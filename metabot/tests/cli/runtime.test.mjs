import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runCli } = require('../../dist/cli/main.js');

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

async function stopDaemon(homeDir) {
  const daemonStatePath = path.join(homeDir, '.metabot', 'hot', 'daemon.json');

  let daemonState;
  try {
    daemonState = JSON.parse(await readFile(daemonStatePath, 'utf8'));
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (Number.isFinite(daemonState.pid)) {
    try {
      process.kill(Number(daemonState.pid), 'SIGTERM');
    } catch (error) {
      const code = error?.code;
      if (code !== 'ESRCH') {
        throw error;
      }
    }
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(daemonStatePath, 'utf8');
    } catch (error) {
      const code = error?.code;
      if (code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await rm(daemonStatePath, { force: true });
}

test('identity create autostarts the local daemon and doctor reports the identity as loaded', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-cli-runtime-'));
  t.after(async () => stopDaemon(homeDir));

  const created = await runCommand(homeDir, ['identity', 'create', '--name', 'Alice']);

  assert.equal(created.exitCode, 0);
  assert.equal(created.payload.ok, true);
  assert.equal(created.payload.data.name, 'Alice');
  assert.match(created.payload.data.globalMetaId, /^id/);

  const doctor = await runCommand(homeDir, ['doctor']);

  assert.equal(doctor.exitCode, 0);
  assert.equal(doctor.payload.ok, true);
  assert.equal(
    doctor.payload.data.checks.some((check) => check.code === 'identity_loaded' && check.ok === true),
    true
  );

  const daemonState = JSON.parse(await readFile(path.join(homeDir, '.metabot', 'hot', 'daemon.json'), 'utf8'));
  assert.match(daemonState.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(Number.isInteger(daemonState.pid), true);
});

test('services publish persists a local directory entry that network services --online can read back', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-cli-runtime-'));
  t.after(async () => stopDaemon(homeDir));

  const created = await runCommand(homeDir, ['identity', 'create', '--name', 'Alice']);
  assert.equal(created.exitCode, 0);

  const payloadFile = path.join(homeDir, 'payload.json');
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

  const published = await runCommand(homeDir, ['services', 'publish', '--payload-file', payloadFile]);

  assert.equal(published.exitCode, 0);
  assert.equal(published.payload.ok, true);
  assert.equal(published.payload.data.displayName, 'Weather Oracle');
  assert.equal(published.payload.data.providerGlobalMetaId, created.payload.data.globalMetaId);
  assert.match(published.payload.data.servicePinId, /^service-/);

  const listed = await runCommand(homeDir, ['network', 'services', '--online']);

  assert.equal(listed.exitCode, 0);
  assert.equal(listed.payload.ok, true);
  assert.equal(Array.isArray(listed.payload.data.services), true);
  assert.equal(listed.payload.data.services.length, 1);
  assert.equal(listed.payload.data.services[0].displayName, 'Weather Oracle');
  assert.equal(listed.payload.data.services[0].online, true);
  assert.equal(listed.payload.data.services[0].providerGlobalMetaId, created.payload.data.globalMetaId);
});

test('services call stores a trace that trace get can read back from the local runtime', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-cli-runtime-'));
  t.after(async () => stopDaemon(homeDir));

  const created = await runCommand(homeDir, ['identity', 'create', '--name', 'Alice']);
  assert.equal(created.exitCode, 0);

  const publishFile = path.join(homeDir, 'payload.json');
  await writeFile(publishFile, JSON.stringify({
    serviceName: 'weather-oracle',
    displayName: 'Weather Oracle',
    description: 'Returns tomorrow weather from the local MetaBot runtime.',
    providerSkill: 'metabot-weather-oracle',
    price: '0.00001',
    currency: 'SPACE',
    outputType: 'text',
    skillDocument: '# Weather Oracle',
  }), 'utf8');

  const published = await runCommand(homeDir, ['services', 'publish', '--payload-file', publishFile]);
  assert.equal(published.exitCode, 0);

  const requestFile = path.join(homeDir, 'request.json');
  await writeFile(requestFile, JSON.stringify({
    request: {
      servicePinId: published.payload.data.servicePinId,
      providerGlobalMetaId: created.payload.data.globalMetaId,
      userTask: 'Tell me tomorrow weather',
      taskContext: 'Shanghai tomorrow',
    },
  }), 'utf8');

  const called = await runCommand(homeDir, ['services', 'call', '--request-file', requestFile]);

  assert.equal(called.exitCode, 0);
  assert.equal(called.payload.ok, true);
  assert.match(called.payload.data.traceId, /^trace-/);
  assert.match(called.payload.data.externalConversationId, /^metaweb_order:buyer:/);
  assert.match(called.payload.data.traceJsonPath, /\/\.metabot\/exports\/traces\/.*\.json$/);
  assert.match(called.payload.data.traceMarkdownPath, /\/\.metabot\/exports\/traces\/.*\.md$/);

  const trace = await runCommand(homeDir, ['trace', 'get', '--trace-id', called.payload.data.traceId]);

  assert.equal(trace.exitCode, 0);
  assert.equal(trace.payload.ok, true);
  assert.equal(trace.payload.data.traceId, called.payload.data.traceId);
  assert.equal(trace.payload.data.session.peerGlobalMetaId, created.payload.data.globalMetaId);
  assert.equal(trace.payload.data.order.serviceId, published.payload.data.servicePinId);
  assert.equal(trace.payload.data.order.serviceName, 'Weather Oracle');

  const traceJson = JSON.parse(await readFile(called.payload.data.traceJsonPath, 'utf8'));
  assert.equal(traceJson.traceId, called.payload.data.traceId);

  const traceMarkdown = await readFile(called.payload.data.traceMarkdownPath, 'utf8');
  assert.match(traceMarkdown, /Weather Oracle/);
});

test('chat private encrypts a loopback message and stores a chat trace in the local runtime', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-cli-runtime-'));
  t.after(async () => stopDaemon(homeDir));

  const created = await runCommand(homeDir, ['identity', 'create', '--name', 'Alice']);
  assert.equal(created.exitCode, 0);

  const requestFile = path.join(homeDir, 'chat-request.json');
  await writeFile(requestFile, JSON.stringify({
    to: created.payload.data.globalMetaId,
    content: 'hello from loopback',
    replyPin: 'reply-pin-1',
  }), 'utf8');

  const sent = await runCommand(homeDir, ['chat', 'private', '--request-file', requestFile]);

  assert.equal(sent.exitCode, 0);
  assert.equal(sent.payload.ok, true);
  assert.equal(sent.payload.data.to, created.payload.data.globalMetaId);
  assert.equal(sent.payload.data.path, '/protocols/simplemsg');
  assert.equal(sent.payload.data.deliveryMode, 'local_runtime');
  assert.match(sent.payload.data.traceId, /^trace-private-/);
  assert.match(sent.payload.data.payload, /"encrypt":"ecdh"/);
  assert.match(sent.payload.data.traceJsonPath, /\/\.metabot\/exports\/traces\/.*\.json$/);

  const trace = await runCommand(homeDir, ['trace', 'get', '--trace-id', sent.payload.data.traceId]);

  assert.equal(trace.exitCode, 0);
  assert.equal(trace.payload.ok, true);
  assert.equal(trace.payload.data.traceId, sent.payload.data.traceId);
  assert.equal(trace.payload.data.channel, 'simplemsg');
  assert.equal(trace.payload.data.session.peerGlobalMetaId, created.payload.data.globalMetaId);

  const transcriptMarkdown = await readFile(sent.payload.data.transcriptMarkdownPath, 'utf8');
  assert.match(transcriptMarkdown, /hello from loopback/);
});
