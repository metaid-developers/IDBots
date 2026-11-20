import { z } from 'zod';
import type { LongTermTaskStore } from '../longTermTaskStore';
import { WAIT_UNTIL_STRICT_ISO } from '../longTermTaskStore';
import type {
  LongTermActor,
  LongTermBoard,
  LongTermEvent,
  LongTermParticipant,
  LongTermSubtask,
  LongTermTaskDetail,
  LongTermTaskStage,
  LongTermTaskSummary,
  TaskOriginChannel,
  TaskWorkerSubmissionOutcome,
} from '../../renderer/types/longTermTask';
import { buildDelegationAnchorBlock } from './longTermDelegationAnchor';

/**
 * Long-term task tools — the TwinBot's first-class surface for the redesigned
 * long-term task board (docs/design/long-term-task-redesign-plan.md).
 *
 * Every tool delegates straight to LongTermTaskStore, so derivation and the
 * event journal live in exactly one place. The tools are the Twin's channel
 * (`actor: 'twin'` is fixed here — the model can never impersonate the owner);
 * the owner's channel is the board UI (IPC with `actor: 'owner'`).
 *
 * Discipline the tool descriptions encode (the creation skill owns the rest):
 *  - create requires the pre-create discipline (research digest, grilling, a
 *    confirmed visual plan page) — the description is the checklist and the
 *    echo reminds when no plan artifact is recorded (it never refuses: the
 *    owner may explicitly order a skip).
 *  - create stays a DRAFT until the owner explicitly confirms → activate.
 *  - acceptance is owner-only unless the task's delegate switch is on (the
 *    switch defaults ON at task creation since 2026-10-22; the owner can turn
 *    it off per task).
 *  - every write lands in the task's event journal (restart-proof memory).
 */

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Echoes are serialized compact (no indentation). The runtime's spill-policy
 * caps a tool result at 2048 estimated tokens (chars / 4 ≈ 8.2K chars) and
 * tears anything larger into head + `[...]` + tail text; a 9-sub-project detail
 * pretty-printed with two-space indentation is ~10K chars, 23–30% of it
 * whitespace. Compact serialization is the cheapest lever toward keeping the
 * whole roster inline (see toAgentTaskDetailView for the rest).
 */
function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value));
}

/**
 * Agent-facing projection of the store's rows.
 *
 * The store serves two channels from one shape. The owner channel (IPC, board
 * UI) wants every column — participant avatars for the chips, `evidence: []`
 * and `waitNote: ''` as stable table cells, the parent id on every nested row.
 * The Twin's channel reads the echo as text under a 2048-estimated-token spill
 * cap, where each of those costs context and none of them carries information
 * the root does not already state:
 *
 *  - `participants[].avatar` is a base64 data URL (~75K chars per bot); every
 *    create / activate / get / list echo shipped it — 87% of a 9-sub-project
 *    result, which pushed the runtime shaper into tearing id and title (bug
 *    report 2026-10-20). Dropped; { id, name } stays.
 *  - null / '' / [] members are the same fact as an absent key for the model
 *    and are ~23% of a pending sub-project row. Dropped recursively; `false`
 *    and `0` are values (acceptanceDelegate, counts) and stay.
 *  - nested rows repeat `taskId` (the echo's root id) and sub-project rows
 *    carry createdAt / updatedAt the Twin never acts on. Dropped from nested
 *    rows only; the root keeps its timestamps, events keep createdAt (a journal
 *    entry's time is its meaning).
 *  - the detail's journal is capped at 200 events for the UI. The echo puts the
 *    root and the whole roster in first, then fills what is left of
 *    AGENT_ECHO_CHAR_BUDGET with journal rows, newest first, and reports
 *    `eventsOmitted` for the rest of what the detail held. A fixed row count
 *    is not robust here: a `waiting` event carries the parked decision brief
 *    (up to 2,000 chars), so the newest rows alone can outweigh the roster.
 *    Each echoed `detail` keeps its first AGENT_EVENT_DETAIL_CAP chars — the
 *    full brief lives in the current sub-project's waitNote, which the roster
 *    carries whole.
 *
 * Measured through the compiled tools on a 9-sub-project task: 10,074 → 4,748
 * chars fresh, 19,383 → 7,426 at 40 events, 58,625 → 7,457 at the 200-event
 * cap, 7,526 with three 2K-char briefs newest — all under the cap with the full
 * roster inline, where the raw detail was torn at 4–6 of 9 sub-projects.
 * Twelve or more sub-projects with long descriptions can still exceed the cap;
 * that result spills with the policy's notice (labeled, and the full text one
 * `read` away) — the honest boundary of this projection.
 */
/** ≈ 1,900 of the policy's 2,048 estimated tokens (chars / 4): headroom for
 *  the marker a later shaping pass may add and for estimator drift. */
const AGENT_ECHO_CHAR_BUDGET = 7600;
const AGENT_EVENT_DETAIL_CAP = 240;

function isEmptyMember(value: unknown): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * Same shape, minus every null / '' / [] member, recursively. Typed as T for
 * the callers' convenience — they only serialize it — so a consumer reading a
 * view programmatically must treat every nullable / list member as optional.
 */
function dropEmpty<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => dropEmpty(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (isEmptyMember(member)) continue;
      out[key] = dropEmpty(member);
    }
    return out as T;
  }
  return value;
}

export type LongTermAgentParticipant = Omit<LongTermParticipant, 'avatar'>;
export type LongTermAgentTaskView<T extends LongTermTaskSummary> = Omit<T, 'participants'> & {
  participants: LongTermAgentParticipant[];
};

export function toAgentTaskView<T extends LongTermTaskSummary>(task: T): LongTermAgentTaskView<T> {
  const { participants, ...rest } = task;
  return dropEmpty({
    ...rest,
    participants: participants.map(({ id, name }) => ({ id, name })),
  });
}

/** Nested sub-project row: no parent id, no row timestamps, no empty members. */
export function toAgentSubtaskRow(subtask: LongTermSubtask) {
  const { taskId: _taskId, createdAt: _createdAt, updatedAt: _updatedAt, ...row } = subtask;
  return dropEmpty(row);
}

/** Standalone sub-project echo (begin / wait / propose …): keeps taskId as the link back. */
export function toAgentSubtaskView(subtask: LongTermSubtask) {
  return dropEmpty(subtask);
}

function toAgentEventRow(event: LongTermEvent) {
  const { taskId: _taskId, detail, ...row } = event;
  const shownDetail = detail.length > AGENT_EVENT_DETAIL_CAP
    ? `${detail.slice(0, AGENT_EVENT_DETAIL_CAP)}… (+${detail.length - AGENT_EVENT_DETAIL_CAP} chars)`
    : detail;
  return dropEmpty({ ...row, detail: shownDetail });
}

