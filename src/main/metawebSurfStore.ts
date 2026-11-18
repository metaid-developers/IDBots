import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * MetaWeb surf ("AI 冲浪") persistence — three tables behind the autonomous
 * surf loop:
 *
 * - `metaweb_surf_runs`: one row per surf run, including the structured surf
 *   report shown in the UI (like dream records) and fed into the same night's
 *   dream prompt. This table is run history only; learned content lives in the
 *   bot's knowledge bases / MetaID knowledge store, never duplicated here.
 * - `metaweb_surf_protocol_state`: per-bot per-protocol watermark
 *   (last-seen chain timestamp + pin id) so each surf fetches only content
 *   published after the previous surf.
 * - `metaweb_surf_seen_pins`: per-bot seen-pin ledger with the strongest
 *   action taken so far — briefing de-dup and the "never interact with the
 *   same pin twice" rule both read from here.
 */

export type MetawebSurfTrigger = 'manual-chat' | 'manual-ui' | 'pre-dream';
export type MetawebSurfRunStatus = 'running' | 'done' | 'failed';

/**
 * Strongest action the bot has taken on a seen pin, ranked: briefing-only
 * actions first, then read/save, then chain-writing interactions. A later
 * markSeen with a lower rank must not downgrade the recorded action.
 */
export type MetawebSurfSeenAction =
  | 'presented'
  | 'skipped'
  | 'read'
  | 'saved'
  | 'liked'
  | 'commented'
  | 'answered'
  | 'posted'
  | 'challenged';

/** Exported for the surf interaction guard (duplicate-interaction checks rank actions). */
export const SEEN_ACTION_RANK: Record<MetawebSurfSeenAction, number> = {
  presented: 0,
  skipped: 1,
  read: 2,
  saved: 3,
  liked: 4,
  commented: 5,
  answered: 6,
  posted: 7,
  challenged: 8,
};

export const SURF_SEEN_RETENTION_DAYS = 90;
export const SURF_SEEN_MAX_ROWS_PER_BOT = 5000;
/** A run row keeps at most this many characters of rendered report. */
const MAX_REPORT_MARKDOWN_CHARS = 20000;
const MAX_REPORT_JSON_CHARS = 40000;
/**
 * The nightly briefing digest (what the bot was shown) is stored next to the
 * report, under its own larger cap — previously it was appended to
 * report_markdown and the 20k report cap silently cut its tail (inbox/radar
 * sections vanished mid-pin-id; live-audit round 1).
 */
const MAX_BRIEFING_MARKDOWN_CHARS = 64000;

/** Cap a stored text with an explicit in-band marker — never a silent slice. */
const clampWithMarker = (text: string, cap: number, label: string): string => {
  if (text.length <= cap) return text;
  const marker = `\n\n[${label} truncated at ${cap} chars to fit storage — the tail was NOT stored]`;
  return `${text.slice(0, Math.max(0, cap - marker.length))}${marker}`;
};

export interface MetawebSurfRunStats {
  fetched: number;
  deepRead: number;
  savedToKb: number;
  knowledgePoints: number;
  liked: number;
  commented: number;
  answered: number;
  posted: number;
  challenged: number;
  inboxHandled: number;
  /** Items the deterministic inbox presented that night (host-computed — separates 'inbox empty' from 'nothing worth acting on'). */
  inboxPresented: number;
  discoveredProtocols: number;
  /** Scheduled tasks created (surf→work handoff); ground truth from the session marker. */
  tasksScheduled: number;
  /**
   * 1 when the pre-dream run found an empty briefing (no unseen items, an
   * error-free empty inbox) and skipped the unattended LLM session entirely,
   * finishing digest-only; 0 otherwise. Numeric because stats_json read-back
   * keeps numeric keys only.
   */
  sessionSkipped: number;
}

