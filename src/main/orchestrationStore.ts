import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';

export type OrchestrationTaskStatus = 'planning' | 'running' | 'review' | 'completed' | 'failed' | 'cancelled';
export type OrchestrationStepStatus = 'blocked' | 'ready' | 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
export type OrchestrationAttemptStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

/**
 * v1.5 (owner ruling 「谁发起，谁验收」): who initiated the card. `owner` is
 * the default for every legacy and owner-facing path; only the Twin's local
 * worker delegation writes `twin_delegate`. Plain fact column on the ledger
 * row (the board that derived closer roles from it has been retired).
 */
export type OrchestrationTaskOrigin = 'owner' | 'twin_delegate';

export interface OrchestrationTask {
  id: string;
  ownerIntent: string;
  enrichedGoal: string | null;
  acceptanceCriteria: unknown[];
  sourceSessionId: string | null;
  twinMetabotId: number;
  ownerGlobalMetaId: string;
  status: OrchestrationTaskStatus;
  planVersion: number;
  origin: OrchestrationTaskOrigin;
  /**
   * Long-term task context (方案 A: explicit linkage for reporting back).
   * When set, this orchestration task is executing a slice of that long-term
   * sub-project; on terminal state (completed/failed) the orchestration service
   * reports back to the long-term task's definition session.
   */
  longtermTaskId: string | null;
  longtermSubtaskId: string | null;
  /**
   * The session to report back to when this orchestration completes. Typically
   * the long-term task's definition session, which may differ from both
   * sourceSessionId (Twin's delegation session) and the sub-task's bound
   * session (the work session).
   */
  longtermReportSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OrchestrationStep {
  id: string;
  taskId: string;
  ordinal: number;
  title: string;
  objective: string;
  acceptanceCriteria: unknown[];
  dependencyStepIds: string[];
  assigneeMetabotId: number | null;
  permissionScope: unknown;
  deadlineAt: string | null;
  status: OrchestrationStepStatus;
  acceptedResult: unknown | null;
  activeAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationAttempt {
  id: string;
  stepId: string;
  idempotencyKey: string;
  workerMetabotId: number;
  workerSessionId: string | null;
  status: OrchestrationAttemptStatus;
  prompt: string;
  result: unknown | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateOrchestrationTaskInput {
  ownerIntent: string;
  enrichedGoal?: string | null;
  acceptanceCriteria?: unknown[];
  sourceSessionId?: string | null;
  twinMetabotId: number;
  ownerGlobalMetaId: string;
  planVersion?: number;
  /** v1.5: omitted = 'owner'. Only delegateLocalWorker passes 'twin_delegate'. */
  origin?: OrchestrationTaskOrigin;
  /**
   * Long-term task context (方案 A): when the Twin delegates a slice of a
   * long-term sub-project, these fields link the orchestration back to it.
   */
  longtermTaskId?: string | null;
  longtermSubtaskId?: string | null;
  longtermReportSessionId?: string | null;
}

export interface CreateOrchestrationStepInput {
  taskId: string;
  ordinal: number;
  title: string;
  objective: string;
  acceptanceCriteria?: unknown[];
  dependencyStepIds?: string[];
  assigneeMetabotId?: number | null;
  permissionScope?: unknown;
  deadlineAt?: string | null;
  status?: OrchestrationStepStatus;
}

export interface CreateOrchestrationAttemptInput {
  stepId: string;
  idempotencyKey: string;
  workerMetabotId: number;
  workerSessionId?: string | null;
  prompt: string;
}

/** The two terminal states a Twin [ORCH-NOTIFY] can announce. */
export type OrchestrationNotificationOutcome = 'completed' | 'failed';

export interface ClaimOrchestrationNotificationInput {
  taskId: string;
  stepId: string;
  attemptId: string;
  outcome: OrchestrationNotificationOutcome;
}

/**
 * v1.4 closure semantics (owner ruling A): the closure columns on the ledger
 * row have EXACTLY ONE writer — `OrchestrationStore.recordClosure`. The board's
 * closeCard and the group-task acceptance path both go through it, so no second
 * copy of the closure SQL can drift.
 *
 * `conclusion === null` means "accepted with no instruction": the human closed
 * the card out without leaving a line for the Twin to execute. It never enters
 * the pending-closure queue.
 */
export interface RecordClosureInput {
  /** Trimmed closing conclusion, or NULL for a conclusion-free acceptance. */
  conclusion: string | null;
  by: 'owner' | 'twin';
  pinId?: string | null;
  /**
   * v1.5 (owner ruling 「谁发起，谁验收」): when the Twin closes its OWN
   * delegation card, the closure IS the execution write-off — the SAME
   * statement that writes the closure must also mark the conclusion processed
   * (`closure_processed_by='twin'`), so it can never leak into the pending
   * queue. `hash` binds the mark to the exact conclusion text
   * (`closureHash(conclusion)` from the board layer, or NULL for a
   * conclusion-free acceptance, which never queues anyway).
   */
  selfProcessed?: { by: 'twin'; hash: string | null };
}

/** The persisted closure mark as read back by `getClosureMark`. */
export interface OrchestrationClosureMark {
  conclusion: string | null;
  by: string | null;
  at: string | null;
  pinId: string | null;
}

interface Row { [key: string]: unknown }

const TASK_TRANSITIONS: Record<OrchestrationTaskStatus, OrchestrationTaskStatus[]> = {
  planning: ['running', 'completed', 'failed', 'cancelled'],
  running: ['review', 'completed', 'failed', 'cancelled'],
  review: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['planning', 'running', 'cancelled'],
  cancelled: [],
};

const STEP_TRANSITIONS: Record<OrchestrationStepStatus, OrchestrationStepStatus[]> = {
  blocked: ['ready', 'cancelled'],
  ready: ['queued', 'cancelled'],
  queued: ['running', 'ready', 'failed', 'cancelled'],
  running: ['waiting_input', 'completed', 'failed', 'ready', 'cancelled'],
  waiting_input: ['running', 'completed', 'failed', 'cancelled'],
  completed: ['ready'],
  // failed -> completed: used when a noise step (e.g. a mistaken worker mention
  // whose skill routing failed) is auto-ignored when the task enters review.
  failed: ['ready', 'cancelled', 'completed'],
  cancelled: [],
};
const ATTEMPT_TRANSITIONS: Record<OrchestrationAttemptStatus, OrchestrationAttemptStatus[]> = {
  queued: ['running', 'failed', 'timed_out', 'cancelled'],
  running: ['completed', 'failed', 'timed_out', 'cancelled'],
  completed: [],
  failed: [],
  // timed_out is NOT terminal: the skill-turn watchdog can fire while the
  // worker session is still running. Such an attempt is parked as timed_out
  // and must be correctable to completed when the session delivers a late
  // result, or settled to failed/cancelled when it terminates without output,
  // the recovery window expires, or the owner cancels/reassigns.
  timed_out: ['completed', 'failed', 'cancelled'],
  cancelled: [],
};

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function taskFromRow(row: Row): OrchestrationTask {
  const status = String(row.status);
  return {
    id: String(row.id),
    ownerIntent: String(row.owner_intent ?? ''),
    enrichedGoal: row.enriched_goal == null ? null : String(row.enriched_goal),
    acceptanceCriteria: parseJson(row.acceptance_criteria_json, []) as unknown[],
    sourceSessionId: row.source_session_id == null ? null : String(row.source_session_id),
    twinMetabotId: Number(row.twin_metabot_id),
    ownerGlobalMetaId: String(row.owner_global_meta_id ?? ''),
    status: status in TASK_TRANSITIONS ? status as OrchestrationTaskStatus : 'planning',
    planVersion: Number(row.plan_version ?? 1),
    // Fail-safe to 'owner': a NULL/missing origin (pre-migration row read
    // before the ALTER ran, or a rogue writer) keeps the card owner-closable —
    // the quiet direction. Only the exact literal is a Twin delegation.
    origin: row.origin === 'twin_delegate' ? 'twin_delegate' : 'owner',
    longtermTaskId: row.longterm_task_id == null ? null : String(row.longterm_task_id),
    longtermSubtaskId: row.longterm_subtask_id == null ? null : String(row.longterm_subtask_id),
    longtermReportSessionId: row.longterm_report_session_id == null ? null : String(row.longterm_report_session_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

function stepFromRow(row: Row): OrchestrationStep {
  const status = String(row.status);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ordinal: Number(row.ordinal),
    title: String(row.title ?? ''),
    objective: String(row.objective ?? ''),
    acceptanceCriteria: parseJson(row.acceptance_criteria_json, []) as unknown[],
    dependencyStepIds: parseJson(row.dependency_step_ids_json, []) as string[],
    assigneeMetabotId: row.assignee_metabot_id == null ? null : Number(row.assignee_metabot_id),
    permissionScope: parseJson(row.permission_scope_json, {}),
    deadlineAt: row.deadline_at == null ? null : String(row.deadline_at),
    status: status in STEP_TRANSITIONS ? status as OrchestrationStepStatus : 'blocked',
    acceptedResult: parseJson(row.accepted_result_json, null),
    activeAttemptId: row.active_attempt_id == null ? null : String(row.active_attempt_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function attemptFromRow(row: Row): OrchestrationAttempt {
  const status = String(row.status);
  return {
    id: String(row.id),
    stepId: String(row.step_id),
    idempotencyKey: String(row.idempotency_key),
    workerMetabotId: Number(row.worker_metabot_id),
    workerSessionId: row.worker_session_id == null ? null : String(row.worker_session_id),
    status: status === 'timed_out' || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'running' ? status : 'queued',
    prompt: String(row.prompt ?? ''),
    result: parseJson(row.result_json, null),
    error: row.error == null ? null : String(row.error),
    queuedAt: String(row.queued_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
  };
}

export class OrchestrationStore {
  private readonly db: Database;
  private readonly saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
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
      CREATE TABLE IF NOT EXISTS orchestration_tasks (
        id TEXT PRIMARY KEY,
        owner_intent TEXT NOT NULL,
        enriched_goal TEXT,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        source_session_id TEXT,
        twin_metabot_id INTEGER NOT NULL,
        owner_global_meta_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','running','review','completed','failed','cancelled')),
        plan_version INTEGER NOT NULL DEFAULT 1,
        origin TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_tasks_owner_status
        ON orchestration_tasks(owner_global_meta_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS orchestration_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        dependency_step_ids_json TEXT NOT NULL DEFAULT '[]',
        assignee_metabot_id INTEGER,
        permission_scope_json TEXT NOT NULL DEFAULT '{}',
        deadline_at TEXT,
        status TEXT NOT NULL DEFAULT 'blocked' CHECK(status IN ('blocked','ready','queued','running','waiting_input','completed','failed','cancelled')),
        accepted_result_json TEXT,
        active_attempt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, ordinal),
        FOREIGN KEY(task_id) REFERENCES orchestration_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_steps_assignee_status
        ON orchestration_steps(assignee_metabot_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS orchestration_attempts (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        worker_metabot_id INTEGER NOT NULL,
        worker_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','timed_out','cancelled')),
        prompt TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY(step_id) REFERENCES orchestration_steps(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_attempts_step_status
        ON orchestration_attempts(step_id, status, queued_at DESC);
      CREATE TABLE IF NOT EXISTS orchestration_notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed')),
        created_at TEXT NOT NULL,
        UNIQUE(attempt_id, outcome)
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_notifications_task
        ON orchestration_notifications(task_id, created_at DESC);
    `);

    // 方案 A: additive migration for long-term task linkage columns (idempotent).
    // Databases created before these columns get them via guarded ALTERs; new
    // databases carry them from the CREATE TABLE (once the IF NOT EXISTS guard
    // stops entering). Each ALTER is safe on existing rows: NULL = no linkage.
    const taskColumns = this.getAll<{ name: unknown }>('PRAGMA table_info(orchestration_tasks)').map((row) => String(row.name));
    if (!taskColumns.includes('longterm_task_id')) {
      this.db.run('ALTER TABLE orchestration_tasks ADD COLUMN longterm_task_id TEXT');
    }
    if (!taskColumns.includes('longterm_subtask_id')) {
      this.db.run('ALTER TABLE orchestration_tasks ADD COLUMN longterm_subtask_id TEXT');
    }
    if (!taskColumns.includes('longterm_report_session_id')) {
      this.db.run('ALTER TABLE orchestration_tasks ADD COLUMN longterm_report_session_id TEXT');
    }
    this.saveDb();
  }

  createTask(input: CreateOrchestrationTaskInput): OrchestrationTask {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`INSERT INTO orchestration_tasks
      (id, owner_intent, enriched_goal, acceptance_criteria_json, source_session_id, twin_metabot_id, owner_global_meta_id, plan_version, origin, longterm_task_id, longterm_subtask_id, longterm_report_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, input.ownerIntent.trim(), input.enrichedGoal?.trim() || null,
      JSON.stringify(input.acceptanceCriteria ?? []), input.sourceSessionId ?? null,
      input.twinMetabotId, input.ownerGlobalMetaId.trim(), input.planVersion ?? 1,
      input.origin === 'twin_delegate' ? 'twin_delegate' : 'owner',
      input.longtermTaskId ?? null,
      input.longtermSubtaskId ?? null,
      input.longtermReportSessionId ?? null,
      now, now,
    ]);
    this.saveDb();
    return this.getTask(id)!;
  }

  getTask(id: string): OrchestrationTask | null {
    const row = this.getOne<Row>('SELECT * FROM orchestration_tasks WHERE id = ?', [id]);
    return row ? taskFromRow(row) : null;
  }

  listActiveTasks(ownerGlobalMetaId?: string): OrchestrationTask[] {
    const rows = ownerGlobalMetaId
      ? this.getAll<Row>(`SELECT * FROM orchestration_tasks WHERE owner_global_meta_id = ? AND status NOT IN ('completed','cancelled') ORDER BY updated_at DESC`, [ownerGlobalMetaId])
      : this.getAll<Row>(`SELECT * FROM orchestration_tasks WHERE status NOT IN ('completed','cancelled') ORDER BY updated_at DESC`);
    return rows.map(taskFromRow);
  }

  getTaskBySourceSessionId(sourceSessionId: string): OrchestrationTask | null {
    const row = this.getOne<Row>(
      'SELECT * FROM orchestration_tasks WHERE source_session_id = ? ORDER BY created_at ASC LIMIT 1',
      [sourceSessionId],
    );
    return row ? taskFromRow(row) : null;
  }

  updateTaskStatus(id: string, status: OrchestrationTaskStatus): OrchestrationTask {
    const current = this.getTask(id);
    if (!current) throw new Error(`Orchestration task ${id} not found`);
    if (current.status === status) return current;
    if (!TASK_TRANSITIONS[current.status].includes(status)) {
      throw new Error(`Illegal orchestration task status transition: ${current.status} -> ${status}`);
    }
    const now = new Date().toISOString();
    this.db.run('UPDATE orchestration_tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?', [
      status, now, status === 'completed' || status === 'cancelled' ? now : null, id,
    ]);
    this.saveDb();
    return this.getTask(id)!;
  }

  /**
   * THE writer of the closure columns (v1.4, owner ruling A). The board's
   * closeCard and the group-task acceptance path both call this — the closure
   * SQL exists exactly once.
   *
   * One statement writes the four closure columns AND resets the five
   * processing marks (T1, freeze doc §3.1): a NEW closure must never inherit
   * the previous conclusion's ack, or a re-closed card's fresh instruction
   * would be silently swallowed. `updated_at` is deliberately NOT touched —
   * the idle/warn clock reads activity anchors, and a closure write alone must
   * not reset it (the accepted card's stale-activity no-warn fix relies on
   * closure_at, not on fresh activity).
   */
  recordClosure(id: string, input: RecordClosureInput): OrchestrationClosureMark {
    const current = this.getTask(id);
    if (!current) throw new Error(`Orchestration task ${id} not found`);
    const conclusion = input.conclusion?.trim() || null;
    const now = new Date().toISOString();
    // v1.5: a Twin self-closure writes its own processed mark in THIS statement;
    // every other close resets the marks to NULL exactly as before (T1).
    const self = input.selfProcessed;
    this.db.run(
      `UPDATE orchestration_tasks
          SET closure_conclusion = ?, closure_by = ?, closure_at = ?, closure_pin_id = ?,
              closure_processed_at = ?, closure_processed_by = ?, closure_processed_hash = ?,
              closure_receipt = NULL, closure_receipt_pin_id = NULL
        WHERE id = ?`,
      [
        conclusion, input.by, now, input.pinId ?? null,
        self ? now : null, self?.by ?? null, self?.hash ?? null,
        id,
      ],
    );
    this.saveDb();
    return this.getClosureMark(id)!;
  }

  /** The persisted closure mark, or NULL when the task row does not exist. */
  getClosureMark(id: string): OrchestrationClosureMark | null {
    const row = this.getOne<Row>(
      'SELECT closure_conclusion, closure_by, closure_at, closure_pin_id FROM orchestration_tasks WHERE id = ?',
      [id],
    );
    if (!row) return null;
    return {
      conclusion: row.closure_conclusion == null ? null : String(row.closure_conclusion),
      by: row.closure_by == null ? null : String(row.closure_by),
      at: row.closure_at == null ? null : String(row.closure_at),
      pinId: row.closure_pin_id == null ? null : String(row.closure_pin_id),
    };
  }

  /**
   * Whether the card carries a closure record (closure_at IS NOT NULL) — the
   * v1.4 definition of "closed" (human acceptance recorded). Missing rows are
   * never closed. Backward compatible: every historical writer (closeCard, the
   * v1.1 startup backfill) wrote closure_at together with the conclusion, so
   * no legacy row flips meaning.
   */
  hasClosureRecord(id: string): boolean {
    const row = this.getOne<Row>('SELECT closure_at FROM orchestration_tasks WHERE id = ?', [id]);
    return row != null && row.closure_at != null && String(row.closure_at) !== '';
  }

  createStep(input: CreateOrchestrationStepInput): OrchestrationStep {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`INSERT INTO orchestration_steps
      (id, task_id, ordinal, title, objective, acceptance_criteria_json, dependency_step_ids_json, assignee_metabot_id, permission_scope_json, deadline_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, input.taskId, Math.trunc(input.ordinal), input.title.trim(), input.objective.trim(),
      JSON.stringify(input.acceptanceCriteria ?? []), JSON.stringify(input.dependencyStepIds ?? []),
      input.assigneeMetabotId ?? null, JSON.stringify(input.permissionScope ?? {}), input.deadlineAt ?? null,
      input.status ?? 'blocked', now, now,
    ]);
    this.saveDb();
    return this.getStep(id)!;
  }

  getStep(id: string): OrchestrationStep | null {
    const row = this.getOne<Row>('SELECT * FROM orchestration_steps WHERE id = ?', [id]);
    return row ? stepFromRow(row) : null;
  }

  getTaskForStep(stepId: string): OrchestrationTask | null {
    const row = this.getOne<Row>(`SELECT t.* FROM orchestration_tasks t
      INNER JOIN orchestration_steps s ON s.task_id = t.id WHERE s.id = ?`, [stepId]);
    return row ? taskFromRow(row) : null;
  }

  listSteps(taskId: string): OrchestrationStep[] {
    return this.getAll<Row>('SELECT * FROM orchestration_steps WHERE task_id = ? ORDER BY ordinal ASC', [taskId]).map(stepFromRow);
  }

  updateStepStatus(id: string, status: OrchestrationStepStatus, patch: { acceptedResult?: unknown; activeAttemptId?: string | null } = {}): OrchestrationStep {
    const current = this.getStep(id);
    if (!current) throw new Error(`Orchestration step ${id} not found`);
    if (current.status !== status && !STEP_TRANSITIONS[current.status].includes(status)) {
      throw new Error(`Illegal orchestration step status transition: ${current.status} -> ${status}`);
    }
    this.db.run(`UPDATE orchestration_steps SET status = ?, accepted_result_json = ?, active_attempt_id = ?, updated_at = ? WHERE id = ?`, [
      status,
      patch.acceptedResult === undefined ? (current.acceptedResult == null ? null : JSON.stringify(current.acceptedResult)) : JSON.stringify(patch.acceptedResult),
      patch.activeAttemptId === undefined ? current.activeAttemptId : patch.activeAttemptId,
      new Date().toISOString(), id,
    ]);
    this.saveDb();
    return this.getStep(id)!;
  }

  updateStepAssignee(id: string, assigneeMetabotId: number): OrchestrationStep {
    const step = this.getStep(id);
    if (!step) throw new Error(`Orchestration step ${id} not found`);
    this.db.run('UPDATE orchestration_steps SET assignee_metabot_id = ?, updated_at = ? WHERE id = ?', [assigneeMetabotId, new Date().toISOString(), id]);
    this.saveDb();
    return this.getStep(id)!;
  }

  createAttempt(input: CreateOrchestrationAttemptInput): OrchestrationAttempt {
    const existing = this.getAttemptByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`INSERT INTO orchestration_attempts
      (id, step_id, idempotency_key, worker_metabot_id, worker_session_id, prompt, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, input.stepId, input.idempotencyKey, input.workerMetabotId, input.workerSessionId ?? null, input.prompt, now]);
    this.db.run('UPDATE orchestration_steps SET active_attempt_id = ?, updated_at = ? WHERE id = ?', [id, now, input.stepId]);
    this.saveDb();
    return this.getAttempt(id)!;
  }

  getAttempt(id: string): OrchestrationAttempt | null {
    const row = this.getOne<Row>('SELECT * FROM orchestration_attempts WHERE id = ?', [id]);
    return row ? attemptFromRow(row) : null;
  }

  getAttemptByIdempotencyKey(key: string): OrchestrationAttempt | null {
    const row = this.getOne<Row>('SELECT * FROM orchestration_attempts WHERE idempotency_key = ?', [key]);
    return row ? attemptFromRow(row) : null;
  }

  listAttempts(stepId: string): OrchestrationAttempt[] {
    return this.getAll<Row>('SELECT * FROM orchestration_attempts WHERE step_id = ? ORDER BY queued_at ASC', [stepId]).map(attemptFromRow);
  }

  /**
   * At-most-once arbiter for Twin terminal-state notifications.
   *
   * The row IS the decision: a single INSERT ... OR IGNORE against
   * UNIQUE(attempt_id, outcome) either wins the (attempt, terminal state) slot
   * or observes that it was already claimed. This replaces "check a kv key,
   * notify, then set the key" — where a process death between the notification
   * and the marker write re-notified the same terminal state — with one atomic
   * write that lands BEFORE the cross-session insert.
   *
   * Returns true only for the caller that actually inserted the row. Rows are
   * never deleted: the table is the audit trail of every notification a task
   * attempt was entitled to AND the durable guard itself.
   *
   * INSERT OR IGNORE is safe here because every bound value is a non-null
   * string and the only CHECK is the two typed outcomes — in practice the one
   * ignorable violation is the (attempt_id, outcome) uniqueness this method
   * exists to arbitrate.
   */
  claimNotification(input: ClaimOrchestrationNotificationInput): boolean {
    const id = uuidv4();
    this.db.run(
      `INSERT OR IGNORE INTO orchestration_notifications
        (id, task_id, step_id, attempt_id, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.taskId, input.stepId, input.attemptId, input.outcome, new Date().toISOString()],
    );
    const modified = this.db.getRowsModified?.();
    let claimed: boolean;
    if (typeof modified === 'number') {
      claimed = modified > 0;
    } else {
      // Backend without change accounting: the INSERT is still atomic, so the
      // read-back names the winner; we claimed the slot iff the row carries
      // the id we just generated.
      const row = this.getOne<{ id: unknown }>(
        'SELECT id FROM orchestration_notifications WHERE attempt_id = ? AND outcome = ?',
        [input.attemptId, input.outcome],
      );
      claimed = String(row?.id ?? '') === id;
    }
    if (claimed) this.saveDb();
    return claimed;
  }

  /** Read-back for tests/audit: every notification claim a task has taken. */
  listNotifications(taskId: string): Array<{
    id: string;
    taskId: string;
    stepId: string;
    attemptId: string;
    outcome: OrchestrationNotificationOutcome;
    createdAt: string;
  }> {
    return this.getAll<Row>(
      'SELECT * FROM orchestration_notifications WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
      [taskId],
    ).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      stepId: String(row.step_id),
      attemptId: String(row.attempt_id),
      outcome: row.outcome === 'failed' ? 'failed' : 'completed',
      createdAt: String(row.created_at),
    }));
  }

  /**
   * Long-term supervision telemetry (P1): attempts whose step's task was
   * sourced from any of these sessions — i.e. every worker dispatch the Twin
   * made from those sessions — newest first.
   */
  listAttemptsForSourceSessions(sessionIds: string[]): OrchestrationAttempt[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(',');
    return this.getAll<Row>(
      `SELECT a.* FROM orchestration_attempts a
       JOIN orchestration_steps s ON s.id = a.step_id
       JOIN orchestration_tasks t ON t.id = s.task_id
       WHERE t.source_session_id IN (${placeholders})
       ORDER BY a.queued_at DESC`,
      sessionIds,
    ).map(attemptFromRow);
  }

  updateAttempt(id: string, status: OrchestrationAttemptStatus, patch: { workerSessionId?: string | null; result?: unknown; error?: string | null } = {}): OrchestrationAttempt {
    const current = this.getAttempt(id);
    if (!current) throw new Error(`Orchestration attempt ${id} not found`);
    if (current.status !== status && !ATTEMPT_TRANSITIONS[current.status].includes(status)) {
      throw new Error(`Illegal orchestration attempt status transition: ${current.status} -> ${status}`);
    }
    const now = new Date().toISOString();
    const startedAt = status === 'running' && !current.startedAt ? now : current.startedAt;
    // timed_out parks the attempt at the watchdog moment; when a late result
    // later recovers it to completed, refresh finishedAt to the real
    // completion time instead of keeping the (early) parked timestamp.
    const finishedAt = !current.finishedAt
      ? (['completed', 'failed', 'timed_out', 'cancelled'].includes(status) ? now : current.finishedAt)
      : (status === 'completed' && current.status === 'timed_out' ? now : current.finishedAt);
    this.db.run(`UPDATE orchestration_attempts
      SET status = ?, worker_session_id = ?, result_json = ?, error = ?, started_at = ?, finished_at = ?
      WHERE id = ?`, [
      status, patch.workerSessionId === undefined ? current.workerSessionId : patch.workerSessionId,
      patch.result === undefined ? (current.result == null ? null : JSON.stringify(current.result)) : JSON.stringify(patch.result),
      patch.error === undefined ? current.error : patch.error, startedAt, finishedAt, id,
    ]);
    this.saveDb();
    return this.getAttempt(id)!;
  }

  getActiveWorkload(metabotId: number): number {
    const row = this.getOne<{ count: number }>(`SELECT COUNT(*) AS count FROM orchestration_steps
      WHERE assignee_metabot_id = ? AND status IN ('ready','queued','running','waiting_input')`, [metabotId]);
    return Number(row?.count ?? 0);
  }

  cancelTaskCascade(taskId: string): OrchestrationTask {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Orchestration task ${taskId} not found`);
    const now = new Date().toISOString();
    const attempts = this.getAll<{ id: string }>(`SELECT a.id FROM orchestration_attempts a
      INNER JOIN orchestration_steps s ON s.id = a.step_id WHERE s.task_id = ? AND a.status IN ('queued','running','timed_out')`, [taskId]);
    for (const attempt of attempts) {
      this.db.run(`UPDATE orchestration_attempts SET status = 'cancelled', error = 'CANCELLED_BY_OWNER', finished_at = ? WHERE id = ?`, [now, attempt.id]);
    }
    this.db.run(`UPDATE orchestration_steps SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status NOT IN ('completed','cancelled')`, [now, taskId]);
    this.db.run(`UPDATE orchestration_tasks SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND status NOT IN ('completed','cancelled')`, [now, now, taskId]);
    this.saveDb();
    return this.getTask(taskId)!;
  }

  recoverAfterRestart(): { attempts: number; steps: number } {
    const now = new Date().toISOString();
    // 'timed_out' attempts are also unrecoverable after a restart: the worker
    // session lives inside the runner process and dies with it, so no late
    // result can ever arrive. Settle them to failed and free the step.
    const running = this.getAll<{ id: string; step_id: string }>(`SELECT id, step_id FROM orchestration_attempts WHERE status IN ('running','timed_out')`);
    for (const attempt of running) {
      this.db.run(`UPDATE orchestration_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, ['RECOVERED_AFTER_RESTART', now, attempt.id]);
      this.db.run(`UPDATE orchestration_steps SET status = 'ready', active_attempt_id = NULL, updated_at = ? WHERE id = ? AND status IN ('running','queued')`, [now, attempt.step_id]);
    }
    if (running.length > 0) this.saveDb();
    return { attempts: running.length, steps: running.length };
  }
}
