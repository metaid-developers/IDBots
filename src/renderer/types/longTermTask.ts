/**
 * Long-term task board — shared types.
 *
 * A long-term task is a FIRST-CLASS entity (tables long_term_tasks /
 * long_term_subtasks / long_term_events), not a projection of the delegation
 * ledger: group tasks, scheduled tasks and one-shot delegations never appear
 * here. The kanban column and progress are derived read-time by the main
 * process (src/main/longTermTaskStore.ts); the renderer consumes, never
 * re-derives. This file mirrors the store's field names verbatim.
 *
 * Contract: docs/design/long-term-task-redesign-plan.md
 */

/** Lifecycle flags stored on the task row. */
export type LongTermTaskStage = 'defining' | 'active' | 'paused' | 'done' | 'cancelled';

/** Task granularity: lightweight single-step card vs multi-stage project tree. */
export type LongTermTaskKind = 'quick' | 'project';

/**
 * Canonical 3-state live model exposed to the owner and Twin in Studio mode:
 * every open task is strictly in_progress, waiting_external, or waiting_owner.
 */
export type LongTermManagedState = 'in_progress' | 'waiting_external' | 'waiting_owner';

/**
 * Kanban column (derived read-time, never persisted). Column order is the
 * display order: owner-attention first.
 */
export type LongTermColumn =
  | 'waiting_owner'
  | 'in_progress'
  | 'waiting_external'
  | 'defining'
  | 'paused'
  | 'done';

export const LONG_TERM_COLUMN_ORDER: LongTermColumn[] = [
  'waiting_owner',
  'in_progress',
  'waiting_external',
  'defining',
  'paused',
  'done',
];

/** Column header i18n keys (renderer renders; backend never carries UI copy). */
export const LONG_TERM_COLUMN_LABEL_KEYS: Record<LongTermColumn, string> = {
  waiting_owner: 'longTermTask.column.waitingOwner',
  in_progress: 'longTermTask.column.inProgress',
  waiting_external: 'longTermTask.column.waitingExternal',
  defining: 'longTermTask.column.defining',
  paused: 'longTermTask.column.paused',
  done: 'longTermTask.column.done',
};

/** Sub-task status chip i18n keys. */
export const LONG_TERM_SUBTASK_STATUS_LABEL_KEYS: Record<LongTermSubtaskStatus, string> = {
  pending: 'longTermTask.status.pending',
  in_progress: 'longTermTask.status.inProgress',
  waiting_owner: 'longTermTask.status.waitingOwner',
  waiting_external: 'longTermTask.status.waitingExternal',
  accepted: 'longTermTask.status.accepted',
  rejected: 'longTermTask.status.rejected',
  skipped: 'longTermTask.status.skipped',
};

export type LongTermSubtaskStatus =
  | 'pending'
  | 'in_progress'
  | 'waiting_owner'
  | 'waiting_external'
  | 'accepted'
  | 'rejected'
  | 'skipped';

/** How a sub-project is meant to be executed (recorded at creation, adjustable). */
export type LongTermPreferredChannel = 'delegate_bot' | 'group_task' | 'owner_external' | 'owner_together';

export type LongTermEventKind =
  | 'created'
  | 'replanned'
  | 'began'
  | 'assigned'
  | 'progress'
  | 'submitted'
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'skipped'
  | 'waiting'
  | 'unblocked'
  | 'nudged'
  | 'supervised'
  | 'paused'
  | 'resumed'
  | 'completed'
  | 'note';

export type LongTermActor = 'owner' | 'twin' | 'system' | `worker:${number}`;

export type TaskOriginChannel =
  | 'studio'
  | 'botworks'
  | 'mobile'
  | 'telegram'
  | 'im'
  | 'a2a'
  | 'schedule'
  | 'other';

export type TaskSessionLinkRole =
  | 'origin'
  | 'discussion'
  | 'worker_exec'
  | 'supervision'
  | 'channel_bridge';

