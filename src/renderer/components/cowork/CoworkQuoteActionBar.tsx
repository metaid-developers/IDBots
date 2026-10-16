/**
 * Floating action bar that appears next to a text selection in the transcript.
 *
 * Only one action is offered — quoting the selected passage into the composer.
 * The reference implementations (Codex desktop, Grok Bot) also offer "ask in a
 * side chat"; that one needs a product surface this host does not have (no
 * separate side conversation exists here), so it is deliberately not ported.
 *
 * Placement is computed by the caller through the repository's shared
 * anchored-popover helpers (`placePopoverAbove` / `useAnchorMoveWatcher`); this
 * component only renders the given placement.
 */

import React from 'react';
import { ChatBubbleBottomCenterTextIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { PopoverPlacement } from '../../utils/anchoredPopover';

interface CoworkQuoteActionBarProps {
  placement: PopoverPlacement;
  onAdd: () => void;
}

/** Intrinsic size, used for the first placement before the bar is measured. */
export const QUOTE_ACTION_BAR_WIDTH = 176;
export const QUOTE_ACTION_BAR_HEIGHT = 32;

const CoworkQuoteActionBar = React.forwardRef<HTMLDivElement, CoworkQuoteActionBarProps>(
  ({ placement, onAdd }, ref) => (
    <div
      ref={ref}
      data-cowork-quote-action="true"
      role="toolbar"
      aria-label={i18nService.t('coworkQuoteActionLabel')}
      className="z-40"
      style={{
        position: 'fixed',
        top: placement.top,
        left: placement.left,
        width: placement.width,
      }}
    >
      <button
        type="button"
        // Keep the transcript selection alive until the click handler has read
        // it: pressing the bar must not collapse the selection first.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAdd}
        className="flex w-full items-center gap-1.5 rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2.5 py-1.5 text-xs shadow-elevated dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
      >
        <ChatBubbleBottomCenterTextIcon className="h-3.5 w-3.5 flex-shrink-0 text-claude-accent" />
        <span className="truncate">{i18nService.t('coworkQuoteAddToConversation')}</span>
      </button>
    </div>
  ),
);

CoworkQuoteActionBar.displayName = 'CoworkQuoteActionBar';

export default CoworkQuoteActionBar;
