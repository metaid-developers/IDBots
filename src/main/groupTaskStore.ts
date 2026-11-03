/**
 * Group Task store: CRUD for group_tasks / group_task_members /
 * group_task_deliverables plus the task status state machine.
 * Structural pattern follows scheduledTaskStore.ts (wraps SqliteStore db + saveDb).
 */

import type { SqliteDatabase as Database } from './sqliteTypes';
import { normalizeRawGlobalMetaId } from './shared/globalMetaId';
import { normalizeGroupTaskMode, type GroupTaskMode } from './libs/groupTaskMode';
import {
  normalizeStaffingPlan,
  type GroupTaskStaffingPlan,
  type GroupTaskStaffingProposal,
  type GroupTaskStaffingProposalStatus,
} from './services/groupTaskStaffing';

/**
 * Canonical GlobalMetaID form when the value parses (trim + lowercase), else
 * the trimmed original so legacy non-canonical rows stay comparable. Applied
 * at every globalmetaid entry point, same normalization as the invite path.
 */
function normalizeMemberGlobalMetaId(value: unknown): string {
  return normalizeRawGlobalMetaId(value) ?? (typeof value === 'string' ? value.trim() : '');
}

export type GroupTaskStatus = 'planning' | 'executing' | 'review' | 'done' | 'cancelled';
export type GroupTaskMemberRole = 'chair' | 'worker';
export type GroupTaskMemberStatus = 'assigned' | 'working' | 'standby' | 'done' | 'unreachable';
/**
 * Deliverable ledger status. 'pending' = recorded, awaiting verification;
 * 'delivered' = pin verified on-chain (P3, v1.1 — previously stuck at
 * 'pending' even after verification); 'accepted'/'rejected' = the owner's
 * final verdict at acceptance time (never overwritten by verification).
 */
export type GroupTaskDeliverableStatus = 'pending' | 'delivered' | 'accepted' | 'rejected';

/**
 * Who moved a group task between statuses. 'chair' = the chair bot acted
 * (on-chain [STATUS:...] tag or its RPC close), 'owner' = the human owner
 * acted (UI accept/close/back-to-work), 'system' = host-internal transition
 * without a recorded actor (defaults, migration/backfill paths).
 */
export type GroupTaskStatusEventActorKind = 'chair' | 'owner' | 'system';

export interface GroupTaskStatusEventActor {
  kind: GroupTaskStatusEventActorKind;
  globalMetaId?: string | null;
  name?: string | null;
}

/** One recorded status transition (P1-5: who/when/from/to). */
export interface GroupTaskStatusEvent {
  id: number;
  taskId: number;
  fromStatus: GroupTaskStatus;
  toStatus: GroupTaskStatus;
  actorKind: GroupTaskStatusEventActorKind;
  actorGlobalMetaId: string | null;
  actorName: string | null;
  /** sqlite datetime('now') text, UTC. */
  createdAt: string | null;
}

export interface UpdateGroupTaskStatusOptions {
  /** Recorded in group_task_status_events; defaults to a 'system' actor. */
  actor?: GroupTaskStatusEventActor;
}

/**
 * Human-in-the-loop checkpoint status. 'open' = the task is paused waiting for
 * the owner's decision; 'resolved' = the chair closed it with a decision and
 * work continued (or it was superseded, e.g. by review entry); 'cancelled' =
 * the task closed while the checkpoint was still open.
 */
export type GroupTaskCheckpointStatus = 'open' | 'resolved' | 'cancelled';

/**
 * One mid-task human-in-the-loop pause point. The chair opens it with a
 * `[CHECKPOINT: <topic>]` group message and resolves it with
 * `[CHECKPOINT_RESOLVED: <decision>]`; multiple checkpoints may exist per task
 * over its lifetime, but at most one is 'open' at a time. The task status
 * state machine is deliberately NOT extended for this — a checkpoint pauses
 * the daemon's responder gating, not the lifecycle.
 */
export interface GroupTaskCheckpoint {
  id: number;
  taskId: number;
  /** What the owner is asked to review/confirm (from the tag). */
  topic: string | null;
  /** Pin of the chair message that opened the checkpoint. */
  openedMsgPinId: string | null;
  status: GroupTaskCheckpointStatus;
  /** The owner's decision as summarized by the chair on resolution. */
  resolution: string | null;
  /** Pin of the chair message that resolved the checkpoint. */
  resolvedMsgPinId: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
}

/** Renderer-bound broadcast payload for one real status transition. */
export interface GroupTaskStatusChangedBroadcast {
  type: 'groupTask:statusChanged';
  taskId: number;
  status: GroupTaskStatus;
  at: number;
}

/**
 * Optional renderer broadcast hook. Injected once from main.ts at startup so
 * EVERY status write (daemon tag round-trip, UI IPC, Twin RPC close/rework)
 * emits groupTask:statusChanged — previously each caller had to remember to
 * broadcast and the RPC path never did, leaving the UI stale until reload.
 */
let statusChangedBroadcaster: ((event: GroupTaskStatusChangedBroadcast) => void) | null = null;

export function setGroupTaskStoreStatusBroadcaster(
  broadcaster: ((event: GroupTaskStatusChangedBroadcast) => void) | null,
): void {
  statusChangedBroadcaster = broadcaster;
}

export interface GroupTask {
  id: number;
  orchestrationTaskId: string | null;
  groupId: string | null;
  title: string;
  goal: string;
  acceptanceCriteria: string | null;
  status: GroupTaskStatus;
  chairMetabotId: number;
  createdBy: string;
  /**
   * Round-4 (semantics): the daemon cursor — id of the LAST MESSAGE THE HOST
   * SUCCESSFULLY PROCESSED. It only advances on success; a failing message is
   * retried (bounded) and never silently skipped.
   */
  lastProcessedMsgId: number;
  /**
   * Round-4: epoch SECONDS of the host's last daemon drive (per-tick heartbeat
   * for the stall signal). null when the daemon has never driven the task.
   */
  lastDrivenAt: number | null;
  createPinId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  /** Owner acceptance rating (1-5 stars), recorded when the task is accepted. */
  rating: number | null;
  /** Optional free-text review from the owner alongside the star rating. */
  ratingComment: string | null;
  /** datetime('now') of the rating; null for unrated tasks. */
  ratedAt: string | null;
  /**
   * Local-only user-chosen display name overriding the on-chain title.
   * NULL = the chain title is shown as-is.
   */
  displayName: string | null;
  /** Local-only pinned flag (0/1); pinned tasks sort first in the list. */
  pinned: boolean;
  /**
   * Local-only archive marker (epoch ms; NULL = active). Archived tasks are
   * hidden from the UI list but fully preserved; restoring clears it.
   */
  archivedAt: number | null;
  /**
   * R2: the originating CoWork session that created this group task (so the
   * host can relay the acceptance result back on close). NULL for panel-created
   * tasks and pre-R2 rows (relay degrades to owner-private-only).
   */
  sourceSessionId: string | null;
  /**
   * G-04: epoch ms while dispatch is paused by a supervisor `pause` signal;
   * NULL = running. While set the daemon holds the planning turn and chair
   * dispatch replies; resume requires explicit owner confirmation.
   */
  dispatchPausedAt: number | null;
  /**
   * R1 (OpenTeam chat scenario): 'task' = dispatch-deliver-accept pipeline;
   * 'chat' = free-form conversation (monitoring exempt, deliverable
   * discipline off). Immutable for the life of the group; legacy rows read
   * as 'task'.
   */
  mode: GroupTaskMode;
}

export interface GroupTaskMember {
  id: number;
  taskId: number;
  metabotId: number | null;
  globalmetaid: string | null;
  role: GroupTaskMemberRole;
  joinedPinId: string | null;
  createdAt: string | null;
  /** Inviter-side name snapshot for remote members (no local metabots row). */
  displayName: string | null;
  /** Set when the member was kicked (M3); active members have NULL. */
  removedAt: string | null;
  /** On-chain /protocols/simplegroupremoveuser pin that removed the member (M3). */
  removePinId: string | null;
  /** Joined from metabots for display / mention matching (falls back to displayName for remote members). */
  name: string | null;
  /** P0-2: member state-machine status (assigned/working/standby/done/unreachable). */
  status: GroupTaskMemberStatus;
  /** P0-2: epoch-seconds (sqlite datetime) of the last status change. */
  statusChangedAt: string | null;
}

export interface GroupTaskDeliverable {
  id: number;
  taskId: number;
  msgPinId: string | null;
  authorGlobalmetaid: string | null;
  kind: string | null;
  uri: string | null;
  status: GroupTaskDeliverableStatus;
  createdAt: string | null;
  /** P0-4: JSON verification report (sources + outcomes) for a deliverable. */
  verification: string | null;
  /**
   * P2: sha256 hex of the deliverable's bytes — the same-bytes dedupe key.
   * NULL until the row is hashed (upload-time or the daemon's backfill pass).
   */
  contentHash?: string | null;
  /**
   * Issue #8: on-chain confirmation of the deliverable's pin, driven by the
   * daemon's multi-source verification (verified=true => 'confirmed'). This is
   * ORTHOGONAL to `status`: a pin can be on-chain confirmed while still
   * pending owner acceptance (status='pending', confirmation='confirmed').
   */
  confirmation: 'unconfirmed' | 'confirmed';
  /**
   * The body of the [DELIVERABLE] message that produced this row, plus its
   * sender name — joined from group_chat_messages by msg_pin_id so the UI can
   * show folded text for `text` deliverables (which carry no uri). Only
   * populated by listDeliverables (the list/detail views); other callers get
   * null because their queries do not join the message table.
   */
  sourceContent?: string | null;
  sourceSenderName?: string | null;
}

/** One transcript row for the Group Task chat view (content already decrypted). */
export interface GroupChatTranscriptMessage {
  id: number;
  pinId: string | null;
  txId: string | null;
  senderName: string | null;
  senderGlobalMetaId: string | null;
  senderAvatar: string | null;
  content: string | null;
  contentType: string | null;
  chainTimestamp: number | null;
  msgIndex: number | null;
  replyPin: string | null;
  /**
   * Round-4 attribution: true when the chain-signature GlobalMetaID could not
   * be resolved OR is neither a task member nor the owner — display-only flag,
   * the sender must never be inferred from senderName.
   */
  senderSuspect: boolean;
}

/**
 * G-04: one supervisor intervention signal (nudge / flag / pause / resume),
 * recorded from the Twin supervisor channel (metabot-group-task skill RPC).
 * Structured data, NOT a chair speech: visible in-group via a host notice,
 * auditable on the ledger, and snapshotted into the acceptance summary at
 * review entry. `processedAt` marks when the daemon drove the chair's
 * response turn (nudge/flag) or applied the host gate (pause/resume).
 */
export type GroupTaskSupervisorSignalKind = 'nudge' | 'flag' | 'pause' | 'resume';

export interface GroupTaskSupervisorSignal {
  id: number;
  taskId: number;
  kind: GroupTaskSupervisorSignalKind;
  /** The supervisor's instruction/finding text (required, capped by the RPC). */
  note: string;
  /** Roster member (name or gmid) a nudge points at; null for task-wide signals. */
  target: string | null;
  createdBy: string;
  /** Pin of the host notice that made the signal visible in-group. */
  noticePinId: string | null;
  processedAt: number | null;
  chairResponsePinId: string | null;
  createdAt: string | null;
}

/** One deliverable row inside an acceptance summary (immutable snapshot). */
export interface GroupTaskAcceptanceSummaryDeliverable {
  kind: string | null;
  uri: string | null;
  status: GroupTaskDeliverableStatus;
  confirmation: 'unconfirmed' | 'confirmed';
  authorName: string | null;
  /**
   * Body preview for text deliverables (no uri). Null for URI-bearing rows.
   * Lets a text-only task show the actual report instead of "（见消息原文）".
   */
  preview?: string | null;
}

/** One member row inside an acceptance summary (immutable snapshot). */
export interface GroupTaskAcceptanceSummaryMember {
  name: string | null;
  role: GroupTaskMemberRole;
  /** Self-reported status snapshot; host-derived workStatus is a P1/R6 concern. */
  workStatus: string;
}

/**
 * G-05: one create-time acceptance criterion judged by the chair at review.
 * 'pass'/'fail' answer the criterion as WRITTEN at create time; 'unclear' is
 * the honest middle state when the criterion genuinely cannot be verified
 * from the recorded evidence (rendered distinctly, never silently folded
 * into pass).
 */
export type GroupTaskAcceptanceCriteriaVerdictValue = 'pass' | 'fail' | 'unclear';

export interface GroupTaskAcceptanceCriteriaVerdict {
  verdict: GroupTaskAcceptanceCriteriaVerdictValue;
  /** The criterion as restated for judgment (derived from create-time criteria). */
  text: string;
}

/**
 * Host-generated, deterministic acceptance summary ("把菜端上桌"). Produced at
 * review entry (T1) and finalized on close (T2). Single source of truth for the
 * group's last review message, the owner private report, and the R2 acceptance
 * notification — all three render from the same record. version increments on
 * each review-entry regeneration (rework → review yields v2).
 */
/**
 * Speedup R-06: one status-window segment of the task timeline (planning /
 * executing / review / …), derived from group_task_status_events.
 */
export interface GroupTaskTimeBreakdownPhase {
  key: GroupTaskStatus;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
}

/** Speedup R-06: one delivery step in the executing phase (ledger-anchored). */
export interface GroupTaskTimeBreakdownStep {
  label: string;
  authorName: string | null;
  at: string;
  minutesSincePrev: number;
}

/**
 * Speedup R-06: deterministic per-phase time breakdown attached to the
 * acceptance summary at review entry — the owner no longer relies on the
 * chair hand-rebuilding the timeline from messages. All numbers are computed
 * from the message/ledger/status-event records (no LLM in the loop).
 */
export interface GroupTaskTimeBreakdown {
  generatedAt: string;
  messageTotal: number;
  /** Host liveness/heartbeat lines ([WORKING] 仍在执行中-style posts). */
  heartbeatMessages: number;
  /** heartbeatMessages / messageTotal, integer percent. */
  heartbeatSharePct: number;
  /** Minutes inside inter-message gaps that contained at least one heartbeat. */
  heartbeatPaddedGapMinutes: number;
  chairMessages: number;
  workerMessages: number;
  noticeMessages: number;
  /**
   * fix-v2 P2-7: host alert lines posted into the group ('@chair ⚠ …'),
   * split by kind, plus how many a later chair/member message marked as a
   * false alarm. Optional: records predating the field simply lack it.
   */
  alertCounts?: {
    ackTimeout: number;
    deliveryDeadline: number;
    total: number;
    falsePositives: number;
  };
  phases: GroupTaskTimeBreakdownPhase[];
  steps: GroupTaskTimeBreakdownStep[];
}

