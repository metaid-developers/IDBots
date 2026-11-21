// Session-log write-path atomicity (2026-11-20 evening recon).
//
// The 2026-10-19 04:34 incident zeroed ten `session.v4.jsonl.zstd` artifacts
// and stripped the header frame off two more inside one 254 ms window. The
// audit in README-sessionlog-atomicity.md walks every write call that can
// touch the dsh-sessions tree; this suite pins the invariants that audit
// leans on, so a later refactor cannot quietly reintroduce an in-place
// truncating write:
//
//   1. the two host-side writers INSIDE the session tree (DshKernel runtime
//      config, DshTurnHub route hint) go through writeFileAtomicSync
//      (temp file + rename) — never `writeFileSync(target, …)`;
//   2. the v0 plaintext→zstd migration and the v0 abort-cause sanitizer only
//      ever open TEMP files for writing, fsync them, then rename into place;
//   3. the quit/startup session-log guard stays read-only over the logs;
//   4. behavior: a writer that fails mid-write through the atomic helper
//      leaves the artifact byte-identical (never 0 bytes, never header-less) —
//      the exact damage shape the incident left behind.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const readRepoFile = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

test('host writers inside the dsh-sessions tree go through the atomic helper', () => {
  const kernel = readRepoFile('src/main/libs/dshKernel/dshKernel.ts');
  assert.match(kernel, /import \{ writeFileAtomicSync \} from '\.\.\/atomicFile'/, 'dshKernel imports the shared atomic writer');
  assert.match(kernel, /writeFileAtomicSync\(configPath,/, 'the runtime config is published with temp+rename');
  assert.doesNotMatch(kernel, /writeFileSync\(/, 'the runtime config must never be truncated in place (it lives in the session root)');

  const turn = readRepoFile('src/main/libs/coworkDshTurn.ts');
  assert.match(turn, /import \{ writeFileAtomicSync \} from '\.\/atomicFile'/, 'coworkDshTurn imports the shared atomic writer');
  assert.match(turn, /writeFileAtomicSync\(\s*\n?\s*join\(dir,/, 'the route hint is published with temp+rename');
  assert.doesNotMatch(turn, /fs\.writeFileSync\(/, 'the route hint must never be truncated in place (it sits beside the logs)');
});

test('the v0 migration opens only temp files for writing and fsyncs before rename', () => {
  const migration = readRepoFile('dsh-runtime/lib/migrate-session-root-zstd.mjs');
  const writeTargets = [...migration.matchAll(/fsp\.open\(([^,]+), 'w'\)/g)].map((match) => match[1].trim());
  assert.ok(writeTargets.length >= 2, 'both the migration stage and the rollback stage open a temp file');
  assert.deepEqual([...new Set(writeTargets)], ['tmp'], 'no session artifact is ever opened for in-place writing');

  const stageStart = migration.indexOf('const tmp = path.join(dir,');
  const stageEnd = migration.indexOf('renamed.push({ dir })');
  assert.ok(stageStart > 0 && stageEnd > stageStart, 'the migration stage block is locatable');
  const stage = migration.slice(stageStart, stageEnd);
  const writeAt = stage.indexOf('await handle.writeFile(compressed)');
  const syncAt = stage.indexOf('await handle.sync()');
  const renameAt = stage.indexOf('await fsp.rename(tmp, zstdPath)');
  assert.ok(writeAt > 0 && syncAt > writeAt && renameAt > syncAt, 'write → fsync → rename ordering holds');
  assert.doesNotMatch(migration, /\btruncate(Sync)?\(/, 'the migration never truncates an artifact');
});

test('the v0 abort-cause sanitizer writes through a synced temp file and never truncates', () => {
  const sanitizer = readRepoFile('dsh-runtime/lib/sanitize-v0-abort-cause.mjs');
  const writeTargets = [...sanitizer.matchAll(/fsp\.open\(([^,]+), 'w'\)/g)].map((match) => match[1].trim());
  assert.deepEqual([...new Set(writeTargets)], ['tmp'], 'the artifact itself is never opened for in-place writing');

  const bodyStart = sanitizer.indexOf('async function writeAtomically');
  const bodyEnd = sanitizer.indexOf('/**', bodyStart + 10);
  const body = sanitizer.slice(bodyStart, bodyEnd);
  assert.match(body, /await handle\.sync\(\)/, 'the temp file is fsynced');
  assert.match(body, /await fsp\.rename\(tmp, targetPath\)/, 'the temp file is renamed onto the artifact');
  assert.doesNotMatch(sanitizer, /\btruncate(Sync)?\(/, 'the sanitizer never truncates an artifact');
});

test('the quit/startup session-log guard stays read-only over the logs', () => {
  const guard = readRepoFile('src/main/libs/dshSessionLogGuard.ts');
  assert.match(guard, /mayDelete: false/);
  assert.match(guard, /mayRewrite: false/);
  assert.doesNotMatch(guard, /\b(writeFile|appendFile|truncate|unlink|rename)(Sync)?\(/, 'the guard issues no content-changing syscall');
  assert.match(guard, /handle\.sync\(\)/, 'its only mutating syscall is fsync on an already-open handle');
});

test('a mid-write failure through the atomic helper leaves a v4 artifact byte-identical', () => {
  const { writeFileAtomicSync } = require('../dist-electron/main/libs/atomicFile.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sessionlog-atomic-'));
  try {
    const target = path.join(dir, 'session.v4.jsonl.zstd');
    const pristine = Buffer.from('HEADER-FRAME-BYTES\nBODY-FRAME-BYTES');
    fs.writeFileSync(target, pristine);

    assert.throws(
      () => writeFileAtomicSync(target, Buffer.from('FRESH-FRAMES'), {
        // Simulate a crash / ENOSPC after the first four bytes of the temp file:
        // the direct `writeFileSync(target, …)` this helper replaces would have
        // truncated the artifact to 4 bytes at this point.
        writeFileSync: (tempPath, data) => {
          fs.writeFileSync(tempPath, Buffer.from(data).subarray(0, 4));
          throw new Error('ENOSPC (simulated)');
        },
      }),
      /ENOSPC/,
    );

    assert.deepEqual(fs.readFileSync(target), pristine, 'the artifact keeps its header bytes — never 0 bytes, never torn');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.tmp-')),
      [],
      'the failed write leaves no temp file behind',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
