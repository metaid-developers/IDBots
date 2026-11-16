import { z } from 'zod';
import type {
  EnqueueStudioDecisionInput,
  StudioDecisionEvidence,
  StudioDecisionKind,
  StudioDecisionOption,
  StudioDecisionQueueItem,
} from '../studioDecisionQueueStore';

type ToolFactory = <Schema extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<z.ZodObject<Schema>>, extra: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>,
) => unknown;

export interface TwinStampPublishItemInput {
  protocol: 'simplenote' | 'buzz';
  /** Verified Worker-produced Markdown/text file on disk (preferred for articles). */
  sourceFilePath?: string;
  title?: string;
  subtitle?: string;
  content?: string;
  tags?: string[];
  network?: 'mvc' | 'doge' | 'btc';
}

export interface StudioChiefOfStaffToolsControl {
  isTwinSession(sessionId: string): boolean;
  resolveTwinMetabotId(sessionId: string): number | null;
  enqueueDecision(
    sessionId: string,
    input: Omit<EnqueueStudioDecisionInput, 'twinMetabotId'>,
  ): { ok: true; item: StudioDecisionQueueItem; reused: boolean } | { ok: false; error: string };
  listOpenDecisions(sessionId: string): StudioDecisionQueueItem[];
  resolveDecision(
    sessionId: string,
    queueItemId: string,
    resolutionNote: string,
  ): { ok: true; item: StudioDecisionQueueItem } | { ok: false; error: string };
  deferDecision(
    sessionId: string,
    queueItemId?: string,
  ): { ok: true; item: StudioDecisionQueueItem } | { ok: false; error: string };
  markPresence(
    sessionId: string,
    mode: 'shaping' | 'idle',
    reason?: string,
  ): { ok: true } | { ok: false; error: string };
  focusTask?(
    sessionId: string,
    longtermTaskId: string,
  ): { ok: true; taskId: string } | { ok: false; error: string };
  dispatchTwinStampPublish?(
    sessionId: string,
    input: {
      items: TwinStampPublishItemInput[];
      approvalNote: string;
      decisionQueueId?: string;
      longtermTaskId?: string;
      longtermSubtaskId?: string;
    },
  ): Promise<{ ok: true; jobId: string; count: number } | { ok: false; error: string }>;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

const OPTION_SCHEMA = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
});

const EVIDENCE_SCHEMA = z.object({
  kind: z.enum(['dir', 'metaapp', 'pin', 'url', 'other']),
  uri: z.string().min(1),
  note: z.string().optional(),
});

const STAMP_ITEM_SCHEMA = z.object({
  protocol: z.enum(['simplenote', 'buzz']),
  sourceFilePath: z.string().optional().describe('Absolute path to the Worker-produced Markdown/text file to sign and publish under the Twin identity.'),
  title: z.string().optional().describe('Required for simplenote (if omitted, extracted from leading `# Title` of sourceFilePath).'),
  subtitle: z.string().optional(),
  content: z.string().optional().describe('Inline body only for short buzz posts; for simplenote articles prefer sourceFilePath produced by a Worker.'),
  tags: z.array(z.string()).optional(),
  network: z.enum(['mvc', 'doge', 'btc']).optional(),
});

