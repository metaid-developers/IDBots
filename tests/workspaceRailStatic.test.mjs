import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Three-column shell, slice 1: left icon rail | middle column | right column.
// These guards pin the skeleton itself (the container split), not the content
// that each column happens to render — that is what the other static suites
// already cover.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const appSource = read('src/renderer/App.tsx');
const railSource = read('src/renderer/components/layout/WorkspaceRail.tsx');
const sidebarSource = read('src/renderer/components/Sidebar.tsx');
const navigationSource = read('src/renderer/components/sidebar/sidebarNavigation.js');

test('App lays the shell out as four tracks: rail | mid column | handle | right column', () => {
  assert.match(appSource, /data-slot="app-three-column-shell"/);
  assert.match(appSource, /className="grid min-h-0 min-w-0 flex-1"/);
  // 64 px rail, the user-resizable middle track, the 4px boundary handle, the
  // right column. Collapsed: the middle track goes to 0 but the handle keeps
  // its 4px track — it carries the ONE panel toggle in both states.
  // (Bot Home degrades this SAME container: the rail track is 0 and the
  // restored HomeSidebar takes track 1 — see homeFaceLayering.test.mjs.)
  assert.match(appSource, /'64px 0px 4px minmax\(0, 1fr\)'/);
  assert.match(appSource, /'64px auto 4px minmax\(0, 1fr\)'/);
  assert.match(appSource, /data-shell-face=\{showHomeSurface \? 'home' : 'browser'\}/);
  assert.match(appSource, /import WorkspaceRail from '\.\/components\/layout\/WorkspaceRail';/);
  // Anchor on the JSX element form (`<Sidebar` followed by whitespace), not a
  // bare prefix: the bare prefix also matches type annotations such as
  // `useRef<SidebarResizeSession | null>`, which made this ordering guard fail
  // for a reason that had nothing to do with column order.
  const railMount = appSource.indexOf('<WorkspaceRail');
  const sidebarMount = appSource.search(/<Sidebar\s/);
  assert.ok(railMount >= 0 && sidebarMount >= 0, 'both columns are mounted');
  assert.ok(
    railMount < sidebarMount,
    'the rail is the first column of the shell',
  );
});

