import React from 'react';
import {
  HandThumbUpIcon,
  HandThumbDownIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { PanelReactionRating } from './panelMessageReactions';

/**
 * Bubble context menu (office-chat purity pass #1, item ②): WeChat/Telegram
 * style — always dark, compact, icon+label rows, hover highlight. Deliberately
 * NOT theme-switched: a context menu is transient chrome, and both reference
 * apps keep it dark in light mode too. No persistent furniture: the panel
 * mounts this component only while the menu is open.
 *
 * Close channels live in the panel (outside pointerdown / Escape / scroll, see
 * panelContextMenuGeometry.ts); this component only renders rows and reports
 * actions. React rows show a check when that side is the bubble's current
 * rating; clicking the current rating again cancels it.
 *
 * Selection-aware (pass #4): when the panel captured a selection inside the
 * bubble, the quote/copy rows switch their labels to the selected-text
 * variants (the actions themselves stay here; the panel resolves WHAT they
 * act on). 👍👎 never read this flag — they always rate the whole bubble.
 */

export interface PanelMessageContextMenuProps {
  /** Fixed-position top-left (viewport px, already flipped by the placement helper). */
  x: number;
  y: number;
  /** The bubble's current rating, for the check marks and cancel-on-reclick. */
  currentReaction: PanelReactionRating | null;
  /** A selection was captured inside the bubble: quote/copy act on the fragment. */
  selectionActive: boolean;
  onReact: (rating: PanelReactionRating) => void;
  onQuoteReply: () => void;
  onCopyText: () => void;
  onDismiss: () => void;
}

const MENU_ROW_CLASS = [
  'flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] leading-4',
  'text-neutral-100 bg-transparent transition-colors',
  'hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none',
].join(' ');

const PanelMessageContextMenu = React.forwardRef<HTMLDivElement, PanelMessageContextMenuProps>(
  ({ x, y, currentReaction, selectionActive, onReact, onQuoteReply, onCopyText, onDismiss }, ref) => {
  const reactRow = (rating: PanelReactionRating) => {
    const isUp = rating === 'up';
    const Icon = isUp ? HandThumbUpIcon : HandThumbDownIcon;
    const active = currentReaction === rating;
    return (
      <button
        type="button"
        role="menuitem"
        data-panel-menu-action={rating}
        onClick={() => {
          onReact(rating);
          // Re-click on the active side cancels (handled by the panel's
          // toggle); either way the menu closes — one action per opening.
          onDismiss();
        }}
        className={MENU_ROW_CLASS}
      >
        <Icon className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {i18nService.t(isUp ? 'botBrowserPanelMenuLike' : 'botBrowserPanelMenuDislike')}
        </span>
        {active ? (
          <span data-panel-menu-checked="true" className="text-neutral-300" aria-hidden>✓</span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      ref={ref}
      role="menu"
      data-slot="panel-message-context-menu"
      data-panel-menu-selection={selectionActive ? 'true' : 'false'}
      style={{ position: 'fixed', top: y, left: x, width: 156 }}
      className="z-[70] rounded-xl border border-white/10 bg-[#2b2b2d] py-1 shadow-elevated"
    >
      {reactRow('up')}
      {reactRow('down')}
      <button
        type="button"
        role="menuitem"
        data-panel-menu-action="quote"
        onClick={() => {
          onQuoteReply();
          onDismiss();
        }}
        className={MENU_ROW_CLASS}
      >
        <ChatBubbleLeftRightIcon className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {i18nService.t(selectionActive ? 'coworkQuoteActionLabel' : 'botBrowserPanelMenuQuoteReply')}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-panel-menu-action="copy"
        onClick={() => {
          onCopyText();
          onDismiss();
        }}
        className={MENU_ROW_CLASS}
      >
        <ClipboardDocumentIcon className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {i18nService.t(selectionActive ? 'botBrowserPanelMenuCopySelected' : 'botBrowserPanelMenuCopyText')}
        </span>
      </button>
    </div>
  );
  },
);

PanelMessageContextMenu.displayName = 'PanelMessageContextMenu';

export default PanelMessageContextMenu;
