import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliScript = path.join(repoRoot, 'scripts', 'metabot-cli.mjs');
const daemonScript = path.join(repoRoot, 'scripts', 'metabot-daemon.mjs');

function createFixtureState() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metabot-cli-'));
  return {
    tempDir,
    fixturePath: path.join(tempDir, 'fixture-state.json'),
  };
}

function buildEnv(fixturePath) {
  return {
    ...process.env,
    METABOT_RUNTIME_FIXTURE_STATE: fixturePath,
  };
}

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function parseJson(stdout) {
  return JSON.parse(String(stdout).trim());
}

test('metabot-cli --help prints the real command list', () => {
  const result = runNodeScript(cliScript, ['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publish-service/);
  assert.match(result.stdout, /list-services/);
  assert.match(result.stdout, /request-service/);
  assert.match(result.stdout, /run-daemon/);
});

test('publish-service persists fixture-backed service state and list-services reads it back', () => {
  const { tempDir, fixturePath } = createFixtureState();
  try {
    const env = buildEnv(fixturePath);
    const publishResult = runNodeScript(cliScript, [
      'publish-service',
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

    assert.equal(publishResult.status, 0, publishResult.stderr);
    const published = parseJson(publishResult.stdout);
    assert.equal(typeof published.pinId, 'string');
    assert.ok(published.pinId.length > 0);

    const listResult = runNodeScript(cliScript, ['list-services'], { env });
    assert.equal(listResult.status, 0, listResult.stderr);

    const listed = parseJson(listResult.stdout);
    assert.deepEqual(
      listed.services.map((service) => service.pinId),
      [published.pinId],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('request-service emits both request_write and provider_wakeup from fixture-backed state', () => {
  const { tempDir, fixturePath } = createFixtureState();
  try {
    const env = buildEnv(fixturePath);
    const publishResult = runNodeScript(cliScript, [
      'publish-service',
      '--metabot-id', '7',
      '--provider-global-metaid', 'idq1provider',
      '--payment-address', 'DProviderAddress',
      '--service-name', 'translator',
      '--display-name', 'Translator',
      '--description', 'One-shot translation',
      '--provider-skill', 'translate-text',
      '--price', '0.01',
      '--currency', 'DOGE',
      '--output-type', 'text',
    ], { env });
    const published = parseJson(publishResult.stdout);

    const requestResult = runNodeScript(cliScript, [
      'request-service',
      '--metabot-id', '9',
      '--request-id', 'req-paid-1',
      '--requester-session-id', 'session-paid-1',
      '--requester-global-metaid', 'idq1requester',
      '--service-pin-id', published.pinId,
      '--user-task', 'summarize the filing',
      '--task-context', 'full filing text',
      '--price', '0.01',
      '--currency', 'DOGE',
      '--payment-txid', 'a'.repeat(64),
      '--payment-chain', 'doge',
    ], { env });

    assert.equal(requestResult.status, 0, requestResult.stderr);
    const requested = parseJson(requestResult.stdout);
    assert.equal(requested.request_write.requestId, 'req-paid-1');
    assert.equal(requested.provider_wakeup.type, 'provider_wakeup');
    assert.equal(requested.provider_wakeup.request_id, 'req-paid-1');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('metabot-daemon --smoke consumes provider_wakeup JSONL and emits provider_delivery JSONL', () => {
  const { tempDir, fixturePath } = createFixtureState();
  try {
    const env = buildEnv(fixturePath);
    const publishResult = runNodeScript(cliScript, [
      'publish-service',
      '--metabot-id', '7',
      '--provider-global-metaid', 'idq1provider',
      '--payment-address', 'DProviderAddress',
      '--service-name', 'translator',
      '--display-name', 'Translator',
      '--description', 'One-shot translation',
      '--provider-skill', 'translate-text',
      '--price', '0.01',
      '--currency', 'DOGE',
      '--output-type', 'text',
    ], { env });
    const published = parseJson(publishResult.stdout);

    const requestResult = runNodeScript(cliScript, [
      'request-service',
      '--metabot-id', '9',
      '--request-id', 'req-paid-2',
      '--requester-session-id', 'session-paid-2',
      '--requester-global-metaid', 'idq1requester',
      '--service-pin-id', published.pinId,
      '--user-task', 'summarize the filing',
      '--task-context', 'full filing text',
      '--price', '0.01',
      '--currency', 'DOGE',
      '--payment-txid', 'b'.repeat(64),
      '--payment-chain', 'doge',
    ], { env });
    const requested = parseJson(requestResult.stdout);

    const daemonResult = runNodeScript(
      daemonScript,
      ['--smoke'],
      { env, input: `${JSON.stringify(requested.provider_wakeup)}\n` },
    );

    assert.equal(daemonResult.status, 0, daemonResult.stderr);
    const lines = daemonResult.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const delivery = JSON.parse(lines[0]);
    assert.equal(delivery.type, 'provider_delivery');
    assert.equal(delivery.request_id, 'req-paid-2');
    assert.equal(delivery.requester_session_id, 'session-paid-2');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
