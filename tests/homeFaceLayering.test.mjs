import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getHomeSectionModel,
  getRailHomeNavModel,
  getRailInternetNavModel,
  getSidebarPrimaryNavModel,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

/**
 * Bot Home face: layout, destination entry point and the session records body.
 *
 * Owner ruling 2026-11-08 14:22: "Bot home 界面先恢复到原来的状态，目前的 bot
 * internet 界面的改动不变" — Bot Home goes back to the baseline TWO-column form,
 * Bot Internet keeps the three-column shell untouched.
 *
 * Owner ruling 2026-11-08 15:46 (supersedes the 14:22 menu/tab composition
 * pinned below, and §X of the closeout report):
 *   · the 「我的 Bot」TEXT ROW is retired from the Home menu (its destination
 *     keeps its Bot Internet rail entry — myBots → metabotsView);
 *   · the 「群任务」RECORD SIGN is retired: the tab row is two signs
 *     (本地对话 / 线上对话), and the group_task chat-channel list no longer
 *     renders inside Home. The 多人任务 row still opens the management view.
 * Nothing is deleted data-wise: sessions stay in the store, task rows stay in
 * the groupTasks slice; only the two Home signboards are gone.
 *
 * What that means for this suite:
 *   1. The Home face mounts NO rail. Its destinations are the baseline TEXT
 *      rows (新建任务 / 长期任务 / 多人任务) in HomeSidebar.tsx.
 *   2. The record-type selector is the sidebar's own text tab row — the drawer
 *      stays retired (owner ruled it redundant), and this is its only entrance.
 *   3. The amber 「待拍板」 decision dot is back on the restored 长期任务 row:
 *      same derivation, same condition (total > 0), same class.
 *   4. The records list keeps the accepted 6165d6449 fusion unchanged: by-Bot
 *      grouped template on both faces, group header = avatar + name + trailing
 *      +, no empty groups on the online face, per-face memory keys.
 *   5. Group-task CHAT CHANNELS no longer have a Home entry (15:46); the
 *      多人任务 row is the management-view door, pinned below.
 *
 * Internet anchors (mid-column header, Co-Work panel, rail) are NOT touched by
 * the restore and are pinned by workspaceRailStatic / botBrowserShellStatic.
 * `Sidebar.tsx` keeps its (now Internet-only) home bodies byte-identical, so
 * those older anchors still hold; the live Home path is HomeSidebar.tsx and is
 * pinned here.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const appSource = read('src/renderer/App.tsx');
const homeSidebarSource = read('src/renderer/components/HomeSidebar.tsx');
const sidebarSource = read('src/renderer/components/Sidebar.tsx');
const railSource = read('src/renderer/components/layout/WorkspaceRail.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');
const navModelSource = read('src/renderer/components/sidebar/sidebarNavigation.js');

test('the Home face mounts the three-column shell: rail | records column | right column', () => {
  // Three-column final ruling 2026-11-09 (supersedes the 14:22 two-column
  // degradation): the Home branch mounts the SAME WorkspaceRail the Internet
  // branch mounts, followed by the records mid column. Both faces share the
  // one shell container; the rail appears exactly twice (once per face).
  assert.match(appSource, /\{showHomeSurface \? \(\s*<>\s*\{\/\*[\s\S]*?\*\/\}\s*<WorkspaceRail/);
  assert.equal((appSource.match(/<WorkspaceRail/g) ?? []).length, 2, 'one rail mount per face');
  assert.ok(
    appSource.indexOf('<HomeSidebar') > appSource.indexOf('<WorkspaceRail'),
    'the home branch is [rail, records column]: the rail is the first column',
  );
  // The shell no longer degrades on Home: same four tracks, the rail keeps
  // its 64px column, the records column keeps its user-resizable track, and
  // a collapsed middle track still leaves the 4px handle + recoverable rail.
  assert.match(appSource, /data-shell-face=\{showHomeSurface \? 'home' : 'browser'\}/);
  // 接缝按钮双向化 2026-11-09: the home face reads its OWN single-direction
  // seam machine (homeSeamCollapsed) — not the Studio face's three-state one.
  assert.match(appSource, /const homeShellGridTemplate = homeSeamCollapsed/);
  assert.match(appSource, /\? '64px 0px 4px minmax\(0, 1fr\)'/);
  assert.match(appSource, /: '64px auto 4px minmax\(0, 1fr\)'/);

  // The records column keeps its composition: switcher + records + footer.
  assert.match(homeSidebarSource, /data-slot="workspace-home-sidebar"/);
  assert.match(homeSidebarSource, /data-slot="mid-column-header"/);
  assert.match(homeSidebarSource, /<BotBrowserModeSwitch/);
  // Owner ruling 2026-11-08 20:59: the full "My ME" panel is retired from the
  // BotWorks face footer; the Studio face keeps the compact rail badge.
  assert.doesNotMatch(homeSidebarSource, /MeBalanceBadge/);
  assert.match(homeSidebarSource, /i18nService\.t\('coworkHistory'\)/);
});

test('the Home destinations are the rail icon entries — 新建任务/长期任务/多人任务', () => {
  // Three-column final ruling 2026-11-09: the three entries moved to the
  // rail's home nav. The model keeps FOUR items (records included) but the
  // rail filters `records` out — the records BODY is always on screen in the
  // middle column, so a fourth icon would add a door the face never had.
  const railRows = getRailHomeNavModel({ t: (key) => key, hasRunningScheduledTask: false })
    .filter((item) => !item.hidden)
    .filter((item) => item.id !== 'records');
  assert.deepEqual(
    railRows.map((item) => item.id),
    ['newTask', 'longTerm', 'groupTasks'],
    'the three entries, in rail order',
  );

  // The roster did not lose its only door: the Bot Internet rail keeps myBots,
  // and it resolves to the same metabotsView.
  const internetRows = getRailInternetNavModel({ t: (key) => key }).filter((item) => !item.hidden);
  assert.equal(internetRows.find((item) => item.id === 'myBots')?.label, 'metabots');

  // The rail renders the FILTERED home model; App wires the OLD rows'
  // behavior VERBATIM in the home-branch mount — 新建任务 →
  // handleBlankNewChat (the rail's own onNewChat hook), 长期任务 →
  // handleShowScheduledTasks, 多人任务 → handleShowGroupTasks. No Home-side
  // 我的 Bot wiring survives.
  const branchStart = appSource.indexOf('{showHomeSurface ? (');
  const homeBranch = appSource.slice(branchStart, appSource.indexOf(') : (', branchStart));
  assert.match(homeBranch, /onNewChat=\{handleBlankNewChat\}/);
  assert.match(homeBranch, /handleShowScheduledTasks\(\)/);
  assert.match(homeBranch, /handleShowGroupTasks\(\)/);
  assert.doesNotMatch(homeBranch, /onShowMetabots/);
  assert.match(railSource, /homeItems\.filter\(\(item\) => item\.id !== 'records'\)/);
  assert.match(railSource, /if \(id === 'newTask'\) \{/);
  assert.match(railSource, /const handleHomeItem = \(id: string\) => \{/);
  // The records column renders no task rows and no rail machinery.
  assert.doesNotMatch(homeSidebarSource, /getSidebarPrimaryNavModel/);
  assert.doesNotMatch(homeSidebarSource, /data-slot="rail-item"/);
  assert.doesNotMatch(homeSidebarSource, /onShowMetabots/);
});

test('the record type has exactly ONE entry point: the sidebar text tabs', () => {
  // The retired drawer stays retired: no <select>, no second copy of the
  // three-type model, no rail section.
  assert.doesNotMatch(homeSidebarSource, /data-slot="home-record-type"/);
  assert.doesNotMatch(homeSidebarSource, /<select\b/);
  assert.doesNotMatch(homeSidebarSource, /getHomeSectionModel/);
  assert.doesNotMatch(appSource, /data-slot="home-record-type"/);

  // The tab row is the selector: TWO signs after the 15:46 ruling (本地对话 /
  // 线上对话), both rendered as text. The 群任务 sign is gone.
  const tableStart = homeSidebarSource.indexOf('const TASK_RECORD_TABS');
  const tableEnd = homeSidebarSource.indexOf('const TASK_RECORD_TAB_STORAGE_KEY');
  const table = homeSidebarSource.slice(tableStart, tableEnd);
  assert.match(table, /id: 'local'/);
  assert.match(table, /id: 'a2a'/);
  assert.doesNotMatch(table, /id: 'group'/);
  assert.equal((table.match(/id: '/g) ?? []).length, 2);
  assert.match(homeSidebarSource, /data-slot="home-session-scope"[\s\S]{0,400}grid-cols-2/);
  assert.match(homeSidebarSource, /aria-pressed=\{isActive\}/);

  // The retired sign took its whole render branch with it — no task-card list,
  // no group-task session slot, no group-only load gate survives on Home.
  assert.doesNotMatch(homeSidebarSource, /UnifiedTaskList/);
  assert.doesNotMatch(homeSidebarSource, /data-slot="group-task-sessions"/);
  assert.doesNotMatch(homeSidebarSource, /taskRecordTab !== 'group'/);
  assert.doesNotMatch(homeSidebarSource, /sessionGroups\.group/);
  // A 'group' value persisted before the ruling must not resurrect the sign.
  assert.match(homeSidebarSource, /if \(stored === 'a2a'\) return stored;/);
});

test('the records body keeps the accepted by-Bot grouped template', () => {
  // ONE component, two data sources: the same session list is fed the local
  // bucket or the online bucket; nothing groups per face.
  assert.match(
    homeSidebarSource,
    /const faceViewMode = taskRecordTab === 'local' \? sessionViewMode : a2aViewMode;/,
    'each face feeds the same list its own remembered view mode',
  );
  assert.match(homeSidebarSource, /viewMode=\{faceViewMode\}/);
  assert.match(homeSidebarSource, /groupFace=\{taskRecordTab\}/);
  assert.match(
    homeSidebarSource,
    /onQuickCreateTask=\{handleQuickCreateTask\}/,
    'the trailing + on a bot group is the same action on both faces',
  );
  assert.match(homeSidebarSource, /const handleQuickCreateTask = useStableCallback\(\(botId: number\) => \{/);
  assert.match(homeSidebarSource, /dispatch\(setNewTaskMetabotId\(botId\)\)/);

  const listSource = read('src/renderer/components/cowork/CoworkSessionList.tsx');
  // The group header template: avatar + bot name, collapse control, trailing +.
  assert.match(listSource, /<SessionAvatarCircle/);
  assert.match(listSource, /aria-expanded=\{!collapsed\}/);
  assert.match(listSource, /onQuickCreateTask\(group\.bot\.id\)/);
  // The same grouping implementation drives both faces.
  assert.match(
    listSource,
    /groupSessionsByBot\(visibleSessions, sortMode, viewBots, \{ includeEmptyBots: groupFace === 'local' \}\)/,
  );
});

test('the local face defaults to 按 Bot, and each face keeps its own memory keys', () => {
  const grouping = read('src/renderer/utils/sessionViewGrouping.ts');
  assert.match(grouping, /export const DEFAULT_SESSION_VIEW_MODE: SessionViewMode = 'bot';/);

  const storage = read('src/renderer/utils/sessionGroupStorage.ts');
  // Same storage family as sidebarWidth: one idbots.* key per face + a legacy
  // unprefixed key that seeds the LOCAL face only.
  assert.match(storage, /local: 'idbots\.sessionGroups\.local'/);
  assert.match(storage, /a2a: 'idbots\.sessionGroups\.a2a'/);
  assert.match(storage, /local: 'idbots\.sessionViewMode\.local'/);
  assert.match(storage, /a2a: 'idbots\.sessionViewMode\.a2a'/);
  assert.match(storage, /LEGACY_SESSION_VIEW_MODE_STORAGE_KEY = 'sessionViewMode'/);
  assert.match(storage, /if \(face === 'local'\) \{/);
  // Fail-open: a corrupt preference never hides groups.
  assert.match(storage, /return new Set\(\);/);
  // The restored Home sidebar reads and writes the SAME per-face keys.
  assert.match(homeSidebarSource, /loadSessionViewMode\(\(key\) => window\.localStorage\.getItem\(key\), 'local'\)/);
  assert.match(homeSidebarSource, /loadSessionViewMode\(\(key\) => window\.localStorage\.getItem\(key\), 'a2a'\)/);
  assert.match(homeSidebarSource, /saveSessionViewMode\([\s\S]{0,160}'a2a',\s*next,/);

  const listSource = read('src/renderer/components/cowork/CoworkSessionList.tsx');
  assert.match(listSource, /loadCollapsedSessionGroups\(\(key\) => window\.localStorage\.getItem\(key\), groupFace\)/);
  assert.match(listSource, /saveCollapsedSessionGroups\(/);
  assert.match(listSource, /\}, \[groupFace\]\);/);
});

test('the group-task door is the rail 多人任务 icon; the Home record list is two tabs', () => {
  // Owner ruling 2026-11-08 15:46 SUPERSEDES the 14:22 contract that group-task
  // chat channels stay reachable under a Home 「群任务」tab. The sign is retired,
  // so the channel list no longer renders inside Home. Three-column final
  // ruling 2026-11-09: the management-view door moved from the text row to
  // the rail's 多人任务 icon; the wiring is App's home-branch rail mount and
  // the OLD rows' behavior (plain view switch — the drill-in reset belonged
  // to the removed Internet type drawer, never to the Home rows).
  const branchStart = appSource.indexOf('{showHomeSurface ? (');
  const homeBranch = appSource.slice(branchStart, appSource.indexOf(') : (', branchStart));
  assert.match(homeBranch, /handleShowGroupTasks\(\)/);
  assert.doesNotMatch(homeBranch, /selectGroupTask\(null\)/);
  const railModelBody = navModelSource.slice(
    navModelSource.indexOf('export function getRailHomeNavModel'),
    navModelSource.indexOf('export function getHomeSectionModel'),
  );
  assert.match(railModelBody, /id: 'groupTasks'/);
  assert.match(railModelBody, /icon: 'userGroup'/);

  // The management view loads its own task rows — it never depended on the tab.
  const groupTasksView = read('src/renderer/components/groupTasks/GroupTasksView.tsx');
  assert.match(groupTasksView, /void groupTaskService\.loadTasks\(\);/);

  // No data was deleted on the view side: Home still reads the FULL session list
  // (search spans it) and the default local list keeps excluding group_task rows.
  assert.match(homeSidebarSource, /const homeSessions = sessions;/);
  assert.match(homeSidebarSource, /session\.sessionType !== 'group_task'/);
  // …and it derives no group bucket that a retired sign could select.
  assert.doesNotMatch(homeSidebarSource, /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/);

  // The Bot Internet middle column keeps its own (untouched) group bucket, so
  // the older sidebar contract still holds where it is still rendered.
  assert.match(sidebarSource, /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/);
  assert.match(sidebarSource, /data-slot="group-task-sessions"/);
  // Both locales carry the section title, so the Internet copy is never unlabelled.
  assert.equal((i18nSource.match(/homeMidGroupSessionsTitle:/g) ?? []).length, 2);
});

test('the amber decision dot rides the rail 长期任务 entry on BOTH faces', () => {
  // Three-column final ruling 2026-11-09: the Home face's dot lives on the
  // RAIL's 长期任务 icon — the same rail mount serves both faces now, so the
  // dot machinery is defined once and rendered on both surfaces. Same
  // derivation, same condition, same class as the accepted dot work (the
  // detail pins live in trackedTaskDecisionBadge.test.ts).
  assert.match(railSource, /hasIndicator=\{item\.hasIndicator\}/);
  assert.match(railSource, /indicatorKind=\{item\.indicatorKind\}/);
  const railModelBody = navModelSource.slice(
    navModelSource.indexOf('export function getRailHomeNavModel'),
    navModelSource.indexOf('export function getHomeSectionModel'),
  );
  assert.match(railModelBody, /hasIndicator: Boolean\(hasRunningScheduledTask\) \|\| hasDecision/);
  assert.match(railModelBody, /indicatorKind: hasDecision \? 'decision' : hasRunningScheduledTask \? 'running' : undefined/);
  assert.match(railModelBody, /trackedTaskNeedsDecision/);

  // Neither middle column carries a second copy of the dot: the records
  // column dropped the sidebar-row copy with the rows themselves, and the
  // Internet mid column never had one.
  assert.doesNotMatch(homeSidebarSource, /tracked-task-decision-indicator/);
  assert.doesNotMatch(homeSidebarSource, /selectTrackedTasksNeedingAttention/);
  assert.doesNotMatch(sidebarSource, /tracked-task-decision-indicator/);
});

test('the rail keeps its model unchanged for the Internet surface', () => {
  // The rail component itself is untouched by the Home restore: it still lists
  // the four Bot Home destinations in its model (used by its own branch and by
  // the destination table), even though the Home face no longer mounts it.
  const railModel = getRailHomeNavModel({ t: (key) => key, hasRunningScheduledTask: false })
    .filter((item) => !item.hidden);
  assert.deepEqual(
    railModel.map((item) => item.id),
    ['newTask', 'longTerm', 'groupTasks', 'records'],
  );
  assert.match(railSource, /active=\{item\.id === 'newTask' \? false : homeSection === item\.id\}/);
  assert.match(railSource, /onSelectHomeSection\(id as BotHomeSection\)/);

  // The baseline three-type contract list is retained (the mid-column bodies
  // in Sidebar.tsx still name it); the restored Home face simply does not use
  // it as a selector.
  const types = getHomeSectionModel({ t: (key) => key }).map((section) => section.id);
  assert.deepEqual(types, ['longTerm', 'groupTasks', 'records']);
});

test('the mid-column header still chooses the SURFACE, never the record type', () => {
  // Internet anchor — unchanged by the Home restore (Sidebar.tsx untouched).
  const headerStart = sidebarSource.indexOf('data-slot="mid-column-header"');
  const headerEnd = sidebarSource.indexOf("{mode === 'home' ? (", headerStart);
  assert.ok(headerStart > 0 && headerEnd > headerStart, 'the header band exists and ends at the body');
  const headerBlock = sidebarSource.slice(headerStart, headerEnd);
  assert.match(headerBlock, /<BotBrowserModeSwitch/);
  assert.match(headerBlock, /onSelectSurface\('browser'\)/);
  assert.match(headerBlock, /onSelectSurface\('home'\)/);
  for (const section of ['longTerm', 'groupTasks', 'records']) {
    assert.doesNotMatch(headerBlock, new RegExp(`'${section}'`));
  }

  // The restored Home sidebar carries exactly one switcher too (same capsule),
  // so neither face can ever show two switchers at once.
  assert.equal((homeSidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);
  assert.equal((sidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);
  assert.equal((appSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 0);
});
