import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampSidebarWidth,
  defaultSidebarWidth,
  firstRunSidebarWidthForWindow,
  seedFirstRunSidebarWidth,
  loadSidebarWidth,
  maxSidebarWidthForWindow,
  migrateSidebarWidthStorage,
  rightPaneWidthForWindow,
  shouldAutoHideSidebar,
  shouldAutoShowSidebar,
  sidebarSnapWidthForWindow,
  sidebarWidthStorageKey,
  splitWidthForWindow,
  RIGHT_PANE_MIN_WIDTH_PX,
  SIDEBAR_AUTO_SHOW_HYSTERESIS_PX,
  SIDEBAR_MAX_DRAG_RATIO,
  SIDEBAR_RAIL_WIDTH_PX,
  SIDEBAR_SEAM_WIDTH_PX,
  SIDEBAR_WIDTH_BROWSER_DEFAULT,
  SIDEBAR_WIDTH_DEFAULT,
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

// ── Shared-width ruling (2026-11-11 evening, owner order ①) — SUPERSEDES the
// per-face storage keys and per-face defaults of the 2026-11-11 fixed-width
// build: Studio and BotWorks share ONE width state, ONE storage key, and ONE
// default, so switching surfaces never changes the column width. ──

test('both faces share one storage key and one default (shared-width ruling)', () => {
  assert.equal(sidebarWidthStorageKey('home'), 'idbots.sidebarWidth');
  assert.equal(sidebarWidthStorageKey('browser'), sidebarWidthStorageKey('home'));
  assert.equal(defaultSidebarWidth('home'), defaultSidebarWidth('browser'));
  assert.equal(defaultSidebarWidth('browser'), SIDEBAR_WIDTH_DEFAULT);
  // The named per-face constants survive as history but no longer select.
  assert.equal(SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_HOME_DEFAULT);
});

test('loadSidebarWidth reads the shared key for both faces (per-mode keys seed only pre-migration)', () => {
  // After the migration (or any drag end) the shared key answers for BOTH
  // faces, regardless of what the retired per-face keys still hold.
  const store = new Map([
    ['idbots.sidebarWidth', '360'],
    ['idbots.sidebarWidth.home', '300'],
    ['idbots.sidebarWidth.browser', '420'],
  ]);
  const getItem = (key: string) => store.get(key) ?? null;
  assert.equal(loadSidebarWidth(getItem, 'home'), 360);
  assert.equal(loadSidebarWidth(getItem, 'browser'), 360);

  // Pre-migration (shared key never written): each face still falls back to
  // its OWN retired key, so an upgrading machine restores its own face's
  // last width until migrateSidebarWidthStorage seeds the shared key.
  const legacy = new Map([
    ['idbots.sidebarWidth.home', '300'],
    ['idbots.sidebarWidth.browser', '420'],
  ]);
  const legacyGet = (key: string) => legacy.get(key) ?? null;
  assert.equal(loadSidebarWidth(legacyGet, 'home'), 300);
  assert.equal(loadSidebarWidth(legacyGet, 'browser'), 420);
});

