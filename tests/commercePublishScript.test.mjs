// publish-commerce-tutorials.mjs — dry-run gate tests (REQ-E-05).
// The script must pass dry-run with exit 0 on the committed payloads, refuse
// --execute without --bot-id, accept a valid --template-pin substitution, and
// never broadcast anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'publish-commerce-tutorials.mjs');

const VALID_PIN = '1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0';

test('dry-run passes on the committed payloads (exit 0, no broadcast)', () => {
  const stdout = execFileSync(process.execPath, [script, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  assert.match(stdout, /mode=DRY-RUN/);
  assert.match(stdout, /PASS/);
  assert.match(stdout, /banned-word scan: clean/);
});

test('bare invocation defaults to dry-run and still exits 0', () => {
  const stdout = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  assert.match(stdout, /mode=DRY-RUN/);
});

test('--execute without --bot-id is refused (non-zero exit, explicit message)', () => {
  assert.throws(
    () => execFileSync(process.execPath, [script, '--execute'], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    }),
    (error) => error.status !== 0 && /--execute requires --bot-id/.test(error.stderr || ''),
  );
});

test('--template-pin substitutes the shop-template placeholder in dry-run', () => {
  const stdout = execFileSync(
    process.execPath,
    [script, '--dry-run', '--template-pin', VALID_PIN],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } },
  );
  assert.match(stdout, /PASS/);
});

test('--template-pin with a malformed pin is refused', () => {
  assert.throws(
    () => execFileSync(process.execPath, [script, '--dry-run', '--template-pin', 'not-a-pin'], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    }),
    (error) => error.status !== 0 && /--template-pin must be/.test(error.stderr || ''),
  );
});