export function toAgentTaskDetailView(detail: LongTermTaskDetail) {
  const { subtasks, events, ...summary } = detail;
  const base = {
    ...toAgentTaskView(summary),
    subtasks: subtasks.map((subtask) => toAgentSubtaskRow(subtask)),
  };
  // Root + roster go in whole; journal rows (newest first, a contiguous prefix
  // so the digest never has a gap) fill what is left. The frame allowance
  // covers `"events":[…]`, the separators, and an `eventsOmitted` member.
  const frameAllowance = 48;
  let used = JSON.stringify(base).length + frameAllowance;
  const shown: ReturnType<typeof toAgentEventRow>[] = [];
  for (const event of events) {
    const row = toAgentEventRow(event);
    const cost = JSON.stringify(row).length + 1;
    if (used + cost > AGENT_ECHO_CHAR_BUDGET) break;
    shown.push(row);
    used += cost;
  }
  return {
    ...base,
    events: shown,
    ...(events.length > shown.length ? { eventsOmitted: events.length - shown.length } : {}),
  };
}

export function toAgentBoardView(board: LongTermBoard) {
  return { ...board, cards: board.cards.map((card) => toAgentTaskView(card)) };
}

/**
 * Activation is the owner's sign-off, not the start of work: every sub-project
 * stays `pending` until the Twin calls longterm_subtask_begin with the agreed
 * channel. An all-pending list after activate is therefore correct — but it
 * reads as "activated and nothing moved" to a caller who has to infer the next
 * step (bug report 2026-10-20, BUG-2). The activate / resume echoes carry this
 * sentence so the step is stated, not guessed. Null when a sub-project is
 * already in flight (resume after a begun pause) or nothing is open.
 */
export function describeActivationNextAction(detail: LongTermTaskDetail): string | null {
  const open = detail.subtasks.filter((sub) => sub.status !== 'accepted' && sub.status !== 'skipped');
  if (open.length === 0) return null;
  if (open.some((sub) => sub.status !== 'pending')) return null;
  const acceptedIds = new Set(detail.subtasks.filter((sub) => sub.status === 'accepted').map((sub) => sub.id));
  const eligible = [...open]
    .sort((a, b) => a.ordinal - b.ordinal)
    .find((sub) => sub.dependsOn.every((dep) => acceptedIds.has(dep)));
  if (!eligible) {
    return 'The task is active but no sub-project is in progress, and every open sub-project is blocked by an unmet dependency — repair the dependency graph with longterm_subtask_update before anything can begin.';
  }
  return `The task is active but no sub-project is in progress yet — activation does not begin work. Call longterm_subtask_begin({ subtaskId: "${eligible.id}", channel }) to start sub-project #${eligible.ordinal} "${eligible.title}" on the channel you and the owner agreed.`;
}

function withActivationNextAction(detail: LongTermTaskDetail) {
  const nextAction = describeActivationNextAction(detail);
  const view = toAgentTaskDetailView(detail);
  return nextAction ? { ...view, nextAction } : view;
}

export interface TaskAgentSessionIdentity {
  actor: LongTermActor;
  metabotId: number | null;
  isTwin: boolean;
  originChannel?: TaskOriginChannel | null;
}

export interface TaskOriginContextMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface LongTermTaskAgentControl {
  store: () => LongTermTaskStore;
  /** Owner's UI language ('zh' | 'en') — delegation anchors follow it. */
  getAppLanguage?: () => string;
  /** Resolve whether the calling session is the Twin Bot or a specialist Worker Bot. */
  resolveSessionIdentity?: (sessionId: string) => TaskAgentSessionIdentity;
  /** Latest genuine human-typed message id in `sessionId` for automatic origin anchoring. */
  resolveLatestUserMessageId?: (sessionId: string) => string | null;
  /** Read bounded verbatim origin context around anchor message ids. */
  readOriginContextSlice?: (params: {
    sessionId: string;
    anchorMessageIds: string[];
    windowTurns?: number;
  }) => TaskOriginContextMessage[] | null;
  /** Notify Studio HUD / session focus immediately when a task is created or focused. */
  onTaskCreatedOrFocused?: (sessionId: string, taskId: string) => void;
  /**
   * Fired when a subtask accept completes the WHOLE task to `done`. The
   * Studio chapter trigger records the boundary and closes the owning
   * conversation's active chapter at the next turn end (章节 = 任务,
   * Phase 1 slice 3).
   */
  onTaskCompleted?: (sessionId: string, taskId: string) => void;
}

const CHANNEL_ENUM = ['delegate_bot', 'group_task', 'owner_external', 'owner_together'] as const;
const EVIDENCE_KIND_ENUM = ['dir', 'file', 'metaapp', 'metafile', 'pin', 'url', 'other'] as const;

const subtaskDraftSchema = z.object({
  title: z.string().min(1).describe('Sub-project / subtask title (short, verifiable).'),
  description: z.string().optional().describe('What this subtask means and its boundaries.'),
  acceptanceCriteria: z.array(z.string()).optional().describe('Checkable acceptance criteria, one per line.'),
  dependsOnOrdinals: z.array(z.number()).optional().describe('1-based ordinals of sibling subtasks that must be accepted first (omit for parallel initial steps).'),
  preferredChannel: z.enum(CHANNEL_ENUM).optional().describe('delegate_bot | group_task | owner_external | owner_together.'),
  assigneeMetabotId: z.number().int().positive().optional().describe('Optional assigned local Bot id responsible for this subtask.'),
  notes: z.string().optional(),
  expectedMinutes: z.number().int().positive().optional().describe('Rough expected duration in minutes — the supervision heartbeat checks in when the subtask runs past its budget.'),
});

