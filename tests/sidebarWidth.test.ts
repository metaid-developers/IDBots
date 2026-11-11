import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampSidebarWidth,
  defaultSidebarWidth,
  loadSidebarWidth,
  maxSidebarWidthForWindow,
  rightPaneWidthForWindow,
  shouldAutoHideSidebar,
  shouldAutoShowSidebar,
  sidebarSnapWidthForWindow,
  sidebarWidthStorageKey,
  splitWidthForWindow,
  RIGHT_PANE_MIN_WIDTH_PX,
  SIDEBAR_AUTO_SHOW_HYSTERESIS_PX,
  SIDEBAR_RAIL_WIDTH_PX,
  SIDEBAR_SEAM_WIDTH_PX,
  SIDEBAR_WIDTH_BROWSER_DEFAULT,
  SIDEBAR_WIDTH_HOME_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../src/renderer/utils/sidebarWidth';

test('clampSidebarWidth clamps to the 240–480 range and rounds', () => {
  assert.equal(clampSidebarWidth(100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(1000), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth(288), 288);
  assert.equal(clampSidebarWidth(300.6), 301);
});

test('clampSidebarWidth falls back to the home default for non-finite input', () => {
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_WIDTH_HOME_DEFAULT);
  assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY), SIDEBAR_WIDTH_HOME_DEFAULT);
});

test('each mode has its own default and storage key', () => {
  assert.equal(defaultSidebarWidth('home'), SIDEBAR_WIDTH_HOME_DEFAULT);
  assert.equal(defaultSidebarWidth('browser'), SIDEBAR_WIDTH_BROWSER_DEFAULT);
  assert.notEqual(sidebarWidthStorageKey('home'), sidebarWidthStorageKey('browser'));
});

test('loadSidebarWidth reads per-mode values independently', () => {
  const store = new Map([
    [sidebarWidthStorageKey('home'), '300'],
    [sidebarWidthStorageKey('browser'), '420'],
  ]);
  const getItem = (key) => store.get(key) ?? null;
  assert.equal(loadSidebarWidth(getItem, 'home'), 300);
  assert.equal(loadSidebarWidth(getItem, 'browser'), 420);
});

test('loadSidebarWidth falls back to per-mode defaults and the legacy key for home', () => {
  assert.equal(loadSidebarWidth(() => null, 'browser'), SIDEBAR_WIDTH_BROWSER_DEFAULT);
  assert.equal(loadSidebarWidth(() => null, 'home'), SIDEBAR_WIDTH_HOME_DEFAULT);

  const legacyOnly = (key) => (key === 'idbots.sidebarWidth' ? '350' : null);
  assert.equal(loadSidebarWidth(legacyOnly, 'home'), 350);
  // The legacy single key never seeds the browser width.
  assert.equal(loadSidebarWidth(legacyOnly, 'browser'), SIDEBAR_WIDTH_BROWSER_DEFAULT);
});

test('loadSidebarWidth clamps stored values', () => {
  const getItem = (key) => (key === sidebarWidthStorageKey('home') ? '10' : null);
  assert.equal(loadSidebarWidth(getItem, 'home'), SIDEBAR_WIDTH_MIN);
});

// ── Fixed-width ruling (2026-11-11; supersedes the 2026-11-09 3:7 ratio cap
// for drag/resize behavior) ──

test('splitWidthForWindow subtracts rail and seam tracks and floors at 0', () => {
  assert.equal(splitWidthForWindow(1440), 1440 - SIDEBAR_RAIL_WIDTH_PX - SIDEBAR_SEAM_WIDTH_PX);
  // 100 − (64 + 4) = 32: still positive, passes through.
  assert.equal(splitWidthForWindow(100), 32);
  // At or below rail+seam the split floors at 0.
  assert.equal(splitWidthForWindow(SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_SEAM_WIDTH_PX), 0);
  assert.equal(splitWidthForWindow(50), 0);
  assert.equal(splitWidthForWindow(Number.NaN), 0);
});

test('maxSidebarWidthForWindow leaves the right pane its minimum width, capped at 480, floored at the min width', () => {
  // 1440 → split 1372 → 1372 − 480 = 892 → the absolute 480 cap wins: both
  // faces can always drag WIDER from their defaults (the Studio one-way seam
  // fix — the old 30% ratio cap gave only 411 here).
  assert.equal(maxSidebarWidthForWindow(1440), SIDEBAR_WIDTH_MAX);
  // Default 1200 window: split 1132 → 652 → capped at 480.
  assert.equal(maxSidebarWidthForWindow(1200), SIDEBAR_WIDTH_MAX);
  // 1000 → split 932 → 452: the right-pane minimum rules below the cap.
  assert.equal(maxSidebarWidthForWindow(1000), 452);
  // A window too narrow for the right-pane minimum to leave 240px: the
  // minimum-width floor wins (the auto-hide rule takes over from there).
  assert.equal(maxSidebarWidthForWindow(700), SIDEBAR_WIDTH_MIN);
  assert.equal(maxSidebarWidthForWindow(300), SIDEBAR_WIDTH_MIN);
  assert.equal(maxSidebarWidthForWindow(SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_SEAM_WIDTH_PX), SIDEBAR_WIDTH_MIN);
});

