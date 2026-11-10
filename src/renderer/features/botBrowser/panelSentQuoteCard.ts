/**
 * Display model for a sent whole-message reply quote in the office panel
 * (office-chat purity pass #5, item ②).
 *
 * A sent user message whose body opens with the generated reply block
 * (`> #<ordinal> <side>：` + blockquote lines) renders on this panel as a
 * Telegram-style quote card — an accent speaker line over a one-line excerpt.
 * The transcript's own parser already knows the generated form and its
 * display-only shortener (parseSentQuoteBlock /
 * shortenSentQuoteBlockForDisplay in coworkQuotedSelections); this module is
 * the thin panel-side step that turns the parsed block into the card's two
 * lines.
 *
 * Pure over its inputs (no React, no DOM): the caller supplies the speaker
 * names per role, so the module stays free of i18n and the panel keeps
 * naming the speakers with its own bot's name.
 *
 * ⚠️ Display-only by construction: nothing here writes back — the submitted
 * prompt body keeps the generated label and the wider excerpt the model
 * needs (see shortenSentQuoteBlockForDisplay's contract).
 */

import { parseSentQuoteBlock } from '../../components/cowork/coworkQuotedSelections';
import type { CoworkQuotedSelectionRole } from '../../types/cowork';

/** Speaker names per quoted-message role, as the card renders them. */
export type PanelQuoteDisplaySources = Record<CoworkQuotedSelectionRole, string>;

export interface PanelSentQuoteCardModel {
  /** Accent speaker line: the session bot's name, or 「你」 for the owner. */
  speaker: string;
  /** The quote body under the speaker (the row clamps it to one line). */
  excerpt: string;
  /** The owner's own instruction after the quote, '' when the send was quote-only. */
  rest: string;
}

/**
 * Build the Telegram-card display model for a sent message body, or null
 * when the body does not open with the generated reply block (plain bodies
 * render exactly as before — a hand-written blockquote never matches the
 * parser). `displaySources` follows parseSentQuoteBlock's contract: the raw
 * generated side label ("助手消息" / "你的消息" / …) is swapped for the
 * caller's speaker name; without a map the raw label is kept, so the caller
 * choosing to omit it degrades to the transcript's old form rather than to a
 * wrong name.
 */
export const buildPanelSentQuoteCardModel = (
  content: string,
  displaySources?: PanelQuoteDisplaySources,
): PanelSentQuoteCardModel | null => {
  const parsed = parseSentQuoteBlock(content, displaySources);
  if (!parsed) return null;
  const lines = parsed.block.split('\n');
  const speaker = (lines[0] ?? '').replace(/^>\s?/, '').trim();
  const excerpt = lines
    .slice(1)
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
  if (!speaker || !excerpt) return null;
  return { speaker, excerpt, rest: parsed.rest };
};
