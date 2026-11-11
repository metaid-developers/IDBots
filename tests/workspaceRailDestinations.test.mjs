import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getRailHomeNavModel,
  getRailInternetNavModel,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';
import {
  HOME_MAIN_VIEW_FALLBACK_RENDERER,
  HOME_MAIN_VIEW_RENDERERS,
  HOME_RAIL_RENDERERS,
  INTERNET_PANE_FALLBACK_RENDERER,
  INTERNET_PANE_RENDERERS,
  PANE_RENDERER_KEYS,
  resolveHomeViewRenderer,
  resolveInternetPaneRenderer,
  resolveRailEntryRenderer,
} from '../src/renderer/components/layout/workspaceDestinations.js';

// Three-column shell, slice 1 fix: rail → pane wiring completeness.
//
// This suite is the guard that turns "every rail icon must land on a rendered
// pane" into a failing test instead of a live blank window. It walks BOTH
// directions:
//
//   rail model entry  →  destination table row  →  renderer key
//   renderer key      →  App's rendered branch
//
// plus the layout precondition that made a blank reachable in the first place:
// the right column must stay pinned to the fourth grid track even when the
// middle column (and the resize handle next to it) are collapsed.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
const t = (key) => key;

/** The rail surfaces render only non-hidden entries; the hidden ones still need a row. */
const internetItems = getRailInternetNavModel({ t });
const homeItems = getRailHomeNavModel({ t, hasRunningScheduledTask: false, needsDecisionCount: 0 });

test('every Bot Internet rail entry has an explicit destination row (hidden entries included)', () => {
  // Three VISIBLE destinations: the Co-Work bubble row is retired (owner ruling
  // 2026-11-08 20:18) and Bot Hub stays implemented but hidden.
  assert.deepEqual(
    internetItems.filter((item) => !item.hidden).map((item) => item.id),
    ['browser', 'metaapps', 'myBots'],
  );
  assert.ok(internetItems.length >= 4, 'the hidden Bot Hub slot keeps its row too');
  for (const item of internetItems) {
    assert.ok(
      Object.hasOwn(INTERNET_PANE_RENDERERS, item.id),
      `rail entry "${item.id}" has no destination row — clicking it would land on nothing`,
    );
    assert.ok(
      PANE_RENDERER_KEYS.includes(INTERNET_PANE_RENDERERS[item.id]),
      `rail entry "${item.id}" maps to an unimplemented renderer "${INTERNET_PANE_RENDERERS[item.id]}"`,
    );
  }
});

test('the retired Co-Work id degrades to the default face instead of owning a pane', () => {
  // 20:18 ruling: the rail's bubble entry is gone and its mapping is folded
  // into the DEFAULT branch. Three directions of the same contract:
  //   1. no table row may re-own `cowork` (a re-added row would hand it a pane),
  //   2. a stale `cowork` value resolves through the fallback,
  //   3. the default face is a REAL branch App implements (never `null`).
  assert.equal(
    Object.hasOwn(INTERNET_PANE_RENDERERS, 'cowork'),
    false,
    'cowork must not be a destination row again — it is the default face',
  );
  assert.equal(resolveInternetPaneRenderer('cowork'), INTERNET_PANE_FALLBACK_RENDERER);
  assert.equal(resolveRailEntryRenderer('browser', 'cowork'), INTERNET_PANE_FALLBACK_RENDERER);
  assert.ok(PANE_RENDERER_KEYS.includes(INTERNET_PANE_FALLBACK_RENDERER));
  // ...and the rail model itself must not grow the entry back.
  assert.equal(
    internetItems.some((item) => item.id === 'cowork' || item.icon === 'chatBubbles'),
    false,
    'the Co-Work bubble rail entry is retired',
  );
});

test('every Bot Home rail entry has an explicit destination row', () => {
  assert.deepEqual(
    homeItems.filter((item) => !item.hidden).map((item) => item.id),
    ['newTask', 'longTerm', 'groupTasks', 'records'],
  );
  for (const item of homeItems) {
    assert.ok(
      Object.hasOwn(HOME_RAIL_RENDERERS, item.id),
      `rail entry "${item.id}" has no destination row`,
    );
    const key = HOME_RAIL_RENDERERS[item.id];
    assert.ok(PANE_RENDERER_KEYS.includes(key), `"${item.id}" maps to an unimplemented renderer "${key}"`);
    assert.ok(
      Object.values(HOME_MAIN_VIEW_RENDERERS).includes(key),
      `"${item.id}" lands on "${key}", which no mainView can actually render`,
    );
  }
});

