import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishScript = path.join(repoRoot, 'integrations', 'openclaw', 'skills-pack', 'bin', 'publish-service.mjs');
const requestScript = path.join(repoRoot, 'integrations', 'openclaw', 'skills-pack', 'bin', 'request-remote-service.mjs');

function createFixturePaths() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openclaw-skills-'));
  return {
    tempDir,
    fixturePath: path.join(tempDir, 'fixture-state.json'),
    pendingRequestsPath: path.join(tempDir, 'pending-requests.json'),
  };
}

function buildEnv(fixturePath, pendingRequestsPath) {
  return {
    ...process.env,
    METABOT_RUNTIME_FIXTURE_STATE: fixturePath,
    OPENCLAW_PENDING_REQUESTS_FILE: pendingRequestsPath,
  };
}

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function parseJson(stdout) {
  return JSON.parse(String(stdout).trim());
}

test('publish-service.mjs delegates to metabot-cli publish-service', () => {
  const { tempDir, fixturePath, pendingRequestsPath } = createFixturePaths();
  try {
    const env = buildEnv(fixturePath, pendingRequestsPath);
    const result = runNodeScript(publishScript, [
      '--metabot-id', '7',
      '--provider-global-metaid', 'idq1provider',
      '--payment-address', 'DProviderAddress',
      '--service-name', 'translator',
      '--display-name', 'Translator',
      '--description', 'One-shot translation',
      '--provider-skill', 'translate-text',
      '--price', '0',
      '--currency', 'SPACE',
      '--output-type', 'text',
    ], { env });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseJson(result.stdout);
    assert.equal(typeof payload.pinId, 'string');
    assert.ok(payload.pinId.length > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('request-remote-service.mjs --discover calls metabot-cli list-services', () => {
  const { tempDir, fixturePath, pendingRequestsPath } = createFixturePaths();
  try {
    const env = buildEnv(fixturePath, pendingRequestsPath);
    const publishResult = runNodeScript(publishScript, [
      '--metabot-id', '7',
      '--provider-global-metaid', 'idq1provider',
      '--payment-address', 'DProviderAddress',
      '--service-name', 'translator',
      '--display-name', 'Translator',
      '--description', 'One-shot translation',
      '--provider-skill', 'translate-text',
      '--price', '0',
      '--currency', 'SPACE',
      '--output-type', 'text',
    ], { env });
    const published = parseJson(publishResult.stdout);

    const discoverResult = runNodeScript(requestScript, ['--discover'], { env });
    assert.equal(discoverResult.status, 0, discoverResult.stderr);
    const payload = parseJson(discoverResult.stdout);
    assert.deepEqual(payload.services.map((service) => service.pinId), [published.pinId]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('request-remote-service.mjs --submit calls metabot-cli request-service and returns both request_write and provider_wakeup', () => {
  const { tempDir, fixturePath, pendingRequestsPath } = createFixturePaths();
  try {
    const env = buildEnv(fixturePath, pendingRequestsPath);
    const publishResult = runNodeScript(publishScript, [
      '--metabot-id', '7',
      '--provider-global-metaid', 'idq1provider',
      '--payment-address', 'DProviderAddress',
      '--service-name', 'translator',
      '--display-name', 'Translator',
      '--description', 'One-shot translation',
      '--provider-skill', 'translate-text',
      '--price', '0',
      '--currency', 'SPACE',
      '--output-type', 'text',
    ], { env });
    const published = parseJson(publishResult.stdout);

    const submitResult = runNodeScript(requestScript, [
      '--submit',
      '--metabot-id', '9',
      '--service-pin-id', published.pinId,
      '--request-id', 'req-submit-1',
      '--requester-session-id', 'requester-session-1',
      '--requester-global-metaid', 'idq1requester',
      '--target-session-id', 'openclaw-local-session-1',
      '--user-task', 'summarize the filing',
      '--task-context', 'full filing text',
      '--confirm',
    ], { env });

    assert.equal(submitResult.status, 0, submitResult.stderr);
    const payload = parseJson(submitResult.stdout);
    assert.equal(payload.request_write.requestId, 'req-submit-1');
    assert.equal(payload.provider_wakeup.type, 'provider_wakeup');

    const pendingRequests = JSON.parse(fs.readFileSync(pendingRequestsPath, 'utf8'));
    assert.equal(pendingRequests[0].requestId, 'req-submit-1');
    assert.equal(pendingRequests[0].requesterSessionId, 'requester-session-1');
    assert.equal(pendingRequests[0].targetSessionId, 'openclaw-local-session-1');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
