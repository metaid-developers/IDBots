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
  /**
   * Epoch ms when this turn's state was created. The persistent stage page
   * uses it to order turns: a patch for a different turnId is accepted only
   * when its turnStartedAt is newer, so a delayed old-turn patch can never
   * overwrite a newer turn.
   */
  turnStartedAt: number;
  revision: number;
  enabled: boolean;
  family: LiveStageFamily;
  botName: string;
  /** Twin avatar as an https URL or a stage-relative `avatars/<hash>.<ext>` path; absent → fallback avatar. */
  botAvatar?: string;
  /** Showcase URI of the projected report; the stage's report button opens it. */
  reportUri?: string | null;
  language: 'zh' | 'en';
  /** Localized label shown above the headline; the raw family id never reaches the owner. */
  kicker: string;
  headline: string;
  caption: string;
  /**
   * 'specific' when headline/caption came from real message content (speech,
   * owner request, tool activity, error copy); 'default' when they are the
   * family fallback. The Director may only rewrite 'default' captions.
   */
  captionSource: 'default' | 'specific';
  /** Epoch ms when the current family began; the stage renders elapsed time from it. */
  phaseStartedAt: number;
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
  botAvatar?: string;
  language: 'zh' | 'en';
  directorEnabled?: boolean;
  nowMs?: number;
};

const text = (language: 'zh' | 'en', zh: string, en: string): string => language === 'zh' ? zh : en;

const TEAMMATE_FALLBACK: Record<'zh' | 'en', string> = { zh: '协作 Bot', en: 'a teammate' };

/** Localized kicker label per family; 'speaking' uses the bot name instead. */
const FAMILY_KICKER: Record<LiveStageFamily, { zh: string; en: string }> = {
  received: { zh: '收到', en: 'Received' },
  reasoning: { zh: '思考中', en: 'Thinking' },
  speaking: { zh: '', en: '' },
  'local-recall': { zh: '查阅资料', en: 'Looking things up' },
  'web2-research': { zh: '上网查找', en: 'Searching the web' },
  'metaweb-research': { zh: '查 AI 互联网', en: 'Searching MetaWeb' },
  making: { zh: '动手制作', en: 'Making' },
  delegation: { zh: '安排协作', en: 'Delegating' },
  waiting: { zh: '等待协作', en: 'Waiting on a teammate' },
  'worker-report': { zh: '协作回执', en: 'Teammate reported' },
  verification: { zh: '核对结果', en: 'Checking' },
  'browser-action': { zh: '操作大屏', en: 'On the big screen' },
  'owner-needed': { zh: '需要你决定', en: 'Needs you' },
  problem: { zh: '出了点问题', en: 'Problem' },
  'report-ready': { zh: '汇报就绪', en: 'Report ready' },
  complete: { zh: '已完成', en: 'Done' },
};

