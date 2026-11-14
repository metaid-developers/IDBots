import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * Chain content history ("链上内容经历") — the local ledger of what a MetaBot
 * has published TO the chain and what it has read FROM the chain.
 *
 * Two tables:
 * - `metabot_chain_writes`: every pin this bot successfully broadcast via
 *   `createPin` (buzz, simplenote, metafile uploads, follow/like, etc.).
 *   Chat/group-chat pins are excluded up front — the MetaWeb listener already
 *   lands those in `private_chat_messages` / `group_chat_messages`, and
 *   duplicating them here would be a second source of truth.
 * - `metabot_chain_reads`: every chain pin this bot fully opened through the
 *   read tools (read_metaweb_pin, social_post_detail, omni_read pin-class
 *   actions). Searches and list browsing are intentionally not recorded.
 *
 * Text payloads (buzz, simplenote, …) keep their full text (capped); binary
 * payloads (images, video, audio metafiles) keep only pin id + path + mime +
 * byte size. Long content gets an LLM summary filled in asynchronously by the
 * content-summary service (`summary_status` lifecycle:
 * pending → done/failed, or skipped when the stored text is short enough to
 * serve as its own summary).
 *
 * The dream service folds both tables into the nightly dream input, so what a
 * bot wrote and read becomes part of its memories without a separate channel.
 */

export type ChainSummaryStatus = 'pending' | 'done' | 'skipped' | 'failed';

/** Text above this length gets an LLM summary; shorter text is self-summarizing. */
export const SUMMARY_MIN_CONTENT_CHARS = 800;
/** Full-text cap for published text payloads stored in metabot_chain_writes. */
export const MAX_WRITE_CONTENT_CHARS = 16_000;
/** Excerpt cap for read content stored in metabot_chain_reads. The async
 * summarizer works from this excerpt, so it is generous enough to hold a
 * typical article's core. */
export const MAX_READ_EXCERPT_CHARS = 8_000;
/** A pending summary is retried on later ticks until this many attempts. */
export const MAX_SUMMARY_ATTEMPTS = 3;
/**
 * release-review P2: retention — newest rows per bot kept per table. Recall
 * and dream never read past the newest 50 rows, so 1000 per bot preserves
 * ample history while bounding a long-lived install's growth (rows hold up
 * to 16 KB of text each). Pruning runs at most once a day, time-gated inside
 * the record paths so no new scheduler wiring is needed.
 */
export const MAX_LEDGER_ROWS_PER_BOT = 1_000;
const LEDGER_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MetabotChainWriteRecord {
  id: number;
  metabotId: number;
  pinId: string;
  txId: string | null;
  path: string | null;
  operation: string | null;
  contentText: string | null;
  contentTruncated: boolean;
  contentBytes: number;
  contentType: string | null;
  summary: string | null;
  summaryStatus: ChainSummaryStatus;
  summaryAttempts: number;
  summarizedAtMs: number | null;
  origin: string | null;
  occurredAtMs: number;
  createdAt: string;
}

export interface MetabotChainReadRecord {
  id: number;
  metabotId: number;
  pinId: string;
  path: string | null;
  protocol: string | null;
  title: string | null;
  authorGlobalMetaId: string | null;
  contentExcerpt: string | null;
  contentBytes: number;
  summary: string | null;
  summaryStatus: ChainSummaryStatus;
  summaryAttempts: number;
  summarizedAtMs: number | null;
  savedToKb: boolean;
  kbId: string | null;
  source: string | null;
  firstReadAtMs: number;
  lastReadAtMs: number;
  readCount: number;
  createdAt: string;
}

export interface RecordChainWriteInput {
  metabotId: number;
  pinId: string;
  txId?: string | null;
  path?: string | null;
  operation?: string | null;
  /** Full text payload when textual; pass null/undefined for binary pins. */
  contentText?: string | null;
  contentBytes?: number | null;
  contentType?: string | null;
  origin?: string | null;
  occurredAtMs: number;
}

export interface RecordChainReadInput {
  metabotId: number;
  pinId: string;
  path?: string | null;
  protocol?: string | null;
  title?: string | null;
  authorGlobalMetaId?: string | null;
  /** Full read text when available; the store keeps only an excerpt. */
  contentText?: string | null;
  contentBytes?: number | null;
  /** Tool that performed the read, e.g. 'read_metaweb_pin'. */
  source: string;
  readAtMs: number;
}

