import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';
import type {
  LongTermActor,
  LongTermBoard,
  LongTermColumn,
  LongTermEvent,
  LongTermEventKind,
  LongTermEvidence,
  LongTermParticipant,
  LongTermPreferredChannel,
  LongTermProgress,
  LongTermResult,
  LongTermSubtask,
  LongTermSubtaskDraft,
  LongTermSubtaskStatus,
  LongTermSubtaskUpdateInput,
  LongTermTaskCreateInput,
  LongTermTaskDetail,
  LongTermTaskStage,
  LongTermTaskSummary,
  LongTermTaskUpdateInput,
} from '../renderer/types/longTermTask';
import { LONG_TERM_COLUMN_ORDER } from '../renderer/types/longTermTask';

/**
 * Long-term task board — first-class store (redesign, owner-ruled 2026-09-22).
 *
 * A long-term task is a persistent decomposition of a fuzzy goal into ordered
 * sub-projects with acceptance criteria; the TwinBot drives it over days/weeks
 * and the owner decides at blocking points. This store is the single authority:
 *
 *  - Tables are created idempotently in the constructor (same pattern as
 *    OrchestrationStore.ensureTables) — additive, upgrade-safe, no DDL on
 *    existing tables. The ledger (`orchestration_tasks`) is NOT reused: group
 *    tasks / delegations never appear here.
 *  - Facts only on disk: stage, per-subtask status, evidence, journal events.
 *    Column / progress / current-subtask are derived at read time by pure
 *    functions (`deriveColumn` / `deriveProgress` / `deriveCurrentSubtask`).
 *  - Every mutation writes a `long_term_events` row — the journal is the
 *    TwinBot's restart-proof memory of "where this task is and why".
 *  - Acceptance authority: `acceptSubtask` with actor 'twin' is refused unless
 *    the task carries acceptance_delegate = 1. The delegate switch defaults to
 *    ON at creation (owner's call, 2026-10-22) and can be switched off per
 *    task from the detail panel; existing tasks keep their stored value.
 */

type Row = Record<string, unknown>;

const SUBTASK_STATUSES: LongTermSubtaskStatus[] = [
  'pending',
  'in_progress',
  'waiting_owner',
  'waiting_external',
  'accepted',
  'rejected',
  'skipped',
];

/** kv key of the per-task heartbeat nudge throttle map (advance service). */
export const LONGTERM_NUDGE_STATE_KV_KEY = 'longterm_nudge_state';

/** Throttle state for one task's heartbeat escalations. */
export interface LongTermNudgeState {
  lastNudgeAtMs: number;
  /** Event-journal id at the last nudge — anything newer counts as "changed". */
  lastEventId: number;
  /**
   * Newest owner message observed across the task's related sessions (advance
   * service). Owner chat activity is engagement evidence that never becomes a
   * journal event: owner-facing reminders measure quiet from this anchor too,
   * so a reminder cannot fire minutes after an active discussion ended.
   */
  lastOwnerActivityAtMs?: number;
}

/** kv key of the per-task supervision re-arm map (advance service, P1). */
export const LONGTERM_SUPERVISE_STATE_KV_KEY = 'longterm_supervise_state';

/** Supervision re-arm state for one task's supervise escalations. */
export interface LongTermSuperviseState {
  lastSuperviseAtMs: number;
  /**
   * Signature of the failure-streak signal already supervised (a NEW failure
   * changes the signature and fires again). Kept separate from duration
   * turns, which re-arm purely by lastSuperviseAtMs — one shared slot let a
   * duration turn reset the failure dedup and cause spurious paired
   * supervision turns per budget window (review P1-A).
   */
  lastFailureSignal?: string;
  /** Last orchestration attention that completed an advancing action. */
  lastAttentionKey?: string;
  /** Timestamps of recent stale-wait convergence escalations (churn breaker). */
  convergenceAtMs?: number[];
}

const CHANNELS: LongTermPreferredChannel[] = ['delegate_bot', 'group_task', 'owner_external', 'owner_together'];

/**
 * One subtask status transition, emitted to `onSubtaskStatusChange` listeners.
 * The owner-facing surfaces (sidebar badge, board) use it to refresh in real
 * time instead of waiting for the 30s board poll.
 */
export interface LongTermSubtaskStatusChange {
  taskId: string;
  subtaskId: string;
  status: LongTermSubtaskStatus;
  /** null when the subtask was just created (no previous status). */
  previousStatus: LongTermSubtaskStatus | null;
  /** Short machine reason, e.g. 'began' | 'waiting' | 'proposed' | 'accepted'. */
  reason: string;
}

export type LongTermSubtaskStatusListener = (change: LongTermSubtaskStatusChange) => void;

/** Longest owner decision brief kept in `wait_note` on the proposal path. */
const WAIT_NOTE_MAX_CHARS = 4000;

/** Allowed evidence kinds (LongTermEvidence.kind) — anything else bypasses
 *  the per-kind URI shape checks and is refused. */
const EVIDENCE_KINDS = ['dir', 'metaapp', 'pin', 'url', 'other'];

/**
 * waitUntil must be a full ISO timestamp WITH an explicit timezone designator
 * (Z or ±HH:MM). Naive local times parse as local, date-only strings parse as
 * UTC midnight (≈a day off for UTC+8 owners), and unparseable values yield
 * NaN — silently disabling the quiet-window math. Enforced at every entry
 * (twin tool, IPC), not just in prompt guidance.
 */
