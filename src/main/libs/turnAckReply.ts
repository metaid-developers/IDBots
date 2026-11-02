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
        'You write the opening acknowledgment of a chat assistant. The user just sent a message; the full reply is being prepared separately and will appear after yours.',
        'Write ONE short acknowledgment that confirms you received and understood the request and says in plain words what you are about to do for it.',
        'Rules: 1-2 sentences, under 40 words. Same language as the user message. Do not answer, solve, or start the task. Do not promise results or time limits, and do not ask questions. No markdown, lists, quotes, emoji, or greetings. Output only the finished acknowledgment text — never your thinking, deliberation, or reasoning about these rules or the message.',
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

export function buildFallbackTurnAckReply(userText: string): string {
  const normalized = (userText ?? '').replace(/\s+/g, ' ').trim();
  const cjk = containsCjk(normalized);
  const firstSentence = normalized.split(/[。！？!?；;]/, 1)[0]?.trim() ?? '';
  let summary = firstSentence;
  const comma = summary.search(/[,，]/);
  if (comma >= 4) {
    summary = summary.slice(0, comma);
  } else if (summary.length > 40) {
    summary = `${truncateUtf16UnitsSafe(summary, 40).trimEnd()}…`;
  }
  if (!summary) summary = cjk ? '这个问题' : 'this request';
  return sanitizeTurnAckReply(cjk
    ? `收到，我先核对「${summary}」的原因和处理路径，然后直接推进；有关键进展或需要你决定的事，我会再汇报。`
    : `Got it. I’ll look into “${summary}”, confirm the cause and next step, then move it forward. I’ll report key milestones or anything that needs your decision.`);
}

/**
 * Input-aware sanitize for the LLM ack (2026-10-23 thinking-leak fix).
 * Two deterministic rejections return '' BEFORE the length cap so the caller
 * uses the deterministic opening instead of emitting leaked reasoning:
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
