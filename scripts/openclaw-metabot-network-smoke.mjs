#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const cliScript = path.join(repoRoot, 'scripts', 'metabot-cli.mjs');
const daemonScript = path.join(repoRoot, 'scripts', 'metabot-daemon.mjs');
const requestBridgeScript = path.join(
  repoRoot,
  'integrations',
  'openclaw',
  'skills-pack',
  'bin',
  'request-remote-service.mjs',
);
const requesterRuntimePath = path.join(
  repoRoot,
  'dist-electron',
  'metabotRuntime',
  'openclaw',
  'openclawRequesterAdapter.js',
);

function toSafeString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function parseJson(stdout) {
  return JSON.parse(String(stdout).trim());
}

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

function runJsonScript(scriptPath, args, options = {}) {
  const result = runNodeScript(scriptPath, args, options);
  if (result.status !== 0) {
    throw new Error(toSafeString(result.stderr) || `Command failed: ${path.basename(scriptPath)}`);
  }
  return parseJson(result.stdout);
}

function pass(label) {
  process.stdout.write(`PASS: ${label}\n`);
}

function createEmptyFixtureState() {
  return {
    version: 1,
    nextSequence: 1,
    pins: [],
    localServices: [],
    remoteServiceItems: [],
    mirroredServices: [],
    requests: [],
    deliveries: [],
    orders: [],
  };
}

