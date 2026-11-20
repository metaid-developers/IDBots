import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('writeFileAtomicSync replaces file contents through a temporary file', () => {
  const { writeFileAtomicSync } = require('../dist-electron/main/libs/atomicFile.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-atomic-'));
  const target = path.join(dir, 'idbots.sqlite');
  fs.writeFileSync(target, 'old');

  writeFileAtomicSync(target, Buffer.from('new'));

  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('.tmp-')),
    [],
  );
});
test('writeFileAtomicSync preserves the original file if rename fails', () => {
  const { writeFileAtomicSync } = require('../dist-electron/main/libs/atomicFile.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-atomic-fail-'));
  const target = path.join(dir, 'idbots.sqlite');
  fs.writeFileSync(target, 'old');

  assert.throws(
    () => writeFileAtomicSync(target, Buffer.from('new'), {
      renameSync: () => {
        throw new Error('rename failed');
      },
    }),
    /rename failed/,
  );

  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('.tmp-')),
    [],
  );
});
test('writeFileAtomicSync preserves the original file if the temp write fails mid-way', () => {
  const { writeFileAtomicSync } = require('../dist-electron/main/libs/atomicFile.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-atomic-writefail-'));
  const target = path.join(dir, 'idbots.sqlite');
  fs.writeFileSync(target, 'old');

  assert.throws(
    () => writeFileAtomicSync(target, Buffer.from('new'), {
      // A direct writeFileSync(target, …) truncates first and would leave a
      // 4-byte file here; the temp+rename path must leave the target untouched.
      writeFileSync: (tempPath, data) => {
        fs.writeFileSync(tempPath, Buffer.from(data).subarray(0, 4));
        throw new Error('ENOSPC (simulated)');
      },
    }),
    /ENOSPC/,
  );

  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('.tmp-')),
    [],
  );
});
