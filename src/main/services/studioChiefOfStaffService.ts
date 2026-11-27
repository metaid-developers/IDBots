import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import type { StudioContinuitySnapshot } from '../dreamStore';
import type { OrchestrationAttempt, OrchestrationTask } from '../orchestrationStore';
import type {
  EnqueueStudioDecisionInput,
  StudioDecisionQueueItem,
  StudioDecisionQueueStore,
} from '../studioDecisionQueueStore';
import type {
  ProactiveFollowUpItem,
  ProactiveFollowUpStore,
} from '../proactiveFollowUpStore';
import {
  deriveStudioPresenceState,
  StudioPresenceTracker,
  type StudioTwinPresenceSnapshot,
} from './studioPresenceState';
import type { TwinStampPublishItemInput } from '../libs/studioChiefOfStaffAgentTools';
import { buildStudioDecisionReportHtml } from '../libs/studioDecisionReportHtml';
import {
  localFilesystemPathFromArtifactRef,
  previewMetaappUriForPath,
} from '../libs/localPreviewUri';
import { formatCompactTwinTodosPromptBlock } from '../libs/twinTodoAgentTools';
import type { TwinTodoItem } from '../twinTodoStore';
import { isServerMode } from '../server/serverMode';
import { sanitizeTurnAckReplyForInput, type StudioWaitReassuranceInput } from '../libs/turnAckReply';

export const STUDIO_CHIEF_OF_STAFF_INTERVAL_MS = 5_000;
export const DEFAULT_SUPERVISION_COALESCE_MS = 1_200;
/**
 * Progressive waiting reassurance schedule (owner ruling 2026-11-16):
 * 1st notice after 5m of quiet waiting, then +10m (15m total), +15m (30m total),
 * +20m (50m total, and every +20m thereafter). Never fixed 5-minute spam.
 */
export const DEFAULT_WAITING_REASSURANCE_INTERVALS_MS: readonly number[] = [
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  20 * 60_000,
];

export interface ActiveStudioSupervisionEntry {
  attemptId: string;
  workerMetabotId: number;
  workerName: string;
  workerSessionId?: string;
  title: string;
  startedAt: number;
}

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
  workerMetabotId?: number;
  workerName: string;
  workerSessionId?: string;
  longtermTaskId?: string | null;
  title: string;
  status: string;
  startedAt?: number;
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
    hiddenFromSessionList?: boolean;
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
  getStudioContinuity?: (twinMetabotId: number) => StudioContinuitySnapshot | null;
  /** Terminal-stage tasks (done/cancelled) resolved after a given epoch ms — feeds the dream-brief reconciliation block. */
  listTasksResolvedSince?: (sinceMs: number) => StudioResolvedTaskRef[];
  listPendingTwinTodos?: (twinMetabotId: number) => TwinTodoItem[];
  hasDefiningDraftForSession?: (sessionId: string) => boolean;
  listOpenSiblingDelegations?: (studioSessionId: string, longtermTaskId?: string | null) => StudioSiblingDelegationSummary[];
  projectShowcaseHtml?: (input: {
    sessionId: string;
    localPath: string;
    title: string;
  }) => Promise<unknown>;
  didSessionProjectSince?: (sessionId: string, sinceMs: number) => boolean;
  resolvePublisherIdentity?: (metabotId: number) => {
    name: string;
    role: string;
    globalMetaId?: string | null;
    address?: string | null;
  };
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
  waitingReassuranceIntervalsMs?: readonly number[];
  /** Cheap local SQLite watermark of active tasks to broadcast live Worker DB updates on each 5s tick. */
  getTaskWatermark?: () => string;
  /** Live Worker progress checkpoint recorded on a Managed Task (`progress_note`). */
  getTaskProgressNote?: (longtermTaskId: string | null | undefined) => string | null;
  /** One-shot LLM generator for non-repeating Studio background wait check-ins. */
  generateWaitingReassurance?: (input: StudioWaitReassuranceInput) => Promise<string>;
  /** Lightweight 3-tier Proactive Follow-Up queue (`inform` / `light_decision` / `task_proposal`). */
  followUpStore?: () => ProactiveFollowUpStore;
  /** True when running as a 24/7 headless Cloud Tenant (`IDBots --server`). */
  isServerMode?: () => boolean;
  /** Fired once a Proactive Follow-Up briefing turn completes cleanly in the primary Twin stream. */
  onProactiveFollowUpDeliveredToSession?: (input: {
    item: ProactiveFollowUpItem;
    sessionId: string;
    isPrimaryNonStudioFallback: boolean;
  }) => void;
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

function clipCleanTitle(raw: string, maxChars: number = 36): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  let sliced = normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  // Avoid stranding a dangling opening bracket right before the ellipsis
  // (e.g. "BTC UTXO <1000 过滤与转账下限对齐 Metalet（S6 " -> close or trim cleanly).
  const lastFullOpen = sliced.lastIndexOf('（');
  const lastFullClose = sliced.lastIndexOf('）');
  if (lastFullOpen > lastFullClose && sliced.length - lastFullOpen <= 6) {
    sliced = sliced.slice(0, lastFullOpen).trimEnd();
  }
  const lastAsciiOpen = sliced.lastIndexOf('(');
  const lastAsciiClose = sliced.lastIndexOf(')');
  if (lastAsciiOpen > lastAsciiClose && sliced.length - lastAsciiOpen <= 6) {
    sliced = sliced.slice(0, lastAsciiOpen).trimEnd();
  }
  return `${sliced}…`;
}

export interface StudioResolvedTaskRef {
  id: string;
  title: string;
  stage: 'done' | 'cancelled';
  resolvedAtIso: string;
}

const DREAM_BRIEF_RECONCILIATION_TITLE_MAX_CHARS = 80;
const DREAM_BRIEF_RECONCILIATION_MAX_ITEMS = 8;

/** Local-midnight epoch ms for a `YYYY-MM-DD` dreamDate label (NaN when malformed). */
export function dreamDateLocalMidnightMs(dreamDate: string): number {
  return Date.parse(`${dreamDate}T00:00:00`);
}

/**
 * The dream-brief reconciliation block. The nightly <studio_continuity_brief>
 * is a static distillation: a workstream it lists as open may already be
 * resolved hours later (2026-11-19 incident — two tasks were closed at 02:47
 * while the brief still asked the owner to green-light the fix, and the Twin
 * copied the stale line into a "waiting owner decision" list). Reconciling at
 * injection time keeps the snapshot immutable, works regardless of when the
 * dream actually ran, and makes the live task table authoritative without
 * parsing free-text workstream lines. Null when nothing resolved — no block,
 * no tokens.
 */
export function buildDreamBriefTaskReconciliation(
  dreamDate: string,
  resolved: readonly StudioResolvedTaskRef[],
): string | null {
  const usable = resolved
    .map((task) => ({
      id: String(task?.id ?? '').trim(),
      title: clipCleanTitle(String(task?.title ?? ''), DREAM_BRIEF_RECONCILIATION_TITLE_MAX_CHARS),
      stage: task?.stage === 'cancelled' ? ('cancelled' as const) : ('done' as const),
      resolvedAtIso: String(task?.resolvedAtIso ?? '').trim(),
    }))
    .filter((task) => task.id && task.title)
    .slice(0, DREAM_BRIEF_RECONCILIATION_MAX_ITEMS);
  if (usable.length === 0) return null;
  return [
    `<dream_brief_task_reconciliation dreamDate="${escapeHtml(dreamDate)}">`,
    `Tasks RESOLVED (done/cancelled) since ${escapeHtml(dreamDate)} — the live <active_tasks_radar> is authoritative and no longer lists them:`,
    ...usable.map((task) => `- [${task.stage}] "${task.title}" (taskId=${task.id}, resolvedAt=${task.resolvedAtIso})`),
    'Rule: if a workstream line in <studio_continuity_brief> corresponds to a task listed here, that workstream is ALREADY RESOLVED — never re-surface it as pending and never fold it into a waiting-for-owner list. For ANY brief line whose topic is absent from <active_tasks_radar>, verify with `task_search` before presenting it as open work.',
    '</dream_brief_task_reconciliation>',
  ].join('\n');
}

function buildSupervisionPrompt(params: {
  originStudioSessionId: string;
  longtermTaskId: string | null;
  longtermSubtaskId: string | null;
  events: StudioWorkerSettlementEvent[];
  openSiblings: StudioSiblingDelegationSummary[];
  pendingTodosBlock?: string;
  reportsDir: string;
  language: 'zh' | 'en';
}): string {
  const {
    originStudioSessionId,
    longtermTaskId,
    longtermSubtaskId,
    events,
    openSiblings,
    pendingTodosBlock,
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
    ...(pendingTodosBlock ? ['', pendingTodosBlock] : []),
    '',
    '### Mandatory Chief-of-Staff Back-Office Protocol',
    '1. VERIFY FROM THE TASK OBJECT & EVIDENCE (READ-ONLY BOUNDARY): Call `task_get` first when a Managed Task is linked (inspecting the Worker\'s structured `submission`, `artifacts`, and `evidence` registered on the subtask), then independently verify the actual produced files/evidence via `read`, `bash` (read-only checks & test suites), `twin_task_status`, or `idbots_session_read_latest` against the acceptance criteria. STRICT BOUNDARY: NEVER merge git branches into `main`, NEVER rename/modify live user SQLite databases, NEVER register scheduled tasks, and NEVER broadcast on-chain transactions from this silent verification session — leave merges and live execution to the owner\'s approved Studio turn!',
    '2. HANDLE DEFECTS SILENTLY: If a Worker failed, drifted, missed a criterion, or hit a technical error you can diagnose, DO NOT bother the owner — immediately issue corrective instructions via `twin_task_reassign` or `local_worker_delegate` from here.',
    '3. RECORD VERIFIED STEPS & ADVANCE SERIAL DAG: For each orchestration step that verifiably meets its acceptance criteria, call `twin_task_accept` with concrete evidence. If the linked Task has INTERMEDIATE subtasks whose completion unlocks downstream serial subtasks, call `task_subtask_accept` on that intermediate subtask and immediately dispatch the newly unlocked ready subtask(s)! CRITICAL OWNER-RULING GATE: NEVER call `longterm_subtask_accept` / `task_subtask_accept` on the FINAL open deliverable of a task from back-office supervision — the final deliverable/plan MUST stay in `waiting_owner` (等你拍板) until the owner reviews the presented briefing and approves!',
    '4. PARALLEL CONSOLIDATION GATE: Look at "Still-Running Parallel Sibling Delegations" above. If sibling Workers are still running AND none of the settled steps raised a genuine blocking product decision that requires the owner right now, DO NOT call `studio_decision_enqueue` yet! Conclude this supervision turn quietly after recording your verification; you will be woken again as remaining siblings finish so the owner receives ONE consolidated briefing.',
    '5. ENQUEUE FOR OWNER RULING / FINAL ACCEPTANCE: Only when (a) all parallel steps for this deliverable stage are verified and ready for owner acceptance / stamp sign-off, OR (b) a genuine product/scope ambiguity or irreversible authorization blocks progress:',
    '   - STRICT SCOPE DISCIPLINE: Respect the owner\'s exact stated scope. If the owner asked for research/drafts only ("先不要上链 / 暂不动代码"), enqueue an `acceptance` briefing of the verified drafts — do NOT invent unrequested code-change options that pressure the owner!',
    '   - DO NOT DOUBLE-ENQUEUE: Once you call `studio_decision_enqueue`, do NOT also call `longterm_subtask_wait(kind="owner")` for the same question.',
    `   - First write ONE clean, self-contained visual HTML briefing page into "${reportsDir}/<descriptive-name>.html" (inline CSS, zero external assets, clear status badge at top, verified deliverables/metrics table, options + your recommendation, and next step; if any on-chain pin was published, show BOTH the publishing Bot account name/MetaID AND the full verbatim \`pin://...i0\` ID).`,
    `   - Then call \`studio_decision_enqueue\` with \`originStudioSessionId: "${originStudioSessionId}"\`, \`reportHtmlPath\` set to that exact absolute HTML path, and all six decision-brief fields in ${language === 'zh' ? 'Chinese (中文)' : 'English'}.`,
    '</studio_back_office_supervision>',
  ].join('\n');
}

