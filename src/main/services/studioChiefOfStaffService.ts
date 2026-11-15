import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import type { OrchestrationAttempt, OrchestrationTask } from '../orchestrationStore';
import type {
  EnqueueStudioDecisionInput,
  StudioDecisionQueueItem,
  StudioDecisionQueueStore,
} from '../studioDecisionQueueStore';
import {
  deriveStudioPresenceState,
  StudioPresenceTracker,
  type StudioTwinPresenceSnapshot,
} from './studioPresenceState';
import type { TwinStampPublishItemInput } from '../libs/studioChiefOfStaffAgentTools';

export const STUDIO_CHIEF_OF_STAFF_INTERVAL_MS = 5_000;
export const DEFAULT_SUPERVISION_COALESCE_MS = 1_200;

export interface StudioWorkerSettlementEvent {
  task: OrchestrationTask;
  attempt: OrchestrationAttempt;
  workerName: string;
  outcome: 'completed' | 'failed';
  detail?: string | null;
  notifySummaryText: string;
}

export interface StudioSiblingDelegationSummary {
  attemptId: string;
  workerName: string;
  title: string;
  status: string;
}

export interface StudioChiefOfStaffSessionStore {
  getSession(sessionId: string): CoworkSession | null;
  listSessions?(): Array<{
    id: string;
    title: string;
    sessionType?: string;
    assistantMode?: boolean;
    metabotId?: number | null;
    updatedAt?: number;
    archivedAt?: number | null;
    autoOrigin?: string | null;
  }>;
  createSession(
    title: string,
    cwd: string,
    systemPrompt?: string,
    executionMode?: 'local' | 'sandbox',
    activeSkillIds?: string[],
    metabotId?: number | null,
    sessionType?: 'standard' | 'browser' | 'a2a' | 'longterm',
  ): CoworkSession;
  setSessionAutoOrigin?(sessionId: string, origin: 'orchestration' | 'longterm' | 'schedule'): void;
  updateSession(sessionId: string, updates: Record<string, unknown>): void;
  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage;
}

export interface StudioChiefOfStaffRunner {
  isSessionActive(sessionId: string): boolean;
  startSession(
    sessionId: string,
    prompt: string,
    options?: {
      skipInitialUserMessage?: boolean;
      acknowledgeOwner?: boolean;
      confirmationMode?: 'modal' | 'text';
      permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
      autoApprove?: boolean;
    },
  ): Promise<void>;
}

export interface StudioChiefOfStaffCreatePinResult {
  pinId: string;
  txids?: string[];
  totalCost?: number;
}

export interface StudioChiefOfStaffDeps {
  decisionQueueStore: () => StudioDecisionQueueStore;
  coworkStore: () => StudioChiefOfStaffSessionStore;
  coworkRunner: () => StudioChiefOfStaffRunner;
  resolveTwinMetabotId: () => number | null;
  resolveTwinWorkspace: (twinMetabotId: number) => string;
  getBaseSystemPrompt?: () => string;
  getAppLanguage?: () => 'zh' | 'en';
  getPreferredStudioSessionId?: () => string | null;
  hasDefiningDraftForSession?: (sessionId: string) => boolean;
  listOpenSiblingDelegations?: (studioSessionId: string, longtermTaskId?: string | null) => StudioSiblingDelegationSummary[];
  projectShowcaseHtml?: (input: {
    sessionId: string;
    localPath: string;
    title: string;
  }) => Promise<unknown>;
  emitSessionMessage?: (sessionId: string, message: CoworkMessage) => void;
  onStateChanged?: (reason: string) => void;
  createPin?: (
    metabotId: number,
    payload: {
      operation: 'create';
      path: string;
      encryption: '0';
      version: string;
      contentType: string;
      payload: string;
    },
    options?: { network?: 'mvc' | 'doge' | 'btc'; origin?: string },
  ) => Promise<StudioChiefOfStaffCreatePinResult>;
  kv?: {
    get<T = unknown>(key: string): T | undefined;
    set<T = unknown>(key: string, value: T): void;
  };
  supervisionCoalesceMs?: number;
  idleDebounceMs?: number;
  now?: () => number;
  emitLog?: (line: string) => void;
}

