/**
 * The composer's quote slot, rendered above the input.
 *
 * The slot is single-target: one quoted fragment — a hand-picked passage or a
 * whole message quoted by the reply entry — renders as a Telegram-style reply
 * card (purity pass #3 ②): an accent "replying to {speaker}" header line with
 * a ✕ icon button at its right and the excerpt preview underneath; the accent
 * vertical bar on the left is kept, so the pending card and the sent message
 * quote state (the same bar over the generated blockquote) read as one
 * family. The multi-item tile row is kept for N > 1 (the fragment model
 * supports several excerpts; the composer exposes one at a time today).
 * Visually a cousin of the file-attachment chip, but a separate list: an
 * attachment holds a host path, a quote holds conversation text that gets
 * written into the prompt body.
 *
 * Cancel/removal is composer-local state mutation (purity pass #3 ③): it
 * must stay clickable while the session streams, so the slot inherits no
 * running-state `disabled` from its caller.
 */

import React from 'react';
import { ChatBubbleBottomCenterTextIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkQuotedSelection } from '../../types/cowork';
import {
  QUOTED_SELECTION_DISPLAY_CHARS,
  QUOTED_SELECTION_SOURCE_KEYS,
  summarizeQuotedSelectionText,
} from './coworkQuotedSelections';

interface CoworkQuotedSelectionTilesProps {
  selections: readonly CoworkQuotedSelection[];
  onRemove: (id: string) => void;
  /** The session bot's name — names the speaker for an assistant-side excerpt. */
  botName?: string | null;
}

/**
 * The speaker the pending reply card names, mirroring the sent-quote label:
 * the owner is "你", the assistant speaks in the session bot's own name. The
 * header reads as a sentence ("回复 {speaker}"), so the names carry no
 * trailing colon — unlike the sent-quote label set.
 */
const speakerNameFor = (
  selection: CoworkQuotedSelection,
  botName?: string | null,
): string => {
  if (selection.role === 'user') return i18nService.t('coworkQuoteReplyCardSpeakerUser');
  return (botName ?? '').trim()
    || i18nService.t('coworkQuoteSentReplySourceAssistantFallback');
};

const CoworkQuotedSelectionTiles: React.FC<CoworkQuotedSelectionTilesProps> = ({
  selections,
  onRemove,
  botName,
}) => {
  if (selections.length === 0) return null;

  if (selections.length === 1) {
    // Single-target slot: one Telegram-style reply card — the accent header
    // ("回复 {speaker}") with the ✕ cancel icon at its right, the excerpt's
    // one-line preview below, and the accent vertical bar kept on the left
    // (same family as the sent quote's bar). The excerpt uses the same
    // display cap the sent quote uses, so the pending card and the message
    // it becomes read the same length.
    const selection = selections[0];
    const cancelLabel = i18nService.t('coworkQuoteReplyCancel');
    const replyToLabel = i18nService.t('coworkQuoteReplyCardReplyingTo')
      .replace('{speaker}', speakerNameFor(selection, botName));
    return (
      <div
        data-cowork-quote-reply-bar="true"
        aria-label={i18nService.t('coworkQuoteReplyPreviewLabel')}
        className="mb-2 flex items-start gap-1.5 rounded-lg border border-claude-border border-l-2 border-l-claude-accent dark:border-claude-darkBorder dark:border-l-claude-accent dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset py-1.5 pl-2.5 pr-1.5 text-xs dark:text-claude-darkText text-claude-text"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-claude-accent">
            {replyToLabel}
          </div>
          <div className="mt-0.5 truncate dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {summarizeQuotedSelectionText(selection.text, QUOTED_SELECTION_DISPLAY_CHARS)}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onRemove(selection.id)}
          className="flex-shrink-0 rounded-md p-0.5 text-claude-accent hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          aria-label={cancelLabel}
          title={cancelLabel}
        >
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-cowork-quote-tiles="true"
      aria-label={i18nService.t('coworkQuoteSelectionsLabel')}
      className="mb-2 flex flex-wrap gap-2"
    >
      {selections.map((selection) => {
        const sourceKey = QUOTED_SELECTION_SOURCE_KEYS[selection.role]
          ?? QUOTED_SELECTION_SOURCE_KEYS.other;
        const source = i18nService.t(sourceKey);
        const removeLabel = `${i18nService.t('coworkQuoteRemove')} ${source}`;
        return (
          <div
            key={selection.id}
            data-cowork-quote-tile={selection.id}
            title={selection.text}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-claude-border border-l-2 border-l-claude-accent dark:border-claude-darkBorder dark:border-l-claude-accent dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-2.5 py-1 text-xs dark:text-claude-darkText text-claude-text"
          >
            <ChatBubbleBottomCenterTextIcon className="h-3.5 w-3.5 flex-shrink-0 text-claude-accent" />
            <span className="flex-shrink-0 font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {source}
            </span>
            <span className="truncate max-w-[220px]">{summarizeQuotedSelectionText(selection.text, QUOTED_SELECTION_DISPLAY_CHARS)}</span>
            {selection.truncated && (
              <span className="flex-shrink-0 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('coworkQuoteTruncated')}
              </span>
            )}
            <button
              type="button"
              onClick={() => onRemove(selection.id)}
              className="ml-0.5 rounded-full p-0.5 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              aria-label={removeLabel}
              title={removeLabel}
            >
              <XMarkIcon className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default CoworkQuotedSelectionTiles;
