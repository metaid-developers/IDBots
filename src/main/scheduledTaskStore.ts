import type { SqliteDatabase as Database } from './sqliteTypes';
import { v4 as uuidv4 } from 'uuid';
import { CronExpressionParser } from 'cron-parser';
import { resolveCoworkExecutionMode } from './libs/coworkExecutionMode';

// Types for scheduled tasks (main process side)
export type TaskLastStatus = 'success' | 'error' | 'running' | 'max_fires_reached' | null;

/**
 * Who initiated the task's creation. 'human' = the settings UI (a deliberate
 * owner act); 'agent' = a bot through the skill script / inline tool / proxy
 * API. Null = rows created before the lifecycle fields existed (legacy).
 */
export type TaskOrigin = 'human' | 'agent';

export interface TaskState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: TaskLastStatus;
  lastError: string | null;
  lastDurationMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

export interface Schedule {
  type: 'at' | 'interval' | 'cron';
  datetime?: string;
  intervalMs?: number;
  unit?: 'minutes' | 'hours' | 'days';
  value?: number;
  expression?: string;
}

export type NotifyPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord';

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  metabotId: number | null;
  coworkSessionId: string | null;
  targetSessionId: string | null;
  /** Session strategy when no targetSessionId binding applies (see SCHEDULED_TASK_SESSION_MODES). */
  sessionMode: ScheduledTaskSessionMode;
  /** The standing conversation a 'series' task's fires currently continue in (null = none yet). */
  seriesSessionId: string | null;
  /** Memory-surface opt-in for the task's session; 'none' = legacy blackout. */
  memoryAccess: ScheduledTaskMemoryAccess;
  expiresAt: string | null;
  notifyPlatforms: NotifyPlatform[];
  /**
   * Lifecycle provenance and fire budget. `origin`/`originSessionId`/
   * `originContext` record WHO created the task and WHERE (never recreated
   * from nothing); `exitCondition`/`maxFires`/`fireCount` carry the death
   * clause — recurring tasks must be able to end. Legacy rows keep NULL
   * origin / NULL maxFires (no behavior change for them).
   */
  origin: TaskOrigin | null;
  originSessionId: string | null;
  originContext: string | null;
  exitCondition: string | null;
  maxFires: number | null;
  fireCount: number;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

/**
 * Why an execution was decided NOT to run. Enumerated so the ledger can be
 * queried by reason instead of by parsing prose (issue #60):
 * - `already_running`: the previous run of the same task is still executing.
 * - `expired`: the task's `expiresAt` day is over.
 * - `disabled`: reserved for a fire attempt on a disabled task. Disabling nulls
 *   `next_run_at_ms`, so no due-set entry exists to skip; the code is kept in
 *   the enumeration as the vocabulary for that state.
 * - `stuck_running`: `running_at_ms` was left set with no live execution behind
 *   it (scheduler stopped mid-run, lost run) — the task was wedged out of the
 *   due set and the marker was released.
 */
export const SCHEDULED_TASK_SKIP_REASONS = [
  'already_running',
  'expired',
  'disabled',
  'stuck_running',
] as const;

export type ScheduledTaskSkipReason = (typeof SCHEDULED_TASK_SKIP_REASONS)[number];

/**
 * Default fire budget for bot-created RECURRING tasks (creation seams stamp
 * it when the caller passes none). Humans keep unlimited tasks; a bot's
 * cron/interval loop must always carry a bounded lifecycle. 50 fires ≈ 4.2
 * days at the incident's every-2-hours cadence — long enough for any
 * legitimate watch, short enough to never become permanent noise.
 */
export const DEFAULT_AGENT_MAX_FIRES = 50;

/**
 * Per-task opt-in for the session memory surface (2026-10-25): what the
 * memory-family tools of a task's cowork session may do.
 * - `none`: the legacy default — full blackout, no memory reads or writes
 *   (exactly the pre-opt-in behavior of every scheduled task).
 * - `read-only`: the recall/injection tools mount, mutating tools do not.
 * - `read-write`: recall, injection, and turn-end/mutating memory updates.
 */
export const SCHEDULED_TASK_MEMORY_ACCESS_LEVELS = [
  'none',
  'read-only',
  'read-write',
] as const;

export type ScheduledTaskMemoryAccess = (typeof SCHEDULED_TASK_MEMORY_ACCESS_LEVELS)[number];

/**
 * Where a task's fires run when it has no `targetSessionId` binding
 * (2026-11-09):
 * - `series` (default): every fire continues in ONE standing conversation
 *   titled `[定时] <name>`; when that conversation outgrows its budget the
 *   scheduler rotates to `[定时] <name>（2）`, `（3）`… The previous default
 *   opened a brand-new session per fire, so a daily task piled up dozens of
 *   identical sessions (one task reached 708) and a week of results had to be
 *   collected from as many conversations.
 * - `fresh`: the explicit opt-out — a new session for every fire.
 * Legacy rows store NULL and read as `series`, so existing tasks move to the
 * standing conversation on their next fire.
 */
export const SCHEDULED_TASK_SESSION_MODES = ['series', 'fresh'] as const;

