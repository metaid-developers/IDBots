import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { loadIdentity } = require('../dist/core/identity/loadIdentity.js');
const { buildPublishedService } = require('../dist/core/services/publishService.js');
const { buildPresenceSnapshot } = require('../dist/core/discovery/serviceDirectory.js');
const { planRemoteCall } = require('../dist/core/delegation/remoteCall.js');
const { buildSessionTrace } = require('../dist/core/chat/sessionTrace.js');

const THIS_FILE = fileURLToPath(import.meta.url);
const E2E_ROOT = path.dirname(THIS_FILE);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function buildDirectorySnapshot(providerIdentity, providerFixture, publishedRecord) {
  const serviceRecord = {
    ...publishedRecord,
    servicePinId: publishedRecord.sourceServicePinId,
    providerAddress: providerIdentity.mvcAddress,
  };

  return buildPresenceSnapshot(
    [serviceRecord],
    {
      healthy: true,
      peerCount: 1,
      onlineBots: {
        [providerIdentity.globalMetaId]: {
          lastSeenSec: providerFixture.presence.lastSeenSec,
        },
      },
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: providerFixture.presence.lastSeenSec,
    },
    providerFixture.presence.lastSeenSec,
    new Set()
  );
}

export async function runHostFixtureHarness({
  providerFixturePath,
  callerFixturePath,
  callerHost,
  providerHost,
}) {
  const providerFixture = await readJson(providerFixturePath);
  const callerFixture = await readJson(callerFixturePath);

  const identity = await loadIdentity(providerFixture.identity);
  const published = buildPublishedService({
    sourceServicePinId: providerFixture.service.sourceServicePinId,
    currentPinId: providerFixture.service.currentPinId,
    creatorMetabotId: providerFixture.service.creatorMetabotId,
    providerGlobalMetaId: identity.globalMetaId,
    paymentAddress: identity.mvcAddress,
    draft: providerFixture.service.draft,
    skillDocument: providerFixture.service.skillDocument,
    now: providerFixture.service.updatedAtMs,
  });

  const directory = buildDirectorySnapshot(identity, providerFixture, published.record);
  const call = planRemoteCall({
    request: callerFixture.request,
    availableServices: directory.availableServices,
    sessionId: callerFixture.sessionId,
  });

  const trace = buildSessionTrace({
    traceId: call.traceId,
    channel: `${callerHost}->${providerHost}`,
    exportRoot: callerFixture.traceExportRoot,
    createdAt: providerFixture.service.updatedAtMs,
    session: {
      id: callerFixture.sessionId,
      title: `${callerHost} to ${providerHost}`,
      type: 'remote_call',
      metabotId: providerFixture.service.creatorMetabotId,
      peerGlobalMetaId: identity.globalMetaId,
      peerName: providerFixture.service.draft.displayName,
      externalConversationId: call.session?.externalConversationId ?? null,
    },
    order: {
      id: `fixture-order-${providerFixture.service.sourceServicePinId}`,
      role: 'buyer',
      serviceId: providerFixture.service.sourceServicePinId,
      serviceName: providerFixture.service.draft.serviceName,
      paymentTxid: null,
      paymentCurrency: call.ok ? call.payment.currency : null,
      paymentAmount: call.ok ? call.payment.amount : null,
    },
  });

  return {
    callerHost,
    providerHost,
    provider: {
      identity,
      service: published.record,
    },
    directory,
    call,
    trace,
  };
}

export async function runCodexClaudeFixtureHarness({
  providerFixturePath = path.join(E2E_ROOT, 'fixtures/provider-service.json'),
  callerFixturePath = path.join(E2E_ROOT, 'fixtures/caller-request.json'),
} = {}) {
  return runHostFixtureHarness({
    providerFixturePath,
    callerFixturePath,
    callerHost: 'codex',
    providerHost: 'claude-code',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = await runCodexClaudeFixtureHarness();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
