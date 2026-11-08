import React, { useRef } from 'react';
import { i18nService } from '../../services/i18n';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
  /**
   * Light actions at the right end of the header bar (new session ✎, session
   * records ◷ on BotHub; the collapse control + update badge on BotWorks). The
   * bar owns the row so the switcher and the actions never read as two
   * separate control ladders.
   */
  actions?: React.ReactNode;
}

interface SurfaceSegment {
  id: BotBrowserSurfaceMode;
  label: string;
}

const segmentClass = (active: boolean) => [
  'non-draggable inline-flex h-7 min-w-0 items-center justify-center rounded-md px-2 text-xs font-medium leading-none transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40',
  active
    // The yellow surface fill comes straight from the accent tokens, the same
    // way the records scope tab does it (aesthetic pass 2026-11-08): the
    // free-standing primary-button class carries fixed rem padding and a 2 px
    // offset shadow that overflow a segmented cell and grow a grey second edge.
    ? 'bg-claude-accent text-claude-accentInk'
    : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText',
].join(' ');

/**
 * The ONE surface header bar (owner ruling 2026-11-08 22:19, superseding the
 * 21:31 pill + menu form): a 36 px shared row that sits directly below the
 * traffic-light strip on both faces. Left = the IDBots baseline two-cell
 * segmented switcher (BotHub | BotWorks, yellow fill on the current face);
 * right = the face's light actions. No three-ring mark, no chevron, no menu.
 *
 * Switching semantics are unchanged: the same two callbacks, a radiogroup with
 * two radios, aria-checked on the current face, roving tab stop and arrow-key
 * movement. Rendering only.
 */
const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  onSelectHome,
  onSelectBrowser,
  actions,
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
    <div
      data-slot="surface-header-bar"
      className="draggable flex h-9 w-full min-w-0 shrink-0 items-center gap-2 px-2.5"
    >
      <div
        ref={groupRef}
        data-slot="bot-browser-mode-segments"
        role="radiogroup"
        aria-label={`${i18nService.t('surfaceSwitcherLabel')}: ${segments[0].label} / ${segments[1].label}`}
        onKeyDown={handleKeyDown}
        className="non-draggable grid min-w-0 flex-1 grid-cols-2 gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/80 p-0.5 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
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
