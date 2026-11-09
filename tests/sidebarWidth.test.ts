import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampSidebarWidth,
  defaultSidebarWidth,
  loadSidebarWidth,
  maxSidebarWidthForWindow,
  sidebarSnapWidthForWindow,
  sidebarWidthStorageKey,
  splitWidthForWindow,
  SIDEBAR_MAX_RATIO,
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

// ── 3:7 seam ruling (2026-11-09 fourth expansion order; supersedes the
// third order's 40:60) ──

test('splitWidthForWindow subtracts rail and seam tracks and floors at 0', () => {
  assert.equal(splitWidthForWindow(1440), 1440 - SIDEBAR_RAIL_WIDTH_PX - SIDEBAR_SEAM_WIDTH_PX);
  // 100 − (64 + 4) = 32: still positive, passes through.
  assert.equal(splitWidthForWindow(100), 32);
  // At or below rail+seam the split floors at 0.
  assert.equal(splitWidthForWindow(SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_SEAM_WIDTH_PX), 0);
  assert.equal(splitWidthForWindow(50), 0);
  assert.equal(splitWidthForWindow(Number.NaN), 0);
});

test('maxSidebarWidthForWindow is 30% of the split (the 3 side of 3:7), floored at the min width', () => {
  const split = splitWidthForWindow(1440);
  assert.equal(maxSidebarWidthForWindow(1440), Math.floor(split * SIDEBAR_MAX_RATIO));
  // A window too narrow for 30% to reach 240px: the minimum-width floor wins.
  assert.equal(maxSidebarWidthForWindow(300), SIDEBAR_WIDTH_MIN);
  assert.equal(maxSidebarWidthForWindow(SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_SEAM_WIDTH_PX), SIDEBAR_WIDTH_MIN);
  // Mid-size window: 700 → split 632 → 30% = 189.6 → floor 189, but the
  // 240px minimum-width floor wins over the ratio (implementation contract:
  // "never below the minimum-width floor").
  assert.equal(maxSidebarWidthForWindow(700), SIDEBAR_WIDTH_MIN);
});

test('clampSidebarWidth caps at the 3:7 ratio when a window width is given', () => {
  const cap = maxSidebarWidthForWindow(1440);
  // 1440 → split 1372 → 30% = 411: the 3:7 cap is TIGHTER than the legacy
  // 480 at this window size (40:60's 548 was looser). On wide windows the
  // ratio cap is looser again (1920 → 555) — the ratio, not the legacy cap,
  // always rules the windowed path.
  assert.equal(cap, 411);
  assert.ok(cap < SIDEBAR_WIDTH_MAX, 'on a 1440 window the 3:7 cap is tighter than the legacy 480');
  assert.equal(clampSidebarWidth(600, 1440), cap);
  // 700 → split 632 → 30% = 189, below the 240 floor → the floor wins.
  assert.equal(clampSidebarWidth(600, 700), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(600, 1920), 555);
  assert.equal(clampSidebarWidth(100, 1440), SIDEBAR_WIDTH_MIN);
  // Exactly at the cap passes through unchanged.
  assert.equal(clampSidebarWidth(cap, 1440), cap);
});

test('clampSidebarWidth keeps the legacy 480 cap when no window width is given', () => {
  // Back-compat contract for pure callers: one argument = the old behavior.
  assert.equal(clampSidebarWidth(1000), SIDEBAR_WIDTH_MAX);
});

test('sidebarSnapWidthForWindow is exactly the 3:7 cap', () => {
  assert.equal(sidebarSnapWidthForWindow(1440), maxSidebarWidthForWindow(1440));
  assert.equal(sidebarSnapWidthForWindow(700), maxSidebarWidthForWindow(700));
});