export interface GroupTaskAcceptanceSummary {
  id: number;
  taskId: number;
  version: number;
  goal: string;
  acceptanceCriteria: string | null;
  deliverables: GroupTaskAcceptanceSummaryDeliverable[];
  members: GroupTaskAcceptanceSummaryMember[];
  /**
   * Improvement #4 (v1.3): plan-change disclosures snapshotted at review entry
   * — one line each (original plan -> blocker -> fallback) from the chair's own
   * in-group [PLAN_CHANGE] resolutions. Empty array = no plan change (the
   * owner-facing block is then omitted entirely, never padded).
   */
  planChanges: string[];
  /**
   * G-05: per-criterion verdicts against the CREATE-TIME acceptance criteria,
   * extracted from the chair's owner report at review entry. Empty until
   * captured (the card then shows only the raw criteria preview as before).
   */
  criteriaVerdicts: GroupTaskAcceptanceCriteriaVerdict[];
  /**
   * G-05: findings OUTSIDE the declared criteria (e.g. "archive not
   * on-chain" when the criteria never asked for on-chain archival). Rendered as
   * non-blocking observations — they never count against a criterion verdict.
   */
  observations: string[];
  /**
   * G-04: supervisor intervention lines (nudge/flag/pause/resume) snapshotted
   * at review entry so the review record carries the full supervision trail.
   */
  supervisorSignals: string[];
  /** Deterministic acceptance guidance (3 actions). */
  guidance: string;
  /**
   * Improvement #1 (single-card acceptance): the chair's one-line conclusion
   * extracted from the owner-report narrative at review entry. The SAME string
   * headlines the Tasks acceptance card, the group summary message, and the
   * source-session notice — null until captured (card falls back to a
   * deterministic deliverable-count headline).
   */
  conclusion: string | null;
  /** T2 terminal outcome, null until the task closes. */
  outcome: GroupTaskStatus | null;
  rating: number | null;
  ratingComment: string | null;
  /**
   * Speedup R-06: deterministic per-phase time breakdown computed from the
   * message timeline at review entry (phase windows, per-step minutes,
   * heartbeat volume/share). null for summaries recorded before R-06.
   */
  timeBreakdown: GroupTaskTimeBreakdown | null;
  generatedBy: string;
  generatedAt: string | null;
  /** Pin of the group message that published this summary (review closing). */
  publishedGroupPinId: string | null;
  /** Source session that received the R2 acceptance notification, if any. */
  notifiedSession: string | null;
  /**
   * Task #83 audit (F2a): set when a review→executing rework voided this
   * already-notified summary. NULL = still authoritative; the acceptance card
   * surfaces the stamp so the owner never acts on a retracted review.
   */
  supersededAt: string | null;
}

export interface CreateGroupTaskInput {
  groupId: string;
  title: string;
  goal: string;
  acceptanceCriteria?: string | null;
  chairMetabotId: number;
  createdBy: 'user' | 'twinbot';
  createPinId?: string | null;
  /** R2: originating CoWork session (relay target on close). */
  sourceSessionId?: string | null;
  /**
   * R1 (OpenTeam chat scenario): 'task' (default) or 'chat'. Chat groups are
   * born 'executing' (a conversation has no planning phase) and are exempt
   * from task monitoring on every path that reads task.mode.
   */
  mode?: GroupTaskMode;
}

export interface AddGroupTaskMemberInput {
  taskId: number;
  metabotId: number | null;
  globalmetaid?: string | null;
  role: GroupTaskMemberRole;
  joinedPinId?: string | null;
  /** Name snapshot for remote members (metabotId === null). */
  displayName?: string | null;
}

export interface MarkGroupTaskMemberRemovedInput {
  taskId: number;
  /** Local member path (metabots row id). */
  metabotId?: number | null;
  /** Remote member path (metabot_id IS NULL rows). */
  globalmetaid?: string | null;
  /** The on-chain removeuser pin id, recorded for audit. */
  removePinId?: string | null;
}

export interface AddGroupTaskDeliverableInput {
  taskId: number;
  msgPinId?: string | null;
  authorGlobalmetaid?: string | null;
  kind?: string | null;
  uri?: string | null;
  /** P2: sha256 hex of the deliverable bytes, when known at record time. */
  contentHash?: string | null;
  /**
   * Ledger status at record time. Defaults to 'pending' (the live daemon
   * path); the one-time backfill inserts 'delivered' — the artifact is
   * verifiably on-chain, only the row was missing.
   */
  status?: GroupTaskDeliverableStatus;
}
export interface GroupTaskTransition {
  id: number;
  taskId: number;
  fromStatus: GroupTaskStatus | null;
  toStatus: GroupTaskStatus;
  actor: string | null;
  reason: string | null;
  createdAt: string | null;
}

export interface AddGroupTaskTransitionInput {
  taskId: number;
  fromStatus: GroupTaskStatus | null;
  toStatus: GroupTaskStatus;
  actor?: string | null;
  reason?: string | null;
}
export type GroupTaskIntegrityEventType = 'correction' | 'honest_report';

export interface GroupTaskIntegrityEvent {
  id: number;
  taskId: number;
  msgPinId: string | null;
  authorGlobalmetaid: string | null;
  eventType: GroupTaskIntegrityEventType;
  /** Human-readable detail (the public declaration text, capped). */
  detail: string | null;
  createdAt: string | null;
}



interface GroupTaskRow {
  id: number;
  orchestration_task_id: string | null;
  group_id: string | null;
  title: string;
  goal: string;
  acceptance_criteria: string | null;
  status: string;
  chair_metabot_id: number;
  created_by: string;
  last_processed_msg_id: number;
  last_driven_at: number | null;
  create_pin_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  rating: number | null;
  rating_comment: string | null;
  rated_at: string | null;
  display_name: string | null;
  pinned: number | null;
  archived_at: number | null;
  source_session_id: string | null;
  dispatch_paused_at: number | null;
  mode: string | null;
}

interface GroupTaskMemberRow {
  id: number;
  task_id: number;
  metabot_id: number | null;
  globalmetaid: string | null;
  role: string;
  joined_pin_id: string | null;
  created_at: string | null;
  display_name: string | null;
  removed_at: string | null;
  remove_pin_id: string | null;
  metabot_name: string | null;
  metabot_globalmetaid: string | null;
  status: string;
  status_changed_at: string | null;
}

interface GroupTaskDeliverableRow {
  id: number;
  task_id: number;
  msg_pin_id: string | null;
  author_globalmetaid: string | null;
  kind: string | null;
  uri: string | null;
  status: string;
  created_at: string | null;
  verification: string | null;
  confirmation: string | null;
  /** P2: sha256 hex of the deliverable bytes (migrated-in column). */
  content_hash?: string | null;
  /** Joined from group_chat_messages by listDeliverables only. */
  source_content?: string | null;
  source_sender_name?: string | null;
}

interface GroupTaskTransitionRow {
  id: number;
  task_id: number;
  from_status: string | null;
  to_status: string;
  actor: string | null;
  reason: string | null;
  created_at: string | null;
}

interface GroupTaskIntegrityEventRow {
  id: number;
  task_id: number;
  msg_pin_id: string | null;
  author_globalmetaid: string | null;
  event_type: string;
  detail: string | null;
  created_at: string | null;
}

interface GroupTaskStatusEventRow {
  id: number;
  task_id: number;
  from_status: string;
  to_status: string;
  actor_kind: string;
  actor_globalmetaid: string | null;
  actor_name: string | null;
  created_at: string | null;
}

interface GroupTaskCheckpointRow {
  id: number;
  task_id: number;
  topic: string | null;
  opened_msg_pin_id: string | null;
  status: string;
  resolution: string | null;
  resolved_msg_pin_id: string | null;
  created_at: string | null;
  resolved_at: string | null;
}

interface GroupTaskAcceptanceSummaryRow {
  id: number;
  task_id: number;
  version: number;
  goal: string;
  acceptance_criteria: string | null;
  deliverables_json: string;
  members_json: string;
  guidance: string;
  plan_changes_json?: string | null;
  criteria_verdicts_json?: string | null;
  observations_json?: string | null;
  supervisor_signals_json?: string | null;
  time_breakdown_json?: string | null;
  conclusion: string | null;
  outcome: string | null;
  rating: number | null;
  rating_comment: string | null;
  generated_by: string;
  generated_at: string | null;
  published_group_pin_id: string | null;
  notified_session: string | null;
  superseded_at?: string | null;
}

interface GroupTaskSupervisorSignalRow {
  id: number;
  task_id: number;
  kind: string;
  note: string;
  target: string | null;
  created_by: string;
  notice_pin_id: string | null;
  processed_at: number | null;
  chair_response_pin_id: string | null;
  created_at: string | null;
}

/**
 * Single-commander architecture: one environment observation queued for the
 * chair. Kinds are open-ended (recorded as plain strings) — emitters own
 * their vocabulary; the chair turn renders kind/target/body lines verbatim.
 */
export interface GroupTaskHostNote {
  id: number;
  taskId: number;
  kind: string;
  target: string | null;
  body: string;
  dedupeKey: string | null;
  consumedAt: number | null;
  chairResponsePinId: string | null;
  createdAt: string | null;
}

interface GroupTaskHostNoteRow {
  id: number;
  task_id: number;
  kind: string;
  target: string | null;
  body: string;
  dedupe_key: string | null;
  consumed_at: number | null;
  chair_response_pin_id: string | null;
  created_at: string | null;
}

function rowToGroupTaskHostNote(row: GroupTaskHostNoteRow): GroupTaskHostNote {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    target: row.target ?? null,
    body: row.body,
    dedupeKey: row.dedupe_key ?? null,
    consumedAt: row.consumed_at ?? null,
    chairResponsePinId: row.chair_response_pin_id ?? null,
    createdAt: row.created_at ?? null,
  };
}

function isSupervisorSignalKind(value: string): value is GroupTaskSupervisorSignalKind {
  return value === 'nudge' || value === 'flag' || value === 'pause' || value === 'resume';
}

function rowToGroupTaskSupervisorSignal(row: GroupTaskSupervisorSignalRow): GroupTaskSupervisorSignal {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: isSupervisorSignalKind(row.kind) ? row.kind : 'flag',
    note: row.note,
    target: row.target ?? null,
    createdBy: row.created_by ?? 'supervisor',
    noticePinId: row.notice_pin_id ?? null,
    processedAt: row.processed_at ?? null,
    chairResponsePinId: row.chair_response_pin_id ?? null,
    createdAt: row.created_at ?? null,
  };
}

/** Improvement #4 (v1.3): one recorded chair plan-change resolution. */
export interface GroupTaskPosition {
  id: number;
  taskId: number;
  msgPinId: string | null;
  authorGlobalmetaid: string | null;
  /** The recorded statement (objection / boundary / agreed conclusion). */
  statement: string;
  /** 1-based line number in the source message. */
  lineNo: number;
  createdAt: string | null;
}

export interface GroupTaskPlanChange {
  id: number;
  taskId: number;
  msgPinId: string | null;
  authorGlobalmetaid: string | null;
  /** One line: original plan -> blocker -> fallback, as the chair posted it. */
  summary: string;
  createdAt: string | null;
}

interface GroupTaskPositionRow {
  id: number;
  task_id: number;
  msg_pin_id: string | null;
  author_globalmetaid: string | null;
  statement: string;
  line_no: number;
  created_at: string | null;
}

function rowToGroupTaskPosition(row: GroupTaskPositionRow): GroupTaskPosition {
  return {
    id: row.id,
    taskId: row.task_id,
    msgPinId: row.msg_pin_id ?? null,
    authorGlobalmetaid: row.author_globalmetaid ?? null,
    statement: row.statement,
    lineNo: Number(row.line_no) || 1,
    createdAt: row.created_at ?? null,
  };
}

interface GroupTaskPlanChangeRow {
  id: number;
  task_id: number;
  msg_pin_id: string | null;
  author_globalmetaid: string | null;
  summary: string;
  created_at: string | null;
}

function rowToGroupTaskPlanChange(row: GroupTaskPlanChangeRow): GroupTaskPlanChange {
  return {
    id: row.id,
    taskId: row.task_id,
    msgPinId: row.msg_pin_id ?? null,
    authorGlobalmetaid: row.author_globalmetaid ?? null,
    summary: row.summary,
    createdAt: row.created_at ?? null,
  };
}

interface GroupChatTranscriptRow {
  id: number;
  pin_id: string | null;
  tx_id: string | null;
  sender_name: string | null;
  sender_global_metaid: string | null;
  sender_avatar: string | null;
  content: string | null;
  content_type: string | null;
  chain_timestamp: number | null;
  msg_index: number | null;
  reply_pin: string | null;
  sender_suspect?: number | null;
}

function rowToGroupTaskStatusEvent(row: GroupTaskStatusEventRow): GroupTaskStatusEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    fromStatus: isGroupTaskStatus(row.from_status) ? row.from_status : 'planning',
    toStatus: isGroupTaskStatus(row.to_status) ? row.to_status : 'planning',
    actorKind: row.actor_kind === 'chair' || row.actor_kind === 'owner' ? row.actor_kind : 'system',
    actorGlobalMetaId: row.actor_globalmetaid ?? null,
    actorName: row.actor_name ?? null,
    createdAt: row.created_at ?? null,
  };
}

function rowToGroupChatTranscriptMessage(row: GroupChatTranscriptRow): GroupChatTranscriptMessage {
  return {
    id: row.id,
    pinId: row.pin_id ?? null,
    txId: row.tx_id ?? null,
    senderName: row.sender_name ?? null,
    senderGlobalMetaId: row.sender_global_metaid ?? null,
    senderAvatar: row.sender_avatar ?? null,
    content: row.content ?? null,
    contentType: row.content_type ?? null,
    chainTimestamp: row.chain_timestamp ?? null,
    msgIndex: row.msg_index ?? null,
    replyPin: row.reply_pin ?? null,
    senderSuspect: Number(row.sender_suspect ?? 0) === 1,
  };
}

const TERMINAL_STATUSES: ReadonlySet<GroupTaskStatus> = new Set(['done', 'cancelled']);

/**
 * Legal transitions: planning→executing→review→done, →cancelled from any
 * non-terminal state, and review→executing as the rework hatch (the chair
 * re-opens work via [STATUS:EXECUTING] when acceptance fails). Terminal states
 * (done/cancelled) allow no further moves.
 */
const LEGAL_TRANSITIONS: Record<GroupTaskStatus, GroupTaskStatus[]> = {
  // The chair-driven flow is planning→executing→review→done, but the owner's
  // accept/close action may shortcut to 'done' from any non-terminal state.
  planning: ['executing', 'done', 'cancelled'],
  executing: ['review', 'done', 'cancelled'],
  review: ['done', 'executing', 'cancelled'],
  done: [],
  cancelled: [],
};

