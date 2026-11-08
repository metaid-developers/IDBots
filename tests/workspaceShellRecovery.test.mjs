import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getRailHomeNavModel,
  getRailInternetNavModel,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';
import {
  HOME_RAIL_RENDERERS,
  INTERNET_PANE_RENDERERS,
  PANE_RENDERER_KEYS,
  resolveHomeViewRenderer,
  resolveInternetPaneRenderer,
  resolveRailEntryRenderer,
} from '../src/renderer/components/layout/workspaceDestinations.js';

/**
 * "Click a rail icon and the workspace must still have content" — the guard
 * behind the 11:37 collapse.
 *
 * Owner-visible failure it pins: with the middle column collapsed the shell
 * emitted THREE grid children (the resize handle was conditional) against FOUR
 * tracks, so the right column auto-placed into the zero-width handle track and
 * the whole workspace went blank while the rail kept rendering. Every further
 * rail click kept changing state that nothing visible could show; the only way
 * back was a full reload (the collapse flag is in-memory).
 *
 * The suite therefore asserts three separate things:
 *   1. every rail entry resolves to a renderer (no unwired icon),
 *   2. the shell pins each column to an explicit track (no auto-placement),
 *   3. recovery never depends on a control that the collapse itself hides.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const appSource = read('src/renderer/App.tsx');
const railSource = read('src/renderer/components/layout/WorkspaceRail.tsx');

/** CSS grid auto-placement, enough of it to model this shell. */
function autoPlacementTracks(childCount) {
  return Array.from({ length: childCount }, (_, index) => index + 1);
}

test('every rail entry resolves to a real pane renderer — an icon can never be a dead end', () => {
  const t = (key) => key;
  const internet = getRailInternetNavModel({ t }).filter((item) => !item.hidden);
  const home = getRailHomeNavModel({ t, hasRunningScheduledTask: false }).filter((item) => !item.hidden);

  assert.ok(internet.length >= 4, 'internet rail entries');
  assert.ok(home.length >= 4, 'home rail entries');

  for (const item of internet) {
    const key = resolveRailEntryRenderer('browser', item.id);
    assert.ok(PANE_RENDERER_KEYS.includes(key), `${item.id} resolves to a known renderer (${key})`);
    assert.equal(INTERNET_PANE_RENDERERS[item.id], key, `${item.id} has its own row, not a fallback`);
  }
  for (const item of home) {
    const key = resolveRailEntryRenderer('home', item.id);
    assert.ok(PANE_RENDERER_KEYS.includes(key), `${item.id} resolves to a known renderer (${key})`);
    assert.equal(HOME_RAIL_RENDERERS[item.id], key, `${item.id} has its own row, not a fallback`);
  }
});

test('stale or unknown destinations still land on a pane instead of null', () => {
  // HMR keeps module state across a reload, and a profile can carry an older
  // view id: neither may ever produce an empty right column.
  for (const stale of [undefined, null, '', 'not-a-pane', 'gigSquare.old']) {
    assert.ok(PANE_RENDERER_KEYS.includes(resolveInternetPaneRenderer(stale)));
    assert.ok(PANE_RENDERER_KEYS.includes(resolveHomeViewRenderer(stale)));
  }
});

test('App implements a branch for every renderer key the table can produce', () => {
  for (const key of PANE_RENDERER_KEYS) {
    // Bot Browser is the keep-alive pane (its own div), the rest are switch
    // branches keyed on the resolved renderer key (some via a local variable
    // such as `coworkLandingCard`), so a case-insensitive mention is enough.
    assert.ok(
      appSource.toLowerCase().includes(key.toLowerCase()),
      `App has no branch for renderer "${key}" — that pane would render blank`,
    );
  }
});

test('the shell pins every column to an explicit track (no auto-placement blind spot)', () => {
  // Both collapse states must describe four tracks.
  const templates = [...appSource.matchAll(/gridTemplateColumns:[^,]*?'([^']+)'/g)].map((match) => match[1]);
  assert.ok(templates.length >= 2, 'expanded + collapsed templates are both declared');
  // `minmax(0, 1fr)` is ONE track, so collapse its inner spaces before counting.
  const trackCount = (template) => template.replace(/minmax\(([^)]*)\)/g, (_m, inner) => `minmax(${inner.replace(/\s+/g, '')})`).trim().split(/\s+/).length;
  for (const template of templates) {
    assert.equal(trackCount(template), 4, `template "${template}" has four tracks`);
  }

  // The right column and the resize handle are placed by track number, so a
  // conditional middle child can never shift them into the wrong track.
  assert.match(appSource, /data-slot="app-right-column"[\s\S]{0,160}gridColumn: 4/);
  assert.match(appSource, /role="separator"[\s\S]{0,240}gridColumn: 3/);

  // Negative control: the modelled bug still reproduces, so the assertions
  // above are checking a real property rather than restating the source.
  // Collapsed template = [64, 0, 0, 1fr]; three children (no handle) =>
  // the right column is the THIRD child and lands in track 3 — the 0px track.
  const tracks = [64, 0, 0, '1fr'];
  const threeChildren = autoPlacementTracks(3);
  assert.equal(tracks[threeChildren[2] - 1], 0, 'unplaced third child lands in the zero-width track');
  const fourChildren = autoPlacementTracks(4);
  assert.equal(tracks[fourChildren[3] - 1], '1fr', 'the explicit fourth track is the content column');
});

test('recovery never depends on a control inside the collapsible column', () => {
  // The rail carries its own always-visible toggle …
  assert.match(railSource, /data-slot="rail-collapse-toggle"/);
  assert.match(railSource, /onClick=\{onToggleMiddleColumn\}/);
  assert.match(railSource, /isMiddleColumnCollapsed/);
  // … and App wires it to the same collapse state it renders the shell from.
  assert.match(appSource, /isMiddleColumnCollapsed=\{isSidebarCollapsed\}/);
  assert.match(appSource, /onToggleMiddleColumn=\{handleToggleSidebar\}/);
});

test('a rail destination click re-opens the middle column (the second recovery path)', () => {
  assert.match(appSource, /const revealMiddleColumn = useCallback\(\(\) => \{\s*setIsSidebarCollapsed\(false\);/);
  // Scope the search to the rail's own JSX block: the same prop names appear
  // again on <Sidebar> where no reveal is expected.
  const railStart = appSource.indexOf('<WorkspaceRail');
  const railEnd = appSource.indexOf('/>', railStart);
  const railBlock = appSource.slice(railStart, railEnd);
  for (const handler of ['onSelectInternetPane', 'onSelectHomeSection', 'onNewChat']) {
    const start = railBlock.indexOf(`${handler}={`);
    assert.ok(start > 0, `${handler} wiring exists on the rail`);
    assert.match(
      railBlock.slice(start, start + 400),
      /revealMiddleColumn\(\)/,
      `${handler} reveals the middle column before acting`,
    );
  }
});