export function buildProactiveBriefingPrompt(item: StudioDecisionQueueItem, remainingQueuedCount: number, language: 'zh' | 'en'): string {
  const optionsText = item.options.length > 0
    ? item.options
        .map((opt, index) => `${index + 1}. ${opt.recommended ? '[Recommended] ' : ''}${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
        .join('\n')
    : '(free-text owner confirmation)';

  if (language === 'zh') {
    return [
      '<studio_proactive_briefing>',
      '你现在正在主人的 Studio 常驻主会话中主动发起一次「超级助理汇报」。',
      '注意：这条触发指令对主人不可见，主人只会看到你接下来的回复以及右侧投影页面。',
      `队列项 ID: ${item.id} | 类型: ${item.kind} | 队列剩余待拍板数: ${remainingQueuedCount}`,
      `标题: ${item.title}`,
      `背景: ${item.backgroundSummary}`,
      `当前已核验进展: ${item.progressSummary}`,
      `需要主人拍板的事项: ${item.question}`,
      `选项:\n${optionsText}`,
      `你的首推建议与理由: ${item.recommendation}`,
      `主人拍板后的下一步: ${item.nextStep}`,
      ...(() => {
        const cleanReportPath = localFilesystemPathFromArtifactRef(item.reportHtmlPath);
        return cleanReportPath ? [`预备投影详情页路径: ${cleanReportPath}`] : [];
      })(),
      '',
      '执行规则：',
      `1. **防重判据（严禁二次形式主义追问）**：先核对本会话上下文——如果主人在此前对话中**已经对这件事拍过板或选定了方案**（例如已选定某版设计稿、已明确后续发布方式、或已说「暂不动代码 / 只留文稿」），严禁为了走流程再让主人多回一次「验收」！请立即调用 \`studio_decision_resolve({ queueItemId: "${item.id}", resolutionNote: "..." })\` 静默收口，**不要调用任何投影工具，也不要再次向主人追问同一件事**（宿主看到已 resolve 就不会覆盖右侧投影屏）。`,
      `2. **严禁调用 \`ask_user_question\`，先完整呈现成果再让主人在左侧输入拍板（硬规则）**：汇报、是否验收/是否通过、选择方案时**绝对禁止调用 \`ask_user_question\` 工具**（该工具仅限任务开始前做前置调查，严禁用于汇报拍板，否则会遮挡右侧详情页、让主人在看不到文稿/成果的情况下盲选 A/B/C）！保持该队列项为当前待拍板状态（不要提前调 \`studio_decision_resolve\`）：先用 1 次 \`owner_update({ kind: "milestone", message: "..." })\` 简短交代核验结论，随后在左侧聊天回复中用 3–6 行自然简练的文字说明已完成成果、列出清晰的选项（如 \`A（推荐）：...\` / \`B：...\`）与下一步` +
        `${(() => {
          const cleanReportPath = localFilesystemPathFromArtifactRef(item.reportHtmlPath);
          return cleanReportPath ? `，并附上 \`[查看核验详情页](${previewMetaappUriForPath(cleanReportPath)})\` 链接` : '';
        })()}，` +
        '然后**直接结束本轮回复**——宿主会自动将包含完整内容与选项的 HTML 页面投到右侧投影屏，主人看完右侧完整文稿/页面后直接在左侧输入框回复 A 或 B 即可！',
      '3. **实物可见硬约束**：凡涉及让主人挑选、确认或验收文稿/方案/图片/设计稿/本地产物，**必须在右侧投影页完整呈现核心内容，并在左侧回复中逐项附上可点击的本地预览链接**（如 `[文稿全文](preview-file://localhost/绝对路径)` 或 `[方案A](preview-file://localhost/绝对路径)`）与一句区分说明，绝不允许不把实际内容呈现给主人看就让主人做 A/B/C 盲选！（若涉及已上链内容，务必同时明文写出**发布账号**和完整 `pin://...i0` ID）。',
      '4. **禁止前台重复验工（秒级呈报纪律）**：后台 `[督办]` 会话在入队前**已经跑完了文件、字数与图片核验并生成了详情页**；本轮前台汇报严禁再次从头调 `bash` 跑校验脚本或重复调 `read_image` 拖慢响应——除非先做防重收口，否则直接基于上方已核验信息发出简报与链接并结束本轮！',
      '</studio_proactive_briefing>',
    ].join('\n');
  }

  return [
    '<studio_proactive_briefing>',
    'You are proactively initiating a Chief-of-Staff briefing in the owner\'s persistent Studio conversation.',
    'Note: this trigger block is invisible to the owner; they will only see your reply and the right-hand projector page.',
    `Queue item ID: ${item.id} | Kind: ${item.kind} | Remaining queued behind this: ${remainingQueuedCount}`,
    `Title: ${item.title}`,
    `Background: ${item.backgroundSummary}`,
    `Verified progress: ${item.progressSummary}`,
    `Decision needed from owner: ${item.question}`,
    `Options:\n${optionsText}`,
    `Your recommendation: ${item.recommendation}`,
    `Next step after owner ruling: ${item.nextStep}`,
    ...(() => {
      const cleanReportPath = localFilesystemPathFromArtifactRef(item.reportHtmlPath);
      return cleanReportPath ? [`Prepared briefing HTML path: ${cleanReportPath}`] : [];
    })(),
    '',
    'Rules:',
    `1. **Deduplication check (no redundant ceremony)**: If the owner ALREADY ruled on this question or selected a candidate earlier in this conversation, NEVER re-ask them just for formal subtask sign-off — call \`studio_decision_resolve({ queueItemId: "${item.id}", resolutionNote: "..." })\` immediately and do NOT project or re-ask (the host will keep the existing projector page untouched once resolved).`,
    `2. **NEVER call \`ask_user_question\` for reporting, acceptance, or plan selection (hard rule)**: \`ask_user_question\` is strictly for pre-task requirement surveys BEFORE work begins — NEVER call it during a briefing/acceptance/ruling turn (calling it blocks the right-hand projector and forces the owner to pick A/B/C blind without seeing the deliverable!). Leave the queue item in \`presenting\` (do NOT resolve yet), send one brief \`owner_update({ kind: "milestone", message: "..." })\`, write a concise 3–6 line chat reply summarizing the verified result and clearly listing the A / B options (recommended first)` +
      `${(() => {
        const cleanReportPath = localFilesystemPathFromArtifactRef(item.reportHtmlPath);
        return cleanReportPath ? ` plus \`[Open full briefing](${previewMetaappUriForPath(cleanReportPath)})\`` : '';
      })()}, and **end your turn immediately** so the host projects the full HTML report/deliverable onto the right screen while the owner inspects it and types A or B in the left chat input.`,
    '3. **Show full artifacts before asking**: Whenever asking the owner to review, pick, or accept articles, plans, images, designs, or files, ALWAYS present the full content on the right-hand projector and include clickable `[label](preview-file://localhost/abs/path)` links with one-line descriptions in your reply — never ask the owner to choose A/B/C over unseen artifacts! (If on-chain content was published, always state BOTH the publishing Bot identity and the verbatim `pin://...i0` ID.)',
    '4. **No redundant front-office re-verification**: Back-office supervision has ALREADY verified every artifact and built `reportHtmlPath` before enqueuing; do NOT re-run `bash` verification scripts or `read_image` checks during this front-office presentation turn — deliver the summary, clickable links, and A/B options straight away!',
    '</studio_proactive_briefing>',
  ].join('\n');
}

