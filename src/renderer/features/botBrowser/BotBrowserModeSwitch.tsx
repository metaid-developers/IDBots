import React, { useRef } from 'react';
import { i18nService } from '../../services/i18n';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
  /**
   * Light actions that belong to the same header stack (new session ✎, session
   * records ◷ on Studio; the update badge on BotWorks since the 侧栏微调批单
   * 2026-11-09 12:23 — its records search lives in the 按 Bot toolbar row and
   * its collapse control is the shell's seam tab, not this header).
   * They ride the row directly below the band — right-aligned, still inside
   * the same shared header.
   */
  actions?: React.ReactNode;
  /**
   * Gap ABOVE the band row. macOS 52 — a traffic-light strip as tall as the
   * rail's mac top track, so the band row starts exactly at the lights row's
   * bottom edge (the lights, trafficLightPosition y=20, never share the
   * band's row). Elsewhere 12 px of quiet air. An explicit value is accepted
   * so tests can pin BOTH platform branches without a DOM.
   */
  topGapPx?: number;
}

interface SurfaceSegment {
  id: BotBrowserSurfaceMode;
  label: string;
}

/**
 * macOS: a 52 px traffic-light strip precedes the band row — the same height
 * as the rail's mac top track, so the band row starts exactly at the strip's
 * bottom edge and the lights (trafficLightPosition y=20) own the first row
 * alone (owner red-box order 2026-11-09 10:58).
 */
export const TOP_GAP_MAC_PX = 52;
/** Non-macOS: no system corner to share, keep a quiet 12 px breath. */
export const TOP_GAP_DEFAULT_PX = 12;

/**
 * The platform's top gap. Guarded for the static tests, which render this
 * component in Node where `window` does not exist.
 */
const readPlatformTopGapPx = (): number => {
  if (typeof window === 'undefined') return TOP_GAP_DEFAULT_PX;
  return window.electron?.platform === 'darwin' ? TOP_GAP_MAC_PX : TOP_GAP_DEFAULT_PX;
};

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
 * The ONE surface switcher, in the form of the owner's 2026-11-09 10:58
 * red-box order (superseding the 10:29 row-1 sketches), amended by the D-line
 * final ruling 2026-11-09 (identity moved to the rail's top slot):
 *
 *   [ traffic lights alone ]                          <- row 1: the lights'
 *                                                       own 52 px strip
 *   [ Studio | BotWorks ]                             <- row 2: the band, BELOW
 *                                                      the lights row — no
 *                                                      identity slot here any
 *                                                      more (the avatar lives
 *                                                      in the rail's top slot)
 *   [rail icons / menu]              [ actions ]      <- row 3: content + actions
 *
 * The band row moved DOWN one row: no avatar entry and no band inside the
 * traffic lights' row on macOS. Because the lights no longer share the band's
 * row, the old 64 px horizontal lights reserve is retired — both faces use
 * the same small column inset. The identity entry does not ride this header
 * at all any more: it is WorkspaceRail's top avatar slot. Text only: no
 * three-ring mark, no chevron, no menu. Labels are the finalized
 * Studio | BotWorks. Semantics are unchanged: radiogroup + two radios,
 * aria-checked, one roving tab stop, Arrow/Home/End movement; the same two
 * callbacks drive the switch.
 */
const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  onSelectHome,
  onSelectBrowser,
  actions,
  topGapPx,
}) => {
  const groupRef = useRef<HTMLDivElement>(null);
  const segments: SurfaceSegment[] = [
    { id: 'browser', label: i18nService.t('botInternet') },
    { id: 'home', label: i18nService.t('botHome') },
  ];

  // The lights no longer share the band's row, so no face needs a horizontal
  // lights reserve: both columns start the row at their own small inset.
  const resolvedTopGapPx = topGapPx ?? readPlatformTopGapPx();

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
      {resolvedTopGapPx > 0 ? (
        <div
          data-slot="surface-header-top-gap"
          data-top-gap-px={resolvedTopGapPx}
          style={{ height: `${resolvedTopGapPx}px` }}
        />
      ) : null}
      {/* Row 2: the band — one full row BELOW the traffic lights' 52 px strip
          on macOS. The container stays a drag handle; the tray is the
          non-draggable content. The identity avatar does NOT ride this row
          any more (owner D-line final ruling 2026-11-09): it lives in the
          rail's top slot (WorkspaceRail workspace-rail-avatar-slot). */}
      <div
        data-slot="surface-header-bar"
        className="draggable flex h-[52px] w-full min-w-0 items-center gap-2 pl-2 pr-2.5"
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
