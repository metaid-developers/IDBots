import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { runCli } = require('../dist/cli/main.js');
const { createRuntimeStateStore } = require('../dist/core/state/runtimeStateStore.js');
const { buildPresenceSnapshot } = require('../dist/core/discovery/serviceDirectory.js');
const { rankServicesForDirectory } = require('../dist/core/discovery/serviceRanking.js');
const { planRemoteCall } = require('../dist/core/delegation/remoteCall.js');
const { buildSessionTrace } = require('../dist/core/chat/sessionTrace.js');
const { exportSessionArtifacts } = require('../dist/core/chat/transcriptExport.js');

function parseLastJson(chunks) {
  return JSON.parse(chunks.join('').trim());
}

async function runCommand(homeDir, args) {
  const stdout = [];
  const stderr = [];
  const env = {
    ...process.env,
    HOME: homeDir,
    METABOT_HOME: homeDir,
  };

  const exitCode = await runCli(args, {
    env,
    cwd: homeDir,
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
  });

  return {
    exitCode,
    stdout,
    stderr,
    payload: parseLastJson(stdout),
  };
}

function assertCommandSucceeded(result, args) {
  if (result.exitCode === 0 && result.payload?.ok === true) {
    return result.payload.data;
  }

  throw new Error(
    `Command failed: metabot ${args.join(' ')}\n${JSON.stringify({
      exitCode: result.exitCode,
      payload: result.payload,
      stderr: result.stderr.join(''),
    }, null, 2)}`
  );
}

