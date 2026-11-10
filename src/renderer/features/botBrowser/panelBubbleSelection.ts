/**
 * Selection-aware bubble context menu (office-chat purity pass #4): when the
 * owner right-clicks a bubble while a text selection lives INSIDE that same
 * bubble, 「引用回复」 quotes the selected fragment and 「复制文本」 copies it;
 * with no selection the menu falls back to the whole message, exactly as
 * before. 👍👎 never follow the selection — they always rate the whole bubble.
 *
 * Pure module (no React): the panel reads `window.getSelection()` inside the
 * contextmenu handler — at that moment Chromium still holds the selection,
 * which is the only reliable capture point for select-then-right-click — and
 * resolves it through this helper before any state update.
 */

/**
 * Resolve the selected text a right-clicked bubble should act on, or null when
 * the menu must treat the WHOLE message:
 * - the selection's anchor and focus must BOTH sit inside the bubble, so a
 *   selection spanning two bubbles (or starting outside the transcript) never
 *   harvests another bubble's text — whichever bubble was right-clicked falls
 *   back to its whole message;
 * - the raw text must carry non-whitespace content.
 * Returns the RAW selected text verbatim: the copy path needs the original
 * fragment, while the quote path normalizes and truncates it downstream
 * (createQuotedSelection, capped at QUOTED_SELECTION_MAX_CHARS).
 */
export const resolveBubbleSelectedText = (
  anchorNode: Node | null,
  focusNode: Node | null,
  rawText: string,
  bubble: Node | null,
): string | null => {
  if (!bubble) return null;
  if (!anchorNode || !focusNode) return null;
  if (!bubble.contains(anchorNode) || !bubble.contains(focusNode)) return null;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) return null;
  return rawText;
};
