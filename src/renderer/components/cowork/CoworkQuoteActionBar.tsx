/**
 * Floating action bar that appears next to a text selection in the transcript.
 *
 * Only one action is offered — quoting the selected passage into the composer.
 * (A "copy text" item was tried on 2026-10-23 and reverted the same day: the
 * second button read as clutter next to the selection.)
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

/**
 * Intrinsic size, used for the first placement before the bar is measured.
 *
 * Width covers the widest label (the English dictionary string measures
 * ~162px at the text-xs / px-3 sizing below). The bar is right-justified
 * inside this width, so a narrower label (the zh one, ~107px) keeps its right
 * edge — the edge pinned to the selection — aligned. Height is the button's
 * laid-out height (16px line + 2×6px padding + 2×1px border).
 */
export const QUOTE_ACTION_BAR_WIDTH = 164;
export const QUOTE_ACTION_BAR_HEIGHT = 30;

const CoworkQuoteActionBar = React.forwardRef<HTMLDivElement, CoworkQuoteActionBarProps>(
  ({ placement, onAdd }, ref) => (
    <div
      ref={ref}
      data-cowork-quote-action="true"
      role="toolbar"
      aria-label={i18nService.t('coworkQuoteActionLabel')}
      className="z-40 flex justify-end"
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
        className="inline-flex items-center gap-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3 py-1.5 text-xs font-medium dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
      >
        <ChatBubbleBottomCenterTextIcon className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate">{i18nService.t('coworkQuoteAddToConversation')}</span>
      </button>
    </div>
  ),
);

CoworkQuoteActionBar.displayName = 'CoworkQuoteActionBar';

export default CoworkQuoteActionBar;
