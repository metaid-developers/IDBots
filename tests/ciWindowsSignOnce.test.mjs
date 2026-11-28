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
// different file again. SIGN_STUB_MODE makes it stand still the way a service
// that does not answer does: "silent" for every signature; "silent with a
// timestamp" only while a timestamp server is asked — a signer that is well
// behind a timestamp server that is not.
const STUB = [
  '#!/bin/sh',
  'for target; do :; done',
  'echo "$target" >> "$SIGN_STUB_LOG"',
  'if [ -n "$SIGN_STUB_FAIL" ]; then echo "stub failure" >&2; exit 1; fi',
  'if [ "$SIGN_STUB_MODE" = "silent" ]; then exec sleep 20; fi',
  'if [ "$SIGN_STUB_MODE" = "silent with a timestamp" ]; then',
  '  for argument; do if [ "$argument" = "/tr" ]; then exec sleep 20; fi; done',
  'fi',
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
  // The stand-in is started once before anything is timed: each attempt spawns a
  // fresh shell, a slow start can eat the timeout before the stub writes its log
  // line, and a test that counts calls must not depend on the machine's speed.
  // Its call goes to a log of its own.
  execFileSync(signtool, [path.join(dir, 'warm-up.exe')], { env: { ...process.env, SIGN_STUB_LOG: path.join(dir, 'warm-up.log'), SIGN_STUB_MODE: '' } });
  const env = {
    WIN_SIGNTOOL_PATH: signtool,
    WIN_CERT_SHA1: 'AB'.repeat(20),
    WIN_TIMESTAMP_URL: 'http://timestamp.invalid',
    SIGN_STUB_LOG: log,
  };
  const keys = [...Object.keys(env), 'SIGN_STUB_FAIL', 'SIGN_STUB_MODE', 'WIN_SIGNTOOL_TIMEOUT_MS', 'IDBOTS_PRESIGNED_MANIFEST'];
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

const isSignerQuestion = (call) => path.basename(call).startsWith('idbots-signer-probe-');

test('a signing service that does not answer is named after two questions, not eight timeouts', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
  const exe = rig.target('OpenConsole.exe');

  // What run 46051725913 met at its first signature: the SimplySign session had run out.
  const failure = await rig
    .sign(exe, { SIGN_STUB_MODE: 'silent', WIN_SIGNTOOL_TIMEOUT_MS: '1000' })
    .then(
      () => null,
      (error) => error
    );

  assert.match(String(failure && failure.message), /the signing service is not answering\./);
  assert.match(failure.message, /no timestamp server is involved/);
  assert.match(failure.message, /SimplySign session running out/);
  assert.match(failure.message, /Re-login SimplySign/);
  assert.doesNotMatch(failure.message, /all timestamp attempts failed/);
  // The signature with its timestamp, then one question to the service alone. The build spent eight timeouts of 90 seconds here.
  assert.equal(rig.calls().length, 2);
  assert.equal(isSignerQuestion(rig.calls()[1]), true, 'the question is asked on a throwaway copy of signtool');
  assert.equal(fs.existsSync(rig.calls()[1]), false, 'which is gone afterwards');
  assert.equal(rig.read(exe), 'MZ\u0000\u0000binary', 'and nothing was signed');
  assert.deepEqual(warnings.filter((message) => /mark timestamp server unavailable/.test(message)), [], 'no timestamp server is blamed');
});

test('a timestamp server that does not answer is still the server: the service is asked once, then the next server', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
  const exe = rig.target('IDBots.exe');

  await rig.sign(exe, { SIGN_STUB_MODE: 'silent with a timestamp', WIN_SIGNTOOL_TIMEOUT_MS: '1000' });

  assert.equal(rig.read(exe), 'MZ\u0000\u0000binarysignature', 'signed in the end, without a timestamp');
  assert.equal(rig.calls().filter(isSignerQuestion).length, 1, 'the service is asked alone once for this file');
  const givenUp = warnings.filter((message) => /mark timestamp server unavailable/.test(message)).map((message) => message.replace(/^.*: /, ''));
  assert.equal(new Set(givenUp).size, 4, 'the configured server and the three defaults');
  assert.equal(givenUp.length, 4, 'each once: the second certificate profile does not ask them again');
  assert.equal(rig.calls().length, 6, 'four servers, one question to the service, one signature without a timestamp');
  assert.equal(warnings.some((message) => /fallback to signing without timestamp/.test(message)), true);

  // A file asked for later in the same build goes straight to a signature without a timestamp.
  const callsSoFar = rig.calls().length;
  const next = rig.target('uninstaller.exe');
  await rig.sign(next, { WIN_SIGNTOOL_TIMEOUT_MS: '1000' });
  assert.equal(rig.calls().length, callsSoFar + 1, 'no timestamp server is tried again in this build');
  assert.equal(rig.read(next), 'MZ\u0000\u0000binarysignature');
});

test('a service that falls silent after it had answered is named as well', { skip: process.platform === 'win32' }, async (t) => {
  const rig = makeSigningRig(t);
  await rig.sign(rig.target('IDBots.exe'), { SIGN_STUB_MODE: 'silent with a timestamp', WIN_SIGNTOOL_TIMEOUT_MS: '1000' });

  const second = rig.target('uninstaller.exe');
  const failure = await rig
    .sign(second, { SIGN_STUB_MODE: 'silent', WIN_SIGNTOOL_TIMEOUT_MS: '1000' })
    .then(
      () => null,
      (error) => error
    );

  assert.match(String(failure && failure.message), /the signing service is not answering\./);
  assert.equal(rig.read(second), 'MZ\u0000\u0000binary');
});