export function buildStudioChiefOfStaffAgentTools(params: {
  tool: ToolFactory;
  control: StudioChiefOfStaffToolsControl;
  sessionId: string;
}): unknown[] {
  const { tool, control, sessionId } = params;
  if (!control.isTwinSession(sessionId)) {
    return [];
  }

  const enqueueTool = tool(
    'studio_decision_enqueue',
    'Enqueue ONE owner-facing decision, hiring proposal, stamp-publish sign-off, or final task acceptance into the Studio Owner Decision Queue. Twin Bot only. Use from back-office supervision (or after asynchronous checks) when a task genuinely needs the owner to rule or accept — NEVER interrupt an active Studio conversation directly. Provide all six decision-brief fields (backgroundSummary, progressSummary, question, options with recommended first, recommendation, nextStep) and optionally reportHtmlPath (a self-contained HTML briefing page under reports/*.html to project on the right screen when this item pops). Idempotent by dedupeKey.',
    {
      kind: z.enum(['decision', 'acceptance', 'hiring', 'stamp_publish', 'blocker']),
      title: z.string().min(1),
      backgroundSummary: z.string().min(1),
      progressSummary: z.string().min(1),
      question: z.string().min(1),
      options: z.array(OPTION_SCHEMA).optional(),
      recommendation: z.string().min(1),
      nextStep: z.string().min(1),
      reportHtmlPath: z.string().optional(),
      evidence: z.array(EVIDENCE_SCHEMA).optional(),
      orchestrationTaskId: z.string().optional(),
      longtermTaskId: z.string().optional(),
      longtermSubtaskId: z.string().optional(),
      originStudioSessionId: z.string().optional(),
      dedupeKey: z.string().optional(),
      priority: z.number().int().optional(),
    },
    async (args) => {
      const res = control.enqueueDecision(sessionId, {
        kind: args.kind as StudioDecisionKind,
        title: args.title,
        backgroundSummary: args.backgroundSummary,
        progressSummary: args.progressSummary,
        question: args.question,
        options: (args.options ?? []) as StudioDecisionOption[],
        recommendation: args.recommendation,
        nextStep: args.nextStep,
        reportHtmlPath: args.reportHtmlPath ?? null,
        evidence: (args.evidence ?? []) as StudioDecisionEvidence[],
        orchestrationTaskId: args.orchestrationTaskId ?? null,
        longtermTaskId: args.longtermTaskId ?? null,
        longtermSubtaskId: args.longtermSubtaskId ?? null,
        originStudioSessionId: args.originStudioSessionId ?? null,
        dedupeKey: args.dedupeKey ?? null,
        priority: args.priority,
      });
      if ('error' in res) return textResult(`studio_decision_enqueue refused: ${res.error}`, true);
      return textResult(JSON.stringify({
        ok: true,
        reused: res.reused,
        queueItem: {
          id: res.item.id,
          kind: res.item.kind,
          status: res.item.status,
          title: res.item.title,
        },
      }));
    },
  );

  const listTool = tool(
    'studio_decision_list',
    'List open items in the Studio Owner Decision Queue (`presenting` + `queued`). Twin Bot only. Call when the owner asks what awaits their decision/acceptance, or before enqueuing to check existing pending briefings.',
    {},
    async () => {
      const items = control.listOpenDecisions(sessionId);
      return textResult(JSON.stringify({
        ok: true,
        count: items.length,
        items: items.map((item) => ({
          id: item.id,
          status: item.status,
          kind: item.kind,
          title: item.title,
          question: item.question,
          recommendation: item.recommendation,
          longtermTaskId: item.longtermTaskId,
          orchestrationTaskId: item.orchestrationTaskId,
          reportHtmlPath: item.reportHtmlPath,
          createdAt: item.createdAt,
        })),
      }, null, 2));
    },
  );

  const resolveTool = tool(
    'studio_decision_resolve',
    'Mark a Studio Owner Decision Queue item as resolved once the owner has given their ruling or acceptance in chat. Twin Bot only. Calling this releases the queue lock so the next queued item can be presented when the conversation returns to idle.',
    {
      queueItemId: z.string().min(1),
      resolutionNote: z.string().min(1).describe('Concise record of what the owner decided.'),
    },
    async (args) => {
      const res = control.resolveDecision(sessionId, args.queueItemId, args.resolutionNote);
      if ('error' in res) return textResult(`studio_decision_resolve refused: ${res.error}`, true);
      return textResult(JSON.stringify({
        ok: true,
        id: res.item.id,
        status: res.item.status,
        resolutionNote: res.item.resolutionNote,
      }));
    },
  );

  const deferTool = tool(
    'studio_decision_defer',
    'Defer the currently presenting Studio briefing back to the front of the Owner Decision Queue when the owner changes topic or asks to discuss a new request first. Twin Bot only. Call immediately when the owner preempts an active briefing with an unrelated demand so you can focus 100% on their new request without losing the pending decision.',
    {
      queueItemId: z.string().optional(),
    },
    async (args) => {
      const res = control.deferDecision(sessionId, args.queueItemId);
      if ('error' in res) return textResult(`studio_decision_defer refused: ${res.error}`, true);
      return textResult(JSON.stringify({
        ok: true,
        id: res.item.id,
        status: res.item.status,
      }));
    },
  );

  const presenceTool = tool(
    'studio_presence_mark',
    'Explicitly set the Twin Studio front-office presence lock (`shaping` while waiting for the owner to clarify a half-formed requirement before creating/dispatching a task; `idle` once the task card is created/dispatched or during casual chat). Twin Bot only. While `shaping` is active, background task reports stay queued and will not interrupt the requirement discussion.',
    {
      mode: z.enum(['shaping', 'idle']),
      reason: z.string().optional(),
    },
    async (args) => {
      const res = control.markPresence(sessionId, args.mode, args.reason);
      if ('error' in res) return textResult(`studio_presence_mark refused: ${res.error}`, true);
      return textResult(JSON.stringify({ ok: true, mode: args.mode }));
    },
  );

  const tools: unknown[] = [enqueueTool, listTool, resolveTool, deferTool, presenceTool];

  if (control.focusTask) {
    tools.push(
      tool(
        'studio_task_focus',
        'Pin a specific Managed Task Tree card (`ltt_...`) as the active/focused task at the top of the Studio Live Stage progress HUD when the owner shifts conversation to that task. Twin Bot only.',
        {
          longtermTaskId: z.string().min(1).describe('Task ID (ltt_...) currently being discussed or advanced.'),
        },
        async (args) => {
          const res = control.focusTask!(sessionId, args.longtermTaskId);
          if ('error' in res) return textResult(`studio_task_focus refused: ${res.error}`, true);
          return textResult(JSON.stringify({ ok: true, focusedTaskId: res.taskId }));
        },
      ),
    );
  }

  if (control.dispatchTwinStampPublish) {
    tools.push(
      tool(
        'twin_stamp_publish',
        'Executive Stamp Publish ("总裁办盖章上链"): asynchronously sign and publish verified Worker-produced deliverable(s) on-chain under the Twin Bot\'s own MetaID identity in the background, without blocking the Studio chat turn. Twin Bot only. Use ONLY after: (1) a Worker Bot produced and verified the content file on disk, and (2) the owner explicitly approved on-chain publication in Studio. Dispatches immediately and delivers verified pin:// links back through the Studio queue once confirmed.',
        {
          items: z.array(STAMP_ITEM_SCHEMA).min(1).max(20),
          approvalNote: z.string().min(1).describe('Record of the owner\'s explicit go-ahead.'),
          decisionQueueId: z.string().optional().describe('Optional queue item id to auto-resolve as part of this stamp.'),
          longtermTaskId: z.string().optional(),
          longtermSubtaskId: z.string().optional(),
        },
        async (args) => {
          const res = await control.dispatchTwinStampPublish!(sessionId, {
            items: args.items as TwinStampPublishItemInput[],
            approvalNote: args.approvalNote,
            decisionQueueId: args.decisionQueueId,
            longtermTaskId: args.longtermTaskId,
            longtermSubtaskId: args.longtermSubtaskId,
          });
          if ('error' in res) return textResult(`twin_stamp_publish refused: ${res.error}`, true);
          return textResult(JSON.stringify({
            ok: true,
            jobId: res.jobId,
            count: res.count,
            message: `Queued ${res.count} item(s) for background Twin-signed publication. The Studio chat remains free; verified pin:// links will be reported automatically once broadcast completes.`,
          }));
        },
      ),
    );
  }

  return tools;
}