function isGroupTaskMemberStatus(value: string): value is GroupTaskMemberStatus {
  return value === 'assigned' || value === 'working' || value === 'standby'
    || value === 'done' || value === 'unreachable';
}

function isGroupTaskStatus(value: string): value is GroupTaskStatus {
  return value === 'planning' || value === 'executing' || value === 'review'
    || value === 'done' || value === 'cancelled';
}

function isGroupTaskCheckpointStatus(value: string): value is GroupTaskCheckpointStatus {
  return value === 'open' || value === 'resolved' || value === 'cancelled';
}

function rowToGroupTaskCheckpoint(row: GroupTaskCheckpointRow): GroupTaskCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    topic: row.topic ?? null,
    openedMsgPinId: row.opened_msg_pin_id ?? null,
    status: isGroupTaskCheckpointStatus(row.status) ? row.status : 'open',
    resolution: row.resolution ?? null,
    resolvedMsgPinId: row.resolved_msg_pin_id ?? null,
    createdAt: row.created_at ?? null,
    resolvedAt: row.resolved_at ?? null,
  };
}

function isGroupTaskStatusValue(value: unknown): value is GroupTaskStatus {
  return (
    value === 'planning'
    || value === 'executing'
    || value === 'review'
    || value === 'done'
    || value === 'cancelled'
  );
}

function rowToGroupTaskAcceptanceSummary(
  row: GroupTaskAcceptanceSummaryRow,
): GroupTaskAcceptanceSummary {
  let deliverables: GroupTaskAcceptanceSummaryDeliverable[] = [];
  try {
    const parsed = JSON.parse(row.deliverables_json) as unknown;
    if (Array.isArray(parsed)) deliverables = parsed as GroupTaskAcceptanceSummaryDeliverable[];
  } catch {
    // Malformed snapshot JSON degrades to empty; the row is never fatal.
  }
  let members: GroupTaskAcceptanceSummaryMember[] = [];
  try {
    const parsed = JSON.parse(row.members_json) as unknown;
    if (Array.isArray(parsed)) members = parsed as GroupTaskAcceptanceSummaryMember[];
  } catch {
    // Malformed snapshot JSON degrades to empty; the row is never fatal.
  }
  let planChanges: string[] = [];
  try {
    const parsed = row.plan_changes_json ? JSON.parse(row.plan_changes_json) as unknown : null;
    if (Array.isArray(parsed)) {
      planChanges = parsed.filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
    }
  } catch {
    // Malformed snapshot JSON degrades to "no plan change disclosed".
  }
  // G-05: per-criterion verdicts + non-blocking observations (degrade to empty).
  let criteriaVerdicts: GroupTaskAcceptanceCriteriaVerdict[] = [];
  try {
    const parsed = row.criteria_verdicts_json ? JSON.parse(row.criteria_verdicts_json) as unknown : null;
    if (Array.isArray(parsed)) {
      criteriaVerdicts = parsed.filter((entry): entry is GroupTaskAcceptanceCriteriaVerdict =>
        Boolean(entry)
        && typeof entry === 'object'
        && typeof (entry as GroupTaskAcceptanceCriteriaVerdict).text === 'string'
        && (entry as GroupTaskAcceptanceCriteriaVerdict).text.trim().length > 0
        && ['pass', 'fail', 'unclear'].includes(String((entry as GroupTaskAcceptanceCriteriaVerdict).verdict)));
    }
  } catch {
    // Malformed verdict JSON degrades to "not captured".
  }
  let observations: string[] = [];
  try {
    const parsed = row.observations_json ? JSON.parse(row.observations_json) as unknown : null;
    if (Array.isArray(parsed)) {
      observations = parsed.filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
    }
  } catch {
    // Malformed observations JSON degrades to empty.
  }
  // G-04: supervisor-signal snapshot lines (degrade to empty).
  let supervisorSignals: string[] = [];
  try {
    const parsed = row.supervisor_signals_json ? JSON.parse(row.supervisor_signals_json) as unknown : null;
    if (Array.isArray(parsed)) {
      supervisorSignals = parsed.filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
    }
  } catch {
    // Malformed snapshot JSON degrades to empty.
  }
  // Speedup R-06: time-breakdown snapshot (degrades to null for legacy rows).
  let timeBreakdown: GroupTaskTimeBreakdown | null = null;
  try {
    const parsed = row.time_breakdown_json ? JSON.parse(row.time_breakdown_json) as unknown : null;
    if (
      parsed
      && typeof parsed === 'object'
      && Array.isArray((parsed as GroupTaskTimeBreakdown).phases)
      && typeof (parsed as GroupTaskTimeBreakdown).messageTotal === 'number'
    ) {
      timeBreakdown = parsed as GroupTaskTimeBreakdown;
    }
  } catch {
    // Malformed breakdown JSON degrades to "not computed".
  }
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    goal: row.goal,
    acceptanceCriteria: row.acceptance_criteria ?? null,
    deliverables,
    members,
    planChanges,
    criteriaVerdicts,
    observations,
    supervisorSignals,
    timeBreakdown,
    guidance: row.guidance,
    conclusion: row.conclusion ?? null,
    outcome: isGroupTaskStatusValue(row.outcome) ? row.outcome : null,
    rating: row.rating ?? null,
    ratingComment: row.rating_comment ?? null,
    generatedBy: row.generated_by ?? 'host',
    generatedAt: row.generated_at ?? null,
    publishedGroupPinId: row.published_group_pin_id ?? null,
    notifiedSession: row.notified_session ?? null,
    supersededAt: row.superseded_at ?? null,
  };
}

function rowToGroupTask(row: GroupTaskRow): GroupTask {
  return {
    id: row.id,
    orchestrationTaskId: row.orchestration_task_id ?? null,
    groupId: row.group_id ?? null,
    title: row.title,
    goal: row.goal,
    acceptanceCriteria: row.acceptance_criteria ?? null,
    status: isGroupTaskStatus(row.status) ? row.status : 'planning',
    chairMetabotId: row.chair_metabot_id,
    createdBy: row.created_by,
    lastProcessedMsgId: row.last_processed_msg_id ?? 0,
    lastDrivenAt: row.last_driven_at ?? null,
    createPinId: row.create_pin_id ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    closedAt: row.closed_at ?? null,
    rating: row.rating ?? null,
    ratingComment: row.rating_comment ?? null,
    ratedAt: row.rated_at ?? null,
    displayName: row.display_name ?? null,
    pinned: Boolean(row.pinned),
    archivedAt: row.archived_at ?? null,
    sourceSessionId: row.source_session_id ?? null,
    dispatchPausedAt: row.dispatch_paused_at ?? null,
    mode: normalizeGroupTaskMode(row.mode),
  };
}

function rowToGroupTaskMember(row: GroupTaskMemberRow): GroupTaskMember {
  return {
    id: row.id,
    taskId: row.task_id,
    metabotId: row.metabot_id ?? null,
    // Prefer the redundant member-row copy; fall back to the metabots table.
    globalmetaid: row.globalmetaid ?? row.metabot_globalmetaid ?? null,
    role: row.role === 'chair' ? 'chair' : 'worker',
    joinedPinId: row.joined_pin_id ?? null,
    createdAt: row.created_at ?? null,
    displayName: row.display_name ?? null,
    removedAt: row.removed_at ?? null,
    removePinId: row.remove_pin_id ?? null,
    // Local members get the metabots-table name; remote members fall back to
    // the display_name snapshot recorded at invite time.
    name: row.metabot_name ?? row.display_name ?? null,
    // P0-2: default status — chair starts 'working', workers 'assigned'. Old
    // rows without a status column default the same way.
    status: isGroupTaskMemberStatus(row.status)
      ? row.status
      : (row.role === 'chair' ? 'working' : 'assigned'),
    statusChangedAt: row.status_changed_at ?? null,
  };
}

function rowToGroupTaskIntegrityEvent(row: GroupTaskIntegrityEventRow): GroupTaskIntegrityEvent {
  const type = row.event_type === 'honest_report' ? 'honest_report' : 'correction';
  return {
    id: row.id,
    taskId: row.task_id,
    msgPinId: row.msg_pin_id ?? null,
    authorGlobalmetaid: row.author_globalmetaid ?? null,
    eventType: type,
    detail: row.detail ?? null,
    createdAt: row.created_at ?? null,
  };
}

function rowToGroupTaskTransition(row: GroupTaskTransitionRow): GroupTaskTransition {
  const from = row.from_status;
  const to = row.to_status;
  return {
    id: row.id,
    taskId: row.task_id,
    fromStatus: from && isGroupTaskStatus(from) ? from : null,
    toStatus: isGroupTaskStatus(to) ? to : 'planning',
    actor: row.actor ?? null,
    reason: row.reason ?? null,
    createdAt: row.created_at ?? null,
  };
}

function rowToGroupTaskDeliverable(row: GroupTaskDeliverableRow): GroupTaskDeliverable {
  const status = row.status;
  return {
    id: row.id,
    taskId: row.task_id,
    msgPinId: row.msg_pin_id ?? null,
    authorGlobalmetaid: row.author_globalmetaid ?? null,
    kind: row.kind ?? null,
    uri: row.uri ?? null,
    // P3 (v1.1): 'delivered' = pin verified on-chain; anything unknown keeps
    // reading as 'pending' so a corrupt row can never masquerade as accepted.
    status: status === 'accepted' || status === 'rejected' || status === 'delivered'
      ? status
      : 'pending',
    createdAt: row.created_at ?? null,
    verification: row.verification ?? null,
    contentHash: row.content_hash ?? null,
    confirmation: row.confirmation === 'confirmed' ? 'confirmed' : 'unconfirmed',
    sourceContent: row.source_content ?? null,
    sourceSenderName: row.source_sender_name ?? null,
  };
}

