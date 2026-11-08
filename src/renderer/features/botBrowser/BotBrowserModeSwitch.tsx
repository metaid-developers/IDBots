import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon, GlobeAltIcon, HomeIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { getSurfaceMenuModel } from '../../components/sidebar/sidebarNavigation.js';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
}

interface SurfaceMenuModelItem {
  id: BotBrowserSurfaceMode;
  label: string;
  subtitle: string;
}

const SurfaceEntryIcon: React.FC<{ id: BotBrowserSurfaceMode; className?: string }> = ({ id, className }) =>
  id === 'home'
    ? <HomeIcon className={className} />
    : <GlobeAltIcon className={className} />;

/**
 * The expanded surface menu — split out of the trigger so the two states can be
 * rendered independently (static-markup tests render it directly).
 *
 * Codex-style: every entry is a title line plus a muted subtitle line, the
 * current surface carries a ✓, and the whole list is one menu rather than the
 * old two-segment control. It opens BELOW the trigger now that the trigger is a
 * labelled capsule in the middle column's header (it used to open to the right
 * of an icon-only trigger standing in the 64 px rail).
 */
export const SurfaceModeMenu: React.FC<{
  open: boolean;
  mode: BotBrowserSurfaceMode;
  items: SurfaceMenuModelItem[];
  onSelect: (mode: BotBrowserSurfaceMode) => void;
}> = ({ open, mode, items, onSelect }) => {
  if (!open) return null;
  return (
    <div
      data-slot="surface-switch-menu"
      role="menu"
      aria-label={i18nService.t('surfaceSwitcherLabel')}
      className="non-draggable absolute left-0 top-[calc(100%+6px)] z-[60] w-[228px] overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-1 shadow-xl"
    >
      {items.map((item) => {
        const active = mode === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            data-slot="surface-switch-option"
            data-surface={item.id}
            onClick={() => onSelect(item.id)}
            className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
              active
                ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
                : 'hover:dark:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
            }`}
          >
            <SurfaceEntryIcon
              id={item.id}
              className={`mt-0.5 h-4 w-4 shrink-0 ${
                active
                  ? 'dark:text-claude-darkText text-claude-text'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
              }`}
            />
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate text-[13px] font-medium leading-tight ${
                  active
                    ? 'dark:text-claude-darkText text-claude-text'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
                }`}
              >
                {item.label}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {item.subtitle}
              </span>
            </span>
            {active && (
              <CheckIcon
                data-slot="surface-switch-check"
                aria-hidden
                className="mt-0.5 h-3.5 w-3.5 shrink-0 dark:text-claude-darkText text-claude-text"
              />
            )}
          </button>
        );
      })}
    </div>
  );
};

/**
 * Surface switcher for the middle column's header (owner ruling 2026-11-08
 * 14:15). It used to be an icon-only trigger in the 64 px rail; a named
 * capsule is what Codex uses, and the rail cannot hold a name.
 *
 * Closed state = ONE capsule: the current surface's name plus a chevron. The
 * menu is the only place both surfaces are listed, each with its subtitle, and
 * the current one is checked. The trigger's accessible name still names the
 * current surface, so the visible text is a bonus rather than the only cue.
 */
const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  onSelectHome,
  onSelectBrowser,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const items: SurfaceMenuModelItem[] = getSurfaceMenuModel({ t: (key: string) => i18nService.t(key) });
  const current = items.find((item) => item.id === mode) ?? items[0];

  const handleSelect = useCallback(
    (next: BotBrowserSurfaceMode) => {
      setOpen(false);
      if (next === 'home') onSelectHome();
      else onSelectBrowser();
    },
    [onSelectBrowser, onSelectHome],
  );

  // Outside click + Escape close the menu. Both listeners only exist while the
  // menu is open, so a closed header costs nothing.
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} data-slot="bot-browser-mode-bar" className="non-draggable relative min-w-0 shrink-0">
      <button
        type="button"
        data-slot="surface-switch-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${i18nService.t('surfaceSwitcherLabel')}: ${current.label}`}
        title={current.label}
        onClick={() => setOpen((value) => !value)}
        className={`non-draggable inline-flex h-7 max-w-[180px] items-center gap-1 rounded-lg border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
          open
            ? 'border-claude-accent/60 dark:border-claude-accent/60 dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text'
            : 'dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text hover:dark:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
        }`}
      >
        <span data-slot="surface-switch-current" className="min-w-0 truncate">
          {current.label}
        </span>
        <ChevronDownIcon
          className={`h-3 w-3 shrink-0 transition-transform dark:text-claude-darkTextSecondary text-claude-textSecondary ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <SurfaceModeMenu open={open} mode={mode} items={items} onSelect={handleSelect} />
    </div>
  );
};

export default BotBrowserModeSwitch;