test('loadSidebarWidth falls back to the one shared default when nothing is stored', () => {
  assert.equal(loadSidebarWidth(() => null, 'browser'), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(loadSidebarWidth(() => null, 'home'), SIDEBAR_WIDTH_DEFAULT);
});

test('migrateSidebarWidthStorage seeds the shared key from the freshest per-face width exactly once', () => {
  // Home seed present: it wins (the home face is the shell's boot face).
  const homeOnly = new Map([['idbots.sidebarWidth.home', '300']]);
  const writes1: Array<[string, string]> = [];
  migrateSidebarWidthStorage(
    (key) => homeOnly.get(key) ?? null,
    (key, value) => { writes1.push([key, value]); homeOnly.set(key, value); },
  );
  assert.deepEqual(writes1, [['idbots.sidebarWidth', '300']]);
  assert.equal(loadSidebarWidth((key) => homeOnly.get(key) ?? null, 'browser'), 300);

  // Browser-only seed: still seeds (no per-face preference beyond freshness).
  const browserOnly = new Map([['idbots.sidebarWidth.browser', '420']]);
  const writes2: Array<[string, string]> = [];
  migrateSidebarWidthStorage(
    (key) => browserOnly.get(key) ?? null,
    (key, value) => { writes2.push([key, value]); browserOnly.set(key, value); },
  );
  assert.deepEqual(writes2, [['idbots.sidebarWidth', '420']]);

  // Idempotent: a present shared key is never overwritten.
  const both = new Map([
    ['idbots.sidebarWidth', '360'],
    ['idbots.sidebarWidth.home', '300'],
    ['idbots.sidebarWidth.browser', '420'],
  ]);
  const writes3: Array<[string, string]> = [];
  migrateSidebarWidthStorage((key) => both.get(key) ?? null, (key, value) => writes3.push([key, value]));
  assert.deepEqual(writes3, []);

  // Fresh install (nothing stored anywhere): no seed is invented, so the
  // shared default serves both faces.
  const writes4: Array<[string, string]> = [];
  migrateSidebarWidthStorage(() => null, (key, value) => writes4.push([key, value]));
  assert.deepEqual(writes4, []);
});

test('loadSidebarWidth clamps stored values', () => {
  const getItem = (key: string) => (key === sidebarWidthStorageKey('home') ? '10' : null);
  assert.equal(loadSidebarWidth(getItem, 'home'), SIDEBAR_WIDTH_MIN);
});

// ── 50:50 drag-cap ruling (2026-11-11 evening, owner order ③) — SUPERSEDES
// the same-day fixed-width 480px drag cap (which had superseded the
// 2026-11-09 3:7 ratio cap): a manual drag may push the column to at most
// HALF the middle+right split. ──

test('splitWidthForWindow subtracts rail and seam tracks and floors at 0', () => {
  assert.equal(splitWidthForWindow(1440), 1440 - SIDEBAR_RAIL_WIDTH_PX - SIDEBAR_SEAM_WIDTH_PX);
  // 100 − (64 + 4) = 32: still positive, passes through.
  assert.equal(splitWidthForWindow(100), 32);
  // At or below rail+seam the split floors at 0.
  assert.equal(splitWidthForWindow(SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_SEAM_WIDTH_PX), 0);
  assert.equal(splitWidthForWindow(50), 0);
  assert.equal(splitWidthForWindow(Number.NaN), 0);
});

test('SIDEBAR_MAX_DRAG_RATIO is the 50:50 half-split ceiling', () => {
  assert.equal(SIDEBAR_MAX_DRAG_RATIO, 0.5);
});

test('maxSidebarWidthForWindow caps the drag at 50:50; the right-pane minimum stays the narrow-window safety', () => {
  // 1440 → split 1372 → half 686 (the right-pane rule 892 is looser): either
  // side can hold at most half the split.
  assert.equal(maxSidebarWidthForWindow(1440), 686);
  // Default 1200 window: split 1132 → half 566 (rule 652 looser).
  assert.equal(maxSidebarWidthForWindow(1200), 566);
  // 1000 → split 932 → half 466, right-pane rule 452: below split 960 the
  // right-pane minimum binds first, so a drag can never push the column into
  // auto-hide territory.
  assert.equal(maxSidebarWidthForWindow(1000), 452);
  // A window too narrow for the right-pane minimum to leave 240px: the
  // minimum-width floor wins (the auto-hide rule takes over from there).
  assert.equal(maxSidebarWidthForWindow(700), SIDEBAR_WIDTH_MIN);
  assert.equal(maxSidebarWidthForWindow(300), SIDEBAR_WIDTH_MIN);
  assert.equal(maxSidebarWidthForWindow(SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_SEAM_WIDTH_PX), SIDEBAR_WIDTH_MIN);
});

test('clampSidebarWidth caps at the 50:50 rule when a window width is given', () => {
  const cap = maxSidebarWidthForWindow(1440);
  assert.equal(cap, 686);
  // 600 is now reachable (the retired 480 cap would have clipped it).
  assert.equal(clampSidebarWidth(600, 1440), 600);
  // 700 overshoots the half-split → capped at 686.
  assert.equal(clampSidebarWidth(700, 1440), 686);
  // 700 → the right-pane minimum leaves < 240 → the floor wins.
  assert.equal(clampSidebarWidth(600, 700), SIDEBAR_WIDTH_MIN);
  // On a wide window the 50:50 ratio rules, not the 480 absolute max
  // (1920 → split 1852 → half 926).
  assert.equal(clampSidebarWidth(600, 1920), 600);
  assert.equal(clampSidebarWidth(100, 1440), SIDEBAR_WIDTH_MIN);
  // Exactly at the cap passes through unchanged.
  assert.equal(clampSidebarWidth(cap, 1440), cap);
  // Both face defaults fit under the cap at the default 1200 window — the
  // seam drags both ways.
  assert.ok(SIDEBAR_WIDTH_BROWSER_DEFAULT < maxSidebarWidthForWindow(1200));
  assert.ok(SIDEBAR_WIDTH_HOME_DEFAULT < maxSidebarWidthForWindow(1200));
});

test('clampSidebarWidth keeps the 480 cap when no window width is given', () => {
  // Back-compat contract for pure callers: one argument = the fixed-width cap.
  assert.equal(clampSidebarWidth(1000), SIDEBAR_WIDTH_MAX);
});

test('sidebarSnapWidthForWindow is the 3:7 split clamped into the drag range', () => {
  // 1440 → split 1372 → 30% = 411 (under the 686 half-split cap).
  assert.equal(sidebarSnapWidthForWindow(1440), 411);
  // 700 → 30% = 189, below the 240 floor → the floor wins.
  assert.equal(sidebarSnapWidthForWindow(700), SIDEBAR_WIDTH_MIN);
  // 1920 → 30% = 555: the 3:7 baseline sits under the 50:50 cap (926), so
  // the snap is NEVER ratio-clipped any more — the double-click baseline is
  // always reachable (supersedes the fixed-width build, where the 480 cap
  // clipped this to 480).
  assert.equal(sidebarSnapWidthForWindow(1920), 555);
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

test('first-run width: wider than the old 320 default and both panes stay visible', () => {
  assert.equal(firstRunSidebarWidthForWindow(1200), 430);
  assert.equal(firstRunSidebarWidthForWindow(1440), SIDEBAR_WIDTH_MAX);
  assert.equal(firstRunSidebarWidthForWindow(1680), SIDEBAR_WIDTH_MAX);
  assert.equal(firstRunSidebarWidthForWindow(1024), 380);
  assert.equal(firstRunSidebarWidthForWindow(Number.NaN), SIDEBAR_WIDTH_DEFAULT);
  for (const windowWidth of [1024, 1100, 1200, 1280, 1366, 1440, 1512, 1680, 1920, 2560]) {
    const width = firstRunSidebarWidthForWindow(windowWidth);
    assert.ok(width > SIDEBAR_WIDTH_DEFAULT, `${windowWidth}: ${width} is wider than the old default`);
    assert.ok(width <= maxSidebarWidthForWindow(windowWidth), `${windowWidth}: within the drag cap`);
    assert.equal(shouldAutoHideSidebar(windowWidth, width), false, `${windowWidth}: the column is not auto-hidden`);
    assert.ok(rightPaneWidthForWindow(windowWidth, width) >= RIGHT_PANE_MIN_WIDTH_PX, `${windowWidth}: the browser keeps its minimum`);
  }
});

test('seedFirstRunSidebarWidth writes once, only on a machine that never stored a width', () => {
  const store = new Map<string, string>();
  const get = (key: string) => store.get(key) ?? null;
  const set = (key: string, value: string) => void store.set(key, value);
  seedFirstRunSidebarWidth(get, set, 1200);
  assert.equal(loadSidebarWidth(get, 'browser'), 430);
  seedFirstRunSidebarWidth(get, set, 1920);
  assert.equal(loadSidebarWidth(get, 'home'), 430, 'never overwrites');

  const remembered = new Map<string, string>([['idbots.sidebarWidth', '300']]);
  seedFirstRunSidebarWidth((key) => remembered.get(key) ?? null, (key, value) => void remembered.set(key, value), 1200);
  assert.equal(remembered.get('idbots.sidebarWidth'), '300', 'a stored width is untouched');

  const legacy = new Map<string, string>([['idbots.sidebarWidth.home', '290']]);
  seedFirstRunSidebarWidth((key) => legacy.get(key) ?? null, (key, value) => void legacy.set(key, value), 1200);
  assert.equal(legacy.has('idbots.sidebarWidth'), false, 'a legacy per-face width is left to the migration');
});
