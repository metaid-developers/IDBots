/**
 * 火花线取数面 — the bucket math behind the process hub's sparkline.
 *
 * ONE owner for the whole computation (SQL + assembly) so the shape the store
 * returns is exactly the shape the tests pin. Dependency-free on purpose: the
 * store calls it, and the test imports it directly and runs the SAME SQL text
 * against a real SQLite fixture — no second implementation to drift.
 *
 * Reading semantics (the design稿's 24 bars, left = oldest, right = newest):
 *   bucket 0  = the session's FIRST message timestamp
 *   bucket 23 = its LAST message timestamp
 *   the span is divided into PROCESS_SPARK_BUCKET_COUNT equal slices, so the
 *   strip draws the process's own activity rhythm rather than a clock window.
 *
 * Boundary rule (measured on the live DB: 117 of 1389 grouped rows came back
 * with bucket = 24 — the last message always lands exactly on the right edge):
 *   a bucket index is clamped into [0, 23]; a NULL bucket (a session whose
 *   messages all share one timestamp → zero span → division by NULL) means
 *   "everything happened at once" and is placed in the LAST bucket.
 *   No message ever produces an out-of-range index.
 */

/** The design稿 pins 24 bars (2px + 1px gap inside 48px). */
export const PROCESS_SPARK_BUCKET_COUNT = 24;

/**
 * The most session ids one call accepts. The hub renders far fewer rows than
 * this, so the cap only guards against a runaway caller; measured cost on the
 * live DB (403k messages) is ~15ms for 120 sessions.
 */
export const PROCESS_SPARK_MAX_SESSIONS = 200;

/** One session's reading — the renderer-side type mirrors this exactly. */
export interface ProcessSparkReadingRow {
  counts: number[];
  total: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface SparkBoundRow {
  sessionId: string;
  firstMs: number;
  lastMs: number;
  total: number;
}

export interface SparkBucketRow {
  sessionId: string;
  /** SQL-side bucket index; null when the session's span is 0. May be 24. */
  bucket: number | null;
  count: number;
}

/** Dedupe + validate the caller's id list (never trust the IPC boundary). */
export const normalizeSparkSessionIds = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id) continue;
    seen.add(id);
    if (seen.size >= PROCESS_SPARK_MAX_SESSIONS) break;
  }
  return [...seen];
};

const placeholders = (count: number): string => new Array(count).fill('?').join(',');

/**
 * Per-session bounds. `total` is the number of message rows behind the strip —
 * the tooltip's "共 N 条"; a session with no rows is ABSENT from this result
 * (the assembler turns that into the empty reading, never a fabricated bar).
 */
export const buildSparkBoundsQuery = (sessionIds: readonly string[]): { sql: string; params: (string | number | null)[] } => ({
  sql: `
    SELECT session_id AS sessionId,
           MIN(created_at) AS firstMs,
           MAX(created_at) AS lastMs,
           COUNT(*) AS total
    FROM cowork_messages
    WHERE session_id IN (${placeholders(sessionIds.length)})
    GROUP BY session_id
  `,
  params: [...sessionIds],
});

/**
 * The bucket histogram. The CTE is referenced twice (bounds + join) so the id
 * list is bound once. NULLIF keeps the zero-span case from raising a division
 * error — it yields NULL, which the assembler maps to the last bucket.
 */
export const buildSparkBucketQuery = (sessionIds: readonly string[]): { sql: string; params: (string | number | null)[] } => ({
  sql: `
    WITH picked AS (
      SELECT session_id, created_at
      FROM cowork_messages
      WHERE session_id IN (${placeholders(sessionIds.length)})
    )
    SELECT p.session_id AS sessionId,
           CAST((p.created_at - b.first_ms) * ${PROCESS_SPARK_BUCKET_COUNT}
                / NULLIF(b.last_ms - b.first_ms, 0) AS INTEGER) AS bucket,
           COUNT(*) AS count
    FROM picked p
    JOIN (
      SELECT session_id, MIN(created_at) AS first_ms, MAX(created_at) AS last_ms
      FROM picked
      GROUP BY session_id
    ) b ON b.session_id = p.session_id
    GROUP BY p.session_id, bucket
  `,
  params: [...sessionIds],
});

/** Clamp one SQL bucket index into the strip (null = zero span = newest slot). */
export const clampSparkBucketIndex = (bucket: number | null | undefined): number => {
  if (bucket === null || bucket === undefined) return PROCESS_SPARK_BUCKET_COUNT - 1;
  const numeric = Number(bucket);
  if (!Number.isFinite(numeric)) return PROCESS_SPARK_BUCKET_COUNT - 1;
  return Math.min(PROCESS_SPARK_BUCKET_COUNT - 1, Math.max(0, Math.trunc(numeric)));
};

const emptyReading = (): ProcessSparkReadingRow => ({
  counts: new Array(PROCESS_SPARK_BUCKET_COUNT).fill(0),
  total: 0,
  firstMs: null,
  lastMs: null,
});

/**
 * Fold the two query results into one reading per requested session.
 *
 * Every requested id gets an entry — a session with no message rows returns the
 * zero reading (`total: 0`, all buckets 0), which is what the UI renders as the
 * explicit empty state. Nothing here invents a height.
 */
export const assembleSparkReadings = (
  boundRows: readonly SparkBoundRow[],
  bucketRows: readonly SparkBucketRow[],
  sessionIds: readonly string[],
): Record<string, ProcessSparkReadingRow> => {
  const readings: Record<string, ProcessSparkReadingRow> = {};
  for (const id of sessionIds) readings[id] = emptyReading();

  for (const row of boundRows) {
    const reading = readings[row.sessionId];
    if (!reading) continue;
    const firstMs = Number(row.firstMs);
    const lastMs = Number(row.lastMs);
    const total = Number(row.total);
    reading.firstMs = Number.isFinite(firstMs) ? firstMs : null;
    reading.lastMs = Number.isFinite(lastMs) ? lastMs : null;
    reading.total = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  }

  for (const row of bucketRows) {
    const reading = readings[row.sessionId];
    if (!reading) continue;
    const count = Number(row.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const index = clampSparkBucketIndex(row.bucket);
    reading.counts[index] += Math.trunc(count);
  }

  // `total` must equal what the strip actually carries, so a row-count drift
  // can never show a tooltip number the bars do not add up to.
  for (const id of sessionIds) {
    const reading = readings[id];
    const summed = reading.counts.reduce((sum, value) => sum + value, 0);
    if (summed !== reading.total) reading.total = summed;
  }

  return readings;
};