test('a rail click always resolves to an implemented renderer, never to the blank fallback by accident', () => {
  for (const item of internetItems.filter((entry) => !entry.hidden)) {
    const key = resolveRailEntryRenderer('browser', item.id);
    assert.ok(PANE_RENDERER_KEYS.includes(key), `browser/"${item.id}" -> "${key}"`);
    assert.equal(key, INTERNET_PANE_RENDERERS[item.id], 'rendered entries must hit their own row');
  }
  for (const item of homeItems.filter((entry) => !entry.hidden)) {
    const key = resolveRailEntryRenderer('home', item.id);
    assert.ok(PANE_RENDERER_KEYS.includes(key), `home/"${item.id}" -> "${key}"`);
    assert.equal(key, HOME_RAIL_RENDERERS[item.id], 'rendered entries must hit their own row');
  }
});

test('unknown or stale destinations fall back to a rendered pane (null is never a destination)', () => {
  for (const stale of ['__unknown__', '', null, undefined]) {
    assert.equal(resolveInternetPaneRenderer(stale), INTERNET_PANE_FALLBACK_RENDERER);
    assert.equal(resolveHomeViewRenderer(stale), HOME_MAIN_VIEW_FALLBACK_RENDERER);
  }
  // `skills` is a legacy persisted mainView that has no owned view of its own.
  assert.equal(resolveHomeViewRenderer('skills'), 'coworkView');
  // The full-app Meta Bots view keeps its own branch.
  assert.equal(resolveHomeViewRenderer('metabots'), 'metabotsView');
  // The rail's myBots entry lands on the same implemented renderer.
  assert.equal(resolveInternetPaneRenderer('myBots'), 'metabotsView');
});

test('App implements a rendered branch for every renderer key in the table', () => {
  // Bot Internet catalogue switch.
  assert.match(appSource, /internetPaneKey === 'gigSquareView'/);
  assert.match(appSource, /internetPaneKey === 'metaAppsView'/);
  assert.match(appSource, /internetPaneKey === 'metabotsView'/);
  assert.match(appSource, /const coworkLandingCard = \(/);
  // Bot Home switch.
  assert.match(appSource, /homePaneKey === 'scheduledTasksView'/);
  assert.match(appSource, /homePaneKey === 'groupTasksView'/);
  assert.match(appSource, /homePaneKey === 'metabotsView'/);
  assert.match(appSource, /<CoworkView/);
  // The keep-alive Bot Browser pane carries its own marker.
  assert.match(
    appSource,
    /data-pane-view=\{botBrowserShell\.isBrowserPaneVisible \? 'botBrowserSurface' : undefined\}/,
  );
  // The two non-switch renderer keys are the chain closers, asserted below.
  assert.equal(resolveInternetPaneRenderer('__stale__'), 'coworkLanding');
  assert.equal(resolveHomeViewRenderer('__stale__'), 'coworkView');
});

test('the right column never ends on null — both destination chains close on a rendered pane', () => {
  const homeStart = appSource.indexOf('const homePaneKey');
  const homeEnd = appSource.indexOf('const coworkLandingCard');
  const homeBlock = appSource.slice(homeStart, homeEnd);
  assert.ok(homeStart > -1 && homeEnd > homeStart);
  assert.doesNotMatch(homeBlock, /\)\s*:\s*null\s*;/, 'the home chain has a null branch');

  const catalogStart = appSource.indexOf('const internetPaneKey');
  const catalogEnd = appSource.indexOf('const showHomeSurface');
  const catalogBlock = appSource.slice(catalogStart, catalogEnd);
  assert.ok(catalogStart > -1 && catalogEnd > catalogStart);
  assert.doesNotMatch(catalogBlock, /\)\s*:\s*null\s*;/, 'the Bot Internet chain can still resolve to null');
  // ... and each chain names its non-blank fallback explicitly.
  assert.match(homeBlock, /\) : \(\n    <CoworkView/);
  assert.match(catalogBlock, /\) : \(\n    coworkLandingCard\n  \);/);
});

