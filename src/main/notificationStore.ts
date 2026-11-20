import type { SqliteDatabase as Database } from './sqliteTypes';
import type {
  AgentNotification,
  AgentNotificationCategory,
  AgentNotificationInput,
  AgentNotificationListOptions,
  AgentNotificationListResult,
} from '../renderer/types/notification';

interface NotificationRow {
  event_id: string;
  type: string;
  category: AgentNotificationCategory;
  created_at: number;
  metabot_id: number | null;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  title: string;
  body: string;
  priority: 'normal' | 'high';
  target_json: string;
  read_at: number | null;
}

function rowToNotification(row: NotificationRow): AgentNotification {
  return {
    eventId: row.event_id,
    type: row.type,
    category: row.category,
    createdAt: row.created_at,
    metabotId: row.metabot_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    runId: row.run_id,
    title: row.title,
    body: row.body,
    priority: row.priority,
    target: JSON.parse(row.target_json),
    readAt: row.read_at,
  };
}

export interface NotificationDeliveryItem extends AgentNotification {
  attemptCount: number;
}

export class NotificationStore {
  constructor(private db: Database, private saveDb: () => void) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS notification_events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metabot_id INTEGER,
        session_id TEXT,
        task_id TEXT,
        run_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        priority TEXT NOT NULL,
        target_json TEXT NOT NULL,
        read_at INTEGER
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_notification_events_created ON notification_events(created_at DESC, event_id DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_notification_events_unread ON notification_events(read_at, created_at DESC)');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS notification_outbox (
        event_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_notification_outbox_delivery ON notification_outbox(state, next_attempt_at)');
    const columns = this.getAll<{ name: string }>('PRAGMA table_info(notification_outbox)');
    if (!columns.some((column) => column.name === 'claimed_at')) {
      this.db.run('ALTER TABLE notification_outbox ADD COLUMN claimed_at INTEGER');
    }
  }

