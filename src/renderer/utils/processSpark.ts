/**
 * 火花线 (process sparkline) — the render-side math.
 *
 * The DATA comes from `cowork:session:activitySpark` (main-process SQL over
 * `cowork_messages.created_at`, bucketed in `services/processSparkBuckets.ts`).
 * This module never invents a bucket: it only normalizes whatever arrived into
 * exactly 24 slots and turns counts into bar heights. A session with no
 * timestamps therefore renders the empty state, not 24 placeholder bars.
 */

import {
  PROCESS_SPARK_BUCKET_COUNT,
  PROCESS_SPARK_MIN_BAR_PERCENT,
  emptyProcessSpark,
  type ProcessSparkReading,
} from '../types/processSpark';

export {
  PROCESS_SPARK_BUCKET_COUNT,
  PROCESS_SPARK_MIN_BAR_PERCENT,
  emptyProcessSpark,
};
export type { ProcessSparkReading };

/** Coerce any payload into exactly 24 finite, non-negative integer counts. */
export const normalizeSparkCounts = (raw: unknown): number[] => {
  const counts = new Array(PROCESS_SPARK_BUCKET_COUNT).fill(0);
  if (!Array.isArray(raw)) return counts;
  const limit = Math.min(raw.length, PROCESS_SPARK_BUCKET_COUNT);
  for (let index = 0; index < limit; index += 1) {
    const value = Number(raw[index]);
    if (!Number.isFinite(value) || value <= 0) continue;
    counts[index] = Math.trunc(value);
  }
  return counts;
};

/** Coerce one IPC reading into the render shape (never throws, never pads a bar). */
export const normalizeSparkReading = (raw: unknown): ProcessSparkReading => {
  if (!raw || typeof raw !== 'object') return emptyProcessSpark();
  const source = raw as Partial<ProcessSparkReading>;
  const counts = normalizeSparkCounts(source.counts);
  const summed = counts.reduce((sum, value) => sum + value, 0);
  const firstMs = Number(source.firstMs);
  const lastMs = Number(source.lastMs);
  return {
    counts,
    total: summed,
    firstMs: Number.isFinite(firstMs) ? firstMs : null,
    lastMs: Number.isFinite(lastMs) ? lastMs : null,
  };
};

/** Does this reading carry any real activity? (false → the explicit empty state) */
export const sparkHasData = (reading: ProcessSparkReading | null | undefined): boolean =>
  Boolean(reading && reading.counts.some((count) => count > 0));

/**
 * Bar heights in percent of the strip's height.
 *
 * A zero bucket is 0% — it is never drawn, because a visible stub on an empty
 * slot would read as "there was activity here" (fabrication). A non-zero bucket
 * is proportional to the busiest slot, floored at PROCESS_SPARK_MIN_BAR_PERCENT
 * so a single message stays visible inside 48px.
 */
export const sparkBarPercents = (reading: ProcessSparkReading | null | undefined): number[] => {
  const counts = normalizeSparkCounts(reading?.counts);
  const busiest = counts.reduce((max, count) => (count > max ? count : max), 0);
  if (busiest <= 0) return counts.map(() => 0);
  return counts.map((count) => {
    if (count <= 0) return 0;
    const percent = Math.round((count / busiest) * 100);
    return Math.min(100, Math.max(PROCESS_SPARK_MIN_BAR_PERCENT, percent));
  });
};

/** How many slots actually carry activity (the tooltip's "N 段有活动"). */
export const sparkActiveBuckets = (reading: ProcessSparkReading | null | undefined): number =>
  normalizeSparkCounts(reading?.counts).filter((count) => count > 0).length;
