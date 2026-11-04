/**
 * AskUserQuestion over IM — numbered options.
 *
 * The desktop renders an interactive wizard, so a question's options are
 * clickable. IM has text only, and the handler used to collapse EVERY
 * AskUserQuestion into the generic 允许/拒绝 confirmation: the owner could
 * approve the question but never choose an answer, and the tool was answered
 * with a hard-coded option (the label containing 「允许本次操作」, else the
 * first one). That is a decision-correctness defect, not a formatting one —
 * the person's choice never reached the tool.
 *
 * This module owns the ONE numbering shared by both sides:
 *  - `collectImAskOptions()` flattens the questions into the list the prompt
 *    renders (1..N);
 *  - `parseImAskOptionReply()` maps a whole-string reply back to the exact
 *    (question, option) pair.
 *
 * Numbers are GLOBAL across questions — question 1 may own 1–2 and question 2
 * own 3–4 — so a number can never be ambiguous between questions ("编号与题一
 * 一对应"). Explicitly NOT supported, and never guessed at: free-form text,
 * negations, and multi-select checklists (one number selects exactly one
 * label). Those keep the status quo: the reply is not an option answer.
 */

export interface ImAskOptionRef {
  /** 1-based number rendered in the prompt; unique across the whole request. */
  number: number;
  /** Index of the question inside `toolInput.questions`. */
  questionIndex: number;
  /** Index of the option inside that question's `options` array. */
  optionIndex: number;
  label: string;
  /** Optional option description, rendered after the label. */
  description?: string;
}

/** Reply may carry at most this many characters to count as a selection. */
export const IM_ASK_OPTION_REPLY_MAX_CHARS = 32;

/**
 * The renderer treats this substituted value as "structure lost" (F-17a); an
 * option carrying it must never become a selectable number.
 */
const TRUNCATED_DEPTH_SENTINEL = '[truncated-depth]';

const toRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

/**
 * Flatten an AskUserQuestion payload into the numbered option list.
 *
 * Only questions that carry a non-empty `question` text and at least one usable
 * option contribute numbers: the answer map is keyed by that text, and a
 * question without options has no label a number could honestly stand for.
 * Option entries tolerate the same shapes the desktop wizard accepts (bare
 * string or `{label, description}`), so the IM list shows exactly what the
 * desktop would.
 */
export function collectImAskOptions(toolInput: unknown): ImAskOptionRef[] {
  const input = toRecord(toolInput);
  const rawQuestions = input && Array.isArray(input.questions) ? input.questions : [];
  const collected: ImAskOptionRef[] = [];
  let number = 0;

  rawQuestions.forEach((rawQuestion, questionIndex) => {
    const question = toRecord(rawQuestion);
    if (!question || typeof question.question !== 'string' || !question.question.trim()) return;
    const rawOptions = Array.isArray(question.options) ? question.options : [];

    rawOptions.forEach((rawOption, optionIndex) => {
      let label: string | null = null;
      let description: string | undefined;
      if (typeof rawOption === 'string') {
        if (rawOption.trim() && rawOption !== TRUNCATED_DEPTH_SENTINEL) {
          label = rawOption;
        }
      } else {
        const option = toRecord(rawOption);
        if (option && typeof option.label === 'string' && option.label.trim()
          && option.label !== TRUNCATED_DEPTH_SENTINEL) {
          label = option.label;
          if (typeof option.description === 'string' && option.description.trim()) {
            description = option.description;
          }
        }
      }
      if (label === null) return;
      number += 1;
      collected.push({ number, questionIndex, optionIndex, label, description });
    });
  });

  return collected;
}

/** Question indexes that own at least one numbered option, ascending. */
export function optionQuestionIndexes(options: readonly ImAskOptionRef[]): number[] {
  const seen = new Set<number>();
  for (const option of options) seen.add(option.questionIndex);
  return [...seen].sort((a, b) => a - b);
}

/**
 * The first (smallest) number of each option-bearing question, in question
 * order. This is the example a multi-question reply must show: with global
 * numbering "1 2" can belong to ONE question, so a hard-coded example would
 * teach the owner the wrong syntax.
 */
