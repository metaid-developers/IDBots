// Autonomous Tasks folding for the sidebar's local-chats list.
//
// Main stamps `auto_origin` on sessions the app created on its own (long-term
// task runs, orchestration/delegation runs, scheduled-task runs); the summary
// carries it as `autoOrigin`. The sidebar splits the local list into the main
// list and the folded rows per the fold policy — all three machine origins fold
// (policy change: scheduled-task runs used to stay in the main list; they now
// fold with the rest so the main list stays the user's own conversations).
// What this suite pins: the pure split, the persisted fold preference, and the
// wiring invariants that keep a folded row out of the main list while keeping
// it searchable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTO_TASKS_EXPANDED_STORAGE_KEY,
  isAutoCreatedSession,
  isInAutonomousFold,
  parseAutoTasksExpandedPreference,
  serializeAutoTasksExpandedPreference,
  shouldFoldIntoAutonomousTasks,
  splitSessionsByAutonomousFold,
} from '../src/renderer/utils/sessionAutoGrouping';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const mkSession = (
  id: string,
  autoOrigin?: CoworkSessionSummary['autoOrigin'],
  foldOverride?: CoworkSessionSummary['foldOverride'],
): CoworkSessionSummary => ({
  id,
  title: `Session ${id}`,
  status: 'idle',
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  autoOrigin,
  foldOverride,
});

test('a manual fold placement wins over the auto-origin policy in both directions', () => {
  // No manual placement: the policy decides (the state of every untouched row).
  assert.equal(isInAutonomousFold(mkSession('human')), false);
  assert.equal(isInAutonomousFold(mkSession('lt', 'longterm')), true);
  assert.equal(isInAutonomousFold(mkSession('orch', 'orchestration')), true);
  assert.equal(isInAutonomousFold(mkSession('sched', 'schedule')), true);
  assert.equal(isInAutonomousFold(mkSession('human-null', null, null)), false, 'null override = policy');

  // 'in' parks a human row in the fold.
  assert.equal(isInAutonomousFold(mkSession('human-in', undefined, 'in')), true);
  assert.equal(isInAutonomousFold(mkSession('sched-in', 'schedule', 'in')), true);

  // 'out' pulls an autonomous run back into the main list without touching its
  // origin — scheduled runs included, now that they fold by policy.
  assert.equal(isInAutonomousFold(mkSession('lt-out', 'longterm', 'out')), false);
  assert.equal(isInAutonomousFold(mkSession('orch-out', 'orchestration', 'out')), false);
  assert.equal(isInAutonomousFold(mkSession('sched-out', 'schedule', 'out')), false);
  assert.equal(mkSession('lt-out', 'longterm', 'out').autoOrigin, 'longterm',
    'the creation fact survives the move');
});

test('a session owed an owner verdict leaves the fold — manual placement still wins', () => {
  const owed = new Set(['lt-owed', 'orch-owed']);

  // A waiting_owner long-term run renders on the MAIN timeline: the decision
  // surface must be seen, not buried in the collapsed folder.
  assert.equal(isInAutonomousFold(mkSession('lt-owed', 'longterm'), owed), false);
  assert.equal(isInAutonomousFold(mkSession('orch-owed', 'orchestration'), owed), false);
  // Sessions without a pending verdict keep the plain policy.
  assert.equal(isInAutonomousFold(mkSession('lt-quiet', 'longterm'), owed), true);
  assert.equal(isInAutonomousFold(mkSession('human-quiet'), owed), false);
  // A manual placement outranks the promotion in both directions.
  assert.equal(isInAutonomousFold(mkSession('lt-owed-in', 'longterm', 'in'), owed), true,
    'the owner can fold a decision session back in by hand');
  assert.equal(isInAutonomousFold(mkSession('lt-owed-out', 'longterm', 'out'), owed), false);
  // Without the set, the same owed session folds (legacy callers unchanged).
  assert.equal(isInAutonomousFold(mkSession('lt-owed', 'longterm')), true);

  const { humanSessions, autoSessions } = splitSessionsByAutonomousFold(
    [mkSession('human-1'), mkSession('lt-owed', 'longterm'), mkSession('lt-quiet', 'longterm')],
    owed,
  );
  assert.deepEqual(humanSessions.map((session) => session.id), ['human-1', 'lt-owed'],
    'the decision surface rides the main list, in place');
  assert.deepEqual(autoSessions.map((session) => session.id), ['lt-quiet']);
});

