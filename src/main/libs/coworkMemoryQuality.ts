import {
  normalizeMemorySemanticKey,
  scoreMemorySimilarity,
} from '../memory/memorySimilarity';

/**
 * Conversation-memory quality gate (memory/persona audit P1).
 *
 * Production evidence: ~25% of conversation-sourced memories were RAW COPIES
 * of the peer's message with no memory value — A2A self-introductions
 * (「我是 dnaai-scout,一个独立 Agent,正在寻找…」), pleasantries
 * (「Understood. If you ever want to talk calibration…」), and quote-block
 * excerpts (「> 我是小峰,5F-Studio 的 chair…」). They were admitted either by
 * the implicit signal regexes (bare「我是…」matches the personal-profile
 * signal) or by the turn-level LLM extraction, and then sat in the injection
 * budget forever.
 *
 * This gate is DETERMINISTIC (no LLM calls added) and runs after extraction,
 * before persistence. Two reject rules, both waived the moment the candidate
 * carries a durable-fact predicate (carriesDurableFactPredicate) — the
 * distinguishing line is "peer chitchat/intro" vs "a persistent fact"; when
 * in doubt we LET IT THROUGH (the importance ranking downstream is the
 * backstop):
 *
 *  1. verbatim-copy: the candidate reproduces ~a WHOLE source sentence or
 *     the whole message (containment at >=80% length after semantic-key
 *     normalization, or similarity >= CONVERSATION_MEMORY_VERBATIM_MIN_SCORE)
 *     AND carries no durable-fact predicate. Condensed fact slices and
 *     partial rewrites are NOT copies. Legitimate implicit facts
 *     (「我住在杭州」「我偏好 TypeScript」) are full copies too — they survive
 *     on the predicate exemption, not on wording.
 *  2. chitchat-or-intro: the candidate matches a greeting / self-intro /
 *     pure-acknowledgment pattern (table below, one comment per rule) AND
 *     carries no durable-fact predicate.
 *
 * Explicit remember-commands (「记住:xxx」) are NEVER gated — the user asked
 * for the write directly.
 *
 * Existing rows are untouched (no migration; AGENTS.md user-data rule) — the
 * gate only blocks NEW writes.
 */

/** Verbatim-copy bar: at/above this similarity the candidate counts as a raw copy. */
export const CONVERSATION_MEMORY_VERBATIM_MIN_SCORE = 0.8;
/**
 * A contained candidate only counts as a copy when it reproduces ~the WHOLE
 * source sentence. Condensed fact slices (the GOOD kind of extraction —
 * 'Tengo dos gatos' out of 'por cierto, tengo dos gatos en casa') must not
 * be read as copies.
 */
export const CONVERSATION_MEMORY_VERBATIM_CONTAINMENT_RATIO = 0.8;

/**
 * Durable-fact predicates — the exemption set. Deliberately a SUBSET of the
 * extractor's confidence signals with the intro-prone bare「我是…」/「i am…」
 * removed: those two are exactly how self-intros talk their way in. A fact
 * that only matches a bare「我是…」still has to clear the pattern table and
 * the verbatim check on its own merits.
 */