async function stopDaemon(homeDir) {
  const daemonStatePath = path.join(homeDir, '.metabot', 'hot', 'daemon.json');

  let daemonState;
  try {
    daemonState = JSON.parse(await readFile(daemonStatePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (Number.isFinite(daemonState.pid)) {
    try {
      process.kill(Number(daemonState.pid), 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(daemonStatePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await rm(daemonStatePath, { force: true });
}

async function readSuccessJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Request failed: ${url}\n${JSON.stringify(payload, null, 2)}`);
  }
  return payload.data;
}

async function postSuccessJson(url, body) {
  return readSuccessJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function buildProviderDirectoryServices(providerIdentity, services) {
  return services.map((service) => ({
    ...service,
    sourceServicePinId: service.sourceServicePinId || service.servicePinId,
    providerAddress: providerIdentity.mvcAddress,
    providerSkill: service.providerSkill || 'metabot-remote-service',
    serviceName: service.serviceName,
    displayName: service.displayName,
    description: service.description,
    price: service.price,
    currency: service.currency,
    outputType: service.outputType,
    available: service.available,
    updatedAt: service.updatedAt,
  }));
}

async function publishWeatherOracle(homeDir) {
  const payloadFile = path.join(homeDir, 'weather-oracle.json');
  await writeFile(payloadFile, JSON.stringify({
    serviceName: 'weather-oracle',
    displayName: 'Weather Oracle',
    description: 'Returns tomorrow weather from the local MetaBot runtime.',
    providerSkill: 'metabot-weather-oracle',
    price: '0.00001',
    currency: 'SPACE',
    outputType: 'text',
    skillDocument: '# Weather Oracle',
  }), 'utf8');

  return payloadFile;
}

export async function runLocalCrossHostDemo({
  callerHost = 'codex',
  providerHost = 'claude-code',
  callerName = `${callerHost} Caller`,
  providerName = `${providerHost} Provider`,
  task = 'Tell me tomorrow weather.',
  taskContext = '',
} = {}) {
  const callerHome = await mkdtemp(path.join(os.tmpdir(), `metabot-${callerHost}-`));
  const providerHome = await mkdtemp(path.join(os.tmpdir(), `metabot-${providerHost}-`));
  const callerStore = createRuntimeStateStore(callerHome);

  try {
    const providerIdentity = assertCommandSucceeded(
      await runCommand(providerHome, ['identity', 'create', '--name', providerName]),
      ['identity', 'create', '--name', providerName]
    );
    const publishFile = await publishWeatherOracle(providerHome);
    const providerService = assertCommandSucceeded(
      await runCommand(providerHome, ['services', 'publish', '--payload-file', publishFile]),
      ['services', 'publish', '--payload-file', publishFile]
    );
    const callerIdentity = assertCommandSucceeded(
      await runCommand(callerHome, ['identity', 'create', '--name', callerName]),
      ['identity', 'create', '--name', callerName]
    );
    const providerDaemon = assertCommandSucceeded(
      await runCommand(providerHome, ['daemon', 'start']),
      ['daemon', 'start']
    );
    const callerDaemon = assertCommandSucceeded(
      await runCommand(callerHome, ['daemon', 'start']),
      ['daemon', 'start']
    );

    const callerState = await callerStore.readState();
    if (!callerState.identity) {
      throw new Error('Expected the caller runtime to persist its identity.');
    }

    const listedServices = await readSuccessJson(
      `${providerDaemon.baseUrl}/api/network/services?online=true`
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const directorySnapshot = buildPresenceSnapshot(
      buildProviderDirectoryServices(providerIdentity, listedServices.services),
      {
        healthy: true,
        peerCount: 1,
        onlineBots: {
          [providerIdentity.globalMetaId]: {
            lastSeenSec: nowSec,
          },
        },
        unhealthyReason: null,
        lastConfigReloadError: null,
        nowSec,
      },
      nowSec,
      new Set()
    );
    const directory = {
      ...directorySnapshot,
      availableServices: rankServicesForDirectory(
        directorySnapshot.availableServices,
        directorySnapshot.onlineBots
      ),
    };

    const call = planRemoteCall({
      request: {
        servicePinId: providerService.servicePinId,
        providerGlobalMetaId: providerIdentity.globalMetaId,
        userTask: task,
        taskContext,
        rawRequest: task,
      },
      availableServices: directory.availableServices,
      sessionId: `session-${callerHost}-to-${providerHost}`,
    });

    if (!call.ok) {
      throw new Error(`Expected a ready remote call plan, received ${call.state}:${call.code}`);
    }

    const remoteExecution = await postSuccessJson(
      `${providerDaemon.baseUrl}/api/services/execute`,
      {
        traceId: call.traceId,
        externalConversationId: call.session.externalConversationId,
        servicePinId: call.service.servicePinId,
        providerGlobalMetaId: call.service.providerGlobalMetaId,
        buyer: {
          host: callerHost,
          globalMetaId: callerIdentity.globalMetaId,
          name: callerName,
        },
        request: {
          userTask: task,
          taskContext,
        },
      }
    );
    const providerTrace = await readSuccessJson(
      `${providerDaemon.baseUrl}/api/trace/${encodeURIComponent(call.traceId)}`
    );

    const trace = buildSessionTrace({
      traceId: call.traceId,
      channel: `${callerHost}->${providerHost}`,
      exportRoot: callerStore.paths.exportRoot,
      session: {
        id: `session-${call.traceId}`,
        title: `${callerHost} to ${providerHost}`,
        type: 'remote_call',
        metabotId: callerState.identity.metabotId,
        peerGlobalMetaId: providerIdentity.globalMetaId,
        peerName: providerService.displayName,
        externalConversationId: call.session.externalConversationId,
      },
      order: {
        id: `order-${call.traceId}`,
        role: 'buyer',
        serviceId: providerService.servicePinId,
        serviceName: providerService.displayName,
        paymentTxid: null,
        paymentCurrency: call.payment.currency,
        paymentAmount: call.payment.amount,
      },
    });
    const artifacts = await exportSessionArtifacts({
      trace,
      transcript: {
        sessionId: trace.session.id,
        title: trace.session.title,
        messages: [
          {
            id: `${trace.traceId}-user`,
            type: 'user',
            timestamp: trace.createdAt,
            content: task,
            metadata: {
              taskContext: taskContext || null,
            },
          },
          {
            id: `${trace.traceId}-assistant`,
            type: 'assistant',
            timestamp: trace.createdAt,
            content: `${callerHost} discovered ${providerService.displayName} from ${providerHost} and opened a remote A2A session over daemon HTTP.`,
            metadata: {
              providerGlobalMetaId: providerIdentity.globalMetaId,
              servicePinId: providerService.servicePinId,
              providerDaemonBaseUrl: providerDaemon.baseUrl,
            },
          },
          {
            id: `${trace.traceId}-remote-result`,
            type: 'assistant',
            timestamp: trace.createdAt,
            content: remoteExecution.responseText,
            metadata: {
              providerTraceId: remoteExecution.traceId,
              providerGlobalMetaId: remoteExecution.providerGlobalMetaId,
            },
          },
        ],
      },
    });

    await callerStore.writeState({
      ...callerState,
      traces: [
        trace,
        ...callerState.traces.filter((entry) => entry.traceId !== trace.traceId),
      ],
    });

    await stopDaemon(callerHome);
    await stopDaemon(providerHome);

    return {
      caller: {
        host: callerHost,
        homeDir: callerHome,
        identity: callerIdentity,
        daemon: callerDaemon,
      },
      provider: {
        host: providerHost,
        homeDir: providerHome,
        identity: providerIdentity,
        daemon: providerDaemon,
        service: providerService,
        trace: providerTrace,
      },
      directory,
      transport: {
        mode: 'daemon_http',
        callerDaemonBaseUrl: callerDaemon.baseUrl,
        providerDaemonBaseUrl: providerDaemon.baseUrl,
      },
      call,
      remoteExecution,
      trace,
      artifacts,
      cleanup: async () => {
        await Promise.all([
          rm(callerHome, { recursive: true, force: true }),
          rm(providerHome, { recursive: true, force: true }),
        ]);
      },
    };
  } catch (error) {
    await Promise.allSettled([
      stopDaemon(callerHome),
      stopDaemon(providerHome),
    ]);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = await runLocalCrossHostDemo();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
