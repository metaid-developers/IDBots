import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon, GlobeAltIcon, HomeIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { getSurfaceMenuModel } from '../../components/sidebar/sidebarNavigation.js';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
  /**
   * Light actions at the right end of the header bar (new session ✎, session
   * records ◷ on BotHub; the records search + shell badges on BotWorks). The
   * bar owns the row so the switcher and the actions never read as two
   * separate control ladders.
   */
  actions?: React.ReactNode;
  /**
   * BotWorks is the FIRST window track, so the macOS traffic lights sit over
   * its top-left corner. That mount reserves 68 px before the trigger; the
   * BotHub mount starts next to the 64 px rail and needs no reservation.
   */
  trafficLightInset?: boolean;
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
 * The house three-ring mark worn by the surface pill (owner spec 2026-11-08
 * 21:31: "三环 logo + 当前面名 + 右侧轻量动作位"). Three concentric rings are
 * drawn with currentColor only — no imported palette — so the mark inherits
 * the pill's own state (rest / hover / open) like every other glyph here.
 */
export const SurfaceBrandMark: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    data-slot="surface-brand-mark"
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    className={className}
  >
    <circle cx="10" cy="10" r="8.2" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="10" cy="10" r="5.1" stroke="currentColor" strokeWidth="1.2" opacity="0.62" />
    <circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.2" opacity="0.34" />
  </svg>
);

/**
 * The expanded surface menu — split out of the trigger so the two states can be
 * rendered independently (static-markup tests render it directly).
 *
 * Codex-style: every entry is a title line plus a muted subtitle line, the
 * current surface carries a ✓, and the whole list is one menu rather than the
 * old two-segment control. It opens BELOW the trigger (the trigger is a
 * labelled pill at the left end of a full-width header bar).
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
      className="non-draggable absolute left-0 top-full z-[60] mt-1.5 w-56 overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-1 shadow-xl"
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
 * The ONE surface header bar (owner spec 2026-11-08 21:31). It used to be a
 * loose capsule dropped into whichever header happened to host it (the mid
 * column's h-9 band on BotHub, a padded block under the drag row on BotWorks).
 * Both faces now mount this same 36 px bar at the top of their first content
 * column, so the switcher reads as the window's own title-row control:
 *
 *   [three-ring mark  BotHub ⌄]                    [light actions…]
 *
 * The bar carries the drag region; every control inside is non-draggable. The
 * trigger keeps its old accessible contract (haspopup / expanded / pressed
 * label naming the current surface) — this is a rendering change only.
 */
const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  onSelectHome,
  onSelectBrowser,
  actions,
  trafficLightInset = false,
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
    <div
      data-slot="surface-header-bar"
      className={`draggable flex h-9 w-full min-w-0 shrink-0 items-center gap-1 ${
        trafficLightInset ? 'pl-20 pr-2.5' : 'px-2.5'
      }`}
    >
      <div ref={rootRef} data-slot="bot-browser-mode-bar" className="non-draggable relative min-w-0 shrink-0">
        <button
          type="button"
          data-slot="surface-switch-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${i18nService.t('surfaceSwitcherLabel')}: ${current.label}`}
          title={current.label}
          onClick={() => setOpen((value) => !value)}
          className={`non-draggable inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
            open
              ? 'border-claude-accent/60 dark:border-claude-accent/60 dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
              : 'dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text hover:dark:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
          }`}
        >
          <SurfaceBrandMark
            className="h-4 w-4 shrink-0 text-claude-accent"
          />
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
      {actions ? (
        <div
          data-slot="surface-header-actions"
          className="non-draggable ml-auto flex min-w-0 shrink-0 items-center gap-0.5"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
};

export default BotBrowserModeSwitch;
