import { randomBytes } from 'node:crypto';
import type { SqliteDatabase as Database } from './sqliteTypes';

export type TwinTodoStatus = 'pending' | 'done';

export interface TwinTodoItem {
  id: string;
  metabotId: number;
  title: string;
  status: TwinTodoStatus;
  taskId: string | null;
  sessionId: string | null;
  projectKey: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AddTwinTodoInput {
  metabotId: number;
  title: string;
  taskId?: string | null;
  sessionId?: string | null;
  projectKey?: string | null;
  note?: string | null;
}

export interface UpdateTwinTodoInput {
  title?: string;
  status?: TwinTodoStatus;
  taskId?: string | null;
  sessionId?: string | null;
  projectKey?: string | null;
  note?: string | null;
}

export interface ListTwinTodosOptions {
  metabotId: number;
  includeDone?: boolean;
  taskId?: string | null;
  sessionId?: string | null;
  projectKey?: string | null;
  limit?: number;
}

const MAX_TITLE_CHARS = 120;
const MAX_NOTE_CHARS = 140;
const MAX_KEY_CHARS = 80;
const MAX_RETAINED_DONE_PER_BOT = 80;

function nowIso(): string {
  return new Date().toISOString();
}

function cleanText(raw: unknown, maxChars: number): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanNullable(raw: unknown, maxChars: number = MAX_KEY_CHARS): string | null {
  const cleaned = cleanText(raw, maxChars);
  return cleaned ? cleaned : null;
}

/**
 * Persistent, lightweight memory-tier todo store for Twin Bot (and local Bots).
 *
 * Sits strictly below Managed Tasks / Long-Term Tasks:
 * - Never rendered as owner-facing task cards or Live Stage Task Progress bars.
 * - Ultra-compact schema so pending reminders take minimal prompt context while
 *   preventing lightweight follow-ups, conditional promises, and side requests
 *   from being forgotten across multi-topic Studio turns or restarts.
 */
export class TwinTodoStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
  ) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_todos (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        task_id TEXT,
        session_id TEXT,
        project_key TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_todos_bot_status
        ON metabot_todos(metabot_id, status, updated_at DESC);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_todos_bot_task
        ON metabot_todos(metabot_id, task_id, status);
    `);
  }

  private queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const result = this.db.exec(sql, params);
    if (!result[0]) return [];
    const { columns, values } = result[0];
    return values.map((row) => {
      const record: Record<string, unknown> = {};
      columns.forEach((col, index) => {
        record[col] = row[index];
      });
      return record;
    });
  }

  private mapRow(row: Record<string, unknown>): TwinTodoItem {
    const rawStatus = cleanText(row.status, 16);
    const status: TwinTodoStatus = rawStatus === 'done' ? 'done' : 'pending';
    return {
      id: String(row.id ?? ''),
      metabotId: Number(row.metabot_id ?? 0),
      title: String(row.title ?? ''),
      status,
      taskId: cleanNullable(row.task_id, 120),
      sessionId: cleanNullable(row.session_id, 120),
      projectKey: cleanNullable(row.project_key, MAX_KEY_CHARS),
      note: cleanNullable(row.note, MAX_NOTE_CHARS),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      completedAt: cleanNullable(row.completed_at, 64),
    };
  }

  private generateShortId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `td_${randomBytes(3).toString('hex')}`;
      if (!this.getById(candidate)) return candidate;
    }
    return `td_${randomBytes(5).toString('hex')}`;
  }

  getById(id: string): TwinTodoItem | null {
    const trimmed = cleanText(id, 64);
    if (!trimmed) return null;
    const rows = this.queryAll('SELECT * FROM metabot_todos WHERE id = ? LIMIT 1', [trimmed]);
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  list(options: ListTwinTodosOptions): TwinTodoItem[] {
    const clauses: string[] = ['metabot_id = ?'];
    const params: unknown[] = [options.metabotId];
    if (!options.includeDone) {
      clauses.push("status = 'pending'");
    }
    const taskId = cleanNullable(options.taskId, 120);
    if (taskId) {
      clauses.push('task_id = ?');
      params.push(taskId);
    }
    const sessionId = cleanNullable(options.sessionId, 120);
    if (sessionId) {
      clauses.push('session_id = ?');
      params.push(sessionId);
    }
    const projectKey = cleanNullable(options.projectKey, MAX_KEY_CHARS);
    if (projectKey) {
      clauses.push('project_key = ?');
      params.push(projectKey);
    }
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    params.push(limit);
    const rows = this.queryAll(
      `SELECT * FROM metabot_todos
        WHERE ${clauses.join(' AND ')}
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC,
                 created_at ASC
        LIMIT ?`,
      params,
    );
    return rows.map((row) => this.mapRow(row));
  }

  add(input: AddTwinTodoInput, atIso: string = nowIso()): { item: TwinTodoItem; reused: boolean } {
    const title = cleanText(input.title, MAX_TITLE_CHARS);
    if (!title) {
      throw new Error('TODO_TITLE_REQUIRED');
    }
    const taskId = cleanNullable(input.taskId, 120);
    const sessionId = cleanNullable(input.sessionId, 120);
    const projectKey = cleanNullable(input.projectKey, MAX_KEY_CHARS);
    const note = cleanNullable(input.note, MAX_NOTE_CHARS);

    // Deduplicate against an existing open pending todo with the same normalized title.
    const normalizedLower = title.toLowerCase();
    const existingPending = this.list({ metabotId: input.metabotId, includeDone: false, limit: 100 })
      .find((entry) => entry.title.toLowerCase() === normalizedLower);
    if (existingPending) {
      const updated = this.update(
        input.metabotId,
        existingPending.id,
        {
          ...(taskId !== null ? { taskId } : {}),
          ...(sessionId !== null ? { sessionId } : {}),
          ...(projectKey !== null ? { projectKey } : {}),
          ...(note !== null ? { note } : {}),
        },
        atIso,
      );
      return { item: updated ?? existingPending, reused: true };
    }

    const id = this.generateShortId();
    this.db.run(
      `INSERT INTO metabot_todos (
        id, metabot_id, title, status, task_id, session_id, project_key, note,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, NULL)`,
      [id, input.metabotId, title, taskId, sessionId, projectKey, note, atIso, atIso],
    );
    this.saveDb();
    return { item: this.getById(id)!, reused: false };
  }

  update(
    metabotId: number,
    id: string,
    patch: UpdateTwinTodoInput,
    atIso: string = nowIso(),
  ): TwinTodoItem | null {
    const existing = this.getById(id);
    if (!existing || existing.metabotId !== metabotId) return null;

    const nextTitle = patch.title !== undefined
      ? (cleanText(patch.title, MAX_TITLE_CHARS) || existing.title)
      : existing.title;
    const nextStatus: TwinTodoStatus = patch.status === 'done' || patch.status === 'pending'
      ? patch.status
      : existing.status;
    const nextTaskId = patch.taskId !== undefined ? cleanNullable(patch.taskId, 120) : existing.taskId;
    const nextSessionId = patch.sessionId !== undefined ? cleanNullable(patch.sessionId, 120) : existing.sessionId;
    const nextProjectKey = patch.projectKey !== undefined ? cleanNullable(patch.projectKey, MAX_KEY_CHARS) : existing.projectKey;
    const nextNote = patch.note !== undefined ? cleanNullable(patch.note, MAX_NOTE_CHARS) : existing.note;
    const nextCompletedAt = nextStatus === 'done'
      ? (existing.completedAt ?? atIso)
      : null;

    this.db.run(
      `UPDATE metabot_todos
          SET title = ?,
              status = ?,
              task_id = ?,
              session_id = ?,
              project_key = ?,
              note = ?,
              updated_at = ?,
              completed_at = ?
        WHERE id = ? AND metabot_id = ?`,
      [
        nextTitle,
        nextStatus,
        nextTaskId,
        nextSessionId,
        nextProjectKey,
        nextNote,
        atIso,
        nextCompletedAt,
        existing.id,
        metabotId,
      ],
    );
    if (nextStatus === 'done') {
      this.pruneExcessDone(metabotId);
    }
    this.saveDb();
    return this.getById(existing.id);
  }

  completeMany(metabotId: number, ids: string[], note?: string | null, atIso: string = nowIso()): TwinTodoItem[] {
    const completed: TwinTodoItem[] = [];
    const cleanedNote = note !== undefined ? cleanNullable(note, MAX_NOTE_CHARS) : undefined;
    for (const rawId of ids) {
      const updated = this.update(
        metabotId,
        rawId,
        {
          status: 'done',
          ...(cleanedNote !== undefined ? { note: cleanedNote } : {}),
        },
        atIso,
      );
      if (updated) completed.push(updated);
    }
    return completed;
  }

  removeMany(metabotId: number, ids: string[]): number {
    let removed = 0;
    for (const rawId of ids) {
      const existing = this.getById(rawId);
      if (!existing || existing.metabotId !== metabotId) continue;
      this.db.run('DELETE FROM metabot_todos WHERE id = ? AND metabot_id = ?', [existing.id, metabotId]);
      removed += 1;
    }
    if (removed > 0) this.saveDb();
    return removed;
  }

  clearDone(metabotId: number, taskId?: string | null): number {
    const cleanTask = cleanNullable(taskId, 120);
    const rows = cleanTask
      ? this.queryAll("SELECT id FROM metabot_todos WHERE metabot_id = ? AND status = 'done' AND task_id = ?", [metabotId, cleanTask])
      : this.queryAll("SELECT id FROM metabot_todos WHERE metabot_id = ? AND status = 'done'", [metabotId]);
    if (rows.length === 0) return 0;
    if (cleanTask) {
      this.db.run("DELETE FROM metabot_todos WHERE metabot_id = ? AND status = 'done' AND task_id = ?", [metabotId, cleanTask]);
    } else {
      this.db.run("DELETE FROM metabot_todos WHERE metabot_id = ? AND status = 'done'", [metabotId]);
    }
    this.saveDb();
    return rows.length;
  }

  private pruneExcessDone(metabotId: number): void {
    const doneRows = this.queryAll(
      `SELECT id FROM metabot_todos
        WHERE metabot_id = ? AND status = 'done'
        ORDER BY updated_at DESC`,
      [metabotId],
    );
    if (doneRows.length <= MAX_RETAINED_DONE_PER_BOT) return;
    for (const stale of doneRows.slice(MAX_RETAINED_DONE_PER_BOT)) {
      const staleId = String(stale.id ?? '');
      if (staleId) {
        this.db.run('DELETE FROM metabot_todos WHERE id = ? AND metabot_id = ?', [staleId, metabotId]);
      }
    }
  }
}