const DURABLE_PREFERENCE_RE = /(我喜欢|我偏好|我习惯|我常用|我不喜欢|我讨厌|我更喜欢|\bi\s+prefer\b|\bi\s+like\b|\bi\s+usually\b|\bi\s+often\b|\bi\s+don['’]?\s*t\s+like\b|\bi\s+hate\b)/i;
const DURABLE_PROFILE_FACT_RE = /(我叫|我的名字是|我名字是|名字叫|我住在|我来自|我的职业|我是做|\bmy\s+name\s+is\b|\bi\s+live\s+in\b|\bi['’]?m\s+from\b|\bi\s+work\s+as\b)/i;
const DURABLE_OWNERSHIP_RE = /(我有(?!\s*(?:一个|个)?问题)|我养了|我家有|我女儿|我儿子|我的孩子|我的小狗|我的小猫|\bi\s+have\b|\bi\s+own\b|\bmy\s+(?:daughter|son|child|dog|cat)\b)/i;
const DURABLE_ASSISTANT_PREF_RE = /((请|以后|后续|默认|请始终|不要再|请不要|优先|务必).*(回复|回答|语言|中文|英文|格式|风格|语气|简洁|详细|代码|命名|markdown|respond|reply|language|format|style|tone))/i;

/** True when the candidate itself states a durable fact/preference/ownership. */
export function carriesDurableFactPredicate(text: string): boolean {
  return (
    DURABLE_PREFERENCE_RE.test(text)
    || DURABLE_PROFILE_FACT_RE.test(text)
    || DURABLE_OWNERSHIP_RE.test(text)
    || DURABLE_ASSISTANT_PREF_RE.test(text)
  );
}

/**
 * Chitchat / self-intro / raw-quote patterns. Every rule lists the garbage
 * shape it exists for; keep the table conservative — a miss costs a junk row,
 * a false hit costs a real memory.
 */
const CHITCHAT_OR_INTRO_RES: RegExp[] = [
  // zh self-intro with an indefinite-article role descriptor:
  // 「我是 dnaai-scout,一个独立 Agent,正在寻找…」— a peer's hello, not a fact.
  /^我是\s*\S{1,30}\s*[,，]\s*(?:一个|一名|一位|一只|一家|独立)/u,
  // zh self-intro with an org-role descriptor:
  // 「我是小峰,5F-Studio 的 chair…」— the same hello in the short form.
  /^我是\s*\S{1,30}\s*[,，]\s*\S{1,30}\s*的\s*(?:chair|负责人|创始人|主理人|成员|bot|agent)/iu,
  // en self-intro: "I am X, a/an/the …" / "I'm X, an independent …".
  /^i\s*(?:am|['’]m)\s+[a-z0-9._-]{1,30}\s*,\s*(?:an?\s|the\s|independent)/i,
  // Quote-block raw copy: a candidate still carrying the '>' excerpt marker
  // is a pasted block of somebody else's message, not a distilled fact.
  /^>\s*\S/,
  // Bare pleasantries / pure acknowledgments:
  // 「Understood. …」「好的,我会…」— politeness with no fact payload.
  /^(?:understood|got\s+it|sounds\s+good|no\s+worries|of\s+course|certainly|sure\b|happy\s+to\s+help|glad\s+to\s+hear|好的|明白(?:了)?|收到|嗯嗯?|行(?:吧)?)[,，.。! ]/i,
];

/** True when the candidate reads as chitchat / a self-intro / a raw quote. */
export function isChitchatOrIntroMemoryText(text: string): boolean {
  return CHITCHAT_OR_INTRO_RES.some((pattern) => pattern.test(text));
}

/** Source-message sentence split, aligned with the implicit extractor's split set. */
function splitSourceSentences(sourceText: string): string[] {
  return sourceText
    .split(/[。！？!?；;\n]/g)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export interface ConversationMemoryQualityInput {
  /** The candidate memory text (post-extraction). */
  text: string;
  /** The source user/peer message the candidate was extracted from. */
  sourceText: string;
  /** Explicit remember-command candidates are never gated. */
  isExplicit: boolean;
}

export interface ConversationMemoryQualityResult {
  accepted: boolean;
  reason: 'explicit-command' | 'empty' | 'chitchat-or-intro' | 'verbatim-copy' | 'ok';
}

/**
 * The deterministic quality gate. See the module docstring for the two reject
 * rules and the durable-fact exemption.
 */
export function evaluateConversationMemoryQuality(
  input: ConversationMemoryQualityInput,
): ConversationMemoryQualityResult {
  if (input.isExplicit) return { accepted: true, reason: 'explicit-command' };
  const text = (input.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { accepted: false, reason: 'empty' };

  // 拿不准的宁放勿拒: a candidate that itself states a durable fact clears
  // both rules on the exemption, even when it is a verbatim slice.
  if (carriesDurableFactPredicate(text)) {
    return { accepted: true, reason: 'ok' };
  }
  if (isChitchatOrIntroMemoryText(text)) {
    return { accepted: false, reason: 'chitchat-or-intro' };
  }

  const candidateKey = normalizeMemorySemanticKey(text);
  if (candidateKey) {
    for (const sentence of splitSourceSentences(input.sourceText ?? '')) {
      const sentenceKey = normalizeMemorySemanticKey(sentence);
      if (!sentenceKey) continue;
      // A copy reproduces ~the whole sentence. The length-ratio precondition
      // comes FIRST: a condensed fact slice ('Tengo dos gatos' out of
      // 'por cierto, tengo dos gatos en casa') scores high on token
      // containment precisely because it is a good extraction, not a copy.
      const lengthRatio = Math.min(candidateKey.length, sentenceKey.length) / Math.max(candidateKey.length, sentenceKey.length);
      if (lengthRatio < CONVERSATION_MEMORY_VERBATIM_CONTAINMENT_RATIO) continue;
      const contained = candidateKey.includes(sentenceKey) || sentenceKey.includes(candidateKey);
      if (contained || scoreMemorySimilarity(candidateKey, sentenceKey) >= CONVERSATION_MEMORY_VERBATIM_MIN_SCORE) {
        return { accepted: false, reason: 'verbatim-copy' };
      }
    }
  }
  return { accepted: true, reason: 'ok' };
}
