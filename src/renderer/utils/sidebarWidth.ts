export type SidebarWidthMode = 'home' | 'browser';

export const SIDEBAR_WIDTH_HOME_DEFAULT = 320;
export const SIDEBAR_WIDTH_BROWSER_DEFAULT = 400;
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 480;

const LEGACY_STORAGE_KEY = 'idbots.sidebarWidth';
const STORAGE_KEYS: Record<SidebarWidthMode, string> = {
  home: 'idbots.sidebarWidth.home',
  browser: 'idbots.sidebarWidth.browser',
};

export function defaultSidebarWidth(mode: SidebarWidthMode): number {
  return mode === 'browser' ? SIDEBAR_WIDTH_BROWSER_DEFAULT : SIDEBAR_WIDTH_HOME_DEFAULT;
}

export function sidebarWidthStorageKey(mode: SidebarWidthMode): string {
  return STORAGE_KEYS[mode];
}

export function clampSidebarWidth(width: number, windowWidth?: number): number {
  if (!Number.isFinite(width)) return defaultSidebarWidth('home');
  // With a window width the cap is "the right pane keeps its minimum width"
  // (fixed-width ruling below); without one the fixed 480 cap still applies
  // (pure callers / tests / SSR-ish use).
  const max = windowWidth == null ? SIDEBAR_WIDTH_MAX : maxSidebarWidthForWindow(windowWidth);
  return Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

// ── Fixed-width ruling (2026-11-11; supersedes the 2026-11-09 3:7 ratio cap
// for drag/resize behavior) ──
// The middle column is a FIXED, remembered pixel width per face (BotWorks /
// Studio persist independently). A window resize flexes ONLY the right pane:
// the column never re-scales with the window, so a width the user chose (or
// the per-face default) survives window changes and app restarts verbatim.
//
//   · Seam drag cap: the column may grow until the right pane would keep less
//     than RIGHT_PANE_MIN_WIDTH_PX, bounded above by SIDEBAR_WIDTH_MAX and
//     floored at SIDEBAR_WIDTH_MIN (the floor wins on very narrow windows —
//     there the auto-hide rule takes over instead of squeezing further).
//     This replaces the old 30%-of-window ratio cap, which pinned the column
//     at the cap on typical window sizes (Studio's 400 default > 3:7 cap at
//     the 1200 default window) and so made the seam drag one-directional.
//   · Window too narrow: when the right pane would drop below
//     RIGHT_PANE_MIN_WIDTH_PX the shell auto-hides the middle column (see
//     shouldAutoHideSidebar) instead of shrinking it, and restores it once
//     the window has room again (shouldAutoShowSidebar, with a hysteresis
//     band so a borderline window does not oscillate hide/show per pixel).
export const SIDEBAR_RAIL_WIDTH_PX = 64;
export const SIDEBAR_SEAM_WIDTH_PX = 4;
export const RIGHT_PANE_MIN_WIDTH_PX = 480;
export const SIDEBAR_AUTO_SHOW_HYSTERESIS_PX = 96;

/** Width of the middle+right area the seam divides, for a window width. */
export function splitWidthForWindow(windowWidth: number): number {
  if (!Number.isFinite(windowWidth)) return 0;
  return Math.max(0, windowWidth - SIDEBAR_RAIL_WIDTH_PX - SIDEBAR_SEAM_WIDTH_PX);
}

/** Width the right pane keeps when the middle column shows at this width. */
export function rightPaneWidthForWindow(windowWidth: number, sidebarWidth: number): number {
  if (!Number.isFinite(sidebarWidth)) return splitWidthForWindow(windowWidth);
  return Math.max(0, splitWidthForWindow(windowWidth) - sidebarWidth);
}

/**
 * Largest middle-column width a window of this size allows: the split minus
 * the right pane's minimum width, capped at SIDEBAR_WIDTH_MAX, never below
 * the minimum-width floor. On a window too narrow for the right-pane minimum
 * to leave 240px the floor wins (the auto-hide rule handles that case).
 */
export function maxSidebarWidthForWindow(windowWidth: number): number {
  return Math.max(
    SIDEBAR_WIDTH_MIN,
    Math.min(SIDEBAR_WIDTH_MAX, splitWidthForWindow(windowWidth) - RIGHT_PANE_MIN_WIDTH_PX),
  );
}

/**
 * The middle column auto-hides when the right pane would keep less than its
 * minimum comfortable width ("快看不到" — the main area is about to be
 * squeezed away). Hiding beats shrinking: the column's width is remembered,
 * so it must not be re-scaled by window size.
 */
export function shouldAutoHideSidebar(windowWidth: number, sidebarWidth: number): boolean {
  return rightPaneWidthForWindow(windowWidth, sidebarWidth) < RIGHT_PANE_MIN_WIDTH_PX;
}

/**
 * An auto-hidden column comes back only once the right pane has its minimum
 * width PLUS the hysteresis band, so a window hovering at the threshold does
 * not flicker hide/show on every resize pixel.
 */
export function shouldAutoShowSidebar(windowWidth: number, sidebarWidth: number): boolean {
  return rightPaneWidthForWindow(windowWidth, sidebarWidth) >= RIGHT_PANE_MIN_WIDTH_PX + SIDEBAR_AUTO_SHOW_HYSTERESIS_PX;
}

// Kept for the double-click snap target only: the snap eases the column to
// the 3:7 split of the live window (the drag cap no longer uses the ratio).
export const SIDEBAR_MAX_RATIO = 0.3;

/**
 * Double-click snap target: the 3:7 split for this window, floored at the
 * minimum width and capped by the live drag cap, so the snap can never land
 * somewhere a drag could not reach.
 */
export function sidebarSnapWidthForWindow(windowWidth: number): number {
  const ratio = Math.floor(splitWidthForWindow(windowWidth) * SIDEBAR_MAX_RATIO);
  return Math.min(maxSidebarWidthForWindow(windowWidth), Math.max(SIDEBAR_WIDTH_MIN, ratio));
}

/**
 * Load the persisted width for a surface mode. Bot Home and Bot Internet keep
 * independent widths so each surface restores its own comfortable size on
 * switch. A legacy single-key value (pre per-mode) seeds the home width.
 */
export function loadSidebarWidth(getItem: (key: string) => string | null, mode: SidebarWidthMode): number {
  const raw = getItem(STORAGE_KEYS[mode]);
  if (raw != null) return clampSidebarWidth(Number(raw));
  if (mode === 'home') {
    const legacy = getItem(LEGACY_STORAGE_KEY);
    if (legacy != null) return clampSidebarWidth(Number(legacy));
  }
  return defaultSidebarWidth(mode);
}
