/**
 * Streaming text backfill for the mobile voice input (voice P0, subtask #10).
 *
 * Doubao-style experience: while the user speaks, hypothesis (`partial`) text fills
 * the chat input live; when the gateway settles an utterance (`final`), the
 * trailing partial is replaced by the settled text. Nothing here touches the
 * network or React — pure string/caret math so the merge rules (CJK vs latin
 * spacing, partial replacement, abort handling) unit-test in isolation.
 *
 * Model kept by the caller (the hook):
 *   base = { before, after }  — the draft split at the caret when the session
 *                               started (voice text grows at the caret)
 *   segments: string[]        — settled finals so far
 *   partial: string           — current unsettled hypothesis (≤ 1 at a time)
 * draft = before + glue + voiceText + glue + after, recomputed per event.
 */

/**
 * Glue between two text pieces: no space across CJK/full-width boundaries or
 * when either side is empty; a single space between latin runs. Punctuation
 * (both ASCII and CJK) attaches to the previous run without a leading space.
 */
export function glueBetween(left: string, right: string): string {
  const l = left.trimEnd();
  const r = right.trimStart();
  if (!l || !r) return '';
  const lastLeft = l.charAt(l.length - 1);
  const firstRight = r.charAt(0);
  if (isCjkOrFullWidth(lastLeft) || isCjkOrFullWidth(firstRight)) return '';
  if (isOpeningPunctuation(firstRight)) return '';
  return ' ';
}

const CJK_RE =
  /[\u1100-\u11FF\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/;

function isCjkOrFullWidth(ch: string): boolean {
  return CJK_RE.test(ch);
}

function isOpeningPunctuation(ch: string): boolean {
  return ch === '(' || ch === '"' || ch === '“' || ch === '（' || ch === '《' || ch === '「';
}

/** The voice text shown/merged into the draft right now. */
export function composeVoiceText(segments: string[], partial: string): string {
  const parts = [...segments];
  if (partial) parts.push(partial);
  let text = '';
  for (const part of parts) {
    if (!part) continue;
    text += glueBetween(text, part) + part;
  }
  return text;
}

/** Full draft = base-before + voiceText + base-after (with glue rules).
 *
 * Boundary whitespace is normalized: the user's trailing/leading spaces at
 * the insertion point are replaced by exactly one glue unit — 'reply: ' +
 * voice 'okay' lands as 'reply: okay', never 'reply:  okay'.
 */
export function composeDraft(base: { before: string; after: string }, voiceText: string): string {
  const before = base.before.replace(/\s+$/, '');
  const after = base.after.replace(/^\s+/, '');
  return before + glueBetween(before, voiceText) + voiceText + glueBetween(voiceText, after) + after;
}

/** Caret position after the merged voice text (user caret sits post-voice).
 *
 * Mirrors composeDraft's boundary trimming so caret math and draft math can
 * never disagree. */
export function voiceTextCaret(base: { before: string; after: string }, voiceText: string): number {
  const before = base.before.replace(/\s+$/, '');
  return before.length + glueBetween(before, voiceText).length + voiceText.length;
}

export interface BackfillController {
  /** Current hypothesis replaced on every partial event. */
  setPartial(text: string): void;
  /** Settles the current partial as one final segment. */
  commitFinal(text: string): void;
  /** Drops the unsettled partial, keeps settled segments (abort path). */
  dropPartial(): void;
  /** Drops EVERYTHING from this voice session (user cancels all). */
  clearAll(): void;
  /** Merged voice text so far. */
  readonly voiceText: string;
  readonly hasText: boolean;
}

/**
 * Creates the backfill state controller for one voice session. The hook
 * derives `draft`/caret from this plus the captured base on every event.
 */
export function createBackfill(): BackfillController {
  let segments: string[] = [];
  let partial = '';
  const api: BackfillController = {
    setPartial(text: string) {
      partial = text;
    },
    commitFinal(text: string) {
      const settled = text.trim();
      // A final usually replaces the trailing partial; an empty final (silence
      // segment) must not leave a dangling empty partial either.
      partial = '';
      if (settled) segments.push(settled);
    },
    dropPartial() {
      partial = '';
    },
    clearAll() {
      segments = [];
      partial = '';
    },
    get voiceText() {
      return composeVoiceText(segments, partial);
    },
    get hasText() {
      return api.voiceText.length > 0;
    },
  };
  return api;
}

/**
 * Splits the draft at the caret into the session base. A null caret means
 * "append at end" (textarea selectionStart can be null before focus).
 */
export function splitDraftAtCaret(draft: string, caret: number | null): { before: string; after: string } {
  const index = caret == null || caret < 0 || caret > draft.length ? draft.length : caret;
  return { before: draft.slice(0, index), after: draft.slice(index) };
}