export function buildProactiveFollowUpBriefingPrompt(
  item: ProactiveFollowUpItem,
  remainingQueuedCount: number,
  language: 'zh' | 'en',
): string {
  const optionsText = item.options.length > 0
    ? item.options
        .map((opt, index) => `${index + 1}. ${opt.recommended ? '[Recommended] ' : ''}${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
        .join('\n')
    : '';
  const actorLineZh = [
    item.localMetabotName ? `涉及本地角色: ${item.localMetabotName}${item.localMetabotId ? ` (metabotId=${item.localMetabotId})` : ''}` : null,
    item.peerName || item.peerGlobalMetaId ? `远端对象: ${item.peerName || item.peerGlobalMetaId}` : null,
    item.sourceSessionId ? `关联 A2A 会话: IDBots://${item.sourceSessionId}` : null,
    item.workerSessionId ? `关联 Worker 会话: IDBots://${item.workerSessionId}` : null,
    item.coalescedCount > 1 ? `已合并同源动态轮数: ${item.coalescedCount}` : null,
  ].filter(Boolean).join(' | ');

  const actorLineEn = [
    item.localMetabotName ? `Local bot: ${item.localMetabotName}${item.localMetabotId ? ` (metabotId=${item.localMetabotId})` : ''}` : null,
    item.peerName || item.peerGlobalMetaId ? `Remote peer: ${item.peerName || item.peerGlobalMetaId}` : null,
    item.sourceSessionId ? `Origin A2A session: IDBots://${item.sourceSessionId}` : null,
    item.workerSessionId ? `Worker session: IDBots://${item.workerSessionId}` : null,
    item.coalescedCount > 1 ? `Coalesced updates: ${item.coalescedCount}` : null,
  ].filter(Boolean).join(' | ');

  if (language === 'zh') {
    const tierHeadline =
      item.tier === 'inform'
        ? `已办妥告知 (${item.informOutcome === 'declined' ? '已代拒/婉拒' : item.informOutcome === 'observed' ? '重要观察同步' : '已自动处理完成'})`
        : item.tier === 'task_proposal'
          ? '提议转正式任务 (task_proposal)'
          : '一轮轻拍板 (light_decision)';

    const tierDirective =
      item.tier === 'inform'
        ? [
            `3. **零回合自然知会（${item.informOutcome === 'declined' ? '告知已代为婉拒' : '告知已办妥'}）**：用 2–4 句像真人助理一样自然简练的话，直接告诉主人刚才谁联系了咱们哪位 Bot、发生了什么、${item.informOutcome === 'declined' ? '我们已经按边界代为拒绝/挡回及原因' : '我们已经如何处理妥当'}，最后轻轻带一句「不需要你额外操作，除非你想改口或追加交代」即可。**不要反问主人 Yes/No，本轮结束后宿主会自动将该告知标记为已送达（无需调 followup_resolve）**。`,
          ]
        : item.tier === 'task_proposal'
          ? [
              `3. **自然对话提议转任务**：用 3–5 句自然简练的话交代清楚来龙去脉（谁联系了谁、为什么这件事涉及多步或多角色协作），明确给出你的建议，并自然询问主人是否立项推进（或婉拒对方），然后**直接结束本轮等待主人在聊天框自然回复**（保持 presenting 状态，本轮不要提前调 followup_resolve）。主人同意后下一轮再调 \`followup_promote_to_task\` 立项并同步回复对方。`,
            ]
          : [
              `3. **一轮轻拍板自然请示**：用 3–5 句自然简练的话把背景、Worker 排查结论或对方诉求说清楚，给出你的明确建议或清晰可选项，让主人在聊天框一句话拍板即可，然后**直接结束本轮等待主人回复**（保持 presenting 状态，本轮不要提前调 followup_resolve）。主人回复后下一轮用 \`followup_reply_a2a\`（及必要的 Worker 授权）一步落实。`,
            ];

    return [
      '<studio_proactive_briefing>',
      '你现在作为主人的唯一数字分身（TwinBot），趁当前会话空闲，主动向主人同步一条来自 AI 网络 / 团队协作的跟进事项。',
      '注意：本触发块对主人不可见，主人只会看到你接下来自然说出的话。',
      `FollowUp ID: ${item.id} | 分级: ${tierHeadline} | 来源域: ${item.sourceDomain} | 后续排队数: ${remainingQueuedCount}`,
      ...(actorLineZh ? [actorLineZh] : []),
      `事项标题: ${item.title}`,
      `摘要详情: ${item.summary}`,
      ...(item.question ? [`待主人确认/拍板点: ${item.question}`] : []),
      ...(optionsText ? [`可选方向:\n${optionsText}`] : []),
      ...(item.recommendation ? [`建议口径: ${item.recommendation}`] : []),
      ...(item.nextStep ? [`拍板后动作: ${item.nextStep}`] : []),
      '',
      '硬性交互铁律：',
      `1. **防重收口**：如果主人在此前几轮对话里已经明确对这件事表过态，立即调用 \`followup_resolve({ followUpId: "${item.id}", resolutionNote: "..." })\` 静默收口，严禁重复打扰。`,
      '2. **严禁机械弹窗 & 严禁投屏重页面**：**绝对禁止调用 `ask_user_question`**，也**不要生成或投屏右侧 HTML 汇报页**！全程像熟悉主人的首席幕僚一样在聊天流里自然开口。',
      ...tierDirective,
      '</studio_proactive_briefing>',
    ].join('\n');
  }

  const tierInstructionEn =
    item.tier === 'inform'
      ? `3. **Zero-turn natural FYI (${item.informOutcome === 'declined' ? 'auto-declined notice' : 'handled notice'})**: In 2–4 natural conversational sentences, tell the owner which peer contacted which local Bot, what happened, and ${item.informOutcome === 'declined' ? 'that we already politely declined/blocked it and why' : 'how it was handled'}, noting that no action is needed unless they want to override. **Do NOT ask a Yes/No question; the host will automatically mark this inform item delivered as soon as your turn ends.**`
      : item.tier === 'task_proposal'
        ? '3. **Conversational task proposal**: In 3–5 natural sentences, explain who reached out and why this spans multiple steps/bots, share your recommendation, and ask naturally in chat whether to take it on as a formal Task (or decline). Keep the item in `presenting` and end your turn cleanly.'
        : '3. **One-turn light decision**: In 3–5 natural sentences, state the situation, verified Worker/A2A context, and your concrete recommendation so the owner can rule in a single chat reply. Keep the item in `presenting` and end your turn cleanly.';

  return [
    '<studio_proactive_briefing>',
    'You are speaking proactively as the owner\'s single TwinBot funnel while the primary conversation is idle.',
    'Note: this trigger block is invisible to the owner; they only see your natural chat message.',
    `FollowUp ID: ${item.id} | Tier: ${item.tier}${item.informOutcome ? ` (${item.informOutcome})` : ''} | Domain: ${item.sourceDomain} | Queued behind this: ${remainingQueuedCount}`,
    ...(actorLineEn ? [actorLineEn] : []),
    `Title: ${item.title}`,
    `Summary: ${item.summary}`,
    ...(item.question ? [`Question for owner: ${item.question}`] : []),
    ...(optionsText ? [`Options:\n${optionsText}`] : []),
    ...(item.recommendation ? [`Recommendation: ${item.recommendation}`] : []),
    ...(item.nextStep ? [`Next step: ${item.nextStep}`] : []),
    '',
    'Hard UX rules:',
    `1. **Deduplication**: If the owner already ruled on this in recent turns, call \`followup_resolve({ followUpId: "${item.id}", resolutionNote: "..." })\` immediately and do not re-ask.`,
    '2. **NO modal popups & NO right-screen HTML projection**: **NEVER call `ask_user_question`**, and do NOT write or project any right-screen showcase HTML page for lightweight FollowUp events! Speak naturally in the chat stream.',
    tierInstructionEn,
    '</studio_proactive_briefing>',
  ].join('\n');
}

export class StudioChiefOfStaffService {
  readonly presenceTracker = new StudioPresenceTracker();
  private readonly pendingBatches = new Map<string, PendingSupervisionBatch>();
  private supervisionChain = new Map<string, Promise<void>>();
  private readonly focusedTaskBySession = new Map<string, string>();
  private readonly focusedTaskHistoryBySession = new Map<string, Set<string>>();
  /** Tracks the task most recently ruled/rejected in a Studio session so follow-up/rework delegations auto-bind `parentTaskId`. */
  private readonly recentDecisionParentBySession = new Map<string, { taskId: string; atMs: number }>();
  private readonly activeSupervisionsBySession = new Map<string, ActiveStudioSupervisionEntry>();
  private readonly supervisionToOriginStudio = new Map<string, string>();
  private readonly studioToSupervisionIds = new Map<string, Set<string>>();
  private readonly waitingReassuranceState = new Map<string, {
    waitBeganMs: number;
    lastNoticeMs: number;
    lastVisibleChatAtMs: number;
    rungIndex: number;
    signature: string;
    priorMessages: string[];
  }>();
  private readonly waitingReassuranceInFlight = new Set<string>();
  private activeSupervisionCount = 0;
  private heartbeatInFlight = false;
  private lastObservedTaskWatermark: string | null = null;
  private readonly now: () => number;
  private readonly emitLog: (line: string) => void;
  private readonly coalesceMs: number;
  private readonly reassuranceIntervalsMs: readonly number[];

  constructor(private readonly deps: StudioChiefOfStaffDeps) {
    this.now = deps.now ?? Date.now;
    this.emitLog = deps.emitLog ?? ((line: string) => console.log(line));
    this.coalesceMs = Math.max(0, deps.supervisionCoalesceMs ?? DEFAULT_SUPERVISION_COALESCE_MS);
    this.reassuranceIntervalsMs = deps.waitingReassuranceIntervalsMs?.length
      ? deps.waitingReassuranceIntervalsMs
      : DEFAULT_WAITING_REASSURANCE_INTERVALS_MS;
  }

  getActiveSupervisionForSession(sessionId: string | null | undefined): ActiveStudioSupervisionEntry | null {
    const sid = (sessionId ?? '').trim();
    if (!sid) return null;
    const live = this.activeSupervisionsBySession.get(sid);
    if (live) return live;
    for (const batch of this.pendingBatches.values()) {
      if (batch.originStudioSessionId === sid && batch.events.length > 0) {
        const last = batch.events[batch.events.length - 1];
        return {
          attemptId: last.attempt.id,
          workerMetabotId: last.attempt.workerMetabotId,
          workerName: last.workerName,
          workerSessionId: last.attempt.workerSessionId ?? undefined,
          title: String(last.task.ownerIntent ?? '').split('\n')[0].slice(0, 48),
          startedAt: Date.parse(last.attempt.finishedAt ?? '') || this.now(),
        };
      }
    }
    return null;
  }

  focusTask(sessionId: string | null | undefined, longtermTaskId: string | null | undefined): void {
    const sid = (sessionId ?? '').trim();
    const tid = (longtermTaskId ?? '').trim();
    if (!sid || !tid) return;
    this.focusedTaskBySession.set(sid, tid);
    let history = this.focusedTaskHistoryBySession.get(sid);
    if (!history) {
      history = new Set<string>();
      this.focusedTaskHistoryBySession.set(sid, history);
    }
    history.delete(tid);
    history.add(tid);
    while (history.size > 12) {
      const oldest = history.values().next();
      if (oldest.done) break;
      history.delete(oldest.value);
    }
  }

