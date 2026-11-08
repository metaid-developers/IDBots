import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getHomeSectionModel,
  getRailHomeNavModel,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

/**
 * Bot Home face: two selector layers that must never read as peers.
 *
 * Owner ruling 2026-11-08:
 *   1. the record TYPE (long-term / group tasks / records) is the destination
 *      selector — ONE line of its own, above everything;
 *   2. the session SCOPE tabs belong to the records body only — two of them
 *      (local / online), sitting strictly BELOW the type row.
 *   3. the retired «群任务» scope is not allowed to lose reachability: every
 *      session_type='group_task' session must still be listed under the
 *      group-tasks record type.
 *
 * The suite pins the layering, the scope set, and the reachability that the
 * removed tab used to provide.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const sidebarSource = read('src/renderer/components/Sidebar.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

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

test('record type is its own single-line row ABOVE the session-scope tabs', () => {
  const typeIndex = sidebarSource.indexOf('data-slot="home-record-type"');
  const scopeIndex = sidebarSource.indexOf('data-slot="home-session-scope"');
  assert.ok(typeIndex > 0, 'the record-type selector exists');
  assert.ok(scopeIndex > 0, 'the session-scope row exists');
  assert.ok(typeIndex < scopeIndex, 'the type row renders before the scope tabs');

  // The type selector is a native single-line <select> over exactly the three
  // record types the rail model declares — no second set of pills, no state.
  assert.match(sidebarSource, /<select[\s\S]{0,400}data-slot="home-record-type"/);
  assert.match(sidebarSource, /homeSections\.map\(\(section\) =>/);
  assert.match(sidebarSource, /onChange=\{\(event\) => handleSectionSelect\(event\.target\.value as BotHomeSection\)\}/);

  const types = getHomeSectionModel({ t: (key) => key }).map((section) => section.id);
  assert.deepEqual(types, ['longTerm', 'groupTasks', 'records']);
  // Same three destinations the rail exposes (minus the creation action).
  const railTypes = getRailHomeNavModel({ t: (key) => key, hasRunningScheduledTask: false })
    .filter((item) => item.id !== 'newTask' && !item.hidden)
    .map((item) => item.id);
  assert.deepEqual(railTypes, types, 'rail and mid column name the same record types');
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
  // Both locales carry the new section title, so the list is never unlabelled.
  assert.equal((i18nSource.match(/homeMidGroupSessionsTitle:/g) ?? []).length, 2);
  assert.equal((i18nSource.match(/homeRecordTypeLabel:/g) ?? []).length, 2);
});

test('the group-task rows load when their record type opens, not when a tab is picked', () => {
  // The load gate used to be the retired scope tab; it now follows the record
  // type, otherwise the section would render stale/empty lists.
  assert.match(sidebarSource, /if \(homeSection !== 'groupTasks'\) return;\s*\n\s*void groupTaskService\.loadTasks\(\);/);
  assert.match(sidebarSource, /if \(homeSection !== 'groupTasks'\) return;\s*\n\s*let cancelled = false;/);
  assert.doesNotMatch(sidebarSource, /taskRecordTab !== 'group'/);
});
