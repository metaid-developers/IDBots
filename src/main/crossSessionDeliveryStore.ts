import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';

export type CrossSessionDeliveryState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CrossSessionDelivery {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  message: string;
  messageId: string | null;
  renderedMessage: string | null;
  state: CrossSessionDeliveryState;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  insertedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  /**
   * Dispatch-report flag: when the turn triggered by this delivery settles,
   * the drain reports the outcome (plus the final reply excerpt) back into
   * the SOURCE session as a `dispatch_report:<id>` delivery. Set by the
   * bot-facing idbots_session_insert_user_message tool; internal relays
   * (ORCH-NOTIFY, wrap-up, group-task) stay silent.
   */
  notifySource: boolean;
}

export interface CrossSessionDeliveryReliabilitySnapshot {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  retrying: number;
  attempts: number;
  oldestPendingAgeMs: number | null;
  averageCompletionLatencyMs: number | null;
  maxCompletionLatencyMs: number | null;
}

interface Row { [key: string]: unknown }

function fromRow(row: Row): CrossSessionDelivery {
  return {
    id: String(row.id),
    sourceSessionId: String(row.source_session_id),
    targetSessionId: String(row.target_session_id),
    message: String(row.message),
    messageId: row.message_id == null ? null : String(row.message_id),
    renderedMessage: row.rendered_message == null ? null : String(row.rendered_message),
    state: String(row.state) as CrossSessionDeliveryState,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
    insertedAt: row.inserted_at == null ? null : Number(row.inserted_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    updatedAt: Number(row.updated_at),
    notifySource: Number(row.notify_source ?? 0) === 1,
  };
}

export class CrossSessionDeliveryStore {
  private readonly now: () => number;
  private readonly backoffMs: readonly number[];

  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
    options: { now?: () => number; backoffMs?: readonly number[] } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.backoffMs = options.backoffMs ?? [2_000, 5_000, 15_000, 30_000];
    this.ensureTables();
  }

  private getOne<T extends Row>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values?.[0]) return null;
    const row: Row = {};
    result[0].columns.forEach((column, index) => { row[column] = result[0].values[0][index]; });
    return row as T;
  }

  private getAll<T extends Row>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    return (result[0]?.values ?? []).map((values) => {
      const row: Row = {};
      result[0].columns.forEach((column, index) => { row[column] = values[index]; });
      return row as T;
    });
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_cross_session_deliveries (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        message_id TEXT,
        rendered_message TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','running','completed','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        inserted_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        notify_source INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cross_session_delivery_target
        ON cowork_cross_session_deliveries(target_session_id, state, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_cross_session_delivery_state
        ON cowork_cross_session_deliveries(state, next_attempt_at, created_at);
    `);
    // Upgrade path for tables created before the dispatch-report flag
    // existed (idempotent: skipped once the column is present).
    const columns = this.getAll<Row>('PRAGMA table_info(cowork_cross_session_deliveries)');
    if (!columns.some((column) => String(column.name) === 'notify_source')) {
      this.db.run('ALTER TABLE cowork_cross_session_deliveries ADD COLUMN notify_source INTEGER NOT NULL DEFAULT 0;');
    }
    this.saveDb();
  }

  enqueue(input: { sourceSessionId: string; targetSessionId: string; message: string; deliveryId?: string; notifySource?: boolean }): CrossSessionDelivery {
    const id = input.deliveryId?.trim() || uuidv4();
    const existing = this.getById(id);
    if (existing) {
      if (
        existing.sourceSessionId !== input.sourceSessionId
        || existing.targetSessionId !== input.targetSessionId
        || existing.message !== input.message
      ) {
        throw new Error('CROSS_SESSION_DELIVERY_CONFLICT');
      }
      return existing;
    }
    const now = this.now();
    this.db.run(`
      INSERT INTO cowork_cross_session_deliveries
        (id, source_session_id, target_session_id, message, state, next_attempt_at, created_at, updated_at, notify_source)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `, [id, input.sourceSessionId, input.targetSessionId, input.message, now, now, input.notifySource ? 1 : 0]);
    this.saveDb();
    return this.getById(id)!;
  }

  getById(id: string): CrossSessionDelivery | null {
    const row = this.getOne<Row>('SELECT * FROM cowork_cross_session_deliveries WHERE id = ?', [id]);
    return row ? fromRow(row) : null;
  }

  attachMessage(id: string, messageId: string, renderedMessage: string): CrossSessionDelivery {
    const now = this.now();
    this.db.run(`
      UPDATE cowork_cross_session_deliveries
      SET message_id = ?, rendered_message = ?, inserted_at = COALESCE(inserted_at, ?), updated_at = ?
      WHERE id = ? AND state = 'pending'
    `, [messageId, renderedMessage, now, now, id]);
    this.saveDb();
    return this.getById(id)!;
  }

  markRunning(id: string): CrossSessionDelivery {
    const now = this.now();
    this.db.run(`
      UPDATE cowork_cross_session_deliveries
      SET state = 'running', attempts = attempts + 1,
          started_at = COALESCE(started_at, ?), next_attempt_at = 0, last_error = NULL, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `, [now, now, id]);
    this.saveDb();
    return this.getById(id)!;
  }

  markCompleted(id: string): CrossSessionDelivery {
    const now = this.now();
    this.db.run(`
      UPDATE cowork_cross_session_deliveries
      SET state = 'completed', completed_at = ?, next_attempt_at = 0, last_error = NULL, updated_at = ?
      WHERE id = ? AND state = 'running'
    `, [now, now, id]);
    this.saveDb();
    return this.getById(id)!;
  }

  markAttemptFailed(id: string, error: string): CrossSessionDelivery {
    const current = this.getById(id);
    if (!current || current.state !== 'running') return current!;
    const exhausted = current.attempts > this.backoffMs.length;
    const nextAttemptAt = exhausted ? 0 : this.now() + this.backoffMs[Math.max(0, current.attempts - 1)];
    this.db.run(`
      UPDATE cowork_cross_session_deliveries
      SET state = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND state = 'running'
    `, [exhausted ? 'failed' : 'pending', nextAttemptAt, error, this.now(), id]);
    this.saveDb();
    return this.getById(id)!;
  }

  markCancelled(id: string, error: string): CrossSessionDelivery {
    this.db.run(`
      UPDATE cowork_cross_session_deliveries
      SET state = 'cancelled', next_attempt_at = 0, last_error = ?, updated_at = ?
      WHERE id = ? AND state != 'completed'
    `, [error, this.now(), id]);
    this.saveDb();
    return this.getById(id)!;
  }

  /**
   * Push one pending delivery's next attempt past a budget/pause horizon
   * WITHOUT consuming an attempt or touching its message — the row stays
   * pending and resumes when its new time comes due. In-memory update only:
   * a budget pass may defer many rows, so the caller flushes once via
   * persist() instead of paying a full-DB save per row.
   */
  deferDeliveryTo(id: string, nextAttemptAtMs: number, note: string): void {
    this.db.run(`
      UPDATE cowork_cross_session_deliveries
      SET next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'
    `, [Math.max(0, Math.trunc(nextAttemptAtMs)), note, this.now(), id]);
  }

  /** Flush pending in-memory store updates to disk (the injected save fn). */
  persist(): void {
    this.saveDb();
  }

  cancelTarget(targetSessionId: string, error: string): number {
    const active = this.getAll<{ id: string }>(`
      SELECT id FROM cowork_cross_session_deliveries
      WHERE target_session_id = ? AND state IN ('pending','running')
    `, [targetSessionId]);
    for (const row of active) this.markCancelled(row.id, error);
    return active.length;
  }

  nextDue(targetSessionId: string, now = this.now()): CrossSessionDelivery | null {
    const row = this.getOne<Row>(`
      SELECT * FROM cowork_cross_session_deliveries
      WHERE target_session_id = ? AND state = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at ASC, id ASC LIMIT 1
    `, [targetSessionId, now]);
    return row ? fromRow(row) : null;
  }

  nextPending(targetSessionId: string): CrossSessionDelivery | null {
    const row = this.getOne<Row>(`
      SELECT * FROM cowork_cross_session_deliveries
      WHERE target_session_id = ? AND state = 'pending'
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC LIMIT 1
    `, [targetSessionId]);
    return row ? fromRow(row) : null;
  }

  countPending(targetSessionId: string): number {
    const row = this.getOne<{ count: number }>(`
      SELECT COUNT(*) AS count FROM cowork_cross_session_deliveries
      WHERE target_session_id = ? AND state = 'pending'
    `, [targetSessionId]);
    return Number(row?.count ?? 0);
  }

  recoverAfterRestart(): string[] {
    const targets = this.getAll<{ target_session_id: string }>(`
      SELECT DISTINCT target_session_id FROM cowork_cross_session_deliveries
      WHERE state IN ('pending','running')
    `).map((row) => row.target_session_id);
    this.db.run(`
      UPDATE cowork_cross_session_deliveries
      SET state = 'pending', next_attempt_at = ?, last_error = 'RECOVERED_AFTER_RESTART', updated_at = ?
      WHERE state = 'running'
    `, [this.now(), this.now()]);
    this.saveDb();
    return targets;
  }

  listDeliveries(): CrossSessionDelivery[] {
    return this.getAll<Row>('SELECT * FROM cowork_cross_session_deliveries ORDER BY created_at ASC, id ASC').map(fromRow);
  }

  reliabilitySnapshot(now = this.now()): CrossSessionDeliveryReliabilitySnapshot {
    const rows = this.listDeliveries();
    const pendingRows = rows.filter((row) => row.state === 'pending');
    const completedLatencies = rows
      .filter((row) => row.state === 'completed' && row.completedAt !== null)
      .map((row) => Math.max(0, row.completedAt! - row.createdAt));
    return {
      total: rows.length,
      pending: pendingRows.length,
      running: rows.filter((row) => row.state === 'running').length,
      completed: rows.filter((row) => row.state === 'completed').length,
      failed: rows.filter((row) => row.state === 'failed').length,
      cancelled: rows.filter((row) => row.state === 'cancelled').length,
      retrying: pendingRows.filter((row) => row.attempts > 0).length,
      attempts: rows.reduce((sum, row) => sum + row.attempts, 0),
      oldestPendingAgeMs: pendingRows.length > 0
        ? Math.max(0, now - Math.min(...pendingRows.map((row) => row.createdAt)))
        : null,
      averageCompletionLatencyMs: completedLatencies.length > 0
        ? completedLatencies.reduce((sum, value) => sum + value, 0) / completedLatencies.length
        : null,
      maxCompletionLatencyMs: completedLatencies.length > 0 ? Math.max(...completedLatencies) : null,
    };
  }
}