export const WAIT_UNTIL_STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function nowIso(): string {
  return new Date().toISOString();
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalize an expected-duration input: positive integer minutes or null. */
function asExpectedMinutes(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Pure: the kanban column of a task, from its stage + current sub-task. */
export function deriveColumn(
  stage: LongTermTaskStage,
  currentSubtaskStatus: LongTermSubtaskStatus | null,
): LongTermColumn | null {
  if (stage === 'defining') return 'defining';
  if (stage === 'paused') return 'paused';
  if (stage === 'done') return 'done';
  if (stage === 'cancelled') return null; // cancelled tasks stay in the data, off the board
  if (currentSubtaskStatus === 'waiting_owner') return 'waiting_owner';
  if (currentSubtaskStatus === 'waiting_external') return 'waiting_external';
  return 'in_progress';
}

/** Pure: progress over non-skipped sub-tasks. */
export function deriveProgress(subtasks: LongTermSubtask[]): LongTermProgress {
  const live = subtasks.filter((s) => s.status !== 'skipped');
  const accepted = live.filter((s) => s.status === 'accepted').length;
  const total = live.length;
  return { accepted, total, percent: total === 0 ? 0 : Math.round((accepted / total) * 100) };
}

/**
 * Pure: the sub-task the board/heartbeat should focus on. An explicit pin
 * (tasks.current_subtask_id) wins while it is still open; otherwise the
 * lowest-ordinal open sub-task whose dependencies are all accepted, falling
 * back to the lowest-ordinal open one (dependency-blocked) so the card never
 * shows a blank "current".
 */
export function deriveCurrentSubtask(
  pinnedId: string | null,
  subtasks: LongTermSubtask[],
): LongTermSubtask | null {
  const open = subtasks
    .filter((s) => s.status !== 'accepted' && s.status !== 'skipped')
    .sort((a, b) => a.ordinal - b.ordinal);
  if (open.length === 0) return null;
  if (pinnedId) {
    const pinned = open.find((s) => s.id === pinnedId);
    if (pinned) return pinned;
  }
  const acceptedIds = new Set(subtasks.filter((s) => s.status === 'accepted').map((s) => s.id));
  return open.find((s) => s.dependsOn.every((dep) => acceptedIds.has(dep))) ?? open[0];
}

interface TaskRow {
  id: string;
  title: string;
  goal: string;
  stage: LongTermTaskStage;
  acceptance_delegate: number;
  current_subtask_id: string | null;
  definition_session_id: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

interface SubtaskRow {
  id: string;
  task_id: string;
  ordinal: number;
  title: string;
  description: string;
  acceptance_criteria_json: string;
  status: LongTermSubtaskStatus;
  depends_on_json: string;
  preferred_channel: string | null;
  evidence_json: string;
  session_id: string | null;
  session_history_json: string;
  wait_note: string;
  wait_until: string | null;
  notes: string;
  expected_minutes: number | null;
  metatask_root: string | null;
  accepted_by: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
}

interface EventRow {
  id: number;
  task_id: string;
  subtask_id: string | null;
  kind: LongTermEventKind;
  actor: LongTermActor;
  detail: string;
  created_at: string;
}

export class LongTermTaskStore {
  private readonly db: Database;
  private readonly saveDb: () => void;
  /** Resolves metabot ids to display rows (name + avatar) for participant chips. */
  private readonly resolveParticipants: (ids: number[]) => LongTermParticipant[];
  /** Status-transition subscribers (main wires the push broadcast here). */
  private readonly statusListeners = new Set<LongTermSubtaskStatusListener>();

  constructor(db: Database, saveDb: () => void, options?: { resolveParticipants?: (ids: number[]) => LongTermParticipant[] }) {
    this.db = db;
    this.saveDb = saveDb;
    this.resolveParticipants = options?.resolveParticipants ?? ((ids) => ids.map((id) => ({ id, name: `#${id}`, avatar: null })));
    this.ensureTables();
  }

  /**
   * Subscribe to subtask status transitions; returns the unsubscribe function.
   * Twin-side mutations (agent tools, heartbeat) go through this store with no
   * IPC reply, so listeners are the only way the renderer learns of a new
   * `waiting_owner` without waiting out the board poll.
   */
  onSubtaskStatusChange(listener: LongTermSubtaskStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Fire the transition listeners. Transitions that leave the status untouched
   * (re-recording a note on an already-waiting sub-project, rebinding a
   * session) stay silent — a push per keystroke would be noise, not news.
   * A throwing listener never breaks the mutation it was notified about.
   */
  private emitStatusChange(
    previous: LongTermSubtask | null,
    updated: LongTermSubtask | null,
    reason: string,
  ): void {
    if (!updated) return;
    const previousStatus = previous?.status ?? null;
    if (previousStatus === updated.status) return;
    const change: LongTermSubtaskStatusChange = {
      taskId: updated.taskId,
      subtaskId: updated.id,
      status: updated.status,
      previousStatus,
      reason,
    };
    for (const listener of [...this.statusListeners]) {
      try {
        listener(change);
      } catch {
        // A subscriber must never break the store mutation it rides on.
      }
    }
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS long_term_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'defining'
          CHECK(stage IN ('defining','active','paused','done','cancelled')),
        acceptance_delegate INTEGER NOT NULL DEFAULT 1,
        current_subtask_id TEXT,
        definition_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        done_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_long_term_tasks_stage
        ON long_term_tasks(stage, updated_at DESC);
      CREATE TABLE IF NOT EXISTS long_term_subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','in_progress','waiting_owner','waiting_external','accepted','rejected','skipped')),
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        preferred_channel TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        session_id TEXT,
        session_history_json TEXT NOT NULL DEFAULT '[]',
        wait_note TEXT NOT NULL DEFAULT '',
        wait_until TEXT,
        notes TEXT NOT NULL DEFAULT '',
        expected_minutes INTEGER,
        accepted_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        UNIQUE(task_id, ordinal),
        FOREIGN KEY(task_id) REFERENCES long_term_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_long_term_subtasks_task
        ON long_term_subtasks(task_id, ordinal);
      CREATE TABLE IF NOT EXISTS long_term_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        subtask_id TEXT,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_long_term_events_task
        ON long_term_events(task_id, id DESC);
    `);
    // P1: additive columns — CREATE TABLE IF NOT EXISTS cannot extend an
    // existing table, so databases created before these columns get them via
    // guarded ALTERs (idempotent first-run migration, rows intact).
    const subtaskColumns = this.getAll<{ name: unknown }>('PRAGMA table_info(long_term_subtasks)').map((row) => String(row.name));
    if (!subtaskColumns.includes('expected_minutes')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN expected_minutes INTEGER');
    }
    if (!subtaskColumns.includes('session_history_json')) {
      this.db.run("ALTER TABLE long_term_subtasks ADD COLUMN session_history_json TEXT NOT NULL DEFAULT '[]'");
    }
    // P2 MetaTask interop: structured link from a sub-project to its on-chain
    // MetaTask execution channel (referenced, not mixed in).
    if (!subtaskColumns.includes('metatask_root')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN metatask_root TEXT');
    }
    this.saveDb();
  }

  // ── row mapping ──────────────────────────────────────────────────────────

  private getOne<T extends object>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values?.[0]) return null;
    const row: Row = {};
    result[0].columns.forEach((column, index) => {
      row[column] = result[0].values[0][index];
    });
    return row as T;
  }

  private getAll<T extends object>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    return (result[0]?.values ?? []).map((values) => {
      const row: Row = {};
      result[0].columns.forEach((column, index) => {
        row[column] = values[index];
      });
      return row as T;
    });
  }

  private mapTask(row: TaskRow) {
    return {
      id: row.id,
      title: row.title,
      goal: row.goal,
      stage: row.stage,
      acceptanceDelegate: row.acceptance_delegate === 1,
      currentSubtaskIdPinned: row.current_subtask_id ?? null,
      definitionSessionId: row.definition_session_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at ?? null,
    };
  }

  private mapSubtask(row: SubtaskRow): LongTermSubtask {
    return {
      id: row.id,
      taskId: row.task_id,
      ordinal: row.ordinal,
      title: row.title,
      description: row.description ?? '',
      acceptanceCriteria: parseJsonArray<string>(row.acceptance_criteria_json),
      status: row.status,
      dependsOn: parseJsonArray<string>(row.depends_on_json),
      preferredChannel: CHANNELS.includes(row.preferred_channel as LongTermPreferredChannel)
        ? (row.preferred_channel as LongTermPreferredChannel)
        : null,
      evidence: parseJsonArray<LongTermEvidence>(row.evidence_json),
      sessionId: row.session_id ?? null,
      // Read-time union: a session bound before the column existed still
      // shows up, so supervision telemetry never misses the pre-upgrade session.
      sessionHistory: (() => {
        const history = parseJsonArray<string>(row.session_history_json);
        const currentSession = row.session_id ?? null;
        return currentSession && !history.includes(currentSession) ? [...history, currentSession] : history;
      })(),
      waitNote: row.wait_note ?? '',
      waitUntil: row.wait_until ?? null,
      notes: row.notes ?? '',
      expectedMinutes: row.expected_minutes ?? null,
      metataskRoot: row.metatask_root ?? null,
      acceptedBy: row.accepted_by === 'owner' || row.accepted_by === 'twin' ? row.accepted_by : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acceptedAt: row.accepted_at ?? null,
    };
  }

  private mapEvent(row: EventRow): LongTermEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      subtaskId: row.subtask_id ?? null,
      kind: row.kind,
      actor: row.actor,
      detail: row.detail ?? '',
      createdAt: row.created_at,
    };
  }

  private getTaskRow(taskId: string): TaskRow | null {
    return this.getOne<TaskRow>('SELECT * FROM long_term_tasks WHERE id = ?', [taskId]);
  }

  private listSubtaskRows(taskId: string): SubtaskRow[] {
    return this.getAll<SubtaskRow>('SELECT * FROM long_term_subtasks WHERE task_id = ? ORDER BY ordinal ASC', [taskId]);
  }

  private addEvent(taskId: string, subtaskId: string | null, kind: LongTermEventKind, actor: LongTermActor, detail: string): void {
    this.db.run('INSERT INTO long_term_events (task_id, subtask_id, kind, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      taskId,
      subtaskId,
      kind,
      actor,
      detail.slice(0, 2000),
      nowIso(),
    ]);
  }

  private touch(taskId: string): void {
    this.db.run('UPDATE long_term_tasks SET updated_at = ? WHERE id = ?', [nowIso(), taskId]);
  }

  // ── derivation ───────────────────────────────────────────────────────────

  private toSummary(taskRow: TaskRow, subtasks: LongTermSubtask[]): LongTermTaskSummary {
    const task = this.mapTask(taskRow);
    const current = deriveCurrentSubtask(task.currentSubtaskIdPinned, subtasks);
    const column = deriveColumn(task.stage, current?.status ?? null);
    const counts = Object.fromEntries(SUBTASK_STATUSES.map((s) => [s, 0])) as Record<LongTermSubtaskStatus, number>;
    for (const subtask of subtasks) counts[subtask.status] += 1;
    return {
      id: task.id,
      title: task.title,
      goal: task.goal,
      stage: task.stage,
      column: column ?? 'done',
      acceptanceDelegate: task.acceptanceDelegate,
      currentSubtaskId: current?.id ?? null,
      currentSubtaskTitle: current?.title ?? null,
      currentSubtaskStatus: current?.status ?? null,
      currentWaitNote: current && current.waitNote ? current.waitNote : null,
      currentExpectedMinutes: current?.expectedMinutes ?? null,
      progress: deriveProgress(subtasks),
      counts,
      // Sessions currently owed an owner verdict (every waiting_owner
      // sub-project's bound session). The sidebar lifts these OUT of the
      // collapsed autonomous fold: a decision the owner must make belongs on
      // the main timeline, derived live — folds back automatically the moment
      // the verdict lands.
      decisionSessionIds: subtasks
        .filter((sub) => sub.status === 'waiting_owner' && sub.sessionId)
        .map((sub) => sub.sessionId as string),
      participants: this.resolveParticipants(this.listParticipantIds(taskRow, subtasks)),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      doneAt: task.doneAt,
    };
  }

  /**
   * Participating bots, derived read-time from the task's sessions: the bot
   * that ran each bound session (the Twin on longterm/definition sessions) ∪
   * workers delegated from those sessions (orchestration assignees) ∪ members
   * of group tasks sourced from them.
   */
  private listParticipantIds(taskRow: TaskRow, subtasks: LongTermSubtask[]): number[] {
    const sessionIds = [taskRow.definition_session_id, ...subtasks.map((sub) => sub.sessionId)]
      .filter((id): id is string => Boolean(id));
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(',');
    const ids = new Set<number>();
    const collect = (sql: string) => {
      for (const row of this.getAll<{ id: unknown }>(sql, sessionIds)) {
        const id = Number(row.id);
        if (Number.isFinite(id)) ids.add(id);
      }
    };
    collect(`SELECT DISTINCT metabot_id AS id FROM cowork_sessions WHERE id IN (${placeholders}) AND metabot_id IS NOT NULL`);
    collect(`SELECT DISTINCT s.assignee_metabot_id AS id FROM orchestration_steps s
             JOIN orchestration_tasks t ON t.id = s.task_id
             WHERE t.source_session_id IN (${placeholders}) AND s.assignee_metabot_id IS NOT NULL`);
    collect(`SELECT DISTINCT m.metabot_id AS id FROM group_task_members m
             JOIN group_tasks g ON g.id = m.task_id
             WHERE g.source_session_id IN (${placeholders}) AND m.metabot_id IS NOT NULL`);
    return [...ids].sort((a, b) => a - b);
  }

  // ── task lifecycle ───────────────────────────────────────────────────────

  /**
   * Create a task in `defining` (draft) with its sub-projects. Nothing is
   * pushed forward until `activateTask` — creation is the grilling skill's
   * output, activation is the owner's sign-off.
   */
  createTask(input: LongTermTaskCreateInput, actor: LongTermActor): LongTermResult<LongTermTaskDetail> {
    const title = asText(input.title).trim();
    const goal = asText(input.goal).trim();
    if (!title || !goal) return { ok: false, code: 'VALIDATION', error: 'title and goal are required' };
    const drafts = input.subtasks ?? [];
    if (drafts.length === 0) return { ok: false, code: 'VALIDATION', error: 'at least one sub-project is required' };
    const taskId = `ltt_${uuidv4()}`;
    const now = nowIso();
    const subtaskIds = drafts.map(() => `lts_${uuidv4()}`);
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      if (!asText(draft.title).trim()) {
        return { ok: false, code: 'VALIDATION', error: `sub-project #${index + 1} has no title` };
      }
      for (const ordinal of draft.dependsOnOrdinals ?? []) {
        if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > drafts.length || ordinal === index + 1) {
          return { ok: false, code: 'VALIDATION', error: `sub-project #${index + 1} has an invalid dependsOn ordinal ${ordinal}` };
        }
      }
      void subtaskIds;
    }
    this.db.run(
      `INSERT INTO long_term_tasks (id, title, goal, stage, acceptance_delegate, definition_session_id, created_at, updated_at)
       VALUES (?, ?, ?, 'defining', 1, ?, ?, ?)`,
      [taskId, title, goal, input.definitionSessionId ?? null, now, now],
    );
    drafts.forEach((draft, index) => {
      const dependsOn = (draft.dependsOnOrdinals ?? []).map((ordinal) => subtaskIds[ordinal - 1]);
      this.db.run(
        `INSERT INTO long_term_subtasks
         (id, task_id, ordinal, title, description, acceptance_criteria_json, status, depends_on_json, preferred_channel, notes, expected_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        [
          subtaskIds[index],
          taskId,
          index + 1,
          asText(draft.title).trim(),
          asText(draft.description ?? ''),
          JSON.stringify(draft.acceptanceCriteria ?? []),
          JSON.stringify(dependsOn),
          draft.preferredChannel && CHANNELS.includes(draft.preferredChannel) ? draft.preferredChannel : null,
          asText(draft.notes ?? ''),
          asExpectedMinutes(draft.expectedMinutes),
          now,
          now,
        ],
      );
    });
    this.addEvent(taskId, null, 'created', actor, `created as draft with ${drafts.length} sub-project(s): ${title}`);
    this.saveDb();
    const detail = this.getTask(taskId);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'creation failed' };
  }

  /** Owner confirmed the plan in chat → the task goes active. */
  activateTask(taskId: string, actor: LongTermActor): LongTermResult<LongTermTaskDetail> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (row.stage !== 'defining' && row.stage !== 'paused') {
      return { ok: false, code: 'VALIDATION', error: `cannot activate from stage ${row.stage}` };
    }
    this.db.run("UPDATE long_term_tasks SET stage = 'active', updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    this.addEvent(taskId, null, row.stage === 'paused' ? 'resumed' : 'created', actor,
      row.stage === 'paused' ? 'resumed' : 'plan confirmed, task activated');
    this.saveDb();
    const detail = this.getTask(taskId);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }

  pauseTask(taskId: string, actor: LongTermActor, note = ''): LongTermResult<LongTermTaskDetail> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (row.stage !== 'active') return { ok: false, code: 'VALIDATION', error: `cannot pause from stage ${row.stage}` };
    this.db.run("UPDATE long_term_tasks SET stage = 'paused', updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    this.addEvent(taskId, null, 'paused', actor, note || 'paused');
    this.saveDb();
    const detail = this.getTask(taskId);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }

  cancelTask(taskId: string, actor: LongTermActor, note = ''): LongTermResult<null> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (row.stage === 'done' || row.stage === 'cancelled') {
      return { ok: false, code: 'VALIDATION', error: `already ${row.stage}` };
    }
    this.db.run("UPDATE long_term_tasks SET stage = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    this.addEvent(taskId, null, 'note', actor, `cancelled${note ? `: ${note}` : ''}`);
    this.saveDb();
    return { ok: true, value: null };
  }

  /**
   * Close the whole task as done at the GOAL level ("the outcome is already
   * met, stop driving the plan"). Every remaining open sub-project is skipped
   * — not accepted, closing is not a verdict on work never proposed — the
   * focus pin clears, and the task lands in 'done' with one goal-level
   * 'completed' journal event. This is the one-click exit for the "work
   * finished inside one session while the board still shows N open
   * sub-projects" situation; it is NOT for abandoning a task (use cancel).
   *
   * Actor 'twin' requires the task's acceptance_delegate switch — declaring
   * the goal met carries the same authority as accepting a sub-project, and
   * the optional evidence is validated with the same URI shape rules.
   */
  completeTask(
    taskId: string,
    actor: LongTermActor,
    input: { note?: string; evidence?: LongTermEvidence[] } = {},
  ): LongTermResult<LongTermTaskDetail> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (row.stage !== 'active' && row.stage !== 'paused') {
      return { ok: false, code: 'VALIDATION', error: `cannot complete from stage ${row.stage}` };
    }
    if (actor === 'twin' && row.acceptance_delegate !== 1) {
      return { ok: false, code: 'FORBIDDEN', error: 'task completion is owner-only for this task (delegate switch is off)' };
    }
    const evidence = (input.evidence ?? []).filter((entry) => entry && asText(entry.uri).trim());
    if (evidence.length > 0) {
      const evidenceError = this.validateEvidenceInput(evidence);
      if (evidenceError) return { ok: false, code: 'VALIDATION', error: evidenceError };
    }
    const now = nowIso();
    const open = this.listSubtaskRows(taskId)
      .map((sub) => this.mapSubtask(sub))
      .filter((sub) => sub.status !== 'accepted' && sub.status !== 'skipped');
    for (const sub of open) {
      this.db.run(
        "UPDATE long_term_subtasks SET status = 'skipped', wait_note = '', wait_until = NULL, updated_at = ? WHERE id = ?",
        [now, sub.id],
      );
      this.addEvent(taskId, sub.id, 'skipped', actor, `closed with task completion (was ${sub.status})`);
      this.emitStatusChange(sub, this.getSubtask(sub.id), 'skipped');
    }
    this.db.run(
      "UPDATE long_term_tasks SET stage = 'done', done_at = ?, current_subtask_id = NULL, updated_at = ? WHERE id = ?",
      [now, now, taskId],
    );
    const evidenceLines = evidence
      .map((entry) => `${asText(entry.kind).trim()}: ${asText(entry.uri).trim()}${entry.note ? ` (${asText(entry.note)})` : ''}`)
      .join(' | ');
    const note = asText(input.note).trim();
    const detail = [
      `goal closed at task level by ${actor}; ${open.length} open sub-project(s) skipped`,
      note,
      evidenceLines,
    ]
      .filter(Boolean)
      .join(' — ');
    this.addEvent(taskId, null, 'completed', actor, detail);
    this.saveDb();
    const detailTask = this.getTask(taskId);
    return detailTask ? { ok: true, value: detailTask } : { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }

  updateTask(input: LongTermTaskUpdateInput, actor: LongTermActor): LongTermResult<LongTermTaskDetail> {
    const row = this.getTaskRow(input.taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    const changes: string[] = [];
    if (typeof input.title === 'string' && input.title.trim() && input.title.trim() !== row.title) {
      this.db.run('UPDATE long_term_tasks SET title = ? WHERE id = ?', [input.title.trim(), row.id]);
      changes.push('title');
    }
    if (typeof input.goal === 'string' && input.goal.trim() && input.goal.trim() !== row.goal) {
      this.db.run('UPDATE long_term_tasks SET goal = ? WHERE id = ?', [input.goal.trim(), row.id]);
      changes.push('goal');
    }
    if (typeof input.acceptanceDelegate === 'boolean') {
      const next = input.acceptanceDelegate ? 1 : 0;
      if (next !== row.acceptance_delegate) {
        this.db.run('UPDATE long_term_tasks SET acceptance_delegate = ? WHERE id = ?', [next, row.id]);
        changes.push(`acceptance_delegate=${next === 1 ? 'on' : 'off'}`);
      }
    }
    if (changes.length === 0) return { ok: false, code: 'VALIDATION', error: 'nothing to update' };
    this.touch(row.id);
    this.addEvent(row.id, null, 'replanned', actor, `updated: ${changes.join(', ')}`);
    this.saveDb();
    const detail = this.getTask(row.id);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }

  // ── reads ────────────────────────────────────────────────────────────────

  getTask(taskId: string): LongTermTaskDetail | null {
    const row = this.getTaskRow(taskId);
    if (!row) return null;
    const subtasks = this.listSubtaskRows(taskId).map((sub) => this.mapSubtask(sub));
    const summary = this.toSummary(row, subtasks);
    const events = this.getAll<EventRow>(
      'SELECT * FROM long_term_events WHERE task_id = ? ORDER BY id DESC LIMIT 200',
      [taskId],
    ).map((event) => this.mapEvent(event));
    return { ...summary, subtasks, events, definitionSessionId: row.definition_session_id ?? null };
  }

  listBoard(): LongTermBoard {
    const taskRows = this.getAll<TaskRow>("SELECT * FROM long_term_tasks WHERE stage != 'cancelled'");
    const cards: LongTermTaskSummary[] = [];
    for (const row of taskRows) {
      const subtasks = this.listSubtaskRows(row.id).map((sub) => this.mapSubtask(sub));
      cards.push(this.toSummary(row, subtasks));
    }
    const columns = LONG_TERM_COLUMN_ORDER.map((column) => ({
      column,
      cardIds: cards
        .filter((card) => card.column === column)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((card) => card.id),
    }));
    return { generatedAtMs: Date.now(), columns, cards };
  }

  listEvents(taskId: string, limit = 200): LongTermEvent[] {
    return this.getAll<EventRow>('SELECT * FROM long_term_events WHERE task_id = ? ORDER BY id DESC LIMIT ?', [
      taskId,
      Math.max(1, Math.min(500, Math.trunc(limit))),
    ]).map((row) => this.mapEvent(row));
  }

  /**
   * Newest event of the given kinds for one sub-project (null when none).
   * Direct query — immune to the capped 200-event detail projection that
   * heartbeat state detection must not depend on.
   */
  getLatestSubtaskEventOfKinds(taskId: string, subtaskId: string, kinds: LongTermEventKind[]): LongTermEvent | null {
    if (kinds.length === 0) return null;
    const placeholders = kinds.map(() => '?').join(',');
    const row = this.getOne<EventRow>(
      `SELECT * FROM long_term_events WHERE task_id = ? AND subtask_id = ? AND kind IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
      [taskId, subtaskId, ...kinds],
    );
    return row ? this.mapEvent(row) : null;
  }

  /**
   * True when the sub-project has REAL work after the given event id: any
   * newer event except heartbeat infrastructure — 'nudged'/'supervised'
   * escalations and system notes (session binds). A system bookkeeping note
   * is not "the Twin worked past the wait"; a twin note, replan, or owner
   * action is.
   */
  hasTwinWorkAfter(taskId: string, subtaskId: string, afterEventId: number): boolean {
    const row = this.getOne<{ one: number }>(
      `SELECT 1 AS one FROM long_term_events
       WHERE task_id = ? AND subtask_id = ? AND id > ?
         AND NOT (kind IN ('nudged','supervised') OR (kind = 'note' AND actor = 'system'))
       LIMIT 1`,
      [taskId, subtaskId, afterEventId],
    );
    return row != null;
  }

  // ── sub-task mutations ───────────────────────────────────────────────────

  addSubtask(taskId: string, draft: LongTermSubtaskDraft, actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    const title = asText(draft.title).trim();
    if (!title) return { ok: false, code: 'VALIDATION', error: 'title is required' };
    const existing = this.listSubtaskRows(taskId);
    const ordinal = existing.reduce((max, sub) => Math.max(max, sub.ordinal), 0) + 1;
    const dependsOn = (draft.dependsOnOrdinals ?? []).map((ordinalRef) => existing.find((sub) => sub.ordinal === ordinalRef)?.id ?? '');
    if (dependsOn.some((id) => !id)) {
      return { ok: false, code: 'VALIDATION', error: 'dependsOnOrdinals must reference existing sub-projects' };
    }
    const id = `lts_${uuidv4()}`;
    const now = nowIso();
    this.db.run(
      `INSERT INTO long_term_subtasks
       (id, task_id, ordinal, title, description, acceptance_criteria_json, status, depends_on_json, preferred_channel, notes, expected_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        taskId,
        ordinal,
        title,
        asText(draft.description ?? ''),
        JSON.stringify(draft.acceptanceCriteria ?? []),
        JSON.stringify(dependsOn),
        draft.preferredChannel && CHANNELS.includes(draft.preferredChannel) ? draft.preferredChannel : null,
        asText(draft.notes ?? ''),
        asExpectedMinutes(draft.expectedMinutes),
        now,
        now,
      ],
    );
    this.touch(taskId);
    this.addEvent(taskId, id, 'replanned', actor, `sub-project added (#${ordinal}): ${title}`);
    this.saveDb();
    const created = this.getSubtask(id);
    this.emitStatusChange(null, created, 'created');
    return created ? { ok: true, value: created } : { ok: false, code: 'NOT_FOUND', error: 'creation failed' };
  }

  getSubtask(subtaskId: string): LongTermSubtask | null {
    const row = this.getOne<SubtaskRow>('SELECT * FROM long_term_subtasks WHERE id = ?', [subtaskId]);
    return row ? this.mapSubtask(row) : null;
  }

  /** Owner/Twin may redefine any open sub-project at any time (requirements drift). */
  updateSubtask(input: LongTermSubtaskUpdateInput, actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(input.subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status === 'accepted' || current.status === 'skipped') {
      return { ok: false, code: 'VALIDATION', error: `cannot edit a ${current.status} sub-project` };
    }
    const changes: string[] = [];
    const set = (column: string, value: unknown, label: string) => {
      this.db.run(`UPDATE long_term_subtasks SET ${column} = ? WHERE id = ?`, [value, current.id]);
      changes.push(label);
    };
    if (typeof input.title === 'string' && input.title.trim() && input.title.trim() !== current.title) {
      set('title', input.title.trim(), 'title');
    }
    if (typeof input.description === 'string' && input.description !== current.description) {
      set('description', input.description, 'description');
    }
    if (Array.isArray(input.acceptanceCriteria)) {
      set('acceptance_criteria_json', JSON.stringify(input.acceptanceCriteria), 'acceptance criteria');
    }
    if (typeof input.notes === 'string' && input.notes !== current.notes) set('notes', input.notes, 'notes');
    if (input.expectedMinutes !== undefined) {
      const next = asExpectedMinutes(input.expectedMinutes);
      if ((next !== null || input.expectedMinutes === null) && next !== current.expectedMinutes) {
        set('expected_minutes', next, 'expected duration');
      }
    }
    if (input.preferredChannel === null || CHANNELS.includes(input.preferredChannel as LongTermPreferredChannel)) {
      if (input.preferredChannel !== undefined && input.preferredChannel !== current.preferredChannel) {
        set('preferred_channel', input.preferredChannel, 'preferred channel');
      }
    }
    if (input.metataskRoot !== undefined && input.metataskRoot !== current.metataskRoot) {
      const nextRoot = input.metataskRoot === null ? null : String(input.metataskRoot).trim();
      if (nextRoot !== null && !/^[0-9a-f]{64}i0$/.test(nextRoot)) {
        return { ok: false, code: 'VALIDATION', error: 'metataskRoot must be a full 66-char pinId (64 hex + i0) or null' };
      }
      set('metatask_root', nextRoot, 'metatask link');
    }
    if (typeof input.ordinal === 'number' && Number.isInteger(input.ordinal) && input.ordinal > 0 && input.ordinal !== current.ordinal) {
      const occupied = this.getOne<SubtaskRow>('SELECT * FROM long_term_subtasks WHERE task_id = ? AND ordinal = ? AND id != ?', [
        current.taskId,
        input.ordinal,
        current.id,
      ]);
      if (occupied) return { ok: false, code: 'VALIDATION', error: `ordinal ${input.ordinal} is taken by another sub-project` };
      // An ordinal edit is a manual reorder — dependency-linked rows are
      // reordered by redefining dependencies, never by hand.
      if (this.dependencyLinkedIds(current.taskId).has(current.id)) {
        return { ok: false, code: 'VALIDATION', error: 'dependency-linked sub-projects cannot be reordered manually — redefine the dependencies instead' };
      }
      set('ordinal', input.ordinal, 'order');
    }
    if (Array.isArray(input.dependsOn)) {
      const siblings = new Set(this.listSubtaskRows(current.taskId).map((sub) => sub.id));
      for (const dep of input.dependsOn) {
        if (!siblings.has(dep)) return { ok: false, code: 'VALIDATION', error: `dependency ${dep} is not a sibling sub-project` };
        if (dep === current.id) return { ok: false, code: 'VALIDATION', error: 'a sub-project cannot depend on itself' };
      }
      const next = { ...current, dependsOn: input.dependsOn };
      if (this.hasDependencyCycle(next)) {
        return { ok: false, code: 'VALIDATION', error: 'dependency cycle detected' };
      }
      set('depends_on_json', JSON.stringify(input.dependsOn), 'dependencies');
    }
    if (changes.length === 0) return { ok: false, code: 'VALIDATION', error: 'nothing to update' };
    this.db.run('UPDATE long_term_subtasks SET updated_at = ? WHERE id = ?', [nowIso(), current.id]);
    this.touch(current.taskId);
    this.addEvent(current.taskId, current.id, 'replanned', actor, `redefined: ${changes.join(', ')}`);
    this.saveDb();
    const updated = this.getSubtask(current.id);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  private hasDependencyCycle(start: LongTermSubtask): boolean {
    const byId = new Map(
      this.listSubtaskRows(start.taskId).map((row) => {
        const sub = this.mapSubtask(row);
        return [sub.id, sub.id === start.id ? start : sub] as const;
      }),
    );
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): boolean => {
      if (done.has(id)) return false;
      if (visiting.has(id)) return true;
      visiting.add(id);
      const node = byId.get(id);
      for (const dep of node?.dependsOn ?? []) {
        if (visit(dep)) return true;
      }
      visiting.delete(id);
      done.add(id);
      return false;
    };
    return visit(start.id);
  }

  /** Start pushing a sub-project. Refused while its dependencies are unmet. */
  beginSubtask(subtaskId: string, actor: LongTermActor, channel?: LongTermPreferredChannel | null): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'pending' && current.status !== 'in_progress') {
      return { ok: false, code: 'VALIDATION', error: `cannot begin from status ${current.status}` };
    }
    const siblings = this.listSubtaskRows(current.taskId).map((row) => this.mapSubtask(row));
    const unmet = current.dependsOn.filter((dep) => siblings.find((sub) => sub.id === dep)?.status !== 'accepted');
    if (unmet.length > 0) {
      const titles = unmet.map((dep) => siblings.find((sub) => sub.id === dep)?.title ?? dep);
      return { ok: false, code: 'VALIDATION', error: `dependencies not yet accepted: ${titles.join('; ')}` };
    }
    const task = this.getTaskRow(current.taskId);
    if (task?.stage === 'defining') {
      return { ok: false, code: 'VALIDATION', error: 'activate the task first (owner confirms the plan)' };
    }
    if (task?.stage === 'paused' || task?.stage === 'done' || task?.stage === 'cancelled') {
      return { ok: false, code: 'VALIDATION', error: `task is ${task.stage}` };
    }
    const channelClause = channel && CHANNELS.includes(channel) ? channel : current.preferredChannel;
    this.db.run(
      "UPDATE long_term_subtasks SET status = 'in_progress', preferred_channel = ?, wait_note = '', wait_until = NULL, updated_at = ? WHERE id = ?",
      [channelClause, nowIso(), subtaskId],
    );
    // Pin the board focus onto the sub-project being pushed.
    this.db.run('UPDATE long_term_tasks SET current_subtask_id = ?, updated_at = ? WHERE id = ?', [subtaskId, nowIso(), current.taskId]);
    this.addEvent(current.taskId, subtaskId, 'began', actor, `began (channel: ${channelClause ?? 'undecided'})`);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, 'began');
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Park the current sub-project on a blocking point (owner decision / external condition). */
  waitSubtask(
    subtaskId: string,
    input: { kind: 'owner' | 'external'; note: string; waitUntil?: string | null },
    actor: LongTermActor,
  ): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'in_progress' && current.status !== 'waiting_owner' && current.status !== 'waiting_external') {
      return { ok: false, code: 'VALIDATION', error: `cannot wait from status ${current.status}` };
    }
    if (input.waitUntil != null) {
      const waitUntilText = asText(input.waitUntil).trim();
      if (!WAIT_UNTIL_STRICT_ISO.test(waitUntilText) || !Number.isFinite(Date.parse(waitUntilText))) {
        return {
          ok: false,
          code: 'VALIDATION',
          error: 'waitUntil must be a full ISO timestamp WITH timezone offset (Z or ±HH:MM), converted to the owner\'s local timezone — bare local times, date-only strings, and unparseable values are rejected',
        };
      }
    }
    const status: LongTermSubtaskStatus = input.kind === 'owner' ? 'waiting_owner' : 'waiting_external';
    this.db.run('UPDATE long_term_subtasks SET status = ?, wait_note = ?, wait_until = ?, updated_at = ? WHERE id = ?', [
      status,
      asText(input.note),
      input.waitUntil ?? null,
      nowIso(),
      subtaskId,
    ]);
    this.addEvent(current.taskId, subtaskId, 'waiting', actor, `${input.kind}: ${asText(input.note)}`);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, input.kind === 'owner' ? 'waiting_owner' : 'waiting_external');
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /**
   * Validate evidence entries (kind gate + per-kind URI shape); null = valid.
   * Shared by every evidence-bearing path (proposal, task-level completion) —
   * the acceptance chain is only as good as its evidence, and a criterion
   * "proven" by a malformed URI was never proven.
   */
  private validateEvidenceInput(evidence: LongTermEvidence[]): string | null {
    if (evidence.length === 0) return 'at least one evidence URI is required';
    const unknownKind = evidence.find((entry) => !EVIDENCE_KINDS.includes(asText(entry.kind).trim()));
    if (unknownKind) {
      return `unknown evidence kind "${asText(unknownKind.kind)}" — allowed: ${EVIDENCE_KINDS.join(' | ')}`;
    }
    const malformed = evidence.filter((entry) => {
      const uri = asText(entry.uri).trim();
      const kind = asText(entry.kind).trim();
      if (kind === 'pin') return !uri.startsWith('pin://');
      if (kind === 'metaapp') return !uri.startsWith('metaapp://');
      if (kind === 'metafile') return !uri.startsWith('metafile://');
      if (kind === 'url') return !/^https?:\/\//.test(uri);
      if (kind === 'dir') return !uri.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(uri);
      return false;
    });
    if (malformed.length > 0) {
      return `malformed evidence URI(s): ${malformed.map((entry) => `${asText(entry.kind) || 'untyped'} ${asText(entry.uri).slice(0, 80)}`).join('; ')}`;
    }
    return null;
  }

  /** Twin presents evidence against the acceptance criteria and asks the owner to accept. */
  proposeSubtask(subtaskId: string, input: { evidence: LongTermEvidence[]; summary: string }, actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'in_progress' && current.status !== 'waiting_external') {
      return { ok: false, code: 'VALIDATION', error: `cannot propose acceptance from status ${current.status}` };
    }
    const evidence = (input.evidence ?? []).filter((entry) => entry && asText(entry.uri).trim());
    const evidenceError = this.validateEvidenceInput(evidence);
    if (evidenceError) return { ok: false, code: 'VALIDATION', error: evidenceError };
    this.db.run(
      "UPDATE long_term_subtasks SET status = 'waiting_owner', evidence_json = ?, wait_note = ?, wait_until = NULL, updated_at = ? WHERE id = ?",
      [
        JSON.stringify(evidence),
        // The proposal note IS the owner's decision brief: keep it whole (an
        // acceptance proposal carries the same background/options/recommendation
        // structure), trimming only against a pathological payload.
        `acceptance proposed: ${asText(input.summary).slice(0, WAIT_NOTE_MAX_CHARS)}`,
        nowIso(),
        subtaskId,
      ],
    );
    this.addEvent(current.taskId, subtaskId, 'proposed', actor, asText(input.summary).slice(0, 1000));
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, 'proposed');
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /**
   * Accept a sub-project. Actor 'twin' requires the task's acceptance_delegate
   * flag (owner granted it once, explicitly); otherwise owner-only. When every
   * live sub-project is accepted the task itself completes.
   */
  acceptSubtask(subtaskId: string, actor: LongTermActor, note = ''): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    const task = this.getTaskRow(current.taskId);
    if (!task) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (actor === 'twin' && task.acceptance_delegate !== 1) {
      return { ok: false, code: 'FORBIDDEN', error: 'acceptance is owner-only for this task (delegate switch is off)' };
    }
    if (current.status !== 'waiting_owner' && current.status !== 'in_progress') {
      return { ok: false, code: 'VALIDATION', error: `cannot accept from status ${current.status}` };
    }
    const now = nowIso();
    this.db.run(
      "UPDATE long_term_subtasks SET status = 'accepted', accepted_by = ?, accepted_at = ?, wait_note = '', wait_until = NULL, updated_at = ? WHERE id = ?",
      [actor, now, now, subtaskId],
    );
    // Clear the focus pin when it pointed here so derivation moves on.
    if (task.current_subtask_id === subtaskId) {
      this.db.run('UPDATE long_term_tasks SET current_subtask_id = NULL WHERE id = ?', [task.id]);
    }
    this.addEvent(task.id, subtaskId, 'accepted', actor, note || `accepted by ${actor}`);
    const remaining = this.listSubtaskRows(task.id)
      .map((row) => this.mapSubtask(row))
      .filter((sub) => sub.status !== 'accepted' && sub.status !== 'skipped');
    if (remaining.length === 0 && task.stage === 'active') {
      this.db.run("UPDATE long_term_tasks SET stage = 'done', done_at = ?, updated_at = ? WHERE id = ?", [now, now, task.id]);
      this.addEvent(task.id, null, 'completed', actor, 'all sub-projects accepted — task complete');
    } else {
      this.touch(task.id);
    }
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, 'accepted');
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /**
   * Skip one open sub-project: "this sub-project is no longer needed". The
   * skip is a verdict on the PLAN, not the work — it never fakes acceptance,
   * so progress math stays honest. Twin may skip freely (same replanning
   * authority as updateSubtask), EXCEPT when the skip would close the last
   * open sub-project of an active task — that carries acceptance authority
   * and requires the delegate switch.
   */
  skipSubtask(subtaskId: string, actor: LongTermActor, reason = ''): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    const task = this.getTaskRow(current.taskId);
    if (!task) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    if (current.status === 'accepted' || current.status === 'skipped') {
      return { ok: false, code: 'VALIDATION', error: `cannot skip a ${current.status} sub-project` };
    }
    if (task.stage === 'done' || task.stage === 'cancelled') {
      return { ok: false, code: 'VALIDATION', error: `task is ${task.stage}` };
    }
    const remainingAfter = this.listSubtaskRows(task.id)
      .map((row) => this.mapSubtask(row))
      .filter((sub) => sub.id !== subtaskId && sub.status !== 'accepted' && sub.status !== 'skipped');
    const closesTask = remainingAfter.length === 0 && task.stage === 'active';
    if (actor === 'twin' && closesTask && task.acceptance_delegate !== 1) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        error: 'skipping the last open sub-project completes the task — acceptance is owner-only for this task (delegate switch is off)',
      };
    }
    const now = nowIso();
    this.db.run(
      "UPDATE long_term_subtasks SET status = 'skipped', wait_note = '', wait_until = NULL, updated_at = ? WHERE id = ?",
      [now, subtaskId],
    );
    if (task.current_subtask_id === subtaskId) {
      this.db.run('UPDATE long_term_tasks SET current_subtask_id = NULL WHERE id = ?', [task.id]);
    }
    const reasonText = asText(reason).trim().slice(0, 1000);
    this.addEvent(task.id, subtaskId, 'skipped', actor, reasonText || `skipped by ${actor}`);
    if (closesTask) {
      this.db.run("UPDATE long_term_tasks SET stage = 'done', done_at = ?, updated_at = ? WHERE id = ?", [now, now, task.id]);
      this.addEvent(task.id, null, 'completed', actor, 'all sub-projects accepted or skipped — task complete');
    } else {
      this.touch(task.id);
    }
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, 'skipped');
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Reject a proposed acceptance: back to in_progress with the owner's feedback. */
  rejectSubtask(subtaskId: string, actor: LongTermActor, feedback: string): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'waiting_owner') {
      return { ok: false, code: 'VALIDATION', error: `cannot reject from status ${current.status}` };
    }
    const text = asText(feedback).trim();
    if (!text) return { ok: false, code: 'VALIDATION', error: 'feedback is required (it steers the next iteration)' };
    this.db.run("UPDATE long_term_subtasks SET status = 'in_progress', updated_at = ? WHERE id = ?", [nowIso(), subtaskId]);
    this.addEvent(current.taskId, subtaskId, 'rejected', actor, text.slice(0, 1000));
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, 'rejected');
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Leave a waiting state (owner answered / external condition changed). */
  unblockSubtask(subtaskId: string, actor: LongTermActor, note = ''): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status !== 'waiting_owner' && current.status !== 'waiting_external') {
      return { ok: false, code: 'VALIDATION', error: `not waiting (status ${current.status})` };
    }
    this.db.run("UPDATE long_term_subtasks SET status = 'in_progress', wait_note = '', wait_until = NULL, updated_at = ? WHERE id = ?", [
      nowIso(),
      subtaskId,
    ]);
    this.addEvent(current.taskId, subtaskId, 'unblocked', actor, note || 'resumed');
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, 'unblocked');
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  /** Bind (or rebind) the cowork session that hosts this sub-project's work.
   *  Rotation-safe: every bind appends to session_history, which the
   *  supervision telemetry spans — a rotation must not blind the detectors. */
  bindSession(subtaskId: string, sessionId: string, actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    const trimmed = asText(sessionId).trim();
    if (!trimmed) return { ok: false, code: 'VALIDATION', error: 'sessionId is required' };
    const history = [...current.sessionHistory];
    if (!history.includes(trimmed)) history.push(trimmed);
    this.db.run('UPDATE long_term_subtasks SET session_id = ?, session_history_json = ?, updated_at = ? WHERE id = ?', [
      trimmed,
      JSON.stringify(history),
      nowIso(),
      subtaskId,
    ]);
    this.addEvent(current.taskId, subtaskId, 'note', actor, `session bound: ${trimmed}`);
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  addNote(taskId: string, subtaskId: string | null, text: string, actor: LongTermActor): LongTermResult<null> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    const trimmed = asText(text).trim();
    if (!trimmed) return { ok: false, code: 'VALIDATION', error: 'note text is required' };
    this.addEvent(taskId, subtaskId, 'note', actor, trimmed);
    this.touch(taskId);
    this.saveDb();
    return { ok: true, value: null };
  }

  // ── heartbeat nudge support (longTermAdvanceService) ─────────────────────

  /**
   * Journal a heartbeat escalation ('nudged' event, actor 'system'): the
   * advance handler opened/continued a session for this sub-project. The
   * journal is the owner's audit of every proactive move the TwinBot made.
   */
  recordNudge(taskId: string, subtaskId: string, detail: string): void {
    this.addEvent(taskId, subtaskId, 'nudged', 'system', detail);
    this.touch(taskId);
    this.saveDb();
  }

  /**
   * Journal a SUPERVISION escalation (kind 'supervised', actor 'system'): the
   * heartbeat opened a supervision turn (failure streak / duration overrun)
   * on this sub-project. Distinct from 'nudged' so the owner's journal — and
   * future telemetry — can tell routine pushes from interventions.
   */
  recordSupervision(taskId: string, subtaskId: string, detail: string): void {
    this.addEvent(taskId, subtaskId, 'supervised', 'system', detail);
    this.touch(taskId);
    this.saveDb();
  }

  /** Per-task nudge throttle state, one kv JSON map row (`longterm_nudge_state`). */
  getNudgeState(taskId: string): LongTermNudgeState | null {
    const map = this.readNudgeStateMap();
    const entry = map[taskId];
    if (!entry || typeof entry !== 'object') return null;
    const lastNudgeAtMs = Number((entry as LongTermNudgeState).lastNudgeAtMs);
    const lastEventId = Number((entry as LongTermNudgeState).lastEventId);
    if (!Number.isFinite(lastNudgeAtMs)) return null;
    const lastOwnerActivityAtMs = Number((entry as LongTermNudgeState).lastOwnerActivityAtMs);
    return {
      lastNudgeAtMs,
      lastEventId: Number.isFinite(lastEventId) ? lastEventId : 0,
      ...(Number.isFinite(lastOwnerActivityAtMs) && lastOwnerActivityAtMs > 0 ? { lastOwnerActivityAtMs } : {}),
    };
  }

  setNudgeState(taskId: string, state: LongTermNudgeState): void {
    const map = this.readNudgeStateMap();
    // An omitted owner-activity anchor preserves the existing one: an
    // escalation-turn write must not wipe the engagement anchor a sweep wrote.
    const lastOwnerActivityAtMs = state.lastOwnerActivityAtMs ?? map[taskId]?.lastOwnerActivityAtMs;
    map[taskId] = {
      lastNudgeAtMs: Math.trunc(state.lastNudgeAtMs),
      lastEventId: Math.trunc(state.lastEventId),
      ...(typeof lastOwnerActivityAtMs === 'number' && Number.isFinite(lastOwnerActivityAtMs) && lastOwnerActivityAtMs > 0
        ? { lastOwnerActivityAtMs: Math.trunc(lastOwnerActivityAtMs) }
        : {}),
    };
    this.db.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [LONGTERM_NUDGE_STATE_KV_KEY, JSON.stringify(map), Date.now()],
    );
    this.saveDb();
  }

  private readNudgeStateMap(): Record<string, LongTermNudgeState> {
    try {
      const row = this.getOne<{ value: string }>('SELECT value FROM kv WHERE key = ?', [LONGTERM_NUDGE_STATE_KV_KEY]);
      const parsed = row?.value ? JSON.parse(row.value) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, LongTermNudgeState>) : {};
    } catch {
      return {};
    }
  }

  /** Per-task supervision re-arm state (advance service P1): when did the last
   *  supervise escalation run, and which failure signature did it consume. */
  getSuperviseState(taskId: string): LongTermSuperviseState | null {
    const map = this.readSuperviseStateMap();
    const entry = map[taskId];
    if (!entry || typeof entry !== 'object') return null;
    const lastSuperviseAtMs = Number((entry as LongTermSuperviseState).lastSuperviseAtMs);
    if (!Number.isFinite(lastSuperviseAtMs)) return null;
    const convergenceAtMs = Array.isArray((entry as LongTermSuperviseState).convergenceAtMs)
      ? (entry as LongTermSuperviseState).convergenceAtMs.map(Number).filter((value) => Number.isFinite(value))
      : [];
    return {
      lastSuperviseAtMs,
      lastFailureSignal: String((entry as LongTermSuperviseState).lastFailureSignal ?? ''),
      lastAttentionKey: String((entry as LongTermSuperviseState).lastAttentionKey ?? ''),
      convergenceAtMs,
    };
  }

  setSuperviseState(taskId: string, state: LongTermSuperviseState): void {
    const map = this.readSuperviseStateMap();
    // Omitted optional fields preserve their existing values: a duration-turn
    // write must not wipe the failure dedup, and a supervision-turn write
    // must not wipe the churn-breaker trail.
    const lastFailureSignal = state.lastFailureSignal ?? map[taskId]?.lastFailureSignal ?? '';
    const lastAttentionKey = state.lastAttentionKey ?? map[taskId]?.lastAttentionKey ?? '';
    const convergenceAtMs = state.convergenceAtMs ?? map[taskId]?.convergenceAtMs ?? [];
    map[taskId] = {
      lastSuperviseAtMs: Math.trunc(state.lastSuperviseAtMs),
      lastFailureSignal,
      lastAttentionKey,
      convergenceAtMs: convergenceAtMs.map(Number).filter((value) => Number.isFinite(value)),
    };
    this.db.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [LONGTERM_SUPERVISE_STATE_KV_KEY, JSON.stringify(map), Date.now()],
    );
    this.saveDb();
  }

  private readSuperviseStateMap(): Record<string, LongTermSuperviseState> {
    try {
      const row = this.getOne<{ value: string }>('SELECT value FROM kv WHERE key = ?', [LONGTERM_SUPERVISE_STATE_KV_KEY]);
      const parsed = row?.value ? JSON.parse(row.value) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, LongTermSuperviseState>) : {};
    } catch {
      return {};
    }
  }

  /** Reverse lookup for the session-side origin chip: which task/sub-project owns this session. */
  findBySessionId(sessionId: string): { task: LongTermTaskSummary; subtask: LongTermSubtask | null } | null {
    const trimmed = asText(sessionId).trim();
    if (!trimmed) return null;
    const subRow = this.getOne<SubtaskRow>('SELECT * FROM long_term_subtasks WHERE session_id = ?', [trimmed]);
    if (subRow) {
      const taskRow = this.getTaskRow(subRow.task_id);
      if (!taskRow) return null;
      const subtasks = this.listSubtaskRows(taskRow.id).map((row) => this.mapSubtask(row));
      return { task: this.toSummary(taskRow, subtasks), subtask: this.mapSubtask(subRow) };
    }
    const taskRow = this.getOne<TaskRow>('SELECT * FROM long_term_tasks WHERE definition_session_id = ?', [trimmed]);
    if (!taskRow) return null;
    const subtasks = this.listSubtaskRows(taskRow.id).map((row) => this.mapSubtask(row));
    return { task: this.toSummary(taskRow, subtasks), subtask: null };
  }

  /**
   * Every session this task has ever been discussed in: the definition
   * session plus each sub-project's full session history (binds + rotations).
   * The advance service scans this set for owner engagement — the live
   * conversation about a task can drift away from the currently bound session
   * (the owner keeps talking in the session they are used to), and heartbeat
   * decisions must follow the owner, not the binding alone.
   */
  listRelatedSessionIds(taskId: string): string[] {
    const row = this.getTaskRow(taskId);
    if (!row) return [];
    const ids = new Set<string>();
    if (row.definition_session_id) ids.add(row.definition_session_id);
    for (const subRow of this.listSubtaskRows(taskId)) {
      for (const id of parseJsonArray<string>(subRow.session_history_json)) {
        if (id) ids.add(id);
      }
      if (subRow.session_id) ids.add(subRow.session_id);
    }
    return [...ids];
  }

  /** Sub-project ids involved in any dependency edge (has deps OR is depended on). */
  private dependencyLinkedIds(taskId: string): Set<string> {
    const linked = new Set<string>();
    for (const row of this.listSubtaskRows(taskId)) {
      const sub = this.mapSubtask(row);
      if (sub.dependsOn.length > 0) linked.add(sub.id);
      for (const dep of sub.dependsOn) linked.add(dep);
    }
    return linked;
  }

  /**
   * Move a sub-project one slot up/down (swap ordinals with the neighbor).
   * The UNIQUE(task_id, ordinal) pair makes a direct swap impossible, so the
   * current row parks at a temp ordinal mid-flight.
   *
   * Dependency-linked sub-projects (has deps OR is depended on) are NOT
   * manually reorderable — dependencies are the real ordering constraint;
   * ordinal is only the display order among free items. Reorder those by
   * redefining the dependencies instead (owner ruling 2026-09-24).
   */
  moveSubtask(subtaskId: string, direction: 'up' | 'down', actor: LongTermActor): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
    if (current.status === 'accepted' || current.status === 'skipped') {
      return { ok: false, code: 'VALIDATION', error: `cannot move a ${current.status} sub-project` };
    }
    const siblings = this.listSubtaskRows(current.taskId)
      .map((row) => this.mapSubtask(row))
      .sort((a, b) => a.ordinal - b.ordinal);
    const index = siblings.findIndex((sub) => sub.id === subtaskId);
    const neighbor = direction === 'up' ? siblings[index - 1] : siblings[index + 1];
    if (!neighbor) {
      return { ok: false, code: 'VALIDATION', error: direction === 'up' ? 'already first' : 'already last' };
    }
    const linked = this.dependencyLinkedIds(current.taskId);
    if (linked.has(current.id) || linked.has(neighbor.id)) {
      return {
        ok: false,
        code: 'VALIDATION',
        error: 'dependency-linked sub-projects cannot be reordered manually — redefine the dependencies instead',
      };
    }
    const now = nowIso();
    const tempOrdinal = siblings.reduce((max, sub) => Math.max(max, sub.ordinal), 0) + 1;
    this.db.run('UPDATE long_term_subtasks SET ordinal = ?, updated_at = ? WHERE id = ?', [tempOrdinal, now, current.id]);
    this.db.run('UPDATE long_term_subtasks SET ordinal = ?, updated_at = ? WHERE id = ?', [current.ordinal, now, neighbor.id]);
    this.db.run('UPDATE long_term_subtasks SET ordinal = ?, updated_at = ? WHERE id = ?', [neighbor.ordinal, now, current.id]);
    this.addEvent(current.taskId, current.id, 'replanned', actor, `moved ${direction} (#${current.ordinal} → #${neighbor.ordinal})`);
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }
}