  private getOne<T>(sql: string, params: unknown[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    return Object.fromEntries(result[0].columns.map((column, index) => [column, result[0]!.values[0]![index]])) as T;
  }

  private getAll<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]) return [];
    return result[0].values.map((values) => Object.fromEntries(result[0]!.columns.map((column, index) => [column, values[index]])) as T);
  }

  record(input: AgentNotificationInput): boolean {
    if (this.get(input.eventId)) return false;
    const createdAt = input.createdAt ?? Date.now();
    this.db.run('BEGIN IMMEDIATE');
    try {
      this.db.run(
        `INSERT INTO notification_events
          (event_id, type, category, created_at, metabot_id, session_id, task_id, run_id,
           title, body, priority, target_json, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          input.eventId, input.type, input.category, createdAt, input.metabotId, input.sessionId,
          input.taskId, input.runId, input.title, input.body, input.priority, JSON.stringify(input.target),
        ],
      );
      this.db.run(
        `INSERT INTO notification_outbox
          (event_id, state, attempt_count, next_attempt_at, last_error, created_at)
         VALUES (?, 'pending', 0, ?, NULL, ?)`,
        [input.eventId, createdAt, createdAt],
      );
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
    this.saveDb();
    return true;
  }

  get(eventId: string): AgentNotification | null {
    const row = this.getOne<NotificationRow>('SELECT * FROM notification_events WHERE event_id = ? LIMIT 1', [eventId]);
    return row ? rowToNotification(row) : null;
  }

  list(options: AgentNotificationListOptions = {}): AgentNotificationListResult {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
    const clauses = ['1 = 1'];
    const params: unknown[] = [];
    if (options.category) {
      clauses.push('category = ?');
      params.push(options.category);
    }
    if (options.unreadOnly) clauses.push('read_at IS NULL');
    if (options.before) {
      clauses.push('(created_at < ? OR (created_at = ? AND event_id < ?))');
      params.push(options.before.createdAt, options.before.createdAt, options.before.eventId);
    }
    params.push(limit + 1);
    const rows = this.getAll<NotificationRow>(
      `SELECT * FROM notification_events WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, event_id DESC LIMIT ?`,
      params,
    );
    const items = rows.slice(0, limit).map(rowToNotification);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, eventId: last.eventId } : null,
    };
  }

  getUnreadCount(category?: AgentNotificationCategory): number {
    const row = this.getOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM notification_events
       WHERE read_at IS NULL ${category ? 'AND category = ?' : ''}`,
      category ? [category] : [],
    );
    return row?.count ?? 0;
  }

  markRead(eventIds: string[], atMs: number = Date.now()): number {
    const ids = [...new Set(eventIds.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, 100);
    if (ids.length === 0) return 0;
    this.db.run(
      `UPDATE notification_events SET read_at = ?
       WHERE read_at IS NULL AND event_id IN (${ids.map(() => '?').join(',')})`,
      [atMs, ...ids],
    );
    const changed = this.db.getRowsModified?.() ?? 0;
    this.db.run(
      `UPDATE notification_outbox SET state = 'cancelled', claimed_at = NULL
       WHERE state IN ('pending', 'sending') AND event_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    this.saveDb();
    return changed;
  }

  markAllRead(category?: AgentNotificationCategory, atMs: number = Date.now()): number {
    this.db.run(
      `UPDATE notification_events SET read_at = ?
       WHERE read_at IS NULL ${category ? 'AND category = ?' : ''}`,
      category ? [atMs, category] : [atMs],
    );
    const changed = this.db.getRowsModified?.() ?? 0;
    this.db.run(
      `UPDATE notification_outbox SET state = 'cancelled', claimed_at = NULL
       WHERE state IN ('pending', 'sending') AND event_id IN (
         SELECT event_id FROM notification_events WHERE read_at IS NOT NULL
       )`,
    );
    this.saveDb();
    return changed;
  }

  listPendingOutbox(limit = 50): Array<{ eventId: string; attemptCount: number; nextAttemptAt: number }> {
    return this.getAll(
      `SELECT event_id AS eventId, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt
       FROM notification_outbox WHERE state = 'pending'
       ORDER BY next_attempt_at ASC, event_id ASC LIMIT ?`,
      [Math.min(100, Math.max(1, Math.floor(limit)))],
    );
  }

  claimPendingOutbox(now: number, limit = 20, leaseMs = 30_000): NotificationDeliveryItem[] {
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    this.db.run('BEGIN IMMEDIATE');
    try {
      this.db.run(
        `UPDATE notification_outbox SET state = 'pending', claimed_at = NULL
         WHERE state = 'sending' AND claimed_at < ?`,
        [now - leaseMs],
      );
      const rows = this.getAll<{ eventId: string; attemptCount: number }>(
        `SELECT o.event_id AS eventId, o.attempt_count AS attemptCount FROM notification_outbox o
         JOIN notification_events e ON e.event_id = o.event_id
         WHERE o.state = 'pending' AND o.next_attempt_at <= ? AND e.read_at IS NULL
         ORDER BY o.next_attempt_at ASC, o.event_id ASC LIMIT ?`,
        [now, boundedLimit],
      );
      for (const row of rows) {
        this.db.run(
          `UPDATE notification_outbox SET state = 'sending', claimed_at = ?
           WHERE event_id = ? AND state = 'pending'`,
          [now, row.eventId],
        );
      }
      this.db.run('COMMIT');
      return rows.map((row) => {
        const item = this.get(row.eventId);
        return item?.readAt === null ? { ...item, attemptCount: row.attemptCount } : null;
      }).filter((item): item is NotificationDeliveryItem => item !== null);
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  markOutboxDelivered(eventId: string): void {
    this.db.run(
      `UPDATE notification_outbox SET state = 'delivered', claimed_at = NULL, last_error = NULL
       WHERE event_id = ? AND state = 'sending'`,
      [eventId],
    );
    this.saveDb();
  }

  retryOutbox(eventId: string, error: string, nextAttemptAt: number): void {
    this.db.run(
      `UPDATE notification_outbox
       SET state = 'pending', claimed_at = NULL, attempt_count = attempt_count + 1,
           next_attempt_at = ?, last_error = ?
       WHERE event_id = ? AND state = 'sending'`,
      [nextAttemptAt, error.slice(0, 500), eventId],
    );
    this.saveDb();
  }
}