export function buildLongTermTaskAgentTools(deps: {
  tool: SdkToolFactory;
  control: LongTermTaskAgentControl;
  /** The session these tools are mounted in. When the model omits
   *  definitionSessionId on create, the calling session is recorded as the
   *  task's definition session — the birth conversation must never depend on
   *  the model remembering to pass an id it was only told about in prose
   *  (2026-11-08 incident: a task created in the owner's chat recorded no
   *  definition session, so the heartbeat could not see the conversation the
   *  owner was actually talking in and forked fresh sessions all day). */
  sessionId?: string;
}): unknown[] {
  const { tool, control } = deps;
  const store = () => control.store();
  const mountedSessionId = String(deps.sessionId ?? '').trim();

  const callerIdentity = (): TaskAgentSessionIdentity => {
    if (control.resolveSessionIdentity && mountedSessionId) {
      return control.resolveSessionIdentity(mountedSessionId);
    }
    return { actor: 'twin', metabotId: null, isTwin: true, originChannel: null };
  };

  const resolveOriginAnchors = (explicitSessionId?: string) => {
    const identity = callerIdentity();
    const originSessionId = String(explicitSessionId ?? '').trim() || mountedSessionId || null;
    const originMessageId =
      originSessionId && control.resolveLatestUserMessageId
        ? control.resolveLatestUserMessageId(originSessionId)
        : null;
    return {
      originSessionId,
      originMessageId,
      originChannel: identity.originChannel ?? null,
      identity,
    };
  };

  const createTask = tool(
    'longterm_task_create',
    'Create a long-term task DRAFT after the full creation discipline (the long-term-task skill owns it — load and follow that skill; this description is only the checklist). Preconditions, all required: (1) you researched MetaWeb + Web2 BEFORE asking and opened with a research digest naming the searches; (2) you grilled the owner one question per round until no load-bearing detail was guessed; (3) you presented a visual plan page (infographic HTML linked in the bubble) and the owner confirmed it in prose — pass its URI as planArtifactUri (skip only on the owner\'s explicit instruction in THIS conversation, and say so in your reply). Never create from a fuzzy one-line ask. The draft is NOT active: after create, reconcile the echo against the approved plan page field by field and fix drift with the update tools; only call longterm_task_activate after the owner\'s final confirmation in prose. Not for one-session work (normal cowork turn) or a multi-bot short job (group task).',
    {
      title: z.string().min(1).describe('Task title (short).'),
      goal: z.string().min(1).describe('The full goal statement, including the done-ness definition of the whole task.'),
      subtasks: z.array(subtaskDraftSchema).min(1).describe('Ordered sub-projects. Order should respect dependencies.'),
      definitionSessionId: z.string().optional().describe('Optional: the session where the definition was discussed. Defaults to this session when omitted — you normally do not need to pass it.'),
      planArtifactUri: z.string().min(1).optional().describe('URI of the confirmed plan page — the local .html file path shown in the bubble (or pin:// if the owner asked for an on-chain copy). Recorded on the task so the board can re-open the plan later.'),
    },
    async (args: { title?: string; goal?: string; subtasks?: unknown[]; definitionSessionId?: string; planArtifactUri?: string }) => {
      try {
        const anchors = resolveOriginAnchors(args.definitionSessionId);
        const result = store().createTask(
          {
            title: String(args.title ?? ''),
            goal: String(args.goal ?? ''),
            subtasks: (args.subtasks ?? []) as never[],
            definitionSessionId: anchors.originSessionId,
            originSessionId: anchors.originSessionId,
            originMessageId: anchors.originMessageId,
            originChannel: anchors.originChannel,
            planArtifactUri: args.planArtifactUri ?? null,
          },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        if (mountedSessionId && result.value) {
          control.onTaskCreatedOrFocused?.(mountedSessionId, result.value.id);
        }
        const view = toAgentTaskDetailView(result.value);
        // Missing plan artifact → the echo reminds, it does not refuse: the
        // owner may legitimately order a skip, but silence must not pass as
        // consent (2026-11-08 incident: a draft was created with no plan page
        // ever shown, off the tool description alone).
        const echo = args.planArtifactUri
          ? view
          : { ...view, planArtifactReminder: 'No planArtifactUri recorded. If you have not shown the owner a visual plan page yet, present one (infographic HTML linked in chat) and get prose confirmation BEFORE asking for activation; once shown, set it via longterm_task_update planArtifactUri.' };
        return jsonResult(echo);
      } catch (error) {
        return textResult(`Failed to create the long-term task: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const activateTask = tool(
    'longterm_task_activate',
    'Activate a draft long-term task after the OWNER confirmed the sub-project split and acceptance criteria in prose. Never activate on your own initiative — activation is the owner\'s sign-off. Activation does NOT begin work: every sub-project stays pending until you call longterm_subtask_begin; the response\'s nextAction names the first sub-project to begin.',
    { taskId: z.string().min(1) },
    async (args: { taskId?: string }) => {
      try {
        const result = store().activateTask(String(args.taskId ?? ''), 'twin');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(withActivationNextAction(result.value));
      } catch (error) {
        return textResult(`Failed to activate: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const listTasks = tool(
    'longterm_task_list',
    'List every long-term task on the board (defining / active / waiting / paused / done) with column, progress (accepted/total) and the current sub-project. Read-only. Use this at session start to recall what is in flight.',
    {},
    async () => {
      try {
        return jsonResult(toAgentBoardView(store().listBoard()));
      } catch (error) {
        return textResult(`Failed to list: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const getTask = tool(
    'longterm_task_get',
    'Get one long-term task\'s full state brief: goal, stage, progress, the current sub-project with its acceptance criteria and evidence, all sub-projects, and the recent event journal (why it is where it is). Read-only. Call this before pushing any task forward so you never lose the thread across sessions. Echo shape: empty members (null / "" / []) are omitted — an absent waitNote, evidence or dependsOn means empty; sub-project and event rows omit the parent taskId; events are the newest rows that fit the echo (eventsOmitted counts the rest of the journal held by the detail), each detail cut at 240 chars — the full decision brief is in the sub-project\'s waitNote.',
    { taskId: z.string().min(1) },
    async (args: { taskId?: string }) => {
      try {
        const detail = store().getTask(String(args.taskId ?? ''));
        if (!detail) return textResult('Task not found.', true);
        return jsonResult(toAgentTaskDetailView(detail));
      } catch (error) {
        return textResult(`Failed to read: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const updateTask = tool(
    'longterm_task_update',
    'Update a long-term task\'s title/goal, set the plan-page URI (planArtifactUri — record it when the plan page is presented or re-issued), toggle the acceptance-delegate switch (it defaults to on; change it only when the owner explicitly asks in chat), or pause/resume/cancel the task. Every change is journalled as a replan.',
    {
      taskId: z.string().min(1),
      title: z.string().optional(),
      goal: z.string().optional(),
      planArtifactUri: z.string().min(1).optional().describe('Set/replace the plan-page URI (local .html path or pin://) for traceability.'),
      acceptanceDelegate: z.boolean().optional().describe('TwinBot acceptance authority for THIS task (defaults to on; set false only at the owner\'s explicit request).'),
      action: z.enum(['pause', 'resume', 'cancel']).optional(),
      note: z.string().optional().describe('Reason for pause/cancel.'),
    },
    async (args: { taskId?: string; title?: string; goal?: string; planArtifactUri?: string; acceptanceDelegate?: boolean; action?: 'pause' | 'resume' | 'cancel'; note?: string }) => {
      try {
        const taskId = String(args.taskId ?? '');
        if (args.action === 'pause') {
          const paused = store().pauseTask(taskId, 'twin', args.note ?? '');
          if (!paused.ok) return textResult(`Refused (${paused.code}): ${paused.error}`, true);
          return jsonResult(toAgentTaskDetailView(paused.value));
        }
        if (args.action === 'resume') {
          const resumed = store().activateTask(taskId, 'twin');
          if (!resumed.ok) return textResult(`Refused (${resumed.code}): ${resumed.error}`, true);
          return jsonResult(withActivationNextAction(resumed.value));
        }
        if (args.action === 'cancel') {
          const cancelled = store().cancelTask(taskId, 'twin', args.note ?? '');
          if (!cancelled.ok) return textResult(`Refused (${cancelled.code}): ${cancelled.error}`, true);
          return textResult('Cancelled.');
        }
        const result = store().updateTask(
          { taskId, title: args.title, goal: args.goal, planArtifactUri: args.planArtifactUri, acceptanceDelegate: args.acceptanceDelegate },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentTaskDetailView(result.value));
      } catch (error) {
        return textResult(`Failed to update: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const completeTask = tool(
    'longterm_task_complete',
    `Declare the TASK'S GOAL met and close the whole task — the one-call exit when the outcome the task existed for is already achieved (typically the owner just said so in chat; their goal-level verdict outranks the sub-project state machine) or the remaining sub-projects became moot. Every remaining open sub-project is marked SKIPPED (never fake-accepted), the task lands in done, and the heartbeat stops driving it. Requires: the task's acceptance-delegate switch on (it defaults to on; the owner can switch it off per task), at least one goal-level evidence URI, and a summary that passes the two-level check — re-read the task goal, show WHICH evidence proves it, and say why each remaining open sub-project is moot. Do NOT use this to abandon a task that is simply stale (use longterm_task_update action=cancel) or to rubber-stamp sub-projects whose work you never verified.`,
    {
      taskId: z.string().min(1),
      summary: z.string().min(1).describe('Goal-level closure verdict in the owner\'s language: how the goal is met (quote it), which evidence proves it, and why the remaining open sub-projects are moot.'),
      evidence: z.array(z.object({ kind: z.enum(['dir', 'file', 'metaapp', 'pin', 'url', 'other']), uri: z.string().min(1), note: z.string().optional() })).min(1).describe('Goal-level proof: local dir or file, metaapp:// URI, pin:// id, or URL.'),
    },
    async (args: { taskId?: string; summary?: string; evidence?: unknown[] }) => {
      try {
        const result = store().completeTask(
          String(args.taskId ?? ''),
          'twin',
          { note: String(args.summary ?? ''), evidence: (args.evidence ?? []) as never[] },
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentTaskDetailView(result.value));
      } catch (error) {
        return textResult(`Failed to complete: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const addSubtask = tool(
    'longterm_subtask_add',
    'Add a sub-project to an existing task (requirements grow). Journalled as a replan.',
    {
      taskId: z.string().min(1),
      title: z.string().min(1),
      description: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      dependsOnOrdinals: z.array(z.number()).optional(),
      preferredChannel: z.enum(CHANNEL_ENUM).optional(),
      notes: z.string().optional(),
      expectedMinutes: z.number().int().positive().nullable().optional().describe('Expected duration in minutes — the supervision heartbeat checks in when this sub-project runs past its budget.'),
    },
    async (args: { taskId?: string; title?: string } & Record<string, unknown>) => {
      try {
        const result = store().addSubtask(String(args.taskId ?? ''), args as never, 'twin');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to add: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const updateSubtask = tool(
    'longterm_subtask_update',
    'Redefine an open sub-project: title, description, acceptance criteria, dependencies (by sub-project id), preferred channel, notes, order. Use when the owner corrects the definition mid-flight — the change is journalled so the correction is auditable.',
    {
      subtaskId: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional().describe('Sibling sub-project ids that must be accepted first.'),
      preferredChannel: z.enum(CHANNEL_ENUM).nullable().optional(),
      notes: z.string().optional(),
      ordinal: z.number().optional(),
      expectedMinutes: z.number().int().positive().nullable().optional().describe('Set or clear the expected-duration budget in minutes (null = use the supervision default).'),
      metataskRoot: z.string().regex(/^[0-9a-f]{64}i0$/).nullable().optional().describe('Link this sub-project to an on-chain MetaTask root pinId as its execution channel (multi-bot × long quadrant); null unlinks. Progress shows from the chain projection.'),
    },
    async (args: { subtaskId?: string } & Record<string, unknown>) => {
      try {
        const result = store().updateSubtask(args as never, 'twin');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to update: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const beginSubtask = tool(
    'longterm_subtask_begin',
    'Start pushing a sub-project (pins it as the board focus). Refused while its dependencies are not yet accepted. Pick the execution channel you and the owner agreed on. IMPORTANT: After calling this tool, you MUST immediately begin the first work step in the same turn or a follow-up message — do not wait for the heartbeat to trigger work. The heartbeat is only a fallback mechanism.',
    {
      subtaskId: z.string().min(1),
      channel: z.enum(CHANNEL_ENUM).optional(),
    },
    async (args: { subtaskId?: string; channel?: string }) => {
      try {
        const result = store().beginSubtask(String(args.subtaskId ?? ''), 'twin', (args.channel as never) ?? null);
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to begin: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  // The owner reads the wait note as the DECISION BRIEF — main-side surfaces
  // (board card, detail panel, heartbeat re-presentation) all render this same
  // text, so the required structure is stated identically in
  // SKILLs/long-term-task{,-exec}/SKILL.md and buildOwnerWaitBlock().
  const ownerBriefRule =
    'When kind=owner (and whenever you ask the owner to accept a proposal), the note IS the decision brief: the owner must be able to decide WITHOUT reading the session. Write it in the owner\'s language with these six labeled sections, one per line, in this order — 1) 背景与已完成进展 (background & progress so far), 2) 当前状况 (current situation), 3) 需要你拍板的事项 (the decision itself, one question), 4) 选项与利弊 (each option with its trade-offs, your recommendation first), 5) 推荐项及理由 (recommendation & why), 6) 拍板后的下一步 (what happens after the call). Newlines matter: the panel renders them as-is.';

  const waitSubtask = tool(
    'longterm_subtask_wait',
    `Park the current sub-project on a blocking point: kind=owner when you need the owner to decide something (say exactly WHAT in the note), kind=external when waiting on an outside condition (notarization, external delivery, a date). The heartbeat re-checks time-based waits and the card shows the note. ${ownerBriefRule}`,
    {
      subtaskId: z.string().min(1),
      kind: z.enum(['owner', 'external']),
      note: z.string().min(1).describe('Precisely what is being waited on. For kind=owner, the six-section decision brief described in the tool description (multi-line, owner\'s language).'),
      waitUntil: z.string().regex(WAIT_UNTIL_STRICT_ISO, 'full ISO timestamp WITH timezone offset (Z or ±HH:MM), converted to the owner\'s local timezone').optional().describe('ISO datetime for time-based re-checks — must carry an explicit timezone offset.'),
    },
    async (args: { subtaskId?: string; kind?: 'owner' | 'external'; note?: string; waitUntil?: string }) => {
      try {
        const result = store().waitSubtask(
          String(args.subtaskId ?? ''),
          { kind: args.kind === 'external' ? 'external' : 'owner', note: String(args.note ?? ''), waitUntil: args.waitUntil ?? null },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to wait: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const unblockSubtask = tool(
    'longterm_subtask_unblock',
    'Resume a waiting sub-project (owner answered / external condition resolved).',
    { subtaskId: z.string().min(1), note: z.string().optional() },
    async (args: { subtaskId?: string; note?: string }) => {
      try {
        const result = store().unblockSubtask(String(args.subtaskId ?? ''), 'twin', args.note ?? '');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to unblock: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const proposeSubtask = tool(
    'longterm_subtask_propose',
    `Propose acceptance for a sub-project: attach verifiable evidence (local dir or file, metaapp:// URI, pin:// id, URL) and a summary of how each acceptance criterion is met. Moves the card to waiting-owner; the owner accepts or rejects with feedback. The summary is also the owner's decision brief (criterion-by-criterion evidence recap inside section 1/2): ${ownerBriefRule}`,
    {
      subtaskId: z.string().min(1),
      evidence: z.array(z.object({ kind: z.enum(['dir', 'file', 'metaapp', 'pin', 'url', 'other']), uri: z.string().min(1), note: z.string().optional() })).min(1),
      summary: z.string().min(1).describe('Evidence recap per acceptance criterion AND the six-section decision brief described in the tool description (multi-line, owner\'s language).'),
    },
    async (args: { subtaskId?: string; evidence?: unknown[]; summary?: string }) => {
      try {
        const result = store().proposeSubtask(
          String(args.subtaskId ?? ''),
          { evidence: (args.evidence ?? []) as never[], summary: String(args.summary ?? '') },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to propose: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const acceptSubtask = tool(
    'longterm_subtask_accept',
    'Accept a sub-project as the Twin — ONLY when the task\'s acceptance-delegate switch is on (it defaults to on; the owner can switch it off per task) AND you verified every acceptance criterion against the evidence. Otherwise ask the owner to accept. When the last open sub-project is accepted the whole task completes.',
    { subtaskId: z.string().min(1), note: z.string().optional() },
    async (args: { subtaskId?: string; note?: string }) => {
      try {
        const result = store().acceptSubtask(String(args.subtaskId ?? ''), 'twin', args.note ?? '');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to accept: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const rejectSubtask = tool(
    'longterm_subtask_reject',
    'Bounce your own acceptance proposal back to in-progress when you discover the evidence does not actually meet the criteria. Carries a reason.',
    { subtaskId: z.string().min(1), feedback: z.string().min(1) },
    async (args: { subtaskId?: string; feedback?: string }) => {
      try {
        const result = store().rejectSubtask(String(args.subtaskId ?? ''), 'twin', String(args.feedback ?? ''));
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to reject: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const skipSubtask = tool(
    'longterm_subtask_skip',
    'Mark an open sub-project as no longer needed ("skipped" — a verdict on the PLAN, not the work; it never counts as accepted). Use when the owner ruled it out, it became redundant, or its purpose is already served elsewhere. Carries a reason for the journal. Skipping the LAST open sub-project of an active task completes the task and therefore requires the acceptance-delegate switch.',
    {
      subtaskId: z.string().min(1),
      reason: z.string().min(1).describe('Why this sub-project is no longer needed (journalled for the audit trail).'),
    },
    async (args: { subtaskId?: string; reason?: string }) => {
      try {
        const result = store().skipSubtask(String(args.subtaskId ?? ''), 'twin', String(args.reason ?? ''));
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to skip: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const addNote = tool(
    'longterm_event_note',
    'Journal a note on a task (or one sub-project): decisions made in chat, context worth surviving a restart, why something is where it is. Cheap and append-only — prefer one precise note over re-explaining later.',
    { taskId: z.string().min(1), subtaskId: z.string().optional(), text: z.string().min(1) },
    async (args: { taskId?: string; subtaskId?: string; text?: string }) => {
      try {
        const result = store().addNote(String(args.taskId ?? ''), args.subtaskId ?? null, String(args.text ?? ''), 'twin');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return textResult('Noted.');
      } catch (error) {
        return textResult(`Failed to note: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const delegationAnchor = tool(
    'longterm_delegation_anchor',
    'Build the context anchor block for a delegation brief. REQUIRED whenever you delegate any slice of a long-term sub-project to a worker bot or a group task: paste the returned block into the delegation objective verbatim. It carries the task/sub-project ids, the goal, the acceptance criteria, recent journal events, and the worker\'s duties (read longterm_task_get first, never invent infrastructure, journal key findings back). A delegation without this anchor is a lossy relay — the worker would build the plausible thing instead of the right thing.',
    {
      taskId: z.string().min(1),
      subtaskId: z.string().min(1),
    },
    async (args: { taskId?: string; subtaskId?: string }) => {
      try {
        const detail = store().getTask(String(args.taskId ?? ''));
        if (!detail) return textResult('Task not found.', true);
        const subtask = detail.subtasks.find((sub) => sub.id === String(args.subtaskId ?? ''));
        if (!subtask) return textResult('Sub-project not found in this task.', true);
        return textResult(buildDelegationAnchorBlock(detail, subtask, control.getAppLanguage?.() === 'zh' ? 'zh' : 'en'));
      } catch (error) {
        return textResult(`Failed to build the delegation anchor: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const quickCreateTask = tool(
    'longterm_task_quick_create',
    'Create and immediately activate a lightweight single-step deliverable card (`taskKind: "quick"`, sole subtask `in_progress`) in the unified Studio Managed Task Tree. Use for clear, bounded 1-step deliverables (e.g. writing an article, fixing a concrete bug, generating a visual asset) where multi-round Socratic interrogation and a separate HTML plan page would be unnecessary friction. Pass the returned `id` and `subtasks[0].id` as `longtermTaskId` and `longtermSubtaskId` into `local_worker_delegate` so the task ledger, Live Stage HUD, and Owner Decision Queue track it end-to-end.',
    {
      title: z.string().min(1).describe('Short deliverable title.'),
      goal: z.string().optional().describe('Concrete done-ness goal (defaults to title).'),
      acceptanceCriteria: z.array(z.string()).optional().describe('Checkable acceptance criteria for the Worker output.'),
      preferredChannel: z.enum(CHANNEL_ENUM).optional(),
      expectedMinutes: z.number().int().positive().optional(),
      parentTaskId: z.string().optional(),
      definitionSessionId: z.string().optional(),
    },
    async (args: {
      title?: string;
      goal?: string;
      acceptanceCriteria?: string[];
      preferredChannel?: (typeof CHANNEL_ENUM)[number];
      expectedMinutes?: number;
      parentTaskId?: string;
      definitionSessionId?: string;
    }) => {
      try {
        const anchors = resolveOriginAnchors(args.definitionSessionId);
        const result = store().createQuickTask(
          {
            title: String(args.title ?? ''),
            goal: args.goal,
            acceptanceCriteria: args.acceptanceCriteria ?? [],
            preferredChannel: args.preferredChannel ?? 'delegate_bot',
            expectedMinutes: args.expectedMinutes,
            parentTaskId: args.parentTaskId ?? null,
            definitionSessionId: anchors.originSessionId,
            originSessionId: anchors.originSessionId,
            originMessageId: anchors.originMessageId,
            originChannel: anchors.originChannel,
          },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        if (mountedSessionId && result.value) {
          control.onTaskCreatedOrFocused?.(mountedSessionId, result.value.id);
        }
        return jsonResult(toAgentTaskDetailView(result.value));
      } catch (error) {
        return textResult(`Failed to quick-create task: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  // ── First-class universal `task_*` tools (Twin + Worker shared blackboard) ──

  const taskListActive = tool(
    'task_list_active',
    'HIGH-PRIORITY RADAR: Instantly list all active / in-flight / waiting tasks on this machine in an ultra-compact summary (<2KB, never spills). Call FIRST whenever the owner asks what tasks are in progress, what still needs doing, or before deciding whether an incoming request continues an existing task vs creates a new one.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Maximum active tasks to return (default 25).'),
    },
    async (args: { limit?: number }) => {
      try {
        const active = store().listActiveTasksCompact(args.limit ?? 25);
        return jsonResult({ count: active.length, tasks: active.map((entry) => dropEmpty(entry)) });
      } catch (error) {
        return textResult(`Failed to list active tasks: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const taskSearch = tool(
    'task_search',
    'Search ALL tasks on this machine (both active and completed/archived) by keyword, status, [long-term] badge, assignee Bot, or session. Matches task titles, goals, subtask descriptions/notes/progress, submitted deliverables/URIs, and event logs in milliseconds. Call immediately whenever the owner mentions a past or ongoing topic, keyword, feature, or Worker assignment.',
    {
      query: z.string().optional().describe('Space-separated keywords (e.g. "多签 review", "好友系统", "MRC721").'),
      stage: z.enum(['defining', 'active', 'paused', 'done']).optional(),
      managedState: z.enum(['in_progress', 'waiting_owner', 'waiting_external']).optional(),
      isLongTerm: z.boolean().optional().describe('Filter by [long-term] badge (true) vs standard tasks (false).'),
      assigneeMetabotId: z.number().int().positive().optional().describe('Filter tasks with subtasks assigned to this Bot id.'),
      sessionId: z.string().optional().describe('Filter tasks linked to a specific conversation session id.'),
      includeDone: z.boolean().optional().describe('Include completed/archived tasks (default true).'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20).'),
    },
    async (args: {
      query?: string;
      stage?: LongTermTaskStage;
      managedState?: 'in_progress' | 'waiting_owner' | 'waiting_external';
      isLongTerm?: boolean;
      assigneeMetabotId?: number;
      sessionId?: string;
      includeDone?: boolean;
      limit?: number;
    }) => {
      try {
        const matches = store().searchTasks({
          query: args.query,
          stage: args.stage,
          managedState: args.managedState,
          isLongTerm: args.isLongTerm,
          assigneeMetabotId: args.assigneeMetabotId,
          sessionId: args.sessionId,
          includeDone: args.includeDone ?? true,
          limit: args.limit ?? 20,
        });
        return jsonResult({
          count: matches.length,
          tasks: matches.map((card) => toAgentTaskView(card)),
        });
      } catch (error) {
        return textResult(`Failed to search tasks: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const taskGet = tool(
    'task_get',
    'Read one Task\'s complete shared state: goal, [long-term] badge, origin session/message anchors, all subtasks with serial/parallel dependencies, assignee Bots, live Worker progress checkpoints, Worker-registered deliverable submissions + evidence, and recent journal events. Call before starting, delegating, or verifying any task.',
    { taskId: z.string().min(1) },
    async (args: { taskId?: string }) => {
      try {
        const detail = store().getTask(String(args.taskId ?? ''));
        if (!detail) return textResult('Task not found.', true);
        return jsonResult(toAgentTaskDetailView(detail));
      } catch (error) {
        return textResult(`Failed to read task: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const taskContextRead = tool(
    'task_context_read',
    'Pull the exact verbatim conversation excerpt where a Task (or specific subtask) was initiated by the owner, resolved via its persisted `originSessionId` and `originMessageId` anchors. Eliminates natural-language relay loss in multi-Bot collaboration without exposing unrelated conversation history.',
    {
      taskId: z.string().min(1),
      subtaskId: z.string().optional(),
      windowTurns: z.number().int().min(1).max(10).optional().describe('Surrounding messages before/after the origin message (default 3).'),
    },
    async (args: { taskId?: string; subtaskId?: string; windowTurns?: number }) => {
      try {
        const detail = store().getTask(String(args.taskId ?? ''));
        if (!detail) return textResult('Task not found.', true);
        const sub = args.subtaskId
          ? detail.subtasks.find((item) => item.id === String(args.subtaskId ?? '')) ?? null
          : null;
        const targetSessionId =
          sub?.originSessionId
          ?? detail.originSessionId
          ?? detail.definitionSessionId
          ?? null;
        if (!targetSessionId) {
          return jsonResult({
            taskId: detail.id,
            originSessionId: null,
            messages: [],
            note: 'No originSessionId recorded on this task; rely on task_get goal and acceptanceCriteria.',
          });
        }
        const anchors = Array.from(
          new Set(
            [
              sub?.originMessageId ?? null,
              detail.originMessageId ?? null,
              ...(detail.anchorMessageIds ?? []),
            ].filter((id): id is string => Boolean(id)),
          ),
        );
        const slice =
          control.readOriginContextSlice?.({
            sessionId: targetSessionId,
            anchorMessageIds: anchors,
            windowTurns: args.windowTurns ?? 3,
          }) ?? [];
        return jsonResult({
          taskId: detail.id,
          ...(sub ? { subtaskId: sub.id } : {}),
          originSessionId: targetSessionId,
          originMessageId: sub?.originMessageId ?? detail.originMessageId ?? null,
          originChannel: detail.originChannel ?? null,
          messages: slice,
        });
      } catch (error) {
        return textResult(`Failed to read task origin context: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const taskCreate = tool(
    'task_create',
    'Create a first-class Task card (Twin Bot only). Supports BOTH simple 1–2 turn deliverables (omit `subtasks` or pass 1 item — e.g. drafting a proposal, producing 3 cover candidates, auditing a module) AND multi-subtask serial/parallel DAG workflows (`subtasks` with `dependsOnOrdinals` — omit `dependsOnOrdinals` for parallel subtasks, set `[1]` for serial subtasks). By default (`activateImmediately: true`) the task activates immediately (`in_progress`), mounts onto the Studio bottom-right Task HUD, and begins all dependency-free subtasks. Automatically records `originSessionId` and `originMessageId` for zero-loss Worker context lookup. IMPORTANT OWNER RULING RULE: When a deliverable or proposal is produced (whether by you directly or by Workers), park the task in `waiting_owner` via `task_subtask_propose` (or `studio_decision_enqueue`) and present the detailed plan/deliverable to the owner — NEVER mark the whole task `done` before the owner reviews and approves.',
    {
      title: z.string().min(1).describe('Concise task title shown on the Task Board and Studio HUD.'),
      goal: z.string().optional().describe('Clear outcome & done-ness definition (defaults to title).'),
      acceptanceCriteria: z.array(z.string()).optional().describe('Checkable acceptance criteria (used when `subtasks` is omitted).'),
      subtasks: z.array(subtaskDraftSchema).optional().describe('Optional 1..N subtasks with serial/parallel `dependsOnOrdinals` and optional `assigneeMetabotId`.'),
      preferredChannel: z.enum(CHANNEL_ENUM).optional(),
      expectedMinutes: z.number().int().positive().optional(),
      activateImmediately: z.boolean().optional().describe('Default true (immediately enters `in_progress`). Set false only for fuzzy multi-week drafts still in `defining`.'),
      isLongTerm: z.boolean().optional().describe('Optional explicit [long-term] badge override (omit for automatic derivation from >=3 Bots, >=1440m duration, >24h span, or >=4 subtasks).'),
      parentTaskId: z.string().optional().describe('Optional parent Task id (ltt_...) when this task is a rework, companion asset, or follow-up child spawned while advancing/reviewing an existing task (renders indented under its parent on the HUD and Task Board).'),
      planArtifactUri: z.string().optional(),
      definitionSessionId: z.string().optional(),
    },
    async (args: {
      title?: string;
      goal?: string;
      acceptanceCriteria?: string[];
      subtasks?: unknown[];
      preferredChannel?: (typeof CHANNEL_ENUM)[number];
      expectedMinutes?: number;
      activateImmediately?: boolean;
      isLongTerm?: boolean;
      parentTaskId?: string;
      planArtifactUri?: string;
      definitionSessionId?: string;
    }) => {
      try {
        const anchors = resolveOriginAnchors(args.definitionSessionId);
        if (!anchors.identity.isTwin) {
          return textResult('Refused (FORBIDDEN): Only the Twin Bot may create top-level Tasks; Workers update/submit assigned subtasks.', true);
        }
        const result = store().createUnifiedTask(
          {
            title: String(args.title ?? ''),
            goal: args.goal,
            acceptanceCriteria: args.acceptanceCriteria,
            subtasks: args.subtasks as never[] | undefined,
            preferredChannel: args.preferredChannel,
            expectedMinutes: args.expectedMinutes,
            activateImmediately: args.activateImmediately !== false,
            isLongTerm: args.isLongTerm ?? null,
            parentTaskId: args.parentTaskId ?? null,
            planArtifactUri: args.planArtifactUri ?? null,
            definitionSessionId: anchors.originSessionId,
            originSessionId: anchors.originSessionId,
            originMessageId: anchors.originMessageId,
            originChannel: anchors.originChannel,
          },
          anchors.identity.actor,
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        if (mountedSessionId && result.value) {
          control.onTaskCreatedOrFocused?.(mountedSessionId, result.value.id);
        }
        const readySubtasks = result.value.subtasks
          .filter((s) => s.status === 'in_progress')
          .map((s) => ({ subtaskId: s.id, ordinal: s.ordinal, title: s.title, assigneeMetabotId: s.assigneeMetabotId ?? undefined }));
        return jsonResult({
          ...toAgentTaskDetailView(result.value),
          readySubtasks,
          closureRule: 'Present finished deliverables/plans in detail and move to waiting_owner (task_subtask_propose / studio_decision_enqueue) — wait for owner sign-off before final closure.',
        });
      } catch (error) {
        return textResult(`Failed to create task: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const taskSubtaskProgress = tool(
    'task_subtask_progress',
    'Record a live milestone progress checkpoint on an in-flight subtask (e.g. "2/3: security audit complete, running regression suite"). Updates the local SQLite Task blackboard immediately so the Twin Bot heartbeat and Studio bottom-right HUD show live progress.',
    {
      subtaskId: z.string().min(1),
      note: z.string().min(1).max(280).describe('Concise progress checkpoint.'),
    },
    async (args: { subtaskId?: string; note?: string }) => {
      try {
        const identity = callerIdentity();
        const result = store().recordSubtaskProgress(
          String(args.subtaskId ?? ''),
          { note: String(args.note ?? '') },
          identity.actor,
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to record progress: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const taskSubtaskSubmit = tool(
    'task_subtask_submit',
    'Worker self-registration on the Task blackboard: call BEFORE finishing your delegated turn to write your completion status (`ready_for_review` | `blocked` | `waiting_external` | `failed`), summary, produced digital artifacts (local file/dir paths, metaapp://, metafile://, pin://, URLs), and verification evidence directly into the Subtask object. The Twin Bot reads this structured record directly when verifying and advancing downstream subtasks.',
    {
      subtaskId: z.string().min(1),
      outcome: z.enum(['ready_for_review', 'blocked', 'waiting_external', 'failed']),
      summary: z.string().min(1).describe('Concise factual summary of what was accomplished and verified.'),
      artifacts: z
        .array(
          z.object({
            kind: z.string().min(1).describe('file | dir | metaapp | metafile | pin | url | branch | other'),
            uri: z.string().min(1).describe('Full path or URI (never abbreviated).'),
            label: z.string().optional(),
            sha256: z.string().optional(),
          }),
        )
        .optional(),
      evidence: z
        .array(
          z.object({
            kind: z.enum(EVIDENCE_KIND_ENUM),
            uri: z.string().min(1),
            note: z.string().optional(),
          }),
        )
        .optional(),
      blockers: z.array(z.string()).optional(),
    },
    async (args: {
      subtaskId?: string;
      outcome?: TaskWorkerSubmissionOutcome;
      summary?: string;
      artifacts?: Array<{ kind: string; uri: string; label?: string; sha256?: string }>;
      evidence?: Array<{ kind: string; uri: string; note?: string }>;
      blockers?: string[];
    }) => {
      try {
        const identity = callerIdentity();
        const result = store().submitSubtaskWork(
          String(args.subtaskId ?? ''),
          {
            outcome: (args.outcome ?? 'ready_for_review') as TaskWorkerSubmissionOutcome,
            workerMetabotId: identity.metabotId ?? 0,
            workerSessionId: mountedSessionId || null,
            summary: String(args.summary ?? ''),
            artifacts: args.artifacts ?? [],
            evidence: args.evidence ?? [],
            blockers: args.blockers ?? [],
          },
          identity.actor,
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to submit subtask work: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const taskSubtaskPropose = tool(
    'task_subtask_propose',
    'Park a completed deliverable, plan, or candidate slate in `waiting_owner` (等你拍板) with verifiable evidence and a clear summary so the owner can inspect the detailed result before final sign-off. REQUIRED when you finish a 1–2 turn plan/deliverable yourself or when presenting the final stage of a task to the owner.',
    {
      subtaskId: z.string().min(1),
      evidence: z
        .array(
          z.object({
            kind: z.enum(EVIDENCE_KIND_ENUM),
            uri: z.string().min(1),
            note: z.string().optional(),
          }),
        )
        .min(1),
      summary: z.string().min(1).describe('Clear deliverable summary + what the owner is reviewing/approving.'),
    },
    async (args: { subtaskId?: string; evidence?: unknown[]; summary?: string }) => {
      try {
        const identity = callerIdentity();
        if (!identity.isTwin) {
          return textResult('Refused (FORBIDDEN): Workers should call task_subtask_submit; only the Twin Bot proposes owner acceptance.', true);
        }
        const result = store().proposeSubtask(
          String(args.subtaskId ?? ''),
          { evidence: (args.evidence ?? []) as never[], summary: String(args.summary ?? '') },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(toAgentSubtaskView(result.value));
      } catch (error) {
        return textResult(`Failed to propose subtask: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const taskSubtaskAccept = tool(
    'task_subtask_accept',
    'Accept a verified subtask as Twin Bot. For INTERMEDIATE subtasks in a multi-step DAG, accepting automatically unlocks dependent serial subtasks (returned in `unlockedSubtasks` so you can immediately begin/delegate them). IMPORTANT: Closing the LAST open subtask of a task completes the entire task to `done` — NEVER close the final deliverable of a task without the owner having reviewed and approved it (`ownerApprovedInChat: true`); if the owner has not seen/approved the deliverable yet, call `task_subtask_propose` (or `studio_decision_enqueue`) instead so it waits in `waiting_owner` (等你拍板).',
    {
      subtaskId: z.string().min(1),
      note: z.string().optional(),
      ownerApprovedInChat: z.boolean().optional().describe('Set true ONLY when closing the final subtask AFTER the owner explicitly approved/accepted the presented deliverable in chat.'),
    },
    async (args: { subtaskId?: string; note?: string; ownerApprovedInChat?: boolean }) => {
      try {
        const identity = callerIdentity();
        if (!identity.isTwin) {
          return textResult('Refused (FORBIDDEN): Only the Twin Bot or Owner may accept subtasks.', true);
        }
        const subtaskId = String(args.subtaskId ?? '');
        const target = store().getSubtask(subtaskId);
        if (!target) return textResult('Refused (NOT_FOUND): subtask not found', true);
        const detailBefore = store().getTask(target.taskId);
        if (!detailBefore) return textResult('Refused (NOT_FOUND): task not found', true);
        const otherOpen = detailBefore.subtasks.filter(
          (s) => s.id !== subtaskId && s.status !== 'accepted' && s.status !== 'skipped',
        );
        if (otherOpen.length === 0 && args.ownerApprovedInChat !== true) {
          return textResult(
            `Refused (OWNER_RULING_REQUIRED): Subtask "${target.title}" is the final open deliverable of task "${detailBefore.title}". Present the detailed result/plan to the owner and park it in waiting_owner via task_subtask_propose (or studio_decision_enqueue) first; pass ownerApprovedInChat: true only after the owner explicitly approves in chat.`,
            true,
          );
        }
        const result = store().acceptSubtask(subtaskId, 'twin', args.note ?? '');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        const detailAfter = store().getTask(target.taskId);
        const acceptedIds = new Set(
          (detailAfter?.subtasks ?? []).filter((s) => s.status === 'accepted').map((s) => s.id),
        );
        const unlockedSubtasks: Array<{ subtaskId: string; ordinal: number; title: string; assigneeMetabotId?: number }> = [];
        for (const candidate of detailAfter?.subtasks ?? []) {
          if (candidate.status === 'pending' && candidate.dependsOn.every((dep) => acceptedIds.has(dep))) {
            const begun = store().beginSubtask(candidate.id, 'twin', candidate.preferredChannel);
            const activeSub = begun.ok && begun.value ? begun.value : candidate;
            unlockedSubtasks.push({
              subtaskId: activeSub.id,
              ordinal: activeSub.ordinal,
              title: activeSub.title,
              ...(activeSub.assigneeMetabotId ? { assigneeMetabotId: activeSub.assigneeMetabotId } : {}),
            });
          }
        }
        // Whole-task completion (章节 = 任务, Phase 1 slice 3): when this
        // accept finishes the LAST open subtask, the owning conversation's
        // chapter closes at the next turn end. Best-effort — the chapter
        // trigger validates the session and its own guards.
        if (detailAfter?.stage === 'done' && mountedSessionId) {
          try {
            control.onTaskCompleted?.(mountedSessionId, target.taskId);
          } catch {
            // Never fail the accept because a bookkeeping hook threw.
          }
        }
        return jsonResult({
          subtask: toAgentSubtaskView(result.value),
          taskStage: detailAfter?.stage ?? 'active',
          unlockedSubtasks,
        });
      } catch (error) {
        return textResult(`Failed to accept subtask: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  return [
    taskListActive,
    taskSearch,
    taskGet,
    taskContextRead,
    taskCreate,
    taskSubtaskProgress,
    taskSubtaskSubmit,
    taskSubtaskPropose,
    taskSubtaskAccept,
    createTask,
    quickCreateTask,
    activateTask,
    listTasks,
    getTask,
    updateTask,
    completeTask,
    addSubtask,
    updateSubtask,
    beginSubtask,
    waitSubtask,
    unblockSubtask,
    proposeSubtask,
    acceptSubtask,
    rejectSubtask,
    skipSubtask,
    addNote,
    delegationAnchor,
  ];
}
