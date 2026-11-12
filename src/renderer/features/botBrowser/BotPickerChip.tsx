import React, { useEffect, useRef } from 'react';
import TwinBadge from '../../components/metabots/TwinBadge';
import { i18nService } from '../../services/i18n';
import { bindSeatMenuOutsideDismiss } from './seatMenuDismiss';

/**
 * Shared Studio bot picker for the draft welcome and history filter. The host
 * owns the selection's meaning; this component owns roster-menu dismissal.
 */

export interface BotPickerChipBot {
  id: number;
  name: string;
  avatar: string | null;
  metabot_type: string;
  role?: string;
}

interface BotPickerChipProps {
  /** The currently presented bot. */
  chipMetabot: BotPickerChipBot;
  /** Every local bot, in roster order. */
  roster: readonly BotPickerChipBot[];
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Closes the menu when a pointer lands outside the chip container. */
  onDismissMenu: () => void;
  /** Hands the picked bot to the host without writing metabot_type. */
  onSelect: (bot: BotPickerChipBot) => void;
  /** Which way the roster menu opens from its host. */
  menuDirection?: 'up' | 'down';
  size?: 'default' | 'compact';
  ariaLabel?: string;
  menuHint?: string;
}

const ChipIdentity: React.FC<{ metabot: BotPickerChipBot; compact: boolean }> = ({ metabot, compact }) => (
  <>
    {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
      <img
        src={metabot.avatar}
        alt=""
        className={`${compact ? 'h-5 w-5 rounded-md' : 'h-8 w-8 rounded-full'} shrink-0 object-cover ring-1 ring-black/10 dark:ring-white/10`}
      />
    ) : (
      <div className={`${compact ? 'h-5 w-5 rounded-md' : 'h-8 w-8 rounded-full'} flex shrink-0 items-center justify-center ring-1 ring-black/10 dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:ring-white/10`}>
        <span className={`${compact ? 'text-[8px]' : 'text-[10px]'} font-semibold uppercase dark:text-claude-darkText text-claude-text`}>
          {metabot.name.slice(0, 2) || '?'}
        </span>
      </div>
    )}
    <span className={`min-w-0 truncate ${compact ? 'text-xs' : 'text-sm'} font-medium dark:text-claude-darkText text-claude-text`}>
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
  size = 'default',
  ariaLabel,
  menuHint,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const compact = size === 'compact';
  const resolvedAriaLabel = ariaLabel ?? i18nService.t('botInternetBotPickerChip');

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
      className={`relative flex min-w-0 items-center ${compact ? 'max-w-[160px]' : 'max-w-full'}`}
    >
      <button
        type="button"
        aria-label={resolvedAriaLabel}
        title={resolvedAriaLabel}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={onToggleMenu}
        className={`flex min-w-0 max-w-full items-center transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${
          compact ? 'h-7 gap-1.5 rounded-md px-1' : 'h-9 gap-2 rounded-lg px-1.5'
        }`}
      >
        <ChipIdentity metabot={chipMetabot} compact={compact} />
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
          {menuHint !== '' ? (
            <p className="px-1 pt-1 text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {menuHint ?? i18nService.t('botInternetBotPickerHint')}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default BotPickerChip;