test('clampSidebarWidth caps at the right-pane-minimum rule when a window width is given', () => {
  const cap = maxSidebarWidthForWindow(1440);
  assert.equal(cap, SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth(600, 1440), cap);
  // 700 → the right-pane minimum leaves < 240 → the floor wins.
  assert.equal(clampSidebarWidth(600, 700), SIDEBAR_WIDTH_MIN);
  // Even on very wide windows the absolute 480 cap holds (1920 → 480, not
  // the old ratio's 555): the column is a fixed-size records list, the
  // right pane flexes.
  assert.equal(clampSidebarWidth(600, 1920), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth(100, 1440), SIDEBAR_WIDTH_MIN);
  // Exactly at the cap passes through unchanged.
  assert.equal(clampSidebarWidth(cap, 1440), cap);
  // The Studio default (400) fits under the cap at the default 1200 window —
  // the launch clamp no longer pins it, so the seam drags both ways.
  assert.ok(SIDEBAR_WIDTH_BROWSER_DEFAULT < maxSidebarWidthForWindow(1200));
  assert.ok(SIDEBAR_WIDTH_HOME_DEFAULT < maxSidebarWidthForWindow(1200));
});

test('clampSidebarWidth keeps the 480 cap when no window width is given', () => {
  // Back-compat contract for pure callers: one argument = the old behavior.
  assert.equal(clampSidebarWidth(1000), SIDEBAR_WIDTH_MAX);
});

test('sidebarSnapWidthForWindow is the 3:7 split clamped into the drag range', () => {
  // 1440 → split 1372 → 30% = 411 (under the 480 cap).
  assert.equal(sidebarSnapWidthForWindow(1440), 411);
  // 700 → 30% = 189, below the 240 floor → the floor wins.
  assert.equal(sidebarSnapWidthForWindow(700), SIDEBAR_WIDTH_MIN);
  // 1920 → 30% = 555, over the drag cap → the cap wins.
  assert.equal(sidebarSnapWidthForWindow(1920), SIDEBAR_WIDTH_MAX);
});

test('rightPaneWidthForWindow subtracts the column from the split, floored at 0', () => {
  assert.equal(rightPaneWidthForWindow(1200, 400), 1200 - SIDEBAR_RAIL_WIDTH_PX - SIDEBAR_SEAM_WIDTH_PX - 400);
  assert.equal(rightPaneWidthForWindow(500, 480), 0);
  assert.equal(rightPaneWidthForWindow(1200, Number.NaN), splitWidthForWindow(1200));
});

test('shouldAutoHideSidebar fires only when the right pane drops below its minimum width', () => {
  // Default window, Studio default width: right = 732 — plenty of room.
  assert.equal(shouldAutoHideSidebar(1200, SIDEBAR_WIDTH_BROWSER_DEFAULT), false);
  // 948 → split 880 → right exactly 480: NOT hidden (boundary is inclusive).
  assert.equal(shouldAutoHideSidebar(948, SIDEBAR_WIDTH_BROWSER_DEFAULT), false);
  // 947 → right 479 < 480 → the column hides instead of shrinking.
  assert.equal(shouldAutoHideSidebar(947, SIDEBAR_WIDTH_BROWSER_DEFAULT), true);
  // BotWorks width 320 at an 860 window: right = 792 − 320 = 472 < 480.
  assert.equal(shouldAutoHideSidebar(860, SIDEBAR_WIDTH_HOME_DEFAULT), true);
});

test('shouldAutoShowSidebar requires the hysteresis band beyond the hide threshold', () => {
  const showAt = SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_SEAM_WIDTH_PX + SIDEBAR_WIDTH_BROWSER_DEFAULT
    + RIGHT_PANE_MIN_WIDTH_PX + SIDEBAR_AUTO_SHOW_HYSTERESIS_PX;
  // One pixel short of the band: stays hidden (no hide/show flicker).
  assert.equal(shouldAutoShowSidebar(showAt - 1, SIDEBAR_WIDTH_BROWSER_DEFAULT), false);
  assert.equal(shouldAutoShowSidebar(showAt, SIDEBAR_WIDTH_BROWSER_DEFAULT), true);
  assert.equal(shouldAutoShowSidebar(1440, SIDEBAR_WIDTH_HOME_DEFAULT), true);
});
