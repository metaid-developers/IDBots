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
  // With a window width the cap is the 3:7 seam ruling; without one the
  // legacy fixed 480 cap still applies (pure callers / tests / SSR-ish use).
  const max = windowWidth == null ? SIDEBAR_WIDTH_MAX : maxSidebarWidthForWindow(windowWidth);
  return Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

// ── 3:7 seam ruling (2026-11-09 fourth expansion order; supersedes the third
// order's 40:60, which superseded the never-shipped 50:50 wording) ──
// The seam drag/snap cap is a RATIO, not a fixed pixel cap: the middle column
// may grow until middle : right = 3 : 7 of the split the seam actually
// divides — window width minus the 64px icon rail minus the 4px seam track.
// The minimum-width floor (SIDEBAR_WIDTH_MIN) is untouched by the new cap.
export const SIDEBAR_RAIL_WIDTH_PX = 64;
export const SIDEBAR_SEAM_WIDTH_PX = 4;
export const SIDEBAR_MAX_RATIO = 0.3;

/** Width of the middle+right area the seam divides, for a window width. */
export function splitWidthForWindow(windowWidth: number): number {
  if (!Number.isFinite(windowWidth)) return 0;
  return Math.max(0, windowWidth - SIDEBAR_RAIL_WIDTH_PX - SIDEBAR_SEAM_WIDTH_PX);
}

/**
 * Largest middle-column width a window of this size allows: 30% of the split
 * (the 3 side of 3:7), floored, never below the minimum-width floor. On a
 * window too narrow for 30% to reach 240px the floor wins (min-width
 * constraint is preserved).
 */
export function maxSidebarWidthForWindow(windowWidth: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.floor(splitWidthForWindow(windowWidth) * SIDEBAR_MAX_RATIO));
}

/** Double-click snap target: exactly the 3:7 split for this window. */
export function sidebarSnapWidthForWindow(windowWidth: number): number {
  return maxSidebarWidthForWindow(windowWidth);
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
