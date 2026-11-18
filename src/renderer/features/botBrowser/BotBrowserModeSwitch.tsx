import React, { useRef } from 'react';
import { i18nService } from '../../services/i18n';
import MacWindowLights from './MacWindowLights';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
  /**
   * Content below the surface band. BotWorks supplies a compact right-aligned
   * action row; Studio supplies its taller identity-and-session-title header.
   */
  actions?: React.ReactNode;
  /**
   * Gap ABOVE the band row. macOS 42.375 — sized so the tray's visible top
   * edge lands on the bot-home panel's header divider (y=50.625; owner
   * baseline ruling 2026-11-15 08:27). Windows + browser face 36 — h-9,
   * strictly level with the right column's Windows title-bar strip (owner
   * alignment ruling 2026-11-17). Elsewhere 12 px of quiet air. An explicit
   * value is accepted so tests can pin the platform branches without a DOM.
   */
  topGapPx?: number;
}

interface SurfaceSegment {
  id: BotBrowserSurfaceMode;
  label: string;
}

/**
 * macOS: a 42.375 px strip precedes the band row (owner baseline change
 * 2026-11-15 08:27: the tray's visible top edge lands on the bot-home
 * panel's header divider line — measured y=50.625; 50.625 − tray centering
 * offset 7.25 − 1 px tray border = 42.375, supersedes the y=45 tabstrip
 * baseline). Windows + browser face: a 36 px strip, strictly level with the
 * right column's h-9 Windows title-bar strip (owner alignment ruling
 * 2026-11-17). The rail's top track mirrors BOTH tiers so the rail's avatar
 * slot stays aligned with the band row.
 */
export const TOP_GAP_MAC_PX = 42.375;
/**
 * Windows, browser face ONLY: 36 px = the `h-9` WindowTitleBar strip App.tsx
 * mounts at the top of the right column's browser pane (the
 * windowsStandaloneTitleBar form; owner alignment ruling 2026-11-17). That
 * strip exists only while the browser pane is visible — home/catalog faces
 * mount none — so win32 + any other face falls back to TOP_GAP_DEFAULT_PX.
 */
export const TOP_GAP_WINDOWS_PX = 36;
/** Everything else: no system corner to share, keep a quiet 12 px breath. */
export const TOP_GAP_DEFAULT_PX = 12;

/**
 * The platform's top gap, mode-aware (owner alignment ruling 2026-11-17):
 * darwin → MAC; win32 → WINDOWS only on the browser face — the right
 * column's 36 px h-9 strip exists only while that pane is visible, so win32
 * + any other face falls back to DEFAULT; everything else → DEFAULT.
 * Guarded for the static tests, which render this component in Node where
 * `window` does not exist.
 */
const readPlatformTopGapPx = (mode: BotBrowserSurfaceMode): number => {
  if (typeof window === 'undefined') return TOP_GAP_DEFAULT_PX;
  if (window.electron?.platform === 'darwin') return TOP_GAP_MAC_PX;
  if (window.electron?.platform === 'win32' && mode === 'browser') return TOP_GAP_WINDOWS_PX;
  return TOP_GAP_DEFAULT_PX;
};

const segmentClass = (active: boolean) => [
  'non-draggable inline-flex h-full min-w-0 items-center justify-center px-2 text-xs font-medium leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40',
  active
    // Flat accent fill + dark ink from the accent tokens. The v2 rect-flat
    // ruling (2026-11-14) retires the baseline's 3 px grey offset edge: the
    // selected face is carried by the fill alone, and the tray's 1 px border
    // does the layering the shadow used to do.
    ? 'bg-claude-accent text-claude-accentInk'
    : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText',
].join(' ');

/**
 * The ONE surface switcher, in the form of the owner's 2026-11-09 10:58
 * red-box order (superseding the 10:29 row-1 sketches), amended by the D-line
 * final ruling 2026-11-09 (identity moved to the rail's top slot):
 *
 *   [ traffic lights alone ]                          <- row 1: the lights'
 *                                                       own strip (38.75 px
 *                                                       on mac, sized to the
 *                                                       browser-tabstrip
 *                                                       divider line)
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
 *
 * Shape language v2 (owner ruling 2026-11-14, rect-flat family): the tray and
 * its two cells are rectangular now — the cells sit FLUSH (no tray padding and
 * no divider, exactly the reference `.seg`), the selected face is a flat accent
 * fill, and the old capsule radius plus the 3 px offset shadow are retired.
 * The tray clips its cells (overflow-hidden) so the fill's outer corners follow
 * the tray's 12 px arc and the 1 px border stays visible all the way round. An
 * inset fill (the earlier p-0.5) read as two square tiles pasted inside a
 * rounded frame — owner rejected that on 2026-11-14. The radiogroup semantics
 * above are deliberately untouched.
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
  const resolvedTopGapPx = topGapPx ?? readPlatformTopGapPx(mode);

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
          className="flex items-center"
        >
          {/* macOS draws its own mini lights here (main.ts hides the native
              buttons); other platforms render nothing. Owner gap-center
              ruling 2026-11-15 08:21: the dots center between the window
              content top and the tray's border-top — the pt offset lives in
              MacWindowLights. */}
          <MacWindowLights />
        </div>
      ) : null}
      {/* Row 2: the band — one full row BELOW the 52 px top-gap strip on
          macOS. The container stays a drag handle; the tray is the
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
          className="non-draggable grid h-10 min-w-0 flex-1 grid-cols-2 gap-0 overflow-hidden rounded-[var(--shape-radius-lg)] border border-claude-border/70 bg-claude-bg/80 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
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
        // Left inset rides the band's pl-2 rhythm so the Studio face's
        // left-aligned identity header starts on the tray's left edge;
        // BotWorks' compact actions are right-aligned and only see the
        // pr-2.5 (owner left-anchor order 2026-11-15).
        <div
          data-slot="surface-header-actions"
          className="non-draggable flex min-h-7 w-full items-center justify-end gap-0.5 pl-2 pr-2.5"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
};

export default BotBrowserModeSwitch;
