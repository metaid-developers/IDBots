import { z } from 'zod';
import type {
  EnqueueProactiveFollowUpInput,
  FollowUpInformOutcome,
  FollowUpReportingGranularity,
  FollowUpSourceDomain,
  FollowUpTier,
  ProactiveFollowUpItem,
} from '../proactiveFollowUpStore';
import type { StudioDecisionEvidence, StudioDecisionOption } from '../studioDecisionQueueStore';
import type { LongTermSubtaskDraft } from '../../renderer/types/longTermTask';

type ToolFactory = <Schema extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<z.ZodObject<Schema>>, extra: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>,
) => unknown;

export type A2AGuidanceDispatchResult =
  | { ok: true; mode: 'queued' | 'restart_started'; messageId?: string }
  | { ok: false; error: string };

export interface PromoteFollowUpToTaskInput {
  followUpId: string;
  title?: string;
  goal?: string;
  subtasks?: LongTermSubtaskDraft[];
  acceptanceCriteria?: string[];
  assigneeMetabotId?: number;
  activateImmediately?: boolean;
  resolutionNote?: string;
  peerReplyGuidance?: string;
}

export interface ProactiveFollowUpToolsControl {
  isTwinSession(sessionId: string): boolean;
  listOpenFollowUps(
    sessionId: string,
    options?: { includeRecentClosed?: boolean },
  ): {
    open: ProactiveFollowUpItem[];
    recentClosed: ProactiveFollowUpItem[];
  };
  enqueueFollowUp(
    sessionId: string,
    input: Omit<EnqueueProactiveFollowUpInput, 'twinMetabotId'>,
  ): { ok: true; item: ProactiveFollowUpItem | null; reused: boolean; skippedReason?: string } | { ok: false; error: string };
  resolveFollowUp(
    sessionId: string,
    followUpId: string,
    resolutionNote: string,
  ): { ok: true; item: ProactiveFollowUpItem } | { ok: false; error: string };
  deferFollowUp(
    sessionId: string,
    followUpId?: string,
  ): { ok: true; item: ProactiveFollowUpItem } | { ok: false; error: string };
  replyA2A(
    sessionId: string,
    input: {
      followUpId?: string;
      a2aSessionId?: string;
      guidance: string;
      resolutionNote?: string;
    },
  ): Promise<
    | {
        ok: true;
        a2aSessionId: string;
        mode: 'queued' | 'restart_started';
        messageId?: string;
        resolvedFollowUpId?: string | null;
      }
    | { ok: false; error: string }
  >;
  promoteFollowUpToTask(
    sessionId: string,
    input: PromoteFollowUpToTaskInput,
  ): Promise<
    | {
        ok: true;
        taskId: string;
        taskTitle: string;
        stage: string;
        followUpId: string;
        peerGuidanceMode?: 'queued' | 'restart_started' | null;
      }
    | { ok: false; error: string }
  >;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function stripSessionUriPrefix(raw: string | undefined | null): string {
  const clean = String(raw ?? '').trim();
  return clean.replace(/^IDBots:\/\//i, '').trim();
}

const OPTION_SCHEMA = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
});

const EVIDENCE_SCHEMA = z.object({
  kind: z.enum(['dir', 'file', 'metaapp', 'pin', 'url', 'other']),
  uri: z.string().min(1),
  note: z.string().optional(),
});

const SUBTASK_DRAFT_SCHEMA = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  dependsOnOrdinals: z.array(z.number().int().positive()).optional(),
  preferredChannel: z.enum(['delegate_bot', 'group_task', 'owner_external', 'owner_together']).optional(),
  assigneeMetabotId: z.number().int().positive().optional(),
  expectedMinutes: z.number().int().positive().optional(),
});

function serializeItem(item: ProactiveFollowUpItem) {
  return {
    id: item.id,
    status: item.status,
    tier: item.tier,
    ...(item.informOutcome ? { informOutcome: item.informOutcome } : {}),
    sourceDomain: item.sourceDomain,
    localMetabotId: item.localMetabotId,
    localMetabotName: item.localMetabotName,
    peerName: item.peerName,
    peerGlobalMetaId: item.peerGlobalMetaId,
    sourceSessionId: item.sourceSessionId,
    workerSessionId: item.workerSessionId,
    orchestrationTaskId: item.orchestrationTaskId,
    promotedTaskId: item.promotedTaskId,
    title: item.title,
    summary: item.summary,
    ...(item.question ? { question: item.question } : {}),
    ...(item.recommendation ? { recommendation: item.recommendation } : {}),
    coalescedCount: item.coalescedCount,
    updatedAt: item.updatedAt,
  };
}

