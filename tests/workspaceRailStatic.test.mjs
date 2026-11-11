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
const homeSidebarSource = read('src/renderer/components/HomeSidebar.tsx');
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

test('rail entries are icon buttons with hover tooltips, Settings pinned to the bottom, NO ME badge', () => {
  assert.match(railSource, /<Tooltip content=\{label\} position="right" delay=\{200\}>/);
  assert.match(railSource, /data-slot="rail-item"/);
  // The label is the accessible name (the tooltip carries the visible text).
  assert.match(railSource, /aria-label=\{label\}/);
  // Bottom block: the update dot, then Settings — and nothing else. The old
  // compact ME badge is retired from this corner (owner 2026-11-09 10:05, D5):
  // the standalone user page is the ONE home of the ME credits panel.
  const bottom = railSource.slice(railSource.indexOf('<div className="mt-auto'));
  assert.ok(bottom.includes('updateBadge'));
  assert.match(bottom, /i18nService\.t\('settings'\)/);
  // Pin the JSX usage AND the import (a prose comment naming the retired
  // component is fine — the mount and the import must not come back).
  assert.doesNotMatch(railSource, /<MeBalanceBadge/);
  assert.doesNotMatch(railSource, /import MeBalanceBadge/);
});

test('the rail top: lights strip, then the avatar slot on the band row; icons start below it (D-line final 2026-11-09)', () => {
  // Row 1 = the lights' pure reservation (52 px mac / 12 px elsewhere).
  assert.match(railSource, /isMac \? 'h-\[52px\]' : 'h-3'/);
  // Row 2 = the identity AVATAR slot (Mac-WeChat form): the SAME 52 px height
  // as the mid column's band row (BotBrowserModeSwitch surface-header-bar),
  // content centered — the slot's centerline is the band labels' centerline,
  // and the rail's centerline is the icon column's X.
  assert.match(railSource, /data-slot="workspace-rail-avatar-slot"/);
  assert.match(railSource, /className="flex h-\[52px\] w-full shrink-0 items-center justify-center"/);
  assert.match(railSource, /<UserProfileAvatarButton \/>/);
  // Row 3: the nav's 8 px top margin puts the first icon at 52 + 52 + 8 =
  // 112 px — below the avatar slot, never in the top cell.
  assert.match(railSource, /className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center/);
  assert.equal(52 + 52 + 8, 112);
});