export function firstNumberPerQuestion(options: readonly ImAskOptionRef[]): number[] {
  const first = new Map<number, number>();
  for (const option of options) {
    if (!first.has(option.questionIndex)) first.set(option.questionIndex, option.number);
  }
  return optionQuestionIndexes(options).map((questionIndex) => first.get(questionIndex) as number);
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/**
 * One numeral token → its value, or null when the token is not a numeral.
 * Arabic tokens are 1–99 without leading zeros; Chinese numerals cover 一–九十
 * 九 (the whole range an AskUserQuestion can address). Full-width digits are
 * normalized by the caller.
 */
export function parseImNumeralToken(token: string): number | null {
  if (!token) return null;

  if (/^\d+$/.test(token)) {
    if (!/^[1-9]\d?$/.test(token)) return null;
    return Number(token);
  }

  if (token === '十') return 10;
  const chars = [...token];
  if (chars.length === 1) {
    const digit = CN_DIGITS[chars[0]];
    return digit && digit > 0 ? digit : null;
  }
  if (chars.length === 2) {
    const [first, second] = chars;
    if (first === '十') {
      const unit = CN_DIGITS[second];
      return unit && unit > 0 ? 10 + unit : null;
    }
    const tens = CN_DIGITS[first];
    if (second === '十' && tens && tens > 0) return tens * 10;
    return null;
  }
  if (chars.length === 3) {
    const [tens, ten, unit] = chars;
    const tensValue = CN_DIGITS[tens];
    const unitValue = CN_DIGITS[unit];
    if (ten === '十' && tensValue && tensValue > 0 && unitValue && unitValue > 0) {
      return tensValue * 10 + unitValue;
    }
  }
  return null;
}

const FULL_WIDTH_DIGIT_RE = /[０-９]/g;
const TRAILING_PUNCTUATION_RE = /[。！!?？.,，、;；:：\s"'“”‘’）)\]】]+$/;
const TOKEN_SEPARATOR_RE = /[\s,，、;；/／＋+]+/;

/**
 * Split a whole-string reply into numeral tokens. Returns an empty list when
 * the text is not made of numeral tokens at all (ordinary chat).
 */
export function splitImAskOptionTokens(raw: string): string[] {
  const normalized = String(raw ?? '')
    .replace(FULL_WIDTH_DIGIT_RE, (char) => String(char.charCodeAt(0) - 0xFF10))
    .trim()
    .replace(TRAILING_PUNCTUATION_RE, '')
    .trim();
  if (!normalized) return [];
  return normalized.split(TOKEN_SEPARATOR_RE).filter(Boolean);
}

export type ImAskOptionReply =
  /** Numeric, and every option-bearing question got exactly one pick. */
  | { kind: 'selected'; numbers: number[]; byQuestion: Map<number, ImAskOptionRef> }
  /** Numeric, but some option-bearing questions remain unanswered. */
  | { kind: 'incomplete'; numbers: number[]; missingQuestionIndexes: number[] }
  /** Numeric-shaped but unusable: out of range, or two picks for one question. */
  | { kind: 'invalid'; numbers: number[]; reason: 'out-of-range' | 'duplicate-question' }
  /** Not a numeric reply at all — the caller keeps the existing vocabulary. */
  | { kind: 'none' };

/**
 * Map a whole-string chat reply onto the numbered options of ONE pending ask.
 *
 * A partial reply is deliberately NOT accepted: answering the other questions
 * with defaults would put choices in the owner's mouth. The caller answers
 * `incomplete` with a hint instead of resolving the request.
 */
export function parseImAskOptionReply(raw: string, options: readonly ImAskOptionRef[]): ImAskOptionReply {
  const tokens = splitImAskOptionTokens(raw);
  if (tokens.length === 0) return { kind: 'none' };
  if (String(raw ?? '').trim().length > IM_ASK_OPTION_REPLY_MAX_CHARS) return { kind: 'none' };

  const numbers: number[] = [];
  for (const token of tokens) {
    const value = parseImNumeralToken(token);
    if (value === null) return { kind: 'none' };
    numbers.push(value);
  }

  const byNumber = new Map(options.map((option) => [option.number, option]));
  for (const value of numbers) {
    if (!byNumber.has(value)) return { kind: 'invalid', numbers, reason: 'out-of-range' };
  }

  const byQuestion = new Map<number, ImAskOptionRef>();
  for (const value of numbers) {
    const option = byNumber.get(value) as ImAskOptionRef;
    if (byQuestion.has(option.questionIndex)) {
      return { kind: 'invalid', numbers, reason: 'duplicate-question' };
    }
    byQuestion.set(option.questionIndex, option);
  }

  const missingQuestionIndexes = optionQuestionIndexes(options)
    .filter((questionIndex) => !byQuestion.has(questionIndex));
  if (missingQuestionIndexes.length > 0) {
    return { kind: 'incomplete', numbers, missingQuestionIndexes };
  }

  return { kind: 'selected', numbers, byQuestion };
}
