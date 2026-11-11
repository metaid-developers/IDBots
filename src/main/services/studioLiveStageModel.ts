import type { CoworkMessage } from '../coworkStore';

export const LIVE_STAGE_PROTOCOL = 'idbots.live-stage.v1' as const;

export type LiveStageFamily =
  | 'received' | 'reasoning' | 'speaking' | 'local-recall' | 'web2-research'
  | 'metaweb-research' | 'making' | 'delegation' | 'waiting' | 'worker-report'
  | 'verification' | 'browser-action' | 'owner-needed' | 'problem'
  | 'report-ready' | 'complete';

export type LiveStageInteractionQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  detail?: string;
};

/**
 * One owner-facing prompt hosted on the stage. The stage renders it as a card
 * and queues the click back to the host; the host still owns the decision —
 * the card is a presentation surface, never the authority.
 */
export type LiveStageInteraction = {
  requestId: string;
  /** Single-use random echo value; drained clicks must return it. */
  token: string;
  kind: 'ask' | 'approval';
  title: string;
  detail: string;
  questions: LiveStageInteractionQuestion[];
  /** Approval watchdog deadline; asks wait indefinitely (null). */
  expiresAt: number | null;
  timeoutDefault: 'allow' | 'deny' | null;
};

export type LiveStageMetrics = {
  directorEnabled: boolean;
  directorCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  rejectedPatches: number;
  fallbackCount: number;
  directorLatencyMs: number;
};

export type LiveStageState = {
  protocol: typeof LIVE_STAGE_PROTOCOL;
  sessionId: string;
  turnId: string;
  revision: number;
  enabled: boolean;
  family: LiveStageFamily;
  botName: string;
  language: 'zh' | 'en';
  headline: string;
  caption: string;
  composition: 'presence' | 'gather' | 'topology' | 'converge' | 'ready';
  motif: string;
  participants: string[];
  topology: {
    mode: 'presence' | 'structured';
    nodes: Array<{ id: string; label: string; kind: 'twin' | 'source' | 'worker' | 'evidence' | 'owner'; avatar?: string }>;
    edges: Array<[string, string]>;
  };
  motion: {
    preset: string;
    seed: number;
    durationMs: number;
    easing: string;
    energy: number;
    density: number;
  };
  metrics: LiveStageMetrics;
  handoff: { direction: 'dispatch' | 'return'; eventId: string } | null;
  /** Prompt currently hosted on the stage card, if any. */
  interaction: LiveStageInteraction | null;
  pendingProjectionIds: string[];
  eventWindow: Array<{ family: LiveStageFamily; tool?: string; outcome?: string }>;
};

export type LiveStageSessionContext = {
  sessionId: string;
  turnId: string;
  botName: string;
  language: 'zh' | 'en';
  directorEnabled?: boolean;
};

const text = (language: 'zh' | 'en', zh: string, en: string): string => language === 'zh' ? zh : en;

