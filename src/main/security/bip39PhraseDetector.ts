/**
 * Delimiter-aware generic BIP-39 mnemonic phrase detector (English & CJK).
 *
 * Why delimiter-aware instead of global word-bag splitting:
 *  - Naive `text.split(/[^a-z]+/)` strips Chinese prose, numbers, and code
 *    operators, gluing scattered tech nouns ("Agent ... Model ... Memory ...
 *    Token ... Market ... Order ... Price ... Trade ...") or code identifiers
 *    across an entire long article into a false >= 12-word BIP-39 run.
 *  - Naive `text.split(/[^\p{Script=Han}]+/).filter(t => t.length === 1)`
 *    discards all multi-character Chinese clauses and concatenates every
 *    isolated single character ("第1章", "1月..12月", "3个", "A与B") across a
 *    long Chinese article into a false >= 12-char CJK BIP-39 run.
 *
 * This module scans both the raw input and a single-pass JSON-unescaped view
 * (so multi-line mnemonics serialized inside `JSON.stringify` payloads such as
 * `simplenote` / `simplebuzz` are caught identically to raw text) while
 * requiring standalone word shapes and mnemonic-plausible separators between
 * consecutive words.
 */

import { validateMnemonic, wordlists } from 'bip39';

interface LoadedWordlist {
  list: string[];
  set: ReadonlySet<string>;
}

function loadWordlist(pick: () => string[] | undefined): LoadedWordlist | null {
  try {
    const list = pick();
    if (!Array.isArray(list) || list.length < 2048) return null;
    return { list, set: new Set(list) };
  } catch {
    return null;
  }
}

const ENGLISH_WORDS = loadWordlist(() => wordlists?.english);
const ZH_HANS_WORDS = loadWordlist(() => wordlists?.chinese_simplified);
const ZH_HANT_WORDS = loadWordlist(() => wordlists?.chinese_traditional);

const VALID_BIP39_LENGTHS = [12, 15, 18, 21, 24] as const;
const MIN_UNCHECKSUMMED_DISTINCT_IN_12 = 8;
const MAX_MNEMONIC_SEP_LEN = 64;

const ASCII_WORD_RE = /[A-Za-z]+/g;
const ENGLISH_CASED_SHAPE_RE = /^(?:[a-z]{3,8}|[A-Z]{3,8}|[A-Z][a-z]{2,7})$/;
const HAN_RUN_RE = /\p{Script=Han}+/gu;

/**
 * Allowed separator between consecutive English BIP-39 words in a generic run:
 *  - optional closing quote after word k
 *  - comma/semicolon list separator, horizontal whitespace, or up to 2 line breaks
 *  - optional bullet or 1..2-digit list index (`1. `, `1) `, `1: `, `#1 `, `- `)
 *  - optional opening quote before word k+1
 *
 * Rejects CJK text, sentence periods (`. ` without list digits), JSON key-value
 * colons (`": "`), Markdown table pipes (`|`), slashes/URLs, and code syntax.
 */
