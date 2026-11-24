import { v4 as uuidv4 } from 'uuid';
import type { SqliteDatabase as Database } from './sqliteTypes';
import type {
  LongTermActor,
  LongTermBadgeThresholds,
  LongTermBoard,
  LongTermColumn,
  LongTermEvent,
  LongTermEventKind,
  LongTermEvidence,
  LongTermManagedState,
  LongTermParticipant,
  LongTermPreferredChannel,
  LongTermProgress,
  LongTermQuickTaskCreateInput,
  LongTermReason,
  LongTermResult,
  LongTermSubtask,
  LongTermSubtaskDraft,
  LongTermSubtaskStatus,
  LongTermSubtaskUpdateInput,
  LongTermTaskCreateInput,
  LongTermTaskDetail,
  LongTermTaskKind,
  LongTermTaskStage,
  LongTermTaskSummary,
  LongTermTaskUpdateInput,
  TaskActiveRadarEntry,
  TaskDeliverableArtifact,
  TaskOriginChannel,
  TaskSearchOptions,
  TaskSessionLink,
  TaskSessionLinkRole,
  TaskWorkerSubmission,
  TaskWorkerSubmissionOutcome,
  UnifiedTaskCreateInput,
} from '../renderer/types/longTermTask';
import { LONG_TERM_COLUMN_ORDER } from '../renderer/types/longTermTask';

/** A task that reached a terminal stage, as consumed by the dream-brief reconciliation block. */
export interface LongTermResolvedTaskRef {
  id: string;
  title: string;
  stage: 'done' | 'cancelled';
  resolvedAtIso: string;
}

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
  lastAttentionResolution?: 'actioned' | 'resolved' | 'escalated';
  lastAttentionActionAtMs?: number;
  nextAttentionRetryAtMs?: number;
  attentionActionCount?: number;
  /** Timestamps of recent stale-wait convergence escalations (churn breaker). */
  convergenceAtMs?: number[];
  /**
   * Attention-driven escalation count for one subtask (resets when a
   * different subtask becomes current or the owner engages). Caps the
   * twin-re-dispatch retry cycle — a fresh failed attempt always produces a
   * new attention key, so without this counter the advance sweep could keep
   * buying supervision turns for a step that keeps failing.
   */
  attentionEscalation?: { subtaskId: string; count: number };
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

/**
 * One task-ledger mutation, emitted to `onTaskChanged` listeners.
 *
 * Broader than `onSubtaskStatusChange` on purpose: a Worker's
 * `ready_for_review` submission, a progress checkpoint, a task edit or a
 * stage move all change what the board / Live Stage HUD must show WITHOUT
 * flipping a subtask status. Subscribers therefore refresh on the ledger,
 * not on the next chat message that happens to persist.
 */
export interface LongTermTaskChange {
  taskId: string;
  /** null when the changed row is the task itself (create/update/stage). */
  subtaskId: string | null;
  entity: 'task' | 'subtask';
  /** Short machine reason, e.g. 'task_created' | 'subtask_submitted'. */
  reason: string;
}

export type LongTermTaskChangeListener = (change: LongTermTaskChange) => void;

/** Longest owner decision brief kept in `wait_note` on the proposal path. */
const WAIT_NOTE_MAX_CHARS = 4000;

/** Allowed evidence kinds (LongTermEvidence.kind) — anything else bypasses
 *  the per-kind URI shape checks and is refused. `dir` and `file` are local
 *  absolute paths; `file` names ONE produced file so it is recorded truthfully
 *  instead of being mislabelled `other`. */
const EVIDENCE_KINDS = ['dir', 'file', 'metaapp', 'metafile', 'pin', 'url', 'other'];

const ORIGIN_CHANNELS: readonly TaskOriginChannel[] = [
  'studio',
  'botworks',
  'mobile',
  'telegram',
  'im',
  'a2a',
  'schedule',
  'other',
];

const SESSION_LINK_ROLES: readonly TaskSessionLinkRole[] = [
  'origin',
  'discussion',
  'worker_exec',
  'supervision',
  'channel_bridge',
];

const SUBMISSION_OUTCOMES: readonly TaskWorkerSubmissionOutcome[] = [
  'ready_for_review',
  'blocked',
  'waiting_external',
  'failed',
];

/**
 * Configurable thresholds for the automatic `[长期]` (`isLongTerm`) badge:
 * 1) participating bots >= 3 (> 2 bots);
 * 2) total/max expected duration >= 1440 min (1 day);
 * 3) active open lifecycle span > 24h;
 * 4) multi-stage task tree with >= 4 non-skipped subtasks.
 */
export const DEFAULT_LONG_TERM_BADGE_THRESHOLDS: LongTermBadgeThresholds = {
  minParticipants: 3,
  minExpectedMinutes: 1440,
  minActiveAgeMs: 24 * 3_600_000,
  minMultiStageSubtasks: 4,
};

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