test('the right column stays pinned to grid track 4, so a collapsed middle column cannot blank the shell', () => {
  // The shell really is the four-track grid (rail | mid | handle | right).
  assert.match(appSource, /data-slot="app-three-column-shell"/);
  assert.match(appSource, /'64px auto 4px minmax\(0, 1fr\)'/);
  assert.match(appSource, /'64px 0px 4px minmax\(0, 1fr\)'/);
  // The boundary handle is mounted in BOTH states (its track keeps 4px), so
  // the third child can never vanish; explicit placement is what keeps the
  // right column out of a zero-width track either way.
  assert.match(appSource, /data-slot="app-right-column"/);
  assert.match(appSource, /data-slot="app-right-column"[\s\S]{0,160}style=\{\{ gridColumn: 4 \}\}/);
  assert.match(appSource, /style=\{\{ gridColumn: 3 \}\}/);
});

test('one visible column carries exactly one data-pane-view marker per surface state', () => {
  // Catalogue / Bot Home payload: marker is on the wrapper, which only renders
  // while one of those two is current.
  assert.match(appSource, /data-pane-view=\{rightPaneKey\}/);
  // Browser payload: marker exists only while the pane is the visible one.
  assert.equal((appSource.match(/data-pane-view=/g) || []).length, 2);
});

test('Bot Home section state stays derived from mainView — no second source of truth', () => {
  assert.match(
    appSource,
    /const homeSection: BotHomeSection = mainView === 'scheduledTasks'[\s\S]{0,160}'records'/,
  );
  assert.doesNotMatch(appSource, /useState<BotHomeSection>/);
  // Every rail list entry is mapped onto the mainView it shows.
  assert.match(appSource, /section === 'longTerm'[\s\S]{0,120}setMainView\('scheduledTasks'\)/);
  assert.match(appSource, /section === 'groupTasks'[\s\S]{0,120}setMainView\('groupTasks'\)/);
});

test('a collapsed middle column is recoverable from the boundary handle alone', () => {
  const railSource = fs.readFileSync(
    path.join(root, 'src/renderer/components/layout/WorkspaceRail.tsx'),
    'utf8',
  );
  // The rail no longer carries a collapse toggle: there is exactly ONE panel
  // toggle in the shell and it lives on the mid ⇄ right boundary handle.
  assert.doesNotMatch(railSource, /rail-collapse-toggle/);
  assert.doesNotMatch(railSource, /isMiddleColumnCollapsed/);
  assert.equal((appSource.match(/role="separator"/g) || []).length, 1, 'one boundary handle');

  // The handle is rendered unconditionally between <Sidebar> and the right
  // column: a control that hides a column must never be hidden by that same
  // state (that was the 11:37 dead end).
  const handleStart = appSource.indexOf('role="separator"');
  const rightColumnStart = appSource.indexOf('data-slot="app-right-column"');
  assert.ok(handleStart > 0 && rightColumnStart > handleStart, 'handle sits before the right column');
  const handleBlock = appSource.slice(handleStart, rightColumnStart);
  assert.match(handleBlock, /data-slot="panel-boundary-handle"/);
  assert.match(handleBlock, /aria-orientation="vertical"/);
  assert.match(handleBlock, /data-slot="panel-toggle"/);
  // 接缝按钮双向化 2026-11-09: the seam publishes its per-face state instead
  // of a boolean toggle, and each face's transitions live on its own chevrons.
  assert.match(handleBlock, /data-seam-state=\{showHomeSurface \? \(homeSeamCollapsed \? 'left' : 'split'\) : studioSeamState\}/);
  assert.match(handleBlock, /onClick=\{handleCollapseHomeSeam\}/);
  assert.match(handleBlock, /<PanelToggleIcon/);
  // ... and every destination click re-opens the column, so a collapsed
  // workspace can never be a dead end. (Fixed-width ruling 2026-11-11: the
  // reveal first clears the face's narrow-window auto-hide flag, so a manual
  // re-open is user-owned from that point on.)
  assert.match(
    appSource,
    /const revealMiddleColumn = useCallback\(\(\) => \{\s*if \(isHomeSurfaceMode\) \{\s*sidebarAutoHiddenRef\.current\.home = false;\s*setHomeSeamCollapsed\(false\);/,
  );
  assert.match(appSource, /onSelectInternetPane=\{\(pane\) => \{\s*revealMiddleColumn\(\);/);
  assert.match(appSource, /onSelectHomeSection=\{\(section\) => \{\s*revealMiddleColumn\(\);/);
  assert.match(appSource, /onNewChat=\{\(\) => \{\s*revealMiddleColumn\(\);/);
});
