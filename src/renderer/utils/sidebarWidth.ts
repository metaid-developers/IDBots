export type SidebarWidthMode = 'home' | 'browser';

export const SIDEBAR_WIDTH_HOME_DEFAULT = 320;
export const SIDEBAR_WIDTH_BROWSER_DEFAULT = 400;
export const SIDEBAR_WIDTH_MIN = 240;
// Absolute ceiling for callers that have NO window width (pure callers /
// tests / SSR-ish use): clampSidebarWidth's one-argument form keeps the
// fixed-width cap. The live window-aware cap is the 50:50 rule below.
export const SIDEBAR_WIDTH_MAX = 480;

// ── Shared-width ruling (2026-11-11 evening, owner order ①) ──
// Studio (browser face) and BotWorks (home face) share ONE middle-column
// width: the seam position is a shell-level choice, not a per-face memory,
// so switching surfaces must never change the column width ("切界面宽度一致
// 不跳变"). One default, one storage key, one load path. The two per-face
// constants above survive as named history (imports elsewhere), but they no
// longer select different values.
export const SIDEBAR_WIDTH_DEFAULT = SIDEBAR_WIDTH_HOME_DEFAULT;

// The single shared storage key. It reuses the pre-per-mode legacy key so
// machines that predate the (now also retired) per-face keys restore their
// oldest remembered width rather than inventing one.
const SHARED_STORAGE_KEY = 'idbots.sidebarWidth';
// Retired per-face keys. They are never written again; they survive only as
// a migration seed — migrateSidebarWidthStorage copies the freshest face's
// value into the shared key exactly once, before the first read.
const LEGACY_PER_MODE_KEYS: Record<SidebarWidthMode, string> = {
  home: 'idbots.sidebarWidth.home',
  browser: 'idbots.sidebarWidth.browser',
};

export function defaultSidebarWidth(_mode: SidebarWidthMode): number {
  // The mode parameter is kept for call-site compatibility but no longer
  // selects: both faces restore the same width (shared-width ruling).
  return SIDEBAR_WIDTH_DEFAULT;
}

export function sidebarWidthStorageKey(_mode: SidebarWidthMode): string {
  // Both faces read AND write the same key (shared-width ruling).
  return SHARED_STORAGE_KEY;
}

export function clampSidebarWidth(width: number, windowWidth?: number): number {
  if (!Number.isFinite(width)) return defaultSidebarWidth('home');
  // With a window width the cap is the live 50:50 drag rule (below); without
  // one the fixed 480 cap still applies (pure callers / tests / SSR-ish use).
  const max = windowWidth == null ? SIDEBAR_WIDTH_MAX : maxSidebarWidthForWindow(windowWidth);
  return Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

// ── 50:50 drag-cap ruling (2026-11-11 evening, owner order ③; supersedes
// the same-day fixed-width 480px drag cap, which had itself superseded the
// 2026-11-09 3:7 ratio cap) ──
// The middle column is still a FIXED, remembered pixel width per the
// fixed-width ruling: a window resize flexes ONLY the right pane and the
// column never re-scales with the window. What changes is how far a manual
// drag may push it: the column may grow until it holds at most HALF the
// middle+right split (50:50 — "任意一侧最大 50%"). The right-pane minimum
// stays as the narrow-window safety net: below split 960 the 50% half would
// leave the right pane under its comfortable minimum, so the right-pane rule
// binds first and a drag can never push the column into auto-hide territory.
//   · Floored at SIDEBAR_WIDTH_MIN (the floor wins on very narrow windows —
//     there the auto-hide rule takes over instead of squeezing further).
//   · Double-click still snaps to the 3:7 baseline (SIDEBAR_MAX_RATIO), which
//     always sits under the 50:50 cap and is therefore always reachable.
//   · Window too narrow (right pane would drop below RIGHT_PANE_MIN_WIDTH_PX
//     with the column at its floor): the shell auto-hides the middle column
//     (shouldAutoHideSidebar) instead of shrinking it, and restores it once
//     the window has room again (shouldAutoShowSidebar, with a hysteresis
//     band so a borderline window does not oscillate hide/show per pixel).
export const SIDEBAR_RAIL_WIDTH_PX = 64;
export const SIDEBAR_SEAM_WIDTH_PX = 4;
export const RIGHT_PANE_MIN_WIDTH_PX = 480;
export const SIDEBAR_AUTO_SHOW_HYSTERESIS_PX = 96;

/** Manual-drag ceiling as a fraction of the middle+right split (50:50). */
export const SIDEBAR_MAX_DRAG_RATIO = 0.5;

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
 * Largest middle-column width a window of this size allows: HALF the split
 * (50:50), tightened by the right pane's minimum width on narrow windows,
 * floored at the minimum-width floor. On a window too narrow for the
 * right-pane minimum to leave 240px the floor wins (the auto-hide rule
 * handles that case).
 */
export function maxSidebarWidthForWindow(windowWidth: number): number {
  const split = splitWidthForWindow(windowWidth);
  const half = Math.floor(split * SIDEBAR_MAX_DRAG_RATIO);
  const rightPaneSafe = split - RIGHT_PANE_MIN_WIDTH_PX;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(half, rightPaneSafe));
}