export type ScheduledTaskSessionMode = (typeof SCHEDULED_TASK_SESSION_MODES)[number];

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: 'running' | 'success' | 'error' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  trigger: 'scheduled' | 'manual';
  /** Set only for `status = 'skipped'`; null on every real run. */
  skipReason: ScheduledTaskSkipReason | null;
}

export interface ScheduledTaskInput {
  name: string;
  description: string;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  metabotId?: number | null;
  targetSessionId?: string | null;
  /** Optional; absent/invalid values store as 'series' (the standing conversation). */
  sessionMode?: ScheduledTaskSessionMode;
  /** Optional; absent/invalid values store as 'none' (legacy blackout). */
  memoryAccess?: ScheduledTaskMemoryAccess;
  expiresAt: string | null;
  notifyPlatforms: NotifyPlatform[];
  enabled: boolean;
  origin?: TaskOrigin | null;
  originSessionId?: string | null;
  originContext?: string | null;
  exitCondition?: string | null;
  /** NULL = uncapped (human-created default); seams stamp 50 for bot-created recurring tasks. */
  maxFires?: number | null;
}

// Raw DB row types
interface TaskRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  schedule_json: string;
  prompt: string;
  working_directory: string;
  system_prompt: string;
  execution_mode: string;
  metabot_id: number | null;
  cowork_session_id: string | null;
  target_session_id: string | null;
  session_mode: string | null;
  series_session_id: string | null;
  memory_access: string | null;
  expires_at: string | null;
  origin: string | null;
  origin_session_id: string | null;
  origin_context: string | null;
  exit_condition: string | null;
  max_fires: number | null;
  fire_count: number;
  notify_platforms_json: string;
  next_run_at_ms: number | null;
  last_run_at_ms: number | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  running_at_ms: number | null;
  consecutive_errors: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  session_id: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  trigger_type: string;
  skip_reason: string | null;
}

/**
 * A blank/whitespace-only binding means "no binding" — store NULL, never ''.
 */
function normalizeTargetSessionId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Every row written before the memoryAccess opt-in has NULL here, and any
 * unknown value is treated the same way: they all normalize to 'none', the
 * legacy full-blackout default. Keeps upgraded databases byte-compatible with
 * the pre-opt-in behavior until the owner opts a task in.
 */
function normalizeMemoryAccess(value: string | null | undefined): ScheduledTaskMemoryAccess {
  return SCHEDULED_TASK_MEMORY_ACCESS_LEVELS.includes(value as ScheduledTaskMemoryAccess)
    ? (value as ScheduledTaskMemoryAccess)
    : 'none';
}

/**
 * Only an explicit 'fresh' opts out of the standing conversation; NULL
 * (legacy rows) and any unknown value read as 'series', the default.
 */
function normalizeSessionMode(value: string | null | undefined): ScheduledTaskSessionMode {
  return value === 'fresh' ? 'fresh' : 'series';
}