export function buildProactiveFollowUpAgentTools(params: {
  tool: ToolFactory;
  control: ProactiveFollowUpToolsControl;
  sessionId: string;
}): unknown[] {
  const { tool, control, sessionId } = params;
  if (!control.isTwinSession(sessionId)) {
    return [];
  }

  const listTool = tool(
    'followup_list',
    'List open Proactive Follow-Up Events (`presenting` + `queued`) aggregated from Twin and Worker A2A chats, Worker escalations, and world events. Twin Bot only.',
    {
      includeRecentClosed: z.boolean().optional().describe('Also return items delivered/resolved/promoted in the last 30 minutes.'),
    },
    async (args) => {
      const res = control.listOpenFollowUps(sessionId, {
        includeRecentClosed: args.includeRecentClosed === true,
      });
      return textResult(
        JSON.stringify({
          ok: true,
          openCount: res.open.length,
          open: res.open.map(serializeItem),
          ...(args.includeRecentClosed
            ? { recentClosed: res.recentClosed.map(serializeItem) }
            : {}),
        }),
      );
    },
  );

  const enqueueTool = tool(
    'followup_enqueue',
    'Enqueue a lightweight Proactive Follow-Up Event (`inform` for handled/auto-declined/observed updates, `light_decision` for 1-turn owner rulings, or `task_proposal` for multi-step proposals) to be delivered naturally in the Twin chat stream when idle — without forcing a heavy Studio HTML projector page or modal popup. Twin Bot only.',
    {
      tier: z.enum(['inform', 'light_decision', 'task_proposal']),
      informOutcome: z.enum(['handled', 'declined', 'observed']).optional(),
      sourceDomain: z.enum(['a2a_chat', 'worker_escalation', 'commerce', 'chain_world']).optional(),
      reportingGranularity: z.enum(['immediate', 'hourly_digest', 'daily_digest']).optional(),
      canonicalKey: z.string().optional(),
      title: z.string().min(1),
      summary: z.string().min(1),
      question: z.string().optional(),
      options: z.array(OPTION_SCHEMA).optional(),
      recommendation: z.string().optional(),
      nextStep: z.string().optional(),
      evidence: z.array(EVIDENCE_SCHEMA).optional(),
      localMetabotId: z.number().int().positive().optional(),
      localMetabotName: z.string().optional(),
      peerGlobalMetaId: z.string().optional(),
      peerName: z.string().optional(),
      sourceSessionId: z.string().optional(),
      workerSessionId: z.string().optional(),
      orchestrationTaskId: z.string().optional(),
      priority: z.number().int().optional(),
    },
    async (args) => {
      const res = control.enqueueFollowUp(sessionId, {
        tier: args.tier as FollowUpTier,
        informOutcome: (args.informOutcome as FollowUpInformOutcome | undefined) ?? null,
        sourceDomain: args.sourceDomain as FollowUpSourceDomain | undefined,
        reportingGranularity: args.reportingGranularity as FollowUpReportingGranularity | undefined,
        canonicalKey: args.canonicalKey ?? null,
        title: args.title,
        summary: args.summary,
        question: args.question,
        options: (args.options ?? []) as StudioDecisionOption[],
        recommendation: args.recommendation,
        nextStep: args.nextStep,
        evidence: (args.evidence ?? []) as StudioDecisionEvidence[],
        localMetabotId: args.localMetabotId ?? null,
        localMetabotName: args.localMetabotName ?? null,
        peerGlobalMetaId: args.peerGlobalMetaId ?? null,
        peerName: args.peerName ?? null,
        sourceSessionId: args.sourceSessionId ? stripSessionUriPrefix(args.sourceSessionId) : null,
        workerSessionId: args.workerSessionId ? stripSessionUriPrefix(args.workerSessionId) : null,
        orchestrationTaskId: args.orchestrationTaskId ?? null,
        priority: args.priority,
      });
      if ('error' in res) return textResult(`followup_enqueue refused: ${res.error}`, true);
      return textResult(
        JSON.stringify({
          ok: true,
          reused: res.reused,
          ...(res.skippedReason ? { skippedReason: res.skippedReason } : {}),
          item: res.item ? serializeItem(res.item) : null,
        }),
      );
    },
  );

  const resolveTool = tool(
    'followup_resolve',
    'Mark a Proactive Follow-Up Event (`pfu_...`) as resolved once the owner has answered, approved, declined, or acknowledged it in chat. Records an anti-self-excitation settle point and releases the presentation lock. Twin Bot only.',
    {
      followUpId: z.string().min(1),
      resolutionNote: z.string().min(1).describe('Concise summary of the owner decision or acknowledgement.'),
    },
    async (args) => {
      const res = control.resolveFollowUp(sessionId, args.followUpId, args.resolutionNote);
      if ('error' in res) return textResult(`followup_resolve refused: ${res.error}`, true);
      return textResult(
        JSON.stringify({
          ok: true,
          id: res.item.id,
          status: res.item.status,
          resolutionNote: res.item.resolutionNote,
        }),
      );
    },
  );

  const deferTool = tool(
    'followup_defer',
    'Defer the currently `presenting` Proactive Follow-Up Event back to the front of the queue ONLY when the owner ignores it to start an unrelated topic first. Twin Bot only.',
    {
      followUpId: z.string().optional(),
    },
    async (args) => {
      const res = control.deferFollowUp(sessionId, args.followUpId);
      if ('error' in res) return textResult(`followup_defer refused: ${res.error}`, true);
      return textResult(
        JSON.stringify({
          ok: true,
          id: res.item.id,
          status: res.item.status,
        }),
      );
    },
  );

  const replyA2ATool = tool(
    'followup_reply_a2a',
    'Steer or reopen a local Bot\'s A2A private-chat conversation (either TwinBot\'s own A2A session or any local Worker Bot\'s A2A session) according to the owner\'s ruling, automatically recording a settle point so the outgoing reply does not self-excite a duplicate follow-up, and resolving `followUpId` if provided. The target local Bot will express the intent naturally in its own voice. Twin Bot only.',
    {
      followUpId: z.string().optional().describe('Open follow-up ID (`pfu_...`) to resolve as part of this A2A reply.'),
      a2aSessionId: z.string().optional().describe('Target A2A session ID (or IDBots://<uuid>); inferred from followUpId.sourceSessionId if omitted.'),
      guidance: z.string().min(1).max(2000).describe('Clear operator intent for the local Bot to convey to the remote peer in its own voice (never mention internal prompts).'),
      resolutionNote: z.string().optional().describe('Optional resolution note stored on followUpId.'),
    },
    async (args) => {
      const res = await control.replyA2A(sessionId, {
        followUpId: args.followUpId,
        a2aSessionId: args.a2aSessionId ? stripSessionUriPrefix(args.a2aSessionId) : undefined,
        guidance: args.guidance,
        resolutionNote: args.resolutionNote,
      });
      if ('error' in res) return textResult(`followup_reply_a2a failed: ${res.error}`, true);
      return textResult(JSON.stringify(res));
    },
  );

  const promoteTool = tool(
    'followup_promote_to_task',
    'Promote a Proactive Follow-Up Event (`pfu_...`, typically `task_proposal` or an owner-approved multi-step `light_decision`) into a formal Managed Task (`long_term_tasks`), automatically linking the origin A2A session (`channel_bridge`) and Worker session (`worker_exec`), marking the follow-up `promoted`, and optionally sending a natural progress/acceptance reply in the A2A conversation. Twin Bot only.',
    {
      followUpId: z.string().min(1),
      title: z.string().optional().describe('Task card title (defaults to follow-up title).'),
      goal: z.string().optional().describe('Task goal and context (defaults to follow-up summary + owner ruling).'),
      subtasks: z.array(SUBTASK_DRAFT_SCHEMA).optional().describe('Optional multi-step subtasks; defaults to 1 active subtask.'),
      acceptanceCriteria: z.array(z.string()).optional(),
      assigneeMetabotId: z.number().int().positive().optional(),
      activateImmediately: z.boolean().optional().describe('Defaults to true once the owner just confirmed promotion.'),
      resolutionNote: z.string().optional(),
      peerReplyGuidance: z.string().max(2000).optional().describe('Optional intent to reply to the A2A peer right away (e.g. confirming we took the task on and will report back).'),
    },
    async (args) => {
      const res = await control.promoteFollowUpToTask(sessionId, {
        followUpId: args.followUpId,
        title: args.title,
        goal: args.goal,
        subtasks: args.subtasks as LongTermSubtaskDraft[] | undefined,
        acceptanceCriteria: args.acceptanceCriteria,
        assigneeMetabotId: args.assigneeMetabotId,
        activateImmediately: args.activateImmediately,
        resolutionNote: args.resolutionNote,
        peerReplyGuidance: args.peerReplyGuidance,
      });
      if ('error' in res) return textResult(`followup_promote_to_task failed: ${res.error}`, true);
      return textResult(JSON.stringify(res));
    },
  );

  return [listTool, enqueueTool, resolveTool, deferTool, replyA2ATool, promoteTool];
}
