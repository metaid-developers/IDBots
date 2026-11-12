/**
 * Assistant-mode activity indicator phrase pools + event-derived status lines
 * — the renderer half of the bubble-phase display upgrade.
 *
 * Revision 2 (owner feedback 2026-11-11, session b817372f): revision 1's
 * fallback pool rotated on a 3s timer, and it contained completion-flavored
 * words ("马上就好…", "还有一小会儿…") plus warm-up theater ("正在热身…").
 * A 429-storm session surfaced both flaws: every auto-resume splice breaks
 * the runtime-status tail run, the renderer fell through to the rotating
 * pool, and the owner watched "热身/蓄力" loop like a recording while the
 * Studio right pane already showed the projected HTML. Rules now:
 *
 *   - NO TIMER ROTATION anywhere. Every phase draws ONE phrase per instance
 *     (keyed by session + phase + the runtime-status/tool message id) and
 *     holds it until the phase instance changes; a full pool cycle never
 *     repeats (shuffle bag per rotation scope).
 *   - COMPLETION WORDS live ONLY in the writing pool (phrases shown while
 *     reply text is actually streaming — the one state where "收尾/almost
 *     done" is honest). No other pool may carry them.
 *   - PHASE-ACCURATE pools, one per real working state: thinking, writing,
 *     working (tool with its own object), coordinating (delegation via
 *     worker tools / live subagent events), projecting (the artifact already
 *     on the big screen), digesting (tool result landed, next step not yet
 *     in flight), resuming (auto-resume after a provider interruption),
 *     retry lead-ins, and a minimal continue fallback.
 *
 * Pure and dependency-free so it is unit-testable in plain Node.
 */

export type AssistantStatusLanguage = 'zh' | 'en';

/**
 * Owner-approved pools (zh originals 2026-11-11; en mirrors the same voice).
 * Sizes stay small on purpose: phrases are STABLE per phase instance now, so
 * a human reads one phrase per state change, not a carousel — variety comes
 * from state changes, not from re-rolling.
 */
export const ASSISTANT_THINKING_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在思考…',
    '正在琢磨…',
    '正在理思路…',
    '正在认真想…',
    '正在推敲细节…',
    '正在消化你的问题…',
  ],
  en: [
    'Thinking…',
    'Pondering…',
    'Sorting out the approach…',
    'Thinking it through…',
    'Weighing the details…',
    'Digesting your question…',
  ],
};

/**
 * Shown while visible reply text is actually streaming — the ONLY pool where
 * completion-flavored wording is allowed ("收尾" is honest here: text is on
 * screen and the turn is wrapping up).
 */
export const ASSISTANT_WRITING_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在输出中…',
    '正在写回复…',
    '正在组织语言…',
    '正在把结果写出来…',
    '正在收尾总结…',
    '正在写出最终结果…',
  ],
  en: [
    'Writing the reply…',
    'Putting it into words…',
    'Composing the answer…',
    'Writing it up…',
    'Wrapping up the summary…',
    'Writing the final result…',
  ],
};

/** Lead-in for the retry line; the counter is appended by buildRetryStatusLine. */
export const ASSISTANT_RETRY_LEAD_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '网络有点慢',
    '连接不太稳',
    '服务响应慢了',
    '网络开小差了',
    '连接抖了一下',
    '通道有点堵',
  ],
  en: [
    'The network is a bit slow',
    'The connection is wobbly',
    'The service is slow to respond',
    'The network hiccuped',
    'The link jitters',
    'The channel is congested',
  ],
};

/** Generic tool work when the specific tool has no nameable object. */
export const ASSISTANT_WORK_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在使用工具…',
    '正在动手处理…',
    '正在一步步推进…',
    '正在执行任务…',
    '正在处理细节…',
    '正在埋头苦干…',
  ],
  en: [
    'Working with a tool…',
    'Getting hands-on…',
    'Stepping through it…',
    'Executing the task…',
    'Handling the details…',
    'Heads-down at work…',
  ],
};

/** Delegation: worker tools in flight, or live subagent events on the channel. */
export const ASSISTANT_COORDINATE_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在和其他 Bot 沟通…',
    '正在协调分身执行…',
    '正在给协作 Bot 派活…',
    '正在跟进协作进度…',
  ],
  en: [
    'Coordinating with other bots…',
    'Directing the subagent…',
    'Handing work to a partner bot…',
    'Following up on the delegation…',
  ],
};

/**
 * The deliverable is ALREADY on the big screen (bot_browser_preview_local
 * landed) and the turn keeps running — the status must acknowledge what the
 * owner can see, never fall back to generic waiting words (session b817372f:
 * the Studio right pane showed the HTML while the left rotated "热身").
 */