/**
 * The middle column auto-hides when the right pane would keep less than its
 * minimum comfortable width ("快看不到" — the main area is about to be
 * squeezed away). Hiding beats shrinking: the column's width is remembered,
 * so it must not be re-scaled by window size. A drag can never trigger this
 * (the 50:50 cap keeps the right pane at its minimum or better); only a
 * window resize can.
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
// the 3:7 split of the live window (always under the 50:50 drag cap).
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

// ── First-run width (2026-11-13 owner request) ──
// The 320px shared default made the Studio conversation column cramped on a
// fresh install. A machine that has never stored a width now starts at ~38%
// of the middle+right split, kept between 380 and 480px and always under the
// live drag cap, so both the conversation and the browser beside it are
// comfortably visible on first launch at common window widths (1200px → 430,
// 1440px+ → 480, the stored-width ceiling). Stored widths are untouched.
export const SIDEBAR_FIRST_RUN_RATIO = 0.38;
export const SIDEBAR_FIRST_RUN_MIN = 380;
export const SIDEBAR_FIRST_RUN_MAX = SIDEBAR_WIDTH_MAX;

export function firstRunSidebarWidthForWindow(windowWidth: number): number {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return SIDEBAR_WIDTH_DEFAULT;
  const target = Math.floor(splitWidthForWindow(windowWidth) * SIDEBAR_FIRST_RUN_RATIO);
  const preferred = Math.min(SIDEBAR_FIRST_RUN_MAX, Math.max(SIDEBAR_FIRST_RUN_MIN, target));
  return Math.min(maxSidebarWidthForWindow(windowWidth), preferred);
}

/**
 * Seed the shared key with the first-run width when nothing was ever stored
 * (call after migrateSidebarWidthStorage). Persisting it once keeps the face
 * switch re-reads stable even if the window is resized later. Idempotent.
 */
export function seedFirstRunSidebarWidth(
  getItem: (key: string) => string | null,
  setItem: (key: string, value: string) => void,
  windowWidth: number,
): void {
  if (getItem(SHARED_STORAGE_KEY) != null) return;
  if (getItem(LEGACY_PER_MODE_KEYS.home) != null || getItem(LEGACY_PER_MODE_KEYS.browser) != null) return;
  setItem(SHARED_STORAGE_KEY, String(firstRunSidebarWidthForWindow(windowWidth)));
}

/**
 * Load the persisted width. Both faces read the SAME shared key (shared-width
 * ruling 2026-11-11 evening); the retired per-face keys answer only while the
 * shared key has never been written, so a machine upgrading from the per-face
 * build still restores its own face's last width until the migration seeds
 * the shared key. Fresh machines fall back to the one shared default.
 */
export function loadSidebarWidth(getItem: (key: string) => string | null, mode: SidebarWidthMode): number {
  const shared = getItem(SHARED_STORAGE_KEY);
  if (shared != null) return clampSidebarWidth(Number(shared));
  const perMode = getItem(LEGACY_PER_MODE_KEYS[mode]);
  if (perMode != null) return clampSidebarWidth(Number(perMode));
  return defaultSidebarWidth(mode);
}

/**
 * One-time migration: seed the shared key from the freshest remembered
 * per-face width BEFORE the first load, so the very first face switch already
 * reads one shared state and never jumps. Idempotent — a present shared key
 * is never overwritten, and a machine with nothing stored invents no seed.
 * Call this from the width state's initializer (synchronous localStorage).
 */
export function migrateSidebarWidthStorage(
  getItem: (key: string) => string | null,
  setItem: (key: string, value: string) => void,
): void {
  if (getItem(SHARED_STORAGE_KEY) != null) return;
  const seed = getItem(LEGACY_PER_MODE_KEYS.home) ?? getItem(LEGACY_PER_MODE_KEYS.browser);
  if (seed != null) setItem(SHARED_STORAGE_KEY, seed);
}