interface ChainWriteRow {
  id: number;
  metabot_id: number;
  pin_id: string;
  tx_id: string | null;
  path: string | null;
  operation: string | null;
  content_text: string | null;
  content_truncated: number;
  content_bytes: number;
  content_type: string | null;
  summary: string | null;
  summary_status: ChainSummaryStatus;
  summary_attempts: number;
  summarized_at_ms: number | null;
  origin: string | null;
  occurred_at_ms: number;
  created_at: string;
}

interface ChainReadRow {
  id: number;
  metabot_id: number;
  pin_id: string;
  path: string | null;
  protocol: string | null;
  title: string | null;
  author_globalmetaid: string | null;
  content_excerpt: string | null;
  content_bytes: number;
  summary: string | null;
  summary_status: ChainSummaryStatus;
  summary_attempts: number;
  summarized_at_ms: number | null;
  saved_to_kb: number;
  kb_id: string | null;
  source: string | null;
  first_read_at_ms: number;
  last_read_at_ms: number;
  read_count: number;
  created_at: string;
}

/** Create both ledger tables without changing existing user data. */
export function ensureChainContentHistorySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS metabot_chain_writes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metabot_id INTEGER NOT NULL,
      pin_id TEXT NOT NULL UNIQUE,
      tx_id TEXT,
      path TEXT,
      operation TEXT,
      content_text TEXT,
      content_truncated INTEGER NOT NULL DEFAULT 0,
      content_bytes INTEGER NOT NULL DEFAULT 0,
      content_type TEXT,
      summary TEXT,
      summary_status TEXT NOT NULL DEFAULT 'skipped'
        CHECK (summary_status IN ('pending', 'done', 'skipped', 'failed')),
      summary_attempts INTEGER NOT NULL DEFAULT 0,
      summarized_at_ms INTEGER,
      origin TEXT,
      occurred_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metabot_chain_writes_metabot_time
      ON metabot_chain_writes(metabot_id, occurred_at_ms);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metabot_chain_writes_summary
      ON metabot_chain_writes(summary_status, summary_attempts);
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS metabot_chain_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metabot_id INTEGER NOT NULL,
      pin_id TEXT NOT NULL,
      path TEXT,
      protocol TEXT,
      title TEXT,
      author_globalmetaid TEXT,
      content_excerpt TEXT,
      content_bytes INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      summary_status TEXT NOT NULL DEFAULT 'skipped'
        CHECK (summary_status IN ('pending', 'done', 'skipped', 'failed')),
      summary_attempts INTEGER NOT NULL DEFAULT 0,
      summarized_at_ms INTEGER,
      saved_to_kb INTEGER NOT NULL DEFAULT 0,
      kb_id TEXT,
      source TEXT,
      first_read_at_ms INTEGER NOT NULL,
      last_read_at_ms INTEGER NOT NULL,
      read_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (metabot_id, pin_id)
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metabot_chain_reads_metabot_time
      ON metabot_chain_reads(metabot_id, last_read_at_ms);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metabot_chain_reads_summary
      ON metabot_chain_reads(summary_status, summary_attempts);
  `);
}

const writeRowToRecord = (row: ChainWriteRow): MetabotChainWriteRecord => ({
  id: row.id,
  metabotId: row.metabot_id,
  pinId: row.pin_id,
  txId: row.tx_id || null,
  path: row.path || null,
  operation: row.operation || null,
  contentText: row.content_text ?? null,
  contentTruncated: Number(row.content_truncated) === 1,
  contentBytes: Number(row.content_bytes) || 0,
  contentType: row.content_type || null,
  summary: row.summary ?? null,
  summaryStatus: row.summary_status,
  summaryAttempts: Number(row.summary_attempts) || 0,
  summarizedAtMs: row.summarized_at_ms ?? null,
  origin: row.origin || null,
  occurredAtMs: Number(row.occurred_at_ms) || 0,
  createdAt: row.created_at,
});

const readRowToRecord = (row: ChainReadRow): MetabotChainReadRecord => ({
  id: row.id,
  metabotId: row.metabot_id,
  pinId: row.pin_id,
  path: row.path || null,
  protocol: row.protocol || null,
  title: row.title || null,
  authorGlobalMetaId: row.author_globalmetaid || null,
  contentExcerpt: row.content_excerpt ?? null,
  contentBytes: Number(row.content_bytes) || 0,
  summary: row.summary ?? null,
  summaryStatus: row.summary_status,
  summaryAttempts: Number(row.summary_attempts) || 0,
  summarizedAtMs: row.summarized_at_ms ?? null,
  savedToKb: Number(row.saved_to_kb) === 1,
  kbId: row.kb_id || null,
  source: row.source || null,
  firstReadAtMs: Number(row.first_read_at_ms) || 0,
  lastReadAtMs: Number(row.last_read_at_ms) || 0,
  readCount: Number(row.read_count) || 0,
  createdAt: row.created_at,
});

/** Short text is its own summary; only long content queues for the LLM. */
function initialSummaryStatus(contentLength: number): ChainSummaryStatus {
  return contentLength >= SUMMARY_MIN_CONTENT_CHARS ? 'pending' : 'skipped';
}

/** Escape %, _ and \ so a user query is matched literally in LIKE. */
const escapeLikePattern = (raw: string): string => raw.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Optional filters for the recall queries (chain_history_recall tool). */
export interface ChainContentSearchOptions {
  /** Keyword matched against text fields (title/summary/excerpt/path/pinId). */
  query?: string;
  /** Inclusive lower bound, epoch ms. */
  fromMs?: number;
  /** Exclusive upper bound, epoch ms. */
  toMs?: number;
  /** Result cap (clamped to 1..50). */
  limit?: number;
}

export class ChainContentHistoryStore {
  private lastPrunedAtMs = 0;

  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
  ) {
    ensureChainContentHistorySchema(db);
  }

  private getOne<T>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    const values = result[0]?.values?.[0];
    if (!values) return null;
    return Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T;
  }

  private getAll<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T
    );
  }

  /**
   * release-review P2: persist only when the last statement actually modified
   * a row — the sql.js fallback's save() exports and atomically rewrites the
   * WHOLE database file, so an INSERT OR IGNORE that ignored or an UPDATE
   * that matched nothing must not trigger it.
   */
  private saveIfModified(): void {
    if ((this.db.getRowsModified?.() ?? 0) > 0) this.saveDb();
  }

  /**
   * release-review P2: retention prune (see MAX_LEDGER_ROWS_PER_BOT).
   * Time-gated to once a day; failures degrade to a warn — retention must
   * never break a recording path.
   */
  private pruneIfDue(nowMs: number): void {
    if (nowMs - this.lastPrunedAtMs < LEDGER_PRUNE_INTERVAL_MS) return;
    this.lastPrunedAtMs = nowMs;
    try {
      for (const table of ['metabot_chain_writes', 'metabot_chain_reads'] as const) {
        const timeColumn = table === 'metabot_chain_writes' ? 'occurred_at_ms' : 'last_read_at_ms';
        const bots = this.getAll<{ metabot_id: number }>(
          `SELECT DISTINCT metabot_id FROM ${table}`,
        );
        for (const row of bots) {
          this.db.run(
            `DELETE FROM ${table} WHERE metabot_id = ? AND id NOT IN (
               SELECT id FROM ${table} WHERE metabot_id = ?
               ORDER BY ${timeColumn} DESC, id DESC LIMIT ?
             )`,
            [row.metabot_id, row.metabot_id, MAX_LEDGER_ROWS_PER_BOT],
          );
        }
      }
      this.saveIfModified();
    } catch (error) {
      console.warn(
        '[ChainContentHistory] retention prune failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Record one successfully broadcast pin. Idempotent on pin_id: a duplicate
   * (e.g. retried publish that actually went through once) returns
   * `created: false` and changes nothing.
   */
  recordWrite(input: RecordChainWriteInput): { created: boolean } {
    const pinId = String(input.pinId ?? '').trim();
    if (!pinId || !Number.isFinite(input.metabotId)) return { created: false };
    const rawText = typeof input.contentText === 'string' ? input.contentText : null;
    const truncated = rawText !== null && rawText.length > MAX_WRITE_CONTENT_CHARS;
    const contentText = rawText === null ? null : rawText.slice(0, MAX_WRITE_CONTENT_CHARS);
    const contentBytes = Number.isFinite(input.contentBytes)
      ? Number(input.contentBytes)
      : rawText !== null
        ? Buffer.byteLength(rawText, 'utf8')
        : 0;
    const occurredAtMs = Number.isFinite(input.occurredAtMs) ? input.occurredAtMs : Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO metabot_chain_writes
        (metabot_id, pin_id, tx_id, path, operation, content_text, content_truncated,
         content_bytes, content_type, summary_status, origin, occurred_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.metabotId,
        pinId,
        input.txId ?? null,
        input.path ?? null,
        input.operation ?? null,
        contentText,
        truncated ? 1 : 0,
        contentBytes,
        input.contentType ?? null,
        initialSummaryStatus(contentText?.length ?? 0),
        input.origin ?? null,
        occurredAtMs,
      ],
    );
    const created = (this.db.getRowsModified?.() ?? 0) > 0;
    if (created) this.saveDb();
    this.pruneIfDue(occurredAtMs);
    return { created };
  }

  getWriteByPinId(pinId: string): MetabotChainWriteRecord | null {
    const row = this.getOne<ChainWriteRow>(
      'SELECT * FROM metabot_chain_writes WHERE pin_id = ? LIMIT 1',
      [pinId],
    );
    return row ? writeRowToRecord(row) : null;
  }

  /**
   * Record one full read of a chain pin. Idempotent on (metabot_id, pin_id):
   * a re-read refreshes the metadata/excerpt and bumps read_count +
   * last_read_at_ms, but never clobbers an existing summary or KB flag.
   */
  recordRead(input: RecordChainReadInput): void {
    const pinId = String(input.pinId ?? '').trim();
    if (!pinId || !Number.isFinite(input.metabotId)) return;
    const rawText = typeof input.contentText === 'string' && input.contentText.length > 0
      ? input.contentText
      : null;
    const excerpt = rawText === null ? null : rawText.slice(0, MAX_READ_EXCERPT_CHARS);
    const contentBytes = Number.isFinite(input.contentBytes)
      ? Number(input.contentBytes)
      : rawText !== null
        ? Buffer.byteLength(rawText, 'utf8')
        : 0;
    const readAtMs = Number.isFinite(input.readAtMs) ? input.readAtMs : Date.now();
    this.db.run(
      `INSERT INTO metabot_chain_reads
        (metabot_id, pin_id, path, protocol, title, author_globalmetaid,
         content_excerpt, content_bytes, summary_status, source,
         first_read_at_ms, last_read_at_ms, read_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (metabot_id, pin_id) DO UPDATE SET
         path = COALESCE(excluded.path, metabot_chain_reads.path),
         protocol = COALESCE(excluded.protocol, metabot_chain_reads.protocol),
         title = COALESCE(excluded.title, metabot_chain_reads.title),
         author_globalmetaid = COALESCE(excluded.author_globalmetaid, metabot_chain_reads.author_globalmetaid),
         content_excerpt = COALESCE(excluded.content_excerpt, metabot_chain_reads.content_excerpt),
         content_bytes = CASE WHEN excluded.content_bytes > 0
                              THEN excluded.content_bytes ELSE metabot_chain_reads.content_bytes END,
         source = COALESCE(excluded.source, metabot_chain_reads.source),
         last_read_at_ms = excluded.last_read_at_ms,
         read_count = metabot_chain_reads.read_count + 1`,
      [
        input.metabotId,
        pinId,
        input.path ?? null,
        input.protocol ?? null,
        input.title ?? null,
        input.authorGlobalMetaId ?? null,
        excerpt,
        contentBytes,
        initialSummaryStatus(excerpt?.length ?? 0),
        input.source ?? null,
        readAtMs,
        readAtMs,
      ],
    );
    this.saveIfModified();
    this.pruneIfDue(readAtMs);
  }

  getReadByPinId(metabotId: number, pinId: string): MetabotChainReadRecord | null {
    const row = this.getOne<ChainReadRow>(
      'SELECT * FROM metabot_chain_reads WHERE metabot_id = ? AND pin_id = ? LIMIT 1',
      [metabotId, pinId],
    );
    return row ? readRowToRecord(row) : null;
  }

  /**
   * True when this bot PUBLISHED the pin from this device (the writes ledger
   * is local-only — pins published elsewhere are unknown). Used by the surf
   * interaction guard to block self-likes/self-answers (review 2, item 5).
   */
  hasWritePin(metabotId: number, pinId: string): boolean {
    const normalized = String(pinId || '').trim();
    if (!normalized) return false;
    const row = this.getOne<{ id: number }>(
      'SELECT id FROM metabot_chain_writes WHERE metabot_id = ? AND pin_id = ? LIMIT 1',
      [metabotId, normalized],
    );
    return row !== null;
  }

  /** Flag a read pin as saved into a knowledge base. No-op for unknown pins. */
  markReadSavedToKb(metabotId: number, pinId: string, kbId: string | null): boolean {
    this.db.run(
      `UPDATE metabot_chain_reads SET saved_to_kb = 1, kb_id = COALESCE(?, kb_id)
       WHERE metabot_id = ? AND pin_id = ?`,
      [kbId ?? null, metabotId, pinId],
    );
    const modified = (this.db.getRowsModified?.() ?? 0) > 0;
    if (modified) this.saveDb();
    return modified;
  }

  /**
   * One bot's writes (newest-bounded) for the surf seen-ledger reconciliation
   * (round 3): receipts lost to a crash/kill mid-run or a stopped orphan
   * session are re-derived locally from this ledger before each surf run —
   * a duplicate interaction prevented here costs nothing, one that slips
   * through costs gas.
   */
  listWritesForSurfReconciliation(metabotId: number, limit = 2000): MetabotChainWriteRecord[] {
    const capped = Math.max(1, Math.min(5000, Math.floor(limit)));
    return this.getAll<ChainWriteRow>(
      `SELECT * FROM metabot_chain_writes
       WHERE metabot_id = ?
       ORDER BY occurred_at_ms DESC LIMIT ?`,
      [metabotId, capped],
    ).map(writeRowToRecord);
  }

  /**
   * The bot's own PUBLISHED posts (buzz / simplenote / simplequestion — not
   * likes, comments or answers), newest first, for the surf reception section
   * (P0b). The local ledger is the source of truth for what this device
   * published; the briefing windows/caps the list.
   */
  listRecentOwnPostsForSurf(metabotId: number, limit = 20): MetabotChainWriteRecord[] {
    const capped = Math.max(1, Math.min(50, Math.floor(limit)));
    return this.getAll<ChainWriteRow>(
      `SELECT * FROM metabot_chain_writes
       WHERE metabot_id = ?
         AND origin IN ('tool:post_buzz', 'tool:post_simplenote', 'tool:post_simplequestion')
       ORDER BY occurred_at_ms DESC LIMIT ?`,
      [metabotId, capped],
    ).map(writeRowToRecord);
  }

  /** Oldest first across ALL bots — the summary service drains this queue. */
  listPendingSummaries(kind: 'write' | 'read', limit: number): Array<MetabotChainWriteRecord | MetabotChainReadRecord> {
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    if (kind === 'write') {
      return this.getAll<ChainWriteRow>(
        `SELECT * FROM metabot_chain_writes
         WHERE summary_status = 'pending' AND summary_attempts < ?
         ORDER BY occurred_at_ms ASC LIMIT ?`,
        [MAX_SUMMARY_ATTEMPTS, capped],
      ).map(writeRowToRecord);
    }
    return this.getAll<ChainReadRow>(
      `SELECT * FROM metabot_chain_reads
       WHERE summary_status = 'pending' AND summary_attempts < ?
       ORDER BY last_read_at_ms ASC LIMIT ?`,
      [MAX_SUMMARY_ATTEMPTS, capped],
    ).map(readRowToRecord);
  }

  /** How many summaries finished for one bot since `sinceMs` (daily cap). */
  countSummariesSince(kind: 'write' | 'read', metabotId: number, sinceMs: number): number {
    const table = kind === 'write' ? 'metabot_chain_writes' : 'metabot_chain_reads';
    const row = this.getOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}
       WHERE metabot_id = ? AND summary_status = 'done' AND summarized_at_ms >= ?`,
      [metabotId, sinceMs],
    );
    return Number(row?.n) || 0;
  }

  applySummarySuccess(kind: 'write' | 'read', id: number, summary: string, nowMs: number): void {
    const table = kind === 'write' ? 'metabot_chain_writes' : 'metabot_chain_reads';
    this.db.run(
      `UPDATE ${table}
       SET summary = ?, summary_status = 'done', summarized_at_ms = ?
       WHERE id = ?`,
      [summary, nowMs, id],
    );
    this.saveIfModified();
  }

  /** A failed attempt keeps the row pending until MAX_SUMMARY_ATTEMPTS. */
  applySummaryFailure(kind: 'write' | 'read', id: number): void {
    const table = kind === 'write' ? 'metabot_chain_writes' : 'metabot_chain_reads';
    this.db.run(
      `UPDATE ${table}
       SET summary_attempts = summary_attempts + 1,
           summary_status = CASE WHEN summary_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
       WHERE id = ?`,
      [MAX_SUMMARY_ATTEMPTS, id],
    );
    this.saveIfModified();
  }

  /** What the bot published within [dayStartMs, dayEndMs) — dream input. */
  listWritesForDay(metabotId: number, dayStartMs: number, dayEndMs: number, limit = 50): MetabotChainWriteRecord[] {
    return this.getAll<ChainWriteRow>(
      `SELECT * FROM metabot_chain_writes
       WHERE metabot_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
       ORDER BY occurred_at_ms ASC LIMIT ?`,
      [metabotId, dayStartMs, dayEndMs, limit],
    ).map(writeRowToRecord);
  }

  /** What the bot read within [dayStartMs, dayEndMs) — dream input. */
  listReadsForDay(metabotId: number, dayStartMs: number, dayEndMs: number, limit = 50): MetabotChainReadRecord[] {
    return this.getAll<ChainReadRow>(
      `SELECT * FROM metabot_chain_reads
       WHERE metabot_id = ? AND last_read_at_ms >= ? AND last_read_at_ms < ?
       ORDER BY last_read_at_ms ASC LIMIT ?`,
      [metabotId, dayStartMs, dayEndMs, limit],
    ).map(readRowToRecord);
  }

  /**
   * Recall what this bot published: newest first, optional keyword (matched
   * against stored text, summary, path and pin id) and time window. The
   * chain_history_recall tool's search path.
   */
  searchWrites(metabotId: number, options: ChainContentSearchOptions = {}): MetabotChainWriteRecord[] {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 20)));
    const clauses: string[] = ['metabot_id = ?'];
    const params: Array<string | number> = [metabotId];
    if (Number.isFinite(options.fromMs)) {
      clauses.push('occurred_at_ms >= ?');
      params.push(Number(options.fromMs));
    }
    if (Number.isFinite(options.toMs)) {
      clauses.push('occurred_at_ms < ?');
      params.push(Number(options.toMs));
    }
    const query = options.query?.trim();
    if (query) {
      const pattern = `%${escapeLikePattern(query)}%`;
      clauses.push(
        `(content_text LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
          OR path LIKE ? ESCAPE '\\' OR pin_id LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern, pattern);
    }
    return this.getAll<ChainWriteRow>(
      `SELECT * FROM metabot_chain_writes
       WHERE ${clauses.join(' AND ')}
       ORDER BY occurred_at_ms DESC LIMIT ?`,
      [...params, limit],
    ).map(writeRowToRecord);
  }

  /**
   * Recall what this bot fully read: newest read first, optional keyword
   * (matched against title, excerpt, summary, author, path, protocol and pin
   * id) and time window. The chain_history_recall tool's search path.
   */
  searchReads(metabotId: number, options: ChainContentSearchOptions = {}): MetabotChainReadRecord[] {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 20)));
    const clauses: string[] = ['metabot_id = ?'];
    const params: Array<string | number> = [metabotId];
    if (Number.isFinite(options.fromMs)) {
      clauses.push('last_read_at_ms >= ?');
      params.push(Number(options.fromMs));
    }
    if (Number.isFinite(options.toMs)) {
      clauses.push('last_read_at_ms < ?');
      params.push(Number(options.toMs));
    }
    const query = options.query?.trim();
    if (query) {
      const pattern = `%${escapeLikePattern(query)}%`;
      clauses.push(
        `(title LIKE ? ESCAPE '\\' OR content_excerpt LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
          OR author_globalmetaid LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
          OR protocol LIKE ? ESCAPE '\\' OR pin_id LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    return this.getAll<ChainReadRow>(
      `SELECT * FROM metabot_chain_reads
       WHERE ${clauses.join(' AND ')}
       ORDER BY last_read_at_ms DESC LIMIT ?`,
      [...params, limit],
    ).map(readRowToRecord);
  }

  pruneOldChainReads(input: { cutoffMs: number; excludeMetabotIds?: ReadonlySet<number> }): number {
    if (!Number.isFinite(input.cutoffMs) || input.cutoffMs <= 0) return 0;
    const excluded = input.excludeMetabotIds ? [...input.excludeMetabotIds] : [];
    const exclusionSql = excluded.length > 0
      ? ` AND metabot_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    this.db.run(
      `DELETE FROM metabot_chain_reads
       WHERE COALESCE(saved_to_kb, 0) = 0
         AND last_read_at_ms < ?${exclusionSql}`,
      [Math.floor(input.cutoffMs), ...excluded],
    );
    const deleted = this.db.getRowsModified?.() || 0;
    if (deleted > 0) {
      this.saveDb();
    }
    return deleted;
  }
}
