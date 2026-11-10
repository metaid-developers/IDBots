/**
 * Assistant-mode activity indicator phrase pools + event-derived status lines
 * — the renderer half of the bubble-phase display upgrade (owner-approved
 * 2026-11-10, session 42b6a16d follow-up: "几个词在轮换" reads as idle, and a
 * 7-minute invisible retry storm reads as silence).
 *
 * Three sources feed the status line, in the priority the indicator applies:
 *   1. EVENT-DERIVED (zero tokens): the newest runtime event names what is
 *      actually happening — a pending tool_use becomes "正在执行：pdftoppm
 *      -png 第 3 页…", an api_retry becomes "连接不太稳，第 3/8 次重试中…"
 *      (the retry counters already rode the sdkRuntimeStatus payload; the
 *      old wording deliberately hid them). The tone stays non-technical —
 *      objects and counts, never tool jargon or stack traces.
 *   2. LLM HEADLINE (tens of tokens/turn): the main process emits one
 *      progressive goal phrase per turn (`sdkRuntimeStatus: 'turnGoal'`).
 *      Pure rendering here — the pools only cover turns whose goal call
 *      failed or has not landed yet.
 *   3. PRESET POOLS (this file): the generic phases (thinking / writing /
 *      working / idle) rotate through 6-10 phrase pools via the same
 *      shuffle-bag contract as turnAckPhrases — no back-to-back repeats.
 *
 * Pure and dependency-free so it is unit-testable in plain Node.
 */

export type AssistantStatusLanguage = 'zh' | 'en';

/**
 * Owner-approved pools (zh originals 2026-11-10; en mirrors the same voice).
 * Sizes are deliberate: thinking and idle carry the most wall-clock time and
 * need the most ammunition; writing and retry leads rotate less.
 */
export const ASSISTANT_THINKING_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在思考…',
    '正在琢磨…',
    '正在理思路…',
    '正在打腹稿…',
    '正在认真想…',
    '正在推敲细节…',
    '正在消化你的问题…',
    '正在想怎么答…',
  ],
  en: [
    'Thinking…',
    'Pondering…',
    'Sorting out the approach…',
    'Drafting in my head…',
    'Thinking it through…',
    'Weighing the details…',
    'Digesting your question…',
    'Figuring out the answer…',
  ],
};

export const ASSISTANT_WRITING_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在输出中…',
    '正在写回复…',
    '正在敲字…',
    '正在组织语言…',
    '正在落笔…',
    '正在把结果写出来…',
  ],
  en: [
    'Writing the reply…',
    'Putting it into words…',
    'Typing it out…',
    'Composing the answer…',
    'Writing it up…',
    'Getting it down on paper…',
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

export const ASSISTANT_WORK_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在使用工具…',
    '正在动手处理…',
    '正在一步步推进…',
    '正在执行任务…',
    '正在处理细节…',
    '正在忙活…',
    '正在多手准备…',
    '正在埋头苦干…',
  ],
  en: [
    'Working with a tool…',
    'Getting hands-on…',
    'Stepping through it…',
    'Executing the task…',
    'Handling the details…',
    'Busy at work…',
    'Juggling a few things…',
    'Heads-down at work…',
  ],
};

export const ASSISTANT_IDLE_POOLS: Record<AssistantStatusLanguage, readonly string[]> = {
  zh: [
    '正在思考…',
    '正在查资料…',
    '正在整理结果…',
    '马上就好…',
    '还有一小会儿…',
    '发现了一些有趣的线索…',
    '正在整理思路…',
    '正在热身…',
    '正在蓄力…',
    '正在准备动手…',
  ],
  en: [
    'Thinking…',
    'Looking things up…',
    'Organizing results…',
    'Almost there…',
    'Just a little longer…',
    'Found some interesting leads…',
    'Sorting out my thoughts…',
    'Warming up…',
    'Gearing up…',
    'Getting ready to dig in…',
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
 * (session + phase + runtime-status message id): the first call draws from
 * the bag, every later call for the same key returns the remembered phrase —
 * a phase holds one wording for its whole lifetime (the "低改变频率"
 * requirement). `bagScope` identifies the ROTATION scope (session + language
 * + phase NAME): consecutive instances of one phase draw from the same bag,
 * so pool-size consecutive turns never repeat a phrase.
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
const SEARCH_SESSION_TOOLS = new Set(['conversation_search', 'idbots_session_read_all', 'session_search']);
const WEB_TOOLS = new Set(['web_search', 'webfetch', 'web_fetch', 'open_url', 'browser_navigate']);
const TODO_TOOLS = new Set(['todo_write', 'todo_read', 'todowrite', 'todoread']);
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent']);
const MEMORY_TOOLS_PREFIX = 'memory_';
const KNOWLEDGE_TOOLS_PREFIX = 'knowledge_';
const SKILL_TOOLS_PREFIX = 'skill';
const DELEGATE_TOOLS = new Set(['task', 'agent', 'subagent', 'spawn_agent', 'agent_team']);
const ONCHAIN_TOOLS = new Set(['omni_read', 'mrc721_collection_create', 'mrc721_mint', 'mrc721_transfer']);

const MAX_OBJECT_CHARS = 32;

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
  if (WEB_TOOLS.has(name)) {
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
  if (name === 'owner_update') {
    return zh ? '正在向你汇报进展…' : 'Posting a progress update…';
  }
  // Unknown tool with a usable object: still name the object conversationally.
  const object = objectOf();
  if (object) {
    return zh ? `正在处理：${object}` : `Working on: ${object}`;
  }
  return null;
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
