import React, { useRef } from 'react';
import { i18nService } from '../../services/i18n';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
  /**
   * Light actions that belong to the same header stack (new session ✎, session
   * records ◷ on BotHub; the collapse control + update badge on BotWorks).
   * The owner's 22:26 spec puts the segmented band on the TOP row and leaves
   * no room beside it, so the actions ride the row directly below the band —
   * right-aligned, still inside the same shared header.
   */
  actions?: React.ReactNode;
  /**
   * BotWorks is the FIRST window track, so the macOS traffic lights sit over
   * its top-left corner. The band starts to the RIGHT of the lights, on the
   * same row (owner 22:26 spec image), never on a second row below them.
   */
  trafficLightInset?: boolean;
}

interface SurfaceSegment {
  id: BotBrowserSurfaceMode;
  label: string;
}

const segmentClass = (active: boolean) => [
  'non-draggable inline-flex h-[34px] min-w-0 items-center justify-center rounded-[10px] px-2 text-xs font-medium leading-none transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40',
  active
    // Yellow fill + dark ink from the accent tokens, plus the baseline's 3 px
    // grey offset edge (the same `--btn-primary-edge` the primary button uses).
    // The band's 2 px padding + 1 px border leave exactly 3 px for that edge,
    // so the cell never overflows the tray the way the primary-button class did.
    ? 'bg-claude-accent text-claude-accentInk shadow-[3px_3px_0_var(--btn-primary-edge)]'
    : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText',
].join(' ');

/**
 * The ONE surface switcher, restored to the "switching band" form the owner
 * pointed at on 2026-11-08 22:26: a long two-cell band on the window's TOP
 * track, to the RIGHT of the traffic-light dots — not a second row below them.
 *
 *   [traffic lights] [ BotHub | BotWorks ]        <- top track, same row
 *                    [        actions       ]     <- actions row below
 *
 * Text only: no three-ring mark, no chevron, no menu. Labels are the finalized
 * BotHub | BotWorks. Semantics are unchanged: radiogroup + two radios,
 * aria-checked, one roving tab stop, Arrow/Home/End movement; the same two
 * callbacks drive the surface switch.
 */
const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  onSelectHome,
  onSelectBrowser,
  actions,
  trafficLightInset = false,
}) => {
  const groupRef = useRef<HTMLDivElement>(null);
  const segments: SurfaceSegment[] = [
    { id: 'browser', label: i18nService.t('botInternet') },
    { id: 'home', label: i18nService.t('botHome') },
  ];

  const select = (id: BotBrowserSurfaceMode) => {
    if (id === 'home') onSelectHome();
    else onSelectBrowser();
  };

  // A radiogroup keeps ONE tab stop; the arrow keys move both focus and the
  // checked face, which is the keyboard contract the old two-segment control
  // exposed before the menu detour.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, segments.findIndex((segment) => segment.id === mode));
    let nextIndex = currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = segments.length - 1;
    else {
      const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      nextIndex = (currentIndex + delta + segments.length) % segments.length;
    }
    const next = segments[nextIndex];
    select(next.id);
    const button = groupRef.current?.querySelector<HTMLButtonElement>(`[data-surface="${next.id}"]`);
    button?.focus();
  };

  return (
    <div data-slot="surface-header" className="draggable w-full min-w-0 shrink-0">
      <div
        data-slot="surface-header-bar"
        className={`flex h-[52px] w-full min-w-0 items-center ${
          // Both faces land the band's left edge on the SAME absolute x:
          // BotWorks 80 px (traffic-light safe area) and BotHub 64 px rail +
          // 16 px inset = 80 px. Top/height are the row's 52 px / band's 40 px
          // on both, so switching faces does not move the band.
          trafficLightInset ? 'pl-20 pr-2.5' : 'pl-4 pr-2.5'
        }`}
      >
        <div
          ref={groupRef}
          data-slot="bot-browser-mode-segments"
          role="radiogroup"
          aria-label={`${i18nService.t('surfaceSwitcherLabel')}: ${segments[0].label} / ${segments[1].label}`}
          onKeyDown={handleKeyDown}
          className="non-draggable grid h-10 min-w-0 flex-1 grid-cols-2 gap-1 rounded-xl border border-claude-border/70 bg-claude-bg/80 p-0.5 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
        >
          {segments.map((segment) => {
            const active = mode === segment.id;
            return (
              <button
                key={segment.id}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                data-slot="surface-switch-option"
                data-surface={segment.id}
                className={segmentClass(active)}
                onClick={() => select(segment.id)}
              >
                {segment.label}
              </button>
            );
          })}
        </div>
      </div>
      {actions ? (
        <div
          data-slot="surface-header-actions"
          className="non-draggable flex h-7 w-full items-center justify-end gap-0.5 px-2.5"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
};

export default BotBrowserModeSwitch;