test('the rail is an icon column inside the 48–64 px budget, shared by both surfaces', () => {
  assert.match(railSource, /export const WORKSPACE_RAIL_WIDTH_PX = 64;/);
  assert.match(railSource, /className="relative z-30 flex w-16 shrink-0 flex-col items-center/);
  // Both surfaces render entries in the same column; only the model differs.
  assert.match(railSource, /mode === 'browser' \? \(/);
  assert.match(railSource, /getRailInternetNavModel\(\{/);
  assert.match(railSource, /getRailHomeNavModel\(\{/);
});

test('rail entries are icon buttons with hover tooltips, settings and ME pinned to the bottom', () => {
  assert.match(railSource, /<Tooltip content=\{label\} position="right" delay=\{200\}>/);
  assert.match(railSource, /data-slot="rail-item"/);
  // The label is the accessible name (the tooltip carries the visible text).
  assert.match(railSource, /aria-label=\{label\}/);
  // Bottom block: the update dot, then Settings, then ME — and nothing else.
  const bottom = railSource.slice(railSource.indexOf('<div className="mt-auto'));
  assert.ok(bottom.includes('updateBadge'));
  assert.ok(bottom.indexOf('itemId="settings"') < bottom.indexOf('<MeBalanceBadge compact />'));
  assert.match(bottom, /i18nService\.t\('settings'\)/);
});

test('Settings and ME moved out of the middle column into the rail', () => {
  // The old sidebar footer rendered both in this order; the rail owns them now.
  assert.doesNotMatch(sidebarSource, /MeBalanceBadge/);
  assert.doesNotMatch(sidebarSource, /onClick=\{\(\) => onShowSettings\(\)\}/);
});

test('the Internet middle column keeps its two bodies (panel / record type)', () => {
  // Owner ruling 2026-11-08 14:22: Bot Home restored to two columns, Bot
  // Internet's three columns unchanged. Sidebar.tsx is that middle column; the
  // live Home list now lives in HomeSidebar.tsx (pinned there).
  assert.match(sidebarSource, /data-slot="workspace-mid-column"/);
  assert.match(sidebarSource, /<BotBrowserCoworkPanel\s+onShowSkills=\{onShowSkills\}/);
  // The record type is chosen in the left rail ONLY: the drawer that used to
  // sit above the list (and duplicated the rail) is gone, together with its
  // second copy of the three-type model.
  assert.doesNotMatch(sidebarSource, /getHomeSectionModel/);
  assert.doesNotMatch(sidebarSource, /data-slot="home-record-type"/);
  // The column renders the body of the type the rail picked, one body per type.
  for (const section of ['longTerm', 'groupTasks', 'records']) {
    assert.match(sidebarSource, new RegExp(`data-home-section="${section}"`));
  }
  // Records keep the existing session list component (container move only).
  assert.match(sidebarSource, /<CoworkSessionList/);
  assert.match(sidebarSource, /<UnifiedTaskList/);

  // The Home face renders the restored sidebar instead — never this column.
  assert.match(appSource, /\{showHomeSurface \? \(\s*<HomeSidebar/);
});

test('the Home face has no rail entry and its sidebar carries the text menu rows', () => {
  // The rail is mounted exactly once, in the Internet branch of the shell…
  assert.equal((appSource.match(/<WorkspaceRail/g) ?? []).length, 1);
  assert.ok(
    appSource.indexOf('{showHomeSurface ? (') < appSource.indexOf('<WorkspaceRail'),
    'the rail mount belongs to the non-home branch',
  );
  // …and the restored Home sidebar is a TEXT menu: 新建任务 / 长期任务 /
  // 多人任务 (the 我的 Bot row was retired by the owner ruling 15:46), all
  // rendered as rows, not as icon-rail entries.
  const homeSidebarSource = read('src/renderer/components/HomeSidebar.tsx');
  assert.match(homeSidebarSource, /getSidebarPrimaryNavModel/);
  assert.match(homeSidebarSource, /onClick=\{onNewChat\}/);
  assert.match(homeSidebarSource, /primaryNavItems\.map\(/);
  assert.match(homeSidebarSource, /data-slot="workspace-home-sidebar"/);
  // No rail item markup in the Home sidebar; no rail model behind it either.
  assert.doesNotMatch(homeSidebarSource, /data-slot="rail-item"/);
  assert.doesNotMatch(homeSidebarSource, /getRailHomeNavModel/);
});

test('the surface switcher sits in the mid column header — the rail top is a bare spacer', () => {
  // Owner ruling 2026-11-08 14:15: the switch left the 64 px rail so it can
  // show the current surface's NAME in a Codex-style capsule. The rail keeps
  // only its 52 px macOS traffic-light reservation, and mounts no switcher.
  assert.doesNotMatch(railSource, /BotBrowserModeSwitch/);
  assert.doesNotMatch(railSource, /surface-switch-trigger/);
  assert.match(railSource, /isMac \? 'h-\[52px\]' : 'h-3'/);

  assert.match(sidebarSource, /data-slot="mid-column-header"/);
  assert.match(sidebarSource, /data-slot="mid-column-header"[\s\S]{0,420}<BotBrowserModeSwitch/);
  assert.match(sidebarSource, /onSelectSurface: \(mode: BotBrowserSurfaceMode\) => void;/);
  // The header control chooses the SURFACE only — the record TYPE stays a
  // rail-only decision.
  assert.match(sidebarSource, /onSelectBrowser=\{\(\) => onSelectSurface\('browser'\)\}/);
  assert.match(sidebarSource, /onSelectHome=\{\(\) => onSelectSurface\('home'\)\}/);
  // App feeds the same two transitions the rail used to emit.
  assert.match(appSource, /onSelectSurface=\{\(mode\) => \{[\s\S]{0,200}openBrowserHome/);
});

test('the Co-Work destination no longer introduces itself in either column', () => {
  // The NAME belongs to the rail entry that opened the destination (owner
  // ruling 2026-11-08 14:15); the panel carries only its two actions.
  const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
  assert.doesNotMatch(panelSource, /botBrowserCoworkTitle/);
  assert.match(panelSource, /data-slot="cowork-panel-actions"/);
  assert.match(panelSource, /botBrowserCoworkNew/);
  assert.match(panelSource, /botBrowserCoworkHistory/);

  // The right pane stays a REAL rendered branch (never `null`) — the card that
  // used to sit here (title + session counts + an "open the browser" button) is
  // gone, but the destination still resolves to a mounted pane.
  const cardStart = appSource.indexOf('const coworkLandingCard = (');
  const cardEnd = appSource.indexOf('const internetPaneKey');
  assert.ok(cardStart > 0 && cardEnd > cardStart, 'the landing branch still exists');
  const cardBlock = appSource.slice(cardStart, cardEnd);
  assert.match(cardBlock, /data-pane-empty="cowork"/);
  assert.doesNotMatch(cardBlock, /botBrowserCoworkTitle/);
  assert.doesNotMatch(cardBlock, /internetCoworkPane/);
  assert.match(appSource, /\) : \(\n    coworkLandingCard\n  \);/);
});

test('the rail models are the single source of both surfaces’ entries', () => {
  assert.match(navigationSource, /export function getRailInternetNavModel/);
  assert.match(navigationSource, /export function getRailHomeNavModel/);
  assert.match(navigationSource, /export function getSurfaceMenuModel/);
  // Four internet destinations + four home destinations, one of which is the
  // creation action rather than a list.
  for (const id of ['browser', 'metaapps', 'myBots', 'cowork', 'gigSquare']) {
    assert.ok(navigationSource.includes(`id: '${id}'`), `${id} is an internet destination`);
  }
  for (const id of ['newTask', 'longTerm', 'groupTasks', 'records']) {
    assert.ok(navigationSource.includes(`id: '${id}'`), `${id} is a Bot Home destination`);
  }
});

test('the Co-Work destination is an internet pane, and it is not the browser pane', () => {
  const typesSource = read('src/renderer/features/botBrowser/types.ts');
  assert.match(typesSource, /export type BotInternetPane = 'browser' \| 'gigSquare' \| 'metaapps' \| 'myBots' \| 'cowork';/);
  assert.match(typesSource, /export type BotHomeSection = 'longTerm' \| 'groupTasks' \| 'records';/);
  // Slice-1 fix: the destination is resolved through the shared table instead
  // of an inline pane literal, so the completeness guard can see every branch.
  assert.match(appSource, /const internetPaneKey = resolveInternetPaneRenderer\(botBrowserShell\.internetPane\);/);
  assert.match(appSource, /const coworkLandingCard = \(/);
  assert.match(read('src/renderer/components/layout/workspaceDestinations.js'), /cowork: 'coworkLanding'/);
});
