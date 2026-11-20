// DSH session-log retention (Phase 2 slice 6, owner-approved Proposal A):
// idle >90d sessions archive (RENAME, same volume) to dsh-sessions/cold and
// restore transparently on their next turn. Pure-fs tests on temp dirs —
// close-before-tolerant-rm is irrelevant here (no store handles), but the
// cleanup still never fails the test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utimesSync } from 'node:fs';

import {
  archiveIdleDshSessions,
  dshSessionColdRootFor,
  DSH_SESSION_RETENTION_IDLE_DAYS,
  restoreDshSessionDir,
} from '../src/main/libs/dshSessionRetention';

function makeSession(liveRoot: string, bucket: string, id: string, mtimeMs: number): string {
  const dir = path.join(liveRoot, bucket, id);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(log, '{"type":"session"}\n');
  // utimesSync interprets numeric args as SECONDS — pass Dates so the ms
  // epoch values land as intended.
  utimesSync(log, new Date(mtimeMs), new Date(mtimeMs));
  return dir;
}

test('the retention window is 90 days and the cold root is a sibling of the live root', () => {
  assert.equal(DSH_SESSION_RETENTION_IDLE_DAYS, 90);
  assert.equal(
    dshSessionColdRootFor('/u/IDBots/dsh-sessions/v0'),
    path.join('/u/IDBots/dsh-sessions', 'cold'),
    'cold is <userData>/dsh-sessions/cold — same volume so archival is a rename',
  );
});

test('archive moves only idle sessions and never touches fresh ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-ret-'));
  try {
    const liveRoot = path.join(dir, 'dsh-sessions', 'v0');
    const coldRoot = path.join(dir, 'dsh-sessions', 'cold');
    const now = Date.now();
    const oldDir = makeSession(liveRoot, '--Users-x--', 'cw-old1', now - 91 * 86_400_000);
    const freshDir = makeSession(liveRoot, '--Users-x--', 'cw-fresh', now - 1 * 86_400_000);
    makeSession(liveRoot, '--Users-y--', 'cw-old2', now - 400 * 86_400_000);

    const result = archiveIdleDshSessions({ liveRoot, coldRoot, now });
    assert.equal(result.scanned, 3);
    assert.equal(result.archived, 2);
    assert.ok(!fs.existsSync(oldDir), 'the idle session left the live root');
    assert.ok(fs.existsSync(path.join(coldRoot, '--Users-x--', 'cw-old1', 'session.v4.jsonl.zstd')), 'archived under the same bucket');
    assert.ok(fs.existsSync(freshDir), 'the fresh session is untouched');
    assert.ok(fs.existsSync(path.join(liveRoot, '--Users-y--', 'cw-old2', 'session.v4.jsonl.zstd')) === false, 'second bucket archived too');

    // A re-run is idempotent (nothing left to archive).
    const again = archiveIdleDshSessions({ liveRoot, coldRoot, now });
    assert.equal(again.archived, 0);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // cleanup must never fail the test
    }
  }
});

test('a prior archive at the destination is never clobbered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-ret2-'));
  try {
    const liveRoot = path.join(dir, 'v0');
    const coldRoot = path.join(dir, 'cold');
    const now = Date.now();
    makeSession(liveRoot, 'b', 'cw-x', now - 100 * 86_400_000);
    fs.mkdirSync(path.join(coldRoot, 'b', 'cw-x'), { recursive: true });
    fs.writeFileSync(path.join(coldRoot, 'b', 'cw-x', 'session.v4.jsonl.zstd'), 'prior-archive\n');
    const result = archiveIdleDshSessions({ liveRoot, coldRoot, now });
    assert.equal(result.archived, 0, 'destination exists — skip, never overwrite');
    assert.ok(fs.readFileSync(path.join(coldRoot, 'b', 'cw-x', 'session.v4.jsonl.zstd'), 'utf8').includes('prior-archive'));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // harmless
    }
  }
});

test('restore moves an archived session back for its next turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-ret3-'));
  try {
    const liveRoot = path.join(dir, 'v0');
    const coldRoot = path.join(dir, 'cold');
    const now = Date.now();
    makeSession(liveRoot, '--b', 'cw-old', now - 91 * 86_400_000);
    // Archive it via the real sweep…
    const archived = archiveIdleDshSessions({ liveRoot, coldRoot, now });
    assert.equal(archived.archived, 1);
    assert.ok(!fs.existsSync(path.join(liveRoot, '--b', 'cw-old')));

    // …then restore via the turn hook.
    assert.equal(restoreDshSessionDir({ liveRoot, coldRoot, dshSessionId: 'cw-old' }), true, 'restored');
    assert.ok(fs.existsSync(path.join(liveRoot, '--b', 'cw-old', 'session.v4.jsonl.zstd')), 'back under the live root');
    assert.ok(!fs.existsSync(path.join(coldRoot, '--b', 'cw-old')), 'gone from cold');
    // Second restore is a no-op (already live).
    assert.equal(restoreDshSessionDir({ liveRoot, coldRoot, dshSessionId: 'cw-old' }), false);
    // Non-cw ids and absent sessions are safe no-ops.
    assert.equal(restoreDshSessionDir({ liveRoot, coldRoot, dshSessionId: 'not-a-session' }), false);
    assert.equal(restoreDshSessionDir({ liveRoot, coldRoot, dshSessionId: 'cw-absent' }), false);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // harmless
    }
  }
});