export const emptySurfRunStats = (): MetawebSurfRunStats => ({
  fetched: 0,
  deepRead: 0,
  savedToKb: 0,
  knowledgePoints: 0,
  liked: 0,
  commented: 0,
  answered: 0,
  posted: 0,
  challenged: 0,
  inboxHandled: 0,
  inboxPresented: 0,
  discoveredProtocols: 0,
  tasksScheduled: 0,
  sessionSkipped: 0,
});

export interface MetawebSurfRunRecord {
  id: string;
  metabotId: number;
  trigger: MetawebSurfTrigger;
  status: MetawebSurfRunStatus;
  stats: MetawebSurfRunStats;
  reportMarkdown: string | null;
  reportJson: string | null;
  /** The briefing digest the session was shown that night (separate from the report). */
  briefingMarkdown: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetawebSurfProtocolState {
  metabotId: number;
  protocolKey: string;
  /** Unix seconds of the newest chain item seen last run; null = never surfed. */
  lastSeenTs: number | null;
  lastPinId: string | null;
  /**
   * Opaque surf-reads R1 cursor of the unscanned backlog remainder (the
   * window's first page reported hasMore, or a backlog page still in
   * progress). null = no registered debt. Stored and forwarded verbatim,
   * never parsed client-side.
   */
  backlogCursor: string | null;
  updatedAt: string;
}

interface MetawebSurfRunRow {
  id: string;
  metabot_id: number;
  trigger: string;
  status: MetawebSurfRunStatus;
  stats_json: string;
  report_markdown: string | null;
  report_json: string | null;
  briefing_markdown: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MetawebSurfProtocolStateRow {
  metabot_id: number;
  protocol_key: string;
  last_seen_ts: number | null;
  last_pin_id: string | null;
  last_fresh_cursor: string | null;
  updated_at: string;
}

const parseStats = (raw: string | null): MetawebSurfRunStats => {
  const empty = emptySurfRunStats();
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    const out = emptySurfRunStats();
    for (const key of Object.keys(out) as Array<keyof MetawebSurfRunStats>) {
      const value = Number((parsed as Record<string, unknown>)[key]);
      if (Number.isFinite(value) && value >= 0) out[key] = Math.floor(value);
    }
    return out;
  } catch {
    return empty;
  }
};

const rowToRunRecord = (row: MetawebSurfRunRow): MetawebSurfRunRecord => ({
  id: row.id,
  metabotId: row.metabot_id,
  trigger: (['manual-chat', 'manual-ui', 'pre-dream'] as const).includes(row.trigger as MetawebSurfTrigger)
    ? (row.trigger as MetawebSurfTrigger)
    : 'manual-ui',
  status: row.status,
  stats: parseStats(row.stats_json),
  reportMarkdown: row.report_markdown || null,
  reportJson: row.report_json || null,
  briefingMarkdown: row.briefing_markdown || null,
  error: row.error || null,
  startedAt: row.started_at,
  finishedAt: row.finished_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const rowToProtocolState = (row: MetawebSurfProtocolStateRow): MetawebSurfProtocolState => ({
  metabotId: row.metabot_id,
  protocolKey: row.protocol_key,
  lastSeenTs: row.last_seen_ts === null || row.last_seen_ts === undefined ? null : Number(row.last_seen_ts),
  lastPinId: row.last_pin_id || null,
  backlogCursor: row.last_fresh_cursor || null,
  updatedAt: row.updated_at,
});

/** Create the surf tables without changing existing user data. */
export function ensureMetawebSurfSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS metaweb_surf_runs (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'manual-ui'
        CHECK (trigger IN ('manual-chat', 'manual-ui', 'pre-dream')),
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'done', 'failed')),
      stats_json TEXT NOT NULL DEFAULT '{}',
      report_markdown TEXT,
      report_json TEXT,
      briefing_markdown TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaweb_surf_runs_metabot
      ON metaweb_surf_runs(metabot_id, created_at DESC);
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS metaweb_surf_protocol_state (
      metabot_id INTEGER NOT NULL,
      protocol_key TEXT NOT NULL,
      last_seen_ts INTEGER,
      last_pin_id TEXT,
      last_fresh_cursor TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (metabot_id, protocol_key)
    );
  `);
  // First-run migration for existing user databases: the backlog-catch-up
  // cursor column is added idempotently (PRAGMA check, same pattern as
  // CoworkStore.ensureMemorySchemaCompatibility). Old rows start with no
  // registered debt — exactly the state a pre-migration bot was in.
  try {
    const protocolStateCols = db.exec('PRAGMA table_info(metaweb_surf_protocol_state);');
    const protocolStateColumns = (protocolStateCols[0]?.values ?? []).map((row) => String(row[1]));
    if (!protocolStateColumns.includes('last_fresh_cursor')) {
      db.run('ALTER TABLE metaweb_surf_protocol_state ADD COLUMN last_fresh_cursor TEXT;');
    }
    // Same idempotent pattern for the separated briefing digest (live-audit
    // round 1): pre-migration rows keep their digest inside report_markdown.
    const runCols = db.exec('PRAGMA table_info(metaweb_surf_runs);');
    const runColumns = (runCols[0]?.values ?? []).map((row) => String(row[1]));
    if (!runColumns.includes('briefing_markdown')) {
      db.run('ALTER TABLE metaweb_surf_runs ADD COLUMN briefing_markdown TEXT;');
    }
  } catch (error) {
    console.warn('[MetawebSurfStore] Failed to migrate metaweb surf tables:', error);
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS metaweb_surf_seen_pins (
      metabot_id INTEGER NOT NULL,
      pin_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'presented'
        CHECK (action IN ('presented', 'skipped', 'read', 'saved',
                          'liked', 'commented', 'answered', 'posted', 'challenged')),
      PRIMARY KEY (metabot_id, pin_id)
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaweb_surf_seen_pins_first_seen
      ON metaweb_surf_seen_pins(metabot_id, first_seen_at);
  `);
}