  getFocusedTaskId(sessionId: string | null | undefined): string | null {
    const sid = (sessionId ?? '').trim();
    if (!sid) return null;
    return this.focusedTaskBySession.get(sid) ?? null;
  }

  getFocusedTaskIds(sessionId: string | null | undefined): string[] {
    const sid = (sessionId ?? '').trim();
    if (!sid) return [];
    const set = this.focusedTaskHistoryBySession.get(sid);
    if (!set || set.size === 0) {
      const single = this.focusedTaskBySession.get(sid);
      return single ? [single] : [];
    }
    return [...set].reverse();
  }

  recordRecentDecisionTask(sessionId: string | null | undefined, taskId: string | null | undefined): void {
    const sid = (sessionId ?? '').trim();
    const tid = (taskId ?? '').trim();
    if (!sid || !tid) return;
    this.recentDecisionParentBySession.set(sid, { taskId: tid, atMs: this.now() });
    this.focusTask(sid, tid);
  }

  getRecentDecisionTask(sessionId: string | null | undefined, maxAgeMs = 5 * 60_000): string | null {
    const sid = (sessionId ?? '').trim();
    if (!sid) return null;
    const hit = this.recentDecisionParentBySession.get(sid);
    if (!hit) return null;
    if (this.now() - hit.atMs > maxAgeMs) {
      this.recentDecisionParentBySession.delete(sid);
      return null;
    }
    return hit.taskId;
  }

  isSupervisionBusy(): boolean {
    return this.activeSupervisionCount > 0 || this.pendingBatches.size > 0;
  }

  isStudioOwnerSession(sessionId: string | null | undefined): boolean {
    if (isServerMode()) return false;
    if (!sessionId || !sessionId.trim()) return false;
    const session = this.deps.coworkStore().getSession(sessionId.trim());
    if (!session) return false;
    if (session.autoOrigin) return false;
    return session.sessionType === 'browser' && session.assistantMode === true;
  }

  /**
   * Omnichannel primary Twin owner conversation check: matches both Desktop
   * Studio (`browser` + `assistantMode: true`) AND Cloud/Mobile interactive
   * primary Twin sessions (`standard`, non-`autoOrigin`, non-archived, non-hidden,
   * bound to `twinMetabotId`).
   */
  isTwinOwnerFrontOfficeSession(sessionId: string | null | undefined): boolean {
    if (!sessionId || !sessionId.trim()) return false;
    if (this.isStudioOwnerSession(sessionId)) return true;
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) return false;
    const session = this.deps.coworkStore().getSession(sessionId.trim()) as (CoworkSession & {
      archivedAt?: number | null;
      hiddenFromSessionList?: boolean;
    }) | null;
    if (!session) return false;
    if (session.archivedAt || session.autoOrigin || session.hiddenFromSessionList) return false;
    const st = session.sessionType ?? 'standard';
    if (st !== 'standard' && st !== 'browser') return false;
    return session.metabotId === twinId;
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

  /**
   * Resolves the unified primary Twin conversation stream across Desktop Studio
   * and Cloud/Mobile:
   *  1. Active Desktop Studio session (`browser` + `assistantMode: true`) when present.
   *  2. Most recently updated interactive Twin `standard` session (the same stream
   *     `CoworkSessionController.restore(twinId)` opens on Mobile/BotWorks).
   *  3. On headless 24/7 Cloud Tenants (`isServerMode()`), optionally creates a
   *     clean primary Twin `standard` session if none exists yet so TwinBot can
   *     speak first and deep-link a mobile push notification.
   */
  resolvePrimaryTwinOwnerSession(
    twinMetabotId: number | null = this.deps.resolveTwinMetabotId(),
    options?: { createIfMissingInServerMode?: boolean },
  ): { sessionId: string | null; isPrimaryNonStudioFallback: boolean } {
    if (twinMetabotId == null) {
      return { sessionId: null, isPrimaryNonStudioFallback: false };
    }
    const studioId = this.resolveActiveStudioSessionId(twinMetabotId);
    if (studioId) {
      return { sessionId: studioId, isPrimaryNonStudioFallback: false };
    }
    const store = this.deps.coworkStore();
    const all = store.listSessions?.() ?? [];
    const standardCandidates = all
      .filter((entry) =>
        !entry.archivedAt
        && !entry.autoOrigin
        && !entry.hiddenFromSessionList
        && (!entry.sessionType || entry.sessionType === 'standard')
        && entry.metabotId === twinMetabotId,
      )
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    if (standardCandidates[0]?.id) {
      return {
        sessionId: standardCandidates[0].id,
        isPrimaryNonStudioFallback: true,
      };
    }
    if (options?.createIfMissingInServerMode && this.deps.isServerMode?.()) {
      const workspace = this.deps.resolveTwinWorkspace(twinMetabotId);
      const language = this.deps.getAppLanguage?.() ?? 'zh';
      const created = store.createSession(
        language === 'zh' ? '主对话' : 'Primary Chat',
        workspace,
        this.deps.getBaseSystemPrompt?.() ?? '',
        'local',
        [],
        twinMetabotId,
        'standard',
      );
      return {
        sessionId: created.id,
        isPrimaryNonStudioFallback: true,
      };
    }
    return { sessionId: null, isPrimaryNonStudioFallback: false };
  }

  getPresenceSnapshot(nowMs: number = this.now()): StudioTwinPresenceSnapshot {
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) {
      return {
        mode: 'idle',
        reason: 'no Twin Bot configured',
        activeStudioSessionId: null,
        primaryTwinSessionId: null,
        presentingItem: null,
        presentingFollowUpItem: null,
        queuedCount: 0,
        followUpQueuedCount: 0,
      };
    }
    const activeStudioSessionId = this.resolveActiveStudioSessionId(twinId);
    const primaryTwinSessionId = activeStudioSessionId ?? this.resolvePrimaryTwinOwnerSession(twinId).sessionId;
    const trackedSessionId = activeStudioSessionId ?? primaryTwinSessionId;

    const openItems = this.deps.decisionQueueStore().listOpen(twinId);
    const rawPresentingItem = openItems.find((item) => item.status === 'presenting') ?? null;
    const presentingItem = rawPresentingItem && (
      !rawPresentingItem.presentedSessionId
      || !trackedSessionId
      || rawPresentingItem.presentedSessionId === trackedSessionId
      || this.presenceTracker.isBriefingTurnRunning(rawPresentingItem.presentedSessionId)
    )
      ? rawPresentingItem
      : null;
    const queuedCount = openItems.filter((item) => item.status === 'queued').length;

    const openFollowUps = this.deps.followUpStore?.().listOpen(twinId) ?? [];
    const rawPresentingFollowUpItem = openFollowUps.find((item) => item.status === 'presenting') ?? null;
    const presentingFollowUpItem = rawPresentingFollowUpItem && (
      !rawPresentingFollowUpItem.presentedSessionId
      || !trackedSessionId
      || rawPresentingFollowUpItem.presentedSessionId === trackedSessionId
      || this.presenceTracker.isBriefingTurnRunning(rawPresentingFollowUpItem.presentedSessionId)
    )
      ? rawPresentingFollowUpItem
      : null;
    const followUpQueuedCount = openFollowUps.filter(
      (item) => item.status === 'queued' && item.reportingGranularity === 'immediate',
    ).length;

    const briefingTurnRunning = this.presenceTracker.isBriefingTurnRunning(trackedSessionId);
    const studioTurnRunning = trackedSessionId
      ? this.deps.coworkRunner().isSessionActive(trackedSessionId) && !briefingTurnRunning
      : false;
    const hasDefiningDraftInStudio = activeStudioSessionId
      ? Boolean(this.deps.hasDefiningDraftForSession?.(activeStudioSessionId))
      : false;
    const openWorkers = activeStudioSessionId
      ? (this.deps.listOpenSiblingDelegations?.(activeStudioSessionId) ?? [])
      : [];
    const activeSupervision = this.getActiveSupervisionForSession(activeStudioSessionId);
    const explicitShapingHoldReason = this.presenceTracker.getActiveShapingHoldReason(
      trackedSessionId,
      nowMs,
    ) ?? (
      openWorkers.length > 0
        ? `delegated Worker (${openWorkers[0].workerName}) is currently executing`
        : activeSupervision
          ? `back-office verification in progress for ${activeSupervision.workerName}`
          : null
    );
    const lastNonBriefingTurnEndedAtMs = this.presenceTracker.getLastNonBriefingTurnEndedAtMs(
      trackedSessionId,
    );

