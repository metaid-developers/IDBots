import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getHomeSectionModel,
  getRailHomeNavModel,
  getSidebarPrimaryNavModel,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

/**
 * Bot Home face: layout, destination entry point and the session records body.
 *
 * Owner ruling 2026-11-08 14:22 (supersedes the 14:15 three-column Home):
 * "Bot home 界面先恢复到原来的状态，目前的 bot internet 界面的改动不变" —
 * Bot Home goes back to the baseline TWO-column form, Bot Internet keeps the
 * three-column shell untouched.
 *
 * What that means for this suite:
 *   1. The Home face mounts NO rail. Its destinations are the baseline TEXT
 *      rows (新建任务 / 长期任务 / 多人任务 / 我的 Bot) in HomeSidebar.tsx.
 *   2. The record-type selector is the sidebar's own text tab row — the drawer
 *      stays retired (owner ruled it redundant), and this is its only entrance.
 *   3. The amber 「待拍板」 decision dot is back on the restored 长期任务 row:
 *      same derivation, same condition (total > 0), same class.
 *   4. The records list keeps the accepted 6165d6449 fusion unchanged: by-Bot
 *      grouped template on both faces, group header = avatar + name + trailing
 *      +, no empty groups on the online face, per-face memory keys.
 *   5. group_task chat channels stay reachable under the group tab.
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

test('the Home face mounts the restored text sidebar and NO rail', () => {
  // App gates the left slot on the surface: Home → HomeSidebar, Internet →
  // rail + mid column. The Home branch therefore never renders a rail item.
  assert.match(appSource, /\{showHomeSurface \? \(\s*<HomeSidebar/);
  assert.equal((appSource.match(/<WorkspaceRail/g) ?? []).length, 1, 'one rail mount, in the Internet branch');
  assert.ok(
    appSource.indexOf('<HomeSidebar') < appSource.indexOf('<WorkspaceRail'),
    'the Home sidebar is the home branch; the rail only appears in the else branch',
  );
  // The shell degrades on Home instead of replacing the container: the rail
  // track goes to 0 and the sidebar takes track 1 (four tracks stay so the
  // seam and the right column keep their explicit placement).
  assert.match(appSource, /data-shell-face=\{showHomeSurface \? 'home' : 'browser'\}/);
  assert.match(appSource, /const homeShellGridTemplate = 'auto 0px 4px minmax\(0, 1fr\)';/);

  // The restored sidebar is the baseline composition, not the three-column
  // column: text rows + switcher + records + footer.
  assert.match(homeSidebarSource, /data-slot="workspace-home-sidebar"/);
  assert.match(homeSidebarSource, /<BotBrowserModeSwitch/);
  assert.match(homeSidebarSource, /<MeBalanceBadge \/>/);
  assert.match(homeSidebarSource, /i18nService\.t\('coworkHistory'\)/);
});

test('the Home destinations are the baseline text menu rows', () => {
  const homeRows = getSidebarPrimaryNavModel({
    t: (key) => key,
    hasRunningScheduledTask: false,
  }).filter((item) => !item.hidden);
  assert.deepEqual(
    homeRows.map((item) => item.id),
    ['scheduledTasks', 'groupTasks', 'metabots'],
    'long-term / multi-bot / my-bots — the baseline menu after the creation action',
  );

  assert.match(homeSidebarSource, /getSidebarPrimaryNavModel/);
  assert.match(homeSidebarSource, /onClick=\{onNewChat\}/);
  assert.match(homeSidebarSource, /i18nService\.t\('newChat'\)/);
  assert.match(homeSidebarSource, /const handlePrimaryNavClick = \(itemId: string\) => \{/);
  assert.match(homeSidebarSource, /onShowScheduledTasks\(\)/);
  assert.match(homeSidebarSource, /onShowGroupTasks\(\)/);
  assert.match(homeSidebarSource, /onShowMetabots\(\)/);

  // Row order is data, not scatter: the creation row sits above the mapped
  // rows, and the click handlers never re-open a drilled-in group task.
  const newChatRow = homeSidebarSource.indexOf('onClick={onNewChat}');
  const mappedRows = homeSidebarSource.indexOf('{primaryNavItems.map(');
  assert.ok(newChatRow > 0 && mappedRows > newChatRow, 'new task row first, then the mapped destinations');
  assert.match(homeSidebarSource, /dispatch\(selectGroupTask\(null\)\)/);
});

test('the record type has exactly ONE entry point: the sidebar text tabs', () => {
  // The retired drawer stays retired: no <select>, no second copy of the
  // three-type model, no rail section.
  assert.doesNotMatch(homeSidebarSource, /data-slot="home-record-type"/);
  assert.doesNotMatch(homeSidebarSource, /<select\b/);
  assert.doesNotMatch(homeSidebarSource, /getHomeSectionModel/);
  assert.doesNotMatch(appSource, /data-slot="home-record-type"/);

  // The tab row is the selector: three baseline scopes, all rendered as text.
  const tableStart = homeSidebarSource.indexOf('const TASK_RECORD_TABS');
  const tableEnd = homeSidebarSource.indexOf('const TASK_RECORD_TAB_STORAGE_KEY');
  const table = homeSidebarSource.slice(tableStart, tableEnd);
  assert.match(table, /id: 'local'/);
  assert.match(table, /id: 'a2a'/);
  assert.match(table, /id: 'group'/);
  assert.equal((table.match(/id: '/g) ?? []).length, 3);
  assert.match(homeSidebarSource, /data-slot="home-session-scope"[\s\S]{0,400}grid-cols-3/);
  assert.match(homeSidebarSource, /aria-pressed=\{isActive\}/);
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

test('both lists default to 按 Bot, and each face keeps its own memory keys', () => {
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

test('group-task sessions stay reachable under the group tab', () => {
  assert.match(homeSidebarSource, /data-slot="group-task-sessions"/);
  assert.match(
    homeSidebarSource,
    /data-slot="group-task-sessions"[\s\S]{0,600}sessions=\{sessionGroups\.group\}/,
    'the group-task session list is fed by the group_task session bucket',
  );
  assert.match(
    homeSidebarSource,
    /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/,
  );
  // The tab loads/polls the task rows when it opens, not on app start.
  assert.match(homeSidebarSource, /if \(taskRecordTab !== 'group'\) return;\s*\n\s*void groupTaskService\.loadTasks\(\);/);
  assert.match(homeSidebarSource, /if \(taskRecordTab !== 'group'\) return;\s*\n\s*let cancelled = false;/);
  // Both locales carry the section title, so the list is never unlabelled.
  assert.equal((i18nSource.match(/homeMidGroupSessionsTitle:/g) ?? []).length, 2);
});

test('the amber decision dot is back on the restored 长期任务 row', () => {
  // Same derivation, same condition, same class/style as the accepted dot work.
  assert.match(homeSidebarSource, /selectTrackedTasksNeedingAttention\(\{ longTermTask: \{ board: longTermBoard \} \}\)/);
  assert.match(homeSidebarSource, /needsDecisionCount: trackedTaskAttention\.total/);
  assert.match(homeSidebarSource, /tracked-task-decision-indicator/);
  assert.match(homeSidebarSource, /indicatorKind === 'decision'/);
  assert.match(homeSidebarSource, /role="img"[\s\S]{0,160}aria-label=\{item\.indicatorLabel\}/);
  const model = read('src/renderer/components/sidebar/sidebarNavigation.js');
  assert.match(model, /export function getSidebarPrimaryNavModel/);
  assert.match(model, /trackedTaskNeedsDecision/);
  assert.match(model, /const hasDecision = decisionCount > 0;/);
  assert.match(model, /indicatorKind: hasDecision \? 'decision' : hasRunningScheduledTask \? 'running' : undefined/);

  // The Internet mid column still carries no second copy of the dot; the rail
  // keeps its own copy for its own surface (pinned by
  // trackedTaskDecisionBadge.test.ts). No Home face shows two amber dots.
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
