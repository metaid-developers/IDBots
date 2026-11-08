import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getHomeSectionModel,
  getRailHomeNavModel,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

/**
 * Bot Home face: the destination selector and the session scopes.
 *
 * Owner ruling 2026-11-08 (three rounds, merged):
 *   1. the record TYPE (long-term / group tasks / records) is the destination
 *      selector, and the LEFT RAIL is its ONLY entry point. The middle column's
 *      type drawer (`<select data-slot="home-record-type">`) was removed: it
 *      duplicated the rail, and its amber decision dot duplicated the rail's.
 *   2. the session SCOPE tabs belong to the records body only — two of them
 *      (local / online), sitting strictly BELOW the type the rail picked.
 *   3. the retired «群任务» scope is not allowed to lose reachability: every
 *      session_type='group_task' session must still be listed under the
 *      group-tasks record type.
 *   4. BOTH records faces render the same by-Bot grouped template (one
 *      collapsible group per bot, group header = avatar + name, trailing +
 *      starts a new task with that bot), default 按 Bot, and each face
 *      remembers its own grouping state.
 *
 * The suite pins the single entry point, the layering, the scope set, the
 * reachability the removed tab used to provide, and the shared grouping
 * template with its per-face memory.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const sidebarSource = read('src/renderer/components/Sidebar.tsx');
const railSource = read('src/renderer/components/layout/WorkspaceRail.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('the record type has exactly ONE entry point: the left rail', () => {
  // The middle column owns no type selector at all — no drawer, no <select>,
  // no second copy of the three-type model.
  assert.doesNotMatch(sidebarSource, /data-slot="home-record-type"/);
  assert.doesNotMatch(sidebarSource, /<select\b/);
  assert.doesNotMatch(sidebarSource, /getHomeSectionModel/);

  // The rail's model is the destination table: four Bot Home entries, three of
  // which are record types (the fourth is the creation action).
  const railModel = getRailHomeNavModel({ t: (key) => key, hasRunningScheduledTask: false })
    .filter((item) => !item.hidden);
  assert.deepEqual(
    railModel.map((item) => item.id),
    ['newTask', 'longTerm', 'groupTasks', 'records'],
  );

  // The rail is what marks the current type, and clicking it is what switches.
  assert.match(railSource, /active=\{item\.id === 'newTask' \? false : homeSection === item\.id\}/);
  assert.match(railSource, /onSelectHomeSection\(id as BotHomeSection\)/);
});

test('the mid-column header chooses the SURFACE, never the record type', () => {
  // Owner ruling 2026-11-08 14:15 moved the surface switcher into this header.
  // It is a SURFACE selector: no section id and no section handler may appear
  // in that band, otherwise the "rail is the ONLY record-type entry point" rule
  // above would quietly gain a second entrance.
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
});

test('the middle column renders the body of whichever type the rail picked', () => {
  // homeSection is a prop (derived in App from mainView), not local state: the
  // column cannot disagree with the rail about where the user is.
  assert.match(sidebarSource, /homeSection: BotHomeSection;/);
  for (const section of ['longTerm', 'groupTasks', 'records']) {
    assert.match(sidebarSource, new RegExp(`data-home-section="${section}"`));
  }
  // No setter for the type exists in the column: only App's rail handler does.
  assert.doesNotMatch(sidebarSource, /setHomeSection|handleSectionSelect/);
  assert.doesNotMatch(sidebarSource, /onSelectHomeSection/);
  assert.match(read('src/renderer/App.tsx'), /const handleSelectHomeSection = useCallback\(\(section: BotHomeSection\)/);
});

test('the rail and the mid column name the same record types', () => {
  const types = getHomeSectionModel({ t: (key) => key }).map((section) => section.id);
  assert.deepEqual(types, ['longTerm', 'groupTasks', 'records']);
  const railTypes = getRailHomeNavModel({ t: (key) => key, hasRunningScheduledTask: false })
    .filter((item) => item.id !== 'newTask' && !item.hidden)
    .map((item) => item.id);
  assert.deepEqual(railTypes, types, 'rail and mid column name the same record types');
});

test('the record list keeps exactly two session scopes: local + online', () => {
  const table = sidebarSource.slice(
    sidebarSource.indexOf('const TASK_RECORD_TABS'),
    sidebarSource.indexOf('const TASK_RECORD_TAB_STORAGE_KEY'),
  );
  assert.match(table, /id: 'local'/);
  assert.match(table, /id: 'a2a'/);
  assert.doesNotMatch(table, /id: 'group'/, 'the group-task scope was retired into the record type');
  assert.equal((table.match(/id: '/g) ?? []).length, 2);

  // Type-level: the union no longer admits the retired scope.
  assert.match(sidebarSource, /type TaskRecordTab = 'local' \| 'a2a';/);
  // A profile carrying the retired value folds back to the local tab.
  assert.doesNotMatch(sidebarSource, /stored === 'group'/);
});

test('the scope row is a two-column group, not the old three-way split', () => {
  assert.match(sidebarSource, /data-slot="home-session-scope"[\s\S]{0,400}grid-cols-2/);
  assert.doesNotMatch(sidebarSource, /grid-cols-3/);
});

test('the scope tabs only exist inside the records body', () => {
  const recordsStart = sidebarSource.indexOf('data-home-section="records"');
  const scopeIndex = sidebarSource.indexOf('data-slot="home-session-scope"');
  assert.ok(recordsStart > 0 && scopeIndex > recordsStart, 'scope tabs sit inside the records body');

  const longTermStart = sidebarSource.indexOf('data-home-section="longTerm"');
  const groupStart = sidebarSource.indexOf('data-home-section="groupTasks"');
  assert.ok(longTermStart > 0 && groupStart > 0);
  assert.ok(
    sidebarSource.slice(longTermStart, groupStart).indexOf('home-session-scope') === -1,
    'the long-term body carries no session-scope tabs',
  );
  assert.ok(
    sidebarSource.indexOf('home-session-scope') > groupStart,
    'the scope row is not rendered above the records body any more',
  );
});

test('group-task sessions stay reachable under the group-tasks record type', () => {
  // The removed 「群任务」 tab used to be the only place those chat channels
  // showed up in the middle column. They now render under their own type...
  assert.match(sidebarSource, /data-slot="group-task-sessions"/);
  assert.match(
    sidebarSource,
    /data-slot="group-task-sessions"[\s\S]{0,600}sessions=\{sessionGroups\.group\}/,
    'the group-task session list is fed by the group_task session bucket',
  );
  // ...and that bucket is still the only group_task filter (no second source).
  assert.match(
    sidebarSource,
    /group:\s*homeSessions\.filter\(\(session\)\s*=>\s*session\.sessionType\s*===\s*'group_task'\)/,
  );
  // Both locales carry the section title, so the list is never unlabelled.
  assert.equal((i18nSource.match(/homeMidGroupSessionsTitle:/g) ?? []).length, 2);
});

test('the group-task rows load when their record type opens, not when a tab is picked', () => {
  // The load gate used to be the retired scope tab; it now follows the record
  // type, otherwise the section would render stale/empty lists.
  assert.match(sidebarSource, /if \(homeSection !== 'groupTasks'\) return;\s*\n\s*void groupTaskService\.loadTasks\(\);/);
  assert.match(sidebarSource, /if \(homeSection !== 'groupTasks'\) return;\s*\n\s*let cancelled = false;/);
  assert.doesNotMatch(sidebarSource, /taskRecordTab !== 'group'/);
});

test('both records faces render the same by-Bot grouped template', () => {
  // ONE component, two data sources: the same session list is fed the local
  // bucket or the online bucket; nothing groups per face.
  assert.match(
    sidebarSource,
    /const faceViewMode = taskRecordTab === 'local' \? sessionViewMode : a2aViewMode;/,
    'each face feeds the same list its own remembered view mode',
  );
  assert.match(sidebarSource, /viewMode=\{faceViewMode\}/);
  assert.match(sidebarSource, /groupFace=\{taskRecordTab\}/);
  assert.match(
    sidebarSource,
    /onQuickCreateTask=\{handleQuickCreateTask\}/,
    'the trailing + on a bot group is the same action on both faces',
  );

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

test('both lists default to 按 Bot, and each face remembers its own grouping', () => {
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
  // Both faces READ their own view key (the online face is not pinned).
  assert.match(sidebarSource, /loadSessionViewMode\(\(key\) => window\.localStorage\.getItem\(key\), 'local'\)/);
  assert.match(sidebarSource, /loadSessionViewMode\(\(key\) => window\.localStorage\.getItem\(key\), 'a2a'\)/);
  assert.match(sidebarSource, /saveSessionViewMode\([\s\S]{0,160}'a2a',\s*mode,/);

  // The list reads and writes the set through the per-face key, re-reading it
  // when the face changes (one component instance serves both faces).
  const listSource = read('src/renderer/components/cowork/CoworkSessionList.tsx');
  assert.match(listSource, /loadCollapsedSessionGroups\(\(key\) => window\.localStorage\.getItem\(key\), groupFace\)/);
  assert.match(listSource, /saveCollapsedSessionGroups\(/);
  assert.match(listSource, /\}, \[groupFace\]\);/);
});

test('the amber decision dot has exactly one home: the rail long-term entry', () => {
  // The mid column's copy lived on the removed drawer row. It must not come
  // back as a second "you are the blocker" signal.
  assert.doesNotMatch(sidebarSource, /tracked-task-decision-indicator/);
  assert.doesNotMatch(sidebarSource, /selectTrackedTasksNeedingAttention/);
  assert.doesNotMatch(sidebarSource, /trackedTaskNeedsDecision/);

  // The rail keeps the dot next to the 长期任务 icon, driven by the SAME
  // derivation, and only while something is actually waiting on the owner.
  assert.match(railSource, /selectTrackedTasksNeedingAttention\(\{ longTermTask: \{ board: longTermBoard \} \}\)/);
  assert.match(railSource, /needsDecisionCount: trackedTaskAttention\.total/);
  assert.match(railSource, /indicatorKind === 'decision'/);
  assert.match(railSource, /tracked-task-decision-indicator absolute right-1 top-1/);
  const model = read('src/renderer/components/sidebar/sidebarNavigation.js');
  assert.match(model, /const hasDecision = decisionCount > 0;/);
  assert.match(model, /indicatorKind: hasDecision \? 'decision' : hasRunningScheduledTask \? 'running' : undefined/);
});
