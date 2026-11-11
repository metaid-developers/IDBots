// LLM turn-acknowledgment reply — the turn's first bubble.
//
// The template phrase pools (renderer turnAckPhrases.ts) cover the instant
// 0-1s window inside the activity indicators, but the owner's requirement is
// a REAL assistant bubble, written by the LLM about THIS message, arriving
// while the kernel turn is still pre-flight or reasoning (first-response
// latency). This module holds the pure halves — prompt build and output
// sanitize — so they stay unit-testable under plain `node --test` without
// coworkUtil's electron-bearing import graph. It therefore stays
// dependency-free — including the UTF-16 truncate below, inlined from
// llmSafeText (electron-tsconfig forbids .ts-suffixed imports, so importing
// it here would break the plain-node test path).

/** Hard display cap: an ack is 1-2 sentences, never a paragraph. */
export const TURN_ACK_REPLY_MAX_CHARS = 160;

/** Shared wall-clock ceiling across primary, fallback, and one retry. */
export const TURN_ACK_TOTAL_BUDGET_MS = 6_000;

export function remainingTurnAckBudgetMs(startedAt: number, now = Date.now()): number {
  return Math.max(0, TURN_ACK_TOTAL_BUDGET_MS - Math.max(0, now - startedAt));
}

/**
 * CJK script detector for the ack language guard: ideographs (unified, ext-A,
 * compatibility) and kana. CJK punctuation (U+3000-U+303F, fullwidth forms)
 * is deliberately excluded — a lone "。" is not evidence the ack is in the
 * user's language.
 */
const CJK_SCRIPT_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** True when the text contains at least one CJK ideograph or kana character. */
export function containsCjk(text: string): boolean {
  return CJK_SCRIPT_RE.test(text ?? '');
}

/**
 * Meta-analysis markers betraying reasoning-style output ABOUT the message
 * instead of an acknowledgment addressed to the user. On 2026-10-23 an
 * always-thinking GLM-5.3 ack burned its budget on hidden reasoning; the
 * resolver promoted reasoning_content into content and a mid-thought English
 * fragment shaped like these markers leaked out as the ack bubble.
 */
const TURN_ACK_GENRE_MARKERS = [
  "the user's message",
  'the user is',
  'which means',
  'acknowledging something',
  'translates as',
] as const;

/** Input cap for the user-text slice sent to the ack model. */
const TURN_ACK_USER_TEXT_MAX_CHARS = 1200;

/** Input cap for the session-title context line. */
const TURN_ACK_TITLE_MAX_CHARS = 120;