export class GroupTaskStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
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

  /** Must be called immediately after an INSERT, before saveDb. */
  private lastInsertId(): number {
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const rawId = result[0]?.values?.[0]?.[0];
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`last_insert_rowid returned invalid id (raw=${JSON.stringify(rawId)})`);
    }
    return id;
  }

  // --- group_tasks ---

  createTask(input: CreateGroupTaskInput): GroupTask {
    const mode = normalizeGroupTaskMode(input.mode);
    // R1: a chat group is born 'executing' — a conversation has no planning
    // phase and no kickoff ceremony; lifecycle tags stay optional.
    const initialStatus = mode === 'chat' ? 'executing' : 'planning';
    this.db.run(
      `INSERT INTO group_tasks (
        group_id, title, goal, acceptance_criteria, status, chair_metabot_id, created_by,
        last_processed_msg_id, create_pin_id, source_session_id, mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        input.groupId,
        input.title,
        input.goal,
        input.acceptanceCriteria ?? null,
        initialStatus,
        input.chairMetabotId,
        input.createdBy,
        input.createPinId ?? null,
        input.sourceSessionId?.trim() || null,
        mode,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const task = this.getTaskById(id);
    if (!task) throw new Error(`createTask failed: task ${id} not found after insert`);
    // Birth is a list-visible event: the sidebar only upserts on
    // groupTask:statusChanged (or a full list reload). Without this emit a
    // Twin-created task stays invisible until the owner clicks Group Tasks.
    this.emitStatusChanged(id, task.status);
    return task;
  }

  getTaskById(id: number): GroupTask | null {
    const row = this.getOne<GroupTaskRow>('SELECT * FROM group_tasks WHERE id = ?', [id]);
    return row ? rowToGroupTask(row) : null;
  }

  getTaskByGroupId(groupId: string): GroupTask | null {
    const row = this.getOne<GroupTaskRow>('SELECT * FROM group_tasks WHERE group_id = ?', [groupId]);
    return row ? rowToGroupTask(row) : null;
  }

  /**
   * Bind the transport-facing Group Task to its canonical orchestration task.
   * The relationship is immutable once established so retries cannot silently
   * project one group onto a different owner task.
   */
  linkOrchestrationTask(id: number, orchestrationTaskId: string): GroupTask {
    const task = this.getTaskById(id);
    if (!task) throw new Error(`Group task ${id} not found`);
    const canonicalId = orchestrationTaskId.trim();
    if (!canonicalId) throw new Error('orchestrationTaskId is required');
    if (task.orchestrationTaskId && task.orchestrationTaskId !== canonicalId) {
      throw new Error(`Group task ${id} is already linked to orchestration task ${task.orchestrationTaskId}`);
    }
    if (task.orchestrationTaskId === canonicalId) return task;
    this.db.run(
      `UPDATE group_tasks
       SET orchestration_task_id = ?, updated_at = datetime('now')
       WHERE id = ? AND orchestration_task_id IS NULL`,
      [canonicalId, id],
    );
    this.saveDb();
    const linked = this.getTaskById(id);
    if (!linked || linked.orchestrationTaskId !== canonicalId) {
      throw new Error(`Failed to link group task ${id} to orchestration task ${canonicalId}`);
    }
    return linked;
  }

  /**
   * List tasks. `includeArchived` defaults to TRUE so internal callers
   * (daemon drive, experience backfill) keep seeing every task — archiving is
   * a UI-hiding concept, not a lifecycle one. The IPC list surface passes
   * includeArchived: false to exclude archived tasks and sort pinned first.
   */
  listTasks(filter?: { status?: GroupTaskStatus; includeArchived?: boolean }): GroupTask[] {
    const includeArchived = filter?.includeArchived !== false;
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (!includeArchived) {
      clauses.push('archived_at IS NULL');
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderSql = includeArchived ? 'ORDER BY id DESC' : 'ORDER BY pinned DESC, id DESC';
    const rows = this.getAll<GroupTaskRow>(
      `SELECT * FROM group_tasks ${whereSql} ${orderSql}`,
      params,
    );
    return rows.map(rowToGroupTask);
  }

  /** Set the local pinned flag (pinned tasks sort first in the UI list). */
  setTaskPinned(id: number, pinned: boolean): void {
    this.db.run('UPDATE group_tasks SET pinned = ?, updated_at = datetime(\'now\') WHERE id = ?', [
      pinned ? 1 : 0,
      id,
    ]);
    this.saveDb();
  }

  /**
   * Set the local display name (overrides the on-chain title in the UI).
   * Empty input clears the override back to the chain title.
   */
  renameTask(id: number, displayName: string): void {
    const normalized = displayName.trim() || null;
    this.db.run('UPDATE group_tasks SET display_name = ?, updated_at = datetime(\'now\') WHERE id = ?', [
      normalized,
      id,
    ]);
    this.saveDb();
  }

  /**
   * Archive a task: it disappears from the UI list, but the task and all its
   * records are preserved (messages, members, deliverables) and the daemon
   * keeps driving it. Archiving — not deletion — is the user-facing way to
   * put a task away, matching cowork session archiving.
   */
  archiveTask(id: number): void {
    this.db.run('UPDATE group_tasks SET archived_at = ?, updated_at = datetime(\'now\') WHERE id = ?', [
      Date.now(),
      id,
    ]);
    this.saveDb();
  }

  unarchiveTask(id: number): void {
    this.db.run('UPDATE group_tasks SET archived_at = NULL, updated_at = datetime(\'now\') WHERE id = ?', [
      id,
    ]);
    this.saveDb();
  }

  /** Archived tasks, newest archive first (Settings restore panel). */
  listArchivedTasks(options?: { offset?: number; limit?: number }): GroupTask[] {
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));
    const limit = Math.max(1, Math.floor(options?.limit ?? 50));
    const rows = this.getAll<GroupTaskRow>(
      'SELECT * FROM group_tasks WHERE archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows.map(rowToGroupTask);
  }

  countArchivedTasks(): number {
    const row = this.getOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM group_tasks WHERE archived_at IS NOT NULL',
    );
    return row?.n ?? 0;
  }

  /**
   * Transition a task to `nextStatus`, enforcing the state machine.
   * Throws on illegal transitions. Sets closed_at when entering a terminal state.
   * Every REAL transition (before !== next) is recorded in
   * group_task_status_events with the given actor (P1-5 status-transition log);
   * a recording failure never breaks the transition itself.
   */
  updateTaskStatus(
    id: number,
    nextStatus: GroupTaskStatus,
    opts?: UpdateGroupTaskStatusOptions,
  ): GroupTask {
    const task = this.getTaskById(id);
    if (!task) throw new Error(`Group task ${id} not found`);
    if (task.status === nextStatus) return task;
    const legal = LEGAL_TRANSITIONS[task.status] ?? [];
    if (!legal.includes(nextStatus)) {
      throw new Error(
        `Illegal group task status transition: ${task.status} -> ${nextStatus} (task ${id})`,
      );
    }
    const beforeStatus = task.status;
    if (TERMINAL_STATUSES.has(nextStatus)) {
      this.db.run(
        `UPDATE group_tasks SET status = ?, updated_at = datetime('now'), closed_at = datetime('now') WHERE id = ?`,
        [nextStatus, id],
      );
    } else {
      this.db.run(
        `UPDATE group_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`,
        [nextStatus, id],
      );
    }
    this.saveDb();
    const updated = this.getTaskById(id);
    if (!updated) throw new Error(`Group task ${id} not found after status update`);
    this.recordStatusEvent(id, beforeStatus, nextStatus, opts?.actor);
    this.emitStatusChanged(id, nextStatus);
    return updated;
  }

  /** Broadcast one real transition to the renderer; a broadcast failure never breaks the transition. */
  private emitStatusChanged(id: number, nextStatus: GroupTaskStatus): void {
    try {
      statusChangedBroadcaster?.({
        type: 'groupTask:statusChanged',
        taskId: id,
        status: nextStatus,
        at: Date.now(),
      });
    } catch (error) {
      console.warn('GroupTaskStore.emitStatusChanged:', error);
    }
  }

  /** Insert one status-transition event row (best-effort, never throws). */
  private recordStatusEvent(
    taskId: number,
    fromStatus: GroupTaskStatus,
    toStatus: GroupTaskStatus,
    actor?: GroupTaskStatusEventActor,
  ): void {
    try {
      this.db.run(
        `INSERT INTO group_task_status_events (task_id, from_status, to_status, actor_kind, actor_globalmetaid, actor_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          taskId,
          fromStatus,
          toStatus,
          actor?.kind ?? 'system',
          actor?.globalMetaId?.trim() || null,
          actor?.name?.trim() || null,
        ],
      );
      this.saveDb();
    } catch (error) {
      console.warn(
        `Failed to record status event for group task ${taskId} (${fromStatus} -> ${toStatus}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Status transition history for one task, newest first (P1-5). */
  listStatusEvents(taskId: number, opts?: { limit?: number }): GroupTaskStatusEvent[] {
    const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 100)));
    const rows = this.getAll<GroupTaskStatusEventRow>(
      `SELECT id, task_id, from_status, to_status, actor_kind, actor_globalmetaid, actor_name, created_at
       FROM group_task_status_events
       WHERE task_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [taskId, limit],
    );
    return rows.map(rowToGroupTaskStatusEvent);
  }

  isTerminalStatus(status: GroupTaskStatus): boolean {
    return TERMINAL_STATUSES.has(status);
  }

  // --- group_task_checkpoints (human-in-the-loop) ---

  /**
   * Open a HITL checkpoint for a task. At most ONE checkpoint may be open per
   * task at any moment — throws when one is already open (the daemon checks
   * getOpenCheckpoint first; this is the defensive backstop).
   */
  openCheckpoint(input: { taskId: number; topic?: string | null; msgPinId?: string | null }): GroupTaskCheckpoint {
    const existing = this.getOpenCheckpoint(input.taskId);
    if (existing) {
      throw new Error(
        `Group task ${input.taskId} already has an open checkpoint (#${existing.id}); resolve it before opening another`,
      );
    }
    this.db.run(
      `INSERT INTO group_task_checkpoints (task_id, topic, opened_msg_pin_id, status)
       VALUES (?, ?, ?, 'open')`,
      [input.taskId, input.topic?.trim() || null, input.msgPinId?.trim() || null],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const checkpoint = this.getCheckpointById(id);
    if (!checkpoint) throw new Error(`openCheckpoint failed: checkpoint ${id} not found after insert`);
    return checkpoint;
  }

  getCheckpointById(id: number): GroupTaskCheckpoint | null {
    const row = this.getOne<GroupTaskCheckpointRow>(
      'SELECT * FROM group_task_checkpoints WHERE id = ?',
      [id],
    );
    return row ? rowToGroupTaskCheckpoint(row) : null;
  }

  /** The task's currently open checkpoint, if any (at most one by construction). */
  getOpenCheckpoint(taskId: number): GroupTaskCheckpoint | null {
    const row = this.getOne<GroupTaskCheckpointRow>(
      `SELECT * FROM group_task_checkpoints
       WHERE task_id = ? AND status = 'open'
       ORDER BY id DESC LIMIT 1`,
      [taskId],
    );
    return row ? rowToGroupTaskCheckpoint(row) : null;
  }

  /**
   * Resolve an open checkpoint with the owner's decision (summarized by the
   * chair). Idempotent: an already-closed checkpoint is returned unchanged.
   */
  resolveCheckpoint(
    id: number,
    input?: { resolution?: string | null; msgPinId?: string | null },
  ): GroupTaskCheckpoint {
    const checkpoint = this.getCheckpointById(id);
    if (!checkpoint) throw new Error(`Group task checkpoint ${id} not found`);
    if (checkpoint.status !== 'open') return checkpoint;
    this.db.run(
      `UPDATE group_task_checkpoints
       SET status = 'resolved', resolution = ?, resolved_msg_pin_id = ?, resolved_at = datetime('now')
       WHERE id = ? AND status = 'open'`,
      [input?.resolution?.trim() || null, input?.msgPinId?.trim() || null, id],
    );
    this.saveDb();
    return this.getCheckpointById(id)!;
  }

  /**
   * Bulk-close every open checkpoint of a task (review entry supersedes an
   * open checkpoint; task close cancels one). Returns the number closed.
   */
  closeOpenCheckpoints(
    taskId: number,
    status: 'resolved' | 'cancelled',
    note?: string | null,
  ): number {
    const open = this.listCheckpoints(taskId).filter((checkpoint) => checkpoint.status === 'open');
    if (open.length === 0) return 0;
    this.db.run(
      `UPDATE group_task_checkpoints
       SET status = ?, resolution = COALESCE(?, resolution), resolved_at = datetime('now')
       WHERE task_id = ? AND status = 'open'`,
      [status, note?.trim() || null, taskId],
    );
    this.saveDb();
    return open.length;
  }

  /** All checkpoints of a task, oldest first (the task's HITL audit trail). */
  listCheckpoints(taskId: number): GroupTaskCheckpoint[] {
    const rows = this.getAll<GroupTaskCheckpointRow>(
      'SELECT * FROM group_task_checkpoints WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskCheckpoint);
  }

  // --- group_task_acceptance_summaries (R1 验收总结) ---

  /**
   * Persist a new acceptance-summary version for the task. version is assigned
   * as latest+1 so rework→review yields v2, v3… (T1 regeneration). The group
   * message's published pin and the R2 notified session are recorded later via
   * the dedicated updaters (the post/cross-session insert happens after the
   * row exists). Callers pass the already-rendered guidance + snapshots so the
   * aggregator (a pure function) stays the single text-rendering authority.
   */
  saveAcceptanceSummary(input: {
    taskId: number;
    goal: string;
    acceptanceCriteria?: string | null;
    deliverables: GroupTaskAcceptanceSummaryDeliverable[];
    members: GroupTaskAcceptanceSummaryMember[];
    guidance: string;
    /** Improvement #4 (v1.3): plan-change snapshot; omitted/empty stores NULL. */
    planChanges?: string[];
  }): GroupTaskAcceptanceSummary {
    const latest = this.getLatestAcceptanceSummary(input.taskId);
    const version = (latest?.version ?? 0) + 1;
    const planChanges = (input.planChanges ?? []).filter((line) => line.trim().length > 0);
    this.db.run(
      `INSERT INTO group_task_acceptance_summaries
        (task_id, version, goal, acceptance_criteria, deliverables_json, members_json, plan_changes_json, guidance, generated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'host')`,
      [
        input.taskId,
        version,
        input.goal,
        input.acceptanceCriteria?.trim() || null,
        JSON.stringify(input.deliverables),
        JSON.stringify(input.members),
        planChanges.length > 0 ? JSON.stringify(planChanges) : null,
        input.guidance,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const saved = this.getAcceptanceSummaryById(id);
    if (!saved) throw new Error(`saveAcceptanceSummary failed: summary ${id} not found after insert`);
    return saved;
  }

  private getAcceptanceSummaryById(id: number): GroupTaskAcceptanceSummary | null {
    const row = this.getOne<GroupTaskAcceptanceSummaryRow>(
      'SELECT * FROM group_task_acceptance_summaries WHERE id = ?',
      [id],
    );
    return row ? rowToGroupTaskAcceptanceSummary(row) : null;
  }

  /** Newest summary version for the task (null when none has been generated). */
  getLatestAcceptanceSummary(taskId: number): GroupTaskAcceptanceSummary | null {
    const row = this.getOne<GroupTaskAcceptanceSummaryRow>(
      `SELECT * FROM group_task_acceptance_summaries WHERE task_id = ? ORDER BY version DESC LIMIT 1`,
      [taskId],
    );
    return row ? rowToGroupTaskAcceptanceSummary(row) : null;
  }

  /** All summary versions of a task, oldest first (the acceptance audit trail). */
  listAcceptanceSummaries(taskId: number): GroupTaskAcceptanceSummary[] {
    const rows = this.getAll<GroupTaskAcceptanceSummaryRow>(
      'SELECT * FROM group_task_acceptance_summaries WHERE task_id = ? ORDER BY version ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskAcceptanceSummary);
  }

  /**
   * Task #83 audit (F2a): a review→executing rework voids every summary the
   * owner was already notified about (outcome still null). Stamp them
   * superseded so the acceptance card and the audit trail show the
   * retraction instead of presenting a stale review as current. Returns the
   * superseded versions (empty when nothing was open — e.g. rework before
   * the first summary). Idempotent: already-stamped rows are untouched.
   */
  supersedeOpenAcceptanceSummaries(taskId: number): number[] {
    const open = this.getAll<{ id: number; version: number }>(
      `SELECT id, version FROM group_task_acceptance_summaries
       WHERE task_id = ? AND outcome IS NULL AND superseded_at IS NULL`,
      [taskId],
    );
    if (open.length === 0) return [];
    this.db.run(
      `UPDATE group_task_acceptance_summaries SET superseded_at = datetime('now')
       WHERE task_id = ? AND outcome IS NULL AND superseded_at IS NULL`,
      [taskId],
    );
    this.saveDb();
    return open.map((row) => row.version);
  }

  /** Record the pin of the group message that published the latest summary. */
  updateAcceptanceSummaryPublishedPin(taskId: number, pinId: string): void {
    this.db.run(
      `UPDATE group_task_acceptance_summaries SET published_group_pin_id = ?
       WHERE id = (SELECT id FROM group_task_acceptance_summaries
                   WHERE task_id = ? ORDER BY version DESC LIMIT 1)`,
      [pinId, taskId],
    );
    this.saveDb();
  }

  /** Record that the R2 acceptance notification reached this source session. */
  updateAcceptanceSummaryNotifiedSession(taskId: number, sessionId: string): void {
    this.db.run(
      `UPDATE group_task_acceptance_summaries SET notified_session = ?
       WHERE id = (SELECT id FROM group_task_acceptance_summaries
                   WHERE task_id = ? ORDER BY version DESC LIMIT 1)`,
      [sessionId, taskId],
    );
    this.saveDb();
  }

  /**
   * Improvement #1 (single-card acceptance): stamp the chair's one-line
   * conclusion onto the LATEST summary version (= this review entry), making
   * the stored record the single authoritative copy. No-op when no summary
   * row exists; an empty conclusion is normalized to null.
   */
  updateAcceptanceSummaryConclusion(taskId: number, conclusion: string | null): void {
    const trimmed = (conclusion ?? '').trim();
    this.db.run(
      `UPDATE group_task_acceptance_summaries SET conclusion = ?
       WHERE id = (SELECT id FROM group_task_acceptance_summaries
                   WHERE task_id = ? ORDER BY version DESC LIMIT 1)`,
      [trimmed || null, taskId],
    );
    this.saveDb();
  }

  /**
   * G-05: stamp the per-criterion verdicts (against the create-time acceptance
   * criteria) and the non-blocking observations extracted from the chair's
   * owner report onto the LATEST summary version, mirroring the conclusion
   * stamp. Empty inputs normalize to NULL (not captured).
   */
  updateAcceptanceSummaryCriteriaVerdicts(
    taskId: number,
    verdicts: GroupTaskAcceptanceCriteriaVerdict[],
    observations: string[],
  ): void {
    const cleanVerdicts = verdicts.filter((entry) => entry.text.trim().length > 0);
    const cleanObservations = observations.filter((line) => line.trim().length > 0);
    this.db.run(
      `UPDATE group_task_acceptance_summaries
       SET criteria_verdicts_json = ?, observations_json = ?
       WHERE id = (SELECT id FROM group_task_acceptance_summaries
                   WHERE task_id = ? ORDER BY version DESC LIMIT 1)`,
      [
        cleanVerdicts.length > 0 ? JSON.stringify(cleanVerdicts) : null,
        cleanObservations.length > 0 ? JSON.stringify(cleanObservations) : null,
        taskId,
      ],
    );
    this.saveDb();
  }

  // --- G-04: supervisor intervention ledger + dispatch pause gate ---

  /** G-04: set/clear the dispatch pause gate (epoch ms; null resumes). */
  setTaskDispatchPausedAt(taskId: number, pausedAt: number | null): void {
    this.db.run(
      'UPDATE group_tasks SET dispatch_paused_at = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [pausedAt, taskId],
    );
    this.saveDb();
  }

  /** G-04: record one supervisor signal; returns the persisted row. */
  addSupervisorSignal(input: {
    taskId: number;
    kind: GroupTaskSupervisorSignalKind;
    note: string;
    target?: string | null;
    createdBy?: string;
    noticePinId?: string | null;
  }): GroupTaskSupervisorSignal {
    const note = input.note.trim();
    if (!note) throw new Error('supervisor signal note must not be empty');
    this.db.run(
      `INSERT INTO group_task_supervisor_signals
        (task_id, kind, note, target, created_by, notice_pin_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.kind,
        note,
        input.target?.trim() || null,
        input.createdBy?.trim() || 'supervisor',
        input.noticePinId ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskSupervisorSignalRow>(
      'SELECT * FROM group_task_supervisor_signals WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`addSupervisorSignal failed: signal ${id} not found after insert`);
    return rowToGroupTaskSupervisorSignal(row);
  }

  /** G-04: all supervisor signals of a task, oldest first (audit trail). */
  listSupervisorSignals(taskId: number): GroupTaskSupervisorSignal[] {
    const rows = this.getAll<GroupTaskSupervisorSignalRow>(
      'SELECT * FROM group_task_supervisor_signals WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskSupervisorSignal);
  }

  /** G-04: signals the daemon has not yet driven a chair response for. */
  listPendingSupervisorSignals(taskId: number): GroupTaskSupervisorSignal[] {
    const rows = this.getAll<GroupTaskSupervisorSignalRow>(
      'SELECT * FROM group_task_supervisor_signals WHERE task_id = ? AND processed_at IS NULL ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskSupervisorSignal);
  }

  /** G-04: mark signals processed with the chair response pin (null = host-applied). */
  markSupervisorSignalsProcessed(ids: number[], chairResponsePinId: string | null): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.run(
      `UPDATE group_task_supervisor_signals
       SET processed_at = ?, chair_response_pin_id = ?
       WHERE id IN (${placeholders})`,
      [Date.now(), chairResponsePinId, ...ids],
    );
    this.saveDb();
  }

  // --- Single-commander architecture: host→chair environment notes ---

  /**
   * Record one environment observation for the chair. Dedupes on
   * (task_id, dedupe_key) while unconsumed — a repeat bell (a monitor firing
   * every tick) refreshes nothing; the first pending copy is delivered and
   * the dedupe guard re-arms once consumed.
   */
  recordHostNote(input: {
    taskId: number;
    kind: string;
    body: string;
    target?: string | null;
    dedupeKey?: string | null;
  }): GroupTaskHostNote | null {
    const body = input.body.trim();
    if (!body) return null;
    const dedupeKey = input.dedupeKey?.trim() || null;
    if (dedupeKey) {
      const existing = this.getOne<GroupTaskHostNoteRow>(
        `SELECT * FROM group_task_host_notes
         WHERE task_id = ? AND dedupe_key = ? AND consumed_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        [input.taskId, dedupeKey],
      );
      if (existing) return rowToGroupTaskHostNote(existing);
    }
    this.db.run(
      `INSERT INTO group_task_host_notes (task_id, kind, target, body, dedupe_key)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.kind.trim() || 'info',
        input.target?.trim() || null,
        body,
        dedupeKey,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskHostNoteRow>(
      'SELECT * FROM group_task_host_notes WHERE id = ?',
      [id],
    );
    return row ? rowToGroupTaskHostNote(row) : null;
  }

  /** Environment notes not yet delivered to a chair turn, oldest first. */
  listPendingHostNotes(taskId: number): GroupTaskHostNote[] {
    const rows = this.getAll<GroupTaskHostNoteRow>(
      `SELECT * FROM group_task_host_notes
       WHERE task_id = ? AND consumed_at IS NULL ORDER BY id ASC`,
      [taskId],
    );
    return rows.map(rowToGroupTaskHostNote);
  }

  /**
   * Mark notes consumed once a chair turn has carried them (a null pin means
   * the chair saw them and chose [NO_REPLY] — still a decision, still done).
   */
  markHostNotesConsumed(ids: number[], chairResponsePinId: string | null): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.run(
      `UPDATE group_task_host_notes
       SET consumed_at = ?, chair_response_pin_id = ?
       WHERE id IN (${placeholders})`,
      [Date.now(), chairResponsePinId, ...ids],
    );
    this.saveDb();
  }

  /**
   * G-04: one-line renders of every supervisor signal, for the acceptance
   * summary snapshot at review entry (the review record).
   */
  listSupervisorSignalLines(taskId: number): string[] {
    return this.listSupervisorSignals(taskId).map((signal) => {
      const target = signal.target?.trim();
      const prefix = target ? `[${signal.kind.toUpperCase()} → ${target}]` : `[${signal.kind.toUpperCase()}]`;
      // Acceptance record must show whether the daemon already drove the
      // chair's response to each signal (pause/resume are host-applied on
      // record, so they read processed immediately).
      const processed = signal.processedAt != null
        ? `; processed${signal.chairResponsePinId ? ` (chair response ${signal.chairResponsePinId})` : ''}`
        : '; unprocessed';
      return `${prefix} ${signal.note}${processed}`;
    });
  }

  /** G-04: snapshot supervisor signal lines onto the LATEST acceptance summary. */
  updateAcceptanceSummarySupervisorSignals(taskId: number, lines: string[]): void {
    const clean = lines.filter((line) => line.trim().length > 0);
    this.db.run(
      `UPDATE group_task_acceptance_summaries SET supervisor_signals_json = ?
       WHERE id = (SELECT id FROM group_task_acceptance_summaries
                   WHERE task_id = ? ORDER BY version DESC LIMIT 1)`,
      [clean.length > 0 ? JSON.stringify(clean) : null, taskId],
    );
    this.saveDb();
  }

  /**
   * Speedup R-06: stamp the latest summary with the deterministic time
   * breakdown computed from the message timeline at review entry.
   */
  updateAcceptanceSummaryTimeBreakdown(taskId: number, breakdown: GroupTaskTimeBreakdown | null): void {
    this.db.run(
      `UPDATE group_task_acceptance_summaries SET time_breakdown_json = ?
       WHERE id = (SELECT id FROM group_task_acceptance_summaries
                   WHERE task_id = ? ORDER BY version DESC LIMIT 1)`,
      [breakdown ? JSON.stringify(breakdown) : null, taskId],
    );
    this.saveDb();
  }

  /**
   * T2 finalization: stamp the latest summary with the terminal outcome and the
   * owner's rating. Creates a no-snapshot placeholder row if review was skipped
   * (defensive — the aggregator normally produces the row at T1). Idempotent.
   */
  finalizeAcceptanceSummary(
    taskId: number,
    input: { outcome: GroupTaskStatus; rating?: number | null; ratingComment?: string | null },
  ): GroupTaskAcceptanceSummary | null {
    const latest = this.getLatestAcceptanceSummary(taskId);
    if (!latest) return null;
    const rating = input.rating != null ? Math.max(0, Math.trunc(input.rating)) : null;
    this.db.run(
      `UPDATE group_task_acceptance_summaries
       SET outcome = ?, rating = ?, rating_comment = ?
       WHERE id = ?`,
      [input.outcome, rating, input.ratingComment?.trim() || null, latest.id],
    );
    this.saveDb();
    return this.getAcceptanceSummaryById(latest.id);
  }

  /**
   * Record the owner's acceptance rating (1-5 stars + optional comment).
   * The star rating is mandatory for acceptance and validated here (the DB has
   * no CHECK because the column was added via ALTER TABLE on existing DBs).
   * Idempotent: re-rating a task overwrites the previous rating.
   */
  updateTaskRating(id: number, rating: number, comment?: string | null): GroupTask {
    const task = this.getTaskById(id);
    if (!task) throw new Error(`Group task ${id} not found`);
    const value = Math.trunc(rating);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      throw new Error(`Group task rating must be an integer between 1 and 5 (got ${rating})`);
    }
    const text = (comment ?? '').trim();
    this.db.run(
      `UPDATE group_tasks
       SET rating = ?, rating_comment = ?, rated_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [value, text || null, id],
    );
    this.saveDb();
    const updated = this.getTaskById(id);
    if (!updated) throw new Error(`Group task ${id} not found after rating update`);
    return updated;
  }

  /** Advance the daemon cursor (monotonic: never moves backwards). */
  updateLastProcessedMsgId(id: number, msgId: number): void {
    this.db.run(
      'UPDATE group_tasks SET last_processed_msg_id = MAX(last_processed_msg_id, ?) WHERE id = ?',
      [Math.trunc(msgId), id],
    );
    this.saveDb();
  }

  /** Round-4: heartbeat of the last daemon drive (epoch seconds). */
  updateLastDrivenAt(id: number, epochSec: number): void {
    this.db.run(
      'UPDATE group_tasks SET last_driven_at = ? WHERE id = ?',
      [Math.trunc(epochSec), id],
    );
    this.saveDb();
  }

  /** group_id of every non-terminal task (backfill targets). */
  getActiveGroupIds(): string[] {
    const rows = this.getAll<{ group_id: string }>(
      `SELECT group_id FROM group_tasks
       WHERE status IN ('planning','executing','review')
         AND group_id IS NOT NULL AND TRIM(group_id) != ''`,
    );
    return rows.map((row) => row.group_id);
  }

  /**
   * Paged chat transcript for one group, ascending by id. Content is already
   * decrypted at insert time — returned as-is. Without beforeId, returns the
   * LATEST page (chat semantics); beforeId pages backwards to older rows.
   */
  listGroupChatMessages(
    groupId: string,
    opts?: { beforeId?: number; limit?: number },
  ): GroupChatTranscriptMessage[] {
    const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 50)));
    const beforeId = opts?.beforeId != null && Number.isFinite(opts.beforeId)
      ? Math.trunc(opts.beforeId)
      : null;
    const columns = `id, pin_id, tx_id, sender_name, sender_global_metaid, sender_avatar,
      content, content_type, chain_timestamp, msg_index, reply_pin, sender_suspect`;
    const rows = (beforeId != null
      ? this.getAll<GroupChatTranscriptRow>(
          `SELECT ${columns} FROM group_chat_messages
           WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
          [groupId, beforeId, limit],
        )
      : this.getAll<GroupChatTranscriptRow>(
          `SELECT ${columns} FROM group_chat_messages
           WHERE group_id = ? ORDER BY id DESC LIMIT ?`,
          [groupId, limit],
        )
    ).reverse();
    return rows.map(rowToGroupChatTranscriptMessage);
  }

  /**
   * Every chat message in this group's history carrying a [DELIVERABLE] tag
   * (case-insensitive LIKE — matches the parser's /i), oldest first, with the
   * raw fields the deliverable backfill needs. Unlike listGroupChatMessages
   * this is unpaginated: the backfill must see the task's whole history once.
   */
  listGroupChatMessagesWithDeliverableTag(groupId: string): Array<{
    pinId: string;
    senderGlobalMetaId: string | null;
    content: string | null;
  }> {
    return this.getAll<{ pin_id: string | null; sender_global_metaid: string | null; content: string | null }>(
      `SELECT pin_id, sender_global_metaid, content FROM group_chat_messages
       WHERE group_id = ? AND content LIKE '%[DELIVERABLE]%'
       ORDER BY id ASC`,
      [groupId],
    ).map((row) => ({
      pinId: String(row.pin_id ?? ''),
      senderGlobalMetaId: row.sender_global_metaid != null ? String(row.sender_global_metaid) : null,
      content: row.content != null ? String(row.content) : null,
    }));
  }

  /**
   * One transcript message by its on-chain pin id (latest row wins when the
   * pin is somehow not unique). HITL: the detail view uses this to fetch the
   * chair's [CHECKPOINT] message body that opened an open checkpoint, so the
   * banner can show what the owner must decide without paging the transcript.
   */
  getGroupChatMessageByPinId(pinId: string): GroupChatTranscriptMessage | null {
    const pin = (pinId ?? '').trim();
    if (!pin) return null;
    const columns = `id, pin_id, tx_id, sender_name, sender_global_metaid, sender_avatar,
      content, content_type, chain_timestamp, msg_index, reply_pin, sender_suspect`;
    const row = this.getOne<GroupChatTranscriptRow>(
      `SELECT ${columns} FROM group_chat_messages WHERE pin_id = ? ORDER BY id DESC LIMIT 1`,
      [pin],
    );
    return row ? rowToGroupChatTranscriptMessage(row) : null;
  }

  /**
   * Round-4 attribution: persist the GlobalMetaID resolved from the message's
   * chain-signature legacy metaid (manapi /api/info/metaid/{metaid}). The
   * chain signature is the ONLY identity source; sender_name is never used
   * for attribution.
   */
  updateMessageSenderGlobalMetaId(id: number, globalMetaId: string): void {
    this.db.run(
      'UPDATE group_chat_messages SET sender_global_metaid = ? WHERE id = ?',
      [globalMetaId.trim(), id],
    );
    this.saveDb();
  }

  /** Round-4 attribution: mark a message whose sender fails the member/owner check. */
  setMessageSenderSuspect(id: number, suspect: boolean): void {
    this.db.run(
      'UPDATE group_chat_messages SET sender_suspect = ? WHERE id = ?',
      [suspect ? 1 : 0, id],
    );
    this.saveDb();
  }

  // --- group_task_members ---

  /**
   * Add a member row, idempotently. Local members dedupe on (task_id, metabot_id)
   * (backed by the UNIQUE constraint); remote members (metabotId === null) dedupe
   * in code on (task_id, globalmetaid) among active rows, because the UNIQUE
   * constraint does not apply to NULL metabot_id. Returns the existing row when
   * the member is already present instead of throwing after a no-op insert.
   *
   * Re-join after a kick (M3): a LOCAL member whose row is already marked
   * removed is revived in place (removed_at/remove_pin_id cleared, the provided
   * joined_pin_id/display_name refreshed) because the UNIQUE constraint forbids
   * a second row. A removed REMOTE member instead gets a fresh row, keeping the
   * removed row as history.
   */
  addMember(input: AddGroupTaskMemberInput): GroupTaskMember {
    const isRemote = input.metabotId == null;
    const remoteGlobalmetaid = isRemote ? normalizeMemberGlobalMetaId(input.globalmetaid) : '';
    if (isRemote && !remoteGlobalmetaid) {
      throw new Error(`addMember failed for task ${input.taskId}: remote member requires globalmetaid`);
    }

    // Code-level pre-check: an already-present active member is returned as-is.
    const existing = isRemote
      ? this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id IS NULL AND m.globalmetaid = ? AND m.removed_at IS NULL`,
          [input.taskId, remoteGlobalmetaid],
        )
      : this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id = ?`,
          [input.taskId, input.metabotId!],
        );
    if (existing) {
      if (!isRemote && existing.removed_at) {
        // Revive the kicked local member on the same row (UNIQUE forbids a new one).
        this.db.run(
          `UPDATE group_task_members
           SET removed_at = NULL, remove_pin_id = NULL,
               joined_pin_id = COALESCE(?, joined_pin_id),
               display_name = COALESCE(?, display_name)
           WHERE id = ?`,
          [input.joinedPinId ?? null, input.displayName ?? null, existing.id],
        );
        this.saveDb();
        const revived = this.getOne<GroupTaskMemberRow>(`${MEMBER_SELECT} WHERE m.id = ?`, [existing.id]);
        if (!revived || revived.removed_at) {
          throw new Error(`addMember failed for task ${input.taskId}: member ${existing.id} not revived`);
        }
        return rowToGroupTaskMember(revived);
      }
      if (isRemote && existing.joined_pin_id == null && input.joinedPinId) {
        // P1-2: the join watcher previously created a placeholder row (or an
        // indexer-created row predated the ACCEPT); now that the join pin is
        // known, backfill it on the existing row so "already joined" is
        // readable from the member.
        this.db.run(
          `UPDATE group_task_members
           SET joined_pin_id = ?,
               display_name = COALESCE(?, display_name)
           WHERE id = ?`,
          [input.joinedPinId, input.displayName ?? null, existing.id],
        );
        this.saveDb();
        const updated = this.getOne<GroupTaskMemberRow>(`${MEMBER_SELECT} WHERE m.id = ?`, [existing.id]);
        if (updated) return rowToGroupTaskMember(updated);
      }
      return rowToGroupTaskMember(existing);
    }

    this.db.run(
      `INSERT INTO group_task_members (task_id, metabot_id, globalmetaid, role, joined_pin_id, display_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.metabotId,
        isRemote ? remoteGlobalmetaid : normalizeMemberGlobalMetaId(input.globalmetaid) || null,
        input.role,
        input.joinedPinId ?? null,
        input.displayName ?? null,
        input.role === 'chair' ? 'working' : 'assigned',
      ],
    );
    this.saveDb();
    const inserted = isRemote
      ? this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id IS NULL AND m.globalmetaid = ? AND m.removed_at IS NULL`,
          [input.taskId, remoteGlobalmetaid],
        )
      : this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id = ?`,
          [input.taskId, input.metabotId!],
        );
    if (!inserted) throw new Error(`addMember failed for task ${input.taskId}`);
    return rowToGroupTaskMember(inserted);
  }

  /**
   * Members of one task, oldest first. By default only active members are
   * returned (removed_at IS NULL); pass includeRemoved for the full history.
   */
  listMembers(taskId: number, opts?: { includeRemoved?: boolean }): GroupTaskMember[] {
    const rows = opts?.includeRemoved
      ? this.getAll<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? ORDER BY m.id ASC`,
          [taskId],
        )
      : this.getAll<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.removed_at IS NULL ORDER BY m.id ASC`,
          [taskId],
        );
    return rows.map(rowToGroupTaskMember);
  }

  /**
   * P1-1: active remote member row for one GlobalMetaID, or null. A remote row
   * with joined_pin_id NULL is a PLACEHOLDER ("invite sent, join not yet
   * confirmed") — invite_remote retries key off this to decide whether the
   * member actually blocks a re-invite.
   */
  getActiveRemoteMember(taskId: number, globalmetaid?: string | null): GroupTaskMember | null {
    const gmid = normalizeMemberGlobalMetaId(globalmetaid);
    if (!gmid) return null;
    const row = this.getOne<GroupTaskMemberRow>(
      `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id IS NULL AND m.globalmetaid = ? AND m.removed_at IS NULL`,
      [taskId, gmid],
    );
    return row ? rowToGroupTaskMember(row) : null;
  }

  /**
   * Membership check among ACTIVE rows (removed members fail the check). Local
   * members match on metabot_id; remote members (metabotId === null) match on
   * globalmetaid.
   */
  isMember(taskId: number, metabotId: number | null, globalmetaid?: string | null): boolean {
    if (metabotId == null) {
      const gmid = normalizeMemberGlobalMetaId(globalmetaid);
      if (!gmid) return false;
      const row = this.getOne<{ found: number }>(
        `SELECT 1 AS found FROM group_task_members
         WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NULL LIMIT 1`,
        [taskId, gmid],
      );
      return Boolean(row);
    }
    const row = this.getOne<{ found: number }>(
      `SELECT 1 AS found FROM group_task_members
       WHERE task_id = ? AND metabot_id = ? AND removed_at IS NULL LIMIT 1`,
      [taskId, metabotId],
    );
    return Boolean(row);
  }

  /**
   * Record the on-chain join pin. Local members match on metabot_id; remote
   * members (metabotId === null) match the active row by globalmetaid.
   */
  updateMemberJoinedPinId(
    taskId: number,
    metabotId: number | null,
    joinedPinId: string | null,
    globalmetaid?: string | null,
  ): void {
    if (metabotId == null) {
      const gmid = normalizeMemberGlobalMetaId(globalmetaid);
      if (!gmid) {
        throw new Error(`updateMemberJoinedPinId failed for task ${taskId}: remote member requires globalmetaid`);
      }
      this.db.run(
        `UPDATE group_task_members SET joined_pin_id = ?
         WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NULL`,
        [joinedPinId, taskId, gmid],
      );
      this.saveDb();
      return;
    }
    this.db.run(
      'UPDATE group_task_members SET joined_pin_id = ? WHERE task_id = ? AND metabot_id = ?',
      [joinedPinId, taskId, metabotId],
    );
    this.saveDb();
  }

  // --- P0-2: member state machine ---

  /**
   * Set a member's state-machine status with a change timestamp. Local members
   * match by metabot_id; remote members (metabotId === null) by globalmetaid.
   */
  setMemberStatus(
    taskId: number,
    metabotId: number | null,
    status: GroupTaskMemberStatus,
    globalmetaid?: string | null,
  ): GroupTaskMember | undefined {
    if (metabotId == null) {
      const gmid = (globalmetaid ?? '').trim();
      if (!gmid) throw new Error(`setMemberStatus failed for task ${taskId}: remote member requires globalmetaid`);
      this.db.run(
        `UPDATE group_task_members
         SET status = ?, status_changed_at = datetime('now')
         WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NULL`,
        [status, taskId, gmid],
      );
    } else {
      this.db.run(
        `UPDATE group_task_members
         SET status = ?, status_changed_at = datetime('now')
         WHERE task_id = ? AND metabot_id = ?`,
        [status, taskId, metabotId],
      );
    }
    this.saveDb();
    const updated = this.listMembers(taskId).find((member) =>
      metabotId == null
        ? member.globalmetaid?.trim() === (globalmetaid ?? '').trim()
        : member.metabotId === metabotId,
    );
    return updated;
  }

  /** P0-2: list members whose status is one of the given values. */
  listMembersWithStatus(taskId: number, statuses: GroupTaskMemberStatus[]): GroupTaskMember[] {
    const set = new Set(statuses);
    return this.listMembers(taskId).filter((member) => set.has(member.status));
  }

  /** P0-5: update a task's status with an optional transition-log entry (actor/reason). */
  updateTaskStatusWithLog(
    id: number,
    nextStatus: GroupTaskStatus,
    meta?: { actor?: string | null; reason?: string | null },
  ): GroupTask {
    const before = this.getTaskById(id);
    const updated = this.updateTaskStatus(id, nextStatus);
    if (before && before.status !== updated.status) {
      this.addTaskTransition({
        taskId: id,
        fromStatus: before.status,
        toStatus: updated.status,
        actor: meta?.actor ?? null,
        reason: meta?.reason ?? null,
      });
    }
    return updated;
  }

  /** P0-5: append a state-transition log row. */
  addTaskTransition(input: AddGroupTaskTransitionInput): GroupTaskTransition {
    this.db.run(
      `INSERT INTO group_task_transitions (task_id, from_status, to_status, actor, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.fromStatus ?? null,
        input.toStatus,
        input.actor ?? null,
        input.reason ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskTransitionRow>(
      'SELECT * FROM group_task_transitions WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`addTaskTransition failed: row ${id} not found after insert`);
    return rowToGroupTaskTransition(row);
  }

  /** P0-5: full transition history for one task, oldest first. */
  listTaskTransitions(taskId: number): GroupTaskTransition[] {
    const rows = this.getAll<GroupTaskTransitionRow>(
      'SELECT * FROM group_task_transitions WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskTransition);
  }

  /** P0-8: record a public integrity declaration (honest correction/report). */
  addIntegrityEvent(input: {
    taskId: number;
    msgPinId?: string | null;
    authorGlobalmetaid?: string | null;
    eventType: GroupTaskIntegrityEventType;
    detail?: string | null;
  }): GroupTaskIntegrityEvent {
    this.db.run(
      `INSERT INTO group_task_integrity_events (task_id, msg_pin_id, author_globalmetaid, event_type, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.msgPinId ?? null,
        input.authorGlobalmetaid ?? null,
        input.eventType,
        input.detail ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskIntegrityEventRow>(
      'SELECT * FROM group_task_integrity_events WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`addIntegrityEvent failed: row ${id} not found after insert`);
    return rowToGroupTaskIntegrityEvent(row);
  }

  /** P0-8: all integrity events for one task, oldest first. */
  listIntegrityEvents(taskId: number): GroupTaskIntegrityEvent[] {
    const rows = this.getAll<GroupTaskIntegrityEventRow>(
      'SELECT * FROM group_task_integrity_events WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskIntegrityEvent);
  }

  /**
   * Improvement #4 (v1.3): record one chair plan-change resolution (from a
   * [PLAN_CHANGE: ...] tag). Deduped by the caller via hasPlanChange.
   */
  /**
   * R9: record one discussion artifact ([POSITION: …] line). Deduped by
   * (task, msg pin, line no) — reprocessing a message inserts nothing.
   */
  addPosition(input: {
    taskId: number;
    msgPinId: string | null;
    authorGlobalmetaid?: string | null;
    statement: string;
    lineNo?: number;
  }): GroupTaskPosition | null {
    const statement = input.statement.trim();
    if (!statement) return null;
    const msgPinId = input.msgPinId?.trim() || null;
    // The unique index backs the dedupe: a message without a pin cannot be
    // deduped, so it is skipped rather than duplicated on every tick.
    if (!msgPinId) return null;
    const lineNo = Math.max(1, Math.trunc(input.lineNo ?? 1));
    this.db.run(
      `INSERT OR IGNORE INTO group_task_positions (
        task_id, msg_pin_id, author_globalmetaid, statement, line_no
      ) VALUES (?, ?, ?, ?, ?)`,
      [input.taskId, msgPinId, input.authorGlobalmetaid ?? null, statement, lineNo],
    );
    this.saveDb();
    const row = this.getOne<GroupTaskPositionRow>(
      'SELECT * FROM group_task_positions WHERE task_id = ? AND msg_pin_id = ? AND line_no = ?',
      [input.taskId, msgPinId, lineNo],
    );
    return row ? rowToGroupTaskPosition(row) : null;
  }

  /** R9: every recorded discussion artifact for one task (oldest first). */
  listPositions(taskId: number): GroupTaskPosition[] {
    const rows = this.getAll<GroupTaskPositionRow>(
      'SELECT * FROM group_task_positions WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskPosition);
  }

  addPlanChange(input: {
    taskId: number;
    msgPinId?: string | null;
    authorGlobalmetaid?: string | null;
    summary: string;
  }): GroupTaskPlanChange {
    this.db.run(
      `INSERT INTO group_task_plan_changes (task_id, msg_pin_id, author_globalmetaid, summary)
       VALUES (?, ?, ?, ?)`,
      [
        input.taskId,
        input.msgPinId ?? null,
        input.authorGlobalmetaid ?? null,
        input.summary,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskPlanChangeRow>(
      'SELECT * FROM group_task_plan_changes WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`addPlanChange failed: row ${id} not found after insert`);
    return rowToGroupTaskPlanChange(row);
  }

  /** Improvement #4 (v1.3): all plan changes for one task, oldest first. */
  listPlanChanges(taskId: number): GroupTaskPlanChange[] {
    const rows = this.getAll<GroupTaskPlanChangeRow>(
      'SELECT * FROM group_task_plan_changes WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskPlanChange);
  }

  /** Improvement #4 (v1.3): dedupe check — this exact line already recorded for the message pin. */
  hasPlanChange(taskId: number, msgPinId: string | null | undefined, summary: string): boolean {
    if (!msgPinId) return false;
    const row = this.getOne<{ found: number }>(
      `SELECT 1 AS found FROM group_task_plan_changes
       WHERE task_id = ? AND msg_pin_id = ? AND summary = ? LIMIT 1`,
      [taskId, msgPinId, summary],
    );
    return Boolean(row);
  }

  /** P0-8: dedupe check — an event already recorded for this message pin. */
  hasIntegrityEventWithMsgPin(taskId: number, msgPinId: string): boolean {
    const row = this.getOne<{ found: number }>(
      'SELECT 1 AS found FROM group_task_integrity_events WHERE task_id = ? AND msg_pin_id = ? LIMIT 1',
      [taskId, msgPinId],
    );
    return Boolean(row);
  }

  /**
   * Mark a member as kicked (M3): sets removed_at (+ the removeuser pin id for
   * audit) without deleting the row, so history/deliverables stay intact.
   * Local members match on metabot_id (UNIQUE guarantees one row); remote
   * members match the ACTIVE row by globalmetaid. Idempotent: an
   * already-removed member is returned as-is; a never-member throws.
   */
  markMemberRemoved(input: MarkGroupTaskMemberRemovedInput): GroupTaskMember {
    const metabotId = input.metabotId != null ? Math.trunc(Number(input.metabotId)) : null;
    const gmid = normalizeMemberGlobalMetaId(input.globalmetaid);
    if (metabotId == null && !gmid) {
      throw new Error(`markMemberRemoved failed for task ${input.taskId}: metabotId or globalmetaid is required`);
    }

    const row = metabotId != null
      ? this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id = ?`,
          [input.taskId, metabotId],
        )
      : this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id IS NULL AND m.globalmetaid = ?
           ORDER BY m.id DESC LIMIT 1`,
          [input.taskId, gmid],
        );
    if (!row) {
      const who = metabotId != null ? `metabot ${metabotId}` : `globalmetaid ${gmid}`;
      throw new Error(`markMemberRemoved failed for task ${input.taskId}: ${who} is not a member`);
    }
    if (row.removed_at) return rowToGroupTaskMember(row);

    this.db.run(
      `UPDATE group_task_members SET removed_at = strftime('%Y-%m-%d %H:%M:%f','now'), remove_pin_id = ?
       WHERE id = ? AND removed_at IS NULL`,
      [input.removePinId ?? null, row.id],
    );
    this.saveDb();
    const updated = this.getOne<GroupTaskMemberRow>(`${MEMBER_SELECT} WHERE m.id = ?`, [row.id]);
    if (!updated || !updated.removed_at) {
      throw new Error(`markMemberRemoved failed for task ${input.taskId}: member ${row.id} not removed`);
    }
    return rowToGroupTaskMember(updated);
  }

  /**
   * OpenTeam (M3/R2): true when this task has a REMOVED remote member row for
   * the GlobalMetaID. With `notBeforeMs` (epoch ms), only rows kicked at or
   * after that moment count — this distinguishes "the membership this invite
   * created was later kicked" (freeze the invite; never revive) from "an
   * older membership was kicked before this invite existed" (an explicit
   * re-invite must still be able to complete its handshake). The threshold is
   * rendered at millisecond precision (removed_at is stored with %f) so a
   * same-second kick + re-invite stays ordered correctly.
   */
  hasRemovedMember(taskId: number, globalmetaid: string, notBeforeMs?: number): boolean {
    const gmid = normalizeMemberGlobalMetaId(globalmetaid);
    if (!gmid) return false;
    const row = notBeforeMs != null && Number.isFinite(notBeforeMs)
      ? this.getOne<{ found: number }>(
          `SELECT 1 AS found FROM group_task_members
           WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NOT NULL
             AND removed_at >= strftime('%Y-%m-%d %H:%M:%f', ? / 1000.0, 'unixepoch') LIMIT 1`,
          [taskId, gmid, Math.trunc(notBeforeMs)],
        )
      : this.getOne<{ found: number }>(
          `SELECT 1 AS found FROM group_task_members
           WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NOT NULL LIMIT 1`,
          [taskId, gmid],
        );
    return Boolean(row);
  }

  // --- group_task_deliverables ---

  addDeliverable(input: AddGroupTaskDeliverableInput): GroupTaskDeliverable {
    // confirmation is written explicitly ('unconfirmed') even though the
    // schema defaults to it, so the ledger's semantics never depend on the
    // column default; the daemon flips it to 'confirmed' once multi-source
    // on-chain verification succeeds (Issue #8). status stays explicit for
    // the same reason (defaults to 'pending' — the live daemon path).
    this.db.run(
      `INSERT INTO group_task_deliverables (task_id, msg_pin_id, author_globalmetaid, kind, uri, content_hash, status, confirmation)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unconfirmed')`,
      [
        input.taskId,
        input.msgPinId ?? null,
        input.authorGlobalmetaid ?? null,
        input.kind ?? null,
        input.uri ?? null,
        input.contentHash ?? null,
        input.status ?? 'pending',
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskDeliverableRow>(
      'SELECT * FROM group_task_deliverables WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`addDeliverable failed: row ${id} not found after insert`);
    return rowToGroupTaskDeliverable(row);
  }

  listDeliverables(taskId: number): GroupTaskDeliverable[] {
    // LEFT JOIN the producing message (by msg_pin_id) so the UI can render the
    // folded body of text deliverables, which carry no uri of their own.
    const rows = this.getAll<GroupTaskDeliverableRow>(
      `SELECT d.*, m.content AS source_content, m.sender_name AS source_sender_name
       FROM group_task_deliverables AS d
       LEFT JOIN group_chat_messages AS m ON m.pin_id = d.msg_pin_id
       WHERE d.task_id = ?
       ORDER BY d.id ASC`,
      [taskId],
    );
    return rows.map(rowToGroupTaskDeliverable);
  }

  /** Code-level dedupe check for [DELIVERABLE] ingestion (no schema constraint). */
  hasDeliverableWithMsgPin(taskId: number, msgPinId: string): boolean {
    const row = this.getOne<{ found: number }>(
      'SELECT 1 AS found FROM group_task_deliverables WHERE task_id = ? AND msg_pin_id = ? LIMIT 1',
      [taskId, msgPinId],
    );
    return Boolean(row);
  }

  /**
   * Round-4: one message now carries one row PER [DELIVERABLE] tag line (a
   * message with two tag lines yields two rows), so the old whole-message
   * msg_pin_id dedupe would drop real URIs. Dedupe is per
   * (msg_pin_id, uri, kind) — identical rows from a retried message are
   * skipped, distinct tag lines are each recorded.
   */
  findDeliverableByMsgPinAndUri(
    taskId: number,
    msgPinId: string,
    uri: string | null,
    kind: string | null,
  ): GroupTaskDeliverable | undefined {
    const row = this.getOne<GroupTaskDeliverableRow>(
      `SELECT * FROM group_task_deliverables
       WHERE task_id = ? AND msg_pin_id = ? AND uri IS ? AND kind = ?
       LIMIT 1`,
      [taskId, msgPinId, uri, kind],
    );
    return row ? rowToGroupTaskDeliverable(row) : undefined;
  }

  /**
   * Speedup R-03: cross-message idempotency lookup — the EARLIEST non-rejected
   * deliverable in this task carrying the exact same URI from the SAME author.
   * The (msg_pin_id, uri) dedupe only catches a retried message; a member
   * re-delivering the same pin/metafile under a NEW message pin (EP28: the
   * same video delivered twice 3 minutes apart) is a duplicate, not a new
   * ledger row — the caller folds it into this survivor. Rejected rows are
   * excluded so a re-delivery after a rejection still records fresh (the
   * chair's rework loop stays visible). A null/empty author or URI never
   * matches (unknown provenance is not proven sameness).
   */
  findDeliverableByAuthorAndUri(
    taskId: number,
    authorGlobalmetaid: string | null | undefined,
    uri: string | null | undefined,
  ): GroupTaskDeliverable | undefined {
    const authorKey = String(authorGlobalmetaid ?? '').trim().toLowerCase();
    const uriKey = String(uri ?? '').trim();
    if (!authorKey || !uriKey) return undefined;
    const row = this.getOne<GroupTaskDeliverableRow>(
      `SELECT * FROM group_task_deliverables
       WHERE task_id = ? AND uri = ? AND status != 'rejected'
         AND LOWER(TRIM(author_globalmetaid)) = ?
       ORDER BY id ASC LIMIT 1`,
      [taskId, uriKey, authorKey],
    );
    return row ? rowToGroupTaskDeliverable(row) : undefined;
  }

  /**
   * Task #63: artifact-identity lookup for [DELIVERABLE] ingestion — the
   * EARLIEST non-rejected deliverable in this task whose uri embeds the same
   * 64-hex+i0 pinid token, regardless of author or scheme. A deliverable URI
   * names ONE on-chain artifact with ONE author (the bot that published it);
   * another member tagging the same URI (a promo citing the product, copy
   * referencing the package pin) is a citation, not a second deliverable.
   * Rejected rows are excluded so a re-delivery after rejection still records
   * fresh, mirroring findDeliverableByAuthorAndUri.
   */
  findDeliverableByPinid(
    taskId: number,
    pinidToken: string | null | undefined,
  ): GroupTaskDeliverable | undefined {
    const key = String(pinidToken ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}i0$/.test(key)) return undefined;
    const row = this.getOne<GroupTaskDeliverableRow>(
      `SELECT * FROM group_task_deliverables
       WHERE task_id = ? AND status != 'rejected' AND uri LIKE ?
       ORDER BY id ASC LIMIT 1`,
      [taskId, `%${key}%`],
    );
    return row ? rowToGroupTaskDeliverable(row) : undefined;
  }

  /**
   * P2: same-bytes dedupe lookup — the EARLIEST non-rejected deliverable in
   * this task carrying the given sha256 content hash. Rejected rows are
   * excluded so a re-delivery of already-rejected bytes is never absorbed
   * into the rejected row (the chair's rework loop must stay visible).
   *
   * release-review P2: scoped to the SAME author when one is given — member B
   * re-attaching bytes identical to member A's deliverable (a shared asset, a
   * chair-directed re-upload) is a distinct delivery that must keep its own
   * row and credit; only the same author re-delivering collapses (the
   * duplicate-pin shape this dedupe exists for). Authors compare
   * case-insensitively (GlobalMetaID convention), and a null author never
   * matches another row (unknown provenance is not proven sameness).
   */
  findDeliverableByContentHash(
    taskId: number,
    contentHash: string,
    excludeId?: number,
    authorGlobalmetaid?: string | null,
  ): GroupTaskDeliverable | undefined {
    const authorKey = authorGlobalmetaid == null ? null : String(authorGlobalmetaid).trim().toLowerCase();
    if (authorKey != null) {
      const row = excludeId == null
        ? this.getOne<GroupTaskDeliverableRow>(
            `SELECT * FROM group_task_deliverables
             WHERE task_id = ? AND content_hash = ? AND status != 'rejected'
               AND LOWER(TRIM(author_globalmetaid)) = ?
             ORDER BY id ASC LIMIT 1`,
            [taskId, contentHash, authorKey],
          )
        : this.getOne<GroupTaskDeliverableRow>(
            `SELECT * FROM group_task_deliverables
             WHERE task_id = ? AND content_hash = ? AND status != 'rejected' AND id != ?
               AND LOWER(TRIM(author_globalmetaid)) = ?
             ORDER BY id ASC LIMIT 1`,
            [taskId, contentHash, excludeId, authorKey],
          );
      return row ? rowToGroupTaskDeliverable(row) : undefined;
    }
    const row = excludeId == null
      ? this.getOne<GroupTaskDeliverableRow>(
          `SELECT * FROM group_task_deliverables
           WHERE task_id = ? AND content_hash = ? AND status != 'rejected'
           ORDER BY id ASC LIMIT 1`,
          [taskId, contentHash],
        )
      : this.getOne<GroupTaskDeliverableRow>(
          `SELECT * FROM group_task_deliverables
           WHERE task_id = ? AND content_hash = ? AND status != 'rejected' AND id != ?
           ORDER BY id ASC LIMIT 1`,
          [taskId, contentHash, excludeId],
        );
    return row ? rowToGroupTaskDeliverable(row) : undefined;
  }

  /**
   * Round-4 (show summary): last chain speak timestamp (epoch seconds) per
   * sender GlobalMetaID for one group — the summary view's member list shows
   * when each member last spoke. Senders without any timestamp are absent.
   *
   * Task #64: host-authored [GROUP_TASK_NOTICE:…] lines are posted under the
   * member's own GlobalMetaID but are NOT the member speaking (the long-turn
   * reminder, supervisor nudges). Counting them made a silent member look
   * alive — the implicit-ACK check cleared the no-ACK watch on the host's own
   * long-turn notice and the unreachable/timeout monitors kept the member
   * "fresh". They are excluded here by their ASCII protocol prefix so every
   * consumer reads genuine member speech.
   */
  getMembersLastSpeakAt(
    groupId: string,
    globalMetaIds: Array<string | null | undefined>,
  ): Map<string, number> {
    const ids = [...new Set(
      globalMetaIds
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean),
    )];
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.getAll<{ sender_global_metaid: string; last_speak_at: number }>(
      `SELECT sender_global_metaid, MAX(chain_timestamp) AS last_speak_at
       FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid IN (${placeholders})
         AND chain_timestamp IS NOT NULL
         AND content NOT LIKE '[GROUP_TASK_NOTICE:%'
       GROUP BY sender_global_metaid`,
      [groupId, ...ids],
    );
    for (const row of rows) {
      const key = String(row.sender_global_metaid ?? '').trim().toLowerCase();
      if (key) result.set(key, Number(row.last_speak_at));
    }
    return result;
  }

  /**
   * P0-2 (round 5): last chain timestamp (epoch seconds) per sender GlobalMetaID
   * of a message carrying the `[WORKING]` status tag — the durable half of the
   * worker ACK/progress protocol. The service derives the member workStatus
   * from these timestamps (fresh [WORKING] within the working window => working).
   * P2-2: prefix match — `[WORKING long-task …]` heartbeat forms count too.
   */
  getMembersWorkingAt(
    groupId: string,
    globalMetaIds: Array<string | null | undefined>,
  ): Map<string, number> {
    const ids = [...new Set(
      globalMetaIds
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean),
    )];
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.getAll<{ sender_global_metaid: string; last_working_at: number }>(
      `SELECT sender_global_metaid, MAX(chain_timestamp) AS last_working_at
       FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid IN (${placeholders})
         AND content LIKE '%[WORKING%' ESCAPE '\\'
         AND chain_timestamp IS NOT NULL
       GROUP BY sender_global_metaid`,
      [groupId, ...ids],
    );
    for (const row of rows) {
      const key = String(row.sender_global_metaid ?? '').trim().toLowerCase();
      if (key) result.set(key, Number(row.last_working_at));
    }
    return result;
  }

  /**
   * Total decrypted message count of one group — feeds the `show` detail's
   * messagesTotal so callers can page the transcript with beforeId.
   */
  countGroupChatMessages(groupId: string): number {
    const row = this.getOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM group_chat_messages WHERE group_id = ?',
      [groupId],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * OpenTeam M3: one sender's non-suspect message count in a group — feeds the
   * participation stats of collaboration impressions.
   */
  countGroupChatMessagesBySender(groupId: string, senderGlobalMetaId: string): number {
    const row = this.getOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM group_chat_messages
       WHERE group_id = ? AND LOWER(sender_global_metaid) = LOWER(?)
         AND (sender_suspect IS NULL OR sender_suspect = 0)`,
      [groupId, senderGlobalMetaId.trim()],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * P3 communication-entropy metric: stamp the task's inter-agent traffic
   * (total decrypted content bytes + message count of its on-chain group)
   * at close, so bytes-per-deliverable can be watched over time as the
   * shared culture base (hopefully) compresses coordination.
   */
  recordTaskCommStats(taskId: number, groupId: string | null): boolean {
    if (!groupId) return false;
    // CAST to BLOB: LENGTH on TEXT counts UTF-16 code units, understating
    // multibyte (Chinese) content ~3x; BLOB length is the true byte count.
    const row = this.getOne<{ bytes: number | string | null; messages: number | string | null }>(
      `SELECT SUM(LENGTH(CAST(content AS BLOB))) AS bytes, COUNT(*) AS messages
       FROM group_chat_messages WHERE group_id = ?`,
      [groupId],
    );
    this.db.run(
      `UPDATE group_tasks SET comm_total_bytes = ?, comm_message_count = ? WHERE id = ?`,
      [Number(row?.bytes ?? 0) || 0, Number(row?.messages ?? 0) || 0, taskId],
    );
    this.saveDb();
    return true;
  }

  /**
   * Task #83 audit (P6): one-time repair for legacy closes that predated
   * close-time comm stamping — closed tasks with NULL comm stats get them
   * recomputed from their group's message history. Additive and idempotent:
   * already-stamped rows are never touched, so this is safe on every boot.
   */
  backfillTaskCommStats(): number {
    const rows = this.getAll<{ id: number; group_id: string | null }>(
      `SELECT id, group_id FROM group_tasks
       WHERE status IN ('done', 'cancelled') AND comm_total_bytes IS NULL AND group_id IS NOT NULL`,
    );
    let stamped = 0;
    for (const row of rows) {
      try {
        if (this.recordTaskCommStats(row.id, row.group_id)) stamped += 1;
      } catch {
        // best-effort repair — one bad row never blocks the rest
      }
    }
    return stamped;
  }

  listRecentTaskCommStats(limit = 15): Array<{
    taskId: number;
    title: string;
    status: string;
    commTotalBytes: number | null;
    commMessageCount: number | null;
    deliverableCount: number;
    updatedAt: string | null;
  }> {
    return this.getAll<{
      id: number | string;
      title: string;
      status: string;
      comm_total_bytes: number | string | null;
      comm_message_count: number | string | null;
      deliverable_count: number | string;
      updated_at: string | null;
    }>(
      `SELECT t.id, t.title, t.status, t.comm_total_bytes, t.comm_message_count, t.updated_at,
         (SELECT COUNT(*) FROM group_task_deliverables d WHERE d.task_id = t.id) AS deliverable_count
       FROM group_tasks t
       WHERE t.status IN ('done', 'cancelled') AND t.comm_total_bytes IS NOT NULL
       ORDER BY t.updated_at DESC
       LIMIT ?`,
      [Math.min(50, Math.max(1, Math.floor(limit)))],
    ).map((row) => ({
      taskId: Number(row.id),
      title: row.title,
      status: row.status,
      commTotalBytes: row.comm_total_bytes == null ? null : Number(row.comm_total_bytes),
      commMessageCount: row.comm_message_count == null ? null : Number(row.comm_message_count),
      deliverableCount: Number(row.deliverable_count) || 0,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Round-4: in-place update of a deliverable (correction-first aggregation).
   * P2: `contentHash` is written alongside; callers that rewrite the uri
   * WITHOUT knowing the new content's hash (corrections, pinid upgrades)
   * leave it NULL so the stale hash of the superseded bytes never survives —
   * the daemon's verification pass re-hashes the new content.
   */
  updateDeliverableUri(id: number, uri: string | null, kind: string, contentHash?: string | null): void {
    this.db.run(
      'UPDATE group_task_deliverables SET uri = ?, kind = ?, content_hash = ? WHERE id = ?',
      [uri, kind, contentHash ?? null, id],
    );
    this.saveDb();
  }

  /** P2: persist the sha256 content hash computed for an existing deliverable. */
  updateDeliverableContentHash(id: number, contentHash: string | null): void {
    this.db.run(
      'UPDATE group_task_deliverables SET content_hash = ? WHERE id = ?',
      [contentHash, id],
    );
    this.saveDb();
  }

  updateDeliverableStatus(id: number, status: GroupTaskDeliverableStatus): void {
    this.db.run('UPDATE group_task_deliverables SET status = ? WHERE id = ?', [status, id]);
    this.saveDb();
  }

  /**
   * Ledger fix (#14→#16): bulk acceptance backfill for a task's deliverables.
   * Only rows currently in `fromStatus` move — a corrected/re-delivered row
   * keeps its verdict. The chair's reject (rework) marks pending rows
   * 'rejected' so the verdict is traceable; acceptance later moves the
   * remaining pending rows 'accepted'. Returns the number of rows updated.
   */
  updateDeliverablesStatusByTask(
    taskId: number,
    fromStatus: GroupTaskDeliverableStatus,
    toStatus: GroupTaskDeliverableStatus,
  ): number {
    this.db.run(
      'UPDATE group_task_deliverables SET status = ? WHERE task_id = ? AND status = ?',
      [toStatus, taskId, fromStatus],
    );
    const changes = this.db.getRowsModified?.() ?? 0;
    this.saveDb();
    return changes;
  }

  /**
   * Issue #8: the ledger's on-chain confirmation state, driven by the daemon's
   * multi-source verification (verifyPinSources). 'confirmed' means the
   * deliverable's pin is verifiably present on-chain; it is ORTHOGONAL to
   * `status` (owner acceptance). This is the chain-confirmation-driven update
   * path that keeps the ledger in sync with on-chain reality.
   */
  updateDeliverableConfirmation(id: number, confirmation: 'unconfirmed' | 'confirmed'): void {
    this.db.run(
      'UPDATE group_task_deliverables SET confirmation = ? WHERE id = ?',
      [confirmation, id],
    );
    this.saveDb();
  }

  /** P0-4: persist the multi-source verification report for a deliverable. */
  updateDeliverableVerification(id: number, verification: string): void {
    this.db.run(
      'UPDATE group_task_deliverables SET verification = ? WHERE id = ?',
      [verification, id],
    );
    this.saveDb();
  }

  /** Remove a mistakenly recorded deliverable (P1-4 cleanup hatch for the chair). */
  deleteDeliverable(id: number): boolean {
    const row = this.getOne<{ id: number }>(
      'SELECT id FROM group_task_deliverables WHERE id = ?',
      [id],
    );
    if (!row) return false;
    this.db.run('DELETE FROM group_task_deliverables WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  createStaffingProposal(input: {
    sourceSessionId: string;
    twinMetabotId: number;
    title: string;
    goal: string;
    acceptanceCriteria?: string | null;
    plan: GroupTaskStaffingPlan;
    status: Extract<GroupTaskStaffingProposalStatus, 'pending' | 'skip_authorized'>;
    createdAt: number;
  }): GroupTaskStaffingProposal {
    this.cancelOpenStaffingProposalsForSession(input.sourceSessionId);
    this.db.run(
      `INSERT INTO group_task_staffing_proposals (
         source_session_id, twin_metabot_id, title, goal, acceptance_criteria,
         plan_json, status, skip_authorized, created_at, confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sourceSessionId,
        input.twinMetabotId,
        input.title,
        input.goal,
        input.acceptanceCriteria ?? null,
        JSON.stringify(input.plan),
        input.status,
        input.status === 'skip_authorized' ? 1 : 0,
        input.createdAt,
        input.status === 'skip_authorized' ? input.createdAt : null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const created = this.getStaffingProposalById(id);
    if (!created) throw new Error(`createStaffingProposal failed: proposal ${id} not found`);
    return created;
  }

  getStaffingProposalById(id: number): GroupTaskStaffingProposal | null {
    const row = this.getOne<StaffingProposalRow>(
      'SELECT * FROM group_task_staffing_proposals WHERE id = ?',
      [id],
    );
    return row ? rowToStaffingProposal(row) : null;
  }

  getStaffingProposalByTaskId(taskId: number): GroupTaskStaffingProposal | null {
    const row = this.getOne<StaffingProposalRow>(
      `SELECT * FROM group_task_staffing_proposals
       WHERE created_task_id = ? ORDER BY id DESC LIMIT 1`,
      [taskId],
    );
    return row ? rowToStaffingProposal(row) : null;
  }

  markStaffingProposalReady(
    id: number,
    input: { status: 'confirmed' | 'skip_authorized'; ownerDecision: string; confirmedAt: number },
  ): GroupTaskStaffingProposal {
    this.db.run(
      `UPDATE group_task_staffing_proposals
       SET status = ?, owner_decision = ?, skip_authorized = ?, confirmed_at = ?
       WHERE id = ?`,
      [
        input.status,
        input.ownerDecision,
        input.status === 'skip_authorized' ? 1 : 0,
        input.confirmedAt,
        id,
      ],
    );
    this.saveDb();
    const updated = this.getStaffingProposalById(id);
    if (!updated) throw new Error(`Staffing proposal ${id} not found after update`);
    return updated;
  }

  consumeStaffingProposal(id: number, taskId: number): GroupTaskStaffingProposal {
    this.db.run(
      `UPDATE group_task_staffing_proposals
       SET status = 'consumed', created_task_id = ?
       WHERE id = ?`,
      [taskId, id],
    );
    this.saveDb();
    const updated = this.getStaffingProposalById(id);
    if (!updated) throw new Error(`Staffing proposal ${id} not found after consume`);
    return updated;
  }

  /**
   * CAS: flip a usable proposal to consumed before the on-chain group is
   * created, so a concurrent Twin create cannot open a second group.
   */
  claimStaffingProposal(
    id: number,
    input?: { ownerDecision?: string },
  ): {
    proposal: GroupTaskStaffingProposal;
    previousStatus: Extract<GroupTaskStaffingProposalStatus, 'pending' | 'confirmed' | 'skip_authorized'>;
  } | null {
    const current = this.getStaffingProposalById(id);
    if (
      !current
      || (current.status !== 'pending' && current.status !== 'confirmed' && current.status !== 'skip_authorized')
    ) {
      return null;
    }
    this.db.run(
      `UPDATE group_task_staffing_proposals
       SET status = 'consumed',
           owner_decision = COALESCE(?, owner_decision),
           confirmed_at = CASE WHEN confirmed_at IS NULL THEN ? ELSE confirmed_at END
       WHERE id = ? AND status IN ('pending', 'confirmed', 'skip_authorized')`,
      [input?.ownerDecision ?? null, Date.now(), id],
    );
    const changes = this.db.getRowsModified?.() ?? 0;
    if (changes !== 1) return null;
    this.saveDb();
    const updated = this.getStaffingProposalById(id);
    if (!updated) return null;
    return { proposal: updated, previousStatus: current.status };
  }

  releaseStaffingProposal(
    id: number,
    previousStatus: Extract<GroupTaskStaffingProposalStatus, 'pending' | 'confirmed' | 'skip_authorized'>,
  ): GroupTaskStaffingProposal | null {
    this.db.run(
      `UPDATE group_task_staffing_proposals
       SET status = ?, skip_authorized = ?, created_task_id = NULL
       WHERE id = ? AND status = 'consumed' AND created_task_id IS NULL`,
      [previousStatus, previousStatus === 'skip_authorized' ? 1 : 0, id],
    );
    const changes = this.db.getRowsModified?.() ?? 0;
    if (changes !== 1) return this.getStaffingProposalById(id);
    this.saveDb();
    return this.getStaffingProposalById(id);
  }

  bindStaffingProposalTask(id: number, taskId: number): GroupTaskStaffingProposal {
    this.db.run(
      `UPDATE group_task_staffing_proposals
       SET created_task_id = ?
       WHERE id = ? AND status = 'consumed'`,
      [taskId, id],
    );
    this.saveDb();
    const updated = this.getStaffingProposalById(id);
    if (!updated) throw new Error(`Staffing proposal ${id} not found after bind`);
    return updated;
  }

  cancelStaffingProposal(id: number): GroupTaskStaffingProposal | null {
    this.db.run(
      `UPDATE group_task_staffing_proposals
       SET status = 'cancelled'
       WHERE id = ? AND status IN ('pending', 'confirmed', 'skip_authorized')`,
      [id],
    );
    this.saveDb();
    return this.getStaffingProposalById(id);
  }

  /**
   * Latest still-open proposal (pending / confirmed / skip_authorized) in a
   * source session. Feeds propose idempotency: an identical re-propose must
   * return THIS proposal instead of stacking a new one, so the owner's
   * in-window confirmation is never orphaned by a window reset.
   */
  getLatestOpenStaffingProposalForSession(sourceSessionId: string): GroupTaskStaffingProposal | null {
    const row = this.getOne<StaffingProposalRow>(
      `SELECT * FROM group_task_staffing_proposals
       WHERE source_session_id = ? AND status IN ('pending', 'confirmed', 'skip_authorized')
       ORDER BY id DESC LIMIT 1`,
      [sourceSessionId],
    );
    return row ? rowToStaffingProposal(row) : null;
  }

  cancelOpenStaffingProposalsForSession(sourceSessionId: string): number {
    this.db.run(
      `UPDATE group_task_staffing_proposals
       SET status = 'cancelled'
       WHERE source_session_id = ? AND status IN ('pending', 'confirmed', 'skip_authorized')`,
      [sourceSessionId],
    );
    const changes = this.db.getRowsModified?.() ?? 0;
    this.saveDb();
    return changes;
  }
}

interface StaffingProposalRow {
  id: number;
  source_session_id: string;
  twin_metabot_id: number;
  title: string;
  goal: string;
  acceptance_criteria: string | null;
  plan_json: string;
  status: string;
  skip_authorized: number | string | null;
  owner_decision: string | null;
  created_task_id: number | null;
  created_at: number | string;
  confirmed_at: number | string | null;
}

function rowToStaffingProposal(row: StaffingProposalRow): GroupTaskStaffingProposal {
  const status = (
    row.status === 'confirmed'
    || row.status === 'skip_authorized'
    || row.status === 'consumed'
    || row.status === 'cancelled'
      ? row.status
      : 'pending'
  ) as GroupTaskStaffingProposalStatus;
  let plan: GroupTaskStaffingPlan = { stages: [], seats: [] };
  try {
    plan = normalizeStaffingPlan(JSON.parse(row.plan_json));
  } catch {
    plan = { stages: [], seats: [] };
  }
  return {
    id: row.id,
    sourceSessionId: row.source_session_id,
    twinMetabotId: row.twin_metabot_id,
    title: row.title,
    goal: row.goal,
    acceptanceCriteria: row.acceptance_criteria ?? null,
    plan,
    status,
    skipAuthorized: Boolean(Number(row.skip_authorized)),
    ownerDecision: row.owner_decision ?? null,
    createdTaskId: row.created_task_id ?? null,
    createdAt: Number(row.created_at),
    confirmedAt: row.confirmed_at == null ? null : Number(row.confirmed_at),
  };
}

/** Member SELECT with metabots join (name/globalmetaid for mention matching). */
const MEMBER_SELECT = `
  SELECT m.*, mb.name AS metabot_name, mb.globalmetaid AS metabot_globalmetaid
  FROM group_task_members m
  LEFT JOIN metabots mb ON mb.id = m.metabot_id
`;