export const ASSISTANT_PROJECTED_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '成品已投屏，正在继续完善…',
    '大屏已在展示，正在打磨细节…',
    '投屏已更新，正在补充后续内容…',
  ],
  en: [
    'Draft is on the big screen — refining…',
    'The stage is showing the result; polishing details…',
    'Projection updated — adding the finishing touches…',
  ],
};

/** Tool result landed, next LLM step not yet in flight — the inter-step gap. */
export const ASSISTANT_DIGEST_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在消化刚才的结果…',
    '正在核对拿到的东西…',
    '正在衔接下一步…',
    '正在整理阶段性进展…',
  ],
  en: [
    'Digesting the last result…',
    'Checking what came back…',
    'Setting up the next step…',
    'Sorting the progress so far…',
  ],
};

/** Auto-resume after a provider interruption splice — honest recovery copy. */
export const ASSISTANT_RESUME_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在从刚才的中断里恢复…',
    '正在接着刚才的进度继续…',
    '正在重新拉起任务…',
  ],
  en: [
    'Picking up from the interruption…',
    'Continuing where it left off…',
    'Relaunching the task…',
  ],
};

/**
 * Cold-start fallback (no runtime signal at all yet). Deliberately tiny and
 * neutral — no warm-up theater, no completion promises; this state lasts
 * seconds before the goal headline or the requesting marker lands.
 */
export const ASSISTANT_CONTINUE_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在继续处理…',
    '正在推进…',
  ],
  en: [
    'Continuing to work…',
    'Making progress…',
  ],
};

const GENERIC_FALLBACK: Record<AssistantStatusLanguage, string> = {
  zh: '正在处理…',
  en: 'Working on it…',
};

/** Draw bags keyed by caller scope (draw without replacement). */
const bagsByKey = new Map<string, string[]>();

/** One stable phrase per instance key, so re-renders never re-roll. */
const phraseByKey = new Map<string, string>();

const MAX_REMEMBERED_DRAWS = 128;

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function drawFromBag(bagKey: string, pool: readonly string[]): string {
  let bag = bagsByKey.get(bagKey);
  if (!bag || bag.length === 0) {
    bag = shuffle([...pool]);
    bagsByKey.set(bagKey, bag);
  }
  return bag.shift() as string;
}

/**
 * Stable draw for one status-line instance. `key` identifies the INSTANCE
 * (session + phase + runtime-status/tool message id): the first call draws
 * from the bag, every later call for the same key returns the remembered
 * phrase — a phase holds one wording for its whole lifetime (no timer
 * re-roll, ever). `bagScope` identifies the ROTATION scope (session +
 * language + phase NAME): consecutive instances of one phase draw from the
 * same bag, so pool-size consecutive instances never repeat a phrase.
 */
export function drawAssistantStatusPhrase(input: {
  key: string;
  bagScope: string;
  pool: readonly string[];
  language: AssistantStatusLanguage;
}): string {
  const remembered = phraseByKey.get(input.key);
  if (remembered !== undefined) {
    return remembered;
  }
  const pool = input.pool.length > 0 ? input.pool : [];
  const phrase = pool.length > 0
    ? drawFromBag(`${input.bagScope}|${input.language}`, pool)
    : GENERIC_FALLBACK[input.language];
  if (phraseByKey.size >= MAX_REMEMBERED_DRAWS) {
    const oldest = phraseByKey.keys().next().value;
    if (oldest !== undefined) {
      phraseByKey.delete(oldest);
    }
  }
  phraseByKey.set(input.key, phrase);
  return phrase;
}

/** Test seam: forget drawn phrases (and optionally drop every bag). */
export function resetAssistantStatusDrawing(key?: string, dropBags = false): void {
  if (key !== undefined) {
    phraseByKey.delete(key);
  } else {
    phraseByKey.clear();
  }
  if (dropBags) {
    bagsByKey.clear();
  }
}