async function runFixtureSmoke() {
  if (!fs.existsSync(requesterRuntimePath)) {
    throw new Error('Missing compiled requester runtime. Run npm run compile:electron first.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openclaw-smoke-'));
  const fixturePath = path.join(tempDir, 'fixture-state.json');
  const pendingRequestsPath = path.join(tempDir, 'pending-requests.json');
  fs.writeFileSync(fixturePath, `${JSON.stringify(createEmptyFixtureState(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(pendingRequestsPath, '[]\n', 'utf8');
  const env = {
    ...process.env,
    METABOT_RUNTIME_FIXTURE_STATE: fixturePath,
    OPENCLAW_PENDING_REQUESTS_FILE: pendingRequestsPath,
  };

  try {
    const requesterRuntime = await import(pathToFileURL(requesterRuntimePath).href);

    const publishedPaid = runJsonScript(cliScript, [
      'publish-service',
      '--metabot-id', '7',
      '--provider-global-metaid', 'idq1providerpaid',
      '--payment-address', 'DPaidProviderAddress',
      '--service-name', 'analyst',
      '--display-name', 'Paid Analyst',
      '--description', 'One-shot paid analysis',
      '--provider-skill', 'analyze-filing',
      '--price', '0.01',
      '--currency', 'DOGE',
      '--output-type', 'text',
    ], { env });
    const publishedFree = runJsonScript(cliScript, [
      'publish-service',
      '--metabot-id', '8',
      '--provider-global-metaid', 'idq1providerfree',
      '--payment-address', 'DFreeProviderAddress',
      '--service-name', 'greeter',
      '--display-name', 'Free Greeter',
      '--description', 'One-shot free greeting',
      '--provider-skill', 'greet-user',
      '--price', '0',
      '--currency', 'SPACE',
      '--output-type', 'text',
    ], { env });

    assert.equal(typeof publishedPaid.pinId, 'string');
    assert.equal(typeof publishedFree.pinId, 'string');
    assert.notEqual(publishedPaid.pinId, publishedFree.pinId);
    pass('publish-service');

    const listed = runJsonScript(cliScript, ['list-services'], { env });
    const listedPinIds = listed.services.map((service) => service.pinId);
    assert.deepEqual(
      listedPinIds.slice().sort(),
      [publishedPaid.pinId, publishedFree.pinId].sort(),
    );
    const fixtureStateAfterList = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.deepEqual(
      fixtureStateAfterList.mirroredServices.map((service) => service.pinId).sort(),
      [publishedPaid.pinId, publishedFree.pinId].sort(),
    );
    pass('list-services');

    const explicitFreeDecision = requesterRuntime.evaluateRequesterRouting({
      localExecution: { status: 'miss' },
      remoteCandidates: listed.services,
      explicitRemoteServicePinId: publishedFree.pinId,
    });
    assert.equal(explicitFreeDecision.action, 'await_confirmation');
    assert.equal(explicitFreeDecision.selectedService.pinId, publishedFree.pinId);

    const explicitFreeRequest = runJsonScript(requestBridgeScript, [
      '--submit',
      '--metabot-id', '9',
      '--service-pin-id', publishedFree.pinId,
      '--request-id', 'req-free-smoke-1',
      '--requester-session-id', 'requester-session-free-1',
      '--requester-global-metaid', 'idq1requester',
      '--target-session-id', 'openclaw-target-free-1',
      '--user-task', 'say hello',
      '--task-context', 'friendly greeting',
      '--confirm',
    ], { env });
    assert.equal(explicitFreeRequest.request_write.requestId, 'req-free-smoke-1');
    assert.equal(explicitFreeRequest.provider_wakeup.request_id, 'req-free-smoke-1');
    pass('explicit-free-request');

    const recommendationCandidates = listed.services.slice().sort((left, right) => {
      const leftPrice = Number(left.price || 0);
      const rightPrice = Number(right.price || 0);
      if (leftPrice !== rightPrice) return rightPrice - leftPrice;
      return String(left.pinId).localeCompare(String(right.pinId));
    });
    const recommendedPaidDecision = requesterRuntime.evaluateRequesterRouting({
      localExecution: { status: 'miss' },
      remoteCandidates: recommendationCandidates,
    });
    assert.equal(recommendedPaidDecision.action, 'recommend_remote');
    assert.equal(recommendedPaidDecision.recommendedService.pinId, publishedPaid.pinId);
    pass('recommended-paid-request');

    const paidRequest = runJsonScript(requestBridgeScript, [
      '--submit',
      '--metabot-id', '9',
      '--service-pin-id', publishedPaid.pinId,
      '--request-id', 'req-paid-smoke-1',
      '--requester-session-id', 'requester-session-paid-1',
      '--requester-global-metaid', 'idq1requester',
      '--target-session-id', 'openclaw-target-paid-1',
      '--user-task', 'summarize the filing',
      '--task-context', 'full filing text',
      '--price', '0.01',
      '--currency', 'DOGE',
      '--payment-txid', 'c'.repeat(64),
      '--payment-chain', 'doge',
      '--confirm',
    ], { env });
    assert.equal(paidRequest.request_write.requestId, 'req-paid-smoke-1');
    assert.equal(paidRequest.provider_wakeup.type, 'provider_wakeup');
    assert.equal(paidRequest.provider_wakeup.request_id, 'req-paid-smoke-1');
    pass('request-write-and-wakeup');

    const daemonResult = runNodeScript(
      daemonScript,
      ['--smoke'],
      {
        env,
        input: `${JSON.stringify(paidRequest.provider_wakeup)}\n`,
      },
    );
    if (daemonResult.status !== 0) {
      throw new Error(toSafeString(daemonResult.stderr) || 'metabot-daemon smoke failed');
    }
    const deliveryLines = String(daemonResult.stdout).trim().split('\n').filter(Boolean);
    assert.equal(deliveryLines.length, 1);
    const providerDelivery = JSON.parse(deliveryLines[0]);
    assert.equal(providerDelivery.type, 'provider_delivery');
    assert.equal(providerDelivery.request_id, 'req-paid-smoke-1');
    assert.equal(providerDelivery.requester_session_id, 'requester-session-paid-1');
    pass('daemon-transport-loop');

    const requesterBridge = requesterRuntime.createOpenClawRequesterBridge({
      pendingRequestsFile: pendingRequestsPath,
      async listServices() {
        return { services: [] };
      },
      async requestService() {
        throw new Error('requestService is not used during reinjection');
      },
    });
    const pendingRequests = JSON.parse(fs.readFileSync(pendingRequestsPath, 'utf8'));
    pendingRequests.push({
      requestId: 'req-paid-smoke-1',
      requesterSessionId: 'requester-session-other',
      requesterConversationId: null,
      targetSessionId: 'openclaw-target-wrong',
      servicePinId: publishedPaid.pinId,
      createdAt: Date.now(),
    });
    fs.writeFileSync(pendingRequestsPath, `${JSON.stringify(pendingRequests, null, 2)}\n`, 'utf8');
    const reinjected = await requesterBridge.reinjectProviderDelivery({
      delivery: providerDelivery,
    });
    assert.ok(reinjected);
    assert.equal(reinjected.requestId, 'req-paid-smoke-1');
    assert.equal(reinjected.targetSessionId, 'openclaw-target-paid-1');
    assert.match(reinjected.message.text, /Smoke delivery: summarize the filing/);
    pass('requester-result-reinjection');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (!args.has('--fixture')) {
    throw new Error('openclaw-metabot-network-smoke requires --fixture');
  }

  await runFixtureSmoke();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