function sceneFor(family: LiveStageFamily, language: 'zh' | 'en', botName: string): Pick<LiveStageState, 'headline' | 'caption' | 'composition' | 'motif' | 'participants' | 'topology'> {
  const scenes: Record<LiveStageFamily, { headline: string; caption: string; participants: string[] }> = {
    received: { headline: text(language, '收到，开始处理', 'Request received'), caption: text(language, `${botName} 已接到你的请求，正在建立本轮工作现场。`, `${botName} has the request and is establishing this run.`), participants: [botName] },
    reasoning: { headline: text(language, '正在梳理思路', 'Thinking through the request'), caption: text(language, '正在整理目标、上下文和下一步，不展示原始推理。', 'Organizing the goal, context, and next step without exposing raw reasoning.'), participants: [botName] },
    speaking: { headline: text(language, '正在向你汇报', 'Speaking to you'), caption: text(language, '新的可见回应正在形成，左侧仍保留完整文字记录。', 'A visible response is arriving while the left transcript stays complete.'), participants: [botName] },
    'local-recall': { headline: text(language, '正在回查相关记录', 'Checking local context'), caption: text(language, '正在核对任务板、历史会话和本地资料。', 'Reviewing task records, past conversations, and local material.'), participants: [botName, text(language, '本地记录', 'Local records')] },
    'web2-research': { headline: text(language, '正在检索互联网', 'Searching the web'), caption: text(language, '正在查找并核对公开网络资料。', 'Finding and checking public web sources.'), participants: [botName, 'Web'] },
    'metaweb-research': { headline: text(language, '正在检索 AI 互联网', 'Searching MetaWeb'), caption: text(language, '正在读取链上资料与 MetaWeb 证据。', 'Reading on-chain material and MetaWeb evidence.'), participants: [botName, 'MetaWeb'] },
    making: { headline: text(language, '正在制作交付内容', 'Shaping the deliverable'), caption: text(language, '资料正在转化为可交付的文件或页面。', 'Source material is becoming a deliverable file or page.'), participants: [botName, text(language, '交付物', 'Deliverable')] },
    delegation: { headline: text(language, '正在分派协作任务', 'Delegating structured work'), caption: text(language, '任务关系已经展开，协作 Bot 正在接手对应部分。', 'The task graph has expanded and a collaborator is taking a workstream.'), participants: [botName, text(language, '协作 Bot', 'Worker')] },
    waiting: { headline: text(language, '正在等待协作回执', 'Waiting for a worker'), caption: text(language, '工作仍在进行，当前没有可伪造的完成进度。', 'Work is still running without an invented completion percentage.'), participants: [botName, text(language, '协作 Bot', 'Worker')] },
    'worker-report': { headline: text(language, '协作结果已返回', 'A worker has reported back'), caption: text(language, '回执已经到达，还需要核对证据才能验收。', 'A receipt has arrived and still needs evidence verification.'), participants: [botName, text(language, '协作 Bot', 'Worker'), text(language, '回执', 'Report')] },
    verification: { headline: text(language, '正在独立核验', 'Checking the evidence'), caption: text(language, '正在把回执、原始资料和实际结果逐项对照。', 'Comparing claims with original material and observed results.'), participants: [botName, text(language, '证据', 'Evidence')] },
    'browser-action': { headline: text(language, '正在操作大屏幕', 'Working on the big screen'), caption: text(language, '正在打开、检查或验证右侧浏览器中的页面。', 'Opening, inspecting, or verifying a page in the right browser.'), participants: [botName, text(language, '投影页', 'Projection')] },
    'owner-needed': { headline: text(language, '需要你的决定', 'Your decision is needed'), caption: text(language, '当前工作已来到需要你拍板的位置。', 'The work has reached a decision that belongs to you.'), participants: [botName, text(language, '主人', 'Owner')] },
    problem: { headline: text(language, '遇到一个问题', 'A problem needs attention'), caption: text(language, '现场正在保留真实错误与恢复状态，不会包装成成功。', 'The stage preserves the real error and recovery state instead of claiming success.'), participants: [botName] },
    'report-ready': { headline: text(language, '汇报已生成', 'The report is ready'), caption: text(language, '本轮过程已经收束，即将打开最终结果页；后退可回到这里。', 'The process is settling into the final report. Back returns to this trace.'), participants: [botName, text(language, '最终汇报', 'Final report')] },
    complete: { headline: text(language, '本轮工作已完成', 'This run is complete'), caption: text(language, '过程已经收束，左侧保留完整文字记录。', 'The process has settled and the left transcript remains available.'), participants: [botName] },
  };
  const scene = scenes[family];
  const structured = family === 'delegation' || family === 'worker-report' || family === 'verification' || family === 'browser-action';
  const nodes = structured ? [
    { id: 'twin', label: botName, kind: 'twin' as const },
    { id: 'source', label: family === 'verification' ? text(language, '原始资料', 'Source') : 'MetaWeb', kind: 'source' as const },
    { id: 'worker', label: text(language, '协作 Bot', 'Worker'), kind: 'worker' as const },
    { id: 'evidence', label: text(language, '证据', 'Evidence'), kind: 'evidence' as const },
  ] : [];
  return {
    ...scene,
    composition: family === 'verification' ? 'converge' : structured ? 'topology' : family === 'local-recall' || family === 'web2-research' || family === 'metaweb-research' ? 'gather' : family === 'report-ready' || family === 'complete' ? 'ready' : 'presence',
    motif: family,
    topology: {
      mode: structured ? 'structured' : 'presence',
      nodes,
      edges: structured ? [['twin', 'worker'], ['source', 'twin'], ['worker', 'evidence'], ['evidence', 'twin']] : [],
    },
  };
}