/** UTF-16-unit prefix cut that never splits a surrogate pair. */
function truncateUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function firstString(input: Record<string, unknown> | undefined, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

const READ_TOOLS = new Set(['read', 'read_image', 'view', 'notebook_read']);
const WRITE_TOOLS = new Set([
  'write', 'edit', 'multi_edit', 'str_replace_editor', 'str_replace_based_edit_tool',
  'notebook_edit', 'create_file',
]);
const SEARCH_SESSION_TOOLS = new Set([
  'conversation_search', 'idbots_session_read_all', 'idbots_session_read_latest', 'session_search',
]);
const PROJECT_TOOL = 'bot_browser_preview_local';

type ProjectionStatusMessage = {
  type: string;
  metadata?: {
    toolName?: string;
    toolUseId?: string | null;
    isError?: boolean;
    origin?: string;
    sourceChannel?: string;
  };
};

/** Return the latest successful projection in the current owner turn. */
export function findCurrentTurnProjection(messages: readonly ProjectionStatusMessage[]): string | null {
  let turnStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const origin = message.metadata?.origin;
    if (message.type === 'user'
      && message.metadata?.sourceChannel !== 'idbots_cross_session'
      && (!origin || origin === 'user' || origin === 'quick_action')) {
      turnStart = index + 1;
      break;
    }
  }
  const successfulResultIds = new Set<string>();
  for (let index = turnStart; index < messages.length; index += 1) {
    const message = messages[index];
    const id = message.metadata?.toolUseId;
    if (message.type === 'tool_result' && message.metadata?.isError !== true && typeof id === 'string') {
      successfulResultIds.add(id);
    }
  }
  for (let index = messages.length - 1; index >= turnStart; index -= 1) {
    const message = messages[index];
    const id = message.metadata?.toolUseId;
    if (message.type === 'tool_use'
      && message.metadata?.toolName === PROJECT_TOOL
      && typeof id === 'string'
      && successfulResultIds.has(id)) {
      return id;
    }
  }
  return null;
}

const COORDINATE_TOOLS = new Set([
  'local_worker_delegate', 'worker_delegate', 'twin_task_create', 'send_group_message',
]);
const COORDINATE_STATUS_TOOLS = new Set(['twin_task_status', 'worker_status', 'twin_task_list']);
const TODO_TOOLS = new Set(['todo_write', 'todo_read', 'todowrite', 'todoread']);
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent']);
const MEMORY_TOOLS_PREFIX = 'memory_';
const KNOWLEDGE_TOOLS_PREFIX = 'knowledge_';
const SKILL_TOOLS_PREFIX = 'skill';
const DELEGATE_TOOLS = new Set(['task', 'agent', 'subagent', 'spawn_agent', 'agent_team']);
const ONCHAIN_TOOLS = new Set(['omni_read', 'mrc721_collection_create', 'mrc721_mint', 'mrc721_transfer']);
const WEB_TOOL_SET = new Set(['web_search', 'webfetch', 'web_fetch', 'open_url', 'browser_navigate']);
const BROWSER_TOOLS_PREFIXES = ['mcp__playwright', 'browser_', 'bot_browser_'];

const MAX_OBJECT_CHARS = 32;

function matchesBrowserTool(name: string): boolean {
  return BROWSER_TOOLS_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Event-derived status for a pending tool call — the specific "what is it
 * doing right now" line. `null` when nothing specific can be said (unknown
 * tool without a usable object): the caller falls back to the generic work
 * pool. The object (command head / file name / query) is the informative
 * part; the phrasing stays conversational on purpose.
 */