/** UTF-16-unit prefix cut that never splits a surrogate pair (llmSafeText). */
function truncateUtf16UnitsSafe(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface TurnAckReplyInput {
  userText: string;
  sessionTitle?: string | null;
}

/**
 * Prompt messages for the one-shot ack call (pure). The system prompt is
 * English per the repo's prompt convention; the ack itself must come back in
 * the user's own language, which the prompt demands.
 *
 * Content contract (owner decision 2026-11-03, session 3ecd2a2f): the ack
 * NEVER answers the message — this call sees only the user text and the
 * session title (no local time, no memory, no conversation context), so any
 * substantive claim risks contradicting the real reply that follows (the ack
 * said "I can't determine today's date" while the main answer, riding the
 * local-time prompt, named the date). The ack acknowledges and sets
 * expectations (how it will be approached, roughly how long); only a pure
 * greeting gets a greeting back — that greeting carries no content to
 * contradict.
 */
export function buildTurnAckReplyMessages(
  input: TurnAckReplyInput
): Array<{ role: 'system' | 'user'; content: string }> {
  const userText = input.userText.trim();
  const title = (input.sessionTitle ?? '').trim();
  const titleLine = title ? `Session title: ${truncateUtf16UnitsSafe(title, TURN_ACK_TITLE_MAX_CHARS)}\n\n` : '';
  return [
    {
      role: 'system',
      content: [
        'You write the FIRST response a chat assistant sends to the user\'s just-arrived message; the full work or answer follows later.',
        'This line must sound like a real person replying in chat — the bot\'s own words about THIS message, never a canned service template. Vary your wording naturally; never produce boilerplate like "收到，我马上看" unless that is genuinely what you mean.',
        '- For a pure greeting or check-in ("在吗", "hi"), respond naturally as a person would — a greeting gets a greeting back; that greeting IS the whole first response.',
        '- For anything else, ONLY acknowledge and set expectations: say in plain words how you will approach it, and roughly whether it is quick or will take a while with progress updates.',
        '- NEVER answer the user\'s question or state any fact, opinion, guess, or conclusion about its content — not even when the question looks simple. You write without the conversation context, memory, or the current date/time, so any substantive claim can contradict the real reply that follows.',
        'Rules: 1-2 sentences, under 40 words. Same language as the user message. Do not solve the task or promise deadlines. No markdown, lists, quotes, emoji. Output only the finished text — never your thinking or reasoning about these rules.',
        "Never describe, analyze, translate, or quote the user's message; never mention what language it is in.",
      ].join('\n'),
    },
    {
      role: 'user',
      content: `${titleLine}User message:\n${truncateUtf16UnitsSafe(userText, TURN_ACK_USER_TEXT_MAX_CHARS)}`,
    },
  ];
}

/** Normalize a raw ack completion into display text ('' when unusable). */
export function sanitizeTurnAckReply(raw: string): string {
  let text = (raw ?? '')
    // Stray code fences despite the no-markdown rule.
    .replace(/```[a-zA-Z]*\r?\n?/g, '')
    .replace(/```/g, '')
    .trim();
  // Wrapping quotes the model may add anyway (same set as title sanitizing).
  text = text.replace(/^["'`«»「」『』]+|["'`«»「」『』]+$/g, '').trim();
  // One-line it: the ack renders as a single short bubble.
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= TURN_ACK_REPLY_MAX_CHARS) return text;
  const capped = truncateUtf16UnitsSafe(text, TURN_ACK_REPLY_MAX_CHARS);
  const lastStop = Math.max(
    capped.lastIndexOf('.'),
    capped.lastIndexOf('。'),
    capped.lastIndexOf('!'),
    capped.lastIndexOf('！'),
    capped.lastIndexOf('?'),
    capped.lastIndexOf('？')
  );
  // Keep the last complete sentence when one fits; otherwise hard-cap.
  const cut = lastStop > TURN_ACK_REPLY_MAX_CHARS * 0.5 ? lastStop + 1 : TURN_ACK_REPLY_MAX_CHARS;
  return capped.slice(0, cut).trimEnd();
}

export type TurnAckActivity = 'search_local' | 'verify_delivery' | 'working';

export function resolveTurnAckActivity(userText: string): TurnAckActivity {
  const text = userText ?? '';
  if (/\[ORCH-NOTIFY\]/i.test(text)) return 'verify_delivery';
  if (/本机|本地|local/i.test(text) && /搜|查找|search|find/i.test(text)) return 'search_local';
  return 'working';
}

/** Input cap for the user-text slice sent to the wait-update model. */
const OWNER_WAIT_USER_TEXT_MAX_CHARS = 1200;

/** Input cap for the session-title context line on the wait update. */
const OWNER_WAIT_TITLE_MAX_CHARS = 120;

export interface OwnerWaitUpdateInput {
  /** The turn's user message — language cue and topic context. */
  userText: string;
  sessionTitle?: string | null;
  /** How long the owner has been waiting without a visible message. */
  waitedMs: number;
  /** True while a tool/execution step is still running. */
  waitingForTool: boolean;
  /** How many wait updates this turn already sent (0 = first). */
  priorCount: number;
}

/**
 * Prompt messages for the one-shot owner wait update — the "still working"
 * heartbeat bubble (pure). Owner decision 2026-11-04: NO canned text anywhere
 * in bubbles — the old fixed heartbeat strings ("有一个执行步骤还在运行…") read
 * as a recording, so the wait line is written by the LLM in the bot's own
 * words, per fire, from the live wait context. Same output contract as the
 * turn ack: one short line, the user's language, sanitized through the shared
 * input-aware guard.
 */
export function buildOwnerWaitUpdateMessages(
  input: OwnerWaitUpdateInput
): Array<{ role: 'system' | 'user'; content: string }> {
  const userText = (input.userText ?? '').trim();
  const title = (input.sessionTitle ?? '').trim();
  const waitedMinutes = Math.max(1, Math.round(input.waitedMs / 60_000));
  const titleLine = title ? `Session title: ${truncateUtf16UnitsSafe(title, OWNER_WAIT_TITLE_MAX_CHARS)}\n` : '';
  const activityLine = input.waitingForTool
    ? 'Current activity: an execution step (a tool/command) is still running.'
    : 'Current activity: still thinking, organizing, or checking results — no step is visibly stuck.';
  const repeatLine = input.priorCount > 0
    ? `You have already sent ${input.priorCount} such note(s) this turn — say something NEW; do not repeat your earlier wording or structure.`
    : '';
  return [
    {
      role: 'system',
      content: [
        `You are a chat assistant still working on the user's request; the user has been waiting about ${waitedMinutes} minute(s) with no new visible message from you. Write ONE short chat line — your own words — telling them plainly what is happening right now and that work continues.`,
        'This line must sound like a real person replying in chat, never a canned status template. Vary your wording naturally; never produce stock phrases like "仍在处理中" or "still processing" unless that is genuinely what you mean in your own voice.',
        '- If a step is still executing, say so plainly; otherwise say you are still thinking or organizing.',
        '- A brief natural acknowledgment of the wait is fine when it is genuinely meant; no apologies theater.',
        'Rules: 1 sentence, under 30 words. Same language as the user message. No markdown, lists, quotes, or emoji. No promises, no ETAs, no deadlines. Output only the finished text — never your thinking or reasoning about these rules.',
        "Never describe, analyze, translate, or quote the user's message; never mention what language it is in.",
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        titleLine,
        `Minutes waited: ${waitedMinutes}`,
        activityLine,
        repeatLine,
        '',
        `User message:\n${truncateUtf16UnitsSafe(userText, OWNER_WAIT_USER_TEXT_MAX_CHARS)}`,
      ].filter((line) => line !== '').join('\n'),
    },
  ];
}

/**
 * Deterministic opening, emitted synchronously at the early-ack site. Reserved
 * for openings that CARRY INFORMATION a template genuinely cannot get wrong —
 * a worker delivery notice names the actor and the pending review, which is
 * status, not conversation.
 *
 * Everything else returns ''. Owner decision 2026-11-03 (session 2c70849f:
 * "好的，这就处理。" three times in eight minutes): a rotating canned line is
 * worse than no line — the first sentence must be the bot's own words about
 * THIS message, so the generic case waits for the LLM ack (emitTurnAckReplyBubble)
 * and shows nothing but the activity indicator until it lands. Never bring
 * back a phrase pool here.
 */
export function buildDeterministicTurnAckOpening(userText: string): string {
  const normalized = (userText ?? '').replace(/\s+/g, ' ').trim();
  const cjk = containsCjk(normalized);
  if (resolveTurnAckActivity(normalized) !== 'verify_delivery') return '';
  const worker = normalized.match(/\[ORCH-NOTIFY\]\s+worker\s+(.+?)\s+已完成\s+task\s+\S+/i)?.[1]?.trim();
  const actor = worker || (cjk ? '协作 Bot' : 'The worker bot');
  return sanitizeTurnAckReply(cjk
    ? `${actor}已交付一个子任务，我先核对交付物和当前状态，再向你汇报验收结果；如果需要后续发版或你操作，我会一并说明。`
    : `${actor} has delivered a subtask. I’ll check the deliverables and current state, then report the review outcome and any release or action needed next.`);
}

/**
 * Input-aware sanitize for the LLM ack (2026-10-23 thinking-leak fix).
 * Two deterministic rejections return '' BEFORE the length cap so the caller
 * shows NO first sentence rather than a bad one (the activity indicator keeps
 * covering the wait; a leaked-reasoning or wrong-language bubble is worse):
 *  - genre guard: the ack reads as meta-analysis about the message (starts
 *    with "The user" or contains one of TURN_ACK_GENRE_MARKERS);
 *  - language guard: the user wrote CJK but the ack contains no CJK at all.
 * Anything else falls through to the plain sanitizer unchanged.
 */
export function sanitizeTurnAckReplyForInput(raw: string, userText: string): string {
  const probe = (raw ?? '')
    .replace(/^[\s"'`«»“”‘’「」『』]+/, '')
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase();
  if (!probe) return '';
  if (probe.startsWith('the user')) return '';
  for (const marker of TURN_ACK_GENRE_MARKERS) {
    if (probe.includes(marker)) return '';
  }
  if (containsCjk(userText ?? '') && !containsCjk(raw ?? '')) return '';
  return sanitizeTurnAckReply(raw);
}

// ---------------------------------------------------------------------------
// Turn status goal — the activity indicator's headline phrase (assistant mode)
// ---------------------------------------------------------------------------

/**
 * Display cap for the status goal: ONE progressive clause, never a sentence.
 * A CJK clause past ~14 characters stops reading as a status headline; 30
 * UTF-16 units leaves margin for the model overshooting mildly.
 */
export const TURN_STATUS_GOAL_MAX_CHARS = 30;

/** Input cap for the user-text slice sent to the status-goal model. */
const TURN_STATUS_GOAL_USER_TEXT_MAX_CHARS = 600;

export interface TurnStatusGoalInput {
  /** The turn's user message — the action source and language cue. */
  userText: string;
  sessionTitle?: string | null;
}

/**
 * Prompt messages for the one-shot status-goal call (pure). Same call class
 * as the ack reply (same Twin brain pair, thinking off, tight budget) but a
 * much tighter output: ONE progressive-aspect clause naming the ACTION this
 * turn calls for, shown as the activity indicator's headline while the turn
 * is still pre-first-token — the window where the renderer only has generic
 * rotating phrases. It never answers the message (same context-free contract
 * as the ack): it compresses the message into the intent, e.g. "帮我把 10 月
 * 版 BP 改成 11 月版" → "正在恢复 10 月版 BP 配图".
 */
export function buildTurnStatusGoalMessages(
  input: TurnStatusGoalInput
): Array<{ role: 'system' | 'user'; content: string }> {
  const userText = (input.userText ?? '').trim();
  const title = (input.sessionTitle ?? '').trim();
  const titleLine = title ? `Session title: ${truncateUtf16UnitsSafe(title, TURN_ACK_TITLE_MAX_CHARS)}\n\n` : '';
  return [
    {
      role: 'system',
      content: [
        'You write ONE short status line that a chat app shows on the assistant\'s progress indicator while it works on the user\'s just-arrived message — a headline of what is happening, not a reply to the user.',
        'Compress the message into its ACTION and write it in progressive aspect, starting with a verb: what you are about to do or are doing right now (e.g. "正在恢复10月版BP的配图", "正在排查定时任务的报错", "Looking up the October backup").',
        '- NEVER answer the message, state facts, or promise outcomes; you see no conversation context, so any substantive claim can contradict the real work that follows.',
        '- NEVER restate the user\'s sentence; compress it into the intent. Never analyze it, never mention what language it is in.',
        'Rules: ONE clause only — under 14 characters for CJK, under 8 words otherwise. Same language as the user message. No quotes, markdown, emoji, or ending punctuation. Output only the finished line — never your thinking about these rules.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `${titleLine}User message:\n${truncateUtf16UnitsSafe(userText, TURN_STATUS_GOAL_USER_TEXT_MAX_CHARS)}`,
    },
  ];
}

/** Normalize a raw status-goal completion into a headline ('' when unusable). */
export function sanitizeTurnStatusGoal(raw: string): string {
  let text = (raw ?? '')
    .replace(/```[a-zA-Z]*\r?\n?/g, '')
    .replace(/```/g, '')
    .trim();
  // Drop the "Here is..." / "Status:" preamble class outright.
  text = text.replace(/^(here is|here's|status|status line|译文|翻译)\s*[:：]?\s*/i, '').trim();
  text = text.replace(/^["'`«»“”‘’「」『』]+|["'`«»「」『』]+$/g, '').trim();
  // One line, no trailing sentence punctuation — the renderer appends its own
  // ellipsis/timer and a full stop would read as a reply.
  text = text.replace(/\s+/g, ' ').replace(/[.。!！?？;；,，、]+$/g, '').trim();
  if (!text) return '';
  return truncateUtf16UnitsSafe(text, TURN_STATUS_GOAL_MAX_CHARS);
}

/**
 * Input-aware guard over sanitizeTurnStatusGoal, same posture as the ack's:
 * meta-analysis about the message ("The user wants...") and wrong-language
 * output (CJK user, non-CJK phrase) are both worse than no headline, so they
 * return '' and the indicator keeps its generic phrase pool.
 */
export function sanitizeTurnStatusGoalForInput(raw: string, userText: string): string {
  const probe = (raw ?? '')
    .replace(/^[\s"'`«»“”‘’「」『』]+/, '')
    .toLowerCase();
  if (!probe) return '';
  if (probe.startsWith('the user')) return '';
  if (containsCjk(userText ?? '') && !containsCjk(raw ?? '')) return '';
  return sanitizeTurnStatusGoal(raw);
}