interface PendingSupervisionBatch {
  scopeKey: string;
  twinMetabotId: number;
  originStudioSessionId: string;
  longtermTaskId: string | null;
  longtermSubtaskId: string | null;
  events: StudioWorkerSettlementEvent[];
  timer: ReturnType<typeof setTimeout> | null;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSupervisionPrompt(params: {
  originStudioSessionId: string;
  longtermTaskId: string | null;
  longtermSubtaskId: string | null;
  events: StudioWorkerSettlementEvent[];
  openSiblings: StudioSiblingDelegationSummary[];
  reportsDir: string;
  language: 'zh' | 'en';
}): string {
  const {
    originStudioSessionId,
    longtermTaskId,
    longtermSubtaskId,
    events,
    openSiblings,
    reportsDir,
    language,
  } = params;

  const eventLines = events.map((entry, idx) => [
    `### Settlement #${idx + 1}`,
    `- orchestrationTaskId: ${entry.task.id}`,
    `- taskIntent: ${entry.task.ownerIntent}`,
    `- worker: ${entry.workerName} (workerSession: IDBots://${entry.attempt.workerSessionId ?? 'unknown'})`,
    `- attemptId: ${entry.attempt.id} | stepId: ${entry.attempt.stepId} | outcome: ${entry.outcome}`,
    ...(entry.task.longtermTaskId ? [`- longtermTaskId: ${entry.task.longtermTaskId} | longtermSubtaskId: ${entry.task.longtermSubtaskId ?? 'none'}`] : []),
    `- workerSummaryPayload:`,
    entry.notifySummaryText,
  ].join('\n'));

  const siblingBlock = openSiblings.length > 0
    ? [
        `### Still-Running Parallel Sibling Delegations (${openSiblings.length})`,
        ...openSiblings.map((sib) => `- ${sib.workerName}: "${sib.title}" (status=${sib.status}, attempt=${sib.attemptId})`),
      ].join('\n')
    : '### Still-Running Parallel Sibling Delegations: NONE (all dispatched steps for this batch have settled)';

  return [
    '<studio_back_office_supervision>',
    'You are the Twin Bot running a SILENT BACK-OFFICE SUPERVISION turn.',
    'IMPORTANT: The owner CANNOT see messages in this back-office session. Never address the owner in plain chat text here — the Studio front-office conversation stays completely uninterrupted while you verify.',
    `Origin Studio session: ${originStudioSessionId}`,
    ...(longtermTaskId ? [`Linked Managed Task: ${longtermTaskId} (subtask: ${longtermSubtaskId ?? 'none'})`] : []),
    `Projector HTML output directory: ${reportsDir}`,
    `Owner UI language: ${language}`,
    '',
    ...eventLines,
    '',
    siblingBlock,
    '',
    '### Mandatory Chief-of-Staff Back-Office Protocol',
    '1. VERIFY WITH EVIDENCE: Treat every Worker claim as untrusted data. Inspect the actual produced files/evidence via `read`, `bash` (read-only checks), `twin_task_status`, or `idbots_session_read_latest` against the acceptance criteria.',
    '2. HANDLE DEFECTS SILENTLY: If a Worker failed, drifted, missed a criterion, or hit a technical error you can diagnose, DO NOT bother the owner — immediately issue corrective instructions via `twin_task_reassign` or `local_worker_delegate` from here.',
    '3. RECORD VERIFIED STEPS: For each step that verifiably meets its acceptance criteria, call `twin_task_accept` with concrete evidence (and update the linked task-tree subtask status if linked).',
    '4. PARALLEL CONSOLIDATION GATE: Look at "Still-Running Parallel Sibling Delegations" above. If sibling Workers are still running AND none of the settled steps raised a genuine blocking product decision that requires the owner right now, DO NOT call `studio_decision_enqueue` yet! Conclude this supervision turn quietly after recording your verification; you will be woken again as remaining siblings finish so the owner receives ONE consolidated briefing.',
    '5. ENQUEUE FOR OWNER RULING / FINAL ACCEPTANCE: Only when (a) all parallel steps for this deliverable stage are verified and ready for owner acceptance / stamp sign-off, OR (b) a genuine product/scope ambiguity or irreversible authorization blocks progress:',
    `   - First write ONE clean, self-contained visual HTML briefing page into "${reportsDir}/<descriptive-name>.html" (inline CSS, zero external assets, clear status badge at top, verified deliverables/metrics table, options + your recommendation, and next step).`,
    `   - Then call \`studio_decision_enqueue\` with \`originStudioSessionId: "${originStudioSessionId}"\`, \`reportHtmlPath\` set to that exact absolute HTML path, and all six decision-brief fields in ${language === 'zh' ? 'Chinese (中文)' : 'English'}.`,
    '</studio_back_office_supervision>',
  ].join('\n');
}

function buildProactiveBriefingPrompt(item: StudioDecisionQueueItem, remainingQueuedCount: number, language: 'zh' | 'en'): string {
  const optionsText = item.options.length > 0
    ? item.options
        .map((opt, index) => `${index + 1}. ${opt.recommended ? '[Recommended] ' : ''}${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
        .join('\n')
    : '(free-text owner confirmation)';

  if (language === 'zh') {
    return [
      '<studio_proactive_briefing>',
      '你现在正在主人的 Studio 常驻主会话中主动发起一次「超级助理汇报」。',
      '注意：这条触发指令对主人不可见，主人只会看到你接下来的回复以及右侧已自动切出的投影页面。',
      `队列项 ID: ${item.id} | 类型: ${item.kind} | 队列剩余待拍板数: ${remainingQueuedCount}`,
      `标题: ${item.title}`,
      `背景: ${item.backgroundSummary}`,
      `当前已核验进展: ${item.progressSummary}`,
      `需要主人拍板的事项: ${item.question}`,
      `选项:\n${optionsText}`,
      `你的首推建议与理由: ${item.recommendation}`,
      `主人拍板后的下一步: ${item.nextStep}`,
      ...(item.reportHtmlPath ? [`右侧投影屏已自动打开详情页: ${item.reportHtmlPath}（本轮无需再重复调用 projection_begin 或重写 HTML，直接引用右侧大屏即可）`] : []),
      '',
      '请直接以超级助理的口吻向主人简洁、清晰地汇报：先说结论和已完成核验的进展，再点明唯一需要他拍板的问题、你的推荐项及拍板后的下一步，引导他结合右侧大屏直接回复拍板（一次只聚焦这一件事，绝不混杂内部 ID 或机器标签）。',
      '</studio_proactive_briefing>',
    ].join('\n');
  }

  return [
    '<studio_proactive_briefing>',
    'You are proactively initiating a Chief-of-Staff briefing in the owner\'s persistent Studio conversation.',
    'Note: this trigger block is invisible to the owner; they will only see your reply and the right-hand projector page already opened for them.',
    `Queue item ID: ${item.id} | Kind: ${item.kind} | Remaining queued behind this: ${remainingQueuedCount}`,
    `Title: ${item.title}`,
    `Background: ${item.backgroundSummary}`,
    `Verified progress: ${item.progressSummary}`,
    `Decision needed from owner: ${item.question}`,
    `Options:\n${optionsText}`,
    `Your recommendation: ${item.recommendation}`,
    `Next step after owner ruling: ${item.nextStep}`,
    ...(item.reportHtmlPath ? [`Right-hand projector already displays: ${item.reportHtmlPath} (do NOT call projection_begin again this turn; reference the projected page directly).`] : []),
    '',
    'Speak directly to the owner as their Chief of Staff: lead with the verified outcome, state the ONE decision/acceptance needed, give your recommended call and what happens immediately after, and point to the right-side screen for full visual detail (never expose internal IDs or raw tags).',
    '</studio_proactive_briefing>',
  ].join('\n');
}

export class StudioChiefOfStaffService {
  readonly presenceTracker = new StudioPresenceTracker();
  private readonly pendingBatches = new Map<string, PendingSupervisionBatch>();
  private supervisionChain = new Map<string, Promise<void>>();
  private heartbeatInFlight = false;
  private readonly now: () => number;
  private readonly emitLog: (line: string) => void;
  private readonly coalesceMs: number;

  constructor(private readonly deps: StudioChiefOfStaffDeps) {
    this.now = deps.now ?? Date.now;
    this.emitLog = deps.emitLog ?? ((line: string) => console.log(line));
    this.coalesceMs = Math.max(0, deps.supervisionCoalesceMs ?? DEFAULT_SUPERVISION_COALESCE_MS);
  }

  isStudioOwnerSession(sessionId: string | null | undefined): boolean {
    if (!sessionId || !sessionId.trim()) return false;
    const session = this.deps.coworkStore().getSession(sessionId.trim());
    if (!session) return false;
    if (session.autoOrigin) return false;
    return session.sessionType === 'browser' && session.assistantMode === true;
  }

  resolveActiveStudioSessionId(twinMetabotId: number | null = this.deps.resolveTwinMetabotId()): string | null {
    if (twinMetabotId == null) return null;
    const store = this.deps.coworkStore();
    const preferred = this.deps.getPreferredStudioSessionId?.()?.trim() || null;
    if (preferred) {
      const session = store.getSession(preferred) as (CoworkSession & { archivedAt?: number | null }) | null;
      if (
        session
        && !session.archivedAt
        && session.sessionType === 'browser'
        && session.assistantMode === true
        && (session.metabotId == null || session.metabotId === twinMetabotId)
      ) {
        return session.id;
      }
    }
    const all = store.listSessions?.() ?? [];
    const candidates = all
      .filter((entry) =>
        !entry.archivedAt
        && !entry.autoOrigin
        && entry.sessionType === 'browser'
        && entry.assistantMode !== false
        && entry.metabotId === twinMetabotId,
      )
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    return candidates[0]?.id ?? null;
  }

  getPresenceSnapshot(nowMs: number = this.now()): StudioTwinPresenceSnapshot {
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) {
      return {
        mode: 'idle',
        reason: 'no Twin Bot configured',
        activeStudioSessionId: null,
        presentingItem: null,
        queuedCount: 0,
      };
    }
    const activeStudioSessionId = this.resolveActiveStudioSessionId(twinId);
    const openItems = this.deps.decisionQueueStore().listOpen(twinId);
    const presentingItem = openItems.find((item) => item.status === 'presenting') ?? null;
    const queuedCount = openItems.filter((item) => item.status === 'queued').length;
    const briefingTurnRunning = this.presenceTracker.isBriefingTurnRunning(activeStudioSessionId);
    const studioTurnRunning = activeStudioSessionId
      ? this.deps.coworkRunner().isSessionActive(activeStudioSessionId) && !briefingTurnRunning
      : false;
    const hasDefiningDraftInStudio = activeStudioSessionId
      ? Boolean(this.deps.hasDefiningDraftForSession?.(activeStudioSessionId))
      : false;
    const explicitShapingHoldReason = this.presenceTracker.getActiveShapingHoldReason(
      activeStudioSessionId,
      nowMs,
    );
    const lastNonBriefingTurnEndedAtMs = this.presenceTracker.getLastNonBriefingTurnEndedAtMs(
      activeStudioSessionId,
    );

    return deriveStudioPresenceState({
      activeStudioSessionId,
      studioTurnRunning,
      briefingTurnRunning,
      hasDefiningDraftInStudio,
      explicitShapingHoldReason,
      lastNonBriefingTurnEndedAtMs,
      presentingItem,
      queuedCount,
      nowMs,
      idleDebounceMs: this.deps.idleDebounceMs,
    });
  }

  buildVolatileTurnContext(sessionId: string): string {
    if (!this.isStudioOwnerSession(sessionId)) return '';
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) return '';
    const openItems = this.deps.decisionQueueStore().listOpen(twinId);
    if (openItems.length === 0) return '';
    const presenting = openItems.find((item) => item.status === 'presenting') ?? null;
    const queuedCount = openItems.filter((item) => item.status === 'queued').length;
    const blocks: string[] = [];

    if (presenting) {
      blocks.push([
        '<active_studio_briefing>',
        `You are currently awaiting the owner's ruling on Studio Decision Queue item "${presenting.id}" (${presenting.kind}): "${presenting.title}".`,
        `Question asked: ${presenting.question}`,
        `Recommended option: ${presenting.recommendation}`,
        `Planned next step: ${presenting.nextStep}`,
        `Queued items waiting behind this one: ${queuedCount}`,
        'Routing rule for THIS owner message:',
        `- If the owner is answering, approving, modifying, or rejecting "${presenting.title}": call \`studio_decision_resolve({ queueItemId: "${presenting.id}", resolutionNote: "..." })\` FIRST, then immediately trigger the approved next step (delegate rework/next step via \`local_worker_delegate\`, or run \`twin_stamp_publish\` if they approved Twin-signed chain publication).`,
        `- If the owner ignores this briefing or raises a DIFFERENT topic / new task request: call \`studio_decision_defer({ queueItemId: "${presenting.id}" })\` FIRST (so this item returns safely to the front of the queue), then focus 100% on the owner's new request!`,
        '</active_studio_briefing>',
      ].join('\n'));
    } else if (queuedCount > 0) {
      blocks.push(
        `<studio_queue_awareness>There are currently ${queuedCount} verified item(s) waiting quietly in your Studio Owner Decision Queue (inspectable via studio_decision_list). Do NOT blurt them out mid-task while shaping a new owner demand — the Studio heartbeat will automatically present the head item as soon as this topic settles to idle, UNLESS the owner explicitly asks for pending items right now.</studio_queue_awareness>`,
      );
    }

    return blocks.join('\n\n');
  }

  /**
   * Intercepts Worker terminal transitions originating from a Studio session.
   * Returns true when handled (suppressing [ORCH-NOTIFY] injection into the
   * owner's front-office Studio session).
   */
  onStudioWorkerTerminalState(event: StudioWorkerSettlementEvent): boolean {
    const originSessionId = (event.task.sourceSessionId ?? '').trim();
    if (!this.isStudioOwnerSession(originSessionId)) {
      return false;
    }

    const scopeKey = event.task.longtermTaskId
      ? `ltt:${event.task.longtermTaskId}`
      : `studio:${originSessionId}`;

    let batch = this.pendingBatches.get(scopeKey);
    if (!batch) {
      batch = {
        scopeKey,
        twinMetabotId: event.task.twinMetabotId,
        originStudioSessionId: originSessionId,
        longtermTaskId: event.task.longtermTaskId ?? null,
        longtermSubtaskId: event.task.longtermSubtaskId ?? null,
        events: [],
        timer: null,
      };
      this.pendingBatches.set(scopeKey, batch);
    }
    batch.events.push(event);
    if (event.task.longtermTaskId) batch.longtermTaskId = event.task.longtermTaskId;
    if (event.task.longtermSubtaskId) batch.longtermSubtaskId = event.task.longtermSubtaskId;

    if (batch.timer) clearTimeout(batch.timer);
    if (this.coalesceMs === 0) {
      this.pendingBatches.delete(scopeKey);
      this.enqueueBackOfficeSupervision(batch);
    } else {
      batch.timer = setTimeout(() => {
        this.pendingBatches.delete(scopeKey);
        this.enqueueBackOfficeSupervision(batch!);
      }, this.coalesceMs);
      batch.timer.unref?.();
    }

    this.deps.onStateChanged?.('worker_settled');
    return true;
  }

  private resolveOrCreateSupervisionSession(batch: PendingSupervisionBatch): string {
    const kvKey = `studio_supervision_session:${batch.scopeKey}`;
    const store = this.deps.coworkStore();
    const existingId = this.deps.kv?.get<string>(kvKey);
    if (existingId && store.getSession(existingId)) {
      return existingId;
    }
    const workspace = this.deps.resolveTwinWorkspace(batch.twinMetabotId);
    const label = batch.events[0]?.task.ownerIntent?.trim().slice(0, 36) || 'Studio Task';
    const session = store.createSession(
      `[督办] ${label}`,
      workspace,
      this.deps.getBaseSystemPrompt?.() ?? '',
      'local',
      [],
      batch.twinMetabotId,
      'standard',
    );
    store.setSessionAutoOrigin?.(session.id, 'orchestration');
    this.deps.kv?.set(kvKey, session.id);
    return session.id;
  }

  private enqueueBackOfficeSupervision(batch: PendingSupervisionBatch): void {
    const prior = this.supervisionChain.get(batch.scopeKey) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.runBackOfficeSupervision(batch))
      .catch((error) => {
        this.emitLog(
          `[StudioChiefOfStaff] Back-office supervision failed (${batch.scopeKey}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    this.supervisionChain.set(batch.scopeKey, next);
  }

  private async runBackOfficeSupervision(batch: PendingSupervisionBatch): Promise<void> {
    const supervisionSessionId = this.resolveOrCreateSupervisionSession(batch);
    const workspace = this.deps.resolveTwinWorkspace(batch.twinMetabotId);
    const reportsDir = path.join(workspace, 'reports');
    try {
      fs.mkdirSync(reportsDir, { recursive: true });
    } catch {
      // Best-effort directory creation.
    }
    const openSiblings = this.deps.listOpenSiblingDelegations?.(
      batch.originStudioSessionId,
      batch.longtermTaskId,
    ) ?? [];
    const language = this.deps.getAppLanguage?.() ?? 'zh';
    const prompt = buildSupervisionPrompt({
      originStudioSessionId: batch.originStudioSessionId,
      longtermTaskId: batch.longtermTaskId,
      longtermSubtaskId: batch.longtermSubtaskId,
      events: batch.events,
      openSiblings,
      reportsDir,
      language,
    });

    const store = this.deps.coworkStore();
    store.updateSession(supervisionSessionId, { status: 'running' });
    store.addMessage(supervisionSessionId, {
      type: 'user',
      content: prompt,
      metadata: {
        isDelegationInternal: true,
        origin: 'studio_supervision',
        originStudioSessionId: batch.originStudioSessionId,
      },
    });
    await this.deps.coworkRunner().startSession(supervisionSessionId, prompt, {
      skipInitialUserMessage: true,
      acknowledgeOwner: false,
      confirmationMode: 'text',
      permissionMode: 'acceptEdits',
      autoApprove: true,
    });
    this.deps.onStateChanged?.('supervision_completed');
  }

  /**
   * Heartbeat handler (`studio.chiefOfStaff`): cheap local state check.
   * When the Twin's Studio front-office presence is `'idle'` and an owner
   * decision/acceptance item is queued, claims the head item, projects its
   * HTML briefing onto the right-hand screen, and triggers a proactive Twin
   * briefing turn in the active Studio conversation.
   */
  async runHeartbeatTick(nowMs: number = this.now()): Promise<{
    presentedItemId: string | null;
    presence: StudioTwinPresenceSnapshot;
  }> {
    const snapshot = this.getPresenceSnapshot(nowMs);
    if (this.heartbeatInFlight) {
      return { presentedItemId: null, presence: snapshot };
    }
    const twinId = this.deps.resolveTwinMetabotId();
    if (
      twinId == null
      || snapshot.mode !== 'idle'
      || snapshot.queuedCount === 0
      || !snapshot.activeStudioSessionId
    ) {
      return { presentedItemId: null, presence: snapshot };
    }

    const studioSessionId = snapshot.activeStudioSessionId;
    const claimed = this.deps.decisionQueueStore().claimNextForPresentation(
      twinId,
      studioSessionId,
      new Date(nowMs).toISOString(),
    );
    if (!claimed) {
      return { presentedItemId: null, presence: this.getPresenceSnapshot(nowMs) };
    }

    this.heartbeatInFlight = true;
    this.presenceTracker.setBriefingTurnRunning(studioSessionId, true);
    this.deps.onStateChanged?.('briefing_started');

    try {
      if (claimed.reportHtmlPath && fs.existsSync(claimed.reportHtmlPath) && this.deps.projectShowcaseHtml) {
        try {
          await this.deps.projectShowcaseHtml({
            sessionId: studioSessionId,
            localPath: claimed.reportHtmlPath,
            title: claimed.title,
          });
        } catch (projErr) {
          this.emitLog(
            `[StudioChiefOfStaff] Showcase projection failed for ${claimed.id}: ` +
              `${projErr instanceof Error ? projErr.message : String(projErr)}`,
          );
        }
      }

      const remainingQueued = this.deps.decisionQueueStore()
        .listOpen(twinId)
        .filter((item) => item.status === 'queued').length;
      const language = this.deps.getAppLanguage?.() ?? 'zh';
      const briefingPrompt = buildProactiveBriefingPrompt(claimed, remainingQueued, language);

      const store = this.deps.coworkStore();
      store.updateSession(studioSessionId, { status: 'running' });
      const triggerMsg = store.addMessage(studioSessionId, {
        type: 'user',
        content: briefingPrompt,
        metadata: {
          isDelegationInternal: true,
          origin: 'studio_briefing',
          decisionQueueId: claimed.id,
        },
      });
      this.deps.emitSessionMessage?.(studioSessionId, triggerMsg);

      await this.deps.coworkRunner().startSession(studioSessionId, briefingPrompt, {
        skipInitialUserMessage: true,
        acknowledgeOwner: false,
      });

      return {
        presentedItemId: claimed.id,
        presence: this.getPresenceSnapshot(this.now()),
      };
    } catch (error) {
      this.emitLog(
        `[StudioChiefOfStaff] Proactive briefing turn failed (${claimed.id}); deferring back to queue: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      this.deps.decisionQueueStore().deferPresenting(claimed.id);
      return {
        presentedItemId: null,
        presence: this.getPresenceSnapshot(this.now()),
      };
    } finally {
      this.presenceTracker.setBriefingTurnRunning(studioSessionId, false);
      this.heartbeatInFlight = false;
      this.deps.onStateChanged?.('briefing_settled');
    }
  }

  /**
   * Executive Stamp Publish ("总裁办盖章上链"): reads Worker-authored local
   * files, signs and publishes them asynchronously under the Twin Bot's own
   * MetaID identity, and enqueues a verified delivery receipt into the Studio
   * queue without blocking the live chat turn.
   */
  async dispatchTwinStampPublish(
    callerSessionId: string,
    input: {
      items: TwinStampPublishItemInput[];
      approvalNote: string;
      decisionQueueId?: string;
      longtermTaskId?: string;
      longtermSubtaskId?: string;
    },
  ): Promise<{ ok: true; jobId: string; count: number } | { ok: false; error: string }> {
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) {
      return { ok: false, error: 'TWIN_NOT_FOUND' };
    }
    if (!this.deps.createPin) {
      return { ok: false, error: 'CHAIN_WRITE_UNAVAILABLE' };
    }

    const prepared: Array<{
      protocol: 'simplenote' | 'buzz';
      title: string;
      subtitle: string;
      body: string;
      tags: string[];
      network: 'mvc' | 'doge' | 'btc';
    }> = [];

    for (const item of input.items) {
      let rawBody = (item.content ?? '').trim();
      let inferredTitle = (item.title ?? '').trim();
      if (item.sourceFilePath) {
        const resolvedPath = path.resolve(item.sourceFilePath.trim());
        if (!fs.existsSync(resolvedPath)) {
          return { ok: false, error: `SOURCE_FILE_NOT_FOUND: ${resolvedPath}` };
        }
        const diskText = fs.readFileSync(resolvedPath, 'utf8');
        const headingMatch = diskText.match(/^#\s+(.+)\r?\n/);
        if (!inferredTitle && headingMatch) {
          inferredTitle = headingMatch[1].trim();
        }
        rawBody = headingMatch ? diskText.slice(headingMatch[0].length).trim() : diskText.trim();
      }
      if (!rawBody) {
        return { ok: false, error: 'EMPTY_PUBLISH_CONTENT' };
      }
      if (item.protocol === 'simplenote' && !inferredTitle) {
        return { ok: false, error: 'SIMPLENOTE_TITLE_REQUIRED' };
      }
      prepared.push({
        protocol: item.protocol,
        title: inferredTitle || rawBody.slice(0, 48),
        subtitle: (item.subtitle ?? '').trim(),
        body: rawBody,
        tags: (item.tags ?? []).map((t) => t.trim()).filter(Boolean),
        network: item.network ?? 'mvc',
      });
    }

    if (input.decisionQueueId) {
      this.deps.decisionQueueStore().resolve(input.decisionQueueId, input.approvalNote);
    }

    const jobId = `stamp_${uuidv4().slice(0, 8)}`;
    const originStudioSessionId = this.isStudioOwnerSession(callerSessionId)
      ? callerSessionId
      : this.resolveActiveStudioSessionId(twinId);

    void this.executeStampPublishInBackground({
      jobId,
      twinId,
      originStudioSessionId,
      approvalNote: input.approvalNote,
      longtermTaskId: input.longtermTaskId ?? null,
      longtermSubtaskId: input.longtermSubtaskId ?? null,
      prepared,
    });

    return { ok: true, jobId, count: prepared.length };
  }

  private async executeStampPublishInBackground(params: {
    jobId: string;
    twinId: number;
    originStudioSessionId: string | null;
    approvalNote: string;
    longtermTaskId: string | null;
    longtermSubtaskId: string | null;
    prepared: Array<{
      protocol: 'simplenote' | 'buzz';
      title: string;
      subtitle: string;
      body: string;
      tags: string[];
      network: 'mvc' | 'doge' | 'btc';
    }>;
  }): Promise<void> {
    const receipts: Array<{ title: string; pinId: string; cost: number; error?: string }> = [];
    for (const entry of params.prepared) {
      try {
        if (entry.protocol === 'simplenote') {
          const payload = JSON.stringify({
            title: entry.title,
            subtitle: entry.subtitle,
            coverImg: '',
            contentType: 'text/markdown',
            content: entry.body,
            encryption: '0',
            createTime: this.now(),
            tags: entry.tags,
            attachments: [],
          });
          const res = await this.deps.createPin!(
            params.twinId,
            {
              operation: 'create',
              path: '/protocols/simplenote',
              encryption: '0',
              version: '1.0.1',
              contentType: 'application/json',
              payload,
            },
            { network: entry.network, origin: 'tool:twin_stamp_publish' },
          );
          receipts.push({ title: entry.title, pinId: res.pinId, cost: res.totalCost ?? 0 });
        } else {
          const payload = JSON.stringify({
            content: entry.body,
            contentType: 'text/plain;utf-8',
            attachments: [],
          });
          const res = await this.deps.createPin!(
            params.twinId,
            {
              operation: 'create',
              path: '/protocols/simplebuzz',
              encryption: '0',
              version: '1.0.0',
              contentType: 'application/json',
              payload,
            },
            { network: entry.network, origin: 'tool:twin_stamp_publish' },
          );
          receipts.push({ title: entry.title, pinId: res.pinId, cost: res.totalCost ?? 0 });
        }
      } catch (error) {
        receipts.push({
          title: entry.title,
          pinId: '',
          cost: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const workspace = this.deps.resolveTwinWorkspace(params.twinId);
    const reportsDir = path.join(workspace, 'reports');
    let reportHtmlPath: string | null = null;
    try {
      fs.mkdirSync(reportsDir, { recursive: true });
      const filePath = path.join(reportsDir, `${params.jobId}-receipt.html`);
      const rowsHtml = receipts
        .map((r) => r.error
          ? `<tr><td>${escapeHtml(r.title)}</td><td style="color:#b91c1c">Failed: ${escapeHtml(r.error)}</td><td>-</td></tr>`
          : `<tr><td>${escapeHtml(r.title)}</td><td><code>pin://${escapeHtml(r.pinId)}</code></td><td>${r.cost} sats</td></tr>`)
        .join('\n');
      fs.writeFileSync(
        filePath,
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>On-Chain Stamp Receipt</title>` +
          `<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f5f6f8;color:#15181c;padding:28px;margin:0}` +
          `.card{max-width:860px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.05)}` +
          `.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#dcfce7;color:#166534;margin-bottom:10px}` +
          `table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e5e7eb}code{font-size:12px;word-break:break-all}</style></head>` +
          `<body><div class="card"><span class="badge">Twin Stamp Published</span><h1 style="font-size:20px;margin:0 0 8px">On-Chain Publication Receipt (${receipts.filter((r) => !r.error).length}/${receipts.length})</h1>` +
          `<p style="font-size:13px;color:#4b5563;margin:0">Approved: ${escapeHtml(params.approvalNote)}</p>` +
          `<table><thead><tr><th>Deliverable</th><th>MetaWeb Pin URI</th><th>Network Fee</th></tr></thead><tbody>${rowsHtml}</tbody></table></div></body></html>`,
        'utf8',
      );
      reportHtmlPath = filePath;
    } catch {
      reportHtmlPath = null;
    }

    const okCount = receipts.filter((r) => !r.error).length;
    const language = this.deps.getAppLanguage?.() ?? 'zh';
    const pinLines = receipts
      .map((r) => r.error ? `- ${r.title}: FAILED (${r.error})` : `- [${r.title}](pin://${r.pinId})`)
      .join('\n');

    const enqueueInput: EnqueueStudioDecisionInput = {
      dedupeKey: `stamp_receipt:${params.jobId}`,
      twinMetabotId: params.twinId,
      originStudioSessionId: params.originStudioSessionId,
      longtermTaskId: params.longtermTaskId,
      longtermSubtaskId: params.longtermSubtaskId,
      kind: okCount === receipts.length ? 'acceptance' : 'blocker',
      priority: 50,
      title: language === 'zh'
        ? `链上盖章发布回执（成功 ${okCount}/${receipts.length}）`
        : `On-Chain Stamp Receipt (${okCount}/${receipts.length} published)`,
      backgroundSummary: params.approvalNote,
      progressSummary: pinLines,
      question: language === 'zh'
        ? okCount === receipts.length
          ? '全部内容已在后台以你的分身身份上链完毕，请过目验收归档。'
          : '部分条目上链遇到问题，请决定是否重试失败项。'
        : okCount === receipts.length
          ? 'All items have been published on-chain under your Twin identity; please confirm final closure.'
          : 'Some items failed to broadcast; please confirm whether to retry the failed entries.',
      recommendation: language === 'zh'
        ? okCount === receipts.length ? '确认归档结项' : '仅对失败条目补发上链'
        : okCount === receipts.length ? 'Confirm and close task' : 'Retry failed entries only',
      nextStep: language === 'zh'
        ? '更新任务树为已完成并归档本次发布链接'
        : 'Mark task completed and archive the published pin:// URIs',
      reportHtmlPath,
      evidence: receipts
        .filter((r) => r.pinId)
        .map((r) => ({ kind: 'pin' as const, uri: `pin://${r.pinId}`, note: r.title })),
    };
    this.deps.decisionQueueStore().enqueue(enqueueInput);
  }
}