function parseJsonObject<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function asNullableInt(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

/**
 * Pure: compute whether a task carries the `[长期]` (`isLongTerm`) badge and why.
 * An explicit `override` (`true` / `false`) takes precedence over auto heuristics.
 */
export function deriveIsLongTerm(params: {
  override: boolean | null;
  participantCount: number;
  subtasks: LongTermSubtask[];
  stage: LongTermTaskStage;
  createdAtIso: string;
  doneAtIso?: string | null;
  nowMs?: number;
  thresholds?: LongTermBadgeThresholds;
}): { isLongTerm: boolean; reasons: LongTermReason[] } {
  const {
    override,
    participantCount,
    subtasks,
    stage,
    createdAtIso,
    doneAtIso,
    nowMs = Date.now(),
    thresholds = DEFAULT_LONG_TERM_BADGE_THRESHOLDS,
  } = params;

  if (override === true) {
    return { isLongTerm: true, reasons: ['manual'] };
  }
  if (override === false) {
    return { isLongTerm: false, reasons: [] };
  }

  const reasons: LongTermReason[] = [];
  if (participantCount >= thresholds.minParticipants) {
    reasons.push('participants');
  }

  const liveSubtasks = subtasks.filter((s) => s.status !== 'skipped');
  const summedExpected = liveSubtasks.reduce((sum, s) => sum + (s.expectedMinutes ?? 0), 0);
  if (summedExpected >= thresholds.minExpectedMinutes) {
    reasons.push('expected_duration');
  }

  const createdMs = Date.parse(createdAtIso);
  const endMs = stage === 'done' && doneAtIso ? Date.parse(doneAtIso) : nowMs;
  if (
    stage !== 'cancelled'
    && Number.isFinite(createdMs)
    && Number.isFinite(endMs)
    && endMs - createdMs >= thresholds.minActiveAgeMs
  ) {
    reasons.push('elapsed_span');
  }

  if (liveSubtasks.length >= thresholds.minMultiStageSubtasks) {
    reasons.push('multi_stage');
  }

  return { isLongTerm: reasons.length > 0, reasons };
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

/**
 * Pure: canonical 3-state live status exposed in Studio Chief-of-Staff mode.
 * Every open task maps strictly to `in_progress`, `waiting_external`, or
 * `waiting_owner`; terminal tasks (`done` / `cancelled`) map to `null`.
 */
export function deriveManagedState(
  stage: LongTermTaskStage,
  currentSubtaskStatus: LongTermSubtaskStatus | null,
): LongTermManagedState | null {
  if (stage === 'done' || stage === 'cancelled') return null;
  if (stage === 'defining' || stage === 'paused') return 'waiting_owner';
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
  task_kind?: string | null;
  is_long_term_override?: number | null;
  acceptance_delegate: number;
  current_subtask_id: string | null;
  parent_task_id?: string | null;
  definition_session_id: string | null;
  origin_session_id?: string | null;
  origin_message_id?: string | null;
  anchor_message_ids_json?: string | null;
  origin_channel?: string | null;
  intent_score_json?: string | null;
  plan_artifact_uri: string | null;
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
  assignee_metabot_id?: number | null;
  lease_attempt_id?: string | null;
  lease_claimed_at?: string | null;
  last_activity_at?: string | null;
  progress_note?: string | null;
  submission_json?: string | null;
  origin_session_id?: string | null;
  origin_message_id?: string | null;
  accepted_by: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
}

interface SessionLinkRow {
  task_id: string;
  session_id: string;
  subtask_id: string | null;
  role: string;
  channel: string | null;
  anchor_message_id: string | null;
  created_at: string;
  updated_at: string;
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
  private readonly badgeThresholds: LongTermBadgeThresholds;
  /** Status-transition subscribers (main wires the push broadcast here). */
  private readonly statusListeners = new Set<LongTermSubtaskStatusListener>();
  /** Ledger-change subscribers (main wires the Live Stage refresh here). */
  private readonly taskChangeListeners = new Set<LongTermTaskChangeListener>();

  constructor(
    db: Database,
    saveDb: () => void,
    options?: {
      resolveParticipants?: (ids: number[]) => LongTermParticipant[];
      badgeThresholds?: Partial<LongTermBadgeThresholds>;
    },
  ) {
    this.db = db;
    this.saveDb = saveDb;
    this.resolveParticipants = options?.resolveParticipants ?? ((ids) => ids.map((id) => ({ id, name: `#${id}`, avatar: null })));
    this.badgeThresholds = {
      ...DEFAULT_LONG_TERM_BADGE_THRESHOLDS,
      ...(options?.badgeThresholds ?? {}),
    };
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
   * Subscribe to EVERY ledger mutation that changes what the owner can see on
   * the board / Live Stage HUD — task create/update/stage moves, subtask
   * submit (all four outcomes), progress checkpoints, accepts and every other
   * status transition. Returns the unsubscribe function.
   *
   * `onSubtaskStatusChange` deliberately stays silent when a write leaves the
   * status alone (a `ready_for_review` submission keeps the subtask
   * `in_progress`); that silence is exactly the staleness this outlet fixes.
   */
  onTaskChanged(listener: LongTermTaskChangeListener): () => void {
    this.taskChangeListeners.add(listener);
    return () => {
      this.taskChangeListeners.delete(listener);
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
    this.emitTaskChanged(updated.taskId, updated.id, 'subtask', `subtask_${reason}`);
  }

  /**
   * Fire ledger-change listeners. Called by every mutation that changes what
   * the owner can see — including writes that leave the status alone
   * (submission, progress note, field edits, stage moves). A throwing
   * listener never breaks the mutation it was notified about.
   */
  private emitTaskChanged(taskId: string, subtaskId: string | null, entity: 'task' | 'subtask', reason: string): void {
    if (!taskId) return;
    const change: LongTermTaskChange = { taskId, subtaskId, entity, reason };
    for (const listener of [...this.taskChangeListeners]) {
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
        plan_artifact_uri TEXT,
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
    const taskColumns = this.getAll<{ name: unknown }>('PRAGMA table_info(long_term_tasks)').map((row) => String(row.name));
    // Plan-page traceability (feat/ltt-creation-flow): the visual plan page the
    // owner confirmed before `longterm_task_create` — local .html path or pin://.
    if (!taskColumns.includes('plan_artifact_uri')) {
      this.db.run('ALTER TABLE long_term_tasks ADD COLUMN plan_artifact_uri TEXT');
    }
    if (!taskColumns.includes('task_kind')) {
      this.db.run("ALTER TABLE long_term_tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'project'");
    }
    if (!taskColumns.includes('is_long_term_override')) {
      this.db.run('ALTER TABLE long_term_tasks ADD COLUMN is_long_term_override INTEGER');
    }
    if (!taskColumns.includes('origin_session_id')) {
      this.db.run('ALTER TABLE long_term_tasks ADD COLUMN origin_session_id TEXT');
    }
    if (!taskColumns.includes('origin_message_id')) {
      this.db.run('ALTER TABLE long_term_tasks ADD COLUMN origin_message_id TEXT');
    }
    if (!taskColumns.includes('anchor_message_ids_json')) {
      this.db.run("ALTER TABLE long_term_tasks ADD COLUMN anchor_message_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!taskColumns.includes('origin_channel')) {
      this.db.run('ALTER TABLE long_term_tasks ADD COLUMN origin_channel TEXT');
    }
    if (!taskColumns.includes('intent_score_json')) {
      this.db.run('ALTER TABLE long_term_tasks ADD COLUMN intent_score_json TEXT');
    }
    if (!taskColumns.includes('parent_task_id')) {
      this.db.run('ALTER TABLE long_term_tasks ADD COLUMN parent_task_id TEXT');
    }
    this.db.run('CREATE INDEX IF NOT EXISTS idx_long_term_tasks_parent ON long_term_tasks(parent_task_id)');
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
    if (!subtaskColumns.includes('assignee_metabot_id')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN assignee_metabot_id INTEGER');
    }
    if (!subtaskColumns.includes('lease_attempt_id')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN lease_attempt_id TEXT');
    }
    if (!subtaskColumns.includes('lease_claimed_at')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN lease_claimed_at TEXT');
    }
    if (!subtaskColumns.includes('last_activity_at')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN last_activity_at TEXT');
    }
    if (!subtaskColumns.includes('progress_note')) {
      this.db.run("ALTER TABLE long_term_subtasks ADD COLUMN progress_note TEXT NOT NULL DEFAULT ''");
    }
    if (!subtaskColumns.includes('submission_json')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN submission_json TEXT');
    }
    if (!subtaskColumns.includes('origin_session_id')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN origin_session_id TEXT');
    }
    if (!subtaskColumns.includes('origin_message_id')) {
      this.db.run('ALTER TABLE long_term_subtasks ADD COLUMN origin_message_id TEXT');
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_session_links (
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        subtask_id TEXT,
        role TEXT NOT NULL DEFAULT 'discussion',
        channel TEXT,
        anchor_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_session_links_session
        ON task_session_links(session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_session_links_task
        ON task_session_links(task_id, updated_at DESC);
    `);
    this.backfillStudioDecisionParentHierarchy();
    this.saveDb();
  }

  /**
   * Resolve the root parent task id (`ltt_...`) for `candidateParentId` (cycle-guarded,
   * flattened to 1-level parent-child depth so grandchild revisions like v3
   * spawned from v2 stay indented cleanly under the original root task).
   */
  resolveRootParentTaskId(candidateParentId: string | null | undefined, selfTaskId?: string | null): string | null {
    let cur = asText(candidateParentId ?? '').trim();
    if (!cur || (selfTaskId && cur === selfTaskId)) return null;
    const seen = new Set<string>(selfTaskId ? [selfTaskId] : []);
    for (let depth = 0; depth < 8; depth += 1) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const row = this.getOne<{ id: string; parent_task_id?: string | null }>(
        'SELECT id, parent_task_id FROM long_term_tasks WHERE id = ?',
        [cur],
      );
      if (!row) return null;
      const next = asText(row.parent_task_id ?? '').trim();
      if (!next || seen.has(next)) {
        return row.id;
      }
      cur = next;
    }
    return cur || null;
  }

  setTaskParent(taskId: string, parentTaskId: string | null): boolean {
    const tid = asText(taskId).trim();
    if (!tid) return false;
    const rootParent = parentTaskId ? this.resolveRootParentTaskId(parentTaskId, tid) : null;
    this.db.run(
      'UPDATE long_term_tasks SET parent_task_id = ?, updated_at = ? WHERE id = ?',
      [rootParent, nowIso(), tid],
    );
    const modified = (this.db as unknown as { getRowsModified?: () => number }).getRowsModified?.() ?? 1;
    if (modified > 0) {
      this.saveDb();
      this.emitTaskChanged(tid, null, 'task', 'task_reparented');
    }
    return modified > 0;
  }

  /**
   * When a new follow-up/rework child task (e.g. v3) is created for `workerMetabotId`
   * under `parentTaskId`, settle any older active 1-subtask `quick` sibling child
   * assigned to the SAME Worker whose work was already submitted (e.g. v2) so
   * superseded intermediate revisions never linger as zombie active cards.
   */
  supersedeCompletedWorkerSiblingChildren(params: {
    parentTaskId: string;
    newChildTaskId: string;
    workerMetabotId: number;
    hasActiveAttemptForTask?: (taskId: string) => boolean;
  }): string[] {
    const { parentTaskId, newChildTaskId, workerMetabotId, hasActiveAttemptForTask } = params;
    if (!parentTaskId || !newChildTaskId) return [];
    const siblings = this.getAll<TaskRow>(
      "SELECT * FROM long_term_tasks WHERE parent_task_id = ? AND id != ? AND task_kind = 'quick' AND stage = 'active'",
      [parentTaskId, newChildTaskId],
    );
    const closed: string[] = [];
    const now = nowIso();
    for (const sib of siblings) {
      if (hasActiveAttemptForTask?.(sib.id)) continue;
      const subs = this.listSubtaskRows(sib.id);
      if (subs.length !== 1) continue;
      const sub = subs[0];
      if (asNullableInt(sub.assignee_metabot_id) !== workerMetabotId) continue;
      // Only supersede if the prior Worker run already submitted or finished
      const hasSubmission = Boolean((sub.submission_json ?? '').trim() || (sub.progress_note ?? '').startsWith('submitted'));
      if (!hasSubmission) continue;
      this.db.run(
        "UPDATE long_term_subtasks SET status = 'accepted', accepted_by = 'twin', accepted_at = ?, updated_at = ? WHERE id = ?",
        [now, now, sub.id],
      );
      this.db.run(
        "UPDATE long_term_tasks SET stage = 'done', done_at = ?, current_subtask_id = NULL, updated_at = ? WHERE id = ?",
        [now, now, sib.id],
      );
      this.addEvent(sib.id, sub.id, 'completed', 'twin', `Superseded by follow-up child task ${newChildTaskId}`);
      closed.push(sib.id);
    }
    if (closed.length > 0) this.saveDb();
    for (const closedTaskId of closed) {
      this.emitTaskChanged(closedTaskId, null, 'task', 'task_superseded');
    }
    return closed;
  }

  /**
   * Idempotent one-time backfill (`task_parent_hierarchy_backfill_v1`): links
   * existing unparented Studio `quick` tasks created immediately (<= 3 min)
   * after resolving a `studio_decision_queue` item back to that item's root
   * `longterm_task_id`, and settles superseded intermediate revisions.
   */
  private backfillStudioDecisionParentHierarchy(): void {
    try {
      const hasKv = this.getAll<{ name: unknown }>("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").length > 0;
      const hasQueue = this.getAll<{ name: unknown }>("SELECT name FROM sqlite_master WHERE type='table' AND name='studio_decision_queue'").length > 0;
      if (!hasKv || !hasQueue) return;
      const migKey = 'task_parent_hierarchy_backfill_v1';
      const done = this.getOne<{ value?: string }>('SELECT value FROM kv WHERE key = ? LIMIT 1', [migKey]);
      if (done?.value === '1') return;

      const resolvedItems = this.getAll<{ longterm_task_id?: string | null; updated_at?: string | null }>(
        "SELECT longterm_task_id, updated_at FROM studio_decision_queue WHERE status = 'resolved' AND longterm_task_id IS NOT NULL ORDER BY updated_at ASC",
      );
      const quickTasks = this.getAll<TaskRow>(
        "SELECT * FROM long_term_tasks WHERE task_kind = 'quick' AND (parent_task_id IS NULL OR parent_task_id = '') ORDER BY created_at ASC",
      );

      for (const qt of quickTasks) {
        const createdMs = Date.parse(qt.created_at);
        if (!Number.isFinite(createdMs)) continue;
        let matchedParent: string | null = null;
        for (const item of resolvedItems) {
          const ltId = asText(item.longterm_task_id ?? '').trim();
          const resolvedMs = Date.parse(asText(item.updated_at ?? ''));
          if (!ltId || ltId === qt.id || !Number.isFinite(resolvedMs)) continue;
          const delta = createdMs - resolvedMs;
          if (delta >= -2_000 && delta <= 3 * 60_000) {
            matchedParent = this.resolveRootParentTaskId(ltId, qt.id);
          }
        }
        if (matchedParent) {
          this.db.run('UPDATE long_term_tasks SET parent_task_id = ? WHERE id = ?', [matchedParent, qt.id]);
          const subs = this.listSubtaskRows(qt.id);
          const workerId = subs.length === 1 ? asNullableInt(subs[0].assignee_metabot_id) : null;
          if (workerId != null && qt.stage === 'active') {
            this.supersedeCompletedWorkerSiblingChildren({
              parentTaskId: matchedParent,
              newChildTaskId: qt.id,
              workerMetabotId: workerId,
            });
          }
        }
      }

      this.db.run(
        'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [migKey, '1', Date.now()],
      );
    } catch {
      // Best-effort backfill; never block store boot.
    }
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
    const taskKind: LongTermTaskKind = row.task_kind === 'quick' ? 'quick' : 'project';
    const isLongTermOverride =
      row.is_long_term_override === 1 ? true : row.is_long_term_override === 0 ? false : null;
    const originChannel = ORIGIN_CHANNELS.includes(row.origin_channel as TaskOriginChannel)
      ? (row.origin_channel as TaskOriginChannel)
      : null;
    const definitionSessionId = row.definition_session_id ?? null;
    const parentTaskId = (row.parent_task_id ?? '').trim() || null;
    const originSessionId = (row.origin_session_id ?? '').trim() || definitionSessionId;
    const originMessageId = (row.origin_message_id ?? '').trim() || null;
    const anchorMessageIds = (() => {
      const list = parseJsonArray<string>(row.anchor_message_ids_json);
      if (originMessageId && !list.includes(originMessageId)) {
        return [originMessageId, ...list];
      }
      return list;
    })();
    return {
      id: row.id,
      title: row.title,
      goal: row.goal,
      stage: row.stage,
      taskKind,
      isLongTermOverride,
      acceptanceDelegate: row.acceptance_delegate === 1,
      currentSubtaskIdPinned: row.current_subtask_id ?? null,
      parentTaskId: parentTaskId && parentTaskId !== row.id ? parentTaskId : null,
      definitionSessionId,
      originSessionId,
      originMessageId,
      anchorMessageIds,
      originChannel,
      planArtifactUri: row.plan_artifact_uri ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at ?? null,
    };
  }

  private mapSubtask(row: SubtaskRow): LongTermSubtask {
    const assigneeMetabotId = asNullableInt(row.assignee_metabot_id);
    const submission = parseJsonObject<TaskWorkerSubmission>(row.submission_json);
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
      assigneeMetabotId,
      leaseAttemptId: (row.lease_attempt_id ?? '').trim() || null,
      leaseClaimedAt: (row.lease_claimed_at ?? '').trim() || null,
      lastActivityAt: (row.last_activity_at ?? '').trim() || null,
      progressNote: row.progress_note ?? '',
      submission,
      originSessionId: (row.origin_session_id ?? '').trim() || null,
      originMessageId: (row.origin_message_id ?? '').trim() || null,
      acceptedBy: row.accepted_by === 'owner' || row.accepted_by === 'twin' ? row.accepted_by : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acceptedAt: row.accepted_at ?? null,
    };
  }

  private mapSessionLink(row: SessionLinkRow): TaskSessionLink {
    const role: TaskSessionLinkRole = SESSION_LINK_ROLES.includes(row.role as TaskSessionLinkRole)
      ? (row.role as TaskSessionLinkRole)
      : 'discussion';
    const channel: TaskOriginChannel | null = ORIGIN_CHANNELS.includes(row.channel as TaskOriginChannel)
      ? (row.channel as TaskOriginChannel)
      : null;
    return {
      taskId: row.task_id,
      sessionId: row.session_id,
      subtaskId: row.subtask_id ?? null,
      role,
      channel,
      anchorMessageId: row.anchor_message_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
    const managedState = deriveManagedState(task.stage, current?.status ?? null);
    const counts = Object.fromEntries(SUBTASK_STATUSES.map((s) => [s, 0])) as Record<LongTermSubtaskStatus, number>;
    for (const subtask of subtasks) counts[subtask.status] += 1;
    const participantIds = this.listParticipantIds(taskRow, subtasks);
    const participants = this.resolveParticipants(participantIds);
    const badge = deriveIsLongTerm({
      override: task.isLongTermOverride,
      participantCount: participants.length,
      subtasks,
      stage: task.stage,
      createdAtIso: task.createdAt,
      doneAtIso: task.doneAt,
      thresholds: this.badgeThresholds,
    });
    const parentRow = task.parentTaskId
      ? this.getOne<{ id: string; title: string }>('SELECT id, title FROM long_term_tasks WHERE id = ?', [task.parentTaskId])
      : null;
    return {
      id: task.id,
      title: task.title,
      goal: task.goal,
      stage: task.stage,
      column: column ?? 'done',
      taskKind: task.taskKind,
      isLongTerm: badge.isLongTerm,
      longTermReasons: badge.reasons,
      isLongTermOverride: task.isLongTermOverride,
      managedState,
      acceptanceDelegate: task.acceptanceDelegate,
      planArtifactUri: task.planArtifactUri,
      parentTaskId: parentRow?.id ?? null,
      parentTaskTitle: parentRow?.title ?? null,
      originSessionId: task.originSessionId,
      originMessageId: task.originMessageId,
      anchorMessageIds: task.anchorMessageIds,
      originChannel: task.originChannel,
      currentSubtaskId: current?.id ?? null,
      currentSubtaskTitle: current?.title ?? null,
      currentSubtaskStatus: current?.status ?? null,
      currentAssigneeMetabotId: current?.assigneeMetabotId ?? null,
      currentProgressNote: current && current.progressNote ? current.progressNote : null,
      currentLastActivityAt: current?.lastActivityAt ?? null,
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
      participants,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      doneAt: task.doneAt,
    };
  }

  /**
   * Participating bots, derived read-time from the task's sessions + explicit
   * subtask assignees: the bot that ran each bound/linked session ∪ explicit
   * subtask assignees ∪ workers delegated from those sessions ∪ group-task members.
   */
  private listParticipantIds(taskRow: TaskRow, subtasks: LongTermSubtask[]): number[] {
    const ids = new Set<number>();
    for (const sub of subtasks) {
      if (typeof sub.assigneeMetabotId === 'number' && Number.isFinite(sub.assigneeMetabotId)) {
        ids.add(sub.assigneeMetabotId);
      }
      if (sub.submission && Number.isFinite(sub.submission.workerMetabotId) && sub.submission.workerMetabotId > 0) {
        ids.add(sub.submission.workerMetabotId);
      }
    }
    let hasLongTermLinkageCol = false;
    let linkedOrchAssignees: Array<{ id: unknown }> = [];
    try {
      const cols = this.getAll<{ name: unknown }>('PRAGMA table_info(orchestration_tasks)');
      hasLongTermLinkageCol = cols.some((col) => String(col.name) === 'longterm_task_id');
      if (hasLongTermLinkageCol) {
        linkedOrchAssignees = this.getAll<{ id: unknown }>(
          `SELECT DISTINCT s.assignee_metabot_id AS id
             FROM orchestration_steps s
             JOIN orchestration_tasks t ON t.id = s.task_id
            WHERE t.longterm_task_id = ? AND s.assignee_metabot_id IS NOT NULL`,
          [taskRow.id],
        );
        for (const row of linkedOrchAssignees) {
          const id = Number(row.id);
          if (Number.isFinite(id)) ids.add(id);
        }
      }
    } catch {
      hasLongTermLinkageCol = false;
    }
    const linkedSessionIds = this.getAll<{ session_id: unknown }>(
      'SELECT session_id FROM task_session_links WHERE task_id = ?',
      [taskRow.id],
    )
      .map((r) => asText(r.session_id).trim())
      .filter(Boolean);
    const sessionIds = [
      ...new Set(
        [
          taskRow.definition_session_id,
          taskRow.origin_session_id,
          ...subtasks.map((sub) => sub.sessionId),
          ...linkedSessionIds,
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    if (sessionIds.length === 0) return [...ids].sort((a, b) => a - b);
    const placeholders = sessionIds.map(() => '?').join(',');
    const collect = (sql: string) => {
      for (const row of this.getAll<{ id: unknown }>(sql, sessionIds)) {
        const id = Number(row.id);
        if (Number.isFinite(id)) ids.add(id);
      }
    };
    collect(`SELECT DISTINCT metabot_id AS id FROM cowork_sessions WHERE id IN (${placeholders}) AND metabot_id IS NOT NULL`);
    if (!hasLongTermLinkageCol) {
      collect(`SELECT DISTINCT s.assignee_metabot_id AS id FROM orchestration_steps s
               JOIN orchestration_tasks t ON t.id = s.task_id
               WHERE t.source_session_id IN (${placeholders}) AND s.assignee_metabot_id IS NOT NULL`);
    } else if (linkedOrchAssignees.length === 0) {
      collect(`SELECT DISTINCT s.assignee_metabot_id AS id FROM orchestration_steps s
               JOIN orchestration_tasks t ON t.id = s.task_id
               WHERE t.longterm_task_id IS NULL AND t.source_session_id IN (${placeholders}) AND s.assignee_metabot_id IS NOT NULL`);
    }
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
    const taskKind: LongTermTaskKind = input.taskKind === 'quick' ? 'quick' : 'project';
    const originSessionId = asText(input.originSessionId ?? input.definitionSessionId ?? '').trim() || null;
    const definitionSessionId = asText(input.definitionSessionId ?? originSessionId ?? '').trim() || null;
    const originMessageId = asText(input.originMessageId ?? '').trim() || null;
    const anchorIds = Array.from(
      new Set([
        ...(originMessageId ? [originMessageId] : []),
        ...(input.anchorMessageIds ?? []).map((m) => asText(m).trim()).filter(Boolean),
      ]),
    );
    const originChannel = ORIGIN_CHANNELS.includes(input.originChannel as TaskOriginChannel)
      ? (input.originChannel as TaskOriginChannel)
      : null;
    const isLongTermOverride =
      input.isLongTerm === true ? 1 : input.isLongTerm === false ? 0 : null;
    const intentScoreJson =
      input.intentScore !== undefined && input.intentScore !== null
        ? JSON.stringify(input.intentScore)
        : null;
    this.db.run(
      `INSERT INTO long_term_tasks (id, title, goal, stage, task_kind, is_long_term_override, acceptance_delegate, definition_session_id, origin_session_id, origin_message_id, anchor_message_ids_json, origin_channel, intent_score_json, plan_artifact_uri, created_at, updated_at)
       VALUES (?, ?, ?, 'defining', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        title,
        goal,
        taskKind,
        isLongTermOverride,
        definitionSessionId,
        originSessionId,
        originMessageId,
        JSON.stringify(anchorIds),
        originChannel,
        intentScoreJson,
        asText(input.planArtifactUri ?? '').trim() || null,
        now,
        now,
      ],
    );
    drafts.forEach((draft, index) => {
      const dependsOn = (draft.dependsOnOrdinals ?? []).map((ordinal) => subtaskIds[ordinal - 1]);
      this.db.run(
        `INSERT INTO long_term_subtasks
         (id, task_id, ordinal, title, description, acceptance_criteria_json, status, depends_on_json, preferred_channel, notes, expected_minutes, assignee_metabot_id, origin_session_id, origin_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          asNullableInt(draft.assigneeMetabotId),
          originSessionId,
          originMessageId,
          now,
          now,
        ],
      );
    });
    if (originSessionId) {
      this.upsertSessionLinkRow(taskId, originSessionId, {
        role: 'origin',
        channel: originChannel,
        anchorMessageId: originMessageId,
      }, now);
    }
    if (definitionSessionId && definitionSessionId !== originSessionId) {
      this.upsertSessionLinkRow(taskId, definitionSessionId, {
        role: 'discussion',
        channel: originChannel,
      }, now);
    }
    this.addEvent(taskId, null, 'created', actor, `created as draft with ${drafts.length} sub-project(s): ${title}`);
    this.saveDb();
    this.emitTaskChanged(taskId, null, 'task', 'task_created');
    const detail = this.getTask(taskId);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'creation failed' };
  }

  /**
   * Create a lightweight single-step active task (`task_kind = 'quick'`) whose
   * sole subtask begins immediately (`in_progress`). Used in Studio mode so
   * clear, bounded 1-step deliverables enter the same unified Managed Task Tree
   * without multi-round interrogation overhead.
   */
  createQuickTask(
    input: LongTermQuickTaskCreateInput,
    actor: LongTermActor,
  ): LongTermResult<LongTermTaskDetail> {
    return this.createUnifiedTask(
      {
        title: input.title,
        goal: input.goal,
        acceptanceCriteria: input.acceptanceCriteria,
        preferredChannel: input.preferredChannel,
        expectedMinutes: input.expectedMinutes,
        subtasks: [
          {
            title: input.title,
            description: input.goal ?? input.title,
            acceptanceCriteria: input.acceptanceCriteria ?? [],
            preferredChannel: input.preferredChannel ?? 'delegate_bot',
            expectedMinutes: input.expectedMinutes,
            assigneeMetabotId: input.assigneeMetabotId ?? null,
          },
        ],
        activateImmediately: true,
        isLongTerm: input.isLongTerm,
        parentTaskId: input.parentTaskId ?? null,
        definitionSessionId: input.definitionSessionId,
        originSessionId: input.originSessionId ?? input.definitionSessionId,
        originMessageId: input.originMessageId,
        anchorMessageIds: input.anchorMessageIds,
        originChannel: input.originChannel,
        intentScore: input.intentScore,
      },
      actor,
      'quick',
    );
  }

  /**
   * Unified first-class Task creator: handles both 1-step deliverables and
   * multi-subtask serial/parallel DAG decompositions in a single model.
   * When `activateImmediately` is true (default), the task enters `active`
   * immediately and begins all dependency-free subtasks (`dependsOn.length === 0`)
   * so the Studio bottom-right HUD mounts the task right away.
   */
  createUnifiedTask(
    input: UnifiedTaskCreateInput,
    actor: LongTermActor,
    explicitKind?: LongTermTaskKind,
  ): LongTermResult<LongTermTaskDetail> {
    const title = asText(input.title).trim();
    const goal = asText(input.goal ?? input.title).trim();
    if (!title) {
      return { ok: false, code: 'VALIDATION', error: 'title is required' };
    }
    const defaultChannel: LongTermPreferredChannel =
      input.preferredChannel && CHANNELS.includes(input.preferredChannel)
        ? input.preferredChannel
        : 'delegate_bot';
    const drafts: LongTermSubtaskDraft[] =
      Array.isArray(input.subtasks) && input.subtasks.length > 0
        ? input.subtasks
        : [
            {
              title,
              description: goal,
              acceptanceCriteria: input.acceptanceCriteria ?? [],
              preferredChannel: defaultChannel,
              expectedMinutes: input.expectedMinutes,
            },
          ];

    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      if (!asText(draft.title).trim()) {
        return { ok: false, code: 'VALIDATION', error: `subtask #${index + 1} has no title` };
      }
      for (const ordinal of draft.dependsOnOrdinals ?? []) {
        if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > drafts.length || ordinal === index + 1) {
          return { ok: false, code: 'VALIDATION', error: `subtask #${index + 1} has an invalid dependsOn ordinal ${ordinal}` };
        }
      }
    }

    const activateImmediately = input.activateImmediately !== false;
    const taskId = `ltt_${uuidv4()}`;
    const subtaskIds = drafts.map(() => `lts_${uuidv4()}`);
    // Cycle check across the draft DAG before inserting.
    const depMap = new Map<string, string[]>();
    drafts.forEach((draft, idx) => {
      depMap.set(
        subtaskIds[idx],
        (draft.dependsOnOrdinals ?? []).map((ord) => subtaskIds[ord - 1]),
      );
    });
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (nodeId: string): boolean => {
      if (visited.has(nodeId)) return false;
      if (visiting.has(nodeId)) return true;
      visiting.add(nodeId);
      for (const dep of depMap.get(nodeId) ?? []) {
        if (hasCycle(dep)) return true;
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
      return false;
    };
    for (const id of subtaskIds) {
      if (hasCycle(id)) {
        return { ok: false, code: 'VALIDATION', error: 'dependency cycle detected in subtasks' };
      }
    }

    const now = nowIso();
    const taskKind: LongTermTaskKind =
      explicitKind ?? (drafts.length === 1 && activateImmediately ? 'quick' : 'project');
    const stage: LongTermTaskStage = activateImmediately ? 'active' : 'defining';
    const originSessionId = asText(input.originSessionId ?? input.definitionSessionId ?? '').trim() || null;
    const definitionSessionId = asText(input.definitionSessionId ?? originSessionId ?? '').trim() || null;
    const originMessageId = asText(input.originMessageId ?? '').trim() || null;
    const anchorIds = Array.from(
      new Set([
        ...(originMessageId ? [originMessageId] : []),
        ...(input.anchorMessageIds ?? []).map((m) => asText(m).trim()).filter(Boolean),
      ]),
    );
    const originChannel = ORIGIN_CHANNELS.includes(input.originChannel as TaskOriginChannel)
      ? (input.originChannel as TaskOriginChannel)
      : null;
    const isLongTermOverride =
      input.isLongTerm === true ? 1 : input.isLongTerm === false ? 0 : null;
    const parentTaskId = this.resolveRootParentTaskId(input.parentTaskId ?? null);
    const intentScoreJson =
      input.intentScore !== undefined && input.intentScore !== null
        ? JSON.stringify(input.intentScore)
        : null;

    const initialBegunIds: string[] = [];
    if (activateImmediately) {
      drafts.forEach((draft, idx) => {
        if ((draft.dependsOnOrdinals ?? []).length === 0) {
          initialBegunIds.push(subtaskIds[idx]);
        }
      });
    }
    const pinnedSubtaskId = initialBegunIds[0] ?? null;

    this.db.run(
      `INSERT INTO long_term_tasks (id, title, goal, stage, task_kind, is_long_term_override, acceptance_delegate, current_subtask_id, parent_task_id, definition_session_id, origin_session_id, origin_message_id, anchor_message_ids_json, origin_channel, intent_score_json, plan_artifact_uri, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        title,
        goal,
        stage,
        taskKind,
        isLongTermOverride,
        pinnedSubtaskId,
        parentTaskId,
        definitionSessionId,
        originSessionId,
        originMessageId,
        JSON.stringify(anchorIds),
        originChannel,
        intentScoreJson,
        asText(input.planArtifactUri ?? '').trim() || null,
        now,
        now,
      ],
    );

    const begunSet = new Set(initialBegunIds);
    drafts.forEach((draft, index) => {
      const subId = subtaskIds[index];
      const dependsOn = depMap.get(subId) ?? [];
      const isBegun = begunSet.has(subId);
      const channel =
        draft.preferredChannel && CHANNELS.includes(draft.preferredChannel)
          ? draft.preferredChannel
          : drafts.length === 1
            ? defaultChannel
            : null;
      this.db.run(
        `INSERT INTO long_term_subtasks
         (id, task_id, ordinal, title, description, acceptance_criteria_json, status, depends_on_json, preferred_channel, notes, expected_minutes, assignee_metabot_id, last_activity_at, origin_session_id, origin_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          subId,
          taskId,
          index + 1,
          asText(draft.title).trim(),
          asText(draft.description ?? (drafts.length === 1 ? goal : '')),
          JSON.stringify(draft.acceptanceCriteria ?? (drafts.length === 1 ? input.acceptanceCriteria ?? [] : [])),
          isBegun ? 'in_progress' : 'pending',
          JSON.stringify(dependsOn),
          channel,
          asText(draft.notes ?? ''),
          asExpectedMinutes(draft.expectedMinutes ?? (drafts.length === 1 ? input.expectedMinutes : undefined)),
          asNullableInt(draft.assigneeMetabotId),
          isBegun ? now : null,
          originSessionId,
          originMessageId,
          now,
          now,
        ],
      );
    });

    if (originSessionId) {
      this.upsertSessionLinkRow(taskId, originSessionId, {
        role: 'origin',
        channel: originChannel,
        anchorMessageId: originMessageId,
      }, now);
    }
    if (definitionSessionId && definitionSessionId !== originSessionId) {
      this.upsertSessionLinkRow(taskId, definitionSessionId, {
        role: 'discussion',
        channel: originChannel,
      }, now);
    }

    this.addEvent(
      taskId,
      initialBegunIds.length === 1 ? initialBegunIds[0] : null,
      'created',
      actor,
      activateImmediately
        ? `${taskKind === 'quick' ? 'quick ' : ''}task created and activated (${drafts.length} subtask(s)): ${title}`
        : `created as draft with ${drafts.length} sub-project(s): ${title}`,
    );
    for (const begunId of initialBegunIds) {
      const begunSub = this.getSubtask(begunId);
      this.addEvent(
        taskId,
        begunId,
        'began',
        actor,
        `began subtask #${begunSub?.ordinal ?? 1} on channel ${begunSub?.preferredChannel ?? 'undecided'}`,
      );
    }
    this.saveDb();
    for (const begunId of initialBegunIds) {
      this.emitStatusChange(null, this.getSubtask(begunId), 'began');
    }
    this.emitTaskChanged(taskId, null, 'task', 'task_created');
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
    this.emitTaskChanged(taskId, null, 'task', 'task_activated');
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
    this.emitTaskChanged(taskId, null, 'task', 'task_paused');
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
    this.emitTaskChanged(taskId, null, 'task', 'task_cancelled');
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
        "UPDATE long_term_subtasks SET status = 'skipped', wait_note = '', wait_until = NULL, lease_attempt_id = NULL, lease_claimed_at = NULL, updated_at = ? WHERE id = ?",
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
    this.emitTaskChanged(taskId, null, 'task', 'task_completed');
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
    if (input.isLongTerm !== undefined) {
      const nextOverride = input.isLongTerm === true ? 1 : input.isLongTerm === false ? 0 : null;
      const curOverride = row.is_long_term_override ?? null;
      if (nextOverride !== curOverride) {
        this.db.run('UPDATE long_term_tasks SET is_long_term_override = ? WHERE id = ?', [nextOverride, row.id]);
        changes.push(`is_long_term=${nextOverride === 1 ? 'true' : nextOverride === 0 ? 'false' : 'auto'}`);
      }
    }
    if (typeof input.planArtifactUri === 'string') {
      const nextUri = input.planArtifactUri.trim();
      if (nextUri && nextUri !== (row.plan_artifact_uri ?? '')) {
        this.db.run('UPDATE long_term_tasks SET plan_artifact_uri = ? WHERE id = ?', [nextUri, row.id]);
        changes.push('plan_artifact_uri');
      }
    }
    if (changes.length === 0) return { ok: false, code: 'VALIDATION', error: 'nothing to update' };
    this.touch(row.id);
    this.addEvent(row.id, null, 'replanned', actor, `updated: ${changes.join(', ')}`);
    this.saveDb();
    this.emitTaskChanged(row.id, null, 'task', 'task_updated');
    const detail = this.getTask(row.id);
    return detail ? { ok: true, value: detail } : { ok: false, code: 'NOT_FOUND', error: 'task not found' };
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * Tasks that reached a terminal stage (done/cancelled) after `sinceMs`,
   * newest first. Feeds the Chief-of-Staff dream-brief reconciliation block:
   * the nightly <studio_continuity_brief> is a static distillation and can
   * still list workstreams the machine closed hours later, so the injection
   * layer needs the authoritative "resolved since then" delta.
   */
  listTasksResolvedSince(sinceMs: number, limit = 8): LongTermResolvedTaskRef[] {
    const cap = Math.max(1, Math.min(25, Math.trunc(limit)));
    const sinceIso = new Date(Number.isFinite(sinceMs) ? Math.max(0, Math.trunc(sinceMs)) : 0).toISOString();
    const rows = this.getAll<{ id: string; title: string; stage: string; done_at: string | null; updated_at: string }>(
      "SELECT id, title, stage, done_at, updated_at FROM long_term_tasks WHERE stage IN ('done', 'cancelled') AND COALESCE(done_at, updated_at) > ? ORDER BY COALESCE(done_at, updated_at) DESC LIMIT ?",
      [sinceIso, cap],
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      stage: row.stage === 'cancelled' ? ('cancelled' as const) : ('done' as const),
      resolvedAtIso: (row.done_at ?? '').trim() || row.updated_at,
    }));
  }

  getTask(taskId: string): LongTermTaskDetail | null {
    const row = this.getTaskRow(taskId);
    if (!row) return null;
    const subtasks = this.listSubtaskRows(taskId).map((sub) => this.mapSubtask(sub));
    const summary = this.toSummary(row, subtasks);
    const events = this.getAll<EventRow>(
      'SELECT * FROM long_term_events WHERE task_id = ? ORDER BY id DESC LIMIT 200',
      [taskId],
    ).map((event) => this.mapEvent(event));
    const sessionLinks = this.listSessionLinks(taskId);
    return {
      ...summary,
      subtasks,
      events,
      definitionSessionId: row.definition_session_id ?? null,
      sessionLinks,
    };
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
    if (input.assigneeMetabotId !== undefined) {
      const nextAssignee = input.assigneeMetabotId === null ? null : asNullableInt(input.assigneeMetabotId);
      if ((nextAssignee !== null || input.assigneeMetabotId === null) && nextAssignee !== (current.assigneeMetabotId ?? null)) {
        set('assignee_metabot_id', nextAssignee, 'assignee');
      }
    }
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
    this.emitTaskChanged(current.taskId, current.id, 'subtask', 'subtask_updated');
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
    if (updated && updated.status === current.status) {
      // Re-recording the brief on an already-waiting sub-project keeps the
      // status but changes what the owner reads — still a ledger change.
      this.emitTaskChanged(updated.taskId, updated.id, 'subtask', 'subtask_wait_note');
    }
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
      if (kind === 'file') return !uri.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(uri);
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
      "UPDATE long_term_subtasks SET status = 'accepted', accepted_by = ?, accepted_at = ?, wait_note = '', wait_until = NULL, lease_attempt_id = NULL, lease_claimed_at = NULL, updated_at = ? WHERE id = ?",
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
      "UPDATE long_term_subtasks SET status = 'skipped', wait_note = '', wait_until = NULL, lease_attempt_id = NULL, lease_claimed_at = NULL, updated_at = ? WHERE id = ?",
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
    this.db.run(
      "UPDATE long_term_subtasks SET status = 'in_progress', lease_attempt_id = NULL, lease_claimed_at = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), subtaskId],
    );
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
    const now = nowIso();
    this.db.run('UPDATE long_term_subtasks SET session_id = ?, session_history_json = ?, updated_at = ? WHERE id = ?', [
      trimmed,
      JSON.stringify(history),
      now,
      subtaskId,
    ]);
    this.upsertSessionLinkRow(current.taskId, trimmed, { subtaskId, role: 'discussion' }, now);
    this.addEvent(current.taskId, subtaskId, 'note', actor, `session bound: ${trimmed}`);
    this.touch(current.taskId);
    this.saveDb();
    this.emitTaskChanged(current.taskId, subtaskId, 'subtask', 'subtask_session_bound');
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }

  // ── session links, worker blackboard, leases & fast search ───────────────

  private upsertSessionLinkRow(
    taskId: string,
    sessionId: string,
    options: {
      subtaskId?: string | null;
      role?: TaskSessionLinkRole;
      channel?: TaskOriginChannel | null;
      anchorMessageId?: string | null;
    } = {},
    atIso: string = nowIso(),
  ): void {
    const sid = asText(sessionId).trim();
    if (!sid) return;
    const role: TaskSessionLinkRole =
      options.role && SESSION_LINK_ROLES.includes(options.role) ? options.role : 'discussion';
    const channel: TaskOriginChannel | null =
      options.channel && ORIGIN_CHANNELS.includes(options.channel) ? options.channel : null;
    const subtaskId = asText(options.subtaskId ?? '').trim() || null;
    const anchorMessageId = asText(options.anchorMessageId ?? '').trim() || null;
    this.db.run(
      `INSERT INTO task_session_links (task_id, session_id, subtask_id, role, channel, anchor_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, session_id) DO UPDATE SET
         subtask_id = COALESCE(excluded.subtask_id, task_session_links.subtask_id),
         role = CASE WHEN task_session_links.role = 'origin' THEN 'origin' ELSE excluded.role END,
         channel = COALESCE(excluded.channel, task_session_links.channel),
         anchor_message_id = COALESCE(excluded.anchor_message_id, task_session_links.anchor_message_id),
         updated_at = excluded.updated_at`,
      [taskId, sid, subtaskId, role, channel, anchorMessageId, atIso, atIso],
    );
  }

  linkSession(
    taskId: string,
    sessionId: string,
    options: {
      subtaskId?: string | null;
      role?: TaskSessionLinkRole;
      channel?: TaskOriginChannel | null;
      anchorMessageId?: string | null;
    } = {},
  ): LongTermResult<TaskSessionLink> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    const sid = asText(sessionId).trim();
    if (!sid) return { ok: false, code: 'VALIDATION', error: 'sessionId is required' };
    this.upsertSessionLinkRow(taskId, sid, options);
    this.saveDb();
    this.emitTaskChanged(taskId, options.subtaskId ?? null, 'task', 'task_session_linked');
    const linkRow = this.getOne<SessionLinkRow>(
      'SELECT * FROM task_session_links WHERE task_id = ? AND session_id = ?',
      [taskId, sid],
    );
    return linkRow
      ? { ok: true, value: this.mapSessionLink(linkRow) }
      : { ok: false, code: 'NOT_FOUND', error: 'session link failed' };
  }

  listSessionLinks(taskId: string): TaskSessionLink[] {
    return this.getAll<SessionLinkRow>(
      'SELECT * FROM task_session_links WHERE task_id = ? ORDER BY updated_at DESC',
      [taskId],
    ).map((r) => this.mapSessionLink(r));
  }

  /**
   * List all tasks associated with `sessionId` (many-to-many: origin, linked
   * discussions, bound subtasks, or session history), open tasks first.
   */
  listTasksForSession(sessionId: string): LongTermTaskSummary[] {
    const sid = asText(sessionId).trim();
    if (!sid) return [];
    const matchedIds = new Set<string>();
    for (const r of this.getAll<{ task_id: string }>('SELECT task_id FROM task_session_links WHERE session_id = ?', [sid])) {
      if (r.task_id) matchedIds.add(r.task_id);
    }
    for (const r of this.getAll<{ id: string }>(
      'SELECT id FROM long_term_tasks WHERE definition_session_id = ? OR origin_session_id = ?',
      [sid, sid],
    )) {
      if (r.id) matchedIds.add(r.id);
    }
    for (const r of this.getAll<SubtaskRow>(
      'SELECT * FROM long_term_subtasks WHERE session_id = ? OR instr(session_history_json, ?) > 0',
      [sid, sid],
    )) {
      if (r.session_id === sid || parseJsonArray<string>(r.session_history_json).includes(sid)) {
        matchedIds.add(r.task_id);
      }
    }
    const out: LongTermTaskSummary[] = [];
    for (const id of matchedIds) {
      const row = this.getTaskRow(id);
      if (!row || row.stage === 'cancelled') continue;
      const subtasks = this.listSubtaskRows(row.id).map((s) => this.mapSubtask(s));
      out.push(this.toSummary(row, subtasks));
    }
    return out.sort((a, b) => {
      const aOpen = a.stage === 'done' ? 1 : 0;
      const bOpen = b.stage === 'done' ? 1 : 0;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  /**
   * Claim an exclusive execution lease on an open subtask so two parallel
   * sessions cannot accidentally build conflicting branches for the same item
   * (prevents the 2026-11-17 G1 duplicate-execution merge collision).
   */
  claimSubtaskLease(
    subtaskId: string,
    input: {
      assigneeMetabotId: number;
      attemptId: string;
      workerSessionId?: string | null;
      forceSupersede?: boolean;
    },
    actor: LongTermActor,
  ): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'subtask not found' };
    if (current.status === 'accepted' || current.status === 'skipped') {
      return { ok: false, code: 'VALIDATION', error: `cannot claim lease on ${current.status} subtask` };
    }
    const task = this.getTaskRow(current.taskId);
    if (!task || task.stage === 'done' || task.stage === 'cancelled') {
      return { ok: false, code: 'VALIDATION', error: `task is ${task?.stage ?? 'missing'}` };
    }
    const attemptId = asText(input.attemptId).trim();
    const assigneeId = asNullableInt(input.assigneeMetabotId);
    if (!attemptId || !assigneeId) {
      return { ok: false, code: 'VALIDATION', error: 'assigneeMetabotId and attemptId are required' };
    }
    if (
      current.leaseAttemptId
      && current.leaseAttemptId !== attemptId
      && input.forceSupersede !== true
    ) {
      return {
        ok: false,
        code: 'CONFLICT',
        error: `subtask ${subtaskId} is already claimed by active attempt ${current.leaseAttemptId} (assignee bot #${current.assigneeMetabotId ?? 'unknown'})`,
      };
    }
    const now = nowIso();
    const nextStatus: LongTermSubtaskStatus =
      current.status === 'pending' ? 'in_progress' : current.status;
    this.db.run(
      `UPDATE long_term_subtasks
          SET status = ?,
              assignee_metabot_id = ?,
              lease_attempt_id = ?,
              lease_claimed_at = ?,
              last_activity_at = ?,
              updated_at = ?
        WHERE id = ?`,
      [nextStatus, assigneeId, attemptId, now, now, now, subtaskId],
    );
    if (input.workerSessionId) {
      this.upsertSessionLinkRow(
        current.taskId,
        input.workerSessionId,
        { subtaskId, role: 'worker_exec' },
        now,
      );
    }
    this.addEvent(
      current.taskId,
      subtaskId,
      'assigned',
      actor,
      `assigned to bot #${assigneeId} (attempt ${attemptId})`,
    );
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, 'assigned');
    if (updated && updated.status === current.status) {
      // Re-assigning a subtask that is already in progress keeps the status
      // but changes the assignee the stage rail shows.
      this.emitTaskChanged(updated.taskId, updated.id, 'subtask', 'subtask_assigned');
    }
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'subtask not found' };
  }

  releaseSubtaskLease(subtaskId: string, attemptId?: string | null): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'subtask not found' };
    if (attemptId && current.leaseAttemptId && current.leaseAttemptId !== attemptId) {
      return { ok: true, value: current };
    }
    if (!current.leaseAttemptId) {
      return { ok: true, value: current };
    }
    this.db.run(
      'UPDATE long_term_subtasks SET lease_attempt_id = NULL, lease_claimed_at = NULL, updated_at = ? WHERE id = ?',
      [nowIso(), subtaskId],
    );
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'subtask not found' };
  }

  /**
   * Zero-token runtime liveness pulse: updates `last_activity_at` (and optional
   * short activity summary) while a Worker or Twin session is actively running.
   */
  touchSubtaskActivity(subtaskId: string, activityAtIso: string = nowIso(), progressNote?: string): boolean {
    const current = this.getSubtask(subtaskId);
    if (!current) return false;
    if (typeof progressNote === 'string' && progressNote.trim()) {
      const nextNote = progressNote.trim().slice(0, 280);
      this.db.run(
        'UPDATE long_term_subtasks SET last_activity_at = ?, progress_note = ?, updated_at = ? WHERE id = ?',
        [activityAtIso, nextNote, activityAtIso, subtaskId],
      );
      this.touch(current.taskId);
      this.saveDb();
      if (nextNote !== current.progressNote) {
        this.emitTaskChanged(current.taskId, subtaskId, 'subtask', 'subtask_progress');
      }
      return true;
    }
    this.db.run('UPDATE long_term_subtasks SET last_activity_at = ? WHERE id = ?', [activityAtIso, subtaskId]);
    this.saveDb();
    return true;
  }

  /**
   * Worker/Bot self-registered step progress checkpoint (journalled + surfaced
   * live on the Studio HUD and Task Board).
   */
  recordSubtaskProgress(
    subtaskId: string,
    input: { note: string; activityAtIso?: string },
    actor: LongTermActor,
  ): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'subtask not found' };
    if (current.status === 'accepted' || current.status === 'skipped') {
      return { ok: false, code: 'VALIDATION', error: `cannot record progress on ${current.status} subtask` };
    }
    const note = asText(input.note).trim().slice(0, 280);
    if (!note) return { ok: false, code: 'VALIDATION', error: 'progress note is required' };
    const now = input.activityAtIso || nowIso();
    this.db.run(
      'UPDATE long_term_subtasks SET progress_note = ?, last_activity_at = ?, updated_at = ? WHERE id = ?',
      [note, now, now, subtaskId],
    );
    this.addEvent(current.taskId, subtaskId, 'progress', actor, note);
    this.touch(current.taskId);
    this.saveDb();
    this.emitTaskChanged(current.taskId, subtaskId, 'subtask', 'subtask_progress');
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'subtask not found' };
  }

  /**
   * Worker self-registers its completion / blocker submission directly onto the
   * Subtask blackboard (artifacts, evidence, summary, outcome) instead of
   * relying solely on natural-language chat handoff text.
   */
  submitSubtaskWork(
    subtaskId: string,
    input: {
      outcome: TaskWorkerSubmissionOutcome;
      workerMetabotId: number;
      workerSessionId?: string | null;
      summary: string;
      artifacts?: TaskDeliverableArtifact[];
      evidence?: LongTermEvidence[];
      blockers?: string[];
      attemptId?: string | null;
    },
    actor: LongTermActor,
  ): LongTermResult<LongTermSubtask> {
    const current = this.getSubtask(subtaskId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'subtask not found' };
    if (current.status === 'accepted' || current.status === 'skipped') {
      return { ok: false, code: 'VALIDATION', error: `cannot submit work on ${current.status} subtask` };
    }
    if (!SUBMISSION_OUTCOMES.includes(input.outcome)) {
      return { ok: false, code: 'VALIDATION', error: `invalid outcome "${String(input.outcome)}"` };
    }
    const summary = asText(input.summary).trim();
    if (!summary) return { ok: false, code: 'VALIDATION', error: 'submission summary is required' };

    const incomingEvidence = (input.evidence ?? []).filter((e) => e && asText(e.uri).trim());
    if (incomingEvidence.length > 0) {
      const evidenceError = this.validateEvidenceInput(incomingEvidence);
      if (evidenceError) return { ok: false, code: 'VALIDATION', error: evidenceError };
    }

    const mergedEvidence = [...current.evidence];
    for (const item of incomingEvidence) {
      if (!mergedEvidence.some((existing) => existing.kind === item.kind && existing.uri === item.uri)) {
        mergedEvidence.push(item);
      }
    }

    const artifacts: TaskDeliverableArtifact[] = (input.artifacts ?? [])
      .filter((a) => a && asText(a.uri).trim())
      .map((a) => ({
        kind: asText(a.kind).trim() || 'other',
        uri: asText(a.uri).trim(),
        ...(a.label ? { label: asText(a.label).trim() } : {}),
        ...(a.sha256 ? { sha256: asText(a.sha256).trim() } : {}),
      }));

    const now = nowIso();
    const submission: TaskWorkerSubmission = {
      outcome: input.outcome,
      workerMetabotId: asNullableInt(input.workerMetabotId) ?? 0,
      workerSessionId: asText(input.workerSessionId ?? '').trim() || null,
      summary: summary.slice(0, 2000),
      artifacts,
      evidence: incomingEvidence,
      blockers: (input.blockers ?? []).map((b) => asText(b).trim()).filter(Boolean),
      submittedAt: now,
    };

    const nextStatus: LongTermSubtaskStatus =
      input.outcome === 'waiting_external' ? 'waiting_external' : 'in_progress';
    const nextProgress =
      input.outcome === 'ready_for_review'
        ? `submitted for review: ${summary.slice(0, 180)}`
        : `${input.outcome}: ${(submission.blockers[0] || summary).slice(0, 180)}`;
    const releaseLease =
      !input.attemptId || !current.leaseAttemptId || current.leaseAttemptId === input.attemptId;

    this.db.run(
      `UPDATE long_term_subtasks
          SET status = ?,
              evidence_json = ?,
              submission_json = ?,
              progress_note = ?,
              last_activity_at = ?,
              lease_attempt_id = CASE WHEN ? = 1 THEN NULL ELSE lease_attempt_id END,
              lease_claimed_at = CASE WHEN ? = 1 THEN NULL ELSE lease_claimed_at END,
              wait_note = CASE WHEN ? = 'waiting_external' THEN ? ELSE wait_note END,
              updated_at = ?
        WHERE id = ?`,
      [
        nextStatus,
        JSON.stringify(mergedEvidence),
        JSON.stringify(submission),
        nextProgress,
        now,
        releaseLease ? 1 : 0,
        releaseLease ? 1 : 0,
        input.outcome,
        (submission.blockers[0] || summary).slice(0, WAIT_NOTE_MAX_CHARS),
        now,
        subtaskId,
      ],
    );
    if (submission.workerSessionId) {
      this.upsertSessionLinkRow(
        current.taskId,
        submission.workerSessionId,
        { subtaskId, role: 'worker_exec' },
        now,
      );
    }
    const artifactSummary =
      artifacts.length > 0 ? ` [${artifacts.map((a) => a.uri).join(', ')}]` : '';
    this.addEvent(
      current.taskId,
      subtaskId,
      'submitted',
      actor,
      `${input.outcome}: ${summary.slice(0, 800)}${artifactSummary}`,
    );
    this.touch(current.taskId);
    this.saveDb();
    const updated = this.getSubtask(subtaskId);
    this.emitStatusChange(current, updated, 'submitted');
    if (updated && updated.status === current.status) {
      // ready_for_review / blocked / failed keep the subtask in_progress, so
      // the status channel stays silent — the submission itself is the news.
      this.emitTaskChanged(updated.taskId, updated.id, 'subtask', 'subtask_submitted');
    }
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'subtask not found' };
  }

  /**
   * Compact radar of all non-terminal tasks on this machine (<2KB typical),
   * prioritized by `waiting_owner` and `in_progress` so Twin Bot has instant
   * awareness of every active task without spilling huge JSON payloads.
   */
  listActiveTasksCompact(limit = 25): TaskActiveRadarEntry[] {
    const cap = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.getAll<TaskRow>(
      "SELECT * FROM long_term_tasks WHERE stage NOT IN ('done', 'cancelled') ORDER BY updated_at DESC LIMIT ?",
      [cap],
    );
    const entries: TaskActiveRadarEntry[] = [];
    for (const row of rows) {
      const subtasks = this.listSubtaskRows(row.id).map((s) => this.mapSubtask(s));
      const summary = this.toSummary(row, subtasks);
      if (!summary.managedState) continue;
      const assigneeId = summary.currentAssigneeMetabotId ?? null;
      const assigneeParticipant =
        assigneeId != null ? summary.participants.find((p) => p.id === assigneeId) ?? null : null;
      entries.push({
        id: summary.id,
        title: summary.title,
        stage: summary.stage,
        managedState: summary.managedState,
        isLongTerm: Boolean(summary.isLongTerm),
        progress: summary.progress,
        currentSubtaskId: summary.currentSubtaskId,
        currentSubtaskTitle: summary.currentSubtaskTitle,
        currentSubtaskStatus: summary.currentSubtaskStatus,
        assigneeMetabotId: assigneeId,
        assigneeName: assigneeParticipant?.name ?? null,
        progressNote: summary.currentProgressNote ?? null,
        waitNote: summary.currentWaitNote ? summary.currentWaitNote.slice(0, 200) : null,
        originSessionId: summary.originSessionId ?? null,
        parentTaskId: summary.parentTaskId ?? null,
        parentTaskTitle: summary.parentTaskTitle ?? null,
        updatedAt: summary.updatedAt,
      });
    }
    const orderWeight: Record<LongTermManagedState, number> = {
      in_progress: 0,
      waiting_owner: 1,
      waiting_external: 2,
    };
    return entries.sort(
      (a, b) => orderWeight[a.managedState] - orderWeight[b.managedState] || b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  /**
   * Fast full-board search across open and archived/done tasks (matches task
   * title/goal, subtask titles/descriptions/notes/progress/artifacts, and
   * event journal details).
   */
  searchTasks(options: TaskSearchOptions = {}): LongTermTaskSummary[] {
    const includeDone = options.includeDone !== false;
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
    const rawQuery = asText(options.query ?? '').trim().toLowerCase();
    const tokens = rawQuery
      ? rawQuery.split(/\s+/).map((t) => t.trim()).filter(Boolean)
      : [];

    const stageFilter = options.stage
      ? Array.isArray(options.stage)
        ? new Set(options.stage)
        : new Set([options.stage])
      : null;

    const sessionFilterIds = options.sessionId
      ? new Set(this.listTasksForSession(options.sessionId).map((t) => t.id))
      : null;

    const rows = this.getAll<TaskRow>(
      includeDone
        ? "SELECT * FROM long_term_tasks WHERE stage != 'cancelled' ORDER BY updated_at DESC"
        : "SELECT * FROM long_term_tasks WHERE stage NOT IN ('done', 'cancelled') ORDER BY updated_at DESC",
    );

    const scored: Array<{ summary: LongTermTaskSummary; score: number }> = [];
    for (const row of rows) {
      if (stageFilter && !stageFilter.has(row.stage)) continue;
      if (sessionFilterIds && !sessionFilterIds.has(row.id)) continue;

      const subtasks = this.listSubtaskRows(row.id).map((s) => this.mapSubtask(s));
      if (
        typeof options.assigneeMetabotId === 'number'
        && !subtasks.some((s) => s.assigneeMetabotId === options.assigneeMetabotId)
      ) {
        continue;
      }

      const summary = this.toSummary(row, subtasks);
      if (options.managedState && summary.managedState !== options.managedState) continue;
      if (typeof options.isLongTerm === 'boolean' && Boolean(summary.isLongTerm) !== options.isLongTerm) continue;

      if (tokens.length === 0) {
        scored.push({ summary, score: summary.stage === 'done' ? 0 : 10 });
        continue;
      }

      const titleHay = `${summary.title} ${summary.id}`.toLowerCase();
      const bodyHay = [
        summary.goal,
        ...subtasks.map((s) =>
          [
            s.title,
            s.description,
            s.notes,
            s.progressNote ?? '',
            s.waitNote,
            ...s.evidence.map((e) => `${e.uri} ${e.note ?? ''}`),
            ...(s.submission
              ? [
                  s.submission.summary,
                  ...s.submission.artifacts.map((a) => `${a.uri} ${a.label ?? ''}`),
                ]
              : []),
          ].join(' '),
        ),
      ]
        .join(' ')
        .toLowerCase();

      let matchedAll = true;
      let score = summary.stage === 'done' ? 0 : 5;
      for (const tok of tokens) {
        const inTitle = titleHay.includes(tok);
        const inBody = bodyHay.includes(tok);
        if (inTitle) {
          score += 10;
        } else if (inBody) {
          score += 4;
        } else {
          const eventHit = this.getOne<{ one: number }>(
            'SELECT 1 AS one FROM long_term_events WHERE task_id = ? AND lower(detail) LIKE ? LIMIT 1',
            [row.id, `%${tok}%`],
          );
          if (eventHit) {
            score += 2;
          } else {
            matchedAll = false;
            break;
          }
        }
      }
      if (matchedAll) {
        scored.push({ summary, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score || b.summary.updatedAt.localeCompare(a.summary.updatedAt))
      .slice(0, limit)
      .map((entry) => entry.summary);
  }

  addNote(taskId: string, subtaskId: string | null, text: string, actor: LongTermActor): LongTermResult<null> {
    const row = this.getTaskRow(taskId);
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'task not found' };
    const trimmed = asText(text).trim();
    if (!trimmed) return { ok: false, code: 'VALIDATION', error: 'note text is required' };
    this.addEvent(taskId, subtaskId, 'note', actor, trimmed);
    this.touch(taskId);
    this.saveDb();
    this.emitTaskChanged(taskId, subtaskId, 'task', 'task_note');
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
    const lastAttentionKey = String((entry as LongTermSuperviseState).lastAttentionKey ?? '');
    const lastAttentionResolution = (entry as LongTermSuperviseState).lastAttentionResolution
      ?? (lastAttentionKey ? 'actioned' : undefined);
    const attentionActionCount = Number((entry as LongTermSuperviseState).attentionActionCount);
    const rawAttentionEscalation = (entry as LongTermSuperviseState).attentionEscalation;
    const attentionEscalation =
      rawAttentionEscalation
      && typeof rawAttentionEscalation === 'object'
      && typeof (rawAttentionEscalation as { subtaskId?: unknown }).subtaskId === 'string'
      && Number.isFinite(Number((rawAttentionEscalation as { count?: unknown }).count))
        ? { subtaskId: rawAttentionEscalation.subtaskId, count: Math.max(0, Math.trunc(Number(rawAttentionEscalation.count))) }
        : undefined;
    return {
      lastSuperviseAtMs,
      lastFailureSignal: String((entry as LongTermSuperviseState).lastFailureSignal ?? ''),
      lastAttentionKey,
      lastAttentionResolution,
      lastAttentionActionAtMs: Number((entry as LongTermSuperviseState).lastAttentionActionAtMs ?? 0),
      nextAttentionRetryAtMs: Number((entry as LongTermSuperviseState).nextAttentionRetryAtMs ?? 0),
      attentionActionCount: Number.isFinite(attentionActionCount) ? attentionActionCount : (lastAttentionKey ? 1 : 0),
      convergenceAtMs,
      ...(attentionEscalation ? { attentionEscalation } : {}),
    };
  }

  setSuperviseState(taskId: string, state: LongTermSuperviseState): void {
    const map = this.readSuperviseStateMap();
    // Omitted optional fields preserve their existing values: a duration-turn
    // write must not wipe the failure dedup, and a supervision-turn write
    // must not wipe the churn-breaker trail.
    const lastFailureSignal = state.lastFailureSignal ?? map[taskId]?.lastFailureSignal ?? '';
    const lastAttentionKey = state.lastAttentionKey ?? map[taskId]?.lastAttentionKey ?? '';
    const lastAttentionResolution = state.lastAttentionResolution ?? map[taskId]?.lastAttentionResolution;
    const lastAttentionActionAtMs = state.lastAttentionActionAtMs ?? map[taskId]?.lastAttentionActionAtMs ?? 0;
    const nextAttentionRetryAtMs = state.nextAttentionRetryAtMs ?? map[taskId]?.nextAttentionRetryAtMs ?? 0;
    const attentionActionCount = state.attentionActionCount ?? map[taskId]?.attentionActionCount ?? (lastAttentionKey ? 1 : 0);
    const convergenceAtMs = state.convergenceAtMs ?? map[taskId]?.convergenceAtMs ?? [];
    const attentionEscalation = state.attentionEscalation ?? map[taskId]?.attentionEscalation;
    map[taskId] = {
      lastSuperviseAtMs: Math.trunc(state.lastSuperviseAtMs),
      lastFailureSignal,
      lastAttentionKey,
      lastAttentionResolution,
      lastAttentionActionAtMs,
      nextAttentionRetryAtMs,
      attentionActionCount,
      convergenceAtMs: convergenceAtMs.map(Number).filter((value) => Number.isFinite(value)),
      ...(attentionEscalation ? { attentionEscalation } : {}),
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

  /**
   * Reverse lookup for the session-side origin chip: which task/sub-project
   * owns this session. Precedence: the sub-project currently bound to it, the
   * task born in it, then a sub-project that was bound to it earlier — a
   * session rotated away from (or rebound off) stays visibly linked to its
   * task. Before the history fallback a rotation silently dropped the chip,
   * so the old session's readable history looked unrelated to any task.
   */
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
    const taskRow = this.getOne<TaskRow>(
      'SELECT * FROM long_term_tasks WHERE definition_session_id = ? OR origin_session_id = ? ORDER BY updated_at DESC LIMIT 1',
      [trimmed, trimmed],
    );
    if (taskRow) {
      const subtasks = this.listSubtaskRows(taskRow.id).map((row) => this.mapSubtask(row));
      return { task: this.toSummary(taskRow, subtasks), subtask: null };
    }
    const linkRow = this.getOne<SessionLinkRow>(
      'SELECT * FROM task_session_links WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1',
      [trimmed],
    );
    if (linkRow) {
      const linkedTaskRow = this.getTaskRow(linkRow.task_id);
      if (linkedTaskRow) {
        const subtasks = this.listSubtaskRows(linkedTaskRow.id).map((row) => this.mapSubtask(row));
        const sub = linkRow.subtask_id ? subtasks.find((s) => s.id === linkRow.subtask_id) ?? null : null;
        return { task: this.toSummary(linkedTaskRow, subtasks), subtask: sub };
      }
    }
    // Substring prefilter, then exact membership on the parsed history (a
    // session id that is merely a substring of a recorded one must not match).
    const historyRow = this.getAll<SubtaskRow>(
      'SELECT * FROM long_term_subtasks WHERE instr(session_history_json, ?) > 0 ORDER BY updated_at DESC',
      [trimmed],
    ).find((row) => parseJsonArray<string>(row.session_history_json).includes(trimmed));
    if (!historyRow) return null;
    const historyTaskRow = this.getTaskRow(historyRow.task_id);
    if (!historyTaskRow) return null;
    const historySubtasks = this.listSubtaskRows(historyTaskRow.id).map((row) => this.mapSubtask(row));
    return { task: this.toSummary(historyTaskRow, historySubtasks), subtask: this.mapSubtask(historyRow) };
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
    if (row.origin_session_id) ids.add(row.origin_session_id);
    for (const link of this.listSessionLinks(taskId)) {
      if (link.sessionId) ids.add(link.sessionId);
    }
    for (const subRow of this.listSubtaskRows(taskId)) {
      for (const id of parseJsonArray<string>(subRow.session_history_json)) {
        if (id) ids.add(id);
      }
      if (subRow.session_id) ids.add(subRow.session_id);
      if (subRow.origin_session_id) ids.add(subRow.origin_session_id);
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
    this.emitTaskChanged(current.taskId, current.id, 'subtask', 'subtask_moved');
    const updated = this.getSubtask(subtaskId);
    return updated ? { ok: true, value: updated } : { ok: false, code: 'NOT_FOUND', error: 'sub-project not found' };
  }
}