function sceneFor(
  family: LiveStageFamily,
  language: 'zh' | 'en',
  botName: string,
  workerName?: string,
): Pick<LiveStageState, 'headline' | 'caption' | 'kicker' | 'composition' | 'motif' | 'participants' | 'topology'> {
  const worker = workerName?.trim().slice(0, 80) || TEAMMATE_FALLBACK[language];
  const scenes: Record<LiveStageFamily, { headline: string; caption: string; participants: string[] }> = {
    received: { headline: text(language, '收到，我来处理', 'Got it — on it'), caption: text(language, '我来处理这件事。', 'On it.'), participants: [botName] },
    reasoning: { headline: text(language, '正在想怎么做', 'Thinking it through'), caption: '', participants: [botName] },
    speaking: { headline: text(language, '正在回复', 'Replying'), caption: '', participants: [botName] },
    'local-recall': { headline: text(language, '正在查阅相关资料', 'Looking through the material'), caption: '', participants: [botName] },
    'web2-research': { headline: text(language, '正在网上查找资料', 'Searching the web'), caption: '', participants: [botName] },
    'metaweb-research': { headline: text(language, '正在查 AI 互联网上的资料', 'Searching MetaWeb'), caption: '', participants: [botName] },
    making: { headline: text(language, '正在动手制作', 'Making it'), caption: '', participants: [botName] },
    delegation: { headline: text(language, `正在把任务交给 ${worker}`, `Handing the task to ${worker}`), caption: text(language, '它交回来后我会核对，再向你汇报。', "I'll check its work and report back."), participants: [botName, worker] },
    waiting: { headline: text(language, `${worker} 正在处理`, `${worker} is on it`), caption: text(language, '交回来后我会核对，再向你汇报。', "I'll check it and report to you when it's back."), participants: [botName, worker] },
    'worker-report': { headline: text(language, `${worker} 交回了结果`, `${worker} reported back`), caption: text(language, '我正在核对，确认无误再向你汇报。', "I'm checking it now and will report once it's confirmed."), participants: [botName, worker] },
    verification: { headline: text(language, '正在核对结果', 'Checking the result'), caption: text(language, '确认真的做对了再向你汇报。', "I'll only report back once it's verified."), participants: [botName] },
    'browser-action': { headline: text(language, '正在大屏上操作', 'Working on the big screen'), caption: '', participants: [botName] },
    'owner-needed': { headline: text(language, '需要你做个决定', 'I need a decision from you'), caption: text(language, '在你回答之前我先停在这里。', "I'm paused here until you weigh in."), participants: [botName] },
    problem: { headline: text(language, '这一轮没能完成', "This run didn't finish"), caption: text(language, '说「继续」我就接着做。', 'Say "continue" and I\'ll pick it up.'), participants: [botName] },
    'report-ready': { headline: text(language, '汇报已投到大屏', 'The report is on the big screen'), caption: text(language, '汇报在旁边的标签页里，这里继续显示现场。', 'The report is in the next tab; this live view stays here.'), participants: [botName] },
    complete: { headline: text(language, '这一轮做完了', 'Done for this round'), caption: text(language, '完整记录保留在左侧对话里。', 'The full transcript stays on the left.'), participants: [botName] },
  };
  const scene = scenes[family];
  const structured = family === 'delegation' || family === 'waiting' || family === 'worker-report' || family === 'verification' || family === 'browser-action';
  // Only nodes that correspond to something real may appear: the twin, a
  // worker bot that was actually dispatched, the check the twin runs, or the
  // big screen it operates. No decorative "source" nodes.
  const hasWorker = typeof workerName === 'string' && workerName.trim().length > 0;
  const nodes: LiveStageState['topology']['nodes'] = structured ? (() => {
    const twin = { id: 'twin', label: botName, kind: 'twin' as const };
    switch (family) {
      case 'delegation':
      case 'waiting':
      case 'worker-report':
        return [twin, { id: 'worker', label: worker, kind: 'worker' as const }];
      case 'verification':
        return [
          twin,
          ...(hasWorker ? [{ id: 'worker', label: worker, kind: 'worker' as const }] : []),
          { id: 'evidence', label: text(language, '核对', 'Check'), kind: 'evidence' as const },
        ];
      case 'browser-action':
        return [twin, { id: 'source', label: text(language, '大屏', 'Big screen'), kind: 'source' as const }];
      default:
        return [];
    }
  })() : [];
  const edges: LiveStageState['topology']['edges'] = structured ? (() => {
    switch (family) {
      case 'delegation':
      case 'waiting':
        return [['twin', 'worker']];
      case 'worker-report':
        return [['worker', 'twin']];
      case 'verification':
        return [...(hasWorker ? [['twin', 'worker'], ['worker', 'evidence']] : []), ['evidence', 'twin']] as Array<[string, string]>;
      case 'browser-action':
        return [['twin', 'source'], ['source', 'twin']];
      default:
        return [];
    }
  })() : [];
  return {
    ...scene,
    // The participants block lists collaborators only (the stage drops the
    // twin's own entry): a verification names the worker when one exists.
    participants: family === 'verification' && hasWorker ? [botName, worker] : scene.participants,
    kicker: family === 'speaking' ? botName : FAMILY_KICKER[family][language],
    composition: family === 'verification' ? 'converge' : structured ? 'topology' : family === 'local-recall' || family === 'web2-research' || family === 'metaweb-research' ? 'gather' : family === 'report-ready' || family === 'complete' ? 'ready' : 'presence',
    motif: family,
    topology: {
      mode: structured ? 'structured' : 'presence',
      nodes,
      edges,
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
  const nowMs = context.nowMs ?? Date.now();
  return {
    protocol: LIVE_STAGE_PROTOCOL,
    sessionId: context.sessionId,
    turnId: context.turnId,
    turnStartedAt: nowMs,
    revision: 0,
    enabled: true,
    family: 'received',
    botName: context.botName,
    ...(context.botAvatar ? { botAvatar: context.botAvatar } : {}),
    language: context.language,
    ...scene,
    captionSource: 'default',
    phaseStartedAt: nowMs,
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
  if (name === 'read' || name === 'read_image' || name === 'glob' || name === 'grep' || name === 'bash' || name === 'shell' || name === 'conversation_search' || name.startsWith('idbots_session_read') || name.startsWith('longterm_') || name.startsWith('memory_') || name.startsWith('knowledge_')) return 'local-recall';
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

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value);

/** First sentence-ending punctuation index (inclusive), or -1. */
const SENTENCE_END = /[。！？!?…]|\.(?=\s|$)/;
const SENTENCE_END_ALL = /[。！？!?…]|\.(?=\s|$)/g;

const firstSentenceEnd = (text: string): number => {
  const match = SENTENCE_END.exec(text);
  return match ? match.index : -1;
};

/** Last sentence-ending punctuation index inside the first `limit` chars, or -1. */
const sentenceEnd = (text: string, limit: number): number => {
  const window = text.slice(0, limit);
  let best = -1;
  for (const match of window.matchAll(SENTENCE_END_ALL)) best = (match.index ?? 0);
  return best;
};

/**
 * Reduce one assistant bubble to stage copy: markdown is stripped to plain
 * prose, the first sentence becomes the headline (≤90 chars) and the rest
 * becomes the caption (≤200 chars, cut at a sentence boundary).
 */
export function liveStageSpeechCopy(markdown: string): { headline: string; caption: string } | null {
  const plain = markdownToPlainText(markdown);
  if (!plain) return null;
  const end = firstSentenceEnd(plain);
  let headline: string;
  let rest: string;
  if (end >= 0) {
    headline = clip(plain.slice(0, end + 1), 90);
    rest = plain.slice(end + 1).trimStart();
  } else {
    headline = clip(plain, 90);
    rest = plain.slice(headline.length).trimStart();
  }
  let caption = '';
  if (rest) {
    if (rest.length <= 200) {
      caption = rest;
    } else {
      const cut = sentenceEnd(rest, 200);
      caption = cut > 0 ? `${rest.slice(0, cut + 1)}…` : clip(rest, 200);
    }
  }
  return { headline, caption };
}

/** Strip markdown to plain prose for stage display (no raw syntax on the projector). */
export function markdownToPlainText(markdown: string): string {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>+\s?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\|[^\n]*\|\s*$/gm, ' ')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const firstSentence = (value: string, max: number): string => {
  const plain = value.replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  const end = firstSentenceEnd(plain);
  return end >= 0 ? clip(plain.slice(0, end + 1), max) : clip(plain, max);
};

const pathBaseName = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base || normalized;
};

const inputPath = (input: Record<string, unknown>): string =>
  pathBaseName(input.path) || pathBaseName(input.file_path) || pathBaseName(input.filePath) || pathBaseName(input.target_file) || pathBaseName(input.notebook_path);

/**
 * Owner-facing description of one tool call, in plain words — never raw
 * commands, paths, or arguments. Returns null for tools without a dedicated
 * line so the family default copy stays in charge.
 */
export function describeLiveStageActivity(
  toolName: string,
  toolInput: unknown,
  language: 'zh' | 'en',
  workerName?: string,
): { headline: string; caption?: string } | null {
  const name = (toolName || '').toLowerCase();
  if (!name) return null;
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : {};
  const worker = workerName?.trim().slice(0, 80) || TEAMMATE_FALLBACK[language];
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

  if (name === 'bash' || name === 'shell') {
    const description = str(input.description);
    return {
      headline: text(language, '正在电脑上处理', 'Working on the computer'),
      ...(description && description.length <= 120 ? { caption: description } : {}),
    };
  }
  if (name === 'read' || name === 'read_image') {
    const base = inputPath(input);
    return { headline: text(language, `正在查看 ${base || '文件'}`, `Reading ${base || 'a file'}`) };
  }
  if (name === 'write' || name === 'edit') {
    const base = inputPath(input);
    return { headline: text(language, `正在编写 ${base || '文件'}`, `Writing ${base || 'a file'}`) };
  }
  if (name.includes('web_search') || name.includes('websearch')) {
    const query = clip(str(input.query), 32);
    return { headline: text(language, `正在网上查${query ? `：${query}` : ''}`, `Searching the web${query ? `: ${query}` : ''}`) };
  }
  if (name === 'web_fetch' || name === 'fetch_url') {
    return { headline: text(language, '正在打开网页', 'Opening a web page') };
  }
  if (name === 'conversation_search' || name.startsWith('idbots_session_read')) {
    return { headline: text(language, '正在翻看以前的聊天记录', 'Looking through past chats') };
  }
  if (name.startsWith('memory_') || name.startsWith('knowledge_')) {
    return { headline: text(language, '正在回想相关的记忆', 'Recalling what I know') };
  }
  if (name === 'local_worker_delegate') {
    const objective = firstSentence(str(input.objective ?? input.task ?? input.description), 80);
    return {
      headline: text(language, `正在把任务交给 ${worker}`, `Handing the task to ${worker}`),
      ...(objective ? { caption: objective } : {}),
    };
  }
  if (name === 'twin_task_status') {
    return { headline: text(language, `正在看 ${worker} 的进度`, `Checking ${worker}'s progress`) };
  }
  if (name === 'twin_task_accept') {
    return { headline: text(language, `正在验收 ${worker} 的成果`, `Reviewing ${worker}'s work`) };
  }
  if (name === 'bot_browser_preview_local') {
    return input.projection === true
      ? { headline: text(language, '正在把汇报投到大屏', 'Projecting the report') }
      : { headline: text(language, '正在大屏上打开预览', 'Opening a preview on the big screen') };
  }
  if (name.startsWith('bot_browser_')) {
    return { headline: text(language, '正在大屏上操作', 'Working on the big screen') };
  }
  if (name === 'upload_file') {
    return { headline: text(language, '正在把文件传到链上', 'Uploading a file to the chain') };
  }
  if (name.startsWith('omni_') || name.includes('metaweb') || name.includes('metaapp')) {
    return { headline: text(language, '正在查 AI 互联网', 'Searching MetaWeb') };
  }
  return null;
}

/**
 * Apply a streaming assistant update to the speaking scene. Only non-empty
 * prose moves the stage; the same markdown→headline/caption rules as
 * reduceLiveStageMessage apply so streamed and final text agree.
 */
export function applyLiveStageSpeech(state: LiveStageState, content: string, nowMs = Date.now()): LiveStageState {
  const speech = liveStageSpeechCopy(content);
  if (!speech) return state;
  const familyChanged = state.family !== 'speaking';
  const scene = sceneFor('speaking', state.language, state.botName);
  return {
    ...state,
    ...scene,
    headline: speech.headline,
    caption: speech.caption,
    captionSource: 'specific',
    family: 'speaking',
    handoff: null,
    phaseStartedAt: familyChanged ? nowMs : state.phaseStartedAt,
    revision: state.revision + 1,
    eventWindow: [...state.eventWindow, { family: 'speaking' as const }].slice(-8),
  };
}

export function reduceLiveStageMessage(
  state: LiveStageState,
  message: CoworkMessage,
  options: { workerName?: string; workerAvatar?: string; nowMs?: number } = {},
): LiveStageState {
  const nowMs = options.nowMs ?? Date.now();
  const metadata = message.metadata as Record<string, unknown> | undefined;
  // Host projection receipts are bookkeeping bubbles, not the bot speaking.
  if (metadata?.projectorReport) return state;
  let family = state.family;
  let headline: string | undefined;
  let caption: string | undefined;
  let captionSource: 'default' | 'specific' = 'default';
  let pendingProjectionIds = state.pendingProjectionIds;
  if (message.type === 'user') {
    family = isLiveStageWorkerReport(message) ? 'worker-report' : 'received';
    if (family === 'received') {
      const request = String(message.content ?? '').replace(/\s+/g, ' ').trim();
      if (request) {
        caption = clip(state.language === 'zh' ? `「${request}」` : `“${request}”`, 80);
        captionSource = 'specific';
      }
    }
  } else if (message.type === 'assistant') {
    if (message.metadata?.isThinking) {
      family = 'reasoning';
    } else {
      const speech = liveStageSpeechCopy(message.content);
      if (speech) {
        family = 'speaking';
        headline = speech.headline;
        caption = speech.caption || undefined;
        captionSource = 'specific';
      }
      // An assistant bubble without visible text carries no narration; the
      // scene stays where the previous event left it until content arrives.
    }
  } else if (message.type === 'system') {
    if (message.metadata?.sdkRuntimeStatus === 'api_retry') {
      family = 'reasoning';
      const attempt = typeof metadata?.retryAttempt === 'number' && Number.isFinite(metadata.retryAttempt)
        ? Math.max(1, Math.trunc(metadata.retryAttempt))
        : null;
      headline = state.language === 'zh'
        ? `连接不太稳，正在重试${attempt ? `（第 ${attempt} 次）` : ''}`
        : `Connection is shaky — retrying${attempt ? ` (attempt ${attempt})` : ''}`;
    } else if (message.metadata?.sdkRuntimeStatus === 'requesting') {
      family = 'reasoning';
    }
  } else if (message.type === 'tool_use') {
    const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : '';
    const toolInput = message.metadata?.toolInput && typeof message.metadata.toolInput === 'object' && !Array.isArray(message.metadata.toolInput)
      ? message.metadata.toolInput as Record<string, unknown>
      : {};
    // owner_update narration reaches the stage through the assistant bubble
    // that follows it, and projection_begin is host plumbing — neither moves
    // the scene on its own.
    if (toolName !== 'owner_update' && toolName !== 'projection_begin') {
      family = familyForTool(toolName) ?? state.family;
      const workerName = options.workerName ?? (state.topology.mode === 'structured'
        ? state.topology.nodes.find((node) => node.kind === 'worker')?.label
        : undefined);
      const activity = describeLiveStageActivity(toolName, toolInput, state.language, workerName);
      if (activity) {
        headline = activity.headline;
        if (activity.caption) {
          caption = activity.caption;
          captionSource = 'specific';
        }
      }
    }
    if (toolName === 'bot_browser_preview_local' && toolInput.projection === true) {
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
  if (state.interaction) {
    family = 'owner-needed';
    headline = undefined;
    caption = undefined;
    captionSource = 'default';
  }
  // The effective worker is the freshly reported one, else the worker already
  // on the structured topology — sceneFor needs it to decide which nodes are
  // real (a verification only shows a worker that was actually dispatched).
  const workerLabel = options.workerName?.trim().slice(0, 80)
    || (state.topology.mode === 'structured' ? state.topology.nodes.find((node) => node.kind === 'worker')?.label : undefined);
  const workerAvatar = options.workerAvatar
    || (state.topology.mode === 'structured' ? state.topology.nodes.find((node) => node.kind === 'worker')?.avatar : undefined);
  const scene = sceneFor(family, state.language, state.botName, workerLabel);
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
  const familyChanged = family !== state.family;
  const handoffChanged = (handoff?.direction ?? null) !== (state.handoff?.direction ?? null)
    || (handoff?.eventId ?? null) !== (state.handoff?.eventId ?? null);
  // A message that produced no new family and no new copy (empty assistant
  // bubbles, bookkeeping tool results, owner_update/projection_begin) leaves
  // the stage exactly where it was — including any speech already on screen.
  if (!familyChanged && headline == null && caption == null
    && pendingProjectionIds === state.pendingProjectionIds && !handoffChanged) {
    return state;
  }
  // Same-family updates without fresh copy keep the visible headline/caption
  // (and whether the Director may restyle them) instead of reverting to the
  // family defaults.
  const keepCopy = !familyChanged && headline == null && caption == null;
  return {
    ...state,
    ...scene,
    headline: headline ?? (keepCopy ? state.headline : scene.headline),
    caption: caption ?? (keepCopy ? state.caption : scene.caption),
    captionSource: caption != null ? captionSource : (keepCopy ? state.captionSource : 'default'),
    phaseStartedAt: familyChanged ? nowMs : state.phaseStartedAt,
    revision: state.revision + 1,
    family,
    handoff,
    motion: { preset: family, seed: seedFor(state.sessionId, state.turnId, state.revision + 1), durationMs: 720, easing: 'emphasized-decelerate', energy: family === 'report-ready' || family === 'complete' ? .18 : family === 'verification' ? .55 : .4, density: scene.topology.mode === 'structured' ? .55 : .28 },
    pendingProjectionIds,
    eventWindow: [...state.eventWindow, eventSummary(message, family)].slice(-8),
  };
}

export function completeLiveStage(state: LiveStageState, nowMs = Date.now()): LiveStageState {
  if (state.family === 'report-ready') return state;
  const scene = sceneFor('complete', state.language, state.botName);
  // The bot's last words stay on screen when the turn ends mid-speech; the orb
  // rests but the headline/caption are not replaced by generic copy.
  const keepSpeech = state.family === 'speaking';
  return {
    ...state,
    ...scene,
    headline: keepSpeech ? state.headline : scene.headline,
    caption: keepSpeech ? state.caption : scene.caption,
    captionSource: keepSpeech ? state.captionSource : 'default',
    family: 'complete',
    handoff: null,
    phaseStartedAt: nowMs,
    revision: state.revision + 1,
    motion: { ...state.motion, preset: 'complete', energy: .12, durationMs: 600 },
  };
}

export function reportReadyLiveStage(state: LiveStageState, reportUri: string | null, nowMs = Date.now()): LiveStageState {
  const scene = sceneFor('report-ready', state.language, state.botName);
  return { ...state, ...scene, family: 'report-ready', reportUri, handoff: null, phaseStartedAt: nowMs, revision: state.revision + 1, pendingProjectionIds: [], motion: { ...state.motion, preset: 'report-ready', energy: .18, durationMs: 650 } };
}

export function liveStageError(state: LiveStageState, copy?: { headline: string; caption: string }, nowMs = Date.now()): LiveStageState {
  const scene = sceneFor('problem', state.language, state.botName);
  return {
    ...state,
    ...scene,
    headline: copy?.headline ?? scene.headline,
    caption: copy?.caption ?? scene.caption,
    captionSource: copy ? 'specific' : 'default',
    family: 'problem',
    handoff: null,
    phaseStartedAt: nowMs,
    revision: state.revision + 1,
    motion: { ...state.motion, preset: 'problem', energy: .25 },
  };
}

export type LiveStageDelegationWait = {
  workerName?: string;
  workerAvatar?: string;
  /** First delegation's title (owner intent), shown in the caption. */
  title?: string;
  /** Total open delegations; >1 renders "X 等 n 位" / "X and n-1 more". */
  total?: number;
  /** Earliest delegation start (epoch ms) — the elapsed clock measures from here. */
  startedAt?: number;
  nowMs?: number;
};

/**
 * Turn-complete-but-workers-still-running scene: structured topology with the
 * first worker's name/avatar, a bilingual multi-worker summary, and the
 * delegation's own start time as phaseStartedAt.
 */
export function waitingLiveStage(state: LiveStageState, wait: LiveStageDelegationWait): LiveStageState {
  const nowMs = wait.nowMs ?? Date.now();
  const language = state.language;
  const first = wait.workerName?.trim().slice(0, 80) || TEAMMATE_FALLBACK[language];
  const total = Math.max(1, Math.trunc(wait.total ?? 1));
  const others = total - 1;
  const workerLabel = others > 0
    ? (language === 'zh' ? `${first} 等 ${total} 位` : `${first} and ${others} more`)
    : first;
  const scene = sceneFor('waiting', language, state.botName, first);
  if (scene.topology.mode === 'structured') {
    scene.topology.nodes = scene.topology.nodes.map((node) => node.kind === 'worker'
      ? { ...node, label: workerLabel, ...(wait.workerAvatar ? { avatar: wait.workerAvatar } : {}) }
      : node);
    scene.participants = scene.participants.map((participant, index) => index === 1 ? workerLabel : participant);
  }
  const title = wait.title?.replace(/\s+/g, ' ').trim();
  const caption = title
    ? (language === 'zh'
      ? `${clip(title, 60)}。交回来后我会核对，再向你汇报。`
      : `${clip(title, 60)}. When it's back I'll check it and report to you.`)
    : scene.caption;
  return {
    ...state,
    ...scene,
    caption,
    captionSource: 'specific',
    family: 'waiting',
    handoff: null,
    phaseStartedAt: wait.startedAt ?? nowMs,
    revision: state.revision + 1,
    motion: { ...state.motion, preset: 'waiting', energy: .4, durationMs: 720 },
    eventWindow: [...state.eventWindow, { family: 'waiting' as const }].slice(-8),
  };
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
  requestId?: unknown;
  toolName?: unknown;
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

export function presentLiveStageInteraction(state: LiveStageState, interaction: LiveStageInteraction, nowMs = Date.now()): LiveStageState {
  const scene = sceneFor('owner-needed', state.language, state.botName);
  return {
    ...state,
    ...scene,
    family: 'owner-needed',
    interaction,
    phaseStartedAt: state.family === 'owner-needed' ? state.phaseStartedAt : nowMs,
    revision: state.revision + 1,
    handoff: null,
    motion: { ...state.motion, preset: 'owner-needed', energy: .12 },
  };
}

export function dismissLiveStageInteraction(state: LiveStageState, requestId: string): LiveStageState {
  if (!state.interaction || state.interaction.requestId !== requestId) return state;
  return { ...state, interaction: null, revision: state.revision + 1 };
}
