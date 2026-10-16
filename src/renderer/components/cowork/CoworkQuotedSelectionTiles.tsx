/**
 * The composer's quote slot, rendered above the input.
 *
 * The slot is single-target: one quoted fragment — a hand-picked passage or a
 * whole message quoted by the reply entry — renders as a compact reply bar
 * (quote icon + one-line summary + cancel). The multi-item tile row is kept
 * for N > 1 (the fragment model supports several excerpts; the composer
 * exposes one at a time today). Visually a cousin of the file-attachment chip,
 * but a separate list: an attachment holds a host path, a quote holds
 * conversation text that gets written into the prompt body.
 */

import React from 'react';
import { ChatBubbleBottomCenterTextIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkQuotedSelection } from '../../types/cowork';
import {
  QUOTED_SELECTION_SOURCE_KEYS,
  summarizeQuotedSelectionText,
} from './coworkQuotedSelections';

interface CoworkQuotedSelectionTilesProps {
  selections: readonly CoworkQuotedSelection[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

const CoworkQuotedSelectionTiles: React.FC<CoworkQuotedSelectionTilesProps> = ({
  selections,
  onRemove,
  disabled = false,
}) => {
  if (selections.length === 0) return null;

  if (selections.length === 1) {
    // Single-target slot: one compact bar — quote icon, the excerpt's
    // one-line summary, and a cancel control (the reference clients' "quoted
    // message" preview strip).
    const selection = selections[0];
    const cancelLabel = i18nService.t('coworkQuoteReplyCancel');
    return (
      <div
        data-cowork-quote-reply-bar="true"
        aria-label={i18nService.t('coworkQuoteReplyPreviewLabel')}
        className="mb-2 flex items-center gap-1.5 rounded-lg border border-claude-border border-l-2 border-l-claude-accent dark:border-claude-darkBorder dark:border-l-claude-accent dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-2.5 py-1 text-xs dark:text-claude-darkText text-claude-text"
      >
        <ChatBubbleBottomCenterTextIcon className="h-3.5 w-3.5 flex-shrink-0 text-claude-accent" />
        <span className="min-w-0 flex-1 truncate">{summarizeQuotedSelectionText(selection.text)}</span>
        <button
          type="button"
          onClick={() => onRemove(selection.id)}
          disabled={disabled}
          className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-claude-accent hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={cancelLabel}
          title={cancelLabel}
        >
          {cancelLabel}
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
            <span className="truncate max-w-[220px]">{summarizeQuotedSelectionText(selection.text)}</span>
            {selection.truncated && (
              <span className="flex-shrink-0 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('coworkQuoteTruncated')}
              </span>
            )}
            <button
              type="button"
              onClick={() => onRemove(selection.id)}
              disabled={disabled}
              className="ml-0.5 rounded-full p-0.5 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:cursor-not-allowed disabled:opacity-50"
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
