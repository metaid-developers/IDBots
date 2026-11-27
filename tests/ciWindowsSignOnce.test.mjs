import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const signWindowsArtifact = require('../scripts/windows-sign.cjs');

// A stand-in for signtool: records every invocation and, like the real tool,
// modifies its target (the last argument) so a second signature would be a
// different file again.
const STUB = [
  '#!/bin/sh',
  'for target; do :; done',
  'echo "$target" >> "$SIGN_STUB_LOG"',
  'if [ -n "$SIGN_STUB_FAIL" ]; then echo "stub failure" >&2; exit 1; fi',
  'printf signature >> "$target"',
].join('\n');

function makeSigningRig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sign-'));
  // Leftover temp dirs are harmless and OS-swept; never let cleanup fail a test.
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  const signtool = path.join(dir, 'signtool.exe');
  fs.writeFileSync(signtool, STUB, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  const env = {
    WIN_SIGNTOOL_PATH: signtool,
    WIN_CERT_SHA1: 'AB'.repeat(20),
    WIN_TIMESTAMP_URL: 'http://timestamp.invalid',
    SIGN_STUB_LOG: log,
  };
  const keys = [...Object.keys(env), 'SIGN_STUB_FAIL', 'IDBOTS_PRESIGNED_MANIFEST'];
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    signWindowsArtifact.resetForTests();
  });
  const target = (name, content = 'MZ\u0000\u0000binary') => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return {
    target,
    sign: (file, extraEnv = {}) => {
      for (const key of keys) {
        if (!(key in env) && !(key in extraEnv)) delete process.env[key];
      }
      Object.assign(process.env, env, extraEnv);
      return signWindowsArtifact({ path: file });
    },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    read: (file) => fs.readFileSync(file, 'utf8'),
  };
}

test('a file electron-builder asks for twice is signed once', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const exe = rig.target('app.exe');

  await rig.sign(exe);
  const signedBytes = rig.read(exe);

  await rig.sign(exe);

  assert.equal(rig.calls().length, 1, 'the second request must not reach signtool');
  assert.equal(rig.read(exe), signedBytes, 'and must not touch the signed file');
});

test('a file that changed after it was signed is signed again', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const exe = rig.target('IDBots.exe');
  await rig.sign(exe);

  // What rcedit or a copy pass does between electron-builder's two requests.
  fs.writeFileSync(exe, `${rig.read(exe)}edited`);
  await rig.sign(exe);

  assert.equal(rig.calls().length, 2);
});

test('each file is tracked on its own', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const first = rig.target('git.exe');
  const second = rig.target('git-bash.exe');

  await rig.sign(first);
  await rig.sign(first);
  await rig.sign(second);
  await rig.sign(second);

  assert.deepEqual(rig.calls().sort(), [first, second].sort());
});

test('a failed signature is not remembered, so the retry reaches signtool', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const exe = rig.target('uninstaller.exe');

  await assert.rejects(rig.sign(exe, { SIGN_STUB_FAIL: '1' }), /all timestamp attempts failed/);
  const failedCalls = rig.calls().length;
  assert.equal(failedCalls > 0, true);
  assert.equal(rig.read(exe), 'MZ\u0000\u0000binary', 'a failed stub signs nothing');

  await rig.sign(exe);

  // One signature: the configured timestamp server is tried first and succeeds.
  assert.equal(rig.calls().length, failedCalls + 1, 'the retry after a failure must reach signtool');
  assert.equal(rig.read(exe), 'MZ\u0000\u0000binarysignature');
});

test('a PortableGit binary handed over by the signed cache is not signed again — unless its bytes changed', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const signedBytes = 'MZ\u0000git<signature>';
  const git = rig.target(path.join('release', 'win-unpacked', 'resources', 'mingit', 'usr', 'bin', 'git.exe'), signedBytes);
  const digestList = path.join(path.dirname(rig.target('where-am-i')), 'presigned.json');
  fs.writeFileSync(digestList, JSON.stringify({ version: 1, files: { 'usr/bin/git.exe': createHash('sha256').update(signedBytes).digest('hex') } }));

  await rig.sign(git, { IDBOTS_PRESIGNED_MANIFEST: digestList });
  assert.equal(rig.calls().length, 0, 'a pre-signed PortableGit binary must not reach signtool');

  // A damaged or half-replaced tree: the recorded digest no longer describes the file.
  fs.writeFileSync(git, 'MZ\u0000git<signature-with-a-flipped-byte>');
  await rig.sign(git, { IDBOTS_PRESIGNED_MANIFEST: digestList });
  assert.equal(rig.calls().length, 1, 'bytes that no longer match the recorded digest are signed');
});

test('a digest list that cannot be read is said out loud, and the files are signed', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
  const exe = rig.target(path.join('release', 'win-unpacked', 'resources', 'mingit', 'git-bash.exe'));
  // What the first cache hit looked like (run 46037790077, 2026-11-28): the variable points
  // at a path where the reuse step did not write the list.
  const nowhere = path.join(path.dirname(rig.target('where-am-i')), 'idbots-presigned-mingit.json');

  await rig.sign(exe, { IDBOTS_PRESIGNED_MANIFEST: nowhere });
  await rig.sign(rig.target(path.join('release', 'win-unpacked', 'resources', 'mingit', 'bin', 'bash.exe')), { IDBOTS_PRESIGNED_MANIFEST: nowhere });

  assert.equal(rig.calls().length, 2, 'files nothing vouches for are signed');
  assert.equal(warnings.filter((message) => message.includes('cannot be read') && message.includes(nowhere)).length, 1, 'and the reason is said, once');
});

test('no digest list asked for is no warning at all', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));

  await rig.sign(rig.target(path.join('release', 'win-unpacked', 'resources', 'mingit', 'git-bash.exe')));

  assert.equal(rig.calls().length, 1);
  assert.deepEqual(warnings, []);
});