test('the split honours overrides: moved rows land on the other side, in order', () => {
  const sessions = [
    mkSession('human-1'),
    mkSession('pulled-out', 'longterm', 'out'),
    mkSession('pushed-in', undefined, 'in'),
    mkSession('auto-1', 'orchestration'),
  ];

  const { humanSessions, autoSessions } = splitSessionsByAutonomousFold(sessions);

  assert.deepEqual(humanSessions.map((session) => session.id), ['human-1', 'pulled-out']);
  assert.deepEqual(autoSessions.map((session) => session.id), ['pushed-in', 'auto-1']);
});

test('a session is auto-created when it carries a real origin marker, and long-term, orchestration and scheduled runs all fold', () => {
  assert.equal(isAutoCreatedSession(mkSession('human')), false, 'legacy rows (undefined) are human');
  assert.equal(isAutoCreatedSession(mkSession('human-null', null)), false);
  assert.equal(isAutoCreatedSession(mkSession('longterm', 'longterm')), true);
  assert.equal(isAutoCreatedSession(mkSession('orchestration', 'orchestration')), true);
  assert.equal(isAutoCreatedSession(mkSession('schedule', 'schedule')), true, 'the creation fact is still recorded');

  assert.equal(shouldFoldIntoAutonomousTasks(mkSession('human')), false);
  assert.equal(shouldFoldIntoAutonomousTasks(mkSession('longterm', 'longterm')), true);
  assert.equal(shouldFoldIntoAutonomousTasks(mkSession('orchestration', 'orchestration')), true);
  assert.equal(shouldFoldIntoAutonomousTasks(mkSession('schedule', 'schedule')), true,
    'scheduled-task runs fold too — every fire is a machine-started run');
});

test('split keeps main-list and folded halves in input order', () => {
  const sessions = [
    mkSession('human-1'),
    mkSession('auto-1', 'longterm'),
    mkSession('human-2', null),
    mkSession('sched-1', 'schedule'),
    mkSession('auto-2', 'orchestration'),
  ];
  const snapshot = sessions.map((session) => session.id);

  const { humanSessions, autoSessions } = splitSessionsByAutonomousFold(sessions);

  assert.deepEqual(humanSessions.map((session) => session.id), ['human-1', 'human-2']);
  assert.deepEqual(autoSessions.map((session) => session.id), ['auto-1', 'sched-1', 'auto-2'],
    'scheduled runs fold alongside the other machine rows, in place');
  assert.deepEqual(sessions.map((session) => session.id), snapshot, 'the input array is not reordered');
});

test('split handles an empty list and a list with one half missing', () => {
  assert.deepEqual(splitSessionsByAutonomousFold([]), { humanSessions: [], autoSessions: [] });

  const onlyHuman = splitSessionsByAutonomousFold([mkSession('human-1'), mkSession('human-2')]);
  assert.equal(onlyHuman.autoSessions.length, 0);
  assert.equal(onlyHuman.humanSessions.length, 2);

  const onlyAuto = splitSessionsByAutonomousFold([mkSession('auto-1', 'longterm')]);
  assert.equal(onlyAuto.humanSessions.length, 0);
  assert.equal(onlyAuto.autoSessions.length, 1);
});

test('the fold opens only on an explicit stored preference', () => {
  assert.equal(parseAutoTasksExpandedPreference(null), false, 'default is collapsed');
  assert.equal(parseAutoTasksExpandedPreference('0'), false);
  assert.equal(parseAutoTasksExpandedPreference('1'), true);
  assert.equal(parseAutoTasksExpandedPreference('yes'), false, 'anything unexpected stays collapsed');
  assert.equal(serializeAutoTasksExpandedPreference(true), '1');
  assert.equal(serializeAutoTasksExpandedPreference(false), '0');
  assert.equal(AUTO_TASKS_EXPANDED_STORAGE_KEY, 'coworkAutoTasksExpanded');
});