const EN_MNEMONIC_SEP_RE =
  /^['"`“”‘’]?(?:[ \t\u3000]*[,;][ \t\u3000]*(?:\r?\n[ \t\u3000]*)?|[ \t\u3000]+|\r?\n[ \t\u3000]*(?:\r?\n[ \t\u3000]*)?)(?:(?:[-*]|#\d{1,2}|\d{1,2}[.):])[ \t\u3000]+)?['"`“”‘’]?$/;

/**
 * Allowed separator between consecutive standalone CJK BIP-39 characters:
 *  - same whitespace / newline / ASCII comma-semicolon / quote rules as English
 *  - plus Chinese numbered-list prefixes like `1、字`
 *
 * Rejects unnumbered Chinese prose enumeration commas (`衣、食、住、行...`) and
 * Chinese clause punctuation (`，。！？；：`).
 */
const CJK_MNEMONIC_SEP_RE =
  /^['"`“”‘’]?(?:[ \t\u3000]*[,;][ \t\u3000]*(?:\r?\n[ \t\u3000]*)?|[ \t\u3000]+|\r?\n[ \t\u3000]*(?:\r?\n[ \t\u3000]*)?)(?:(?:(?:[-*]|#\d{1,2}|\d{1,2}[.):])[ \t\u3000]+)|(?:\d{1,2}、[ \t\u3000]*))?['"`“”‘’]?$/;

/**
 * Unescape common single-layer JSON / JS string escapes (`\\n`, `\\r\\n`, `\\t`,
 * `\\"`, `\\\\`) while preserving escaped literal backslashes (`\\\\` -> `\\`)
 * so Windows paths inside JSON strings (`"C:\\\\notes\\\\task"`) are restored
 * faithfully instead of turning `\\n` into a newline.
 */
export function unescapeCommonStringEscapes(text: string): string {
  if (!text || !text.includes('\\')) return text;
  return text.replace(/\\(?:\\|r\\n|n|r|t|"|'|u0020)/g, (seq) => {
    switch (seq) {
      case '\\\\':
        return '\\';
      case '\\"':
        return '"';
      case "\\'":
        return "'";
      case '\\t':
        return '\t';
      case '\\u0020':
        return ' ';
      default:
        return '\n';
    }
  });
}

function getCandidateViews(text: string): string[] {
  const unescaped = unescapeCommonStringEscapes(text);
  return unescaped !== text ? [text, unescaped] : [text];
}

function isPlausibleBip39Run(words: readonly string[], wordlist: string[] | null): boolean {
  if (words.length < 12) return false;

  for (let i = 0; i <= words.length - 12; i += 1) {
    const unique = new Set<string>();
    for (let j = i; j < i + 12; j += 1) {
      unique.add(words[j]);
    }
    if (unique.size >= MIN_UNCHECKSUMMED_DISTINCT_IN_12) {
      return true;
    }
  }

  if (!wordlist) return false;
  for (const len of VALID_BIP39_LENGTHS) {
    if (words.length < len) break;
    for (let i = 0; i <= words.length - len; i += 1) {
      const slice = words.slice(i, i + len);
      if (new Set(slice).size < 2) continue;
      if (validateMnemonic(slice.join(' '), wordlist)) {
        return true;
      }
    }
  }

  return false;
}

function recordPhraseIfPlausible(
  run: readonly string[],
  wordlist: string[] | null,
  seen: Set<string>,
  out: string[],
): void {
  if (run.length < 12) return;
  if (!isPlausibleBip39Run(run, wordlist)) return;
  const phrase = run.join(' ');
  if (!seen.has(phrase)) {
    seen.add(phrase);
    out.push(phrase);
  }
}

function scanEnglishView(text: string, seen: Set<string>, out: string[]): void {
  if (!ENGLISH_WORDS) return;
  ASCII_WORD_RE.lastIndex = 0;
  let run: string[] = [];
  let prevEnd = -1;
  let match: RegExpExecArray | null;

  while ((match = ASCII_WORD_RE.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    const lower = raw.toLowerCase();
    const charBefore = start > 0 ? text[start - 1] : '';
    const charAfter = end < text.length ? text[end] : '';

    const validStandaloneWord =
      ENGLISH_CASED_SHAPE_RE.test(raw) &&
      !/[0-9_-]/.test(charBefore) &&
      !/[0-9_(-]/.test(charAfter) &&
      ENGLISH_WORDS.set.has(lower);

    if (!validStandaloneWord) {
      recordPhraseIfPlausible(run, ENGLISH_WORDS.list, seen, out);
      run = [];
      prevEnd = -1;
      continue;
    }

    if (run.length > 0) {
      const sepLen = start - prevEnd;
      const sepOk =
        sepLen > 0 &&
        sepLen <= MAX_MNEMONIC_SEP_LEN &&
        EN_MNEMONIC_SEP_RE.test(text.slice(prevEnd, start));
      if (!sepOk) {
        recordPhraseIfPlausible(run, ENGLISH_WORDS.list, seen, out);
        run = [lower];
        prevEnd = end;
        continue;
      }
    }

    run.push(lower);
    prevEnd = end;
  }

  recordPhraseIfPlausible(run, ENGLISH_WORDS.list, seen, out);
}

function scanCjkView(
  text: string,
  loaded: LoadedWordlist | null,
  seen: Set<string>,
  out: string[],
): void {
  if (!loaded) return;
  HAN_RUN_RE.lastIndex = 0;
  let run: string[] = [];
  let prevEnd = -1;
  let match: RegExpExecArray | null;

  while ((match = HAN_RUN_RE.exec(text)) !== null) {
    const tok = match[0];
    const start = match.index;
    const end = start + tok.length;
    const charBefore = start > 0 ? text[start - 1] : '';
    const charAfter = end < text.length ? text[end] : '';

    const validStandaloneSingleHan =
      tok.length === 1 &&
      !/[A-Za-z0-9_-]/.test(charBefore) &&
      !/[A-Za-z0-9_-]/.test(charAfter) &&
      loaded.set.has(tok);

    if (!validStandaloneSingleHan) {
      recordPhraseIfPlausible(run, loaded.list, seen, out);
      run = [];
      prevEnd = -1;
      continue;
    }

    if (run.length > 0) {
      const sepLen = start - prevEnd;
      const sepOk =
        sepLen > 0 &&
        sepLen <= MAX_MNEMONIC_SEP_LEN &&
        CJK_MNEMONIC_SEP_RE.test(text.slice(prevEnd, start));
      if (!sepOk) {
        recordPhraseIfPlausible(run, loaded.list, seen, out);
        run = [tok];
        prevEnd = end;
        continue;
      }
    }

    run.push(tok);
    prevEnd = end;
  }

  recordPhraseIfPlausible(run, loaded.list, seen, out);
}

export function findGenericEnglishMnemonicPhrases(text: string): string[] {
  if (!text || typeof text !== 'string' || !ENGLISH_WORDS) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const view of getCandidateViews(text)) {
    scanEnglishView(view, seen, out);
  }
  return out;
}

export function findGenericCjkMnemonicPhrases(text: string): string[] {
  if (!text || typeof text !== 'string' || (!ZH_HANS_WORDS && !ZH_HANT_WORDS)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const view of getCandidateViews(text)) {
    scanCjkView(view, ZH_HANS_WORDS, seen, out);
    scanCjkView(view, ZH_HANT_WORDS, seen, out);
  }
  return out;
}