export class MetawebSurfStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
  ) {
    ensureMetawebSurfSchema(db);
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

  // ---------------- runs ----------------

  createRun(input: {
    id: string;
    metabotId: number;
    trigger: MetawebSurfTrigger;
    nowIso: string;
  }): MetawebSurfRunRecord {
    this.db.run(
      `INSERT INTO metaweb_surf_runs
        (id, metabot_id, trigger, status, stats_json, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'running', '{}', ?, ?, ?)`,
      [input.id, input.metabotId, input.trigger, input.nowIso, input.nowIso, input.nowIso],
    );
    this.saveDb();
    const created = this.getRun(input.id);
    if (!created) throw new Error('Failed to create surf run');
    return created;
  }

  finishRun(
    id: string,
    outcome: {
      status: Exclude<MetawebSurfRunStatus, 'running'>;
      stats: MetawebSurfRunStats;
      reportMarkdown?: string | null;
      reportJson?: string | null;
      briefingMarkdown?: string | null;
      error?: string | null;
      finishedAtIso: string;
    },
  ): void {
    this.db.run(
      `UPDATE metaweb_surf_runs
       SET status = ?, stats_json = ?, report_markdown = ?, report_json = ?,
           briefing_markdown = ?, error = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        outcome.status,
        JSON.stringify(outcome.stats),
        outcome.reportMarkdown ? clampWithMarker(outcome.reportMarkdown, MAX_REPORT_MARKDOWN_CHARS, 'report') : null,
        outcome.reportJson ? clampWithMarker(outcome.reportJson, MAX_REPORT_JSON_CHARS, 'report JSON') : null,
        outcome.briefingMarkdown ? clampWithMarker(outcome.briefingMarkdown, MAX_BRIEFING_MARKDOWN_CHARS, 'briefing digest') : null,
        outcome.error ?? null,
        outcome.finishedAtIso,
        outcome.finishedAtIso,
        id,
      ],
    );
    this.saveDb();
  }

  getRun(id: string): MetawebSurfRunRecord | null {
    const row = this.getOne<MetawebSurfRunRow>(
      'SELECT * FROM metaweb_surf_runs WHERE id = ? LIMIT 1',
      [id],
    );
    return row ? rowToRunRecord(row) : null;
  }

  /** Newest first, for the UI report list. */
  listRunsByMetabot(metabotId: number, limit = 50): MetawebSurfRunRecord[] {
    const capped = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    return this.getAll<MetawebSurfRunRow>(
      'SELECT * FROM metaweb_surf_runs WHERE metabot_id = ? ORDER BY created_at DESC LIMIT ?',
      [metabotId, capped],
    ).map(rowToRunRecord);
  }

  /**
   * One day's runs, newest first, for the surf-report panel's calendar day
   * view. `dayStartIso`/`dayEndIso` delimit a HALF-OPEN range (`>=` start,
   * `<` end) in the same ISO coordinate system as `created_at`; the caller
   * picks the boundaries (UTC day cut matches the `listRunDays` markers).
   */
  listRunsByMetabotAndDay(metabotId: number, dayStartIso: string, dayEndIso: string): MetawebSurfRunRecord[] {
    return this.getAll<MetawebSurfRunRow>(
      'SELECT * FROM metaweb_surf_runs WHERE metabot_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC',
      [metabotId, dayStartIso, dayEndIso],
    ).map(rowToRunRecord);
  }

  /**
   * Distinct UTC day prefixes (`YYYY-MM-DD`) of this bot's surf runs, newest
   * first — the calendar's marker dots. Same coordinate system as
   * `created_at` itself, so a marker, the selected day, and that day's
   * `listRunsByMetabotAndDay` range always agree.
   */
  listRunDays(metabotId: number): string[] {
    return this.getAll<{ day: string }>(
      'SELECT DISTINCT substr(created_at, 1, 10) AS day FROM metaweb_surf_runs WHERE metabot_id = ? ORDER BY day DESC',
      [metabotId],
    ).map((row) => row.day);
  }

  /** Latest finished run regardless of trigger — the "surfed within 20h" check. */
  getLatestFinishedRun(metabotId: number): MetawebSurfRunRecord | null {
    const row = this.getOne<MetawebSurfRunRow>(
      `SELECT * FROM metaweb_surf_runs
       WHERE metabot_id = ? AND status = 'done'
       ORDER BY finished_at DESC LIMIT 1`,
      [metabotId],
    );
    return row ? rowToRunRecord(row) : null;
  }

  /**
   * Crash recovery: runs left 'running' by a killed process become failed —
   * a surf run has no queue to rejoin, the next trigger starts a fresh one.
   */
  failStaleRunningRuns(input: { error: string; nowIso: string; excludeId?: string }): number {
    if (input.excludeId) {
      this.db.run(
        `UPDATE metaweb_surf_runs
         SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
         WHERE status = 'running' AND id <> ?`,
        [input.error, input.nowIso, input.nowIso, input.excludeId],
      );
    } else {
      this.db.run(
        `UPDATE metaweb_surf_runs
         SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
         WHERE status = 'running'`,
        [input.error, input.nowIso, input.nowIso],
      );
    }
    this.saveDb();
    return this.db.getRowsModified?.() ?? 0;
  }

  // ---------------- protocol watermarks ----------------

  getProtocolState(metabotId: number, protocolKey: string): MetawebSurfProtocolState | null {
    const row = this.getOne<MetawebSurfProtocolStateRow>(
      'SELECT * FROM metaweb_surf_protocol_state WHERE metabot_id = ? AND protocol_key = ? LIMIT 1',
      [metabotId, protocolKey],
    );
    return row ? rowToProtocolState(row) : null;
  }

  listProtocolStates(metabotId: number): MetawebSurfProtocolState[] {
    return this.getAll<MetawebSurfProtocolStateRow>(
      'SELECT * FROM metaweb_surf_protocol_state WHERE metabot_id = ? ORDER BY protocol_key ASC',
      [metabotId],
    ).map(rowToProtocolState);
  }

  /**
   * Advance the watermark after a successful run; never rewinds.
   *
   * `lastSeenTs: null` leaves the watermark column untouched (backlog pages
   * never advance it — their items are older than the watermark).
   *
   * `backlogCursor`: undefined leaves the stored cursor untouched, null
   * CLEARS it (backlog debt drained), a string STORES it verbatim (opaque
   * server token — the store never parses or validates it).
   */
  advanceProtocolState(
    metabotId: number,
    protocolKey: string,
    input: {
      lastSeenTs: number | null;
      lastPinId?: string | null;
      nowIso: string;
      backlogCursor?: string | null;
    },
  ): void {
    const existing = this.getProtocolState(metabotId, protocolKey);
    const nextTs = typeof input.lastSeenTs === 'number'
      ? (existing?.lastSeenTs != null
        ? Math.max(existing.lastSeenTs, Math.floor(input.lastSeenTs))
        : Math.floor(input.lastSeenTs))
      : (existing?.lastSeenTs ?? null);
    const nextPinId = input.lastPinId !== undefined ? input.lastPinId : (existing?.lastPinId ?? null);
    const nextCursor = input.backlogCursor !== undefined
      ? input.backlogCursor
      : (existing?.backlogCursor ?? null);
    this.db.run(
      `INSERT INTO metaweb_surf_protocol_state
        (metabot_id, protocol_key, last_seen_ts, last_pin_id, last_fresh_cursor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (metabot_id, protocol_key)
       DO UPDATE SET last_seen_ts = excluded.last_seen_ts,
                     last_pin_id = excluded.last_pin_id,
                     last_fresh_cursor = excluded.last_fresh_cursor,
                     updated_at = excluded.updated_at`,
      [metabotId, protocolKey, nextTs, nextPinId, nextCursor, input.nowIso],
    );
    this.saveDb();
  }

  // ---------------- seen-pin ledger ----------------

  getSeenAction(metabotId: number, pinId: string): MetawebSurfSeenAction | null {
    const row = this.getOne<{ action: MetawebSurfSeenAction }>(
      'SELECT action FROM metaweb_surf_seen_pins WHERE metabot_id = ? AND pin_id = ? LIMIT 1',
      [metabotId, pinId],
    );
    return row?.action ?? null;
  }

  /**
   * Record that the bot saw a pin, upgrading to the strongest action so far.
   * first_seen_at stays at the original sighting.
   */
  markSeen(metabotId: number, pinId: string, action: MetawebSurfSeenAction, nowIso: string): void {
    const normalizedPinId = String(pinId || '').trim();
    if (!normalizedPinId) return;
    const existing = this.getSeenAction(metabotId, normalizedPinId);
    if (!existing) {
      this.db.run(
        `INSERT INTO metaweb_surf_seen_pins (metabot_id, pin_id, first_seen_at, action)
         VALUES (?, ?, ?, ?)`,
        [metabotId, normalizedPinId, nowIso, action],
      );
      this.saveDb();
      return;
    }
    if (SEEN_ACTION_RANK[action] > SEEN_ACTION_RANK[existing]) {
      this.db.run(
        'UPDATE metaweb_surf_seen_pins SET action = ? WHERE metabot_id = ? AND pin_id = ?',
        [action, metabotId, normalizedPinId],
      );
      this.saveDb();
    }
  }

  /**
   * Batch variant of markSeen: one read + at most one save for a whole run's
   * worth of ledger writes. A single surf presents up to ~150 pins, and on the
   * WASM backend every saveDb serializes the whole database — per-row saves
   * made the success path O(n) full-DB writes. Strongest action wins both
   * within the batch and against the stored row; first_seen_at is kept.
   */
  markSeenBatch(
    metabotId: number,
    entries: Array<{ pinId: string; action: MetawebSurfSeenAction }>,
    nowIso: string,
  ): void {
    const strongest = new Map<string, MetawebSurfSeenAction>();
    for (const entry of entries) {
      const pinId = String(entry.pinId || '').trim();
      if (!pinId) continue;
      const current = strongest.get(pinId);
      if (!current || SEEN_ACTION_RANK[entry.action] > SEEN_ACTION_RANK[current]) {
        strongest.set(pinId, entry.action);
      }
    }
    if (strongest.size === 0) return;
    const pinIds = [...strongest.keys()];
    const placeholders = pinIds.map(() => '?').join(', ');
    const existingRows = this.getAll<{ pin_id: string; action: MetawebSurfSeenAction }>(
      `SELECT pin_id, action FROM metaweb_surf_seen_pins
       WHERE metabot_id = ? AND pin_id IN (${placeholders})`,
      [metabotId, ...pinIds],
    );
    const existing = new Map(existingRows.map((row) => [row.pin_id, row.action]));
    let dirty = false;
    for (const [pinId, action] of strongest) {
      const stored = existing.get(pinId);
      if (!stored) {
        this.db.run(
          `INSERT INTO metaweb_surf_seen_pins (metabot_id, pin_id, first_seen_at, action)
           VALUES (?, ?, ?, ?)`,
          [metabotId, pinId, nowIso, action],
        );
        dirty = true;
      } else if (SEEN_ACTION_RANK[action] > SEEN_ACTION_RANK[stored]) {
        this.db.run(
          'UPDATE metaweb_surf_seen_pins SET action = ? WHERE metabot_id = ? AND pin_id = ?',
          [action, metabotId, pinId],
        );
        dirty = true;
      }
    }
    if (dirty) this.saveDb();
  }

  /** Return the subset of candidate pin ids the bot has never seen. */
  filterUnseen(metabotId: number, pinIds: string[]): string[] {
    const candidates = pinIds.map((id) => String(id || '').trim()).filter(Boolean);
    if (candidates.length === 0) return [];
    const placeholders = candidates.map(() => '?').join(', ');
    const seenRows = this.getAll<{ pin_id: string }>(
      `SELECT pin_id FROM metaweb_surf_seen_pins
       WHERE metabot_id = ? AND pin_id IN (${placeholders})`,
      [metabotId, ...candidates],
    );
    const seen = new Set(seenRows.map((row) => row.pin_id));
    return candidates.filter((id) => !seen.has(id));
  }

  /**
   * Bound ledger growth: drop entries older than the retention window, then
   * (if still oversized) the oldest entries beyond the per-bot cap.
   */
  pruneSeenPins(metabotId: number, nowIso: string): void {
    const cutoffMs = Date.parse(nowIso) - SURF_SEEN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(cutoffMs)) {
      this.db.run(
        'DELETE FROM metaweb_surf_seen_pins WHERE metabot_id = ? AND first_seen_at < ?',
        [metabotId, new Date(cutoffMs).toISOString()],
      );
    }
    const countRow = this.getOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM metaweb_surf_seen_pins WHERE metabot_id = ?',
      [metabotId],
    );
    const excess = (Number(countRow?.n) || 0) - SURF_SEEN_MAX_ROWS_PER_BOT;
    if (excess > 0) {
      this.db.run(
        `DELETE FROM metaweb_surf_seen_pins
         WHERE rowid IN (
           SELECT rowid FROM metaweb_surf_seen_pins
           WHERE metabot_id = ? ORDER BY first_seen_at ASC LIMIT ?
         )`,
        [metabotId, excess],
      );
    }
    this.saveDb();
  }
}
