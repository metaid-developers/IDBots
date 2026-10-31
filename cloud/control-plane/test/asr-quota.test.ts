import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dayStartMs, finalizeUsageRow, insertUsageRow, quotaFor, CST_OFFSET_MS } from '../src/services/asr/usage.js';
import { freshDb, seedUserAndTenant } from './helpers.js';

describe('asr usage day boundary (Asia/Shanghai, fixed UTC+8)', () => {
  test('midnight boundary lands exactly on 00:00 CST', () => {
    // 2026-10-31 00:00:00 +08:00 == 2026-10-30 16:00:00 UTC
    const midnightCst = Date.UTC(2026, 9, 30, 16, 0, 0);
    assert.equal(dayStartMs(midnightCst), midnightCst);
    // One ms before midnight belongs to the previous day.
    assert.equal(dayStartMs(midnightCst - 1), midnightCst - 86_400_000);
    // Noon CST normalizes back to the same midnight.
    assert.equal(dayStartMs(midnightCst + 12 * 60 * 60 * 1000), midnightCst);
  });

  test('CST offset is 8 hours', () => {
    assert.equal(CST_OFFSET_MS, 8 * 60 * 60 * 1000);
  });
});

describe('asr quota computation', () => {
  const userId = 'u_asr_quota';
  const limitSeconds = 60;
  const maxSessionSeconds = 600;

  function setup(): ReturnType<typeof freshDb> {
    const db = freshDb();
    seedUserAndTenant(db, { userId, phone: '+8613900007701', tenantId: 't_asr_quota', status: 'ready' });
    return db;
  }

  test('an empty user has the full allowance', () => {
    const db = setup();
    const q = quotaFor(db, { userId, now: Date.now(), limitSeconds, maxSessionSeconds });
    assert.equal(q.usedSeconds, 0);
    assert.equal(q.remainingSeconds, limitSeconds);
    db.close();
  });

  test('closed sessions accumulate; open sessions contribute live time', () => {
    const db = setup();
    const now = Date.now();
    // Closed session of 30 s.
    const closed = insertUsageRow(db, { userId, upstream: 'stub', startedAt: now - 60_000 });
    finalizeUsageRow(db, { id: closed, endedAt: now - 30_000, startedAt: now - 60_000, audioBytes: 100, finished: true, closeCode: 1000 });
    // Open session started 10 s ago.
    insertUsageRow(db, { userId, upstream: 'stub', startedAt: now - 10_000 });

    const q = quotaFor(db, { userId, now, limitSeconds, maxSessionSeconds });
    assert.ok(Math.abs(q.usedSeconds - 40) < 0.01, `used ~40, got ${q.usedSeconds}`);
    assert.ok(Math.abs(q.remainingSeconds - 20) < 0.01);
    db.close();
  });

  test('yesterday usage does not count against today', () => {
    const db = setup();
    const now = Date.now();
    const day = dayStartMs(now);
    const closed = insertUsageRow(db, { userId, upstream: 'stub', startedAt: day - 1000 });
    finalizeUsageRow(db, { id: closed, endedAt: day - 500, startedAt: day - 1000, audioBytes: 0, finished: true, closeCode: 1000 });

    const q = quotaFor(db, { userId, now, limitSeconds, maxSessionSeconds });
    assert.equal(q.usedSeconds, 0);
    db.close();
  });

  test('a crash-leftover open row from today is capped at maxSessionSeconds', () => {
    const db = setup();
    const now = Date.now();
    // Open row started 3 h ago TODAY (crashed process): must cap at the
    // session cap, not eat the whole day.
    insertUsageRow(db, { userId, upstream: 'stub', startedAt: now - 3 * 60 * 60 * 1000 });

    const q = quotaFor(db, { userId, now, limitSeconds, maxSessionSeconds: 60 });
    assert.ok(Math.abs(q.usedSeconds - 60) < 0.01, `used ${q.usedSeconds} must be the 60 s cap`);
    assert.equal(q.remainingSeconds, 0, 'a 60 s allowance is fully consumed by the capped leftover');
    db.close();
  });

  test('a crash-leftover open row from a previous day never touches today', () => {
    const db = setup();
    const now = Date.now();
    insertUsageRow(db, { userId, upstream: 'stub', startedAt: now - 3 * 86_400_000 });

    const q = quotaFor(db, { userId, now, limitSeconds, maxSessionSeconds });
    assert.equal(q.usedSeconds, 0, 'sessions are charged to their start day');
    assert.equal(q.remainingSeconds, limitSeconds);
    db.close();
  });

  test('finalized rows persist the metering fields', () => {
    const db = setup();
    const now = Date.now();
    const id = insertUsageRow(db, { userId, upstream: 'doubao', startedAt: now - 5000 });
    finalizeUsageRow(db, { id, endedAt: now, startedAt: now - 5000, audioBytes: 32000, finished: true, closeCode: 1000 });
    const row = db
      .prepare('SELECT upstream, ended_at, seconds, audio_bytes, finished, close_code FROM asr_usage WHERE id = ?')
      .get(id) as { upstream: string; ended_at: number; seconds: number; audio_bytes: number; finished: number; close_code: number };
    assert.equal(row.upstream, 'doubao');
    assert.ok(row.seconds >= 4.9 && row.seconds <= 5.1);
    assert.equal(row.audio_bytes, 32000);
    assert.equal(row.finished, 1);
    assert.equal(row.close_code, 1000);
    assert.ok(row.ended_at !== null);
    db.close();
  });
});