    return deriveStudioPresenceState({
      activeStudioSessionId,
      primaryTwinSessionId,
      studioTurnRunning,
      briefingTurnRunning,
      hasDefiningDraftInStudio,
      explicitShapingHoldReason,
      lastNonBriefingTurnEndedAtMs,
      presentingItem,
      presentingFollowUpItem,
      queuedCount,
      followUpQueuedCount,
      nowMs,
      idleDebounceMs: this.deps.idleDebounceMs,
    });
  }

  buildVolatileTurnContext(sessionId: string): string {
    const isStudio = this.isStudioOwnerSession(sessionId);
    if (!isStudio && !this.isTwinOwnerFrontOfficeSession(sessionId)) return '';
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) return '';
    const blocks: string[] = [];

    if (!isStudio) {
      return this.appendFollowUpVolatileBlocks(twinId, blocks).join('\n\n');
    }

    const openItems = this.deps.decisionQueueStore().listOpen(twinId);
    const openWorkers = this.deps.listOpenSiblingDelegations?.(sessionId) ?? [];

    let continuity: StudioContinuitySnapshot | null = null;
    try {
      continuity = this.deps.getStudioContinuity?.(twinId) ?? null;
    } catch {
      continuity = null;
    }
    if (
      continuity
      && (
        continuity.activeWorkstreams.length > 0
        || continuity.standingRulings.length > 0
        || continuity.collaborationPlaybook.length > 0
      )
    ) {
      const continuityLines: string[] = [
        `<studio_continuity_brief dreamDate="${escapeHtml(continuity.dreamDate)}">`,
        `Nightly dream-distilled executive state for this persistent Studio stream (as of ${continuity.dreamDate}):`,
      ];
      if (continuity.activeWorkstreams.length > 0) {
        continuityLines.push('Active Multi-Turn Workstreams:');
        for (const ws of continuity.activeWorkstreams.slice(0, 6)) {
          continuityLines.push(`- ${ws}`);
        }
      }
      if (continuity.standingRulings.length > 0) {
        continuityLines.push('Standing Owner Rulings & Constraints (keep honoring unless superseded by a newer owner message):');
        for (const ruling of continuity.standingRulings.slice(0, 8)) {
          continuityLines.push(`- ${ruling}`);
        }
      }
      if (continuity.collaborationPlaybook.length > 0) {
        continuityLines.push('Distilled Studio Collaboration Playbook:');
        for (const rule of continuity.collaborationPlaybook.slice(0, 4)) {
          continuityLines.push(`- ${rule}`);
        }
      }
      continuityLines.push(
        'Note: Newer messages in this conversation and live task/queue state always supersede older snapshot entries; never re-ask decisions already listed under Standing Owner Rulings.',
        '</studio_continuity_brief>',
      );
      blocks.push(continuityLines.join('\n'));
      // Owner ruling 2026-11-19: the brief is a static snapshot — reconcile it
      // against the live task table so workstreams resolved after the dream
      // (e.g. tasks closed overnight) are never re-surfaced as pending.
      try {
        const sinceMs = dreamDateLocalMidnightMs(continuity.dreamDate);
        const resolved = Number.isFinite(sinceMs) ? (this.deps.listTasksResolvedSince?.(sinceMs) ?? []) : [];
        const reconciliation = buildDreamBriefTaskReconciliation(continuity.dreamDate, resolved);
        if (reconciliation) blocks.push(reconciliation);
      } catch {
        // Reconciliation is best-effort; never break volatile-context assembly.
      }
    }

    try {
      const pendingTodos = this.deps.listPendingTwinTodos?.(twinId) ?? [];
      const todosBlock = formatCompactTwinTodosPromptBlock(pendingTodos, 12);
      if (todosBlock) {
        blocks.push(todosBlock);
      }
    } catch {
      // Todo context injection is best-effort.
    }

    if (openWorkers.length > 0) {
      const workerLines = openWorkers.map((w) =>
        `- Worker "${w.workerName}"${w.workerMetabotId != null ? ` (workerMetabotId=${w.workerMetabotId})` : ''}: "${w.title}"${w.workerSessionId ? ` [session=IDBots://${w.workerSessionId}]` : ''}`,
      );
      blocks.push([
        '<studio_active_workers>',
        `Currently executing Worker delegation(s) for this Studio conversation (${openWorkers.length}):`,
        ...workerLines,
        'Mid-flight course-correction & parallel-task rules:',
        '- If the owner is ADJUSTING or REVISING instructions for a task that one of the Workers above is STILL executing right now (e.g. "let them generate 3 versions instead"), re-delegate to that SAME `workerMetabotId` WITHOUT setting `parallelSameWorker` — the host will automatically cancel and stop their obsolete in-flight run so two runs never collide! (Or call `twin_task_cancel` if cancelling outright.)',
        '- If the owner brings up an UNRELATED new request while Workers above are busy: (a) for a quick question/inspection you can answer within this turn, answer it directly without creating a task card; (b) for a substantive new deliverable (e.g. "have Eleven make 3 cover images", "write/audit a module"), immediately delegate it to an available Worker via `local_worker_delegate` (do NOT pass the other Worker\'s `longtermTaskId`, so the host auto-creates an independent parallel task card on the right-hand Task Progress HUD!) or register a task card so no parallel owner request is ever forgotten.',
        '- Always end a delegation reply by explicitly telling the owner which Worker(s) are now running in parallel in the background and that they will receive verified reports.',
        '</studio_active_workers>',
      ].join('\n'));
    }

    const rawPresenting = openItems.find((item) => item.status === 'presenting') ?? null;
    const presenting = rawPresenting && (!rawPresenting.presentedSessionId || rawPresenting.presentedSessionId === sessionId)
      ? rawPresenting
      : null;
    const queuedCount = openItems.filter((item) => item.status === 'queued').length;

    if (presenting) {
      blocks.push([
        '<active_studio_briefing>',
        `You are currently awaiting the owner's ruling on Studio Decision Queue item "${presenting.id}" (${presenting.kind}): "${presenting.title}".`,
        `Question asked: ${presenting.question}`,
        `Recommended option: ${presenting.recommendation}`,
        `Planned next step: ${presenting.nextStep}`,
        `Queued items waiting behind this one: ${queuedCount}`,
        'Routing rule for THIS owner message:',
        `- If the owner is answering, approving, critiquing, revising, or rejecting "${presenting.title}" (including asking for a modified v2/v3 or asking you to list/show the images first!): call \`studio_decision_resolve({ queueItemId: "${presenting.id}", resolutionNote: "..." })\` FIRST when they gave a clear decision or revision order (NEVER \`studio_decision_defer\` when they responded to this item!), then immediately trigger the requested revision/next step.`,
        `- If the owner says they cannot decide yet because you did NOT show the images/files ("把图列出来再让我验收"), show every candidate/final image link clearly right now and keep waiting for their explicit pick/confirmation — DO NOT execute any on-chain minting/publishing yet!`,
        `- Irreversible on-chain guard: NEVER treat a bare continuation cue ("继续", "continue", "重试") as implicit approval to mint, upload, or spend on-chain unless the owner already explicitly authorized that exact on-chain execution.`,
        `- ONLY call \`studio_decision_defer({ queueItemId: "${presenting.id}" })\` when the owner completely ignores "${presenting.title}" to start an UNRELATED topic!`,
        '</active_studio_briefing>',
      ].join('\n'));
    } else if (queuedCount > 0) {
      blocks.push(
        `<studio_queue_awareness>There are currently ${queuedCount} verified item(s) waiting quietly in your Studio Owner Decision Queue (inspectable via studio_decision_list). Do NOT blurt them out mid-task while shaping a new owner demand — the Studio heartbeat will automatically present the head item as soon as this topic settles to idle, UNLESS the owner explicitly asks for pending items right now.</studio_queue_awareness>`,
      );
    }

    return this.appendFollowUpVolatileBlocks(twinId, blocks).join('\n\n');
  }

  private appendFollowUpVolatileBlocks(twinId: number, blocks: string[]): string[] {
    if (!this.deps.followUpStore) return blocks;
    const openFollowUps = this.deps.followUpStore().listOpen(twinId);
    const presentingFollowUp = openFollowUps.find((item) => item.status === 'presenting') ?? null;
    const queuedFollowUpCount = openFollowUps.filter(
      (item) => item.status === 'queued' && item.reportingGranularity === 'immediate',
    ).length;

    if (presentingFollowUp) {
      blocks.push([
        '<active_followup_briefing>',
        `You are currently awaiting the owner's natural chat reply on Proactive Follow-Up Event "${presentingFollowUp.id}" (tier=${presentingFollowUp.tier}, domain=${presentingFollowUp.sourceDomain}): "${presentingFollowUp.title}".`,
        `Summary: ${presentingFollowUp.summary}`,
        ...(presentingFollowUp.question ? [`Question asked: ${presentingFollowUp.question}`] : []),
        ...(presentingFollowUp.sourceSessionId ? [`Linked A2A session: IDBots://${presentingFollowUp.sourceSessionId}`] : []),
        ...(presentingFollowUp.workerSessionId ? [`Linked Worker session: IDBots://${presentingFollowUp.workerSessionId}`] : []),
        `Queued follow-ups waiting behind this one: ${queuedFollowUpCount}`,
        'Routing rules for THIS owner message (NEVER call `ask_user_question`):',
        `- If the owner is answering, ruling on, approving, or declining "${presentingFollowUp.title}":`,
        `  1. When promoting to a multi-step Managed Task (owner agreed to take on a \`task_proposal\` or multi-step effort): call \`followup_promote_to_task({ followUpId: "${presentingFollowUp.id}", ... })\` (pass \`peerReplyGuidance\` if an A2A session is linked so the remote peer receives a natural acknowledgement too).`,
        `  2. When steering/replying to the linked A2A conversation with the owner's ruling (without creating a heavy Managed Task): call \`followup_reply_a2a({ followUpId: "${presentingFollowUp.id}", guidance: "...", resolutionNote: "..." })\` — and if a waiting Worker session (\`IDBots://${presentingFollowUp.workerSessionId ?? '...'}\`) also needs authorization to execute the approved action, send that authorization via \`local_worker_delegate\` or \`idbots_session_insert_user_message\`.`,
        `  3. Otherwise (pure local decision/acknowledgement with no A2A reply needed): call \`followup_resolve({ followUpId: "${presentingFollowUp.id}", resolutionNote: "..." })\`.`,
        `- ONLY call \`followup_defer({ followUpId: "${presentingFollowUp.id}" })\` when the owner completely ignores "${presentingFollowUp.title}" to start an UNRELATED topic!`,
        '</active_followup_briefing>',
      ].join('\n'));
    } else if (queuedFollowUpCount > 0) {
      blocks.push(
        `<followup_queue_awareness>There are currently ${queuedFollowUpCount} lightweight Proactive Follow-Up Event(s) queued in \`followup_list\` (from Twin/Worker A2A chats or Worker escalations). Hold them quietly while handling the owner's active topic — the idle heartbeat will weave them into conversation naturally once this topic settles, UNLESS the owner asks for new messages/updates right now.</followup_queue_awareness>`,
      );
    }
    return blocks;
  }

  private rememberSupervisionLink(supervisionSessionId: string, originStudioSessionId: string): void {
    const supId = supervisionSessionId.trim();
    const studioId = originStudioSessionId.trim();
    if (!supId || !studioId) return;
    this.supervisionToOriginStudio.set(supId, studioId);
    let set = this.studioToSupervisionIds.get(studioId);
    if (!set) {
      set = new Set<string>();
      this.studioToSupervisionIds.set(studioId, set);
    }
    set.add(supId);
    this.deps.kv?.set(`studio_supervision_origin:${supId}`, studioId);
    this.deps.kv?.set(`studio_supervision_list:${studioId}`, [...set]);
  }

  getOriginStudioSessionForSupervision(sessionId: string | null | undefined): string | null {
    const sid = (sessionId ?? '').trim();
    if (!sid) return null;
    const mem = this.supervisionToOriginStudio.get(sid);
    if (mem && this.isStudioOwnerSession(mem)) return mem;
    const persisted = this.deps.kv?.get<string>(`studio_supervision_origin:${sid}`);
    if (persisted && this.isStudioOwnerSession(persisted)) {
      this.rememberSupervisionLink(sid, persisted);
      return persisted;
    }
    return null;
  }

  getSupervisionSessionIdsForStudio(studioSessionId: string | null | undefined): string[] {
    const sid = (studioSessionId ?? '').trim();
    if (!sid) return [];
    const set = new Set<string>(this.studioToSupervisionIds.get(sid) ?? []);
    const persisted = this.deps.kv?.get<string[]>(`studio_supervision_list:${sid}`);
    if (Array.isArray(persisted)) {
      for (const item of persisted) {
        if (typeof item === 'string' && item.trim()) set.add(item.trim());
      }
    }
    const directSup = this.deps.kv?.get<string>(`studio_supervision_session:studio:${sid}`);
    if (typeof directSup === 'string' && directSup.trim()) set.add(directSup.trim());
    const focusedTaskId = this.getFocusedTaskId(sid);
    if (focusedTaskId) {
      const lttSup = this.deps.kv?.get<string>(`studio_supervision_session:ltt:${focusedTaskId}`);
      if (typeof lttSup === 'string' && lttSup.trim()) set.add(lttSup.trim());
    }
    return [...set];
  }

  resolveOriginStudioSessionForTask(task: {
    sourceSessionId?: string | null;
    longtermReportSessionId?: string | null;
  }): string | null {
    const sourceSid = (task.sourceSessionId ?? '').trim();
    if (sourceSid) {
      if (this.isStudioOwnerSession(sourceSid)) return sourceSid;
      const fromSup = this.getOriginStudioSessionForSupervision(sourceSid);
      if (fromSup) return fromSup;
    }
    const reportSid = (task.longtermReportSessionId ?? '').trim();
    if (reportSid && this.isStudioOwnerSession(reportSid)) {
      if (sourceSid) this.rememberSupervisionLink(sourceSid, reportSid);
      return reportSid;
    }
    return null;
  }

  /**
   * Intercepts Worker terminal transitions originating from a Studio session
   * (including re-delegations issued from its silent back-office `[督办]` session).
   * Returns true when handled (suppressing [ORCH-NOTIFY] injection into the
   * owner's front-office Studio session).
   */
  onStudioWorkerTerminalState(event: StudioWorkerSettlementEvent): boolean {
    const originSessionId = this.resolveOriginStudioSessionForTask(event.task);
    if (!originSessionId) {
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
    if (event.task.longtermTaskId) {
      batch.longtermTaskId = event.task.longtermTaskId;
      this.focusTask(originSessionId, event.task.longtermTaskId);
    }
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
      this.rememberSupervisionLink(existingId, batch.originStudioSessionId);
      store.updateSession(existingId, { hiddenFromSessionList: true });
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
    store.updateSession(session.id, { hiddenFromSessionList: true });
    this.deps.kv?.set(kvKey, session.id);
    this.rememberSupervisionLink(session.id, batch.originStudioSessionId);
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
    let pendingTodosBlock = '';
    try {
      const pendingTodos = this.deps.listPendingTwinTodos?.(batch.twinMetabotId) ?? [];
      pendingTodosBlock = formatCompactTwinTodosPromptBlock(pendingTodos, 12);
    } catch {
      pendingTodosBlock = '';
    }
    const language = this.deps.getAppLanguage?.() ?? 'zh';
    const prompt = buildSupervisionPrompt({
      originStudioSessionId: batch.originStudioSessionId,
      longtermTaskId: batch.longtermTaskId,
      longtermSubtaskId: batch.longtermSubtaskId,
      events: batch.events,
      openSiblings,
      pendingTodosBlock,
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
    const latestSettled = batch.events[batch.events.length - 1];
    const supervisionStartedAt = this.now();
    if (latestSettled) {
      this.activeSupervisionsBySession.set(batch.originStudioSessionId, {
        attemptId: latestSettled.attempt.id,
        workerMetabotId: latestSettled.attempt.workerMetabotId,
        workerName: latestSettled.workerName,
        workerSessionId: latestSettled.attempt.workerSessionId ?? undefined,
        title: String(latestSettled.task.ownerIntent ?? '').split('\n')[0].slice(0, 48),
        startedAt: supervisionStartedAt,
      });
    }
    this.activeSupervisionCount += 1;
    this.deps.onStateChanged?.('supervision_started');
    try {
      await this.deps.coworkRunner().startSession(supervisionSessionId, prompt, {
        skipInitialUserMessage: true,
        acknowledgeOwner: false,
        confirmationMode: 'text',
        permissionMode: 'bypassPermissions',
        autoApprove: false,
      });
    } finally {
      this.activeSupervisionCount = Math.max(0, this.activeSupervisionCount - 1);
      this.activeSupervisionsBySession.delete(batch.originStudioSessionId);
      this.deps.onStateChanged?.('supervision_completed');
    }
  }

  private normalizeReassuranceText(raw: string): string {
    return raw.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  }

  private reconcileStalePresentingItems(nowMs: number): void {
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null) return;
    const activeStudioSessionId = this.resolveActiveStudioSessionId(twinId);
    const primaryTwinSessionId = activeStudioSessionId ?? this.resolvePrimaryTwinOwnerSession(twinId).sessionId;
    const trackedSessionId = activeStudioSessionId ?? primaryTwinSessionId;
    const store = this.deps.coworkStore();
    const atIso = new Date(nowMs).toISOString();

    const presentingDecision = this.deps.decisionQueueStore().getPresenting(twinId);
    if (presentingDecision && !this.presenceTracker.isBriefingTurnRunning(presentingDecision.presentedSessionId)) {
      const presentedSid = (presentingDecision.presentedSessionId ?? '').trim();
      const presentedSession = presentedSid
        ? (store.getSession(presentedSid) as (CoworkSession & { archivedAt?: number | null }) | null)
        : null;
      const sessionGoneOrArchived = Boolean(presentedSid && (!presentedSession || presentedSession.archivedAt));
      const crossSessionStale = Boolean(
        activeStudioSessionId && presentedSid && presentedSid !== activeStudioSessionId,
      );

      let sameSessionAbandoned = false;
      if (
        !crossSessionStale
        && !sessionGoneOrArchived
        && presentedSid
        && presentedSid === activeStudioSessionId
        && !this.deps.coworkRunner().isSessionActive(presentedSid)
      ) {
        const queuedCount = this.deps.decisionQueueStore()
          .listOpen(twinId)
          .filter((item) => item.status === 'queued')
          .length;
        const presentedAtMs = Date.parse(presentingDecision.presentedAt ?? '');
        if (queuedCount > 0 && Number.isFinite(presentedAtMs)) {
          const messages = Array.isArray(presentedSession?.messages) ? presentedSession!.messages : [];
          let ownerTurnsAfterPresent = 0;
          for (const msg of messages) {
            if (!msg || msg.type !== 'user') continue;
            const meta = msg.metadata as Record<string, unknown> | undefined;
            if (meta?.isDelegationInternal) continue;
            const ts = typeof msg.timestamp === 'number' ? msg.timestamp : 0;
            if (ts > presentedAtMs) {
              ownerTurnsAfterPresent += 1;
            }
          }
          if (ownerTurnsAfterPresent >= 2) {
            sameSessionAbandoned = true;
          }
        }
      }

      if (crossSessionStale || sessionGoneOrArchived || sameSessionAbandoned) {
        this.deps.decisionQueueStore().deferPresenting(presentingDecision.id, atIso);
        this.emitLog(
          `[StudioChiefOfStaff] Auto-deferred stale presenting decision ${presentingDecision.id} ` +
            `(presentedSession=${presentedSid || '(none)'}, activeStudio=${activeStudioSessionId || '(none)'}, ` +
            `crossSession=${crossSessionStale}, archivedOrGone=${sessionGoneOrArchived}, abandoned=${sameSessionAbandoned})`,
        );
      }
    }

    const followUpStore = this.deps.followUpStore?.();
    const presentingFollowUp = followUpStore?.getPresenting(twinId) ?? null;
    if (
      followUpStore
      && presentingFollowUp
      && !this.presenceTracker.isBriefingTurnRunning(presentingFollowUp.presentedSessionId)
    ) {
      const presentedSid = (presentingFollowUp.presentedSessionId ?? '').trim();
      const presentedSession = presentedSid
        ? (store.getSession(presentedSid) as (CoworkSession & { archivedAt?: number | null }) | null)
        : null;
      const sessionGoneOrArchived = Boolean(presentedSid && (!presentedSession || presentedSession.archivedAt));
      const crossSessionStale = Boolean(
        trackedSessionId && presentedSid && presentedSid !== trackedSessionId,
      );
      if (crossSessionStale || sessionGoneOrArchived) {
        followUpStore.deferPresenting(presentingFollowUp.id, atIso);
        this.emitLog(
          `[StudioChiefOfStaff] Auto-deferred stale presenting follow-up ${presentingFollowUp.id} ` +
            `(presentedSession=${presentedSid || '(none)'}, trackedSession=${trackedSessionId || '(none)'})`,
        );
      }
    }
  }

  /**
   * Heartbeat handler (`studio.chiefOfStaff`): cheap local state check.
   * When the Twin's Studio front-office presence is `'idle'` and an owner
   * decision/acceptance item is queued, claims the head item, projects its
   * HTML briefing onto the right-hand screen, and triggers a proactive Twin
   * briefing turn in the active Studio conversation.
   */
  private async checkProgressiveWaitingReassurance(
    studioSessionId: string | null,
    nowMs: number,
  ): Promise<CoworkMessage | null> {
    if (!studioSessionId) return null;
    if (this.deps.coworkRunner().isSessionActive(studioSessionId)) return null;
    if (this.waitingReassuranceInFlight.has(studioSessionId)) return null;

    const openWorkers = this.deps.listOpenSiblingDelegations?.(studioSessionId) ?? [];
    const activeSup = this.getActiveSupervisionForSession(studioSessionId);
    if (openWorkers.length === 0 && !activeSup) {
      this.waitingReassuranceState.delete(studioSessionId);
      return null;
    }

    const isVerifying = openWorkers.length === 0 && Boolean(activeSup);
    const signature = openWorkers.length > 0
      ? `workers:${openWorkers.map((w) => w.attemptId).sort().join(',')}`
      : `verify:${activeSup!.attemptId}`;

    const session = this.deps.coworkStore().getSession(studioSessionId);
    const messages = Array.isArray(session?.messages) ? session!.messages : [];
    let latestVisibleNonReassuranceAt = 0;
    const recentConvoLines: string[] = [];
    const sessionReassuranceHistory: Array<{ ts: number; content: string }> = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg) continue;
      const meta = msg.metadata as Record<string, unknown> | undefined;
      if (meta?.isDelegationInternal) continue;
      if (meta?.waitingReassurance) {
        const text = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (text && sessionReassuranceHistory.length < 5) {
          sessionReassuranceHistory.unshift({
            ts: typeof msg.timestamp === 'number' ? msg.timestamp : 0,
            content: text,
          });
        }
        continue;
      }
      if (msg.type === 'user' || (msg.type === 'assistant' && !meta?.isThinking)) {
        const ts = typeof msg.timestamp === 'number' ? msg.timestamp : 0;
        if (ts > latestVisibleNonReassuranceAt) {
          latestVisibleNonReassuranceAt = ts;
        }
        const text = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (text && recentConvoLines.length < 3) {
          const speaker = msg.type === 'user' ? 'Owner' : 'TwinBot';
          recentConvoLines.unshift(`${speaker}: ${clipCleanTitle(text, 120)}`);
        }
      }
    }

    const earliestWorkerStart = openWorkers.length > 0
      ? openWorkers.reduce((min, w) => Math.min(min, w.startedAt ?? nowMs), openWorkers[0].startedAt ?? nowMs)
      : (activeSup?.startedAt ?? nowMs);

    let state = this.waitingReassuranceState.get(studioSessionId);
    if (!state) {
      const initialNoticeBase = Math.max(
        earliestWorkerStart,
        latestVisibleNonReassuranceAt || earliestWorkerStart,
      );
      state = {
        waitBeganMs: earliestWorkerStart,
        lastNoticeMs: initialNoticeBase,
        lastVisibleChatAtMs: latestVisibleNonReassuranceAt,
        rungIndex: 0,
        signature,
        priorMessages: [],
      };
      this.waitingReassuranceState.set(studioSessionId, state);
    } else if (
      latestVisibleNonReassuranceAt > state.lastVisibleChatAtMs
      && latestVisibleNonReassuranceAt > state.lastNoticeMs
    ) {
      // Only reset the silence window when a new visible front-office chat
      // message actually arrived — NEVER when internal worker retries or
      // back-office [督办] verification start with a newer `startedAt`.
      state.lastNoticeMs = latestVisibleNonReassuranceAt;
      state.lastVisibleChatAtMs = latestVisibleNonReassuranceAt;
      state.rungIndex = 0;
      state.signature = signature;
      state.waitBeganMs = Math.min(state.waitBeganMs, earliestWorkerStart);
    } else {
      // Preserve `lastNoticeMs`, `rungIndex`, and continuous `waitBeganMs`
      // across worker retries, partial sibling completions, and verification.
      state.signature = signature;
      state.waitBeganMs = Math.min(state.waitBeganMs, earliestWorkerStart);
      state.lastVisibleChatAtMs = Math.max(state.lastVisibleChatAtMs, latestVisibleNonReassuranceAt);
    }

    const intervals = this.reassuranceIntervalsMs;
    const neededIntervalMs = intervals[Math.min(state.rungIndex, intervals.length - 1)];
    if (nowMs - state.lastNoticeMs < neededIntervalMs) {
      return null;
    }

    state.lastNoticeMs = nowMs;
    const currentRung = state.rungIndex;
    state.rungIndex += 1;

    if (!this.deps.generateWaitingReassurance) {
      return null;
    }

    const totalMinutes = Math.max(1, Math.round((nowMs - state.waitBeganMs) / 60_000));
    const language = this.deps.getAppLanguage?.() ?? 'zh';
    const workerContexts = openWorkers.length > 0
      ? openWorkers.slice(0, 4).map((w) => ({
          workerName: w.workerName || 'Worker',
          title: clipCleanTitle(w.title ?? '', 48) || null,
          progressNote: w.longtermTaskId
            ? ((this.deps.getTaskProgressNote?.(w.longtermTaskId) ?? '').trim() || null)
            : null,
        }))
      : [{
          workerName: activeSup!.workerName || 'Worker',
          title: clipCleanTitle(activeSup!.title ?? '', 48) || null,
          progressNote: null,
        }];

    const priorMessages = state.priorMessages.length > 0
      ? [...state.priorMessages]
      : sessionReassuranceHistory
          .filter((entry) => entry.ts === 0 || entry.ts >= state!.waitBeganMs)
          .map((entry) => entry.content);
    const lastReassurance = priorMessages[priorMessages.length - 1] ?? '';
    const lastMentionedParallel = /并发|并行|其他事|别的|聊|parallel|other task|something else/i.test(lastReassurance);
    const includeParallelHint = !lastMentionedParallel && (currentRung === 0 || currentRung % 2 === 0);

    this.waitingReassuranceInFlight.add(studioSessionId);
    let rawContent = '';
    try {
      rawContent = await this.deps.generateWaitingReassurance({
        language,
        phase: isVerifying ? 'verifying' : 'working',
        waitedMinutes: totalMinutes,
        priorCount: priorMessages.length,
        workers: workerContexts,
        priorMessages,
        recentConversationContext: recentConvoLines.join('\n'),
        includeParallelHint,
      });
    } catch (err) {
      this.emitLog(
        `[StudioChiefOfStaff] Waiting reassurance generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      this.waitingReassuranceInFlight.delete(studioSessionId);
    }

    // Re-check liveness after async LLM call so a completed or busy session
    // never receives an obsolete waiting bubble.
    if (this.deps.coworkRunner().isSessionActive(studioSessionId)) {
      return null;
    }
    const openWorkersNow = this.deps.listOpenSiblingDelegations?.(studioSessionId) ?? [];
    const activeSupNow = this.getActiveSupervisionForSession(studioSessionId);
    if (openWorkersNow.length === 0 && !activeSupNow) {
      this.waitingReassuranceState.delete(studioSessionId);
      return null;
    }
    const latestSession = this.deps.coworkStore().getSession(studioSessionId);
    const latestMessages = Array.isArray(latestSession?.messages) ? latestSession!.messages : [];
    for (let i = latestMessages.length - 1; i >= 0; i -= 1) {
      const m = latestMessages[i];
      if (!m) continue;
      const meta = m.metadata as Record<string, unknown> | undefined;
      if (meta?.isDelegationInternal || meta?.waitingReassurance) continue;
      if (m.type === 'user' || (m.type === 'assistant' && !meta?.isThinking)) {
        const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
        if (ts > nowMs) return null;
        break;
      }
    }

    const languageCue = language === 'zh' ? '请用中文汇报进度' : 'Reply in English';
    const content = sanitizeTurnAckReplyForInput(rawContent ?? '', languageCue);
    if (!content) {
      return null;
    }
    const normalizedCandidate = this.normalizeReassuranceText(content);
    if (
      normalizedCandidate
      && priorMessages.some((prev) => this.normalizeReassuranceText(prev) === normalizedCandidate)
    ) {
      this.emitLog('[StudioChiefOfStaff] Dropped duplicate waiting reassurance bubble');
      return null;
    }

    state.priorMessages.push(content);
    if (state.priorMessages.length > 5) {
      state.priorMessages.splice(0, state.priorMessages.length - 5);
    }

    const msg = this.deps.coworkStore().addMessage(studioSessionId, {
      type: 'assistant',
      content,
      metadata: { waitingReassurance: true } as CoworkMessage['metadata'],
    });
    this.deps.emitSessionMessage?.(studioSessionId, msg);
    return msg;
  }

  async runHeartbeatTick(nowMs: number = this.now()): Promise<{
    presentedItemId: string | null;
    presentedFollowUpId?: string | null;
    reassuranceMessageId?: string | null;
    taskWatermarkChanged?: boolean;
    presence: StudioTwinPresenceSnapshot;
  }> {
    let taskWatermarkChanged = false;
    if (this.deps.getTaskWatermark) {
      try {
        const currentWatermark = this.deps.getTaskWatermark();
        if (this.lastObservedTaskWatermark !== null && this.lastObservedTaskWatermark !== currentWatermark) {
          taskWatermarkChanged = true;
          this.deps.onStateChanged?.('task_db_updated');
        }
        this.lastObservedTaskWatermark = currentWatermark;
      } catch {
        // Best-effort watermark check.
      }
    }
    this.reconcileStalePresentingItems(nowMs);
    const snapshot = this.getPresenceSnapshot(nowMs);
    if (this.heartbeatInFlight) {
      return { presentedItemId: null, ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}), presence: snapshot };
    }
    const reassuranceMsg = await this.checkProgressiveWaitingReassurance(snapshot.activeStudioSessionId, nowMs);
    if (reassuranceMsg) {
      return {
        presentedItemId: null,
        reassuranceMessageId: reassuranceMsg.id,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: this.getPresenceSnapshot(nowMs),
      };
    }
    const twinId = this.deps.resolveTwinMetabotId();
    if (twinId == null || snapshot.mode !== 'idle') {
      return {
        presentedItemId: null,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: snapshot,
      };
    }

    if (snapshot.queuedCount === 0 || !snapshot.activeStudioSessionId) {
      if ((snapshot.followUpQueuedCount ?? 0) > 0 && this.deps.followUpStore) {
        return this.deliverNextProactiveFollowUp(twinId, nowMs, taskWatermarkChanged);
      }
      return {
        presentedItemId: null,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: snapshot,
      };
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

    if (claimed.longtermTaskId) {
      this.focusTask(studioSessionId, claimed.longtermTaskId);
    }
    this.heartbeatInFlight = true;
    this.presenceTracker.setBriefingTurnRunning(studioSessionId, true);
    this.deps.onStateChanged?.('briefing_started');

    try {
      const turnStartedMs = this.now();
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

      const postTurnSession = this.deps.coworkStore().getSession(studioSessionId) as (CoworkSession & {
        lastTurnFailedAtMs?: number | null;
        lastTurnCompletedAtMs?: number | null;
      }) | null;
      const postTurnItem = this.deps.decisionQueueStore().getById(claimed.id);
      if (
        postTurnItem?.status === 'presenting'
        && typeof postTurnSession?.lastTurnFailedAtMs === 'number'
        && postTurnSession.lastTurnFailedAtMs >= turnStartedMs
        && (postTurnSession.lastTurnCompletedAtMs ?? 0) < postTurnSession.lastTurnFailedAtMs
      ) {
        this.emitLog(
          `[StudioChiefOfStaff] Proactive briefing turn ended unanswered (${claimed.id}); deferring back to queue`,
        );
        this.deps.decisionQueueStore().deferPresenting(claimed.id);
        return {
          presentedItemId: null,
          presence: this.getPresenceSnapshot(this.now()),
        };
      }

      // Project onto the right-hand showcase ONLY if the Twin kept this item
      // in `presenting` (meaning it genuinely requires an owner ruling right
      // now — NOT auto-closed as already answered!) and did not already project
      // its own fresh page during the turn.
      const alreadyProjectedInTurn = Boolean(
        this.deps.didSessionProjectSince?.(studioSessionId, turnStartedMs),
      );
      if (
        postTurnItem?.status === 'presenting'
        && !alreadyProjectedInTurn
        && this.deps.projectShowcaseHtml
      ) {
        let reportPath = localFilesystemPathFromArtifactRef(postTurnItem.reportHtmlPath);
        if (!reportPath || !fs.existsSync(reportPath)) {
          try {
            const workspace = this.deps.resolveTwinWorkspace(twinId);
            const reportsDir = path.join(workspace, 'reports');
            fs.mkdirSync(reportsDir, { recursive: true });
            const fallbackPath = path.join(reportsDir, `briefing-${postTurnItem.id}.html`);
            const openAll = this.deps.decisionQueueStore().listOpen(twinId);
            fs.writeFileSync(
              fallbackPath,
              buildStudioDecisionReportHtml({
                item: postTurnItem,
                queuePosition: 1,
                queueTotal: Math.max(1, openAll.length),
                language,
              }),
              'utf8',
            );
            reportPath = fallbackPath;
          } catch {
            reportPath = null;
          }
        }
        if (reportPath && fs.existsSync(reportPath)) {
          try {
            await this.deps.projectShowcaseHtml({
              sessionId: studioSessionId,
              localPath: reportPath,
              title: postTurnItem.title,
            });
          } catch (projErr) {
            this.emitLog(
              `[StudioChiefOfStaff] Showcase projection failed for ${postTurnItem.id}: ` +
                `${projErr instanceof Error ? projErr.message : String(projErr)}`,
            );
          }
        }
      }

      return {
        presentedItemId: postTurnItem?.status === 'presenting' ? claimed.id : null,
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

  private async deliverNextProactiveFollowUp(
    twinId: number,
    nowMs: number,
    taskWatermarkChanged: boolean,
  ): Promise<{
    presentedItemId: string | null;
    presentedFollowUpId?: string | null;
    taskWatermarkChanged?: boolean;
    presence: StudioTwinPresenceSnapshot;
  }> {
    const followUpStore = this.deps.followUpStore?.();
    if (!followUpStore) {
      return {
        presentedItemId: null,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: this.getPresenceSnapshot(nowMs),
      };
    }

    const target = this.resolvePrimaryTwinOwnerSession(twinId, {
      createIfMissingInServerMode: true,
    });
    if (!target.sessionId) {
      return {
        presentedItemId: null,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: this.getPresenceSnapshot(nowMs),
      };
    }
    const targetSessionId = target.sessionId;

    if (this.deps.coworkRunner().isSessionActive(targetSessionId)) {
      return {
        presentedItemId: null,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: this.getPresenceSnapshot(nowMs),
      };
    }

    const claimed = followUpStore.claimNextForPresentation(
      twinId,
      targetSessionId,
      new Date(nowMs).toISOString(),
    );
    if (!claimed) {
      return {
        presentedItemId: null,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: this.getPresenceSnapshot(nowMs),
      };
    }

    this.heartbeatInFlight = true;
    this.presenceTracker.setBriefingTurnRunning(targetSessionId, true);
    this.deps.onStateChanged?.('followup_briefing_started');

    try {
      const turnStartedMs = this.now();
      const remainingQueued = followUpStore
        .listOpen(twinId)
        .filter((item) => item.status === 'queued' && item.reportingGranularity === 'immediate').length;
      const language = this.deps.getAppLanguage?.() ?? 'zh';
      const briefingPrompt = buildProactiveFollowUpBriefingPrompt(claimed, remainingQueued, language);

      const store = this.deps.coworkStore();
      store.updateSession(targetSessionId, { status: 'running' });
      const triggerMsg = store.addMessage(targetSessionId, {
        type: 'user',
        content: briefingPrompt,
        metadata: {
          isDelegationInternal: true,
          origin: 'studio_briefing',
          followUpId: claimed.id,
        } as CoworkMessage['metadata'],
      });
      this.deps.emitSessionMessage?.(targetSessionId, triggerMsg);

      await this.deps.coworkRunner().startSession(targetSessionId, briefingPrompt, {
        skipInitialUserMessage: true,
        acknowledgeOwner: false,
      });

      const postTurnSession = store.getSession(targetSessionId) as (CoworkSession & {
        lastTurnFailedAtMs?: number | null;
        lastTurnCompletedAtMs?: number | null;
      }) | null;
      let postTurnItem = followUpStore.getById(claimed.id);
      if (
        postTurnItem?.status === 'presenting'
        && typeof postTurnSession?.lastTurnFailedAtMs === 'number'
        && postTurnSession.lastTurnFailedAtMs >= turnStartedMs
        && (postTurnSession.lastTurnCompletedAtMs ?? 0) < postTurnSession.lastTurnFailedAtMs
      ) {
        this.emitLog(
          `[StudioChiefOfStaff] Proactive follow-up briefing turn failed (${claimed.id}); deferring back to queue`,
        );
        followUpStore.deferPresenting(claimed.id);
        this.presenceTracker.setBriefingTurnRunning(targetSessionId, false);
        return {
          presentedItemId: null,
          presentedFollowUpId: null,
          ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
          presence: this.getPresenceSnapshot(this.now()),
        };
      }

      // Zero-turn FYI (`inform`, including both `handled` and `declined`) must
      // release the presentation lock immediately once spoken so subsequent
      // queued items are never blocked awaiting a redundant owner reply!
      let wasSpokenToOwner = false;
      if (postTurnItem?.status === 'presenting' && postTurnItem.tier === 'inform') {
        postTurnItem = followUpStore.markDelivered(
          claimed.id,
          'delivered naturally in Twin chat stream',
          new Date(this.now()).toISOString(),
        );
        wasSpokenToOwner = true;
      } else if (postTurnItem?.status === 'presenting') {
        wasSpokenToOwner = true;
      }

      if (wasSpokenToOwner && postTurnItem) {
        this.deps.onProactiveFollowUpDeliveredToSession?.({
          item: postTurnItem,
          sessionId: targetSessionId,
          isPrimaryNonStudioFallback: target.isPrimaryNonStudioFallback,
        });
      }

      this.presenceTracker.setBriefingTurnRunning(targetSessionId, false);
      return {
        presentedItemId: wasSpokenToOwner ? claimed.id : null,
        presentedFollowUpId: wasSpokenToOwner ? claimed.id : null,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: this.getPresenceSnapshot(this.now()),
      };
    } catch (error) {
      this.emitLog(
        `[StudioChiefOfStaff] Proactive follow-up briefing turn threw (${claimed.id}); deferring back to queue: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      followUpStore.deferPresenting(claimed.id);
      this.presenceTracker.setBriefingTurnRunning(targetSessionId, false);
      return {
        presentedItemId: null,
        presentedFollowUpId: null,
        ...(taskWatermarkChanged ? { taskWatermarkChanged: true } : {}),
        presence: this.getPresenceSnapshot(this.now()),
      };
    } finally {
      this.presenceTracker.setBriefingTurnRunning(targetSessionId, false);
      this.heartbeatInFlight = false;
      this.deps.onStateChanged?.('followup_briefing_settled');
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
    const publisher = this.deps.resolvePublisherIdentity?.(params.twinId) ?? {
      name: `Bot #${params.twinId}`,
      role: 'Twin',
    };
    const publisherLine = [
      `${publisher.name} (${publisher.role})`,
      publisher.globalMetaId ? `MetaID: ${publisher.globalMetaId}` : '',
      publisher.address ? `Address: ${publisher.address}` : '',
    ].filter(Boolean).join(' · ');

    let reportHtmlPath: string | null = null;
    try {
      fs.mkdirSync(reportsDir, { recursive: true });
      const filePath = path.join(reportsDir, `${params.jobId}-receipt.html`);
      const rowsHtml = receipts
        .map((r) => r.error
          ? `<tr><td>${escapeHtml(r.title)}</td><td style="color:#b91c1c">Failed: ${escapeHtml(r.error)}</td><td>-</td></tr>`
          : `<tr><td>${escapeHtml(r.title)}</td><td><a href="pin://${escapeHtml(r.pinId)}"><code>pin://${escapeHtml(r.pinId)}</code></a></td><td>${r.cost} sats</td></tr>`)
        .join('\n');
      fs.writeFileSync(
        filePath,
        `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>链上盖章发布凭证</title>` +
          `<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f5f6f8;color:#15181c;padding:28px;margin:0}` +
          `.card{max-width:860px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.05)}` +
          `.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#dcfce7;color:#166534;margin-bottom:10px}` +
          `.signer{margin-top:8px;padding:10px 12px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;font-size:12px;color:#334155;word-break:break-all}` +
          `table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e5e7eb}code{font-size:12px;word-break:break-all}</style></head>` +
          `<body><div class="card"><span class="badge">总裁办盖章上链凭证</span><h1 style="font-size:20px;margin:0 0 8px">链上发布回执（成功 ${receipts.filter((r) => !r.error).length}/${receipts.length}）</h1>` +
          `<div class="signer"><strong>发布账号：</strong>${escapeHtml(publisherLine)}</div>` +
          `<p style="font-size:13px;color:#4b5563;margin:10px 0 0">批准依据：${escapeHtml(params.approvalNote)}</p>` +
          `<table><thead><tr><th>标题</th><th>完整链上 Pin ID（点击打开）</th><th>网络费用</th></tr></thead><tbody>${rowsHtml}</tbody></table></div></body></html>`,
        'utf8',
      );
      reportHtmlPath = filePath;
    } catch {
      reportHtmlPath = null;
    }

    const okCount = receipts.filter((r) => !r.error).length;
    const language = this.deps.getAppLanguage?.() ?? 'zh';
    const pinLines = [
      language === 'zh' ? `发布账号：${publisherLine}` : `Published by: ${publisherLine}`,
      ...receipts.map((r) =>
        r.error
          ? `- ${r.title}: FAILED (${r.error})`
          : `- [${r.title}](pin://${r.pinId}) — Pin ID: \`pin://${r.pinId}\``,
      ),
    ].join('\n');

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