test('Settings and ME moved out of the middle column into the rail', () => {
  // The old sidebar footer rendered both in this order; the rail owns them
  // now. HomeSidebar's 「⚙ 设置」 text row joined the exit (设置按钮共享化,
  // 总裁办侧栏微调批单 2026-11-09 12:23, superseding the 11:16 order that
  // kept it): the rail's bottom RailButton is the ONE shared settings entry
  // on BOTH faces — same component, same onShowSettings chain.
  assert.doesNotMatch(sidebarSource, /MeBalanceBadge/);
  assert.doesNotMatch(sidebarSource, /onClick=\{\(\) => onShowSettings\(\)\}/);
  assert.doesNotMatch(homeSidebarSource, /MeBalanceBadge/);
  // Code form only (prop decl or JSX pass-through) — prose comments naming
  // the consolidation are fine and must not trip this pin.
  assert.doesNotMatch(homeSidebarSource, /onShowSettings\s*[:=]/);
  // The home branch's rail mount no longer opts out: no showSettings={false}
  // anywhere in App, and BOTH rail mounts ride the same handleShowSettings
  // chain.
  assert.doesNotMatch(appSource, /showSettings=\{false\}/);
  assert.equal(
    (appSource.match(/onShowSettings=\{\(\) => handleShowSettings\(\)\}/g) ?? []).length,
    2,
    'both faces' + ' rail mounts share the one settings chain',
  );
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

  // The Home face renders its own three-column composition (rail | records
  // column | right column) — never this Internet mid column.
  assert.match(appSource, /\{showHomeSurface \? \(\s*<>\s*\{\/\*[\s\S]*?\*\/\}\s*<WorkspaceRail/);
  assert.doesNotMatch(sidebarSource, /data-slot="workspace-home-sidebar"/);
});

test('the Home face mounts the same rail; its records column carries no rail items', () => {
  // Three-column final ruling 2026-11-09: the rail is mounted EXACTLY TWICE —
  // once per face — and the home mount opens the home branch.
  assert.equal((appSource.match(/<WorkspaceRail/g) ?? []).length, 2);
  assert.ok(
    appSource.indexOf('{showHomeSurface ? (') < appSource.indexOf('<WorkspaceRail'),
    'the rail mount opens the home branch',
  );
  // The records column is NOT a rail: it renders no rail item markup and
  // behinds no rail model — its body is the records list under the shared
  // surface header.
  const homeSidebarSource = read('src/renderer/components/HomeSidebar.tsx');
  assert.match(homeSidebarSource, /data-slot="workspace-home-sidebar"/);
  assert.doesNotMatch(homeSidebarSource, /data-slot="rail-item"/);
  assert.doesNotMatch(homeSidebarSource, /getRailHomeNavModel/);
  assert.doesNotMatch(homeSidebarSource, /getSidebarPrimaryNavModel/);
});

test('the surface switcher sits in the mid column header — the rail top has no switcher', () => {
  // Owner ruling 2026-11-08 14:15: the switch left the 64 px rail so it can
  // show the current surface's NAME in a Codex-style capsule. The rail keeps
  // its 52 px macOS traffic-light reservation plus the identity avatar slot
  // (owner D-line final ruling 2026-11-09), and mounts no switcher.
  assert.doesNotMatch(railSource, /BotBrowserModeSwitch/);
  assert.doesNotMatch(railSource, /surface-switch-trigger/);
  assert.match(railSource, /isMac \? 'h-\[52px\]' : 'h-3'/);

  assert.match(sidebarSource, /data-slot="mid-column-header"/);
  // The switcher rides the shared header bar below the traffic-light strip
  // (owner ruling 22:19: the same position on both faces).
  assert.match(sidebarSource, /data-slot="mid-column-header"[\s\S]{0,420}<BotBrowserModeSwitch/);
  assert.match(sidebarSource, /onSelectSurface: \(mode: BotBrowserSurfaceMode\) => void;/);
  // The header control chooses the SURFACE only — the record TYPE stays a
  // rail-only decision.
  assert.match(sidebarSource, /onSelectBrowser=\{\(\) => onSelectSurface\('browser'\)\}/);
  assert.match(sidebarSource, /onSelectHome=\{\(\) => onSelectSurface\('home'\)\}/);
  // App feeds the same two transitions the rail used to emit.
  assert.match(appSource, /onSelectSurface=\{\(mode\) => \{[\s\S]{0,200}openBrowserHome/);
});

test('the Co-Work face no longer introduces itself in either column', () => {
  // The NAME used to belong to the rail entry that opened the destination
  // (owner ruling 2026-11-08 14:15); that entry is retired as well (20:18), so
  // neither column restates it. The session window's two actions moved OUT of
  // the panel into the shared surface header bar (owner spec 21:31) — the
  // panel body now carries no action row at all.
  const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
  assert.doesNotMatch(panelSource, /botBrowserCoworkTitle/);
  // The action slots ride the shared header bar (owner ruling 22:19 keeps the
  // 21:31 bar structure); the records overlay itself keeps the baseline
  // restyle and has no second action row inside the panel.
  assert.match(sidebarSource, /data-slot="cowork-new-session"/);
  assert.match(sidebarSource, /data-slot="cowork-toggle-history"/);
  assert.match(sidebarSource, /botBrowserCoworkNew/);
  assert.match(sidebarSource, /botBrowserCoworkHistory/);
  assert.match(panelSource, /CoworkHistoryPanel/);
  assert.doesNotMatch(panelSource, /data-slot="cowork-panel-actions"/);

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
  assert.match(appSource, /\) : \(\n {4}coworkLandingCard\n {2}\);/);
});

test('surface header: the open session name is the actions row’s LEFT title; 新建会话/会话记录 keep the right end (owner order 2026-11-11 18:05, item ④ rework — supersedes the 17:37 between-buttons order)', () => {
  // SUPERSESSION (owner 18:05 screenshot rework): the 17:37 order placed the
  // name strictly BETWEEN the two buttons; the rework makes it the row's
  // LEFT title — directly under the Studio label — with the icon buttons
  // packed at the right end. Sidebar composes the slot as a component tag
  // (the data-slot attribute itself lives in CoworkSurfaceSessionName.tsx
  // and is pinned by the next test), so the ORDER anchor here is the tag,
  // not the rendered attribute.
  const nameAt = sidebarSource.indexOf('<CoworkSurfaceSessionName');
  const newSessionAt = sidebarSource.indexOf('data-slot="cowork-new-session"');
  const historyAt = sidebarSource.indexOf('data-slot="cowork-toggle-history"');
  assert.ok(nameAt !== -1, 'session-name slot anchor');
  assert.ok(newSessionAt !== -1, 'new-session button anchor');
  assert.ok(historyAt !== -1, 'history button anchor');
  assert.ok(nameAt < newSessionAt, 'name slot must come BEFORE the new-session button (left title lane)');
  assert.ok(nameAt < historyAt, 'name slot must come BEFORE the history button');
  assert.ok(newSessionAt < historyAt, 'the two icon buttons keep their relative order');
  // Exactly one slot mount, still on the SAME actions row (inside the
  // surfaceHeaderActions branch, before it is handed to the mode switch).
  assert.equal(sidebarSource.split('<CoworkSurfaceSessionName').length - 1, 1, 'exactly one session-name slot');

  // The slot's title comes from the SHARED sessions list — the store node
  // updateSessionTitle patches — with the browserCowork slice reduced to a
  // pointer plus a startup-window fallback. A stale snapshot must never be
  // the authoritative title.
  assert.match(sidebarSource, /state\.browserCowork\.currentSession\?\.id \?\? null/);
  assert.match(
    sidebarSource,
    /sessions\.find\(\(session\) => session\.id === browserOpenSessionId\)/,
  );

  // The slot wires the EXISTING rename channel (coworkService.renameSession
  // via listOnRenameSession) — never a second IPC path.
  assert.match(sidebarSource, /onRename=\{listOnRenameSession\}/);
});

test('surface session-name slot: read-only default, inline editor, empty commit falls back (item ④ contract)', () => {
  const componentSource = read('src/renderer/features/botBrowser/CoworkSurfaceSessionName.tsx');
  // Default state is a read-only BUTTON; editing swaps in an inline INPUT.
  assert.match(componentSource, /data-slot="cowork-surface-session-name"/);
  assert.match(componentSource, /data-slot="cowork-surface-session-name-input"/);
  // Enter commits, Escape cancels, blur commits — the transcript header's
  // rename contract, mirrored here.
  assert.match(componentSource, /if \(e\.key === 'Enter'\)/);
  assert.match(componentSource, /if \(e\.key === 'Escape'\)/);
  assert.match(componentSource, /onBlur=\{handleRenameBlur\}/);
  // Draft state (no open session) — superseded by the owner 18:54
  // left-anchor order: the slot renders a non-interactive spacer (same
  // flex-1 lane) instead of unmounting, so the identity component ahead of
  // it never drifts right when the name is absent. Intent kept (no name
  // control in draft) and extended (the spacer slot exists).
  assert.match(componentSource, /data-slot="cowork-surface-session-name-spacer"/);
  // The decision math is delegated to the pure module (tested behaviorally
  // in tests/surfaceSessionName.test.ts).
  assert.match(componentSource, /decideSurfaceSessionRename\(/);
  assert.match(componentSource, /resolveSurfaceSessionDisplayTitle\(/);
  // The pure module pins empty → noop (fallback title, never blank) and the
  // trim-first fallback.
  const pureSource = read('src/renderer/features/botBrowser/surfaceSessionName.ts');
  assert.match(pureSource, /if \(!nextTitle\) return \{ action: 'noop' \};/);
  assert.match(pureSource, /return trimmed \|\| fallbackTitle;/);
  // 18:05 rework: the slot is the row's LEFT TITLE. Its root lane grows
  // (min-w-0 flex-1) so the actions row packs the icon cluster to the right
  // end; the title reads one level darker + medium at 13 px and the label
  // truncates with an ellipsis. Extended by the owner 18:54 left-anchor
  // order: ALL THREE mounts carry the lane classes — the read-only button,
  // the inline editor, AND the draft spacer — so the row's geometry holds
  // across every state swap and the identity component stays left-pinned
  // even with no open session.
  assert.equal((componentSource.match(/min-w-0 flex-1/g) ?? []).length, 3, 'title lane on all three mounts (read-only + editor + draft spacer)');
  assert.match(componentSource, /text-\[13px\] font-medium/);
  assert.match(componentSource, /text-claude-text dark:text-claude-darkText/);
  // Owner 18:54 frameless-editor order: the inline editor carries NO box —
  // transparent background, no border, no ring, no shadow; the 13 px medium
  // metrics stay identical to the display state and only the caret marks
  // the edit affordance. (The old boxed input broke the title look.)
  const editorBlock = componentSource.slice(componentSource.indexOf('data-slot="cowork-surface-session-name-input"'));
  const editorClassName = editorBlock.slice(editorBlock.indexOf('className="'), editorBlock.indexOf('\n', editorBlock.indexOf('className="')));
  assert.match(editorClassName, /bg-transparent/);
  assert.match(editorClassName, /border-0/);
  assert.match(editorClassName, /focus:ring-0/);
  assert.match(editorClassName, /shadow-none/);
  assert.match(editorClassName, /text-\[13px\] font-medium/);
  assert.doesNotMatch(editorClassName, /border-claude|ring-2|ring-claude|bg-claude-darkBg|bg-claude-bg|rounded-lg/);
  assert.match(componentSource, /className="min-w-0 truncate"/);
});

test('the rail models are the single source of both surfaces’ entries', () => {
  assert.match(navigationSource, /export function getRailInternetNavModel/);
  assert.match(navigationSource, /export function getRailHomeNavModel/);
  assert.match(navigationSource, /export function getSurfaceMenuModel/);
  // Three visible internet destinations (the hidden Bot Hub slot stays
  // implemented) + four home destinations, one of which is the creation action
  // rather than a list. The Co-Work bubble entry is retired (owner ruling
  // 2026-11-08 20:18) — it is the surface's default face, not a rail row.
  for (const id of ['browser', 'metaapps', 'myBots', 'gigSquare']) {
    assert.ok(navigationSource.includes(`id: '${id}'`), `${id} is an internet destination`);
  }
  assert.doesNotMatch(navigationSource, /id: 'cowork'/);
  assert.doesNotMatch(navigationSource, /chatBubbles/);
  for (const id of ['newTask', 'longTerm', 'groupTasks', 'records']) {
    assert.ok(navigationSource.includes(`id: '${id}'`), `${id} is a Bot Home destination`);
  }
});

test('the Co-Work face is the Internet default branch, not a rail pane', () => {
  const typesSource = read('src/renderer/features/botBrowser/types.ts');
  assert.match(typesSource, /export type BotInternetPane = 'browser' \| 'gigSquare' \| 'metaapps' \| 'myBots';/);
  assert.match(typesSource, /export type BotHomeSection = 'longTerm' \| 'groupTasks' \| 'records';/);
  // Slice-1 fix: the destination is resolved through the shared table instead
  // of an inline pane literal, so the completeness guard can see every branch.
  assert.match(appSource, /const internetPaneKey = resolveInternetPaneRenderer\(botBrowserShell\.internetPane\);/);
  assert.match(appSource, /const coworkLandingCard = \(/);
  // 20:18 ruling: the Co-Work mapping is consolidated into the DEFAULT branch.
  // `cowork` must not come back as a pane row, and the card must stay the
  // fallback (a real rendered branch, never `null`).
  const destinationsSource = read('src/renderer/components/layout/workspaceDestinations.js');
  assert.doesNotMatch(destinationsSource, /cowork: 'coworkLanding'/);
  assert.match(destinationsSource, /INTERNET_PANE_FALLBACK_RENDERER = 'coworkLanding'/);
  assert.match(destinationsSource, /resolveInternetPaneRenderer\(pane\) \{\s*return INTERNET_PANE_RENDERERS\[pane\] \?\? INTERNET_PANE_FALLBACK_RENDERER;/);
});
