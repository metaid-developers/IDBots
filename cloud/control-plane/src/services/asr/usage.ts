import type Database from 'better-sqlite3';

/**
 * Per-user daily ASR usage recording and quota computation (voice channel).
 *
 * Metering model (trade-offs in the delivery note): one `asr_usage` row per
 * gateway connection — inserted at open, finalized at close. The daily
 * quota is a SUM over the rows (auditable, cheap at our scale, crash-safe:
 * a leftover open row from a crashed process contributes at most
 * `maxSessionSeconds`, so it cannot permanently eat the budget).
 *
 * Day boundary: Asia/Shanghai calendar day of `started_at` (fixed UTC+8,
 * no DST). A session crossing midnight is charged entirely to the day it
 * started.
 */

/** China Standard Time offset in ms (UTC+8, no DST). */
export const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Start-of-day (Asia/Shanghai) of the given epoch ms, as epoch ms. */
export function dayStartMs(ts: number): number {
  return Math.floor((ts + CST_OFFSET_MS) / 86_400_000) * 86_400_000 - CST_OFFSET_MS;
}

export interface AsrQuota {
  /** Sum of closed sessions' seconds plus live time of open sessions. */
  usedSeconds: number;
  limitSeconds: number;
  remainingSeconds: number;
  /** Start of the quota day (Asia/Shanghai) the reading belongs to. */
  dayStartMs: number;
}

export function insertUsageRow(
  db: Database.Database,
  row: { userId: string; upstream: string; startedAt: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO asr_usage (user_id, upstream, started_at, ended_at, seconds, audio_bytes, finished, close_code)
       VALUES (?, ?, ?, NULL, 0, 0, 0, NULL)`,
    )
    .run(row.userId, row.upstream, row.startedAt);
  return Number(info.lastInsertRowid);
}

export function finalizeUsageRow(
  db: Database.Database,
  row: {
    id: number;
    endedAt: number;
    startedAt: number;
    audioBytes: number;
    finished: boolean;
    closeCode: number | null;
  },
): void {
  const seconds = Math.max(0, (row.endedAt - row.startedAt) / 1000);
  db.prepare(
    `UPDATE asr_usage SET ended_at = ?, seconds = ?, audio_bytes = ?, finished = ?, close_code = ? WHERE id = ?`,
  ).run(row.endedAt, seconds, row.audioBytes, row.finished ? 1 : 0, row.closeCode, row.id);
}

/**
 * Current usage for the quota day containing `now`. Open sessions
 * (crash leftovers included) contribute live elapsed time capped at
 * `maxSessionSeconds` per row.
 */
export function quotaFor(
  db: Database.Database,
  opts: { userId: string; now: number; limitSeconds: number; maxSessionSeconds: number },
): AsrQuota {
  const dayStart = dayStartMs(opts.now);
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN seconds ELSE 0 END), 0) AS closed_seconds,
         COALESCE(SUM(
           CASE WHEN ended_at IS NULL
                THEN MIN((CAST(? AS REAL) - started_at) / 1000.0, ?)
                ELSE 0 END), 0) AS open_seconds
       FROM asr_usage
       WHERE user_id = ? AND started_at >= ? AND started_at < ?`,
    )
    .get(opts.now, opts.maxSessionSeconds, opts.userId, dayStart, dayStart + 86_400_000) as {
    closed_seconds: number;
    open_seconds: number;
  };
  const usedSeconds = row.closed_seconds + row.open_seconds;
  return {
    usedSeconds,
    limitSeconds: opts.limitSeconds,
    remainingSeconds: Math.max(0, opts.limitSeconds - usedSeconds),
    dayStartMs: dayStart,
  };
}