test('sidebar feeds the list with the split halves and keeps search over every session', () => {
  const src = readSource('src/renderer/components/Sidebar.tsx');

  // The visible local list gets the human half; the auto half rides alongside.
  // The split takes the decision set (waiting_owner sessions stay visible).
  assert.match(src, /sessions=\{localListSessions\}/);
  assert.match(src, /autoSessions=\{taskRecordTab === 'local' \? localAutoSessions : undefined\}/);
  assert.match(src, /decisionSessionIds=\{taskRecordTab === 'local' \? decisionSessionIds : undefined\}/);
  assert.match(src, /splitSessionsByAutonomousFold\(sessionGroups\.local, decisionSessionIds\)/);
  // The local tab's count + red unread dot ignore the folded rows — the fold
  // carries its own red dot + unread count on its header row.
  assert.match(src, /local: \{ count: localHumanSessions\.length, unread: unreadOf\(localHumanSessions\) \}/);
  // Search still receives the complete list, folded sessions included.
  assert.match(src, /<CoworkSearchModal[\s\S]*?sessions=\{homeSessions\}/);
});

test('the list renders one Autonomous Tasks fold, collapsed by default, directly under the pinned block in every view mode', () => {
  const src = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');

  assert.match(src, /data-testid="autonomous-tasks-section"/);
  assert.match(src, /const \[isAutoTasksExpanded, setIsAutoTasksExpanded\] = useState<boolean>\(loadAutoTasksExpanded\)/);
  assert.match(src, /parseAutoTasksExpandedPreference\(window\.localStorage\.getItem\(AUTO_TASKS_EXPANDED_STORAGE_KEY\)\)/);
  // Timeline, project and flat branches all render the same fold.
  assert.equal((src.match(/\{renderAutoTasksSection\(\)\}/g) ?? []).length, 3);
  // Position: directly under the pinned block, above the content groups, so
  // the folder is visible without scrolling — sitting last made it read as if
  // the feature did not exist.
  assert.match(src, /\{renderPinnedSection\(timelineGrouped\.pinned\)\}\s*\{renderAutoTasksSection\(\)\}\s*\{timelineGrouped\.groups\.map/);
  assert.match(src, /\{renderPinnedSection\(projectGrouped\.pinned\)\}\s*\{renderAutoTasksSection\(\)\}\s*\{projectGrouped\.groups\.map/);
  const flatPinned = src.indexOf('sortedSessions.filter((session) => session.pinned).map(renderItem)');
  const flatFold = src.indexOf('{renderAutoTasksSection()}', flatPinned);
  const flatRest = src.indexOf('sortedSessions.filter((session) => !session.pinned).map(renderItem)');
  assert.ok(flatPinned !== -1 && flatPinned < flatFold && flatFold < flatRest,
    'flat branch: pinned rows, then the fold, then the rest');
  // Nothing is rendered when there is nothing to fold.
  assert.match(src, /sortedAutoSessions\.length > 0 && \(/);
});

test('the fold header carries label + unread count + latest activity, and no total count', () => {
  const src = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');
  const header = src.slice(
    src.indexOf('const renderAutoTasksSection'),
    src.indexOf('{isAutoTasksExpanded && sortedAutoSessions.map(renderItem)}'),
  );

  assert.match(header, /coworkAutonomousTasks'/);
  assert.match(header, /formatRelativeTime\(autoLatestActivityAt\)/, 'the newest-activity stamp stays');
  // The header signals unread the way the user asked for it: a red dot at the
  // row's left (same dot the tabs use) plus the fold's unread session count in
  // red, both only when > 0.
  assert.match(header, /autoUnreadCount > 0 && \(/);
  assert.match(header, /rounded-full bg-red-500/);
  assert.match(header, /\{autoUnreadCount\}/);
  assert.match(header, /text-red-500/);
  assert.match(header, /coworkAutonomousTasksUnread/);
  // The total is no longer rendered as a header number (it survives only in
  // the hover tooltip).
  assert.doesNotMatch(header, /<span className="flex-shrink-0 font-normal tabular-nums">\{sortedAutoSessions\.length\}<\/span>/);
  // Per-row dots inside the expanded fold are untouched.
  assert.match(src, /hasUnread=\{unreadSessionIdSet\.has\(session\.id\)\}/);
  // The derivation feeds from the same unread set the rows use.
  assert.match(src, /const autoUnreadCount = useMemo\(\s*\(\) => sortedAutoSessions\.filter\(\(session\) => unreadSessionIdSet\.has\(session\.id\)\)\.length,/);

  // Both label keys exist once per locale, keeping coverage symmetric.
  const i18n = readSource('src/renderer/services/i18n.ts');
  assert.equal((i18n.match(/coworkAutonomousTasksUnread:/g) ?? []).length, 2, 'one per locale');
  assert.equal((i18n.match(/coworkAutonomousTasksCount:/g) ?? []).length, 2, 'still one per locale');
});

test('the row menu offers the fold move, labels it by current membership, and only renders when wired', () => {
  const item = readSource('src/renderer/components/cowork/CoworkSessionItem.tsx');

  // The entry sits between pin and archive, and its label mirrors where the row
  // is now (move IN while in the main list, OUT while folded).
  assert.match(
    item,
    /\{ key: 'pin'[\s\S]{0,600}\{ key: 'autonomous-fold'[\s\S]{0,400}\{ key: 'archive'/,
    'between pin and archive',
  );
  assert.match(item, /onToggleAutonomousFold\?\.\(session\.id, isInAutonomousFoldWithDecision\(session, decisionPending \?\? false\)\)/);
  assert.match(item, /inAutonomousFold = isInAutonomousFoldWithDecision\(session, decisionPending \?\? false\)/);
  assert.match(item, /inAutonomousFold \? 'coworkMoveOutOfAutonomous' : 'coworkMoveToAutonomous'/);
  // Optional prop: hidden, not dead, when the host does not offer the move.
  assert.match(item, /onToggleAutonomousFold\?: \(sessionId: string, currentlyFolded: boolean\) => void;/);
  assert.match(item, /\.\.\.\(onToggleAutonomousFold\s*\n?\s*\? \[\{ key: 'autonomous-fold'/);

  // The list threads it through to the rows (and keeps a stable identity for
  // the memoized rows, like every other action).
  const list = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');
  assert.match(list, /onToggleAutonomousFold\?: \(sessionId: string, currentlyFolded: boolean\) => void;/);
  assert.match(list, /const toggleAutonomousFold = useStableCallback\(onToggleAutonomousFold \?\? noopToggleAutonomousFold\)/);
  assert.match(list, /onToggleAutonomousFold=\{onToggleAutonomousFold \? toggleAutonomousFold : undefined\}/);

  // The sidebar owns the override decision and gives the list a stable handler;
  // only the local tab (the fold's own list) offers the move.
  const sidebar = readSource('src/renderer/components/Sidebar.tsx');
  assert.match(sidebar, /const handleToggleAutonomousFold = async \(sessionId: string, currentlyFolded: boolean\) => \{/);
  assert.match(sidebar, /\? \(shouldFoldIntoAutonomousTasks\(session\) \? 'out' : null\)/);
  assert.match(sidebar, /: 'in';/);
  assert.match(sidebar, /await coworkService\.setSessionFoldOverride\(sessionId, override\)/);
  assert.match(sidebar, /const listOnToggleAutonomousFold = useStableCallback\(handleToggleAutonomousFold\)/);
  assert.match(sidebar, /onToggleAutonomousFold=\{taskRecordTab === 'local' \? listOnToggleAutonomousFold : undefined\}/);
  // The search modal renders the same rows, so it offers the move too.
  assert.match(sidebar, /<CoworkSearchModal[\s\S]{0,400}onToggleAutonomousFold=\{handleToggleAutonomousFold\}/);
  const modal = readSource('src/renderer/components/cowork/CoworkSearchModal.tsx');
  assert.match(modal, /onToggleAutonomousFold\?: \(sessionId: string, currentlyFolded: boolean\) => void;/);
  assert.match(modal, /onToggleAutonomousFold=\{onToggleAutonomousFold\}/);

  // The service dispatches the local patch on success (mirrors setSessionPinned).
  const service = readSource('src/renderer/services/cowork.ts');
  assert.match(service, /async setSessionFoldOverride\(\s*sessionId: string,\s*override: CoworkSessionFoldOverride \| null,\s*\)/);
  assert.match(service, /await cowork\.setSessionFoldOverride\(\{ sessionId, override \}\)/);
  assert.match(service, /store\.dispatch\(updateSessionFoldOverride\(\{ sessionId, override \}\)\)/);

  // Both menu labels exist once per locale.
  const i18n = readSource('src/renderer/services/i18n.ts');
  assert.equal((i18n.match(/coworkMoveToAutonomous:/g) ?? []).length, 2, 'one per locale');
  assert.equal((i18n.match(/coworkMoveOutOfAutonomous:/g) ?? []).length, 2, 'one per locale');
});
