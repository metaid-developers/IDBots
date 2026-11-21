import {
  classifyA2ATurnFollowUp,
  hasOwnerEscalationSignal,
  isComplexTaskCandidateText,
  type A2AFollowUpTriageInput,
} from '../cerebellum/a2aFollowUpTriage';
import { hasForceFollowUpSignal } from '../cerebellum/sessionFollowUpGate';
import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from '../cerebellum/memoryRank';
import type { CoworkSession } from '../coworkStore';
import type { OrchestrationAttempt, OrchestrationTask } from '../orchestrationStore';
import type {
  FollowUpTier,
  ProactiveFollowUpItem,
  ProactiveFollowUpStore,
} from '../proactiveFollowUpStore';

export interface WorldPerceptionA2ATurnEvent {
  sessionId: string;
  localMetabotId: number;
  localMetabotName: string;
  localMetabotType: 'twin' | 'worker' | string;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerMessageText: string;
  localReplyText?: string | null;
  sourcePinId?: string | null;
  replyPinId?: string | null;
  autoReplySuppressedReason?: 'auto_reply_disabled' | 'max_turns_reached' | null;
}

export interface WorldPerceptionWorkerSettlementEvent {
  task: OrchestrationTask;
  attempt: OrchestrationAttempt;
  workerName: string;
  outcome: 'completed' | 'failed';
  detail?: string | null;
  notifySummaryText: string;
}

export interface WorldPerceptionDeps {
  followUpStore: () => ProactiveFollowUpStore;
  resolveTwinMetabotId: () => number | null;
  getSession: (sessionId: string) => CoworkSession | null;
  getLatestWorkerAssistantText?: (workerSessionId: string) => string | null;
  hasActiveWorkerDelegationForSourceSession?: (sourceSessionId: string) => boolean;
  resolveCerebellum?: () =>
    | {
        config: ResolvedCerebellumConfig;
        fetchImpl: CerebellumFetchLike;
      }
    | null
    | Promise<{
        config: ResolvedCerebellumConfig;
        fetchImpl: CerebellumFetchLike;
      } | null>;
  /**
   * Optional auto-steering bridge: when a read-only Worker check spawned from an
   * A2A session finishes cleanly with NO owner approval needed, injects the
   * verified factual findings back into the A2A session so the peer bot gets its
   * promised answer instead of hanging indefinitely.
   */
  autoSteerCleanA2AWorkerCompletion?: (input: {
    a2aSessionId: string;
    workerName: string;
    taskId: string;
    summaryText: string;
  }) => Promise<void> | void;
  onFollowUpEnqueued?: (item: ProactiveFollowUpItem) => void;
  now?: () => number;
  emitLog?: (line: string) => void;
}

function collapseWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clipText(value: unknown, maxChars: number): string {
  const clean = collapseWhitespace(value);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Extracts explicit owner-action asks from Worker settlement payloads
 * (`humanAction`, `[ORCH-NOTIFY] ... 请求 owner 决策`, or force follow-up signals).
 */
export function extractWorkerOwnerActionSignal(text: string): {
  needsOwnerRuling: boolean;
  extractedQuestion: string | null;
} {
  const raw = String(text ?? '').trim();
  if (!raw) return { needsOwnerRuling: false, extractedQuestion: null };

  const humanActionMatch =
    raw.match(/humanAction\s*[:：]\s*([^\n]+)/i)
    ?? raw.match(/(?:请求\s*owner\s*决策|requested\s+owner\s+input)[^:：]*[:：]\s*([^\n]+)/i)
    ?? raw.match(
      /((?:请(?:主人|主理人|号主|人类|老板|owner|你)?(?:拍板|确认|批准|授权|定夺)|需要(?:你|主人|主理人|老板|人类|owner)?拍板|待(?:主人|主理人|老板|人类|owner)?(?:拍板|确认|批准)|需人工(?:确认|决策|处置|拍板))[^\n]*)/iu,
    );

  if (humanActionMatch?.[1]) {
    return {
      needsOwnerRuling: true,
      extractedQuestion: collapseWhitespace(humanActionMatch[1]),
    };
  }

  if (
    hasForceFollowUpSignal(raw)
    || hasOwnerEscalationSignal(raw)
    || /\(owner action required\)|（需要 owner 处理）/i.test(raw)
  ) {
    return {
      needsOwnerRuling: true,
      extractedQuestion: clipText(raw, 260),
    };
  }

  return { needsOwnerRuling: false, extractedQuestion: null };
}

export class ProactiveWorldPerceptionService {
  private readonly now: () => number;
  private readonly emitLog: (line: string) => void;

  constructor(private readonly deps: WorldPerceptionDeps) {
    this.now = deps.now ?? Date.now;
    this.emitLog = deps.emitLog ?? ((line) => console.log(line));
  }

  static buildA2ACanonicalKey(sessionId: string): string {
    return `a2a_session:${sessionId.trim()}`;
  }

  /**
   * Observes a completed or suppressed A2A private-chat turn across TwinBot and
   * all local Worker Bots. Converges everything noteworthy onto the owner's
   * single TwinBot FollowUp queue.
   */
  async observeA2ATurn(event: WorldPerceptionA2ATurnEvent): Promise<ProactiveFollowUpItem | null> {
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) return null;

    const sessionId = (event.sessionId ?? '').trim();
    if (!sessionId) return null;
    const canonicalKey = ProactiveWorldPerceptionService.buildA2ACanonicalKey(sessionId);
    const sourceMarker =
      collapseWhitespace(event.sourcePinId)
      || collapseWhitespace(event.replyPinId)
      || null;

    const store = this.deps.followUpStore();
    if (
      store.isBlockedBySettlePoint({
        twinMetabotId: twinId,
        canonicalKey,
        sourceMarker,
        nowMs: this.now(),
      })
    ) {
      return null;
    }

    const triageInput: A2AFollowUpTriageInput = {
      localBotName: event.localMetabotName,
      localBotRole: event.localMetabotType === 'twin' ? 'twin' : 'worker',
      peerName: event.peerName ?? null,
      peerGlobalMetaId: event.peerGlobalMetaId ?? null,
      peerMessageText: event.peerMessageText,
      localReplyText: event.localReplyText ?? null,
      autoReplySuppressedReason: event.autoReplySuppressedReason ?? null,
      hasActiveWorkerDelegation: Boolean(
        this.deps.hasActiveWorkerDelegationForSourceSession?.(sessionId),
      ),
    };

    const cerebellumCtx = this.deps.resolveCerebellum
      ? await this.deps.resolveCerebellum()
      : null;

    const verdict = await classifyA2ATurnFollowUp({
      triage: triageInput,
      cerebellum: cerebellumCtx,
    });

    if (verdict.action === 'silent') {
      return null;
    }

    const enqueued = store.enqueue(
      {
        canonicalKey,
        twinMetabotId: twinId,
        tier: verdict.tier,
        informOutcome: verdict.informOutcome ?? null,
        sourceDomain: 'a2a_chat',
        reportingGranularity: 'immediate',
        localMetabotId: event.localMetabotId,
        localMetabotName: event.localMetabotName,
        peerGlobalMetaId: event.peerGlobalMetaId ?? null,
        peerName: event.peerName ?? null,
        sourceSessionId: sessionId,
        title: verdict.title,
        summary: verdict.summary,
        question: verdict.question ?? '',
        recommendation: verdict.recommendation ?? '',
        nextStep:
          verdict.tier === 'task_proposal'
            ? `Owner confirms -> promote to Managed Task linked to IDBots://${sessionId} and notify ${event.peerName || 'peer'}.`
            : verdict.tier === 'light_decision'
              ? `Owner replies in chat -> steer IDBots://${sessionId} via A2A guidance.`
              : '',
        evidence: [
          {
            kind: 'other',
            uri: `IDBots://${sessionId}`,
            note: `A2A conversation (${event.localMetabotName} <-> ${event.peerName || event.peerGlobalMetaId || 'peer'})`,
          },
          ...(event.sourcePinId
            ? [{ kind: 'pin' as const, uri: `pin://${event.sourcePinId}`, note: 'Inbound peer message pin' }]
            : []),
        ],
        sourceMarker,
      },
      { nowMs: this.now() },
    );

    if (enqueued.item) {
      this.emitLog(
        `[WorldPerception] Enqueued A2A follow-up ${enqueued.item.id} (${enqueued.item.tier}${enqueued.item.informOutcome ? `:${enqueued.item.informOutcome}` : ''}, reused=${enqueued.reused}) for session ${sessionId}`,
      );
      this.deps.onFollowUpEnqueued?.(enqueued.item);
    }
    return enqueued.item;
  }

  /**
   * Fixes the `c3171c2c` A2A <- Worker black hole:
   * Intercepts Worker terminal settlements whose `task.sourceSessionId` is an
   * `'a2a'` session (which previously failed with `WRITE_NOT_ALLOWED_FOR_A2A`
   * and was also ignored by `StudioChiefOfStaffService.onStudioWorkerTerminalState`).
   */
  onWorkerSettledForA2ASession(event: WorldPerceptionWorkerSettlementEvent): boolean {
    const sourceSessionId = (event.task.sourceSessionId ?? '').trim();
    if (!sourceSessionId) return false;
    const a2aSession = this.deps.getSession(sourceSessionId);
    if (!a2aSession || a2aSession.sessionType !== 'a2a') {
      return false;
    }

    const twinId = this.deps.resolveTwinMetabotId() ?? event.task.twinMetabotId;
    if (!twinId) return false;

    const workerSessionId = (event.attempt.workerSessionId ?? '').trim() || null;
    const latestWorkerText = workerSessionId
      ? (this.deps.getLatestWorkerAssistantText?.(workerSessionId) ?? '')
      : '';
    const combinedReport = [
      event.notifySummaryText,
      event.detail ?? '',
      latestWorkerText,
    ]
      .filter(Boolean)
      .join('\n');

    const ownerSignal = extractWorkerOwnerActionSignal(combinedReport);
    const peerLabel = a2aSession.peerName || a2aSession.peerGlobalMetaId || '远端 Bot';
    const canonicalKey = ProactiveWorldPerceptionService.buildA2ACanonicalKey(sourceSessionId);
    const sourceMarker = `orch_attempt:${event.attempt.id}:${event.outcome}`;

    if (ownerSignal.needsOwnerRuling || event.outcome === 'failed') {
      const isComplex = isComplexTaskCandidateText(combinedReport) && event.outcome !== 'failed';
      const tier: FollowUpTier = isComplex ? 'task_proposal' : 'light_decision';
      const summaryExcerpt = clipText(latestWorkerText || event.detail || event.notifySummaryText, 360);
      const question = ownerSignal.extractedQuestion
        || (event.outcome === 'failed'
          ? `Worker ${event.workerName} 在跟进 ${peerLabel} 反馈事项时受阻，是否调整方案继续处理并回复对方？`
          : `Worker ${event.workerName} 已完成排查并请求拍板，是否批准执行对应方案并回复 ${peerLabel}？`);

      const enqueued = this.deps.followUpStore().enqueue(
        {
          canonicalKey,
          twinMetabotId: twinId,
          tier,
          sourceDomain: 'worker_escalation',
          reportingGranularity: 'immediate',
          priority: 40,
          localMetabotId: event.attempt.workerMetabotId,
          localMetabotName: event.workerName,
          peerGlobalMetaId: a2aSession.peerGlobalMetaId ?? null,
          peerName: a2aSession.peerName ?? null,
          sourceSessionId,
          workerSessionId,
          orchestrationTaskId: event.task.id,
          title: `${peerLabel} 关联事项待你拍板（${event.workerName} 已交回结论）`,
          summary: `针对与 ${peerLabel} 的线上会话（IDBots://${sourceSessionId}），${event.workerName} 已完成「${clipText(event.task.ownerIntent, 80)}」：${summaryExcerpt}`,
          question,
          recommendation: ownerSignal.needsOwnerRuling
            ? `建议核对 ${event.workerName} 的排查结论；你拍板后我可立即授权 ${event.workerName} 执行，并同步回复 ${peerLabel}。`
            : `请确认下一步处置口径，确认后我将同步推进并回复 ${peerLabel}。`,
          nextStep: workerSessionId
            ? `Authorize Worker session IDBots://${workerSessionId} (or promote to Task) and steer A2A session IDBots://${sourceSessionId}.`
            : `Steer A2A session IDBots://${sourceSessionId} with owner decision.`,
          evidence: [
            { kind: 'other', uri: `IDBots://${sourceSessionId}`, note: `Origin A2A session with ${peerLabel}` },
            ...(workerSessionId
              ? [{ kind: 'other' as const, uri: `IDBots://${workerSessionId}`, note: `Worker ${event.workerName} investigation session` }]
              : []),
          ],
          sourceMarker,
        },
        { nowMs: this.now(), bypassSettlePoint: true },
      );

      if (enqueued.item) {
        this.emitLog(
          `[WorldPerception] Captured A2A<-Worker escalation ${enqueued.item.id} (task=${event.task.id}, worker=${event.workerName}, a2a=${sourceSessionId})`,
        );
        this.deps.onFollowUpEnqueued?.(enqueued.item);
      }
      return true;
    }

    // Clean read-only / non-blocking Worker completion: record an `inform(handled)`
    // FollowUpEvent FIRST (before auto-steering writes its anti-echo settle point),
    // then steer the A2A session so the waiting remote peer receives the answer.
    const cleanSummary = clipText(latestWorkerText || event.notifySummaryText, 320);
    const enqueued = this.deps.followUpStore().enqueue(
      {
        canonicalKey,
        twinMetabotId: twinId,
        tier: 'inform',
        informOutcome: 'handled',
        sourceDomain: 'worker_escalation',
        reportingGranularity: 'immediate',
        localMetabotId: event.attempt.workerMetabotId,
        localMetabotName: event.workerName,
        peerGlobalMetaId: a2aSession.peerGlobalMetaId ?? null,
        peerName: a2aSession.peerName ?? null,
        sourceSessionId,
        workerSessionId,
        orchestrationTaskId: event.task.id,
        title: `${event.workerName} 已协助完成 ${peerLabel} 线上核查`,
        summary: `围绕与 ${peerLabel} 的线上对话，${event.workerName} 已完成「${clipText(event.task.ownerIntent, 80)}」：${cleanSummary}`,
        recommendation: '已自动衔接处理，仅向你知会一声。',
        evidence: [
          { kind: 'other', uri: `IDBots://${sourceSessionId}`, note: `Origin A2A session with ${peerLabel}` },
          ...(workerSessionId
            ? [{ kind: 'other' as const, uri: `IDBots://${workerSessionId}`, note: `Worker ${event.workerName} session` }]
            : []),
        ],
        sourceMarker,
      },
      { nowMs: this.now(), bypassSettlePoint: true },
    );

    if (enqueued.item) {
      this.deps.onFollowUpEnqueued?.(enqueued.item);
    }

    if (this.deps.autoSteerCleanA2AWorkerCompletion) {
      Promise.resolve(
        this.deps.autoSteerCleanA2AWorkerCompletion({
          a2aSessionId: sourceSessionId,
          workerName: event.workerName,
          taskId: event.task.id,
          summaryText: cleanSummary,
        }),
      ).catch((err) => {
        this.emitLog(
          `[WorldPerception] Auto-steer A2A after clean worker completion failed (${sourceSessionId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return true;
  }

  /**
   * Captures direct cross-session messages (`idbots_session_insert_user_message`)
   * sent by a Worker session toward an `'a2a'` target session, preventing silent
   * `WRITE_NOT_ALLOWED_FOR_A2A` loss when a Worker reports directly.
   */
  onDirectWorkerReportToA2ASession(input: {
    sourceSessionId: string;
    targetA2ASessionId: string;
    message: string;
    deliveryId?: string | null;
  }): boolean {
    const a2aSession = this.deps.getSession(input.targetA2ASessionId);
    if (!a2aSession || a2aSession.sessionType !== 'a2a') return false;
    const sourceSession = this.deps.getSession(input.sourceSessionId);
    if (!sourceSession) return false;
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) return false;

    const ownerSignal = extractWorkerOwnerActionSignal(input.message);
    const peerLabel = a2aSession.peerName || a2aSession.peerGlobalMetaId || '远端 Bot';
    const workerName = sourceSession.metabotName || `Bot #${sourceSession.metabotId ?? '?'}`;
    const canonicalKey = ProactiveWorldPerceptionService.buildA2ACanonicalKey(input.targetA2ASessionId);
    const tier: FollowUpTier = ownerSignal.needsOwnerRuling
      ? (isComplexTaskCandidateText(input.message) ? 'task_proposal' : 'light_decision')
      : 'inform';

    const enqueued = this.deps.followUpStore().enqueue(
      {
        canonicalKey,
        twinMetabotId: twinId,
        tier,
        informOutcome: tier === 'inform' ? 'handled' : null,
        sourceDomain: 'worker_escalation',
        reportingGranularity: 'immediate',
        priority: ownerSignal.needsOwnerRuling ? 40 : 100,
        localMetabotId: sourceSession.metabotId ?? null,
        localMetabotName: workerName,
        peerGlobalMetaId: a2aSession.peerGlobalMetaId ?? null,
        peerName: a2aSession.peerName ?? null,
        sourceSessionId: input.targetA2ASessionId,
        workerSessionId: input.sourceSessionId,
        title: ownerSignal.needsOwnerRuling
          ? `${peerLabel} 关联事项待你拍板（${workerName} 汇报）`
          : `${workerName} 已提交关于 ${peerLabel} 会话的协助结果`,
        summary: clipText(input.message, 380),
        question: ownerSignal.extractedQuestion ?? '',
        recommendation: ownerSignal.needsOwnerRuling
          ? '请确认是否按该方案执行并回复对方。'
          : '仅作知会汇报。',
        evidence: [
          { kind: 'other', uri: `IDBots://${input.targetA2ASessionId}`, note: `A2A session with ${peerLabel}` },
          { kind: 'other', uri: `IDBots://${input.sourceSessionId}`, note: `Worker ${workerName} session` },
        ],
        sourceMarker: input.deliveryId || `direct_report:${input.sourceSessionId}:${this.now()}`,
      },
      { nowMs: this.now(), bypassSettlePoint: true },
    );

    if (enqueued.item) {
      this.emitLog(
        `[WorldPerception] Routed direct Worker->A2A report into FollowUp ${enqueued.item.id} (${input.sourceSessionId} -> ${input.targetA2ASessionId})`,
      );
      this.deps.onFollowUpEnqueued?.(enqueued.item);
    }
    return true;
  }
}
