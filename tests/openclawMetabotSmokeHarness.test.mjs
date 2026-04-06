import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeScript = path.join(repoRoot, 'scripts', 'openclaw-metabot-network-smoke.mjs');
const requesterRuntimePath = path.join(
  repoRoot,
  'dist-electron',
  'metabotRuntime',
  'openclaw',
  'openclawRequesterAdapter.js',
);

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

test('fixture smoke harness prints the full PASS checklist', (t) => {
  if (!fs.existsSync(requesterRuntimePath)) {
    t.skip('Run npm run compile:electron before the smoke harness test.');
    return;
  }

  const result = runNodeScript(smokeScript, ['--fixture']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(
    result.stdout.trim().split('\n').filter(Boolean),
    [
      'PASS: publish-service',
      'PASS: list-services',
      'PASS: explicit-free-request',
      'PASS: recommended-paid-request',
      'PASS: request-write-and-wakeup',
      'PASS: daemon-transport-loop',
      'PASS: requester-result-reinjection',
    ],
  );
});