export interface TaskSessionLink {
  taskId: string;
  sessionId: string;
  subtaskId: string | null;
  role: TaskSessionLinkRole;
  channel: TaskOriginChannel | null;
  anchorMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LongTermReason =
  | 'manual'
  | 'participants'
  | 'expected_duration'
  | 'elapsed_span'
  | 'multi_stage';

export interface LongTermBadgeThresholds {
  minParticipants: number;
  minExpectedMinutes: number;
  minActiveAgeMs: number;
  minMultiStageSubtasks: number;
}

export interface TaskDeliverableArtifact {
  /** dir | file | metaapp | metafile | pin | url | branch | other */
  kind: string;
  uri: string;
  label?: string;
  sha256?: string;
}

export type TaskWorkerSubmissionOutcome =
  | 'ready_for_review'
  | 'blocked'
  | 'waiting_external'
  | 'failed';

export interface TaskWorkerSubmission {
  outcome: TaskWorkerSubmissionOutcome;
  workerMetabotId: number;
  workerSessionId: string | null;
  summary: string;
  artifacts: TaskDeliverableArtifact[];
  evidence: LongTermEvidence[];
  blockers: string[];
  submittedAt: string;
}

export interface LongTermEvidence {
  /** dir | metaapp | metafile | pin | url | other */
  kind: string;
  uri: string;
  note?: string;
}

export interface LongTermSubtask {
  id: string;
  taskId: string;
  ordinal: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: LongTermSubtaskStatus;
  /** Sibling sub-task ids that must be accepted first. */
  dependsOn: string[];
  preferredChannel: LongTermPreferredChannel | null;
  evidence: LongTermEvidence[];
  /** Bound cowork session (sessionType 'longterm'); null until one is opened. */
  sessionId: string | null;
  /** Every session EVER bound to this sub-project (rotation appends) — the
   *  supervision telemetry spans all of them so a rotation cannot blind the
   *  failure-streak detector. */
  sessionHistory: string[];
  /** What we are waiting for, when status is waiting_owner / waiting_external. */
  waitNote: string;
  /** ISO time for time-based re-checks (heartbeat), null otherwise. */
  waitUntil: string | null;
  notes: string;
  /** Expected duration in minutes — the supervision heartbeat checks in when a sub-project runs past it (P1). */
  expectedMinutes: number | null;
  /** Linked on-chain MetaTask root pinId when this sub-project's execution
   *  channel is a chain-side multi-bot task (referenced, not mixed in). */
  metataskRoot: string | null;
  /** Assigned Bot id currently responsible for executing this subtask. */
  assigneeMetabotId?: number | null;
  /** Active execution lease attempt id preventing duplicate parallel dispatches. */
  leaseAttemptId?: string | null;
  leaseClaimedAt?: string | null;
  /** Latest liveness heartbeat / tool activity timestamp from the assignee Bot. */
  lastActivityAt?: string | null;
  /** Live step progress note registered by the assignee Bot. */
  progressNote?: string;
  /** Structured Worker completion/blocker submission registered directly on the subtask. */
  submission?: TaskWorkerSubmission | null;
  originSessionId?: string | null;
  originMessageId?: string | null;
  acceptedBy: 'owner' | 'twin' | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}

export interface LongTermEvent {
  id: number;
  taskId: string;
  subtaskId: string | null;
  kind: LongTermEventKind;
  actor: LongTermActor;
  detail: string;
  createdAt: string;
}

export interface LongTermProgress {
  accepted: number;
  /** Non-skipped total. */
  total: number;
  percent: number;
}

/** A bot participating in the task (avatar = data URL or URL, null = none). */
export interface LongTermParticipant {
  id: number;
  name: string;
  avatar: string | null;
}

/** Board card (summary projection; column/progress/current derived by main). */
export interface LongTermTaskSummary {
  id: string;
  title: string;
  goal: string;
  stage: LongTermTaskStage;
  column: LongTermColumn;
  /** 'quick' (single-step deliverable card) | 'project' (multi-stage decomposition). */
  taskKind?: LongTermTaskKind;
  /** True when the task qualifies for the `[长期]` (Long-Term) complexity/span badge. */
  isLongTerm?: boolean;
  /** Objective reasons why `isLongTerm` evaluated to true (empty for standard tasks). */
  longTermReasons?: LongTermReason[];
  /** Explicit override: true = forced long-term, false = forced standard, null/undefined = auto. */
  isLongTermOverride?: boolean | null;
  /** Canonical 3-state live status (null when done/cancelled). */
  managedState?: LongTermManagedState | null;
  acceptanceDelegate: boolean;
  /** URI of the visual plan page the owner confirmed before creation — the
   *  local .html file shown in the bubble (or pin:// when the owner asked for
   *  an on-chain copy). Null when creation skipped the plan page. */
  planArtifactUri: string | null;
  /** Originating session & anchor message pointers (many-to-many session decoupled). */
  originSessionId?: string | null;
  originMessageId?: string | null;
  anchorMessageIds?: string[];
  originChannel?: TaskOriginChannel | null;
  currentSubtaskId: string | null;
  currentSubtaskTitle: string | null;
  currentSubtaskStatus: LongTermSubtaskStatus | null;
  /** Assigned Bot id on the current focus subtask, if any. */
  currentAssigneeMetabotId?: number | null;
  /** Live Worker progress note on the current focus subtask, if any. */
  currentProgressNote?: string | null;
  /** Latest liveness pulse timestamp on the current focus subtask, if any. */
  currentLastActivityAt?: string | null;
  /** Present when the current sub-task waits on something (wait_note). */
  currentWaitNote: string | null;
  /** The current sub-task's expected-duration budget in minutes (null = default). */
  currentExpectedMinutes: number | null;
  progress: LongTermProgress;
  counts: Record<LongTermSubtaskStatus, number>;
  /** Bound sessions of sub-projects currently waiting on the owner's verdict —
   *  the sidebar unpins these from the autonomous fold onto the main list
   *  (derived live; re-folds the moment the verdict lands). */
  decisionSessionIds: string[];
  /** Participating bots: twin + delegated workers + group-task members (derived read-time). */
  participants: LongTermParticipant[];
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

export interface LongTermTaskDetail extends LongTermTaskSummary {
  subtasks: LongTermSubtask[];
  /** Newest first, capped. */
  events: LongTermEvent[];
  definitionSessionId: string | null;
  sessionLinks?: TaskSessionLink[];
}

export interface LongTermBoard {
  generatedAtMs: number;
  columns: Array<{ column: LongTermColumn; cardIds: string[] }>;
  cards: LongTermTaskSummary[];
}

/** Creation draft for one sub-project (dependencies by ordinal, 1-based). */
export interface LongTermSubtaskDraft {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  dependsOnOrdinals?: number[];
  preferredChannel?: LongTermPreferredChannel;
  notes?: string;
  /** Expected duration in minutes; null/invalid = use the supervision default. */
  expectedMinutes?: number;
  /** Optional initial assignee Bot id for this subtask. */
  assigneeMetabotId?: number | null;
}

export interface LongTermTaskCreateInput {
  title: string;
  goal: string;
  subtasks: LongTermSubtaskDraft[];
  definitionSessionId?: string | null;
  originSessionId?: string | null;
  originMessageId?: string | null;
  anchorMessageIds?: string[];
  originChannel?: TaskOriginChannel | null;
  isLongTerm?: boolean | null;
  intentScore?: unknown;
  /** URI of the plan page the owner confirmed before this create call. */
  planArtifactUri?: string | null;
  taskKind?: LongTermTaskKind;
}

export interface LongTermQuickTaskCreateInput {
  title: string;
  goal?: string;
  acceptanceCriteria?: string[];
  preferredChannel?: LongTermPreferredChannel;
  expectedMinutes?: number;
  assigneeMetabotId?: number | null;
  definitionSessionId?: string | null;
  originSessionId?: string | null;
  originMessageId?: string | null;
  anchorMessageIds?: string[];
  originChannel?: TaskOriginChannel | null;
  isLongTerm?: boolean | null;
  intentScore?: unknown;
}

export interface UnifiedTaskCreateInput {
  title: string;
  goal?: string;
  /** 1..N subtasks with optional serial/parallel `dependsOnOrdinals`. Defaults to 1 subtask when omitted. */
  subtasks?: LongTermSubtaskDraft[];
  acceptanceCriteria?: string[];
  preferredChannel?: LongTermPreferredChannel;
  expectedMinutes?: number;
  /** Default true: immediately activates task and begins eligible dependency-free subtask(s). Set false for defining drafts. */
  activateImmediately?: boolean;
  isLongTerm?: boolean | null;
  definitionSessionId?: string | null;
  originSessionId?: string | null;
  originMessageId?: string | null;
  anchorMessageIds?: string[];
  originChannel?: TaskOriginChannel | null;
  planArtifactUri?: string | null;
  intentScore?: unknown;
}

export interface TaskSearchOptions {
  query?: string;
  stage?: LongTermTaskStage | LongTermTaskStage[];
  managedState?: LongTermManagedState;
  isLongTerm?: boolean;
  assigneeMetabotId?: number;
  sessionId?: string;
  includeDone?: boolean;
  limit?: number;
}

export interface TaskActiveRadarEntry {
  id: string;
  title: string;
  stage: LongTermTaskStage;
  managedState: LongTermManagedState;
  isLongTerm: boolean;
  progress: LongTermProgress;
  currentSubtaskId: string | null;
  currentSubtaskTitle: string | null;
  currentSubtaskStatus: LongTermSubtaskStatus | null;
  assigneeMetabotId: number | null;
  assigneeName: string | null;
  progressNote: string | null;
  waitNote: string | null;
  originSessionId: string | null;
  updatedAt: string;
}

export interface LongTermTaskUpdateInput {
  taskId: string;
  title?: string;
  goal?: string;
  acceptanceDelegate?: boolean;
  isLongTerm?: boolean | null;
  /** Set/replace the plan-page URI (no clear — the page stays owed). */
  planArtifactUri?: string | null;
}

export interface LongTermSubtaskUpdateInput {
  subtaskId: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  preferredChannel?: LongTermPreferredChannel | null;
  notes?: string;
  ordinal?: number;
  assigneeMetabotId?: number | null;
  /** Set or clear the expected-duration budget (null clears back to the default). */
  expectedMinutes?: number | null;
  /** Link/unlink an on-chain MetaTask root as this sub-project's execution channel. */
  metataskRoot?: string | null;
}

export interface LongTermResult<T> {
  ok: boolean;
  code?: 'NOT_FOUND' | 'VALIDATION' | 'FORBIDDEN' | 'CONFLICT';
  error?: string;
  value?: T;
}