export function describeToolUseStatus(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  language: AssistantStatusLanguage,
): string | null {
  const name = (toolName ?? '').toLowerCase();
  if (!name) return null;
  const zh = language === 'zh';
  const clip = (text: string): string => truncateUnits(oneLine(text), MAX_OBJECT_CHARS);
  const objectOf = (): string => clip(firstString(toolInput, ['query', 'pattern', 'url', 'file_path', 'path', 'command', 'target']));

  if (name === PROJECT_TOOL) {
    return zh ? '正在投屏到大屏…' : 'Projecting to the big screen…';
  }
  if (COORDINATE_TOOLS.has(name)) {
    return zh ? '正在委派 Bot 协作…' : 'Delegating to a partner bot…';
  }
  if (COORDINATE_STATUS_TOOLS.has(name)) {
    return zh ? '正在跟进协作进度…' : 'Checking on the delegation…';
  }
  if (SHELL_TOOLS.has(name)) {
    const command = firstString(toolInput, ['command']);
    if (!command) return zh ? '正在执行命令…' : 'Running a command…';
    return zh ? `正在执行：${clip(command)}` : `Running: ${clip(command)}`;
  }
  if (READ_TOOLS.has(name)) {
    const file = basenameOf(firstString(toolInput, ['file_path', 'path']) || '');
    return file
      ? (zh ? `正在查看 ${file}` : `Reading ${file}`)
      : (zh ? '正在查看文件…' : 'Reading a file…');
  }
  if (WRITE_TOOLS.has(name)) {
    const file = basenameOf(firstString(toolInput, ['file_path', 'path']) || '');
    return file
      ? (zh ? `正在修改 ${file}` : `Editing ${file}`)
      : (zh ? '正在改写文件…' : 'Editing a file…');
  }
  if (SEARCH_SESSION_TOOLS.has(name)) {
    const query = firstString(toolInput, ['query', 'sessionId']);
    return query
      ? (zh ? `正在翻找会话：${clip(query)}` : `Searching chats: ${clip(query)}`)
      : (zh ? '正在翻找会话记录…' : 'Searching past chats…');
  }
  if (matchesBrowserTool(name)) {
    if (name.includes('screenshot')) {
      return zh ? '正在截屏核对效果…' : 'Taking a check-up screenshot…';
    }
    const target = firstString(toolInput, ['query', 'url']);
    return target
      ? (zh ? `正在操作浏览器：${clip(target)}` : `Using the browser: ${clip(target)}`)
      : (zh ? '正在操作浏览器…' : 'Using the browser…');
  }
  if (WEB_TOOL_SET.has(name)) {
    const target = firstString(toolInput, ['query', 'url']);
    if (name === 'web_search') {
      return target
        ? (zh ? `正在网上查：${clip(target)}` : `Web search: ${clip(target)}`)
        : (zh ? '正在网上查资料…' : 'Searching the web…');
    }
    return target
      ? (zh ? `正在打开网页：${clip(target)}` : `Opening: ${clip(target)}`)
      : (zh ? '正在打开网页…' : 'Opening a page…');
  }
  if (TODO_TOOLS.has(name)) {
    return zh ? '正在更新任务清单' : 'Updating the task list';
  }
  if (ONCHAIN_TOOLS.has(name)) {
    return zh ? '正在读链上数据…' : 'Reading on-chain data…';
  }
  if (name.startsWith(MEMORY_TOOLS_PREFIX) || name.startsWith(KNOWLEDGE_TOOLS_PREFIX)) {
    return zh ? '正在查记忆和知识库…' : 'Checking memory & knowledge…';
  }
  if (name.startsWith(SKILL_TOOLS_PREFIX)) {
    return zh ? '正在调用能力…' : 'Invoking a capability…';
  }
  if (DELEGATE_TOOLS.has(name)) {
    return zh ? '正在派遣分身协作…' : 'Delegating to subagents…';
  }
  // owner_update and projection_begin are host bookkeeping calls: their
  // visible output is the narration bubble / the projected page itself, so
  // they never drive the pending-tool status line (and never reach this
  // function — the indicator's scan skips them upstream).
  // Unknown tool with a usable object: still name the object conversationally.
  const object = objectOf();
  if (object) {
    return zh ? `正在处理：${object}` : `Working on: ${object}`;
  }
  return null;
}

/**
 * The auto-resume splice the runner inserts after a provider-death turn.
 * Matched loosely (host copy, EN source) — a user message starting a turn
 * with this frame is a RESUME, not a human reply.
 */
export function isResumeSpliceContent(content: string): boolean {
  const text = (content ?? '').trim();
  if (!text) return false;
  return /interrupted by a transient network or provider failure/i.test(text)
    || /Continue the task from where you left off/i.test(text);
}

/**
 * The retry line — the counter is the whole point (session 42b6a16d: 15
 * invisible retries over 7m45s read as silence). `attempt`/`max` come from
 * the api_retry runtime-status payload; nulls degrade gracefully.
 */
export function buildRetryStatusLine(input: {
  attempt: number | null;
  max: number | null;
  language: AssistantStatusLanguage;
  bagKey: string;
}): string {
  const zh = input.language === 'zh';
  const lead = drawAssistantStatusPhrase({
    key: `retry-lead:${input.bagKey}`,
    bagScope: `retry:${input.bagKey}`,
    pool: ASSISTANT_RETRY_LEAD_POOLS[input.language],
    language: input.language,
  });
  if (input.attempt != null && input.max != null && input.max > 0) {
    return zh ? `${lead}，正在重试（第 ${input.attempt}/${input.max} 次）…`
      : `${lead}; retrying (attempt ${input.attempt}/${input.max})…`;
  }
  if (input.attempt != null) {
    return zh ? `${lead}，正在重试（第 ${input.attempt} 次）…`
      : `${lead}; retrying (attempt ${input.attempt})…`;
  }
  return zh ? `${lead}，正在重试…` : `${lead}; retrying…`;
}

/**
 * Elapsed suffix for WAITING phases (goal headline / thinking) — the counter
 * starts only after 8s so short phases never flicker numbers. zh reads "· 已
 * 45 秒"; en reads "· 45s".
 */
export function formatWaitSuffix(elapsedMs: number, language: AssistantStatusLanguage): string {
  if (elapsedMs < 8_000) return '';
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (language === 'zh') {
    if (totalSeconds < 60) return ` · 已 ${totalSeconds} 秒`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? ` · 已 ${minutes} 分 ${seconds} 秒` : ` · 已 ${minutes} 分钟`;
  }
  if (totalSeconds < 60) return ` · ${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? ` · ${minutes}m${seconds}s` : ` · ${minutes}m`;
}
