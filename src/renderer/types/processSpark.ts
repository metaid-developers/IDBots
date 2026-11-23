/**
 * 火花线 (process sparkline) — the read-side shape of one process's message
 * activity, bucketed from `cowork_messages.created_at`.
 *
 * Why the message timestamps and NOT Live Stage's `eventWindow`:
 *   `eventWindow` is structurally capped at 8 entries
 *   (`studioLiveStageTemplateRegistry.ts` rejects >8), so it cannot carry 24
 *   buckets at all, and it only exists while a live-stage run is mounted.
 *   `cowork_messages` is the durable record every session has, and it is
 *   already indexed by `(session_id, created_at DESC)`.
 *
 * Why the session's OWN span and not a fixed trailing-24h clock window:
 *   a classic sparkline draws the series it is given. A fixed 24h window would
 *   paint a process that started 20 minutes ago as a single bar (23 empty
 *   slots) — exactly the case the hub shows most often — while the session-span
 *   reading shows the real distribution of that process's work. The two ends
 *   are fixed: bucket 0 = the first message, bucket 23 = the last one.
 */

/** The bucket count the design稿 pins (24 bars, 2px each, 1px gap). */
export const PROCESS_SPARK_BUCKET_COUNT = 24;

/**
 * A non-empty bucket never renders shorter than this, so "1 message in that
 * slot" stays visible at 48px wide. Zero buckets stay at 0 — an empty slot is
 * never drawn as a bar (no fabricated heights).
 */
export const PROCESS_SPARK_MIN_BAR_PERCENT = 15;

/** One session's sparkline reading, exactly as the IPC channel returns it. */
export interface ProcessSparkReading {
  /** Exactly PROCESS_SPARK_BUCKET_COUNT counts, oldest → newest. */
  counts: number[];
  /** Total messages behind the buckets (0 = no timestamps at all). */
  total: number;
  /** First / last message timestamps (ms), null when the session has none. */
  firstMs: number | null;
  lastMs: number | null;
}

/** The zero reading: a session with no message timestamps at all. */
export const emptyProcessSpark = (): ProcessSparkReading => ({
  counts: new Array(PROCESS_SPARK_BUCKET_COUNT).fill(0),
  total: 0,
  firstMs: null,
  lastMs: null,
});
