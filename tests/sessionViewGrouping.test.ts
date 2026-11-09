import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_VIEW_MODE,
  formatMonthLabel,
  groupSessionsByBot,
  groupSessionsByTimeline,
  type BotViewBot,
} from '../src/renderer/utils/sessionViewGrouping';
import {
  LEGACY_SESSION_VIEW_MODE_STORAGE_KEY,
  loadCollapsedSessionGroups,
  loadSessionViewMode,
  parseCollapsedSessionGroups,
  saveCollapsedSessionGroups,
  saveSessionViewMode,
  serializeCollapsedSessionGroups,
  sessionGroupCollapseStorageKey,
  sessionViewModeStorageKey,
} from '../src/renderer/utils/sessionGroupStorage';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(SRC_DIR, relative), 'utf8');
const listSourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listSourceFiles(path.join(dir, entry.name))
      : /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
  );

const mkSession = (
  overrides: Partial<CoworkSessionSummary> & Pick<CoworkSessionSummary, 'id'>,
): CoworkSessionSummary => ({
  title: `Session ${overrides.id}`,
  status: 'idle',
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

// Fixed "now": Aug 29 2026, 12:00 local time.
const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime();
const at = (year: number, monthIndex: number, day: number, hour = 12): number =>
  new Date(year, monthIndex, day, hour).getTime();

test('timeline buckets follow the display order today → yesterday → this week → last week → this month → months', () => {
  const result = groupSessionsByTimeline(
    [
      mkSession({ id: 'a', updatedAt: at(2026, 7, 29, 8), createdAt: at(2026, 7, 29, 8) }),
      mkSession({ id: 'b', updatedAt: at(2026, 7, 28, 23), createdAt: at(2026, 7, 28, 23) }),
      mkSession({ id: 'c', updatedAt: at(2026, 7, 26), createdAt: at(2026, 7, 26) }),
      mkSession({ id: 'd', updatedAt: at(2026, 7, 19), createdAt: at(2026, 7, 19) }),
      mkSession({ id: 'e', updatedAt: at(2026, 7, 9), createdAt: at(2026, 7, 9) }),
      mkSession({ id: 'f', updatedAt: at(2026, 6, 20), createdAt: at(2026, 6, 20) }),
    ],
    'updatedAt',
    NOW,
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'month:2026-07'],
  );
  assert.equal(result.groups[0].labelKey, 'timelineToday');
  assert.equal(result.groups[5].monthLabel, 'Jul 2026');
  assert.equal(result.pinned.length, 0);
});

test('timeline bucket timestamps follow the active sort mode', () => {
  // Created 3 days ago but active today: lands in Today when sorting by
  // update time, This Week when sorting by creation time.
  const session = mkSession({
    id: 'a',
    createdAt: at(2026, 7, 26),
    updatedAt: at(2026, 7, 29, 9),
  });
  assert.equal(
    groupSessionsByTimeline([session], 'updatedAt', NOW).groups[0].key,
    'today',
  );
  assert.equal(
    groupSessionsByTimeline([session], 'createdAt', NOW).groups[0].key,
    'thisWeek',
  );
});

test('timeline keeps pinned sessions in a leading section and sorts groups newest first', () => {
  const result = groupSessionsByTimeline(
    [
      mkSession({ id: 'pinned-old', pinned: true, updatedAt: at(2026, 6, 1), createdAt: at(2026, 6, 1) }),
      mkSession({ id: 'new', updatedAt: at(2026, 7, 29, 10), createdAt: at(2026, 7, 29, 10) }),
      mkSession({ id: 'older-today', updatedAt: at(2026, 7, 29, 7), createdAt: at(2026, 7, 29, 7) }),
    ],
    'updatedAt',
    NOW,
  );
  assert.deepEqual(result.pinned.map((session) => session.id), ['pinned-old']);
  assert.deepEqual(
    result.groups[0].sessions.map((session) => session.id),
    ['new', 'older-today'],
  );
});

test('month labels render per language', () => {
  assert.equal(formatMonthLabel(2026, 7, 'zh'), '2026年7月');
  assert.equal(formatMonthLabel(2026, 7, 'en'), 'Jul 2026');
});

const mkBot = (overrides: Partial<BotViewBot> & Pick<BotViewBot, 'id'>): BotViewBot => ({
  name: `Bot ${overrides.id}`,
  avatar: null,
  isTwin: false,
  createdAt: 0,
  ...overrides,
});

test('bot grouping seeds every local bot a group and orders Twin first, then oldest-created first', () => {
  const result = groupSessionsByBot(
    [
      mkSession({ id: 's1', metabotId: 7, createdAt: at(2026, 7, 28), updatedAt: at(2026, 7, 28, 9) }),
      mkSession({ id: 's2', metabotId: 1, cwd: '/Users/tusm/work/custom-dir', createdAt: at(2026, 7, 29), updatedAt: at(2026, 7, 29, 10) }),
    ],
    'updatedAt',
    [
      // Youngest bot (id 7, newest createdAt) but the Twin: still first.
      mkBot({ id: 7, isTwin: true, name: 'Twin Bot', createdAt: 900 }),
      mkBot({ id: 3, name: 'Worker C', createdAt: 300 }),
      mkBot({ id: 1, name: 'Worker A', createdAt: 100 }),
      mkBot({ id: 2, name: 'Worker B', createdAt: 200 }),
      // A tie on createdAt breaks by id ascending.
      mkBot({ id: 5, name: 'Worker E', createdAt: 300 }),
    ],
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['bot:7', 'bot:1', 'bot:2', 'bot:3', 'bot:5'],
  );
  // Every seeded bot keeps a group, empty ones included (20 local bots means
  // 20 groups); no trailing bucket appears when nothing is left unmatched.
  assert.deepEqual(
    result.groups.map((group) => group.sessions.length),
    [1, 1, 0, 0, 0],
  );
  assert.equal(result.groups[0].bot?.name, 'Twin Bot');
  // The custom working directory plays no role anymore: the row lands under
  // its bot (id 1), not under a directory group.
  assert.deepEqual(result.groups[1].sessions.map((session) => session.id), ['s2']);
});

test('bot grouping files rows no live bot claims into one trailing other group', () => {
  const result = groupSessionsByBot(
    [
      mkSession({ id: 'live', metabotId: 1, createdAt: 1, updatedAt: 1 }),
      mkSession({ id: 'gone', metabotId: 42, createdAt: 2, updatedAt: 2 }),
      mkSession({ id: 'legacy', createdAt: 3, updatedAt: 3 }),
    ],
    'updatedAt',
    [mkBot({ id: 1, createdAt: 100 })],
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['bot:1', 'other'],
  );
  assert.deepEqual(
    result.groups[1].sessions.map((session) => session.id),
    ['legacy', 'gone'],
  );
});

test('bot grouping keeps pinned sessions out of the groups and sorts rows by the active mode', () => {
  const result = groupSessionsByBot(
    [
      mkSession({ id: 'pinned', pinned: true, metabotId: 1, createdAt: 3, updatedAt: 3 }),
      mkSession({ id: 'newer', metabotId: 1, createdAt: 1, updatedAt: 20 }),
      mkSession({ id: 'older', metabotId: 1, createdAt: 2, updatedAt: 10 }),
    ],
    'updatedAt',
    [mkBot({ id: 1, createdAt: 100 })],
  );
  assert.deepEqual(result.pinned.map((session) => session.id), ['pinned']);
  assert.deepEqual(
    result.groups[0].sessions.map((session) => session.id),
    ['newer', 'older'],
  );
  const byCreation = groupSessionsByBot(
    [
      mkSession({ id: 'newer', metabotId: 1, createdAt: 1, updatedAt: 20 }),
      mkSession({ id: 'older', metabotId: 1, createdAt: 2, updatedAt: 10 }),
    ],
    'createdAt',
    [mkBot({ id: 1, createdAt: 100 })],
  );
  assert.deepEqual(
    byCreation.groups[0].sessions.map((session) => session.id),
    ['older', 'newer'],
  );
});

test('an empty roster degrades to session-derived bot groups, newest activity first, freshest snapshot identity', () => {
  const result = groupSessionsByBot(
    [
      mkSession({ id: 't1', metabotId: 1, metabotName: 'Twin Bot', metabotAvatar: 'data:image/png;base64,AAA', createdAt: 1, updatedAt: 100 }),
      mkSession({ id: 't2', metabotId: 1, createdAt: 2, updatedAt: 50 }),
      // A newer row without a name must not erase the fresher snapshot's name.
      mkSession({ id: 't3', metabotId: 1, createdAt: 3, updatedAt: 200 }),
      mkSession({ id: 'w1', metabotId: 2, metabotName: 'Worker', createdAt: 4, updatedAt: 90 }),
      mkSession({ id: 'legacy', createdAt: 5, updatedAt: 60 }),
    ],
    'updatedAt',
    [],
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['bot:1', 'bot:2', 'other'],
  );
  assert.deepEqual(result.groups[0].bot, { id: 1, name: 'Twin Bot', avatar: 'data:image/png;base64,AAA' });
  assert.deepEqual(
    result.groups[2].sessions.map((session) => session.id),
    ['legacy'],
  );
});

// ---------------------------------------------------------------------------
// Round 5: batch archive is a list operation on BOTH faces (owner ruling
// 2026-11-09). The dropdown that used to sit on the online face is gone; what
// replaced its scope control is the by-Bot grouping, which needs no counts.
// ---------------------------------------------------------------------------

const readSidebar = (name: 'HomeSidebar' | 'Sidebar'): string =>
  readSource(`renderer/components/${name}.tsx`);

test('batch archive lost its local-only gate on both record areas', () => {
  for (const name of ['HomeSidebar', 'Sidebar'] as const) {
    const src = readSidebar(name);
    // The enter button (ArchiveBoxIcon + handleEnterBatchArchiveMode) renders
    // for every non-empty face, not behind `taskRecordTab === 'local'`.
    assert.equal(
      src.includes('selectionMode={isBatchArchiveMode && taskRecordTab === \'local\'}'),
      false,
      `${name}: the selection-mode gate is gone`,
    );
    assert.ok(
      src.includes('selectionMode={isBatchArchiveMode}'),
      `${name}: rows enter selection mode on the face on screen`,
    );
    assert.equal(
      /\{taskRecordTab === 'local' && \(\s*<Tooltip content=\{i18nService\.t\('batchArchive'\)\}/.test(src),
      false,
      `${name}: the archive button is not gated to the local face`,
    );
    assert.ok(
      src.includes('onClick={handleEnterBatchArchiveMode}'),
      `${name}: the archive button still exists`,
    );
    // Default branch = the toolbar's control cluster; the confirm/cancel pair
    // (same copy, same counter) is shared by both faces.
    assert.ok(src.includes("i18nService.t('batchArchiveConfirm')"), `${name}: shared confirm copy`);
    assert.ok(src.includes("i18nService.t('batchArchiveCancel')"), `${name}: shared cancel copy`);
    assert.ok(
      src.includes('{batchSelectedIds.length > 0 ? ` (${batchSelectedIds.length})` : \'\'}'),
      `${name}: shared selected count`,
    );
  }
});

test('the confirm path archives the face own bucket, never the local one', () => {
  for (const name of ['HomeSidebar', 'Sidebar'] as const) {
    const src = readSidebar(name);
    // A hard-coded `sessionGroups.local` filter silently dropped every a2a
    // pick; the bucket must follow the tab currently on screen.
    assert.equal(
      /sessionGroups\.local\.some\(/.test(src),
      false,
      `${name}: the local bucket is no longer hard-coded into the confirm path`,
    );
    assert.ok(
      src.includes('const faceSessions = sessionGroups[taskRecordTab];'),
      `${name}: the confirm path reads the face's own bucket`,
    );
    assert.ok(
      src.includes('faceSessions.some((session) => session.id === id)'),
      `${name}: stale ids are still filtered against that bucket`,
    );
    // Switching faces drops a selection in progress instead of carrying ids
    // across two disjoint buckets.
    assert.ok(
      /useEffect\(\(\) => \{\s*setIsBatchArchiveMode\(false\);/.test(src),
      `${name}: a face switch ends the selection`,
    );
  }
});

test('the archive backend is session-type agnostic, and an a2a row can come back', () => {
  // The store writes one column on one table, by id — there is no sessionType
  // branch anywhere on the archive path, so an a2a session archives exactly
  // like a local one.
  const store = fs.readFileSync(
    path.join(SRC_DIR, 'main/coworkStore.ts'),
    'utf8',
  );
  const archiveFn = store.slice(
    store.indexOf('archiveSession(id: string): void {'),
    store.indexOf('unarchiveSession(id: string): void {'),
  );
  assert.ok(archiveFn.includes('UPDATE cowork_sessions SET archived_at = ?'), 'one UPDATE by id');
  assert.equal(/sessionType|session_type|a2a/.test(archiveFn), false, 'no type branch in the store');

  const main = fs.readFileSync(path.join(SRC_DIR, 'main/main.ts'), 'utf8');
  const handler = main.slice(
    main.indexOf("registerIpcHandler('cowork:session:archive'"),
    main.indexOf("registerIpcHandler('cowork:session:unarchive'"),
  );
  assert.equal(/sessionType|session_type|a2a/.test(handler), false, 'no type branch in the IPC handler');

  // Renderer leg: the service dispatches the same delete on success, and the
  // reducer removes the row by id — again no session-type branch.
  const service = fs.readFileSync(path.join(SRC_DIR, 'renderer/services/cowork.ts'), 'utf8');
  const serviceFn = service.slice(
    service.indexOf('async archiveSession(sessionId: string): Promise<boolean> {'),
    service.indexOf('async setSessionPinned('),
  );
  assert.ok(serviceFn.includes('deleteSessionAction(sessionId)'), 'the row leaves the store');
  assert.equal(/sessionType|session_type/.test(serviceFn), false, 'no type branch in the service');
  const slice = fs.readFileSync(path.join(SRC_DIR, 'renderer/store/slices/coworkSlice.ts'), 'utf8');
  const reducer = slice.slice(
    slice.indexOf('deleteSession(state, action: PayloadAction<string>) {'),
    slice.indexOf('\n    addMessage(', slice.indexOf('deleteSession(state, action: PayloadAction<string>) {')),
  );
  assert.ok(
    reducer.includes('state.sessions = state.sessions.filter(s => s.id !== sessionId);'),
    'the reducer drops the row by id, whatever its type',
  );

  // Honest caveat, pinned as behaviour: an incoming private (a2a) message
  // unarchives the canonical peer session, so archiving an online chat puts it
  // away — it does not block the peer. Both repair paths carry the call.
  for (const file of [
    'main/services/coworkEnsureA2ASession.ts',
    'main/services/privateChatDaemon.ts',
  ]) {
    const repair = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(
      /isSessionArchived\([^)]*\)\)\s*\{\s*\n\s*[\w.]+\.unarchiveSession\(/.test(repair),
      `${file}: inbound a2a traffic resurrects an archived session`,
    );
  }
});

test('the two faces share one list template; the differences are the declared ones', () => {
  const list = readSource('renderer/components/cowork/CoworkSessionList.tsx');
  // Shared grouping: the same component, the same roster read, the same
  // collapsed-group rendering; only the EMPTY-BOT seeding is face-specific.
  assert.ok(list.includes('{ includeEmptyBots: groupFace === \'local\' }'), 'empty-bot seeding is the only face flag');

  for (const name of ['HomeSidebar', 'Sidebar'] as const) {
    const src = readSidebar(name);
    // Deliberately kept differences (both faces render the same component,
    // but the machine-run buckets and the move-to-section menu are local-only).
    for (const prop of ['autoSessions', 'followUpSessions', 'decisionSessionIds', 'onMoveSessionToSection']) {
      assert.ok(
        src.includes(`${prop}={taskRecordTab === 'local' ?`),
        `${name}: ${prop} stays local-only`,
      );
    }
    // Everything that defines the template itself is shared, not re-built.
    for (const shared of [
      'viewMode={faceViewMode}',
      'sortMode={sessionSortMode}',
      'groupFace={taskRecordTab}',
      'onQuickCreateTask={handleQuickCreateTask}',
      'onRenameSession={listOnRenameSession}',
      'onTogglePin={listOnTogglePin}',
    ]) {
      assert.ok(src.includes(shared), `${name}: ${shared} is shared by both faces`);
    }
  }
});

test('every i18n key the session list still renders exists in both language packs', () => {
  const list = readSource('renderer/components/cowork/CoworkSessionList.tsx');
  const i18n = readSource('renderer/services/i18n.ts');
  const keys = [...list.matchAll(/i18nService\.t\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]);
  const unique = [...new Set(keys)];
  assert.ok(unique.length > 0, 'the list renders a non-empty key set');
  const missing = unique.filter((key) => {
    const hits = i18n.match(new RegExp(`\\n\\s*${key}:`, 'g')) ?? [];
    return hits.length < 2; // one entry per pack: zh + en
  });
  assert.deepEqual(missing, [], 'no key is left behind in one language only');
  // The two keys that DID leave this file still belong to live callers, so the
  // dropdown removal orphaned nothing: no key was deleted, and zh/en stay level.
  assert.equal(unique.includes('coworkMetaBotLabel'), false);
  assert.equal(unique.includes('coworkMetaBotPlaceholder'), false);
  const view = readSource('renderer/components/cowork/CoworkView.tsx');
  for (const key of ['coworkMetaBotLabel', 'coworkMetaBotPlaceholder']) {
    assert.ok(view.includes(`i18nService.t('${key}')`), `${key} is still rendered by CoworkView`);
    assert.equal((i18n.match(new RegExp(`\\n\\s*${key}:`, 'g')) ?? []).length, 2, `${key} stays in zh+en`);
  }
});

test('the card strip is gone: no dead symbol survives anywhere in src', () => {
  const dead = [
    'buildBotFilterCards',
    'shouldShowBotFilterBar',
    'BotFilterCard',
    'ALL_BOTS_FILTER_KEY',
    'groupSessionsByMetabot',
    'SessionBotGroup',
    'BotGroupAccumulator',
    'bot-filter-unread-badge',
    'botFilterBar',
    'botFilter=',
    // NOTE: `viewMode === 'bot'` was in this list while the directory-based
    // project view held the grouped slot; the by-Bot view is back by design
    // (one group per local bot, Twin first) and owns that string again.
    // The "Bot:" caption was dropped when the native <select> became the
    // avatar-led popover; its i18n key must not come back.
    'sessionBotSelectorCaption',
    // The dropdown's remaining tail: its loading row, its above-the-list block,
    // and the two per-bot count builders it fed (deleted from
    // utils/sessionViewGrouping.ts — nothing else ever read them).
    'botSelectorRow',
    'selectorBlock',
    'showBotSelector',
    'pickedBotId',
    'buildBotSessionCounts',
    'buildBotUnreadCounts',
    // The self-drawn popover was replaced by the shared MetaBotSelector, so
    // its component and its session-derived option builder are gone for good.
    'BotSelectorPopover',
    'buildBotSelectorOptions',
    'ALL_BOTS_OPTION_KEY',
    'sessionBotKey',
    'shouldShowBotSelector',
    'defaultBotSelectorKey',
    'unreadOutsideBotSelection',
    'BotSelectorOption',
    // Dead i18n keys (colon-terminated so the live sessionBotFilterAllBots
    // key does not match the dead sessionBotFilterAll one).
    'sessionBotFilterAll:',
    'sessionBotFilterLabel:',
    'sessionBotFilterUnread:',
    'sessionBotSelectorTitle:',
  ];
  const hits: string[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const symbol of dead) {
      if (text.includes(symbol)) hits.push(`${path.relative(SRC_DIR, file)}: ${symbol}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the online list has no bot dropdown: the by-Bot groups are the only bot selector', () => {
  const list = readSource('renderer/components/cowork/CoworkSessionList.tsx');
  // Owner ruling 2026-11-09: the 按 Bot dropdown on the 线上对话 face is gone —
  // it duplicated the very grouping that sits under it. The list renders no
  // MetaBotSelector at all (not even a loading shell), and none of the
  // dropdown's state survives: no pick, no filter, no per-bot count props.
  assert.equal(list.includes('<MetaBotSelector'), false, 'the list no longer renders the dropdown');
  assert.equal(list.includes('botSelector'), false, 'the botSelector prop is gone, call sites included');
  assert.equal(list.includes('allowAll'), false, 'the All Bots entry left with the dropdown');
  assert.equal(list.includes('selectorBlock'), false, 'no control block is stacked above the rows');
  assert.equal(list.includes('pickedBotId'), false, 'no picked-bot state survives');
  assert.equal(list.includes('sessionCounts'), false, 'no per-bot conversation counts are computed');
  assert.equal(list.includes('unreadCounts'), false, 'no per-bot unread counts are computed');
  assert.equal(list.includes('ALL_METABOTS_SELECTOR_ID'), false, 'the All Bots sentinel is gone');
  // The list never scopes itself to a bot any more: every row of the face
  // reaches the groups, legacy rows whose bot is gone included.
  assert.match(list, /const visibleSessions = sessions;/);
  // The bots still come from the live metabot list (enabled bots, Twin first),
  // so a deleted bot can never linger as a group.
  assert.ok(list.includes('getMetaBots'), 'the groups read the live metabot roster');
  assert.ok(list.includes("metabot_type === 'twin'"), 'the roster still marks the Twin');
  // The grouping itself is untouched: same collapsible headers, same template.
  const groupedBranch = list.slice(list.indexOf('if (botGrouped)'));
  assert.ok(groupedBranch.includes('aria-expanded={!collapsed}'), 'groups collapse');
  assert.ok(groupedBranch.includes('groupHeaderLabelClass'), 'groups carry a real header');
  assert.ok(groupedBranch.includes('onQuickCreateTask'), 'the trailing + survives');
});

test('removing the dropdown leaves no filter state behind', () => {
  const list = readSource('renderer/components/cowork/CoworkSessionList.tsx');
  // Nothing in the list can narrow `sessions` before it reaches the groups:
  // the old activeBotId/pickedBotId pipeline is gone, so timelime, by-Bot and
  // flat views all read the same full list.
  assert.equal(list.includes('activeBotId'), false, 'the bot filter is gone');
  assert.equal(list.includes('defaultBotId'), false, 'the All Bots default is gone');
  const visible = list.slice(
    list.indexOf('const visibleSessions'),
    list.indexOf('const sortedSessions'),
  );
  assert.ok(visible.includes('= sessions'), 'the visible list is the full list');
  assert.equal(visible.includes('filter('), false, 'no bot scope filter remains');
});

test('the A2A title fallback is untouched by the selector change', () => {
  const item = readSource('renderer/components/cowork/CoworkSessionItem.tsx');
  assert.ok(item.includes('isPrivatePlaceholderTitle'));
  assert.match(item, /\^Private-\[A-Za-z0-9\]\{6,12\}\$/);
  // The fallback chain was refactored (a placeholder title yields the peer
  // name first, everything else falls through the assistant-title helper and
  // then the peer name); assert the BEHAVIOUR, not one historical literal.
  assert.match(item, /isPrivatePlaceholderTitle && session\.peerName\?\.trim\(\)/);
  assert.match(item, /\|\| session\.peerName/);
});

test('the by-Bot grouping is shared: empty bots only on the local face', () => {
  const bots: BotViewBot[] = [
    { id: 1, name: 'Twin', avatar: null, isTwin: true, createdAt: 10 },
    { id: 2, name: 'Worker', avatar: null, isTwin: false, createdAt: 20 },
  ];
  const sessions = [mkSession({ id: 's1', metabotId: 2, updatedAt: 10 })];

  // Local face: the roster IS the reading — a bot with no conversation still
  // gets its group (the owner can start one from its +).
  const local = groupSessionsByBot(sessions, 'updatedAt', bots);
  assert.deepEqual(local.groups.map((group) => group.key), ['bot:1', 'bot:2']);

  // Online face: a group exists only when the bot has a conversation; an
  // A2A list seeded with one empty group per local bot would be pure noise.
  const online = groupSessionsByBot(sessions, 'updatedAt', bots, { includeEmptyBots: false });
  assert.deepEqual(online.groups.map((group) => group.key), ['bot:2']);
  assert.deepEqual(online.groups[0].sessions.map((session) => session.id), ['s1']);

  // A legacy row whose bot is not in the roster still lands in "other".
  const legacy = groupSessionsByBot(
    [mkSession({ id: 'legacy', updatedAt: 5 })],
    'updatedAt',
    bots,
    { includeEmptyBots: false },
  );
  assert.deepEqual(legacy.groups.map((group) => group.key), ['other']);
});

test('both faces default to 按 Bot and never share one memory', () => {
  assert.equal(DEFAULT_SESSION_VIEW_MODE, 'bot');

  const store = new Map<string, string>();
  const getItem = (key: string) => store.get(key) ?? null;
  const setItem = (key: string, value: string) => void store.set(key, value);

  // Fresh install: both faces open on 按 Bot.
  assert.equal(loadSessionViewMode(getItem, 'local'), 'bot');
  assert.equal(loadSessionViewMode(getItem, 'a2a'), 'bot');
  assert.equal(sessionViewModeStorageKey('local'), 'idbots.sessionViewMode.local');
  assert.equal(sessionViewModeStorageKey('a2a'), 'idbots.sessionViewMode.a2a');

  // A stored choice wins, per face only.
  saveSessionViewMode(setItem, 'local', 'timeline');
  assert.equal(loadSessionViewMode(getItem, 'local'), 'timeline');
  assert.equal(loadSessionViewMode(getItem, 'a2a'), 'bot', 'the online face did not inherit it');

  // The pre-per-face key seeds the LOCAL face only (sidebarWidth's legacy rule).
  store.clear();
  store.set(LEGACY_SESSION_VIEW_MODE_STORAGE_KEY, 'timeline');
  assert.equal(loadSessionViewMode(getItem, 'local'), 'timeline');
  assert.equal(loadSessionViewMode(getItem, 'a2a'), 'bot');
  // 'project' was the retired directory view; its successor is by-Bot.
  store.clear();
  store.set(LEGACY_SESSION_VIEW_MODE_STORAGE_KEY, 'project');
  assert.equal(loadSessionViewMode(getItem, 'local'), 'bot');

  // Collapsed groups: one key per face, stable serialization, fail-open parse.
  assert.equal(sessionGroupCollapseStorageKey('local'), 'idbots.sessionGroups.local');
  assert.equal(sessionGroupCollapseStorageKey('a2a'), 'idbots.sessionGroups.a2a');
  saveCollapsedSessionGroups(setItem, 'local', ['bot:2', 'bot:1', 'bot:1']);
  assert.equal(getItem('idbots.sessionGroups.local'), '["bot:1","bot:2"]');
  assert.deepEqual([...loadCollapsedSessionGroups(getItem, 'local')], ['bot:1', 'bot:2']);
  assert.equal(loadCollapsedSessionGroups(getItem, 'a2a').size, 0, 'the online face is independent');

  assert.equal(serializeCollapsedSessionGroups([]), '[]');
  assert.equal(parseCollapsedSessionGroups('not json').size, 0);
  assert.equal(parseCollapsedSessionGroups('{"bot:1":true}').size, 0);
  assert.equal(parseCollapsedSessionGroups('[1,"bot:1",null]').size, 1);
});
