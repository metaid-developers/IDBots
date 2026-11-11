import React, { useEffect, useRef } from 'react';
import TwinBadge from '../../components/metabots/TwinBadge';
import { i18nService } from '../../services/i18n';
import { bindSeatMenuOutsideDismiss } from './seatMenuDismiss';

/**
 * Draft-state bot picker for the Studio surface header row (owner 18:21
 * final ruling 2026-11-11, item ⑦ rework: the chip moved UP from the
 * composer's top-left row into the shared surface-header actions row,
 * leftmost, ahead of the session name). Clicking the chip opens the menu
 * listing every local bot, and picking one selects which bot runs the NEXT
 * conversation, exactly like the BotWorks new-task bot picker. It never
 * writes `metabot_type`: the Twin appointment is owned by the My Bots
 * editor alone.
 *
 * Supersession note (v3 close wiring, same day): this component used to
 * also carry the live session's display-only identity branch. That role
 * now belongs to CoworkSurfaceIdentityBadge (roster-authoritative
 * resolution with the session summary row as fallback) — the panel renders
 * the badge for live sessions and this chip for drafts, so a live
 * transcript can never grow a menu trigger.
 *
 * The component is intentionally presentational: the selection state and its
 * wiring live in BotBrowserCoworkPanel.tsx (which portals this chip into the
 * header anchor). The one browser behavior it owns is menu dismissal: a
 * pointer anywhere outside the chip container closes the menu (logic in
 * seatMenuDismiss.ts, unit-tested with a fake pointer target).
 */

export interface BotPickerChipBot {
  id: number;
  name: string;
  avatar: string | null;
  metabot_type: string;
  role?: string;
}

interface BotPickerChipProps {
  /** The bot the footer currently shows (the draft pick). */
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
      <img src={metabot.avatar} alt="" className="h-5 w-5 rounded-md object-cover flex-shrink-0" />
    ) : (
      <div className="h-5 w-5 rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0">
        <span className="text-[8px] font-semibold dark:text-claude-darkText text-claude-text uppercase">
          {metabot.name.slice(0, 2) || '?'}
        </span>
      </div>
    )}
    <span className="truncate text-xs font-medium dark:text-claude-darkText text-claude-text">
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
      className="relative flex min-w-0 max-w-[60%] items-center gap-1.5"
    >
      <button
        type="button"
        aria-label={i18nService.t('botInternetBotPickerChip')}
        title={i18nService.t('botInternetBotPickerChip')}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={onToggleMenu}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
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
