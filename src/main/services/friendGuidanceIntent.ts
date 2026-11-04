/**
 * Deterministic owner-intent detection for A2A guidance (S6 final-verification
 * defect #4): when the owner types an explicit mutual-friend instruction into
 * a MetaWeb private-chat A2A session (e.g. 「请完成互相关注」), the guidance
 * delivery paths alone could not reach the S5 friend-authorization chain —
 * the queued path waits for the next inbound peer message (which never comes
 * in the followsMe=true endgame), and the restart path is a one-shot composer
 * with no friend-tag protocol. The queueA2AGuidance handler therefore runs
 * this detector and fires the owner-authorization card directly.
 *
 * Precision-first by design: a missed match only falls back to the LLM-tag
 * behavior (nothing breaks), while a false positive pops an authorization
 * card the owner must dismiss. Only unmistakable MUTUAL-friendship markers
 * match; negated or removal phrasings never do.
 */

/** Negation/removal markers — a guidance containing these never triggers. */
const NEGATIVE_PATTERNS: readonly RegExp[] = [
  /不要.{0,6}(关注|加|好友|follow)/i,
  /(别|先别|无需|不用).{0,6}(关注|加|好友|follow)/i,
  /取消(相互)?关注/,
  /取消.{0,2}好友/,
  /解除好友/,
  /拉黑/,
  /unfollow/i,
  /remove\s+(each\s+other\s+as\s+)?friends?/i,
  /don'?t\s+follow/i,
];

/**
 * Explicit mutual-friendship markers. Bare 「加好友」/「follow」 are
 * deliberately excluded — they read as feature talk as often as intent
 * (e.g. 「帮我实现加好友功能」); the mutual markers below are unambiguous.
 */
const MUTUAL_INVITE_PATTERNS: readonly RegExp[] = [
  /互相关?注/,
  // 「互关」 shorthand, without matching 互关于/互关系/互关联 or re-matching 互相关注.
  /(?<!相)互关(?!于|系|联)/,
  /相互关注/,
  /彼此关注/,
  /双向关注/,
  /互加好友/,
  /互为好友/,
  /互粉/,
  /加为好友/,
  /成为(链上)?好友/,
  /follow\s+each\s+other/i,
  /follow\s+one\s+another/i,
  /mutual(ly)?\s+follow/i,
  /become\s+(on-?chain\s+)?friends?/i,
  /add\s+each\s+other(\s+as\s+friends?)?/i,
];

/**
 * True when the guidance text carries an explicit owner instruction to make
 * the local bot and the peer mutual on-chain friends. Negation dominates:
 * 「先不要互相关注」 never triggers.
 */
export function detectMutualFriendInviteIntent(guidance: string): boolean {
  const text = typeof guidance === 'string' ? guidance.trim() : '';
  if (!text) return false;
  if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return MUTUAL_INVITE_PATTERNS.some((pattern) => pattern.test(text));
}