function seedFor(sessionId: string, turnId: string, revision: number): number {
  let hash = 2166136261;
  for (const char of `${sessionId}:${turnId}:${revision}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.abs(hash >>> 0) % 90000 + 1000;
}

export function createLiveStageState(context: LiveStageSessionContext): LiveStageState {
  const scene = sceneFor('received', context.language, context.botName);
  return {
    protocol: LIVE_STAGE_PROTOCOL,
    sessionId: context.sessionId,
    turnId: context.turnId,
    revision: 0,
    enabled: true,
    family: 'received',
    botName: context.botName,
    language: context.language,
    ...scene,
    motion: { preset: 'received', seed: seedFor(context.sessionId, context.turnId, 0), durationMs: 720, easing: 'emphasized-decelerate', energy: .35, density: .25 },
    metrics: { directorEnabled: context.directorEnabled === true, directorCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rejectedPatches: 0, fallbackCount: 0, directorLatencyMs: 0 },
    handoff: null,
    interaction: null,
    pendingProjectionIds: [],
    eventWindow: [{ family: 'received' }],
  };
}

function familyForTool(toolName: string): LiveStageFamily | null {
  const name = toolName.toLowerCase();
  if (name === 'ask_user_question') return 'owner-needed';
  if (name === 'local_worker_delegate' || name === 'idbots_session_insert_user_message' || name === 'twin_task_reassign') return 'delegation';
  if (name === 'longterm_subtask_wait' || name === 'twin_task_status') return 'waiting';
  if (name === 'bot_browser_screenshot' || name === 'bot_browser_read_page' || name === 'twin_task_accept' || name === 'mrc721_item_info') return 'verification';
  if (name.startsWith('bot_browser_')) return 'browser-action';
  if (name === 'write' || name === 'edit') return 'making';
  if (name.includes('web_search') || name.includes('websearch') || name === 'web_fetch' || name === 'fetch_url') return 'web2-research';
  if (name.startsWith('omni_') || name.includes('metaweb') || name.includes('metaapp') || name.startsWith('mrc721_') || name.startsWith('metatask_') || name === 'chain_history_recall' || name === 'read_metaweb_pin') return 'metaweb-research';
  if (name === 'owner_update' || name === 'read' || name === 'glob' || name === 'grep' || name === 'bash' || name === 'conversation_search' || name.startsWith('idbots_session_read') || name.startsWith('longterm_') || name.startsWith('memory_')) return 'local-recall';
  return null;
}

function eventSummary(message: CoworkMessage, family: LiveStageFamily): LiveStageState['eventWindow'][number] {
  const tool = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : undefined;
  const outcome = message.type === 'tool_result' ? (message.metadata?.isError ? 'error' : 'ok') : undefined;
  return { family, ...(tool ? { tool } : {}), ...(outcome ? { outcome } : {}) };
}

export function isLiveStageWorkerReport(message: CoworkMessage): boolean {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  return message.type === 'user' && (metadata?.origin === 'cross_session' || metadata?.sourceChannel === 'idbots_cross_session');
}

export function reduceLiveStageMessage(
  state: LiveStageState,
  message: CoworkMessage,
  options: { workerName?: string; workerAvatar?: string } = {},
): LiveStageState {
  let family = state.family;
  let headline: string | undefined;
  let caption: string | undefined;
  let pendingProjectionIds = state.pendingProjectionIds;
  const metadata = message.metadata as Record<string, unknown> | undefined;
  if (message.type === 'user') {
    family = isLiveStageWorkerReport(message) ? 'worker-report' : 'received';
  } else if (message.type === 'assistant') {
    family = message.metadata?.isThinking ? 'reasoning' : 'speaking';
  } else if (message.type === 'system') {
    if (message.metadata?.sdkRuntimeStatus === 'api_retry') family = 'problem';
    else if (message.metadata?.sdkRuntimeStatus === 'requesting') family = 'reasoning';
  } else if (message.type === 'tool_use') {
    const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : '';
    if (toolName === 'owner_update') {
      family = message.metadata?.toolInput?.kind === 'problem' ? 'problem' : 'speaking';
      if (typeof message.metadata?.toolInput?.message === 'string') headline = message.metadata.toolInput.message.slice(0, 160);
    } else {
      family = familyForTool(toolName) ?? state.family;
    }
    if (toolName === 'bot_browser_preview_local' && message.metadata?.toolInput?.projection === true) {
      const id = typeof message.metadata.toolUseId === 'string' ? message.metadata.toolUseId : message.id;
      if (!pendingProjectionIds.includes(id)) pendingProjectionIds = [...pendingProjectionIds, id];
    }
  } else if (message.type === 'tool_result') {
    const id = typeof message.metadata?.toolUseId === 'string' ? message.metadata.toolUseId : '';
    if (pendingProjectionIds.includes(id)) {
      family = message.metadata.isError ? 'problem' : 'report-ready';
      pendingProjectionIds = pendingProjectionIds.filter((pendingId) => pendingId !== id);
    }
  }
  const scene = sceneFor(family, state.language, state.botName);
  const workerLabel = options.workerName?.trim().slice(0, 80)
    || (state.topology.mode === 'structured' ? state.topology.nodes.find((node) => node.kind === 'worker')?.label : undefined);
  const workerAvatar = options.workerAvatar
    || (state.topology.mode === 'structured' ? state.topology.nodes.find((node) => node.kind === 'worker')?.avatar : undefined);
  if (workerLabel && scene.topology.mode === 'structured') {
    scene.topology.nodes = scene.topology.nodes.map((node) => node.kind === 'worker'
      ? { ...node, label: workerLabel, ...(workerAvatar ? { avatar: workerAvatar } : {}) }
      : node);
    scene.participants = scene.participants.map((participant, index) => index === 1 ? workerLabel : participant);
  }
  const handoff = family === 'worker-report'
    ? { direction: 'return' as const, eventId: typeof metadata?.crossSessionDeliveryId === 'string' ? metadata.crossSessionDeliveryId : message.id }
    : family === 'delegation'
      ? { direction: 'dispatch' as const, eventId: typeof metadata?.toolUseId === 'string' ? metadata.toolUseId : message.id }
      : null;
  return {
    ...state,
    ...scene,
    headline: headline ?? scene.headline,
    caption: caption ?? scene.caption,
    revision: state.revision + 1,
    family,
    handoff,
    motion: { preset: family, seed: seedFor(state.sessionId, state.turnId, state.revision + 1), durationMs: 720, easing: 'emphasized-decelerate', energy: family === 'report-ready' || family === 'complete' ? .18 : family === 'verification' ? .55 : .4, density: scene.topology.mode === 'structured' ? .55 : .28 },
    pendingProjectionIds,
    eventWindow: [...state.eventWindow, eventSummary(message, family)].slice(-8),
  };
}

export function completeLiveStage(state: LiveStageState): LiveStageState {
  if (state.family === 'report-ready') return state;
  const scene = sceneFor('complete', state.language, state.botName);
  return { ...state, ...scene, family: 'complete', handoff: null, revision: state.revision + 1, motion: { ...state.motion, preset: 'complete', energy: .12, durationMs: 600 } };
}

export function reportReadyLiveStage(state: LiveStageState): LiveStageState {
  const scene = sceneFor('report-ready', state.language, state.botName);
  return { ...state, ...scene, family: 'report-ready', handoff: null, revision: state.revision + 1, pendingProjectionIds: [], motion: { ...state.motion, preset: 'report-ready', energy: .18, durationMs: 650 } };
}

export function liveStageError(state: LiveStageState): LiveStageState {
  const scene = sceneFor('problem', state.language, state.botName);
  return { ...state, ...scene, family: 'problem', handoff: null, revision: state.revision + 1, motion: { ...state.motion, preset: 'problem', energy: .25 } };
}

const MAX_INTERACTION_QUESTIONS = 6;
const MAX_INTERACTION_OPTIONS = 8;

const sliceText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const questionOf = (raw: unknown): LiveStageInteractionQuestion | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const question = sliceText(record.question, 400);
  if (!question) return null;
  const options = (Array.isArray(record.options) ? record.options : [])
    .slice(0, MAX_INTERACTION_OPTIONS)
    .map((option): { label: string; description?: string } | null => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const label = sliceText((option as Record<string, unknown>).label, 200);
      if (!label) return null;
      const description = sliceText((option as Record<string, unknown>).description, 400);
      return description ? { label, description } : { label };
    })
    .filter((option): option is { label: string; description?: string } => option !== null);
  const header = sliceText(record.header, 60);
  const detail = sliceText(record.detail, 2000);
  return {
    question,
    options,
    multiSelect: record.multiSelect === true,
    ...(header ? { header } : {}),
    ...(detail ? { detail } : {}),
  };
};

export type LiveStageInteractionCandidate = {
  requestId: unknown;
  toolName: unknown;
  toolInput?: Record<string, unknown> | null;
  expiresAt?: unknown;
  timeoutDefault?: unknown;
};

/**
 * Decide whether a pending permission can be hosted on the stage, and shape
 * the card data if so. Ordinary prompts only — A2A approvals and
 * delete-safety confirmations keep their desktop seats (Phase 1 ruling:
 * ask + plain approval, dual seats with the overlay).
 * Returns null when the request must stay off the stage.
 */
export function buildLiveStageInteraction(candidate: LiveStageInteractionCandidate, token: string): LiveStageInteraction | null {
  const requestId = typeof candidate.requestId === 'string' ? candidate.requestId.trim() : '';
  if (!requestId) return null;
  const toolName = typeof candidate.toolName === 'string' ? candidate.toolName.trim() : '';
  if (!toolName) return null;
  const input = candidate.toolInput && typeof candidate.toolInput === 'object' && !Array.isArray(candidate.toolInput)
    ? candidate.toolInput as Record<string, unknown>
    : {};
  const expiresAt = typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt) ? candidate.expiresAt : null;
  const timeoutDefault = candidate.timeoutDefault === 'allow' || candidate.timeoutDefault === 'deny' ? candidate.timeoutDefault : null;
  if (toolName === 'AskUserQuestion') {
    const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
      ? input.context as Record<string, unknown>
      : null;
    if (context) {
      const action = typeof context.action === 'string' ? context.action : '';
      if (context.a2aApproval === true || action === 'invite' || action === 'remove') return null;
      if (sliceText(context.requestedToolName, 200)) return null;
    }
    const questions = (Array.isArray(input.questions) ? input.questions : [])
      .slice(0, MAX_INTERACTION_QUESTIONS)
      .map(questionOf)
      .filter((question): question is LiveStageInteractionQuestion => question !== null);
    if (questions.length === 0) return null;
    return {
      requestId,
      token,
      kind: 'ask',
      title: questions[0].question,
      detail: questions[0].detail ?? '',
      questions,
      expiresAt,
      timeoutDefault,
    };
  }
  return {
    requestId,
    token,
    kind: 'approval',
    title: toolName,
    detail: sliceText(input.reason, 400),
    questions: [],
    expiresAt,
    timeoutDefault,
  };
}

export function presentLiveStageInteraction(state: LiveStageState, interaction: LiveStageInteraction): LiveStageState {
  return { ...state, interaction, revision: state.revision + 1 };
}

export function dismissLiveStageInteraction(state: LiveStageState, requestId: string): LiveStageState {
  if (!state.interaction || state.interaction.requestId !== requestId) return state;
  return { ...state, interaction: null, revision: state.revision + 1 };
}
