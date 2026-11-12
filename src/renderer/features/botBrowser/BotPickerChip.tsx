import React, { useEffect, useRef } from 'react';
import TwinBadge from '../../components/metabots/TwinBadge';
import { i18nService } from '../../services/i18n';
import { bindSeatMenuOutsideDismiss } from './seatMenuDismiss';

/**
 * Centered draft-state bot picker above the Studio session title. Picking a
 * bot selects who runs the next conversation without writing `metabot_type`;
 * live sessions use the read-only CoworkSurfaceIdentityBadge instead.
 *
 * Selection state lives in BotBrowserCoworkPanel.tsx. This presentational
 * component owns only outside-pointer dismissal for its roster menu.
 */

export interface BotPickerChipBot {
  id: number;
  name: string;
  avatar: string | null;
  metabot_type: string;
  role?: string;
}

interface BotPickerChipProps {
  /** The bot selected for the next conversation. */
  chipMetabot: BotPickerChipBot;
  /** Every local bot, in roster order. */
  roster: readonly BotPickerChipBot[];
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Closes the menu when a pointer lands outside the chip container. */
  onDismissMenu: () => void;
  /** Picks this bot for the next conversation (a pure selection, no writes). */
  onSelect: (bot: BotPickerChipBot) => void;
  /**
   * Which way the roster menu opens. The composer row (historical host)
   * opens UP (`bottom-full`, the default); the surface-header host opens
   * DOWN (`top-full`) so the roster never climbs over the band row.
   */
  menuDirection?: 'up' | 'down';
}

const ChipIdentity: React.FC<{ metabot: BotPickerChipBot }> = ({ metabot }) => (
  <>
    {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
      <img src={metabot.avatar} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/10" />
    ) : (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-black/10 dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:ring-white/10">
        <span className="text-[10px] font-semibold uppercase dark:text-claude-darkText text-claude-text">
          {metabot.name.slice(0, 2) || '?'}
        </span>
      </div>
    )}
    <span className="min-w-0 truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
      {metabot.name}
    </span>
  </>
);

export interface BotPickerMenuRowProps {
  metabot: BotPickerChipBot;
  /** The currently selected bot row is highlighted, still re-selectable. */
  isSelected: boolean;
  onSelect: (bot: BotPickerChipBot) => void;
}

/** One row of the picker menu. Exported so its click path is unit-tested directly. */
export const BotPickerMenuRow: React.FC<BotPickerMenuRowProps> = ({
  metabot,
  isSelected,
  onSelect,
}) => (
  <button
    type="button"
    role="menuitem"
    aria-selected={isSelected}
    onClick={() => onSelect(metabot)}
    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
      isSelected
        ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:text-claude-text dark:hover:text-claude-darkText'
    }`}
  >
    <span className="h-5 w-5 shrink-0">
      {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
        <img src={metabot.avatar} alt="" className="h-5 w-5 rounded-md object-cover" />
      ) : (
        <span className="flex h-5 w-5 items-center justify-center rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
          <span className="text-[8px] font-semibold uppercase dark:text-claude-darkText text-claude-text">
            {metabot.name.slice(0, 2) || '?'}
          </span>
        </span>
      )}
    </span>
    <span className="min-w-0 flex-1 truncate font-medium">{metabot.name}</span>
    {metabot.role && (
      <span className="min-w-0 max-w-[45%] truncate text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {metabot.role}
      </span>
    )}
    {metabot.metabot_type === 'twin' && <TwinBadge className="shrink-0" />}
  </button>
);

const BotPickerChip: React.FC<BotPickerChipProps> = ({
  chipMetabot,
  roster,
  menuOpen,
  onToggleMenu,
  onDismissMenu,
  onSelect,
  menuDirection = 'up',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Outside-pointer dismissal (owner UX finding 2026-11-08). The listener is
  // bound only while the menu is open; a pointer on a menu row is inside the
  // container, so it does not dismiss — the row's own click runs afterwards.
  useEffect(() => {
    if (!menuOpen) return undefined;
    return bindSeatMenuOutsideDismiss({
      container: () => containerRef.current,
      onDismiss: onDismissMenu,
    });
  }, [menuOpen, onDismissMenu]);

  return (
    <div
      ref={containerRef}
      data-slot="bot-picker-container"
      className="relative flex min-w-0 max-w-full items-center"
    >
      <button
        type="button"
        aria-label={i18nService.t('botInternetBotPickerChip')}
        title={i18nService.t('botInternetBotPickerChip')}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={onToggleMenu}
        className="flex h-9 min-w-0 items-center gap-2 rounded-lg px-1.5 transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
      >
        <ChipIdentity metabot={chipMetabot} />
        {chipMetabot.metabot_type === 'twin' && <TwinBadge className="shrink-0" />}
        <svg viewBox="0 0 12 12" aria-hidden className="h-3 w-3 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <path d="M2 7.5 6 3.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menuOpen && (
        <div
          role="menu"
          data-slot="bot-picker-menu"
          data-menu-direction={menuDirection}
          className={`absolute left-0 z-40 w-72 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-2 shadow-lg ${
            menuDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
        >
          <p className="px-1 pb-1 text-xs font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('botInternetBotPickerTitle')}
          </p>
          <div className="max-h-52 overflow-y-auto">
            {roster.map((metabot) => (
              <BotPickerMenuRow
                key={metabot.id}
                metabot={metabot}
                isSelected={metabot.id === chipMetabot.id}
                onSelect={onSelect}
              />
            ))}
          </div>
          <p className="px-1 pt-1 text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('botInternetBotPickerHint')}
          </p>
        </div>
      )}
    </div>
  );
};

export default BotPickerChip;
