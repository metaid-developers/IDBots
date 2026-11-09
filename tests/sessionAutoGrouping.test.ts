// Autonomous Tasks + Follow-Up Tasks sections for the sidebar's local-chats list.
//
// Main stamps `autoOrigin` on sessions the app created on its own (long-term
// task runs, orchestration/delegation runs, scheduled-task runs); the summary
// carries it as `autoOrigin`, and the follow-up marker (followUpState) on the
// ones currently awaiting a human decision. The sidebar splits the local list
// into the main list, the Follow-Up section and the Autonomous fold per the
// placement policy below. What this suite pins: the pure three-way split and
// its precedence, the legacy two-way split, the persisted expand preferences,
// and the wiring invariants that keep a moved row out of the wrong section
// while keeping it searchable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTO_TASKS_EXPANDED_STORAGE_KEY,
  FOLLOW_UP_EXPANDED_STORAGE_KEY,
  isAutoCreatedSession,
  isInAutonomousFold,
  isInFollowUpSection,
  parseAutoTasksExpandedPreference,
  parseFollowUpExpandedPreference,
  resolveSessionSidebarSection,
  serializeAutoTasksExpandedPreference,
  serializeFollowUpExpandedPreference,
  shouldFoldIntoAutonomousTasks,
  splitSessionsByAutonomousFold,
  splitSessionsWithFollowUp,
} from '../src/renderer/utils/sessionAutoGrouping';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const mkSession = (
  id: string,
  autoOrigin?: CoworkSessionSummary['autoOrigin'],
  foldOverride?: CoworkSessionSummary['foldOverride'],
  followUpState?: CoworkSessionSummary['followUpState'],
): CoworkSessionSummary => ({
  id,
  title: `Session ${id}`,
  status: 'idle',
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  autoOrigin,
  foldOverride,
  followUpState,
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

test('three-way split: placement precedence is manual override > follow-up > auto-origin > main', () => {
  // Plain rows: policy only.
  {
    const { humanSessions, followUpSessions, autoSessions } = splitSessionsWithFollowUp([
      mkSession('human-1'),
      mkSession('lt-1', 'longterm'),
      mkSession('sched-1', 'schedule'),
    ]);
    assert.deepEqual(humanSessions.map((s) => s.id), ['human-1']);
    assert.deepEqual(followUpSessions.map((s) => s.id), []);
    assert.deepEqual(autoSessions.map((s) => s.id), ['lt-1', 'sched-1']);
  }

  // Rule 2: a persisted pending marker lands an auto-origin run in Follow-Up
  // instead of the fold — and a human row too (main never writes that marker
  // on human rows today, but the placement honors it if it ever appears).
  {
    const { humanSessions, followUpSessions, autoSessions } = splitSessionsWithFollowUp([
      mkSession('lt-pending', 'longterm', undefined, 'pending'),
      mkSession('human-pending', undefined, undefined, 'pending'),
    ]);
    assert.deepEqual(humanSessions.map((s) => s.id), []);
    assert.deepEqual(followUpSessions.map((s) => s.id), ['lt-pending', 'human-pending'],
      'pending beats the auto-origin policy');
    assert.deepEqual(autoSessions.map((s) => s.id), []);
  }

  // Rule 2 (live lane): a board decision owed on the session lands it in
  // Follow-Up — NOT the main list, which is where the old two-way split put it.
  {
    const owed = new Set(['lt-owed', 'human-owed']);
    const { humanSessions, followUpSessions, autoSessions } = splitSessionsWithFollowUp(
      [mkSession('lt-owed', 'longterm'), mkSession('human-owed'), mkSession('lt-quiet', 'longterm')],
      owed,
    );
    assert.deepEqual(humanSessions.map((s) => s.id), [],
      'decision-owed rows no longer ride the main list');
    assert.deepEqual(followUpSessions.map((s) => s.id), ['lt-owed', 'human-owed'],
      'the decision surface is the Follow-Up section now');
    assert.deepEqual(autoSessions.map((s) => s.id), ['lt-quiet']);
  }

  // Rule 1: a manual fold placement beats BOTH follow-up lanes.
  {
    const owed = new Set(['lt-owed-out']);
    const { humanSessions, followUpSessions, autoSessions } = splitSessionsWithFollowUp([
      mkSession('lt-pending-in', 'longterm', 'in', 'pending'),
      mkSession('lt-owed-out', 'longterm', 'out'),
      mkSession('human-pending-out', undefined, 'out', 'pending'),
    ], owed);
    assert.deepEqual(followUpSessions.map((s) => s.id), [],
      'override wins over the persisted marker and the live decision');
    assert.deepEqual(autoSessions.map((s) => s.id), ['lt-pending-in']);
    assert.deepEqual(humanSessions.map((s) => s.id), ['lt-owed-out', 'human-pending-out']);
  }
});

test('isInFollowUpSection is the membership the menu label and placement share', () => {
  assert.equal(isInFollowUpSection(mkSession('quiet'), false), false);
  assert.equal(isInFollowUpSection(mkSession('pending', undefined, undefined, 'pending'), false), true,
    'the persisted marker alone lands the row in the section');
  assert.equal(isInFollowUpSection(mkSession('owed'), true), true,
    'a live board decision alone lands the row in the section');
  assert.equal(isInFollowUpSection(mkSession('pending-owed', undefined, undefined, 'pending'), true), true);
});

test('resolveSessionSidebarSection is the per-row view of the three-way split', () => {
  // Precedence mirrors splitSessionsWithFollowUp: manual fold placement, then
  // the follow-up lanes, then the auto-origin policy, then the main list.
  assert.equal(resolveSessionSidebarSection(mkSession('human'), false), 'normal');
  assert.equal(resolveSessionSidebarSection(mkSession('lt', 'longterm'), false), 'autonomous');
  assert.equal(resolveSessionSidebarSection(mkSession('pending', undefined, undefined, 'pending'), false), 'follow-up');
  assert.equal(resolveSessionSidebarSection(mkSession('owed'), true), 'follow-up',
    'a live board decision alone lands the row in Follow-Up');
  assert.equal(resolveSessionSidebarSection(mkSession('in', undefined, 'in', 'pending'), true), 'autonomous',
    'a manual fold placement beats both follow-up lanes');
  assert.equal(resolveSessionSidebarSection(mkSession('out', 'longterm', 'out', 'pending'), true), 'normal',
    "'out' beats the follow-up lanes too — the row renders in the main list");
});

test('three-way split preserves input order per bucket and handles empty lists', () => {
  const sessions = [
    mkSession('human-1'),
    mkSession('fu-1', 'longterm', undefined, 'pending'),
    mkSession('auto-1', 'orchestration'),
    mkSession('human-2', null),
    mkSession('fu-2', 'schedule', undefined, 'pending'),
    mkSession('auto-2', 'longterm'),
  ];
  const snapshot = sessions.map((session) => session.id);

  const { humanSessions, followUpSessions, autoSessions } = splitSessionsWithFollowUp(sessions);

  assert.deepEqual(humanSessions.map((s) => s.id), ['human-1', 'human-2']);
  assert.deepEqual(followUpSessions.map((s) => s.id), ['fu-1', 'fu-2']);
  assert.deepEqual(autoSessions.map((s) => s.id), ['auto-1', 'auto-2']);
  assert.deepEqual(sessions.map((session) => session.id), snapshot, 'the input array is not reordered');

  assert.deepEqual(splitSessionsWithFollowUp([]), { humanSessions: [], followUpSessions: [], autoSessions: [] });

  const onlyFollowUp = splitSessionsWithFollowUp([mkSession('fu-1', 'longterm', undefined, 'pending')]);
  assert.equal(onlyFollowUp.humanSessions.length, 0);
  assert.equal(onlyFollowUp.followUpSessions.length, 1);
  assert.equal(onlyFollowUp.autoSessions.length, 0);

  // The legacy two-way split keeps routing decision-owed rows to the main
  // list (its pre-Follow-Up contract for callers without a follow-up section).
  const legacy = splitSessionsByAutonomousFold(
    [mkSession('human-1'), mkSession('lt-owed', 'longterm')],
    new Set(['lt-owed']),
  );
  assert.deepEqual(legacy.humanSessions.map((s) => s.id), ['human-1', 'lt-owed']);
  assert.deepEqual(legacy.autoSessions.map((s) => s.id), []);
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

test('the Follow-Up section opens only on an explicit stored preference, under its own key', () => {
  assert.equal(parseFollowUpExpandedPreference(null), false, 'default is collapsed (user decision #1)');
  assert.equal(parseFollowUpExpandedPreference('0'), false);
  assert.equal(parseFollowUpExpandedPreference('1'), true);
  assert.equal(parseFollowUpExpandedPreference('yes'), false, 'anything unexpected stays collapsed');
  assert.equal(serializeFollowUpExpandedPreference(true), '1');
  assert.equal(serializeFollowUpExpandedPreference(false), '0');
  assert.equal(FOLLOW_UP_EXPANDED_STORAGE_KEY, 'coworkFollowUpExpanded',
    'its own key — the auto-tasks key is frozen deployed state and must stay untouched');
});

test('sidebar feeds the list with the three-way split and counts Follow-Up rows in the local tab badge', () => {
  const src = readSource('src/renderer/components/Sidebar.tsx');

  // The visible local list gets the human half; the follow-up and auto halves
  // ride alongside. The split takes the decision set (waiting_owner sessions
  // land in the Follow-Up section, not the main list).
  assert.match(src, /sessions=\{localListSessions\}/);
  assert.match(src, /autoSessions=\{taskRecordTab === 'local' \? localAutoSessions : undefined\}/);
  assert.match(src, /followUpSessions=\{taskRecordTab === 'local' \? localFollowUpSessions : undefined\}/);
  assert.match(src, /decisionSessionIds=\{taskRecordTab === 'local' \? decisionSessionIds : undefined\}/);
  assert.match(src, /splitSessionsWithFollowUp\(sessionGroups\.local, decisionSessionIds\)/);
  // The local tab's count + red unread dot include the Follow-Up section — the
  // decision surface is the point of the feature (user decision #5) — while
  // the Autonomous fold stays excluded (its header carries its own unread).
  assert.match(
    src,
    /local: \{\s*count: localHumanSessions\.length \+ localFollowUpSessions\.length,\s*unread: unreadOf\(localHumanSessions\) \+ unreadOf\(localFollowUpSessions\),\s*\}/,
  );
  // Search still receives the complete list, folded sessions included.
  assert.match(src, /<CoworkSearchModal[\s\S]*?sessions=\{homeSessions\}/);
});

test('the list renders one Autonomous Tasks fold, collapsed by default, directly under the pinned block in every view mode', () => {
  const src = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');

  assert.match(src, /data-testid="autonomous-tasks-section"/);
  assert.match(src, /const \[isAutoTasksExpanded, setIsAutoTasksExpanded\] = useState<boolean>\(loadAutoTasksExpanded\)/);
  assert.match(src, /parseAutoTasksExpandedPreference\(window\.localStorage\.getItem\(AUTO_TASKS_EXPANDED_STORAGE_KEY\)\)/);
  // Timeline, by-Bot and flat branches all render the same fold.
  assert.equal((src.match(/\{renderAutoTasksSection\(\)\}/g) ?? []).length, 3);
  // Position: directly under the pinned block, above the Follow-Up section and
  // the content groups, so the folders are visible without scrolling — sitting
  // last made the fold read as if the feature did not exist.
  assert.match(src, /\{renderPinnedSection\(timelineGrouped\.pinned\)\}\s*\{renderAutoTasksSection\(\)\}\s*\{renderFollowUpSection\(\)\}\s*\{timelineGrouped\.groups\.map/);
  assert.match(src, /\{renderPinnedSection\(botGrouped\.pinned\)\}\s*\{renderAutoTasksSection\(\)\}\s*\{renderFollowUpSection\(\)\}\s*\{botGrouped\.groups\.map/);
  const flatPinned = src.indexOf('sortedSessions.filter((session) => session.pinned).map(renderItem)');
  const flatFollowUp = src.indexOf('{renderFollowUpSection()}', flatPinned);
  const flatFold = src.indexOf('{renderAutoTasksSection()}', flatPinned);
  const flatRest = src.indexOf('sortedSessions.filter((session) => !session.pinned).map(renderItem)');
  assert.ok(flatPinned !== -1 && flatPinned < flatFold && flatFold < flatFollowUp && flatFollowUp < flatRest,
    'flat branch: pinned rows, then the fold, then the Follow-Up section, then the rest');
  // Nothing is rendered when there is nothing to fold.
  assert.match(src, /sortedAutoSessions\.length > 0 && \(/);
});

test('the list renders one Follow-Up section below the fold, collapsed by default, in every view mode', () => {
  const src = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');

  assert.match(src, /data-testid="follow-up-tasks-section"/);
  assert.match(src, /const \[isFollowUpExpanded, setIsFollowUpExpanded\] = useState<boolean>\(loadFollowUpExpanded\)/);
  assert.match(src, /parseFollowUpExpandedPreference\(window\.localStorage\.getItem\(FOLLOW_UP_EXPANDED_STORAGE_KEY\)\)/);
  // Timeline, by-Bot and flat branches all render the same section, exactly
  // once each.
  assert.equal((src.match(/\{renderFollowUpSection\(\)\}/g) ?? []).length, 3);
  // Position: directly under the Autonomous fold, which sits under the pinned
  // block (owner 2026-10-23: auto first, follow-up second).
  assert.match(src, /\{renderPinnedSection\(timelineGrouped\.pinned\)\}\s*\{renderAutoTasksSection\(\)\}\s*\{renderFollowUpSection\(\)\}/);
  assert.match(src, /\{renderPinnedSection\(botGrouped\.pinned\)\}\s*\{renderAutoTasksSection\(\)\}\s*\{renderFollowUpSection\(\)\}/);
  // Nothing is rendered when nothing is pending.
  assert.match(src, /sortedFollowUpSessions\.length > 0 && \(/);
  // An empty human list still renders the section (decisions must not hide
  // behind an empty state). The section is gated on the caller-supplied bucket
  // alone — the old `!showBotSelector` clause left with the bot dropdown (owner
  // ruling 2026-11-09); the a2a face passes no bucket, so it stays off there
  // without a selector flag.
  assert.match(src, /hasFollowUpTasks = sortedFollowUpSessions\.length > 0;/);
});

test('the follow-up header carries label + unread count + latest activity, and no total count', () => {
  const src = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');
  const header = src.slice(
    src.indexOf('const renderFollowUpSection'),
    src.indexOf('{isFollowUpExpanded && sortedFollowUpSessions.map(renderItem)}'),
  );

  assert.match(header, /coworkFollowUpTasks'/);
  // Raised hand, not a folder: these sessions wait on a HUMAN decision.
  assert.match(header, /<HandRaisedIcon className="h-3\.5 w-3\.5 flex-shrink-0" \/>/);
  assert.match(header, /formatRelativeTime\(followUpLatestActivityAt\)/, 'the newest-activity stamp stays');
  // The header signals unread the way the fold's does: a red dot at the row's
  // left plus the section's unread session count in red, both only when > 0.
  assert.match(header, /followUpUnreadCount > 0 && \(/);
  assert.match(header, /rounded-full bg-red-500/);
  assert.match(header, /\{followUpUnreadCount\}/);
  assert.match(header, /text-red-500/);
  assert.match(header, /coworkFollowUpTasksUnread/);
  // The total is no more a header number than the fold's (tooltip only).
  assert.doesNotMatch(header, /<span className="flex-shrink-0 font-normal tabular-nums">\{sortedFollowUpSessions\.length\}<\/span>/);
  // The derivation feeds from the same unread set the rows use.
  assert.match(src, /const followUpUnreadCount = useMemo\(\s*\(\) => sortedFollowUpSessions\.filter\(\(session\) => unreadSessionIdSet\.has\(session\.id\)\)\.length,/);

  // Both label keys exist once per locale, keeping coverage symmetric.
  const i18n = readSource('src/renderer/services/i18n.ts');
  assert.equal((i18n.match(/coworkFollowUpTasksUnread:/g) ?? []).length, 2, 'one per locale');
  assert.equal((i18n.match(/coworkFollowUpTasksCount:/g) ?? []).length, 2, 'one per locale');
  assert.equal((i18n.match(/coworkFollowUpTasks:/g) ?? []).length, 2, 'one per locale');
});

test('the fold header carries label + unread count + latest activity, and no total count', () => {
  const src = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');
  const header = src.slice(
    src.indexOf('const renderAutoTasksSection'),
    src.indexOf('{isAutoTasksExpanded && sortedAutoSessions.map(renderItem)}'),
  );

  assert.match(header, /coworkAutonomousTasks'/);
  // Gear, not a folder: these runs drive themselves with no human in the loop.
  assert.match(header, /<Cog6ToothIcon className="h-3\.5 w-3\.5 flex-shrink-0" \/>/);
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

test('the row menu offers one unified "Move to…" submenu, current section disabled, only when wired', () => {
  const item = readSource('src/renderer/components/cowork/CoworkSessionItem.tsx');

  // The entry sits between pin and archive. It is a submenu, not a toggle: one
  // 'move-to' entry replaces the old fold/follow-up toggle pair, wherever the
  // host offers the move at all (the target list is the same for every row —
  // section placement is no longer auto-origin-gated at the menu).
  assert.match(
    item,
    /\{ key: 'pin'[\s\S]{0,400}\{ key: 'move-to'[\s\S]{0,500}\{ key: 'archive'/,
    'between pin and archive',
  );
  assert.match(item, /onMoveToSection\?: \(sessionId: string, target: SessionSidebarSection\) => void;/);
  assert.match(item, /\.\.\.\(onMoveToSection\s*\n?\s*\? \[\{ key: 'move-to'/);
  assert.match(item, /onMoveToSection\?\.\(session\.id, target\)/);
  // The submenu offers all three sidebar sections, and the row's current one
  // comes from the shared resolver (the same precedence as the list's
  // three-way split) — it renders disabled, so a same-section pick (a no-op by
  // design) can never reach the caller.
  assert.match(item, /currentSection = resolveSessionSidebarSection\(session, decisionPending \?\? false\)/);
  assert.equal((item.match(/key: 'autonomous', label: i18nService\.t\('coworkMoveToSectionAutonomous'\)/g) ?? []).length, 1);
  assert.equal((item.match(/key: 'follow-up', label: i18nService\.t\('coworkMoveToSectionFollowUp'\)/g) ?? []).length, 1);
  assert.equal((item.match(/key: 'normal', label: i18nService\.t\('coworkMoveToSectionNormal'\)/g) ?? []).length, 1);
  assert.match(item, /const isCurrent = target\.key === currentSection;/);
  assert.match(item, /disabled=\{isCurrent\}/);

  // The list threads it through to the rows (and keeps a stable identity for
  // the memoized rows, like every other action).
  const list = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');
  assert.match(list, /onMoveSessionToSection\?: \(sessionId: string, target: SessionSidebarSection\) => void;/);
  assert.match(list, /const moveToSection = useStableCallback\(onMoveSessionToSection \?\? noopMoveToSection\)/);
  assert.match(list, /onMoveToSection=\{onMoveSessionToSection \? moveToSection : undefined\}/);
});

test('the sidebar owns the three-way move writes, and the search modal offers the same submenu', () => {
  // The sidebar normalizes BOTH placement lanes per target (see the handler's
  // comment for the precedence reasoning): the fold override and the follow-up
  // marker. The row menu disables the current section, so no branch ever runs
  // for a session that already sits in the target — picking it changes nothing.
  const sidebar = readSource('src/renderer/components/Sidebar.tsx');
  assert.match(sidebar, /const handleMoveSessionToSection = async \(sessionId: string, target: SessionSidebarSection\) => \{/);
  // To the fold: drop the marker, park the override.
  assert.match(sidebar, /target === 'autonomous'[\s\S]{0,200}setSessionFollowUp\(sessionId, false\)[\s\S]{0,200}setSessionFoldOverride\(sessionId, 'in'\)/);
  // To Follow-Up: neutralize the override (it outranks the marker), mark pending.
  assert.match(sidebar, /target === 'follow-up'[\s\S]{0,200}setSessionFoldOverride\(sessionId, null\)[\s\S]{0,200}setSessionFollowUp\(sessionId, true\)/);
  // To the normal list: clear the marker, and 'out' wherever ANY lane would
  // pull the row back — the auto-origin fold policy OR a live board decision
  // owed on the session (decisionSessionIds). Without the explicit 'out' the
  // live decision set keeps a decision-owed row in Follow-Up and the move is
  // a silent no-op; foldOverride outranks the live set in the precedence.
  assert.match(sidebar, /shouldFoldIntoAutonomousTasks\(session\) \|\| decisionSessionIds\.has\(sessionId\)/);
  assert.match(sidebar, /needsExplicitOut \? 'out' : null/);
  // Only the local tab offers the move; the search modal (same rows) offers it too.
  assert.match(sidebar, /const listOnMoveSessionToSection = useStableCallback\(handleMoveSessionToSection\)/);
  assert.match(sidebar, /onMoveSessionToSection=\{taskRecordTab === 'local' \? listOnMoveSessionToSection : undefined\}/);
  assert.match(sidebar, /<CoworkSearchModal[\s\S]{0,600}onMoveSessionToSection=\{handleMoveSessionToSection\}/);
  const modal = readSource('src/renderer/components/cowork/CoworkSearchModal.tsx');
  assert.match(modal, /onMoveSessionToSection\?: \(sessionId: string, target: SessionSidebarSection\) => void;/);
  assert.match(modal, /onMoveSessionToSection=\{onMoveSessionToSection\}/);

  // The service dispatches the local patch on success (mirrors
  // setSessionFoldOverride), and the slice reducer patches both the list row
  // and the active session.
  const service = readSource('src/renderer/services/cowork.ts');
  assert.match(service, /async setSessionFollowUp\(sessionId: string, followUp: boolean\): Promise<boolean>/);
  assert.match(service, /await cowork\.setSessionFollowUp\(\{ sessionId, followUp \}\)/);
  assert.match(service, /store\.dispatch\(updateSessionFollowUp\(\{\s*sessionId,\s*followUp,/);
  const slice = readSource('src/renderer/store/slices/coworkSlice.ts');
  assert.match(slice, /updateSessionFollowUp\(state, action: PayloadAction<\{ sessionId: string; followUp: boolean; followUpAt\?: string \| null \}>\)/);
  assert.match(slice, /session\.followUpState = followUp \? 'pending' : null;/);
  assert.match(slice, /updateSessionFollowUp,/);

  // All four submenu labels exist once per locale.
  const i18n = readSource('src/renderer/services/i18n.ts');
  assert.equal((i18n.match(/coworkMoveTo:/g) ?? []).length, 2, 'one per locale');
  assert.equal((i18n.match(/coworkMoveToSectionAutonomous:/g) ?? []).length, 2, 'one per locale');
  assert.equal((i18n.match(/coworkMoveToSectionFollowUp:/g) ?? []).length, 2, 'one per locale');
  assert.equal((i18n.match(/coworkMoveToSectionNormal:/g) ?? []).length, 2, 'one per locale');
});

test('follow-up pending sessions light the unread dot even for heartbeat turns', () => {
  const slice = readSource('src/renderer/store/slices/coworkSlice.ts');

  // The heartbeat skip is carved out for follow-up pending sessions: the
  // marker makes the session the decision surface, so its machine traffic
  // pages the owner too (user decision #5).
  assert.match(slice, /const isSessionFollowUpPending = \(state: CoworkState, sessionId: string\): boolean =>/);
  assert.match(slice, /state\.sessions\.find\(\(session\) => session\.id === sessionId\)\?\.followUpState === 'pending'/);
  assert.equal((slice.match(/!isHeartbeatOrigin\((?:message\.metadata|metadata)\) \|\| isSessionFollowUpPending\(state, sessionId\)/g) ?? []).length, 2,
    'both addMessage and updateMessageContent apply the carve-out');
});
