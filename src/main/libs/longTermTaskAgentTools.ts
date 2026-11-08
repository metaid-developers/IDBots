import { z } from 'zod';
import type { LongTermTaskStore } from '../longTermTaskStore';
import { WAIT_UNTIL_STRICT_ISO } from '../longTermTaskStore';
import type {
  LongTermBoard,
  LongTermEvent,
  LongTermParticipant,
  LongTermSubtask,
  LongTermTaskDetail,
  LongTermTaskSummary,
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

export interface LongTermTaskAgentControl {
  store: () => LongTermTaskStore;
  /** Owner's UI language ('zh' | 'en') — delegation anchors follow it. */
  getAppLanguage?: () => string;
}

const CHANNEL_ENUM = ['delegate_bot', 'group_task', 'owner_external', 'owner_together'] as const;

const subtaskDraftSchema = z.object({
  title: z.string().min(1).describe('Sub-project title (short, verifiable).'),
  description: z.string().optional().describe('What this sub-project means and its boundaries.'),
  acceptanceCriteria: z.array(z.string()).optional().describe('Checkable acceptance criteria, one per line.'),
  dependsOnOrdinals: z.array(z.number()).optional().describe('1-based ordinals of sub-projects that must be accepted first.'),
  preferredChannel: z.enum(CHANNEL_ENUM).optional().describe('delegate_bot | group_task | owner_external | owner_together.'),
  notes: z.string().optional(),
  expectedMinutes: z.number().int().positive().optional().describe('Rough expected duration in minutes — estimate it during grilling; the supervision heartbeat checks in when the sub-project runs past its budget.'),
});

export function buildLongTermTaskAgentTools(deps: { tool: SdkToolFactory; control: LongTermTaskAgentControl }): unknown[] {
  const { tool, control } = deps;
  const store = () => control.store();

  const createTask = tool(
    'longterm_task_create',
    'Create a long-term task DRAFT after the full creation discipline (the long-term-task skill owns it — load and follow that skill; this description is only the checklist). Preconditions, all required: (1) you researched MetaWeb + Web2 BEFORE asking and opened with a research digest naming the searches; (2) you grilled the owner one question per round until no load-bearing detail was guessed; (3) you presented a visual plan page (infographic HTML linked in the bubble) and the owner confirmed it in prose — pass its URI as planArtifactUri (skip only on the owner\'s explicit instruction in THIS conversation, and say so in your reply). Never create from a fuzzy one-line ask. The draft is NOT active: after create, reconcile the echo against the approved plan page field by field and fix drift with the update tools; only call longterm_task_activate after the owner\'s final confirmation in prose. Not for one-session work (normal cowork turn) or a multi-bot short job (group task).',
    {
      title: z.string().min(1).describe('Task title (short).'),
      goal: z.string().min(1).describe('The full goal statement, including the done-ness definition of the whole task.'),
      subtasks: z.array(subtaskDraftSchema).min(1).describe('Ordered sub-projects. Order should respect dependencies.'),
      definitionSessionId: z.string().optional().describe('The session where the definition was discussed (for traceability).'),
      planArtifactUri: z.string().min(1).optional().describe('URI of the confirmed plan page — the local .html file path shown in the bubble (or pin:// if the owner asked for an on-chain copy). Recorded on the task so the board can re-open the plan later.'),
    },
    async (args: { title?: string; goal?: string; subtasks?: unknown[]; definitionSessionId?: string; planArtifactUri?: string }) => {
      try {
        const result = store().createTask(
          {
            title: String(args.title ?? ''),
            goal: String(args.goal ?? ''),
            subtasks: (args.subtasks ?? []) as never[],
            definitionSessionId: args.definitionSessionId ?? null,
            planArtifactUri: args.planArtifactUri ?? null,
          },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
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
      evidence: z.array(z.object({ kind: z.enum(['dir', 'metaapp', 'pin', 'url', 'other']), uri: z.string().min(1), note: z.string().optional() })).min(1).describe('Goal-level proof: local dir, metaapp:// URI, pin:// id, or URL.'),
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
    `Propose acceptance for a sub-project: attach verifiable evidence (local dir, metaapp:// URI, pin:// id, URL) and a summary of how each acceptance criterion is met. Moves the card to waiting-owner; the owner accepts or rejects with feedback. The summary is also the owner's decision brief (criterion-by-criterion evidence recap inside section 1/2): ${ownerBriefRule}`,
    {
      subtaskId: z.string().min(1),
      evidence: z.array(z.object({ kind: z.enum(['dir', 'metaapp', 'pin', 'url', 'other']), uri: z.string().min(1), note: z.string().optional() })).min(1),
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

  return [
    createTask,
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