export class ScheduledTaskStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureTaskSessionColumn();
    this.ensureTargetSessionColumn();
    this.ensureRunSkipReasonColumn();
    this.ensureMigrationColumns();
    this.ensureLifecycleColumns();
    this.ensureMemoryAccessColumn();
    this.ensureSessionSeriesColumns();
    this.unmigrateLegacySdkCronTasks();
    this.resetStuckRunningTasks();
  }

  // Helper method to get a single row from query result
  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as T;
  }

  // Helper method to get all rows from query result
  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  }

  private tableExists(tableName: string): boolean {
    const row = this.getOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      [tableName]
    );
    return Boolean(row);
  }

  private ensureTaskSessionColumn(): void {
    try {
      if (!this.tableExists('scheduled_tasks')) return;

      const columnsResult = this.db.exec('PRAGMA table_info(scheduled_tasks);');
      const columns = columnsResult[0]?.values.map((row) => String(row[1])) ?? [];
      let shouldSave = false;

      if (!columns.includes('cowork_session_id')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN cowork_session_id TEXT');
        shouldSave = true;
      }

      if (this.backfillMissingTaskSessionIdsFromRuns()) {
        shouldSave = true;
      }

      if (shouldSave) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('Failed to ensure scheduled task cowork session column:', error);
    }
  }

  /**
   * `target_session_id` binds a task to an existing session it injects its
   * prompt into (as opposed to `cowork_session_id`, the legacy "last run
   * session" bookkeeping column, which a startup backfill keeps overwriting).
   * Idempotent: repeated startup never errors.
   */
  private ensureTargetSessionColumn(): void {
    try {
      if (!this.tableExists('scheduled_tasks')) return;

      const columnsResult = this.db.exec('PRAGMA table_info(scheduled_tasks);');
      const columns = columnsResult[0]?.values.map((row) => String(row[1])) ?? [];

      if (!columns.includes('target_session_id')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN target_session_id TEXT');
        this.saveDb();
      }
    } catch (error) {
      console.warn('Failed to ensure scheduled task target session column:', error);
    }
  }

  /**
   * `memory_access` carries the per-task memory-surface opt-in (see
   * SCHEDULED_TASK_MEMORY_ACCESS_LEVELS). Legacy rows keep NULL and read as
   * 'none' via normalizeMemoryAccess. Idempotent: repeated startup never errors.
   */
  private ensureMemoryAccessColumn(): void {
    try {
      if (!this.tableExists('scheduled_tasks')) return;

      const columnsResult = this.db.exec('PRAGMA table_info(scheduled_tasks);');
      const columns = columnsResult[0]?.values.map((row) => String(row[1])) ?? [];

      if (!columns.includes('memory_access')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN memory_access TEXT');
        this.saveDb();
      }
    } catch (error) {
      console.warn('Failed to ensure scheduled task memory access column:', error);
    }
  }

  /**
   * Standing-conversation columns (2026-11-09): `session_mode` carries the
   * per-task session strategy (see SCHEDULED_TASK_SESSION_MODES) and
   * `series_session_id` the conversation a 'series' task currently continues
   * in. Schema only — no data backfill: legacy rows read as 'series' with no
   * series session, and the scheduler adopts the session of the task's latest
   * run at its next fire, so the first launch after upgrade does no extra work.
   * Idempotent: repeated startup never errors.
   */
  private ensureSessionSeriesColumns(): void {
    try {
      if (!this.tableExists('scheduled_tasks')) return;

      const columnsResult = this.db.exec('PRAGMA table_info(scheduled_tasks);');
      const columns = columnsResult[0]?.values.map((row) => String(row[1])) ?? [];
      let shouldSave = false;

      if (!columns.includes('session_mode')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN session_mode TEXT');
        shouldSave = true;
      }
      if (!columns.includes('series_session_id')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN series_session_id TEXT');
        shouldSave = true;
      }

      if (shouldSave) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('Failed to ensure scheduled task session series columns:', error);
    }
  }

  /**
   * `skip_reason` carries the enumerated reason for a `status = 'skipped'` run
   * (see SCHEDULED_TASK_SKIP_REASONS), so skipped executions are distinguishable
   * from success/error in the run ledger. Legacy rows keep NULL. Idempotent:
   * repeated startup never errors.
   */
  private ensureRunSkipReasonColumn(): void {
    try {
      if (!this.tableExists('scheduled_task_runs')) return;

      const columnsResult = this.db.exec('PRAGMA table_info(scheduled_task_runs);');
      const columns = columnsResult[0]?.values.map((row) => String(row[1])) ?? [];

      if (!columns.includes('skip_reason')) {
        this.db.run('ALTER TABLE scheduled_task_runs ADD COLUMN skip_reason TEXT');
        this.saveDb();
      }
    } catch (error) {
      console.warn('Failed to ensure scheduled task run skip reason column:', error);
    }
  }

  /**
   * Legacy columns from the retired SDK durable-cron migration (migration_status /
   * migrated_task_id). The SDK-cron feature was removed; the columns are only kept
   * so the schema is uniform and the one-time un-migration below can find its rows.
   * Idempotent: repeated startup never errors.
   */
  private ensureMigrationColumns(): void {
    try {
      if (!this.tableExists('scheduled_tasks')) return;

      const columnsResult = this.db.exec('PRAGMA table_info(scheduled_tasks);');
      const columns = columnsResult[0]?.values.map((row) => String(row[1])) ?? [];
      let shouldSave = false;

      if (!columns.includes('migration_status')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN migration_status TEXT');
        shouldSave = true;
      }
      if (!columns.includes('migrated_task_id')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN migrated_task_id TEXT');
        shouldSave = true;
      }

      if (shouldSave) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('Failed to ensure scheduled task migration columns:', error);
    }
  }

  /**
   * Lifecycle columns (2026-10-24): `origin` / `origin_session_id` /
   * `origin_context` record who created a task and from where (provenance —
   * a recurring task must never exist without a traceable birthplace);
   * `exit_condition` / `max_fires` / `fire_count` carry the death clause
   * (exit discipline — recurring tasks must be able to end). Legacy rows
   * keep NULL origin / NULL max_fires: no cap, no behavior change.
   * Idempotent: repeated startup never errors.
   */
  private ensureLifecycleColumns(): void {
    try {
      if (!this.tableExists('scheduled_tasks')) return;

      const columnsResult = this.db.exec('PRAGMA table_info(scheduled_tasks);');
      const columns = columnsResult[0]?.values.map((row) => String(row[1])) ?? [];
      let shouldSave = false;

      if (!columns.includes('origin')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN origin TEXT');
        shouldSave = true;
      }
      if (!columns.includes('origin_session_id')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN origin_session_id TEXT');
        shouldSave = true;
      }
      if (!columns.includes('origin_context')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN origin_context TEXT');
        shouldSave = true;
      }
      if (!columns.includes('exit_condition')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN exit_condition TEXT');
        shouldSave = true;
      }
      if (!columns.includes('max_fires')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN max_fires INTEGER');
        shouldSave = true;
      }
      if (!columns.includes('fire_count')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN fire_count INTEGER NOT NULL DEFAULT 0');
        shouldSave = true;
      }

      if (shouldSave) {
        this.saveDb();
      }
    } catch (error) {
      console.warn('Failed to ensure scheduled task lifecycle columns:', error);
    }
  }

  /**
   * One-time (idempotent) un-migration for the retired SDK durable-cron feature:
   * tasks migrated to SDK cron were disabled and marked migrated. With the SDK-cron
   * machinery gone, restore them as enabled host-scheduled tasks with a freshly
   * computed next run. No-op once no migrated rows remain.
   * @returns number of restored tasks.
   */
  private unmigrateLegacySdkCronTasks(): number {
    try {
      if (!this.tableExists('scheduled_tasks')) return 0;
      const rows = this.getAll<TaskRow>(
        `SELECT * FROM scheduled_tasks
         WHERE migration_status = 'migrated' OR migrated_task_id IS NOT NULL`
      );
      if (rows.length === 0) return 0;
      for (const row of rows) {
        let nextRunAtMs: number | null = null;
        try {
          const schedule = JSON.parse(row.schedule_json) as Schedule;
          nextRunAtMs = this.calculateNextRunTime(schedule, row.last_run_at_ms);
        } catch {
          nextRunAtMs = null;
        }
        this.db.run(
          `UPDATE scheduled_tasks
           SET migration_status = NULL, migrated_task_id = NULL,
               enabled = 1, next_run_at_ms = ?, updated_at = ?
           WHERE id = ?`,
          [nextRunAtMs, new Date().toISOString(), row.id]
        );
      }
      this.saveDb();
      console.log(`[ScheduledTaskStore] Restored ${rows.length} migrated task(s) to host scheduling`);
      return rows.length;
    } catch (error) {
      console.warn('Failed to un-migrate legacy SDK cron tasks:', error);
      return 0;
    }
  }

  private backfillMissingTaskSessionIdsFromRuns(): boolean {
    if (!this.tableExists('scheduled_task_runs')) return false;

    this.db.run(`
      UPDATE scheduled_tasks
      SET cowork_session_id = (
            SELECT r.session_id
            FROM scheduled_task_runs r
            WHERE r.task_id = scheduled_tasks.id
              AND r.session_id IS NOT NULL
              AND TRIM(r.session_id) != ''
            ORDER BY r.started_at DESC
            LIMIT 1
          ),
          updated_at = ?
      WHERE (cowork_session_id IS NULL OR TRIM(cowork_session_id) = '')
        AND EXISTS (
          SELECT 1
          FROM scheduled_task_runs r
          WHERE r.task_id = scheduled_tasks.id
            AND r.session_id IS NOT NULL
            AND TRIM(r.session_id) != ''
        )
    `, [new Date().toISOString()]);

    const modified = this.db.getRowsModified?.();
    return typeof modified === 'number' ? modified > 0 : true;
  }

  // --- Startup ---

  private resetStuckRunningTasks(): void {
    try {
      // Reset stuck runs
      this.db.run(`
        UPDATE scheduled_task_runs
        SET status = 'error',
            finished_at = ?,
            error = 'Application was closed during execution'
        WHERE status = 'running'
      `, [new Date().toISOString()]);

      // Reset stuck task states
      this.db.run(`
        UPDATE scheduled_tasks
        SET running_at_ms = NULL,
            last_status = 'error',
            last_error = 'Application was closed during execution'
        WHERE running_at_ms IS NOT NULL
      `);

      this.saveDb();
    } catch (error) {
      console.warn('Failed to reset stuck running tasks:', error);
    }
  }

  // --- Task CRUD ---

  listTasks(): ScheduledTask[] {
    const rows = this.getAll<TaskRow>(
      'SELECT * FROM scheduled_tasks ORDER BY created_at DESC'
    );
    return rows.map((row) => this.rowToTask(row));
  }

  getTask(id: string): ScheduledTask | null {
    const row = this.getOne<TaskRow>(
      'SELECT * FROM scheduled_tasks WHERE id = ?',
      [id]
    );
    return row ? this.rowToTask(row) : null;
  }

  createTask(input: ScheduledTaskInput): ScheduledTask {
    const id = uuidv4();
    const now = new Date().toISOString();
    const nextRunAtMs = input.enabled ? this.calculateNextRunTime(input.schedule, null) : null;

    this.db.run(`
      INSERT INTO scheduled_tasks
        (id, name, description, enabled, schedule_json, prompt,
         working_directory, system_prompt, execution_mode, metabot_id, cowork_session_id, target_session_id, session_mode, memory_access, expires_at,
         origin, origin_session_id, origin_context, exit_condition, max_fires, fire_count,
         notify_platforms_json, next_run_at_ms, consecutive_errors, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?)
    `, [
      id, input.name, input.description,
      input.enabled ? 1 : 0,
      JSON.stringify(input.schedule),
      input.prompt,
      input.workingDirectory, input.systemPrompt, resolveCoworkExecutionMode(input.executionMode),
      input.metabotId ?? null,
      normalizeTargetSessionId(input.targetSessionId),
      normalizeSessionMode(input.sessionMode),
      normalizeMemoryAccess(input.memoryAccess),
      input.expiresAt ?? null,
      input.origin ?? null,
      input.originSessionId ?? null,
      input.originContext ?? null,
      input.exitCondition ?? null,
      input.maxFires ?? null,
      JSON.stringify(input.notifyPlatforms ?? []),
      nextRunAtMs,
      now, now,
    ]);

    this.saveDb();
    return this.getTask(id)!;
  }

  updateTask(id: string, input: Partial<ScheduledTaskInput>): ScheduledTask | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const name = input.name ?? existing.name;
    const description = input.description ?? existing.description;
    const enabled = input.enabled ?? existing.enabled;
    const schedule = input.schedule ?? existing.schedule;
    const prompt = input.prompt ?? existing.prompt;
    const workingDirectory = input.workingDirectory ?? existing.workingDirectory;
    const systemPrompt = input.systemPrompt ?? existing.systemPrompt;
    const executionMode = resolveCoworkExecutionMode(input.executionMode ?? existing.executionMode);
    const metabotId = input.metabotId !== undefined ? input.metabotId : existing.metabotId;
    // Every session binding belongs to the previous bot: a bot change drops
    // them all (the standing conversation included — the new bot starts its own).
    const shouldResetSessionBindings = input.metabotId !== undefined && metabotId !== existing.metabotId;
    const targetSessionId = input.targetSessionId !== undefined
      ? normalizeTargetSessionId(input.targetSessionId)
      : existing.targetSessionId;
    // Switching the mode keeps the standing conversation pointer: a task moved
    // to 'fresh' and back resumes the same conversation instead of a new one.
    const sessionMode = input.sessionMode !== undefined
      ? normalizeSessionMode(input.sessionMode)
      : existing.sessionMode;
    // Only an explicitly provided value rewrites the opt-in; absent keeps the
    // stored one, and an invalid provided value normalizes to 'none'.
    const memoryAccess = input.memoryAccess !== undefined
      ? normalizeMemoryAccess(input.memoryAccess)
      : existing.memoryAccess;
    const expiresAt = input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt;
    const notifyPlatforms = input.notifyPlatforms !== undefined ? input.notifyPlatforms : existing.notifyPlatforms;
    const exitCondition = input.exitCondition !== undefined ? input.exitCondition : existing.exitCondition;
    const maxFires = input.maxFires !== undefined ? input.maxFires : existing.maxFires;

    // Re-enabling a disabled task is a deliberate renewal: the fire budget
    // resets so the task gets a fresh lifecycle. Editing an enabled task
    // leaves the counter alone.
    const isRenewal = !existing.enabled && enabled;
    const fireCount = isRenewal ? 0 : existing.fireCount;

    // Recalculate next run if schedule or enabled changed
    let nextRunAtMs = existing.state.nextRunAtMs;
    if (input.schedule !== undefined || input.enabled !== undefined) {
      nextRunAtMs = enabled
        ? this.calculateNextRunTime(schedule, existing.state.lastRunAtMs)
        : null;
    }

    this.db.run(`
      UPDATE scheduled_tasks
      SET name = ?, description = ?, enabled = ?, schedule_json = ?,
          prompt = ?, working_directory = ?, system_prompt = ?,
          execution_mode = ?, metabot_id = ?, expires_at = ?, notify_platforms_json = ?,
          next_run_at_ms = ?, cowork_session_id = ?, target_session_id = ?,
          session_mode = ?, series_session_id = ?, memory_access = ?,
          exit_condition = ?, max_fires = ?, fire_count = ?, updated_at = ?
      WHERE id = ?
    `, [
      name, description,
      enabled ? 1 : 0,
      JSON.stringify(schedule),
      prompt, workingDirectory,
      systemPrompt, executionMode,
      metabotId ?? null,
      expiresAt,
      JSON.stringify(notifyPlatforms),
      nextRunAtMs,
      shouldResetSessionBindings ? null : existing.coworkSessionId,
      shouldResetSessionBindings ? null : targetSessionId,
      sessionMode,
      shouldResetSessionBindings ? null : existing.seriesSessionId,
      memoryAccess,
      exitCondition,
      maxFires,
      fireCount,
      now, id,
    ]);

    this.saveDb();
    return this.getTask(id)!;
  }

  deleteTask(id: string): boolean {
    // Delete runs first (CASCADE may not work with sql.js)
    this.db.run('DELETE FROM scheduled_task_runs WHERE task_id = ?', [id]);
    this.db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  toggleTask(id: string, enabled: boolean): { task: ScheduledTask | null; warning: string | null } {
    const task = this.updateTask(id, { enabled });
    if (!task || !enabled) return { task, warning: null };

    const warning = this.validateTaskActivation(task);
    return { task, warning };
  }

  /**
   * Check if a task can meaningfully run after being enabled.
   * Returns a warning string if the task will never fire, null otherwise.
   */
  validateTaskActivation(task: ScheduledTask): string | null {
    const now = Date.now();
    const todayStr = new Date().toISOString().slice(0, 10);

    // Check: "at" type task with past datetime → will never fire
    if (task.schedule.type === 'at' && task.schedule.datetime) {
      const targetMs = new Date(task.schedule.datetime).getTime();
      if (targetMs <= now) {
        return 'TASK_AT_PAST';
      }
    }

    // Check: expiresAt is today or in the past → task expired
    if (task.expiresAt && task.expiresAt <= todayStr) {
      return 'TASK_EXPIRED';
    }

    return null;
  }

  // --- Task State Updates (called by Scheduler) ---

  /**
   * Unconditional variant, kept for compatibility. It is NOT the claim: it
   * overwrites whatever marker is already there, so two callers racing on the
   * same due task both "succeed". The scheduler's fire path uses
   * `tryMarkTaskRunning` instead.
   */
  markTaskRunning(id: string, runningAtMs: number): void {
    this.db.run(`
      UPDATE scheduled_tasks
      SET running_at_ms = ?, last_status = 'running', updated_at = ?
      WHERE id = ?
    `, [runningAtMs, new Date().toISOString(), id]);
    this.saveDb();
  }

  /**
   * Atomically claims the task for exactly one execution.
   *
   * The guarantee is entirely the `running_at_ms IS NULL` predicate inside the
   * UPDATE: SQLite serializes writers, so when two host processes sharing this
   * file both pass `getDueTasks` and both try to claim, exactly one UPDATE
   * matches a row — the loser writes nothing and cannot overwrite the winner's
   * marker. This is the claim; the in-process `activeTasks` map is only a fast
   * guard and says nothing about other processes.
   *
   * Returns whether THIS call won. `getRowsModified` is the authoritative
   * answer and both database wrappers expose it. Without a change counter the
   * marker is read back: that proves the row carries the value this call
   * intended, but it cannot separate a winner from a loser that computed the
   * same millisecond timestamp (the write itself is still atomic — only the
   * boolean is degraded, and only for wrappers without a counter).
   */
  tryMarkTaskRunning(id: string, runningAtMs: number): boolean {
    this.db.run(`
      UPDATE scheduled_tasks
      SET running_at_ms = ?, last_status = 'running', updated_at = ?
      WHERE id = ? AND running_at_ms IS NULL
    `, [runningAtMs, new Date().toISOString(), id]);

    // Read the counter before saveDb(): it describes the statement above, and
    // persisting may execute statements of its own.
    const modified = this.db.getRowsModified?.();
    this.saveDb();

    if (typeof modified === 'number') {
      return modified > 0;
    }

    const row = this.getOne<{ running_at_ms: number | null }>(
      'SELECT running_at_ms FROM scheduled_tasks WHERE id = ?',
      [id]
    );
    return row?.running_at_ms === runningAtMs;
  }

  /**
   * Refreshes the liveness clock of a run this process is executing. The
   * `running_at_ms IS NOT NULL` predicate is deliberate: a heartbeat must never
   * resurrect a marker that a sweep or the completion path already released.
   */
  touchTaskRunning(id: string, runningAtMs: number): void {
    this.db.run(`
      UPDATE scheduled_tasks
      SET running_at_ms = ?
      WHERE id = ? AND running_at_ms IS NOT NULL
    `, [runningAtMs, id]);
    this.saveDb();
  }

  markTaskCompleted(
    id: string,
    success: boolean,
    durationMs: number,
    error: string | null,
    schedule: Schedule
  ): void {
    const now = Date.now();
    const task = this.getTask(id);
    const consecutiveErrors = success ? 0 : (task?.state.consecutiveErrors ?? 0) + 1;
    // Every real execution (success or error, scheduled or manual) spends one
    // unit of the fire budget — an erroring loop is just as noisy as a
    // successful one. Skips never reach this method.
    const fireCount = (task?.fireCount ?? 0) + 1;
    const retired = task?.maxFires != null && fireCount >= task.maxFires;
    const nextRunAtMs = retired || !task?.enabled ? null : this.calculateNextRunTime(schedule, now);

    this.db.run(`
      UPDATE scheduled_tasks
      SET running_at_ms = NULL,
          last_run_at_ms = ?,
          last_status = ?,
          last_error = ?,
          last_duration_ms = ?,
          consecutive_errors = ?,
          next_run_at_ms = ?,
          fire_count = ?,
          enabled = CASE WHEN ? THEN 0 ELSE enabled END,
          updated_at = ?
      WHERE id = ?
    `, [
      now,
      retired ? 'max_fires_reached' : (success ? 'success' : 'error'),
      error,
      durationMs,
      consecutiveErrors,
      nextRunAtMs,
      fireCount,
      retired ? 1 : 0,
      new Date().toISOString(),
      id,
    ]);

    if (retired) {
      console.warn(
        `[ScheduledTaskStore] Task ${id} retired: fire budget exhausted (${fireCount}/${task?.maxFires}); auto-disabled`
      );
    }

    this.saveDb();
  }

  // --- Run History ---

  createRun(taskId: string, trigger: 'scheduled' | 'manual'): ScheduledTaskRun {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`
      INSERT INTO scheduled_task_runs (id, task_id, status, started_at, trigger_type)
      VALUES (?, ?, 'running', ?, ?)
    `, [id, taskId, now, trigger]);
    this.saveDb();
    return this.getRun(id)!;
  }

  /**
   * Ledger entry for an execution the scheduler decided NOT to run. A skipped
   * run is terminal the moment it is written (finished_at = started_at, zero
   * duration, no session): it never touched the task's success/error
   * bookkeeping, so this row is the only trace of the decision. `reason` is
   * required and enumerated, which is what makes skips queryable and
   * distinguishable from real runs (issue #60).
   */
  recordSkippedRun(
    taskId: string,
    reason: ScheduledTaskSkipReason,
    trigger: 'scheduled' | 'manual'
  ): ScheduledTaskRun {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(`
      INSERT INTO scheduled_task_runs
        (id, task_id, status, started_at, finished_at, duration_ms, error, trigger_type, skip_reason)
      VALUES (?, ?, 'skipped', ?, ?, 0, NULL, ?, ?)
    `, [id, taskId, now, now, trigger, reason]);
    this.saveDb();
    return this.getRun(id)!;
  }

  getTaskSessionId(taskId: string): string | null {
    const row = this.getOne<{ cowork_session_id: string | null }>(
      'SELECT cowork_session_id FROM scheduled_tasks WHERE id = ?',
      [taskId]
    );
    return row?.cowork_session_id ?? null;
  }

  setTaskSessionId(taskId: string, sessionId: string | null): void {
    this.db.run(`
      UPDATE scheduled_tasks
      SET cowork_session_id = ?, updated_at = ?
      WHERE id = ?
    `, [sessionId, new Date().toISOString(), taskId]);
    this.saveDb();
  }

  /**
   * Seat a 'series' task in its standing conversation (a freshly opened one,
   * a rotation successor, or the latest-run session adopted on a legacy
   * task's first fire after upgrade).
   */
  setSeriesSessionId(taskId: string, sessionId: string | null): void {
    this.db.run(`
      UPDATE scheduled_tasks
      SET series_session_id = ?, updated_at = ?
      WHERE id = ?
    `, [normalizeTargetSessionId(sessionId), new Date().toISOString(), taskId]);
    this.saveDb();
  }

  /**
   * Session of the task's most recent run that had one — the adoption
   * candidate for a 'series' task that has no standing conversation yet
   * (every legacy task on its first fire after upgrade). The in-flight run
   * has no session yet, so it never matches.
   */
  getLatestRunSessionId(taskId: string): string | null {
    const row = this.getOne<{ session_id: string | null }>(
      `SELECT session_id FROM scheduled_task_runs
       WHERE task_id = ? AND session_id IS NOT NULL AND TRIM(session_id) != ''
       ORDER BY started_at DESC, rowid DESC
       LIMIT 1`,
      [taskId]
    );
    return normalizeTargetSessionId(row?.session_id);
  }

  completeRun(
    runId: string,
    status: 'success' | 'error',
    sessionId: string | null,
    durationMs: number,
    error: string | null
  ): ScheduledTaskRun | null {
    const now = new Date().toISOString();
    this.db.run(`
      UPDATE scheduled_task_runs
      SET status = ?, session_id = ?, finished_at = ?, duration_ms = ?, error = ?
      WHERE id = ?
    `, [status, sessionId, now, durationMs, error, runId]);
    this.saveDb();
    return this.getRun(runId);
  }

  getRun(id: string): ScheduledTaskRun | null {
    const row = this.getOne<RunRow>(
      'SELECT * FROM scheduled_task_runs WHERE id = ?',
      [id]
    );
    return row ? this.rowToRun(row) : null;
  }

  listRuns(taskId: string, limit: number = 50, offset: number = 0): ScheduledTaskRun[] {
    const rows = this.getAll<RunRow>(
      'SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
      [taskId, limit, offset]
    );
    return rows.map((row) => this.rowToRun(row));
  }

  listAllRuns(limit: number = 50, offset: number = 0): (ScheduledTaskRun & { taskName: string })[] {
    const rows = this.getAll<RunRow & { task_name: string }>(
      `SELECT r.*, t.name as task_name
       FROM scheduled_task_runs r
       LEFT JOIN scheduled_tasks t ON r.task_id = t.id
       ORDER BY r.started_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return rows.map((row) => ({
      ...this.rowToRun(row),
      taskName: row.task_name ?? '',
    }));
  }

  countRuns(taskId: string): number {
    const row = this.getOne<{ 'COUNT(*)': number }>(
      'SELECT COUNT(*) FROM scheduled_task_runs WHERE task_id = ?',
      [taskId]
    );
    return row?.['COUNT(*)'] ?? 0;
  }

  pruneRuns(taskId: string, keepCount: number = 100): void {
    // Get IDs of the runs to keep
    const keepRows = this.getAll<{ id: string }>(
      'SELECT id FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?',
      [taskId, keepCount]
    );
    const keepIds = keepRows.map((r) => r.id);

    if (keepIds.length === 0) return;

    // Delete all runs not in the keep list
    const placeholders = keepIds.map(() => '?').join(',');
    this.db.run(
      `DELETE FROM scheduled_task_runs WHERE task_id = ? AND id NOT IN (${placeholders})`,
      [taskId, ...keepIds]
    );
    this.saveDb();
  }

  // --- Scheduler Queries ---

  getDueTasks(nowMs: number): ScheduledTask[] {
    const todayStr = new Date(nowMs).toISOString().slice(0, 10);
    const rows = this.getAll<TaskRow>(`
      SELECT * FROM scheduled_tasks
      WHERE enabled = 1
        AND next_run_at_ms IS NOT NULL
        AND next_run_at_ms <= ?
        AND running_at_ms IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND (max_fires IS NULL OR fire_count < max_fires)
      ORDER BY next_run_at_ms ASC
    `, [nowMs, todayStr]);
    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * Tasks whose `running_at_ms` marker is still set. The scheduler cross-checks
   * this against its in-memory active-task registry: a marker with no live
   * execution behind it is an orphaned run that `getDueTasks` would otherwise
   * filter out silently forever.
   */
  getRunningTasks(): ScheduledTask[] {
    const rows = this.getAll<TaskRow>(
      'SELECT * FROM scheduled_tasks WHERE running_at_ms IS NOT NULL ORDER BY running_at_ms ASC'
    );
    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * Releases an orphaned `running_at_ms` marker so the task can fire again.
   * Deliberately leaves last_status / last_error / consecutive_errors alone: a
   * released skip is a ledger event, not a task failure.
   */
  releaseStuckRunningTask(id: string): void {
    this.db.run(`
      UPDATE scheduled_tasks
      SET running_at_ms = NULL, updated_at = ?
      WHERE id = ? AND running_at_ms IS NOT NULL
    `, [new Date().toISOString(), id]);
    this.saveDb();
  }

  getNextDueTimeMs(): number | null {
    const todayStr = new Date().toISOString().slice(0, 10);
    const row = this.getOne<{ min_time: number | null }>(`
      SELECT MIN(next_run_at_ms) as min_time
      FROM scheduled_tasks
      WHERE enabled = 1
        AND next_run_at_ms IS NOT NULL
        AND running_at_ms IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND (max_fires IS NULL OR fire_count < max_fires)`,
      [todayStr]
    );
    return row?.min_time ?? null;
  }

  // --- Helpers ---

  calculateNextRunTime(schedule: Schedule, lastRunAtMs: number | null): number | null {
    const now = Date.now();

    switch (schedule.type) {
      case 'at': {
        if (!schedule.datetime) return null;
        const targetMs = new Date(schedule.datetime).getTime();
        return targetMs > now ? targetMs : null;
      }
      case 'interval': {
        const intervalMs = schedule.intervalMs ?? 60000;
        if (lastRunAtMs) {
          return Math.max(lastRunAtMs + intervalMs, now);
        }
        return now + intervalMs;
      }
      case 'cron': {
        if (!schedule.expression) return null;
        return this.getNextCronTime(schedule.expression, now);
      }
      default:
        return null;
    }
  }

  private getNextCronTime(expression: string, afterMs: number): number | null {
    try {
      const interval = CronExpressionParser.parse(expression, {
        currentDate: new Date(afterMs),
      });
      return interval.next().toDate().getTime();
    } catch {
      return null;
    }
  }

  private rowToTask(row: TaskRow): ScheduledTask {
    let notifyPlatforms: NotifyPlatform[] = [];
    try {
      notifyPlatforms = row.notify_platforms_json ? JSON.parse(row.notify_platforms_json) : [];
    } catch {
      notifyPlatforms = [];
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      schedule: JSON.parse(row.schedule_json),
      prompt: row.prompt,
      workingDirectory: row.working_directory,
      systemPrompt: row.system_prompt,
      executionMode: resolveCoworkExecutionMode(row.execution_mode),
      metabotId: row.metabot_id ?? null,
      coworkSessionId: row.cowork_session_id ?? null,
      targetSessionId: row.target_session_id ?? null,
      sessionMode: normalizeSessionMode(row.session_mode),
      seriesSessionId: normalizeTargetSessionId(row.series_session_id),
      memoryAccess: normalizeMemoryAccess(row.memory_access),
      expiresAt: row.expires_at,
      origin: (row.origin as TaskOrigin | null) ?? null,
      originSessionId: row.origin_session_id ?? null,
      originContext: row.origin_context ?? null,
      exitCondition: row.exit_condition ?? null,
      maxFires: row.max_fires ?? null,
      fireCount: row.fire_count ?? 0,
      notifyPlatforms,
      state: {
        nextRunAtMs: row.next_run_at_ms,
        lastRunAtMs: row.last_run_at_ms,
        lastStatus: row.last_status as TaskLastStatus,
        lastError: row.last_error,
        lastDurationMs: row.last_duration_ms,
        runningAtMs: row.running_at_ms,
        consecutiveErrors: row.consecutive_errors,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToRun(row: RunRow): ScheduledTaskRun {
    return {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      status: row.status as 'running' | 'success' | 'error',
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      error: row.error,
      trigger: row.trigger_type as 'scheduled' | 'manual',
      skipReason: (row.skip_reason as ScheduledTaskSkipReason | null) ?? null,
    };
  }
}
