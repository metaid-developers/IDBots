import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toRenderableAvatarSource } from '../../utils/avatarSource';
import { ChevronDownIcon, CpuChipIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import TwinBadge from '../metabots/TwinBadge';
import { i18nService } from '../../services/i18n';
import { placePopoverAbove, placePopoverBelow, useAnchorMoveWatcher } from '../../utils/anchoredPopover';

/**
 * Minimal bot row shared by the bot pickers and the by-Bot session view.
 * `created_at` (bot creation time, drives the by-Bot view's group order) is
 * optional because the composer-side providers of this type predate it; the
 * getMetaBots IPC always fills it in.
 */
export type MetaBotForSelector = {
  id: number;
  name: string;
  avatar: string | null;
  metabot_type: string;
  created_at?: number;
  role?: string;
};

/**
 * `selectedId` value of the leading "All Bots" entry that `allowAll` adds. A
 * negative id is safe as the sentinel: real metabot ids are positive rowids.
 */
export const ALL_METABOTS_SELECTOR_ID = -1;

/** Per-entry conversation counts for the option rows' right side; 'all' keys
 * the All Bots entry (only rendered when `allowAll` is on). */
export type MetaBotSessionCounts = Partial<Record<number | 'all', number>>;

/** Per-entry unread counts for the option rows' unread indicator; 'all' keys
 * the All Bots entry (only rendered when `allowAll` is on). */
export type MetaBotUnreadCounts = Partial<Record<number | 'all', number>>;

interface MetaBotSelectorProps {
  metabots: MetaBotForSelector[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  label: string;
  placeholder: string;
  /** Compact rendering for narrow surfaces (e.g. the Bot Browser side panel). */
  compact?: boolean;
  dropdownDirection?: 'up' | 'down';
  /**
   * Prepend an "All Bots" entry to the list. Picking it reports
   * ALL_METABOTS_SELECTOR_ID through onSelect — the "no bot filter" choice for
   * surfaces that scope a list by bot (the online-chats tab). Bot ids stay the
   * only other values, so callers that leave this off see no difference.
   */
  allowAll?: boolean;
  /**
   * Conversation counts rendered on the right of each option (and on the All
   * Bots entry). Omitted entries render no count; surfaces without per-bot
   * counts (the composers) simply leave this off.
   */
  sessionCounts?: MetaBotSessionCounts;
  /**
   * Unread counts for the unread indicator (yellow dot) on each option (and on
   * the All Bots entry). Omitted entries or zero counts render no indicator;
   * surfaces without unread tracking simply leave this off.
   */
  unreadCounts?: MetaBotUnreadCounts;
  /**
   * Render the dropdown with `position: fixed` anchored to the trigger so it
   * escapes `overflow-hidden` / scrollable ancestors (e.g. the sidebar session
   * list). Mirrors ModelEffortPicker's flag for the same reason.
   */
  useFixedDropdown?: boolean;
  /**
   * Disable the selector (e.g., during async operations).
   */
  disabled?: boolean;
}

/** The fixed-mode dropdown never shrinks below this, so option rows keep room
 * for the name + count; wider triggers widen it instead. */
const FIXED_DROPDOWN_MIN_WIDTH = 208;

const MetaBotSelector: React.FC<MetaBotSelectorProps> = ({
  metabots,
  selectedId,
  onSelect,
  label,
  placeholder,
  compact = false,
  dropdownDirection = 'down',
  allowAll = false,
  sessionCounts,
  unreadCounts,
  useFixedDropdown = false,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Fixed-mode placement (see useFixedDropdown): computed after the dropdown
  // lays out so the measured height keeps it inside the viewport.
  const [fixedDropdownStyle, setFixedDropdownStyle] = useState<React.CSSProperties | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const isAllSelected = allowAll && selectedId === ALL_METABOTS_SELECTOR_ID;
  const selected = isAllSelected ? null : metabots.find((m) => m.id === selectedId) ?? metabots[0];

  const updateFixedDropdownPlacement = useCallback(() => {
    const anchorRect = triggerRef.current?.getBoundingClientRect() ?? null;
    const dropdownRect = dropdownRef.current?.getBoundingClientRect();
    const width = Math.max(anchorRect?.width ?? 0, FIXED_DROPDOWN_MIN_WIDTH);
    const size = dropdownRect ? { width: dropdownRect.width, height: dropdownRect.height } : { width };
    const placement = dropdownDirection === 'up'
      ? placePopoverAbove(anchorRect, size, width)
      : placePopoverBelow(anchorRect, size, width);
    setFixedDropdownStyle({ position: 'fixed', top: placement.top, left: placement.left, width: placement.width });
  }, [dropdownDirection]);

  useLayoutEffect(() => {
    if (!isOpen || !useFixedDropdown) {
      setFixedDropdownStyle(null);
      return;
    }
    updateFixedDropdownPlacement();
  }, [isOpen, useFixedDropdown, updateFixedDropdownPlacement]);

  useEffect(() => {
    if (!isOpen || !useFixedDropdown) return;
    const handle = () => updateFixedDropdownPlacement();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [isOpen, useFixedDropdown, updateFixedDropdownPlacement]);

  // Re-place when the trigger MOVES without any window-level event (sidebar
  // width drag, list rows mounting above the trigger).
  useAnchorMoveWatcher(triggerRef, isOpen && useFixedDropdown, updateFixedDropdownPlacement);

  const avatarSize = compact ? 'w-5 h-5' : 'w-7 h-7';
  const avatarIcon = compact ? 'h-3 w-3' : 'h-4 w-4';
  const buttonClass = compact
    ? 'w-full flex items-center gap-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border px-2 py-1 text-xs focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/40 cursor-pointer'
    : 'w-full flex items-center gap-2 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border px-5 py-3 text-base focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/40 cursor-pointer';
  const optionClass = compact
    ? 'w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors'
    : 'w-full flex items-center gap-2 px-5 py-3 text-left text-base hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors';
  const countClass = 'flex-shrink-0 text-[10px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary';

  const renderAllAvatar = (sizeClass: string, iconClass: string) => (
    <div className={`${sizeClass} rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0`}>
      <Squares2X2Icon className={`${iconClass} dark:text-claude-darkTextSecondary text-claude-textSecondary`} />
    </div>
  );

  const renderAvatar = (bot: MetaBotForSelector) => (
    toRenderableAvatarSource(bot.avatar) ? (
      <img src={toRenderableAvatarSource(bot.avatar)!} alt="" className={`${avatarSize} rounded-md object-cover flex-shrink-0`} />
    ) : (
      <div className={`${avatarSize} rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0`}>
        {compact ? (
          <span className="text-[8px] font-semibold dark:text-claude-darkText text-claude-text uppercase">
            {bot.name.slice(0, 2) || '?'}
          </span>
        ) : (
          <CpuChipIcon className={`${avatarIcon} dark:text-claude-darkTextSecondary text-claude-textSecondary`} />
        )}
      </div>
    )
  );

  const allLabel = i18nService.t('sessionBotFilterAllBots');
  const countTitle = (count: number) => `${count} ${i18nService.t('sessionBotOptionSessions')}`;
  const currentLabel = isAllSelected ? allLabel : selected?.name ?? placeholder;

  const commit = (id: number) => {
    onSelect(id);
    setIsOpen(false);
  };

  return (
    <div className={compact ? 'flex items-center min-w-0' : 'flex items-center justify-center gap-3'}>
      {!compact && (
        <label className="text-sm font-medium dark:text-claude-darkText text-claude-text shrink-0">
          {label}
        </label>
      )}
      <div ref={containerRef} className={`relative ${compact ? 'min-w-0 flex-1' : 'min-w-[280px]'}`}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={buttonClass}
          aria-label={placeholder}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          title={compact ? `${label}: ${currentLabel}` : undefined}
          disabled={disabled}
        >
          {isAllSelected ? (
            <>
              {renderAllAvatar(avatarSize, avatarIcon)}
              <span className="truncate flex-1 text-left">{allLabel}</span>
            </>
          ) : selected ? (
            <>
              {renderAvatar(selected)}
              <span className="truncate flex-1 text-left">{selected.name}</span>
              {selected.metabot_type === 'twin' && <TwinBadge className="shrink-0" />}
            </>
          ) : (
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{placeholder}</span>
          )}
          <ChevronDownIcon className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {isOpen && (
          <div
            ref={dropdownRef}
            role="listbox"
            data-testid="metabot-selector-dropdown"
            className={useFixedDropdown
              ? 'fixed z-50 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover overflow-hidden max-h-56 overflow-y-auto'
              : `absolute left-0 right-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover z-50 overflow-hidden max-h-56 overflow-y-auto ${
                  dropdownDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
                }`}
            style={useFixedDropdown ? (fixedDropdownStyle ?? { visibility: 'hidden' }) : undefined}
          >
            {allowAll && (
              <button
                type="button"
                role="option"
                aria-selected={isAllSelected}
                data-testid="metabot-selector-all"
                onClick={() => commit(ALL_METABOTS_SELECTOR_ID)}
                className={`${optionClass} ${isAllSelected ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
              >
                {renderAllAvatar(avatarSize, avatarIcon)}
                <span className="truncate flex-1 flex items-center gap-1.5">
                  {allLabel}
                  {(unreadCounts?.all ?? 0) > 0 && (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0" aria-hidden />
                  )}
                </span>
                {sessionCounts?.all != null && (
                  <span className={countClass} title={countTitle(sessionCounts.all)}>
                    {sessionCounts.all}
                  </span>
                )}
              </button>
            )}
            {metabots.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={!isAllSelected && selectedId === m.id}
                data-testid="metabot-selector-option"
                onClick={() => commit(m.id)}
                className={`${optionClass} ${!isAllSelected && selectedId === m.id ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
              >
                {renderAvatar(m)}
                <span className="truncate flex-1 flex items-center gap-1.5">
                  {m.name}
                  {(unreadCounts?.[m.id] ?? 0) > 0 && (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0" aria-hidden />
                  )}
                </span>
                {sessionCounts?.[m.id] != null && (
                  <span className={countClass} title={countTitle(sessionCounts[m.id])}>
                    {sessionCounts[m.id]}
                  </span>
                )}
                {m.metabot_type === 'twin' ? (
                  <TwinBadge className="shrink-0" />
                ) : (
                  <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
                    ({m.metabot_type})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default MetaBotSelector;
