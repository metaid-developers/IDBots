// 进程中心 (Process Hub) — the panel's pure model + its wiring contracts.
//
// Owner ruling 2026-11-21 (23:27–00:24; layout spec
// reports/process-center-layout-v1.html): the machine-started runs that used to
// fold into the local-chats list became their own panel, reached from the left
// function rail (「进程」, icon A, red 待你拍板 badge). This suite pins what must
// not silently drift:
//
//   1. the PURE model — membership, kind tag, status dot, the two live tabs,
//      the archived tab, and the one placement precedence it inherits from
//      sessionAutoGrouping (it is NOT a second policy);
//   2. the rail wiring — the entry exists on BOTH faces with the same id/icon,
//      it has a destination row + a rendered branch, and its badge is the same
//      count the panel's 待你拍板 tab shows;
//   3. the panel's own contracts — three tabs, row anatomy, the pale-yellow
//      awaiting row, the ⋯ valve, and the lazily read archived tab;
//   4. the read-only process view — no composer, a system bar, the jump to Twin;
//   5. i18n parity for every new key.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PROCESS_HUB_VIEW_STATE,
  PROCESS_RUNNING_WINDOW_MS,
  buildArchivedProcessEntries,
  buildProcessGateEntries,
  buildTwinSteeringPrompt,
  classifyProcessGate,
  lastAssistantDigest,
  openDecisionForSession,
  resolveSourceTaskTitle,
  rowValveLevelOf,
  buildProcessDynamic,
  buildProcessZones,
  countAwaitingProcesses,
  countBotSelfDigested,
  isProcessSession,
  lineageBucketOf,
  parseLineageOverrides,
  serializeLineageOverrides,
  processKindOf,
  processStateOf,
  processTreeKeyOf,
  processZoneOf,
  LINEAGE_OVERRIDE_STORAGE_KEY,
  PROCESS_STATUS_RANK,
  resolveProcessStatus as processStatusOf,
  splitProcessHub,
} from '../src/renderer/utils/processCenter';
import {
  PROCESS_SPARK_BUCKET_COUNT,
  PROCESS_SPARK_MIN_BAR_PERCENT,
  emptyProcessSpark,
  normalizeSparkCounts,
  normalizeSparkReading,
  sparkActiveBuckets,
  sparkBarPercents,
  sparkHasData,
} from '../src/renderer/utils/processSpark';
import {
  assembleSparkReadings,
  buildSparkBoundsQuery,
  buildSparkBucketQuery,
  clampSparkBucketIndex,
  normalizeSparkSessionIds,
} from '../src/main/services/processSparkBuckets';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const NOW = 1_700_000_000_000;

const mkSession = (
  id: string,
  autoOrigin?: CoworkSessionSummary['autoOrigin'],
  extra?: Partial<CoworkSessionSummary>,
): CoworkSessionSummary => ({
  id,
  title: `Session ${id}`,
  status: 'idle',
  pinned: false,
  createdAt: NOW - 90 * 60 * 1000,
  updatedAt: NOW - 60 * 60 * 1000,
  autoOrigin,
  ...extra,
});

test('membership: the closed auto-origin set plus a manual placement, never a title', () => {
  assert.equal(isProcessSession(mkSession('human')), false, 'no marker = a human chat');
  assert.equal(isProcessSession(mkSession('lt', 'longterm')), true);
  assert.equal(isProcessSession(mkSession('orch', 'orchestration')), true);
  assert.equal(isProcessSession(mkSession('sched', 'schedule')), true);
  // Manual placements win in both directions — that is how 移出进程中心 and a
  // hand-parked run both work without a second policy.
  assert.equal(isProcessSession(mkSession('human-in', undefined, { foldOverride: 'in' })), true);
  assert.equal(isProcessSession(mkSession('lt-out', 'longterm', { foldOverride: 'out' })), false);
  // A title that LOOKS like a run is not evidence of one.
  const fakeRun = mkSession('pretend', undefined, { title: '[长期] 1121-b 进程中心' });
  assert.equal(isProcessSession(fakeRun), false, 'the kind comes from autoOrigin, not the title');
});

test('the kind tag maps the creation fact, and a hand-parked row falls back to 施工', () => {
  assert.equal(processKindOf(mkSession('lt', 'longterm')), 'build');
  assert.equal(processKindOf(mkSession('orch', 'orchestration')), 'orchestrate');
  assert.equal(processKindOf(mkSession('sched', 'schedule')), 'scheduled');
  assert.equal(processKindOf(mkSession('human-in', undefined, { foldOverride: 'in' })), 'build',
    'no creation fact = the generic run kind, never a fourth tag');
});

test('the status dot: awaited verdict > recent activity > quiet, with an exact window boundary', () => {
  assert.equal(PROCESS_RUNNING_WINDOW_MS, 30 * 60 * 1000, 'the ruling pins 30 minutes');
  assert.equal(processStateOf(NOW - 60 * 1000, NOW), 'running');
  assert.equal(processStateOf(NOW - 29 * 60 * 1000, NOW), 'running');
  // The boundary is exclusive: exactly 30 minutes is already quiet.
  assert.equal(processStateOf(NOW - PROCESS_RUNNING_WINDOW_MS, NOW), 'idle');
  assert.equal(processStateOf(NOW - 31 * 60 * 1000, NOW), 'idle');
  // A clock skew (updated in the future) must not read as timeless "running".
  assert.equal(processStateOf(NOW + 60_000, NOW), 'idle');
});

test('the live split: awaiting holds decision rows, running holds the rest, human holds everything else', () => {
  const owed = new Set(['lt-owed']);
  const sessions = [
    mkSession('human-1'),
    mkSession('lt-owed', 'longterm'),
    mkSession('lt-running', 'longterm', { updatedAt: NOW - 5 * 60 * 1000 }),
    mkSession('sched-idle', 'schedule'),
    mkSession('orch-pending', 'orchestration', { followUpState: 'pending' }),
    mkSession('human-pending', undefined, { followUpState: 'pending' }),
  ];
  const model = splitProcessHub(sessions, owed, NOW);

  // LINEAGE v1 (owner ruling 17:30): an awaited run is the BOT's by default.
  // Nothing reaches 待你拍板 unless an explicit override says 'human'.
  assert.deepEqual(model.awaiting.map((e) => e.session.id), [],
    'default bucket is bot — the owner strip starts empty');
  assert.deepEqual(model.botSelfDigested.map((e) => e.session.id), ['lt-owed', 'orch-pending'],
    'both awaited rows are self-digested until routed up');
  assert.ok(model.botSelfDigested.every((e) => e.state === 'awaiting' && e.awaitingVerdict === false),
    'they stay awaited, they just do not ask the owner');
  assert.deepEqual(model.running.map((e) => e.session.id), ['lt-running', 'sched-idle'],
    'newest first, and only processes');
  assert.deepEqual(
    model.running.map((e) => e.statusKind),
    ['dead', 'dead'],
    'v2.1: a finished run is DEAD however recently it moved (the old 30-min rule painted 97% false green)',
  );
  // The human half is what the local list renders — a human row carrying a
  // pending marker stays OUT of the hub (it is not a process).
  assert.deepEqual(model.humanSessions.map((s) => s.id), ['human-1', 'human-pending']);
  assert.equal(countAwaitingProcesses(model), 0, 'the rail badge counts ONLY human-routed rows');
  assert.equal(countBotSelfDigested(model), 2, 'and the silent bar counts the rest');

  // Now route one up: it moves buckets, and BOTH counts follow on the same pass.
  const routed = splitProcessHub(sessions, owed, NOW, undefined, { 'lt-owed': 'human' });
  assert.deepEqual(routed.awaiting.map((e) => e.session.id), ['lt-owed']);
  assert.deepEqual(routed.botSelfDigested.map((e) => e.session.id), ['orch-pending']);
  assert.equal(countAwaitingProcesses(routed), 1);
  assert.equal(countBotSelfDigested(routed), 1);
  // …and an explicit 'bot' override pins a row DOWN even if it were routed up.
  const demoted = splitProcessHub(sessions, owed, NOW, undefined, { 'lt-owed': 'human', 'orch-pending': 'bot' });
  assert.deepEqual(demoted.awaiting.map((e) => e.session.id), ['lt-owed']);
  assert.deepEqual(demoted.botSelfDigested.map((e) => e.session.id), ['orch-pending']);
});

test('a manual placement still wins over the follow-up lanes (one precedence, not two)', () => {
  const owed = new Set(['lt-owed-in']);
  const model = splitProcessHub([
    mkSession('lt-owed-in', 'longterm', { foldOverride: 'in' }),
    mkSession('lt-pending-in', 'longterm', { foldOverride: 'in', followUpState: 'pending' }),
    // 'out' wins over the auto-origin policy: the row is a human chat again.
  ], owed, NOW);
  // 'in' parks a row in the hub whatever its follow-up lane says — the
  // precedence belongs to sessionAutoGrouping, and the hub inherits it.
  // Both are awaited, hence both start in the bot bucket (lineage v1).
  assert.deepEqual(model.awaiting.map((e) => e.session.id), []);
  assert.deepEqual(model.botSelfDigested.map((e) => e.session.id), ['lt-owed-in', 'lt-pending-in']);
  assert.deepEqual(model.running.map((e) => e.session.id), []);
  assert.deepEqual(model.humanSessions.map((s) => s.id), []);
});

test('① the expanded lists are real scrollers (bounded height + own overflow)', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  // Root cause pinned: the bar is shrink-0, so an unbounded list blows the column
  // out and gets clipped by an ancestor — no scrollbar, no wheel. Both lists must
  // therefore carry their OWN max-height + overflow.
  assert.equal(
    (panel.match(/max-h-\[min\(45vh,420px\)\] flex-col gap-1\.5 overflow-y-auto overscroll-contain px-4 pb-2/g) ?? []).length,
    2,
    'both expanded lists (awaiting + bot) scroll on their own',
  );
  assert.match(panel, /data-testid="process-bot-list"[\s\S]{0,120}overflow-y-auto/);
  assert.match(panel, /data-testid="process-awaiting-list"[\s\S]{0,120}overflow-y-auto/);
});

test('② row columns read dot · task · [spark] · kind · time · signature · valve (v2.1)', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const src = panel.slice(panel.indexOf('const ProcessRunRow'), panel.indexOf('const ProcessTaskRow'));
  const idx = (needle: string) => src.indexOf(needle);
  // The new order, asserted positionally on the RUN row (the owner's "进程行").
  const dot = idx('data-testid="process-state-dot"');
  const title = idx('data-testid="process-row-title"');
  const tag = idx('{kindLabel}');
  const activity = idx('data-testid="process-row-activity"');
  const orch = idx('data-testid="process-row-orchestrator"');
  const valve = idx('data-testid="process-row-valve"');
  // v2.1 (00:41, supersedes 20:15): the TASK is the first readable element and
  // the bot is a signature at the END. 「行首第一文本为任务名、非 bot」.
  assert.ok(dot > 0 && title > dot && tag > title && activity > tag && orch > activity && valve > orch,
    'run row: dot -> task -> kind -> time -> signature -> valve');
  // The elastic slot is the TITLE (it absorbs the remaining width), so the fixed
  // columns never get pushed around by a long name.
  // v2.1: the time column is 52px, right-aligned next to the signature.
  assert.match(src, /data-testid="process-row-activity"[\s\S]{0,200}w-\[52px\][\s\S]{0,80}tabular-nums/);
  assert.match(src, /data-testid="process-row-title"[\s\S]{0,80}min-w-0 flex-1 truncate font-semibold/);
  // …and the orchestrator is a ≤86px signature lane at the END of the row.
  assert.match(src, /data-testid="process-row-orchestrator"[\s\S]{0,160}w-\[86px\] flex-shrink-0/);
  assert.doesNotMatch(src, /ml-auto flex flex-shrink-0 items-center gap-1\.5 text-\[11px\]/);

  // Parent rows mirror the same grid — batch-A P1-6 flipped it: the TASK leads,
  // the orchestrator is the signature at the END (owner 00:41 ruling, 「bot 永不
  // 占行首」). The old assertion pinned the pre-v2.1 order and had to go.
  const task = panel.slice(panel.indexOf('const ProcessTaskRow'), panel.indexOf('const EMPTY_KEY_BY_TAB'));
  const taskTitleAt = task.indexOf('data-testid="process-task-title"');
  const taskActivityAt = task.indexOf('data-testid="process-task-activity"');
  const taskOrchAt = task.indexOf('data-testid="process-task-orchestrator"');
  assert.ok(taskTitleAt > 0 && taskOrchAt > 0 && taskActivityAt > 0);
  assert.ok(taskTitleAt < taskActivityAt, 'group head: task title before the activity time');
  assert.ok(taskActivityAt < taskOrchAt, 'group head: the orchestrator is the END signature');
  // The run-count tag (「N 次执行」) rides right after the title, before time.
  assert.ok(task.indexOf("processTreeRunCount") < taskActivityAt, 'run-count tag sits with the tags, not in the signature lane');
});

test('③ the Twin handoff never moves the user: keepSide on the draft channel only', () => {
  const app = readSource('src/renderer/App.tsx');
  // The draft channel is the ONE caller that must not navigate…
  assert.match(app, /handleNewChat\(undefined, text, \{ keepSide: true \}\)/);
  // …and handleNewChat honours it by skipping the only mainView write.
  assert.match(app, /const handleNewChat = useCallback\(\(preselectSkillId\?: unknown, draftText\?: string, options\?: \{ keepSide\?: boolean \}\) => \{/);
  assert.match(app, /if \(!options\?\.keepSide\) setMainView\('cowork'\);/);
  // …and it must NOT tear down the session either: clearSession unmounts the
  // composer the draft is meant for (measured: draft in store, composer empty).
  assert.match(app, /if \(!options\?\.keepSide\) \{\s*\n\s*coworkService\.clearSession\(\);\s*\n\s*dispatch\(clearSelection\(\)\);/);
  // The OTHER setMainView('cowork') calls belong to explicit new-chat entries
  // (rail 新建任务 etc.) and must keep navigating — the guard is inside
  // handleNewChat, not a global freeze.
  assert.ok((app.match(/setMainView\('cowork'\)/g) ?? []).length > 1, 'explicit entries keep navigating');
  // The explicit new-chat entries still land on the composer (they pass no
  // options, so the guard lets them through).
  assert.match(app, /handleBlankNewChat[\s\S]{0,200}handleNewChat\(/);
});

test('③ mechanism status: BOTH faces can mount the Twin transcript', () => {
  const app = readSource('src/renderer/App.tsx');
  // The transcript + composer live in `homeContent`; the Studio right column's
  // fallback is a LANDING CARD with no composer. Pinned so a future change that
  // gives Studio a real Twin window shows up as a red test, not a silent drift.
  // BotWorks switches on homePaneKey (hub branch present), Studio mounts the same
  // Co-Work node while a hub session is open.
  assert.equal(app.includes("homePaneKey === 'processCenterView'"), true);
  assert.match(app, /const coworkPane = \(/);
  assert.match(app, /: \(\s*\n\s*coworkLandingCard\s*\n\s*\);/);
  assert.equal(app.includes('internetPaneKey === \'coworkView\''), false,
    'the Studio pane switch has no Co-Work transcript branch (landing card only)');
  // The bare Studio landing is still the card (only a hub session upgrades it).
  assert.match(app, /: \(\s*\n\s*coworkLandingCard\s*\n\s*\);/);
});

test('① Studio handoff mounts a real Twin window on the SAME side', () => {
  const app = readSource('src/renderer/App.tsx');
  // The draft channel opens a Studio-side Twin window; it never switches sides.
  assert.match(app, /const \[studioTwinOpen, setStudioTwinOpen\] = useState\(false\);/);
  assert.match(app, /if \(botBrowserShell\.surfaceMode === 'browser'\) \{\s*\n\s*setHubOpenedSessionId\(null\);\s*\n\s*setStudioTwinOpen\(true\);\s*\n\s*\}/);
  // The Studio column mounts the shared Co-Work node while it is open …
  assert.match(app, /const internetCatalogContent = \(studioTwinOpen \|\| hubOpenedSessionId != null\) \? \(/);
  // … and an explicit pane pick / a return closes it, so it can never cover a pane.
  assert.match(app, /onSelectInternetPane=\{\(pane\) => \{\s*\n\s*setStudioTwinOpen\(false\);/);
  assert.match(app, /setHubOpenedSessionId\(null\);\s*\n\s*setStudioTwinOpen\(false\);/);
  // keepSide is untouched: no mainView write on the handoff path.
  assert.match(app, /if \(!options\?\.keepSide\) setMainView\('cowork'\);/);
});

test('② hub groups are task skeletons, never bot names; no-source runs get one bucket', () => {
  const model = readSource('src/renderer/utils/processCenter.ts');
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  // Group key = the task title (prefix-stripped), NOT the orchestrator.
  assert.match(model, /const key = processTreeKeyOf\(entry\.session\.title\) \|\| PROCESS_UNASSIGNED_KEY;/);
  assert.equal(/groups?\.get\(.*metabot/i.test(model), false, 'no bot-keyed grouping');
  // Runs with no task hang from ONE bucket, localised by the panel.
  assert.match(model, /export const PROCESS_UNASSIGNED_KEY = '__process_unassigned__';/);
  assert.match(model, /unassigned: key === PROCESS_UNASSIGNED_KEY,/);
  assert.match(panel, /node\.unassigned\s*\n?\s*\? i18nService\.t\('processUnassignedGroup'\)/);
  // The bot stays an inline attribute of the row (avatar + name), as before.
  assert.match(panel, /data-testid="process-row-orchestrator"/);
  // i18n: both languages.
  const i18n = readSource('src/renderer/services/i18n.ts');
  assert.equal((i18n.match(/\n\s*processUnassignedGroup:/g) ?? []).length, 2);
});

test('状态语言 v2.1: three states replace the 30-minute rule', () => {
  const model = readSource('src/renderer/utils/processCenter.ts');
  const s_ = (status: string, extra: Record<string, unknown> = {}) => ({
    id: 'x', status, followUpState: null, updatedAt: NOW, createdAt: NOW, ...extra,
  }) as never;
  /** Always pin the clock: the 7-day variant-C rule makes an unpinned `now`
   * turn every fixture stale (that is how this pin first failed). */
  const status0 = (session: never, extra: Record<string, unknown> = {}) =>
    processStatusOf(session, { nowMs: NOW, ...extra });

  // live = status 'running' ONLY (a recent completion is NOT alive)
  assert.equal(status0(s_('running')).kind, 'live');
  assert.equal(status0(s_('completed')).kind, 'dead');
  assert.equal(status0(s_('idle')).kind, 'dead');
  // pending wins over live
  assert.equal(status0(s_('running', { followUpState: 'pending' })).kind, 'pending');
  // …and a board decision session counts as pending too
  assert.equal(
    status0(s_('completed'), { decisionSessionIds: new Set(['x']) }).kind,
    'pending',
  );
  // variant D: error is a dead-band row that reads RED
  assert.equal(status0(s_('error')).error, true);
  assert.equal(status0(s_('error')).kind, 'dead');
  assert.equal(status0(s_('error_retried')).error, true);
  // variant C: pending older than 7 days degrades to dead but keeps the marker
  const stale = status0(s_('running', { followUpState: 'pending', updatedAt: NOW - 8 * 24 * 3600_000 }));
  assert.equal(stale.kind, 'dead');
  assert.equal(stale.stalePending, true);
  const fresh = status0(s_('running', { followUpState: 'pending', updatedAt: NOW - 6 * 24 * 3600_000 }));
  assert.equal(fresh.kind, 'pending');

  // priority: pending > live > dead, then newest-first inside a band
  assert.deepEqual(PROCESS_STATUS_RANK, { pending: 0, live: 1, dead: 2 });
  assert.match(model, /entries\.sort\(byStatusThenRecency\)/);
});

test('三探针修复: fresh list on open, and every dot uses the v2.1 palette', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  // ① The list snapshot lags the DB (Mon's 01:2x finding): re-read it when the
  //    hub opens, and again when a turn ends.
  assert.match(panel, /useEffect\(\(\) => \{\s*\n\s*void coworkService\.loadSessions\(\);\s*\n\s*\}, \[\]\);/);
  assert.match(panel, /if \(!isStreaming\) void coworkService\.loadSessions\(\);/);
  // ② No dot may index the palette with the LEGACY state keys any more — the
  //    palette is keyed by pending/live/dead/error, so a bare `[state]` renders
  //    transparent (that was the parent rows' invisible dot).
  assert.doesNotMatch(panel, /PROCESS_STATE_DOT_COLOR\[state\]/);
  assert.match(panel, /state === 'running'\s*\n?\s*\? PROCESS_STATE_DOT_COLOR\.live/);
});

test('两针修复: the live signal beats a stale snapshot, and silent rows are amber', () => {
  const model = readSource('src/renderer/utils/processCenter.ts');
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');

  // ① The list snapshot's status LAGS the DB (measured: DB 'running' vs summary
  //    'completed'), so liveness must also accept the live streaming signal.
  assert.match(model, /liveSessionId\?: string \| null;/);
  assert.match(model, /session\.status === 'running' \|\| options\?\.liveSessionId === session\.id/);
  assert.match(panel, /const isStreaming = useSelector\(\(state: RootState\) => state\.cowork\.isStreaming\);/);
  assert.match(panel, /isStreaming \? streamingSessionId : null/);
  // …and the row still gets the breathing class from that resolved kind.
  assert.match(panel, /statusKind === 'live' \? 'process-dot-live'/);

  // ② 静默条行 = pending-but-bot-digested: amber, never grey.
  assert.match(panel, /mutedDot\s*\n?\s*\/\/ 静默条行[\s\S]{0,40}\n?\s*\? PROCESS_STATE_DOT_COLOR\.pending/);
  const amberUses = (panel.match(/PROCESS_STATE_DOT_COLOR\.pending/g) ?? []).length;
  assert.ok(amberUses >= 2, 'pending palette used for both the strip rows and the silent-bar rows');
});

test('状态语言 v2.1: the row LEADS with the task, the bot is a signature', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const src = panel.slice(panel.indexOf('const ProcessRunRow'), panel.indexOf('const ProcessTaskRow'));
  const idx = (needle: string) => src.indexOf(needle);
  // 「行首第一文本为任务名、非 bot」— after the dot, the FIRST text node is the title.
  const afterDot = src.slice(idx('data-testid="process-state-dot"'));
  const firstTextIdx = afterDot.indexOf('data-testid="process-row-title"');
  const orchIdx = afterDot.indexOf('data-testid="process-row-orchestrator"');
  assert.ok(firstTextIdx > 0 && orchIdx > firstTextIdx, 'title precedes the signature');
  const between = afterDot.slice(0, firstTextIdx);
  assert.equal(/SessionAvatarCircle/.test(between), false, 'no bot avatar before the title');
  // the title is stripped of the 4 prefixes + the · #N suffix
  assert.match(src, /processTreeKeyOf\(session\.title \|\| ''\)/);
  // the time column is compact and right-aligned (52px)…
  assert.match(src, /data-testid="process-row-activity"[\s\S]{0,60}w-\[52px\][\s\S]{0,200}relative\.compact/);
  // …and the signature lane is ≤86px at the END.
  assert.match(src, /data-testid="process-row-orchestrator"[\s\S]{0,160}w-\[86px\]/);
  assert.ok(idx('data-testid="process-row-orchestrator"') > idx('data-testid="process-row-activity"'));
});

test('状态语言 v2.1: the three visual bands are real (no glow, reduced-motion guarded)', () => {
  const css = readSource('src/renderer/index.css');
  // live breathes on the DOT (scale + ring alpha), never with a glow
  assert.match(css, /@keyframes process-dot-breathe/);
  assert.match(css, /transform: scale\(1\.18\)/);
  assert.match(css, /box-shadow: 0 0 0 1px rgba\(34, 160, 107, \.32\)/);
  assert.doesNotMatch(css, /process-dot-live[\s\S]{0,200}filter: drop-shadow/);
  // pending: static amber rail on the left
  assert.match(css, /\.process-row-pending/);
  // dead: variant A 70% text + sunk surface, zero motion
  assert.match(css, /\.process-row-dead-text \{ opacity: \.7; \}/);
  assert.match(css, /\.process-row-dead \{ background-color: #f1f5f9; \}/);
  // motion is opt-out for the owner's system setting
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]{0,80}process-dot-live \{ animation: none; \}/);

  const model = readSource('src/renderer/utils/processCenter.ts');
  // palette: pending amber · live green · dead grey · error red
  assert.match(model, /pending: '#e6c93e'/);
  assert.match(model, /live: '#22a06b'/);
  assert.match(model, /dead: '#c4cad1'/);
  assert.match(model, /error: '#e5484d'/);

  const i18n = readSource('src/renderer/services/i18n.ts');
  for (const key of ['processGoDecide', 'processStateLive', 'processStateDead']) {
    assert.equal((i18n.match(new RegExp(`\\n\\s*${key}:`, 'g')) ?? []).length, 2, `${key}: both locales`);
  }
});

test('出口路由 v1: the override map is defensive, localStorage-only, and defaults to bot', () => {
  // The storage key is deployed state — pinned literally so a rename can't
  // silently reset every owner choice.
  assert.equal(LINEAGE_OVERRIDE_STORAGE_KEY, 'idbots.processHub.lineageOverrides');

  // Default: every awaited run is the bot's.
  assert.equal(lineageBucketOf('any-session', undefined), 'bot');
  assert.equal(lineageBucketOf('any-session', {}), 'bot');
  assert.equal(lineageBucketOf('s1', { s1: 'human' }), 'human');
  assert.equal(lineageBucketOf('s1', { s1: 'bot' }), 'bot');
  // A foreign/garbage value must NOT be read as human (defensive default).
  assert.equal(lineageBucketOf('s1', { s1: 'nonsense' as any }), 'bot');

  // Parsing is defensive in every direction: no crash, no phantom entries.
  assert.deepEqual(parseLineageOverrides(null), {});
  assert.deepEqual(parseLineageOverrides(''), {});
  assert.deepEqual(parseLineageOverrides('not json'), {});
  assert.deepEqual(parseLineageOverrides('[1,2,3]'), {});
  assert.deepEqual(parseLineageOverrides('{"a":"human","b":"bot","c":"weird","d":3}'),
    { a: 'human', b: 'bot' });

  // Serialisation drops anything that is not a bucket (no garbage in storage).
  assert.equal(serializeLineageOverrides({ a: 'human', b: 'bot', c: 'weird' as any }), '{"a":"human","b":"bot"}');
  // Round-trip is lossless for valid maps.
  assert.deepEqual(parseLineageOverrides(serializeLineageOverrides({ x: 'human', y: 'bot' })), { x: 'human', y: 'bot' });
});

test('出口路由 v1: the strip, the silent bar and the rail badge are three views of ONE store', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const rail = readSource('src/renderer/components/layout/WorkspaceRail.tsx');
  const store = readSource('src/renderer/utils/processHubLineageStore.ts');

  // One store module: read/write + subscribe; no component keeps its own copy.
  assert.match(store, /export const setLineageBucket = \(sessionId: string, bucket: LineageBucket\)/);
  assert.match(store, /export const useLineageOverrides = \(\): LineageOverrides =>/);
  assert.match(store, /useSyncExternalStore\(subscribeLineageOverrides, getLineageOverrides, getLineageOverrides\)/);
  assert.match(store, /window\.localStorage\.setItem\(LINEAGE_OVERRIDE_STORAGE_KEY/);

  // Both surfaces subscribe…
  assert.match(panel, /const lineageOverrides = useLineageOverrides\(\);/);
  assert.match(rail, /const lineageOverrides = useLineageOverrides\(\);/);
  // …and both feed the SAME overrides into the SAME split, so the two numbers
  // can never disagree on the same tick.
  assert.match(panel, /splitProcessHub\(\s*\n?\s*sessions,\s*\n?\s*decisionSessionIds,\s*\n?\s*nowMs,\s*\n?\s*undefined,\s*\n?\s*lineageOverrides,/);
  assert.match(rail, /splitProcessHub\(coworkSessions, decisionSessionIds, Date\.now\(\), undefined, lineageOverrides\)/);
  // The strip count and the rail badge count the SAME set (awaiting == human).
  assert.match(panel, /const awaitingCount = countAwaitingProcesses\(model\);/);
  assert.match(panel, /const botCount = countBotSelfDigested\(model\);/);
  // The valve writes through the store (not local state).
  assert.match(panel, /setLineageBucket\(sessionId, next\)/);
});

test('出口路由 v1: the row valve offers exactly one direction per row state', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  // Bot-bucket rows can only be ESCALATED; human-bucket rows only DEMOTED.
  assert.match(panel, /bucket === 'bot' \? \(/);
  assert.match(panel, /data-testid="process-valve-escalate"/);
  assert.match(panel, /data-testid="process-valve-demote"/);
  assert.match(panel, /onSetBucket\(session.id, 'human'\)/);
  assert.match(panel, /onSetBucket\(session.id, 'bot'\)/);
  // Only an awaited row can be routed at all — and the gate is the ROW STATE,
  // not awaitingVerdict (a bot-bucket row carries false there by design).
  assert.match(panel, /onSetBucket && bucket && state === 'awaiting'/);
  // Archive/移出 behaviour is untouched by the routing valve.
  assert.match(panel, /coworkService\.archiveSession\(sessionId\)/);
  assert.match(panel, /setSessionFoldOverride\(sessionId, 'out'\)/);
});

test('出口路由 v1: the four new strings exist in both languages', () => {
  const i18n = readSource('src/renderer/services/i18n.ts');
  for (const key of [
    'processAwaitingStripEmptyBot',
    'processBotBar',
    'processValveEscalate',
    'processValveDemote',
  ]) {
    assert.equal((i18n.match(new RegExp(`\\n\\s*${key}:`, 'g')) ?? []).length, 2, `${key}: one per locale`);
  }
});

test('the archived tab filters the archived reader to processes and never shows a live dot', () => {
  const archived = [
    mkSession('lt-arch', 'longterm', { archivedAt: NOW - 1000, updatedAt: NOW - 2 * 60 * 60 * 1000 }),
    mkSession('human-arch', undefined, { archivedAt: NOW - 2000 }),
    mkSession('sched-arch', 'schedule', { archivedAt: NOW - 3000, updatedAt: NOW - 5 * 60 * 1000 }),
  ];
  const entries = buildArchivedProcessEntries(archived);
  assert.deepEqual(entries.map((e) => e.session.id), ['sched-arch', 'lt-arch'],
    'human archived chats stay out of the hub; newest activity first');
  assert.ok(entries.every((e) => e.state === 'idle'),
    'an archived run is a closed receipt — never red, never green');
  assert.ok(entries.every((e) => e.awaitingVerdict === false));
});

test('the rail carries one 进程 entry on BOTH faces, with icon A and a numeric 待你拍板 badge', () => {
  const nav = readSource('src/renderer/components/sidebar/sidebarNavigation.js');
  const rail = readSource('src/renderer/components/layout/WorkspaceRail.tsx');

  // Both faces keep the entry (owner ruling 22:17).
  assert.equal((nav.match(/id: 'processes'/g) ?? []).length, 2, 'one per face');
  assert.equal((nav.match(/icon: 'processQueue'/g) ?? []).length, 2);
  assert.equal((nav.match(/label: t\('processCenter'\)/g) ?? []).length, 2);
  // Icon A is drawn in-file (a segmented window with rows), not a new dep.
  assert.match(rail, /case 'processQueue': \{/);
  assert.match(rail, /rect x="3" y="4\.5" width="18" height="15" rx="2\.2"/);
  // The 40×36 / rounded-8 button form is the shared RailButton's, not a copy.
  assert.match(rail, /inline-flex h-10 w-10 items-center justify-center rounded-\[8px\]/);
  // The badge binds to badgeCount and renders the NUMBER inside the dot; it is
  // one indicator slot, so a caller cannot stack two dots on one button.
  assert.match(rail, /data-rail-badge-count=\{badgeCount\}/);
  assert.match(rail, /rounded-full bg-red-500 px-\[3px\] text-\[9\.5px\] font-bold leading-none text-white/);
  // It must NOT carry `.tracked-task-decision-indicator`: that class is a
  // 0.375rem amber glowing dot and it WINS over the utilities (same
  // specificity, later source order), which rendered the count badge as a
  // 5.63px amber dot with the number spilling out — measured on the live DOM.
  assert.match(rail, /className="absolute -right-\[3px\] -top-\[3px\] flex h-\[14px\] min-w-\[14px\] shrink-0 items-center justify-center rounded-full bg-red-500/);
  // The count comes from the panel's own model (one source of truth)...
  assert.match(rail, /countAwaitingProcesses\(\s*\n?\s*splitProcessHub\(coworkSessions, decisionSessionIds, Date\.now\(\), undefined, lineageOverrides\),\s*\n?\s*\)/);
  // …and it subscribes to the SAME override store the panel reads.
  assert.match(rail, /const lineageOverrides = useLineageOverrides\(\);/);
  assert.match(rail, /awaitingProcessCount\b/);
  // ...and it actually REACHES the button on both rail faces: the model value
  // is forwarded into the model input, and the model output into the button.
  assert.match(rail, /getRailHomeNavModel\(\{[\s\S]{0,200}awaitingProcessCount,[\s\S]{0,120}\}\)/);
  assert.match(rail, /getRailInternetNavModel\(\{[\s\S]{0,200}awaitingProcessCount,[\s\S]{0,120}\}\)/);
  assert.equal((rail.match(/badgeCount=\{item\.badgeCount\}/g) ?? []).length, 2,
    'both rail loops forward the badge');
});

test('the rail mounts 进程 in the SYSTEM group directly above Settings, not among the common buttons', () => {
  const rail = readSource('src/renderer/components/layout/WorkspaceRail.tsx');
  const nav = readSource('src/renderer/components/sidebar/sidebarNavigation.js');

  // Model: processes is the LAST entry on both faces, which is exactly
  // "adjacent-before Settings" — Settings is mounted by the rail itself, after
  // the model list.
  const internetModel = nav.slice(nav.indexOf('export function getRailInternetNavModel'), nav.indexOf('export function getRailHomeNavModel'));
  const homeStart = nav.indexOf('export function getRailHomeNavModel');
  const homeEnd = nav.indexOf('export function', homeStart + 10);
  const homeModel = nav.slice(homeStart, homeEnd === -1 ? undefined : homeEnd);
  for (const [face, block] of [['internet', internetModel], ['home', homeModel]] as const) {
    const ids = [...block.matchAll(/id: '([a-zA-Z]+)'/g)].map((m) => m[1]);
    assert.equal(ids[ids.length - 1], 'processes', `${face}: processes is the last model entry`);
  }

  // Render: both scrolling navs exclude it, and it is mounted inside the
  // rail's bottom `mt-auto` group, ABOVE the Settings button.
  assert.match(rail, /internetItems\.filter\(\(item: RailNavItem\) => item\.id !== 'processes'\)\.map/);
  assert.match(rail, /homeItems\.filter\(\(item\) => item\.id !== 'records' && item\.id !== 'processes'\)/);
  const footerAt = rail.indexOf('mt-auto flex w-full flex-col items-center gap-1.5 px-1.5 pb-3 pt-1');
  const processesAt = rail.indexOf('{processesItem ? (');
  const settingsAt = rail.indexOf('itemId="settings"');
  assert.ok(footerAt > 0, 'the system group still exists');
  assert.ok(processesAt > footerAt, 'processes mounts INSIDE the bottom system group');
  assert.ok(settingsAt > processesAt, 'processes sits directly ABOVE the Settings button');
  // No common entry may be mounted between them inside that group.
  const between = rail.slice(processesAt, settingsAt);
  assert.doesNotMatch(between, /<RailButton[\s\S]*itemId="(browser|tasks|metaapps|myBots|newTask|longTerm|groupTasks)"/,
    'nothing common sits between 进程 and 设置');
  // Icon + badge are unchanged by the move (same model fields feed both).
  assert.match(rail, /badgeCount=\{processesItem\.badgeCount\}/);
  assert.match(rail, /\{renderRailIcon\(processesItem\.icon\)\}/);
});

test('the rail entry resolves on both faces', () => {
  const destinations = readSource('src/renderer/components/layout/workspaceDestinations.js');
  const app = readSource('src/renderer/App.tsx');

  assert.match(destinations, /processes: 'processCenterView',/, 'Bot Internet destination row');
  assert.equal((destinations.match(/processes: 'processCenterView'/g) ?? []).length, 3,
    'one per table — the hub is a destination on both faces');
  const homeRailTable = destinations.slice(destinations.indexOf('export const HOME_RAIL_RENDERERS'), destinations.indexOf('export const HOME_MAIN_VIEW_RENDERERS'));
  const homeMainTable = destinations.slice(destinations.indexOf('export const HOME_MAIN_VIEW_RENDERERS'), destinations.indexOf('export const PANE_RENDERER_KEYS'));
  assert.match(homeRailTable, /processes: 'processCenterView'/, 'BotWorks rail row kept');
  assert.match(homeMainTable, /processes: 'processCenterView'/, 'BotWorks mainView row kept');
  assert.match(destinations, /PANE_RENDERER_KEYS = Object\.freeze\(\[[\s\S]{0,120}'processCenterView'/, 'the renderer key stays (Internet uses it)');
  assert.equal((destinations.match(/processCenterView/g) ?? []).length >= 2, true,
    'the renderer key exists in the INTERNET table and in PANE_RENDERER_KEYS');
  assert.equal((app.match(/homePaneKey === 'processCenterView'/g) ?? []).length, 1);
  assert.equal((app.match(/internetPaneKey === 'processCenterView'/g) ?? []).length, 1);
  assert.equal((app.match(/<ProcessCenterPanel /g) ?? []).length, 1, 'one pane instance, two switches');
});

test('v6 panel: 动态 is the DEFAULT tab, 自主 / 编排 are the two source entries (M3=A / M4=A)', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const model = readSource('src/renderer/utils/processCenter.ts');

  assert.match(panel, /data-testid="process-center-panel"/);
  assert.match(panel, /data-process-tab=\{tab\}/);
  // ONE tab row, 动态 FIRST and selected by default (owner ruling 2026-11-23
  // 00:09): the landing page is the live processes; 编排/定时/长期 are demoted.
  assert.match(model, /export const PROCESS_HUB_TAB_ORDER: readonly ProcessHubTab\[\] = \[\s*\n\s*'dynamic',\s*\n\s*'autonomous',\s*\n\s*'orch',\s*\n\s*\];/);
  assert.match(panel, /const \[tab, setTab\] = useState<ProcessHubTab>\(restored\?\.tab \?\? 'dynamic'\);/);
  assert.match(panel, /\{PROCESS_HUB_TAB_ORDER\.map\(\(key\) => \{/);
  assert.match(panel, /data-process-tab-key=\{key\}/);
  // Counts are TAB BADGES (角标), never a flat 567/657 band on the first screen.
  // Batch-A P1-4 retired the node-count unit here: every tab now counts RUNS.
  assert.match(
    panel,
    /const count = key === 'dynamic'\s*\n\s*\? dynamic\.running\.length\s*\n\s*: key === 'autonomous'\s*\n\s*\? countAutonomousRuns\(autonomousModel, automationEntries\.length\)\s*\n\s*: orchestrationZone\.runCount;/,
  );
  // 自主's source chips (M3=A): 全部 / 定时 / 长期 / 做梦 / 冲浪 — chips narrow the
  // list, they never re-partition the process set.
  assert.match(panel, /data-testid="process-autonomous-chips"/);
  assert.match(panel, /\[null, \.\.\.PROCESS_AUTONOMOUS_SOURCE_ORDER\] as Array<ProcessAutonomousSource \| null>\)\.map\(\(source\) => \{/);
  // 编排 is STRICT: only autoOrigin='orchestration' (N6 prefix fallback lives in
  // the model, not in the panel).
  assert.match(model, /export const buildOrchestrationZone = \(entries: readonly ProcessEntry\[\]\): ProcessZoneModel => \{\s*\n\s*const rows = entries\.filter\(\(entry\) => isOrchestrationProcess\(entry\.session\)\);/);
  // 人开的会话 fall back into the dynamic page's folded strip (M4=A 兜底).
  assert.match(panel, /data-testid="process-unassigned-humans"/);
  assert.match(panel, /processUnassignedHumans'\)\.replace\('\{count\}'/);
  assert.match(panel, /data-testid="process-tab-count"/);
  assert.match(panel, /data-tab-count-for=\{key\}/);
  assert.doesNotMatch(panel, /const ZONE_ORDER: ProcessZone\[\]/);

  // The awaiting layer is GONE: 待你拍板 is one pinned strip above every tab, and
  // the v1 double-layer inside tab 1 must not survive anywhere.
  assert.doesNotMatch(panel, /process-layer-awaiting/);
  assert.doesNotMatch(panel, /processAwaitingLayerBadge/);
  assert.doesNotMatch(panel, /processTabAwaiting/);
  assert.doesNotMatch(panel, /processTabRunning/);
  assert.match(panel, /data-testid="process-awaiting-strip"/);
  assert.match(panel, /data-awaiting-count=\{awaitingCount\}/);
  assert.match(panel, /data-testid="process-awaiting-count"/);
  assert.match(panel, /border-\[#e6c93e\] bg-\[#fffbe8\]/);
  assert.match(panel, /awaitingExpanded/);
  // The strip count is THE count: the same helper the rail badge uses, over the
  // same model — one source, so the two can never disagree.
  assert.match(panel, /const awaitingCount = countAwaitingProcesses\(model\);/);
  assert.match(panel, /const botCount = countBotSelfDigested\(model\);/);
  // 出口路由 v1: a silent grey bar under the strip, collapsed by default.
  assert.match(panel, /data-testid="process-bot-bar"/);
  assert.match(panel, /data-bot-count=\{botCount\}/);
  assert.match(panel, /const \[botExpanded, setBotExpanded\] = useState\(false\);/);
  assert.match(panel, /data-testid="process-bot-list"/);
  assert.match(panel, /i18nService\.t\('processBotBar'\)\.replace\('\{count\}', String\(botCount\)\)/);
  // the empty copy names the two-bucket split instead of claiming "nothing pending"
  assert.match(panel, /processAwaitingStripEmptyBot/);
  const rail = readSource('src/renderer/components/layout/WorkspaceRail.tsx');
  assert.match(rail, /countAwaitingProcesses\(\s*\n?\s*splitProcessHub\(coworkSessions, decisionSessionIds, Date\.now\(\), undefined, lineageOverrides\),\s*\n?\s*\)/);
  // …and it subscribes to the SAME override store the panel reads.
  assert.match(rail, /const lineageOverrides = useLineageOverrides\(\);/);
  // Tree: parent rows (36px) fold to child rows (32px) with a 16px indent and a
  // 1px connector. The tree content is MOVED verbatim onto the zone tabs.
  // v6: the zone model splits into 自主 (scheduled + longterm) and the STRICT
  // orchestration zone; the old four-zone record is retired.
  assert.match(panel, /const autonomousModel = useMemo\(\(\) => buildProcessAutonomous\(model\.running\), \[model\.running\]\);/);
  assert.match(panel, /const orchestrationZone = useMemo\(\s*\n\s*\(\) => buildOrchestrationZone\(model\.running\),\s*\n\s*\[model\.running\],\s*\n\s*\);/);
  assert.match(panel, /data-testid="process-task-row"/);
  assert.match(panel, /data-testid="process-tree-group"/);
  assert.match(panel, /data-testid="process-tree-children"/);
  // PX, not rem: this app's `html` is 15px, so h-9/h-8 would render 33.75/30.
  assert.match(panel, /const heightClass = depth === 1 \? 'h-\[32px\]' : 'h-\[36px\]';/);
  assert.match(panel, /className="flex h-\[36px\] cursor-pointer items-center gap-2 rounded-\[8px\]/);
  assert.match(panel, /className="ml-\[16px\] mt-1 flex flex-col gap-1 border-l border-\[#e3e6ea\] pl-2 dark:border-claude-darkBorder"/);
  assert.match(panel, /expandedTasks/);
  assert.match(panel, /data-process-task-expanded=\{expanded \? 'true' : 'false'\}/);
  // A run that groups with nothing is a top-level LEAF — no parent invented.
  // v5 (fork 1A): the valve gate rides the row's OWN lineage, computed per row.
  assert.match(panel, /if \(!node\.grouped\) \{\s*\n\s*return renderRun\(node\.children\[0\], 0, rowValveLevelOf\(node\.children\[0\]\.session\)\);/);
  // Row anatomy: state dot + name + kind tag + orchestrator + latest activity.
  assert.match(panel, /data-testid="process-state-dot"/);
  assert.match(panel, /KIND_LABEL_KEY\[kind\]/);
  assert.match(panel, /i18nService\.t\('processOrchestratorLabel'\)/);
  assert.match(panel, /formatRelativeTime\(session\.updatedAt, nowMs\)/);
  // The ⋯ valve offers 归档 + 移出 on RUN rows; a task group has no lifecycle.
  // v5 (fork 1A): `allowValve: boolean` became a TRI-STATE valve level —
  // 'none' (archived) | 'housekeeping' (bot-origin) | 'full' (human-origin) —
  // so the housekeeping wiring gates on the LEVEL, never a bare boolean.
  assert.match(panel, /data-testid="process-row-valve"/);
  assert.match(panel, /processArchiveAction/);
  assert.match(panel, /processRemoveAction/);
  assert.match(panel, /onArchive=\{valveLevel !== 'none' \? handleArchive : undefined\}/);
  assert.match(panel, /onRemove=\{valveLevel !== 'none' \? handleRemove : undefined\}/);
  // 移出 is a manual 'out' placement; 归档 is the ordinary archive write.
  assert.match(panel, /coworkService\.setSessionFoldOverride\(sessionId, 'out'\)/);
  assert.match(panel, /coworkService\.archiveSession\(sessionId\)/);
});

test('v4 动态: 正在运行 breathing rows + 最近结束, re-projected from the SAME byStatus model', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');

  // The data source is the existing live/dead band — no new table, no new query.
  assert.match(panel, /const dynamic = useMemo\(\(\) => buildProcessDynamic\(model\.running\), \[model\.running\]\);/);

  // 正在运行: a section with its own count, then either breathing rows or the
  // explicit empty copy (the acceptance pins "一条呼吸行 or the 空态文案" in 600px).
  assert.match(panel, /data-testid="process-live-section" data-live-count=\{dynamic\.running\.length\}/);
  assert.match(panel, /data-testid="process-live-heading-dot"[\s\S]{0,160}process-dot-live/);
  assert.match(panel, /data-testid="process-live-empty"[\s\S]{0,420}processLiveEmpty/);
  assert.match(panel, /\{dynamic\.running\.map\(\(entry\) => \(/);

  // The breathing row leads with the TASK and signs with the bot (batch-A
  // P1-5, owner 00:41): 任务名 · [火花线] · 开始多久 · 一句当前动作 · 署名.
  const live = panel.slice(panel.indexOf('const ProcessLiveRow'), panel.indexOf('const ProcessCenterPanel'));
  const order = ['process-live-title', 'process-live-elapsed', 'process-live-action', 'process-live-who'];
  const positions = order.map((id) => live.indexOf(`data-testid="${id}"`));
  assert.ok(positions.every((position) => position > 0), 'all four facts are present');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'task -> elapsed -> action -> signature');
  // 「行首第一文本为任务名」: the dot is immediately followed by the title — no
  // bot avatar/name may sit between them (the old who-first order did exactly
  // that, and it was the live band's only justification-free exception).
  const afterDot = live.slice(live.indexOf('data-testid="process-state-dot"'));
  assert.ok(
    afterDot.indexOf('data-testid="process-live-title"') < afterDot.indexOf('data-testid="process-live-who"'),
    'live row: the title is the first lane after the dot',
  );
  const betweenDotAndTitle = afterDot.slice(0, afterDot.indexOf('data-testid="process-live-title"'));
  assert.doesNotMatch(betweenDotAndTitle, /SessionAvatarCircle/, 'no bot avatar before the task title');
  // …and the signature lane is the SAME 86px right-aligned lane the run row uses.
  assert.match(live, /data-testid="process-live-who"[\s\S]{0,200}w-\[86px\] flex-shrink-0 items-center justify-end/);
  assert.match(live, /data-testid="process-live-row"[\s\S]{0,120}data-live-elapsed-ms=\{elapsedMs\}/);
  assert.match(live, /className="h-2 w-2 flex-shrink-0 rounded-full process-dot-live"/);
  assert.match(live, /i18nService\.t\('processLiveElapsed'\)\.replace\('\{duration\}', started\.compact\)/);
  assert.match(live, /formatRelativeTime\(session\.createdAt, nowMs\)/);
  assert.match(live, /action \|\| i18nService\.t\('processLiveActionFallback'\)/);
  // A live row has NO ⋯ valve: archiving a running run is not a thing.
  assert.doesNotMatch(live, /process-row-valve/);

  // 最近结束: completed/failed counts, newest-first list, foldable.
  assert.match(panel, /data-testid="process-ended-section"[\s\S]{0,200}data-ended-count=\{dynamic\.recentlyEnded\.length\}/);
  assert.match(panel, /data-ended-completed=\{dynamic\.completedCount\}/);
  assert.match(panel, /data-ended-failed=\{dynamic\.failedCount\}/);
  assert.match(panel, /data-testid="process-ended-toggle"[\s\S]{0,120}aria-expanded=\{endedExpanded\}/);
  assert.match(panel, /data-testid="process-ended-counts"/);
  assert.match(panel, /processEndedCounts'\)\s*\n?\s*\.replace\('\{done\}', String\(dynamic\.completedCount\)\)/);
  assert.match(panel, /data-testid="process-ended-empty"[\s\S]{0,420}processEndedEmpty/);
  // The ended rows are the EXISTING run rows, verbatim — zero data change.
  // v5: the valve level is the row's own lineage, computed per row.
  assert.match(panel, /\{endedRows\.map\(\(entry\) => renderRun\(entry, 0, rowValveLevelOf\(entry\.session\)\)\)\}/);
  assert.match(panel, /const endedRows = dynamic\.recentlyEnded\.slice\(0, endedVisible\);/);
  assert.match(panel, /const \[endedExpanded, setEndedExpanded\] = useState\(true\);/);

  // First screen = 动态: the zone heading (the old 567/657 band) only renders on
  // a source tab, never inside the dynamic body.
  const dynamicBody = panel.slice(panel.indexOf('data-testid="process-dynamic-body"'), panel.indexOf('data-testid="process-zone-heading"'));
  assert.ok(dynamicBody.length > 0, 'the zone heading follows the dynamic body');
  assert.doesNotMatch(dynamicBody, /process-zone-heading/);
  assert.match(panel, /data-testid="process-zone-heading"[\s\S]{0,900}ZONE_LABEL_KEY\[zoneModel\.zone\]/);

  // Behaviour: the pure projection sorts by recency, splits completed/failed,
  // and keeps pending rows out of both bands.
  const now = NOW;
  const mkEntry = (id: string, status: string, updatedAt: number, extra?: Record<string, unknown>) => ({
    session: {
      id, title: `T ${id}`, status, pinned: false,
      createdAt: updatedAt - 60_000, updatedAt, autoOrigin: 'orchestration' as const,
      ...extra,
    },
    kind: 'orchestrate' as const,
    state: 'idle' as const,
    statusKind: 'dead' as const,
    error: false,
    stalePending: false,
    awaitingVerdict: false,
  });
  const entries = [
    { ...mkEntry('done-old', 'completed', now - 90 * 60_000), statusKind: 'dead' as const },
    { ...mkEntry('live', 'running', now - 5 * 60_000), statusKind: 'live' as const, state: 'running' as const },
    { ...mkEntry('failed', 'error', now - 10 * 60_000), statusKind: 'dead' as const, error: true },
    { ...mkEntry('done-new', 'completed', now - 30 * 60_000), statusKind: 'dead' as const },
    { ...mkEntry('stopped', 'stopped', now - 20 * 60_000), statusKind: 'dead' as const },
    { ...mkEntry('pending', 'idle', now - 60_000), statusKind: 'pending' as const, awaitingVerdict: true },
  ];
  const dynamicModel = buildProcessDynamic(entries as any);
  assert.deepEqual(dynamicModel.running.map((entry) => entry.session.id), ['live']);
  assert.deepEqual(
    dynamicModel.recentlyEnded.map((entry) => entry.session.id),
    ['failed', 'stopped', 'done-new', 'done-old'],
    'newest first (-10m, -20m, -30m, -90m), and a pending row never enters 最近结束',
  );
  assert.equal(dynamicModel.completedCount, 2, 'only status=completed counts as 完成');
  assert.equal(dynamicModel.failedCount, 1, 'error rows count as 失败');
  assert.deepEqual(buildProcessDynamic([]), {
    running: [], recentlyEnded: [], completedCount: 0, failedCount: 0,
  });
});

test('the tree model groups task runs, never fabricates a parent, and loses no run', () => {
  // Behaviour, not text: the model is the part that can be wrong.
  const mkEntry = (id: string, title: string, origin: any, updatedAt: number) => ({
    session: {
      id, title, status: 'idle', pinned: false,
      createdAt: updatedAt - 1000, updatedAt,
      autoOrigin: origin, foldOverride: null,
      metabotName: 'Monday', metabotAvatar: null,
    },
    kind: origin === 'schedule' ? 'scheduled' : origin === 'longterm' ? 'build' : 'orchestrate',
    state: 'idle',
    awaitingVerdict: false,
  }) as any;

  const entries = [
    // one task with three runs (prefix + a dated variant of the same task)
    mkEntry('a1', '[定时] 余额门禁续发（日检）', 'schedule', 10),
    mkEntry('a2', '[定时] 余额门禁续发（日检）', 'schedule', 20),
    mkEntry('a3', '[定时] 余额门禁续发（日检）', 'schedule', 30),
    // long-term: two sub-project runs of ONE parent task
    mkEntry('b1', '[长期] OAC 能力补齐 · #1 先例研究', 'longterm', 40),
    mkEntry('b2', '[长期] OAC 能力补齐 · #2 判据表', 'longterm', 50),
    // a one-shot orchestration run: must stay a leaf, never gain a parent
    mkEntry('c1', '[编排任务] 1121-b 进程中心 v2', 'orchestration', 60),
    // a [督办] run is an orchestration, so it lands in the orchestration zone
    mkEntry('d1', '[督办] 1121-b 进程中心 v2', 'orchestration', 70),
  ];
  const zones = buildProcessZones(entries);

  // Grouping: 3 schedule runs collapse to ONE node whose children are the runs.
  assert.equal(zones.scheduled.nodes.length, 1, 'three runs of one task = one node');
  assert.equal(zones.scheduled.nodes[0].grouped, true);
  assert.deepEqual(zones.scheduled.nodes[0].children.map((c: any) => c.session.id), ['a3', 'a2', 'a1'],
    'children are newest-first');
  assert.equal(zones.scheduled.nodes[0].title, '余额门禁续发（日检）', 'the prefix is stripped for the parent label');

  // Long-term: ` · #N …` collapses to the parent task name.
  assert.equal(zones.longterm.nodes.length, 1);
  assert.equal(zones.longterm.nodes[0].title, 'OAC 能力补齐');
  assert.equal(zones.longterm.nodes[0].children.length, 2);

  // The one-shot run keeps its own row; [督办] + [编排任务] of the same title
  // share a node (same normalised key) — that is a real task family, not a guess.
  assert.equal(zones.orch.nodes.length, 1);
  assert.equal(zones.orch.nodes[0].grouped, true);
  assert.equal(zones.orch.nodes[0].children.length, 2);

  // Nothing is lost or duplicated: every run appears exactly once.
  const seen: string[] = [];
  for (const zone of ['orch', 'scheduled', 'longterm'] as const) {
    for (const node of zones[zone].nodes) for (const child of node.children) seen.push(child.session.id);
  }
  assert.equal(seen.length, entries.length, 'every run accounted for exactly once');
  assert.equal(new Set(seen).size, entries.length, 'no run appears twice');
  // A non-grouped node ever holding ≠1 run would mean a fabricated parent.
  for (const zone of ['orch', 'scheduled', 'longterm'] as const) {
    for (const node of zones[zone].nodes) {
      if (!node.grouped) assert.equal(node.children.length, 1, 'a leaf holds exactly one run');
    }
  }
  // Ordering: foldable TASK nodes come before one-shot leaves. Measured on the
  // live instance, pure recency put 80 leaves on the first screen and hid every
  // task — the tree was invisible until several "show more" clicks.
  const ordered = buildProcessZones([
    mkEntry('z1', '[编排任务] 一条很新的一次性运行', 'orchestration', 900),
    mkEntry('z2', '[编排任务] 老任务', 'orchestration', 100),
    mkEntry('z3', '[编排任务] 老任务', 'orchestration', 200),
  ]);
  assert.deepEqual(ordered.orch.nodes.map((n: any) => n.grouped), [true, false],
    'the grouped task outranks the newer one-shot leaf');
  assert.deepEqual(ordered.orch.nodes[0].children.map((c: any) => c.session.id), ['z3', 'z2'],
    'and children stay newest-first inside the group');

  // Zones are assigned from the CREATION fact, never from the title prefix.
  assert.equal(processZoneOf({ autoOrigin: 'schedule' } as any), 'scheduled');
  assert.equal(processZoneOf({ autoOrigin: 'longterm' } as any), 'longterm');
  assert.equal(processZoneOf({ autoOrigin: 'orchestration' } as any), 'orch');
  assert.equal(processZoneOf({ autoOrigin: null } as any), 'orch', 'a hand-parked row is a generic run');
});

test("the panel speaks the app's shape language (copied values, no bespoke px)", () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const model = readSource('src/renderer/utils/processCenter.ts');

  // ① header = the reference panel's two-tier bar (ScheduledTasksView:104):
  //    h-12 outer strip + an h-8 inner content block, so the divider line keeps
  //    breathing room above AND below instead of hugging the title. The bespoke
  //    14.5px title and the pb-2.5 that squeezed the bar stay gone.
  assert.match(panel, /data-slot="process-panel-header"[\s\S]{0,120}className="flex h-12 shrink-0 items-center gap-2 border-b border-claude-border px-4 dark:border-claude-darkBorder"/);
  assert.doesNotMatch(panel, /h-\[36px\] shrink-0 items-center gap-2 border-b/);
  assert.doesNotMatch(panel, /text-\[14\.5px\]/);
  assert.match(panel, /data-slot="process-panel-header-inner" className="flex h-8 min-w-0 items-center gap-2"/);
  assert.match(panel, /className="flex min-w-0 items-center gap-2 text-lg font-semibold dark:text-claude-darkText text-claude-text"/);

  // ② zone switcher = the Studio|BotWorks segmented master (HomeSidebar):
  //    grid + h-[32px] + gap-0 + clipped radius token + per-cell h-full text-xs.
  assert.match(panel, /className="ml-auto grid h-\[32px\] grid-cols-3 gap-0 overflow-hidden rounded-\[var\(--shape-radius-sm\)\] border border-claude-border\/70 bg-claude-bg\/80 dark:border-claude-darkBorder\/70 dark:bg-claude-darkBg\/80"/);
  assert.match(panel, /inline-flex h-full min-w-0 items-center justify-center gap-1 px-2 text-\[11\.5px\] font-medium leading-none/);
  // Selected = the master's fill pair (claude-accent = #FFDC51, accentInk = #303133).
  assert.match(panel, /'bg-claude-accent text-claude-accentInk'/);
  assert.doesNotMatch(panel, /bg-\[#FFDC51\] font-semibold/);
  assert.doesNotMatch(panel, /border-r border-claude-border px-3 py-1/);

  // ③ awaiting strip = the 36px tier, row-level type sizes, rail's own badge class.
  assert.match(panel, /className="flex h-\[36px\] w-full items-center gap-2 px-4 text-left"/);
  assert.doesNotMatch(panel, /px-4 py-1\.5 dark:border-amber-700/);
  assert.match(panel, /className="flex h-\[14px\] min-w-\[14px\] flex-shrink-0 items-center justify-center rounded-full bg-red-500 px-\[3px\] text-\[9\.5px\] font-bold leading-none text-white"/);

  // ④ in-row tags = the app's existing tag spec (MetaTaskBoard: px-1.5 py-0.5
  //    text-[11px] rounded) via ONE shared constant — no 10px, no rounded-[4px].
  // ONE tag class, in the model, so the list and the detail cannot drift.
  assert.match(model, /export const PROCESS_TAG_CLASS = 'flex-shrink-0 rounded border border-claude-border px-1\.5 py-0\.5 text-\[11px\]/);
  assert.match(panel, /PROCESS_TAG_CLASS,/);
  assert.doesNotMatch(panel, /text-\[10px\] dark:border-claude-darkBorder/);
  // Zone section heading = the app's small-section-header convention.
  assert.match(panel, /className="text-\[11px\] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary"/);
});

test('the archived reader left the tab row but kept its one door and its lazy read', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  // v2 moved 已归档 out of the zone tabs; it must still be reachable.
  assert.match(panel, /data-testid="process-archived-toggle"/);
  assert.match(panel, /archivedMode/);
  assert.match(panel, /if \(!archivedMode \|\| archivedEntries !== null\) return;/);
  assert.match(panel, /window\.electron\?\.cowork\?\.listArchivedSessions/);
  assert.match(panel, /buildArchivedProcessEntries\(result\.sessions\)/);
  // A missing bridge or a failed read lands on [] — the list shows its empty state.
  assert.match(panel, /if \(typeof reader !== 'function'\) return \[\];/);
  assert.match(panel, /\.catch\(\(\) => \{\s*\n\s*if \(!cancelled\) setArchivedEntries\(\[\]\);/);
});

test('the process view is READ-ONLY: no composer, a system bar, and the jump to Twin', () => {
  const detail = readSource('src/renderer/components/cowork/CoworkSessionDetail.tsx');
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');

  // Membership comes from the SAME rule the hub uses (no parallel gate).
  // The membership rule still comes from the ONE shared module (now a grouped
  // import that also carries the v3 prompt helpers).
  assert.match(detail, /import \{[\s\S]{0,400}isProcessSession[\s\S]{0,300}\} from '\.\.\/\.\.\/utils\/processCenter';/);
  assert.match(detail, /const isProcessSessionReadOnly = useMemo\(/);
  assert.match(detail, /\(\) => \(currentSession \? isProcessSession\(currentSession\) : false\),/);
  // The bottom bar branches BEFORE the composer, so a process session can never
  // render an input area.
  const barIndex = detail.indexOf('data-testid="process-read-only-bar"');
  const gateIndex = detail.indexOf('isProcessSessionReadOnly ? (');
  const composerIndex = detail.indexOf('<CoworkPromptInput', gateIndex > 0 ? gateIndex : 0);
  assert.ok(gateIndex > 0 && barIndex > gateIndex, 'the gate precedes the bar');
  assert.ok(composerIndex > barIndex, 'the composer branch comes after the read-only branch');
  // The bar: lock glyph + the read-only contract + the one jump.
  assert.match(detail, /<LockClosedIcon className="h-4 w-4 shrink-0/);
  assert.match(detail, /i18nService\.t\('processReadOnlyBar'\)/);
  assert.match(detail, /i18nService\.t\('processReadOnlyJump'\)/);
  assert.match(detail, /data-testid="process-jump-to-twin"[\s\S]{0,80}onClick=\{handleJumpToTwin\}/);
  // The jump still targets the Twin — the only surface the owner can type in —
  // but v3 hands it a CONTEXT prompt instead of an empty composer, so the
  // session clearing/switching now belongs to handleNewChat (the draft channel)
  // rather than to a local clearCurrentSession dispatch.
  assert.match(detail, /const handleJumpToTwin = useCallback\(\(\) => \{/);
  assert.match(detail, /find\(\(bot\) => bot\.metabot_type === 'twin'\)/);
  assert.match(detail, /dispatch\(setNewTaskMetabotId\(twin\.id\)\)/);
  assert.match(detail, /new CustomEvent\('cowork:newChatWithDraft'/);
  // 只读 is said ONCE, by the bottom bar (design 2026-11-21 22:4x deleted the
  // header chip: the bar is a shrink-0 sibling of the scroll area, always visible).
  assert.doesNotMatch(detail, /data-testid="process-read-only-chip"/);
  assert.doesNotMatch(detail, /i18nService\.t\('processReadOnlySubtitle'\)/);
  // The panel only OPENS rows; it never steers one.
  assert.doesNotMatch(panel, /coworkService\.submitInput/);
  assert.doesNotMatch(panel, /CoworkPromptInput/);
});

test('the process detail header is a dossier, not a session room plate', () => {
  const detail = readSource('src/renderer/components/cowork/CoworkSessionDetail.tsx');

  // A SECOND STRUCTURE: process sessions branch before the session header.
  assert.match(detail, /\{isProcessSessionReadOnly && processHeaderModel \? \(/);
  assert.match(detail, /data-slot="process-detail-header"/);
  assert.match(detail, /\{showBackToProcessHub && onBackToProcessHub && \(/);

  // present: dot · title · kind tag · (conditional) 待你拍板 · source task
  for (const id of ['process-detail-dot', 'process-detail-title', 'process-detail-kind', 'process-detail-awaiting']) {
    assert.match(detail, new RegExp(`data-testid="${id}"`), `${id} present`);
  }
  // 所属任务 is a plain-text pointer: same fetch, text look (no fill, no border).
  assert.match(detail, /<LongTermTaskOriginChip sessionId=\{currentSession\.id\} variant="text" \/>/);
  const chip = readSource('src/renderer/components/longTermTasks/LongTermTaskOriginChip.tsx');
  assert.match(chip, /data-testid="process-detail-task"/);
  assert.match(chip, /variant === 'text'[\s\S]{0,600}max-w-\[220px\][\s\S]{0,120}hover:underline/);
  // present: activity (the ONLY time element) + orchestrator as a SIGNATURE
  assert.match(detail, /data-testid="process-detail-activity"/);
  assert.match(detail, /data-testid="process-detail-signature"/);
  assert.match(detail, /\{i18nService\.t\('processOrchestratorLabel'\)\} · \{processHeaderModel\.orchestrator\}/);

  // tone: the return key is an ICON key (30×30 = h-8 w-8, r8), not a 103px label
  assert.match(detail, /data-testid="process-back-to-hub"[\s\S]{0,700}h-8 w-8[\s\S]{0,200}rounded-\[8px\]/);
  assert.doesNotMatch(detail, /data-testid="process-back-to-hub"[\s\S]{0,700}processBackToHub'\}\s*\n\s*<\/button>/);

  // the family name lives in the return key's title (design §5)
  assert.match(detail, /title=\{`\$\{i18nService\.t\('processBackToHub'\)\} · \$\{processHeaderModel\.zoneLabel\}`\}/);

  // delete: the session-only header elements must not render in this branch —
  // the ⋯ menu / search / cwd are outside the process branch entirely.
  const processBranch = detail.slice(
    detail.indexOf('data-slot="process-detail-header"'),
    detail.indexOf('data-slot="process-detail-header"') + 4000,
  );
  assert.doesNotMatch(processBranch, /EllipsisHorizontalIcon/);
  assert.doesNotMatch(processBranch, /handleOpenFolder/);
  assert.doesNotMatch(processBranch, /coworkConversationSearch|ConversationSearch/);

  // body: zero change — the read-only bar and the jump stay exactly where they were
  assert.match(detail, /data-testid="process-read-only-bar"/);
  assert.match(detail, /data-testid="process-jump-to-twin"/);
});

test('opening a process row routes through the SAME transcript, read-only', () => {
  const app = readSource('src/renderer/App.tsx');
  assert.match(app, /const openProcessReadOnly = useCallback\(async \(sessionId: string\) => \{/);
  assert.match(app, /setMainView\('cowork'\);\s*\n\s*await coworkService\.loadSession\(sessionId\);/);
  // The panel now mounts INSIDE the floatwin shell (which owns the exit).
  assert.match(app, /<ProcessCenterFloatwin\s*\n\s*onClose=\{closeProcessFloatwin\}/);
  assert.match(app, /onOpenProcess=\{openProcessReadOnly\}\s*\n\s*viewStateRef=\{processHubViewRef\}/);
});

test('every v2 i18n key exists once per language pack', () => {
  const i18n = readSource('src/renderer/services/i18n.ts');
  const keys = [
    'processCenter',
    'processCenterTitle',
    'processCenterAwaitingBadge',
    // v4 动态 first (the landing page) + its two bands
    'processTabDynamic',
    'processLiveSection',
    'processLiveEmpty',
    'processLiveElapsed',
    'processLiveActionFallback',
    'processEndedSection',
    'processEndedCounts',
    'processEndedEmpty',
    'processUnattributedBot',
    // v2 zones (the three 页签)
    'processZoneOrch',
    'processZoneScheduled',
    'processZoneLongterm',
    // v2 awaiting strip (demoted from a tab)
    'processAwaitingStripLabel',
    'processAwaitingStripHint',
    'processAwaitingStripEmpty',
    // v2 tree
    'processTreeRunCount',
    'processShowMore',
    'processEmptyZone',
    // row + valve + archived door
    'processKindBuild',
    'processKindOrchestrate',
    'processKindScheduled',
    'processOrchestratorLabel',
    'processArchiveAction',
    'processRemoveAction',
    'processEmptyArchived',
    'processArchivedBack',
    'processTabArchived',
    // read-only view
    'processReadOnlySubtitle',
    'processReadOnlyBar',
    'processReadOnlyJump',
    'processReadOnlyJumpTitle',
    'processReadOnlyJumpMissing',
    // ── v5 动作沉浸 (Friday 稿四步, owner approval 2026-11-23 06:07) ──
    'processValveStop',
    'processRowDecideButton',
    'processRowDecideHint',
    'processGateBarLabel',
    'processGateClassDelete',
    'processGateClassFunds',
    'processGateClassCapability',
    'processGateViewAction',
  ];
  for (const key of keys) {
    assert.equal(
      (i18n.match(new RegExp(`\\n\\s*${key}:`, 'g')) ?? []).length,
      2,
      `${key}: one per locale`,
    );
  }
  // The v1 tab/layer keys are RETIRED with the double semantics they named.
  for (const retired of [
    'processTabAwaiting',
    'processTabRunning',
    'processAwaitingLayerBadge',
    'processAwaitingLayerHint',
    'processEmptyAwaiting',
    'processEmptyRunning',
  ]) {
    assert.equal(
      (i18n.match(new RegExp(`\\n\\s*${retired}:`, 'g')) ?? []).length,
      0,
      `${retired}: must not survive v2`,
    );
  }
  // The read-only hint (added by 1121-a) is still there for the panel footer.
  assert.equal((i18n.match(/coworkProcessReadOnlyHint:/g) ?? []).length, 2);
});

test('v3 ①: the process transcript has a return chip, and the hub remembers where you were', () => {
  const detail = readSource('src/renderer/components/cowork/CoworkSessionDetail.tsx');
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const app = readSource('src/renderer/App.tsx');
  const view = readSource('src/renderer/components/cowork/CoworkView.tsx');

  // The chip only exists on a transcript that was opened FROM the hub, and it
  // says where it goes. Shape: 1px border + the 28px tier the order pins.
  assert.match(detail, /showBackToProcessHub && onBackToProcessHub && \(/);
  assert.match(detail, /data-testid="process-back-to-hub"/);
  assert.match(detail, /className="non-draggable flex h-\[28px\] shrink-0 items-center gap-1 rounded-\[8px\] border border-claude-border px-2/);
  assert.match(detail, /i18nService\.t\('processBackToHub'\)/);
  assert.match(detail, /<ArrowLeftIcon className="h-3\.5 w-3\.5" \/>/);
  // …and the return is a real view switch, not an in-place state tweak.
  assert.match(detail, /onClick=\{onBackToProcessHub\}/);

  // App: one ref holds the hub's own view state; the flag names WHICH session
  // came from the hub (a bare boolean would leak onto unrelated transcripts).
  // N4 (floatwin): ONE view-state object PER FACE, so the overlay's open bit
  // survives a face switch without leaking across faces.
  assert.match(app, /const processHubViewRefHome = useRef<ProcessHubViewState>\(\{/);
  assert.match(app, /const processHubViewRefInternet = useRef<ProcessHubViewState>\(\{/);
  assert.match(app, /floatwin: \{ \.\.\.DEFAULT_PROCESS_HUB_VIEW_STATE\.floatwin \}/);
  assert.match(app, /const processHubViewRef = processHubViewRefFor\(botBrowserShell\.surfaceMode === 'home' \? 'home' : 'browser'\);/);
  assert.match(app, /const \[hubOpenedSessionId, setHubOpenedSessionId\] = useState<string \| null>\(null\);/);
  // Back returns on the side the owner is already on.
  assert.match(app, /const handleBackToProcessHub = useCallback\(\(\) => \{\s*\n\s*setHubOpenedSessionId\(null\);\s*\n\s*setStudioTwinOpen\(false\);/);
  assert.match(app, /openProcessFloatwin\(botBrowserShell\.surfaceMode === 'home' \? 'home' : 'browser'\);/);
  assert.match(app, /const showBackToProcessHub = hubOpenedSessionId != null && hubOpenedSessionId === currentSessionId;/);
  assert.match(app, /<ProcessCenterPanel onOpenProcess=\{openProcessReadOnly\} viewStateRef=\{processHubViewRef\} \/>/);
  // both the view and the detail receive it
  assert.match(view, /showBackToProcessHub=\{showBackToProcessHub\}/);
  assert.match(view, /onBackToProcessHub=\{onBackToProcessHub\}/);

  // Panel: restores zone / archived / scroll on mount, writes them back after.
  assert.match(panel, /const restored = viewStateRef\?\.current;/);
  assert.match(panel, /useState<ProcessHubTab>\(restored\?\.tab \?\? 'dynamic'\)/);
  assert.match(panel, /useState\(restored\?\.archivedMode \?\? false\)/);
  assert.match(panel, /if \(el && target > 0\) el\.scrollTop = target;/);
  assert.match(panel, /onScroll=\{handleBodyScroll\}/);
  assert.match(panel, /scrollTop: event\.currentTarget\.scrollTop/);
  // The default is a named constant, so "nothing remembered" is explicit.
  assert.deepEqual(DEFAULT_PROCESS_HUB_VIEW_STATE, {
    tab: 'dynamic',
    archivedMode: false,
    scrollTop: 0,
    expandedTaskKeys: [],
    floatwin: { open: false, lastSessionId: null },
  });
  // The fold rides the same view state: restoring only the offset is not enough,
  // because a collapsed list is shorter and the offset clamps (-71px measured).
  assert.match(panel, /useState<Set<string>>\(\s*\n?\s*\(\) => new Set\(restored\?\.expandedTaskKeys \?\? \[\]\)/);
  assert.match(panel, /expandedTaskKeys: \[\.\.\.expandedTasks\]/);
});

test('v3 ②: 对 Twin 说 carries a context prompt instead of opening a blank composer', () => {
  const detail = readSource('src/renderer/components/cowork/CoworkSessionDetail.tsx');

  // It rides the SAME draft channel the long-term 继续讨论 uses…
  assert.match(detail, /new CustomEvent\('cowork:newChatWithDraft', \{ detail: \{ text: draftText \} \}\)/);
  // …and no longer opens an empty composer by itself.
  assert.doesNotMatch(detail, /new CustomEvent\('cowork:focus-input', \{ detail: \{ clear: true \} \}\)/);
  // The prompt is BUILT, from real data, before the handoff.
  assert.match(detail, /buildTwinSteeringPrompt\(i18nService\.t\('processJumpDraft'\)/);
  assert.match(detail, /resolveSourceTaskTitle\(session, longTermCards\)/);
  assert.match(detail, /lastAssistantDigest\(session\?\.messages\)/);
  assert.match(detail, /processJumpStateAwaiting/);
  assert.match(detail, /processJumpActionAwaiting/);
  // The Twin stays the addressee (only the Twin may steer a run).
  assert.match(detail, /metabot_type === 'twin'/);
  assert.match(detail, /dispatch\(setNewTaskMetabotId\(twin\.id\)\)/);
});

test('v3 prompt builder: every slot is filled, and a missing field becomes the visible placeholder', () => {
  const template = '关于任务「{task}」的进程「{process}」：{state}，最近进展：{progress}。请帮我处理：{action}。';
  const full = buildTwinSteeringPrompt(template, {
    task: '1121-b 进程中心', process: '[编排任务] 1121-b 面板化',
    state: '施工中', progress: 'tsc 0，测试全绿', action: '继续推进',
  });
  assert.equal(full, '关于任务「1121-b 进程中心」的进程「[编排任务] 1121-b 面板化」：施工中，最近进展：tsc 0，测试全绿。请帮我处理：继续推进。');
  // A field we could not read must be VISIBLE, never silently empty.
  const partial = buildTwinSteeringPrompt(template, {
    task: null, process: '  ', state: '已闲置', progress: null, action: '继续推进',
  });
  assert.ok(partial.includes('「（未取到）」'), 'unknown task shows the placeholder');
  assert.ok(partial.includes('进程「（未取到）」'), 'blank process shows the placeholder');
  assert.ok(partial.includes('最近进展：（未取到）'), 'missing progress shows the placeholder');
  assert.ok(!partial.includes('{'), 'no unfilled slot survives');

  // Source task title: a REAL bound card wins over the title prefix…
  const session = { id: 's1', title: '[编排任务] 1121-b 进程中心面板化接手补完' };
  assert.equal(
    resolveSourceTaskTitle(session, [{ title: '真实的长期任务标题', originSessionId: 's1' }]),
    '真实的长期任务标题',
  );
  assert.equal(
    resolveSourceTaskTitle(session, [{ title: '等验收的任务', decisionSessionIds: ['s1'] }]),
    '等验收的任务',
  );
  // …then the prefix, trimmed of the sub-project suffix…
  assert.equal(
    resolveSourceTaskTitle({ id: 's2', title: '[长期] OAC 能力补齐 · #3 Round 3：助手模式' }, []),
    'OAC 能力补齐',
  );
  // …and null when neither exists (the caller renders the placeholder).
  assert.equal(resolveSourceTaskTitle({ id: 's3', title: '   ' }, null), null);

  // Latest progress = the LAST assistant message, flattened and cut.
  assert.equal(lastAssistantDigest([
    { type: 'user', content: 'do it' },
    { type: 'assistant', content: '第一版\n\n完成' },
    { type: 'user', content: 'again' },
    { type: 'assistant', content: '  最新   汇报：全部绿  ' },
  ]), '最新 汇报：全部绿');
  assert.equal(lastAssistantDigest([{ type: 'user', content: 'only user' }]), null);
  const long = lastAssistantDigest([{ type: 'assistant', content: 'x'.repeat(200) }], 20);
  assert.equal(long?.length, 20, 'cut to maxChars, ellipsis included');
  assert.ok(long?.endsWith('…'));
});

test('App keeps every hook above the init guard (no "more hooks than previous render")', () => {
  // Blocking regression 2026-11-21 09:55: `openProcessReadOnly` was declared as
  // a useCallback BELOW `if (!isInitialized) return (…)`. The first render
  // stopped at the guard (N hooks), the post-bootstrap render continued past it
  // and called one more hook (N+1) → React threw "Rendered more hooks than
  // during the previous render" and the whole window went white.
  const app = readSource('src/renderer/App.tsx');
  const lines = app.split('\n');
  const guardIndex = lines.findIndex((line) => /^ {2}if \(!isInitialized\) \{/.test(line));
  assert.ok(guardIndex > -1, 'the init guard still exists (this test pins the area it guards)');

  // Every hook that lives in the component body (2-space indent) and every bare
  // hook call must sit ABOVE the guard. A hook below it is the bug, whether it
  // is `const x = useMemo(…)` or a bare `useEffect(…)`.
  const hookAtTwoSpaces = /^ {2}(?:const|let|var)\s+[\w$]+\s*=\s*(?:use[A-Z][\w$]*|React\.use[A-Z][\w$]*)\(|^ {2}use[A-Z][\w$]*\(/;
  const offenders = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > guardIndex && hookAtTwoSpaces.test(line))
    .map(({ line, index }) => `${index + 1}: ${line.trim().slice(0, 80)}`);
  assert.deepEqual(offenders, [], 'hooks declared after the init guard break hook order');
});

test('both rail wirings route the entry, and NO path forces a side switch', () => {
  // Companion bug found by the same CDP pass: App mounts TWO WorkspaceRail
  // instances (BotWorks face / Studio face) with their own inline
  // onSelectHomeSection handlers. Only the Studio one delegated to
  // handleSelectHomeSection, so on the BotWorks face clicking 进程 did nothing
  // at all — no error, no panel, just a dead button.
  const app = readSource('src/renderer/App.tsx');
  const handlers = app.split('onSelectHomeSection={(section) => {').slice(1);
  assert.equal(handlers.length, 2, 'both faces keep their own rail wiring');
  for (const [index, body] of handlers.entries()) {
    const slice = body.slice(0, 700);
    // BotWorks carries its own branch; Studio delegates to handleSelectHomeSection
    // (which carries the same branch). Either way the click must land.
    assert.equal(/section === 'processes'|handleSelectHomeSection\(section\)/.test(slice), true,
      `wiring #${index + 1} routes it`);
  }
  // Opening a PROCESS row must not switch sides. (Other flows — 新建任务, the
  // 长期任务 board hand-off, a session deep-link — legitimately do, so the check
  // is scoped to the hub's own opener rather than the whole file.)
  const opener = app.slice(app.indexOf('const openProcessReadOnly'), app.indexOf('const handleBackToProcessHub'));
  assert.equal(opener.includes('switchToHome'), false, 'the hub opener does not switch sides');
  assert.equal(opener.includes("setMainView("), true, 'it still sets mainView — but only on the home face');
  assert.match(opener, /if \(botBrowserShell\.surfaceMode === 'home'\) setMainView\('cowork'\);/);
  assert.match(app, /if \(botBrowserShell\.surfaceMode === 'home'\) setMainView\('cowork'\);/);
  // Back returns on the CURRENT side.
  // v6: back re-opens the FLOATWIN on the face the owner is on; no side switch
  // and no pane change (the hub is a control now, not a destination).
  assert.match(app, /openProcessFloatwin\(botBrowserShell\.surfaceMode === 'home' \? 'home' : 'browser'\);/);
  // …and the Studio column can mount the transcript (that is what removed the
  // need to switch at all).
  // The session test must come BEFORE the pane test, or the hub list wins and the
  // row click looks dead (measured on the live app).
  assert.match(app, /const internetCatalogContent = \(studioTwinOpen \|\| hubOpenedSessionId != null\) \? \([\s\S]{0,600}coworkPane[\s\S]{0,200}internetPaneKey === 'processCenterView'/);
});

/* ═════════════ v5 动作沉浸 (Friday 稿四步, owner approval 2026-11-23 06:07) ═════════════
 *
 * Blueprint: bots/6/2026-11-23/reports/process-action-immersion-{inventory,report}.md
 * §5-7, five forks ruled 1A/2A/3A/4B/5A. These tests pin the NEW valve semantics
 * (the old boolean pins were allowed to go red, per the work order).
 */

test('v5 ① fork 1A: the valve gate is TRI-STATE by lineage, and the boolean is retired', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const model = readSource('src/renderer/utils/processCenter.ts');

  // The pure mapping: autoOrigin == null → full (human), else housekeeping (bot).
  assert.equal(rowValveLevelOf(mkSession('h', undefined)), 'full');
  assert.equal(rowValveLevelOf(mkSession('h2', null)), 'full');
  assert.equal(rowValveLevelOf(mkSession('b1', 'orchestration')), 'housekeeping');
  assert.equal(rowValveLevelOf(mkSession('b2', 'longterm')), 'housekeeping');
  assert.equal(rowValveLevelOf(mkSession('b3', 'schedule')), 'housekeeping');
  assert.match(model, /export type ProcessRowValveLevel = 'none' \| 'housekeeping' \| 'full';/);
  assert.match(model, /export const rowValveLevelOf = \(/);

  // The panel speaks the level, never the retired boolean.
  assert.match(panel, /valveLevel: ProcessRowValveLevel/);
  assert.doesNotMatch(panel, /allowValve/);
  assert.doesNotMatch(panel, /renderRun\([^)]*, 0, true\)/);
  // Archived rows are the 'none' face — no valves at all (unchanged contract).
  assert.match(panel, /renderRun\(entry, 0, 'none'\)/);
  // The awaiting strip / bot bar / tree children compute the level PER ROW.
  assert.match(panel, /model\.awaiting\.map\(\(entry\) => renderRun\(entry, 0, rowValveLevelOf\(entry\.session\)\)\)/);
  assert.match(panel, /model\.botSelfDigested\.map\(\(entry\) => renderRun\(entry, 0, rowValveLevelOf\(entry\.session\), true\)\)/);
  assert.match(panel, /node\.children\.map\(\(child\) => renderRun\(child, 1, rowValveLevelOf\(child\.session\)\)\)/);
  // The bucket valve (整理类, lineage-exempt) rides the SAME level gate.
  assert.match(panel, /onSetBucket=\{valveLevel !== 'none' \? \(sessionId, next\) => void setLineageBucket\(sessionId, next\) : undefined\}/);
});

test('v5 ② S1 brake valve: live rows only, the existing stop channel, zero new wire', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const preload = readSource('src/main/preload.ts');

  // The brake is keyed on the STATUS band, never on lineage (刹车类豁免).
  assert.match(panel, /onStop=\{entry\.statusKind === 'live' \? handleStopRun : undefined\}/);
  assert.match(panel, /data-testid="process-row-stop"/);
  assert.match(panel, /data-testid="process-live-stop"/);
  // One channel only: cowork:session:stop via the existing service wrapper.
  assert.match(panel, /void coworkService\.stopSession\(sessionId\);/);
  assert.match(preload, /stopSession: \(sessionId: string\) =>\s*\n\s*ipcRenderer\.invoke\('cowork:session:stop', sessionId\)/);
  // No hub-side invented stop wire (a scheduled run's "stop this run" is the
  // SAME brake valve on its session row — fork 4B keeps task objects out).
  assert.doesNotMatch(panel, /scheduledTask:/);
  assert.doesNotMatch(panel, /processStopRun|session:stopRun/);
});

test('P0 转向类移出 (v3.2 §2.2 row 7): the hub holds NO retry/steer valve', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const model = readSource('src/renderer/utils/processCenter.ts');

  // 转向 = 派活, not 处置: its entry is the session itself (人说话的地方),
  // never a hub button. Both the button and its draft channel left the panel.
  assert.doesNotMatch(panel, /process-row-retry/);
  assert.doesNotMatch(panel, /onRetry/);
  assert.doesNotMatch(panel, /handleRetryToTwin/);
  assert.doesNotMatch(panel, /buildTwinSteeringPrompt/);
  assert.doesNotMatch(panel, /cowork:newChatWithDraft/);
  assert.doesNotMatch(model, /retrySteerVisible/);
  // No hidden rerun channel either.
  assert.doesNotMatch(panel, /sessionRerun|session:rerun/);
  // The row itself still opens the session — that is where steering belongs.
  assert.match(panel, /onClick=\{\(\) => onOpen\(session\.id\)\}/);
});

test('v5 ③ the exception-gate bar classifies the three gates and stays READ-ONLY', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const model = readSource('src/renderer/utils/processCenter.ts');

  // Pure classification, anchored on the host-stamped wire shape:
  // G1 删文件 = destructive; G2 资金·链上 = wallet_/me_charge/payment_card/upload;
  // G3 能力·定位 = skill_tool/get_host_location; a plain AskUserQuestion is NOT
  // an exception gate and must stay out of the bar.
  const mkPermission = (overrides: Record<string, unknown>): Parameters<typeof classifyProcessGate>[0] => ({
    requestId: 'req-1',
    sessionId: 'sess-1',
    toolName: 'AskUserQuestion',
    toolInput: {},
    ...overrides,
  } as Parameters<typeof classifyProcessGate>[0]);
  const ctx = (requestedToolName: string, destructive?: boolean): Record<string, unknown> => ({
    context: { requestedToolName, requestedToolInput: {}, ...(destructive === undefined ? {} : { destructive }) },
  });
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('bash', true) })), 'delete');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('delete', true) })), 'delete');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('wallet_transfer') })), 'funds');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('me_charge') })), 'funds');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('payment_card_emit') })), 'funds');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('upload_file') })), 'funds');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('wallet_btc_broadcast') })), 'funds');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('skill_tool') })), 'capability');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('get_host_location') })), 'capability');
  // destructive wins FIRST — a funds-named tool stamped destructive reads G1.
  assert.equal(classifyProcessGate(mkPermission({ toolInput: ctx('upload_file', true) })), 'delete');
  assert.equal(classifyProcessGate(mkPermission({ toolInput: {} })), null, 'no stamped context → not a gate');
  assert.equal(classifyProcessGate(mkPermission({ toolName: 'Bash', toolInput: {} })), null, 'raw tool asks are not gates');

  // The projection carries the wire sliver the bar renders.
  const entries = buildProcessGateEntries([
    mkPermission({ requestId: 'r1', sessionId: 's1', toolInput: ctx('bash', true), expiresAt: 123, timeoutDefault: 'deny' }),
    mkPermission({ requestId: 'r2', toolInput: {} }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].requestId, 'r1');
  assert.equal(entries[0].sessionId, 's1');
  assert.equal(entries[0].gateClass, 'delete');
  assert.equal(entries[0].requestedToolName, 'bash');
  assert.equal(entries[0].expiresAt, 123);
  assert.equal(entries[0].timeoutDefault, 'deny');

  // The bar is a VIEW over the global pending-permission mirror — the same
  // redux state cowork:permission:listPending replays; zero new channel.
  assert.match(panel, /const pendingPermissions = useSelector\(\(state: RootState\) => state\.cowork\.pendingPermissions\);/);
  assert.match(panel, /data-testid="process-gate-bar"/);
  assert.match(panel, /data-testid="process-gate-row"/);
  assert.match(panel, /data-gate-class=\{entry\.gateClass\}/);
  assert.match(panel, /data-testid="process-gate-jump"/);
  // 查看 + 跳转 owner 确认: the SAME jump event the corner overlay uses.
  assert.match(panel, /new CustomEvent\('cowork:viewSession', \{ detail: \{ sessionId \} \}\)/);

  // READ-ONLY, structurally: the bar's own source slice never answers a
  // permission — no respond call, no allow-result builder, no deny button.
  const bar = panel.slice(panel.indexOf('const ProcessGateBar'), panel.indexOf('/** The sliver of a Studio decision-queue item'));
  assert.ok(bar.length > 200, 'the gate bar component exists');
  assert.doesNotMatch(bar, /respondToPermission/);
  assert.doesNotMatch(bar, /buildAllowResult/);
  assert.doesNotMatch(bar, /behavior: 'allow'/);
  assert.doesNotMatch(bar, /cowork:permission:respond/);
});

test('P0 权限搬迁 (v3.2 §2.3): the hub holds NO ruling channel — Live Stage is the only writer', () => {
  const preload = readSource('src/main/preload.ts');
  const main = readSource('src/main/main.ts');
  const typings = readSource('src/renderer/types/electron.d.ts');
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const liveStage = readSource('src/renderer/features/botBrowser/BotBrowserSurface.tsx');

  // The ONE renderer wire + the ONE shared main-side function stay untouched.
  assert.match(preload, /decisionResolve: \(input: \{ queueItemId: string; resolutionNote: string; activeSessionId\?: string \| null \}\) =>\s*\n\s*ipcRenderer\.invoke\('longtermTask:decisionResolve', input\)/);
  assert.match(typings, /decisionResolve: \(input: \{ queueItemId: string; resolutionNote: string; activeSessionId\?: string \| null \}\)/);
  assert.equal((main.match(/cancelSiblingQueuedForTask\(/g) ?? []).length, 1, 'the sibling cancel lives ONLY in the shared function');
  assert.match(main, /const resolveOwnerDecision = \(/);
  assert.match(main, /getLongTermTaskStore\(\)\.acceptSubtask\(ltSub\.id, 'owner',/);
  assert.match(main, /getLongTermTaskStore\(\)\.unblockSubtask\(ltSub\.id, 'owner',/);
  assert.match(main, /resolveDecision: \(sid, queueItemId, resolutionNote\) => \{[\s\S]{0,420}return resolveOwnerDecision\(sid \?\? null, queueItemId, resolutionNote\);/);
  assert.match(main, /registerIpcHandler\('longtermTask:decisionResolve'/);
  assert.match(main, /RESOLUTION_NOTE_REQUIRED/, 'a ruling without a recorded reason is not a ruling');
  assert.match(main, /const result = resolveOwnerDecision\(sid, queueItemId, resolutionNote\);/);

  // P0: the hub's ruling seat is GONE — no card, no option/approve/reject, no
  // resolve call, no note builders, no direct store write.
  assert.doesNotMatch(panel, /decisionResolve/, 'the hub must never call the resolve channel');
  assert.doesNotMatch(panel, /data-testid="process-decision-(block|card|option|reject-input|approve|reject-confirm)"/);
  assert.doesNotMatch(panel, /processDecision(Option|Accept|Reject|ResolveFailed)/);
  assert.doesNotMatch(panel, /!rejectText\.trim\(\)/);
  assert.doesNotMatch(panel, /getStudioDecisionQueueStore|studioDecisionQueueStore\./);

  // …and the Live Stage still rides the very same IPC: one resolve channel.
  assert.match(liveStage, /window\.electron\.longtermTask\.decisionResolve\(\{/);
  assert.match(liveStage, /queueItemId: data\.entry\.queueItemId/);

  // The hub still READS the same live queue it points into (no invented data).
  assert.match(panel, /api\?\.studioStatus\?\.\(\{\}\)|api\.studioStatus\(\{\}\)|studioStatus\(\{\}\)/);
});

test('P0 同源 (验收 3): both seats read the SAME live decision queue; no surface invents a row', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const nc = readSource('src/renderer/components/notifications/NotificationCenter.tsx');
  const main = readSource('src/main/main.ts');

  // Both renderer surfaces go through the one studioStatus read…
  assert.match(panel, /api\.studioStatus\(\{\}\)/);
  assert.match(nc, /lt\.studioStatus\(\{\}\)/);
  // …and consume the SAME field the main handler serves from listOpen().
  assert.match(panel, /result\.openDecisions/);
  assert.match(nc, /status\.openDecisions/);
  assert.match(main, /const openDecisions = twin \? getStudioDecisionQueueStore\(\)\.listOpen\(twin\.id\) : \[\];/);
  // Neither renderer may reach the store or fabricate a decision row.
  assert.doesNotMatch(panel, /getStudioDecisionQueueStore|studioDecisionQueueStore\./);
  assert.doesNotMatch(nc, /getStudioDecisionQueueStore|studioDecisionQueueStore\./);
});

test('P0 pointer (v3.2 S-08): a pending row jumps to the Live Stage seat, an unlinked row keeps the span', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const model = readSource('src/renderer/utils/processCenter.ts');

  // Pure linkage: row → its board card (decisionSessionIds) → the open decision
  // on that task. The decision itself is returned because its origin session is
  // the landing key for the Live Stage jump.
  const cards = [{ id: 'task-1', decisionSessionIds: ['sess-a'] }];
  const decisions = [
    { id: 'd1', longtermTaskId: 'task-1', originStudioSessionId: 'studio-a' },
    { id: 'd2', longtermTaskId: 'task-2', originStudioSessionId: 'studio-b' },
    { id: 'd3', longtermTaskId: null, originStudioSessionId: null },
  ];
  assert.deepEqual(openDecisionForSession('sess-a', cards, decisions), decisions[0]);
  assert.equal(openDecisionForSession('sess-b', cards, decisions), null);
  assert.equal(openDecisionForSession('sess-a', [], decisions), null);
  assert.equal(openDecisionForSession('sess-a', [{ id: 'task-1' }], decisions), null, 'a card without decisionSessionIds binds nothing');
  assert.match(model, /export const openDecisionForSession = \(/);

  // The row renders a pointer BUTTON only when linked; otherwise the span stays.
  assert.match(panel, /data-testid="process-row-decide-button"/);
  assert.match(panel, /data-testid="process-row-decide"/);
  assert.match(panel, /data-decision-jump="live-stage"/);
  assert.match(panel, /onDecide=\{linkedDecision \? \(\) => jumpToDecisionSeat\(linkedDecision, entry\.session\.id\) : undefined\}/);
  // The pointer rides the SAME two events the notification center's jump uses.
  assert.match(panel, /const jumpToDecisionSeat = useCallback/);
  assert.match(panel, /originStudioSessionId/);
  assert.match(panel, /new CustomEvent\('cowork:viewSession', \{ detail: \{ sessionId \} \}\)/);
  assert.match(panel, /sessionTabBinding\.revealSessionTab\(sessionId\)/);
  // The old in-place seat (card anchor + scroll) is gone.
  assert.doesNotMatch(panel, /data-decision-id=\{item\.id\}/);
  assert.doesNotMatch(panel, /focusDecision/);
});

test('P0 交互分类 (v3.2 §2.0): the hub keeps EXACTLY the four management actions, each on its own surface', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');

  // 1) kill — the existing brake channel, live rows only (22:50 点名的那一个).
  assert.match(panel, /onStop=\{entry\.statusKind === 'live' \? handleStopRun : undefined\}/);
  assert.match(panel, /void coworkService\.stopSession\(sessionId\)/);
  // 2) archive — DB archived_at via the existing service.
  assert.match(panel, /onArchive=\{valveLevel !== 'none' \? handleArchive : undefined\}/);
  assert.match(panel, /void coworkService\.archiveSession\(sessionId\)/);
  // 3) remove — fold override 'out', never the creation fact.
  assert.match(panel, /onRemove=\{valveLevel !== 'none' \? handleRemove : undefined\}/);
  assert.match(panel, /coworkService\.setSessionFoldOverride\(sessionId, 'out'\)/);
  // 4) bucket — renderer-local routing, gated on awaiting rows.
  assert.match(panel, /onSetBucket=\{valveLevel !== 'none' \? \(sessionId, next\) => void setLineageBucket\(sessionId, next\) : undefined\}/);
  assert.match(panel, /state === 'awaiting' &&/);

  // None of the four writes a ruling: no waiting_owner / decision mutation.
  assert.doesNotMatch(panel, /waiting_owner/);
  assert.doesNotMatch(panel, /acceptSubtask|unblockSubtask|decisionResolve/);
  assert.doesNotMatch(panel, /studio_decision_queue/);
  // And no fifth action survives: the 转向类 retry valve moved out in P0.
  assert.doesNotMatch(panel, /data-testid="process-row-retry"|onRetry|handleRetryToTwin/);
});

test('v5 forks 4B + 5A: scheduled task objects stay OUT of the hub; rows stay sessions', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');

  // fork 4B: no task-object valves (toggle / run-now / task-stop) in the hub —
  // the only scheduled-run action is the session-level brake from v5 ②.
  assert.doesNotMatch(panel, /scheduledTask:toggle|scheduledTask:runManually|scheduledTask:stop/);
  // fork 5A: no task uproll — no new run→task aggregation wire in the panel.
  assert.doesNotMatch(panel, /listTasks|longtermTask\.list\(|orchestrationAttempts/);
  // R2/R3 stay Twin-only: no direct reassign/cancel valve and no rerun channel.
  assert.doesNotMatch(panel, /twin_task_/);
});

// ───────────────────────────────────────────────────────────────────────────
// 火花线取数面 (2026-11-23): real message timestamps → 24 buckets.
//
// The old row drew `Array.from({ length: 24 })` of equal 25%-height bars for
// EVERY live session — a container of 24 empty bars, identical for a session
// with 3,000 messages and one with none. These tests pin the replacement:
// bars come from `cowork_messages.created_at`, a session with messages must
// show a non-zero bar, a session without timestamps must show the explicit
// empty state, and no bucket may ever land outside [0, 23].
// ───────────────────────────────────────────────────────────────────────────

test('火花线①: bucket math — exactly 24 slots, nothing out of range, no invented bar', () => {
  // Any payload normalizes to exactly 24 finite non-negative integers.
  for (const payload of [undefined, null, 'nope', [], [1, 2, 3], new Array(40).fill(5)]) {
    const counts = normalizeSparkCounts(payload);
    assert.equal(counts.length, PROCESS_SPARK_BUCKET_COUNT);
    assert.ok(counts.every((value) => Number.isInteger(value) && value >= 0), 'counts are non-negative integers');
  }
  // Junk / negatives / fractions never become a bar.
  assert.deepEqual(normalizeSparkCounts([-3, 2.9, 'x', NaN, Infinity]), [
    0, 2, 0, 0, 0, ...new Array(PROCESS_SPARK_BUCKET_COUNT - 5).fill(0),
  ]);
  // The boundary clamp: the measured DB returns bucket 24 for every session's
  // LAST message (117 of 1389 grouped rows on the live DB). It must fold into
  // the newest slot, never create a 25th bar.
  assert.equal(clampSparkBucketIndex(24), PROCESS_SPARK_BUCKET_COUNT - 1);
  assert.equal(clampSparkBucketIndex(999), PROCESS_SPARK_BUCKET_COUNT - 1);
  assert.equal(clampSparkBucketIndex(-4), 0);
  assert.equal(clampSparkBucketIndex(null), PROCESS_SPARK_BUCKET_COUNT - 1, 'zero span = the newest slot');
  assert.equal(clampSparkBucketIndex(undefined), PROCESS_SPARK_BUCKET_COUNT - 1);
});

test('火花线②: 有 N 条消息必现非零柱；零消息是空态而不是 24 根假柱', () => {
  // N messages in one slot → that slot is the busiest, every other slot 0%.
  const withMessages = { ...emptyProcessSpark(), counts: [...new Array(PROCESS_SPARK_BUCKET_COUNT).fill(0)], total: 7 };
  withMessages.counts[5] = 7;
  assert.equal(sparkHasData(withMessages), true);
  const bars = sparkBarPercents(withMessages);
  assert.equal(bars.length, PROCESS_SPARK_BUCKET_COUNT);
  assert.equal(bars[5], 100, 'the only active slot is the full height');
  assert.equal(bars.filter((percent) => percent > 0).length, 1, 'no other slot grows a bar');
  assert.ok(bars.filter((_, index) => index !== 5).every((percent) => percent === 0), 'empty slots stay 0%');

  // A single message in a slot is still visible (the 15% floor) but never 100
  // unless it is the busiest slot.
  const lopsided = { ...emptyProcessSpark(), counts: new Array(PROCESS_SPARK_BUCKET_COUNT).fill(0), total: 101 };
  lopsided.counts[3] = 1;
  lopsided.counts[9] = 100;
  const lopsidedBars = sparkBarPercents(lopsided);
  assert.equal(lopsidedBars[9], 100);
  assert.equal(lopsidedBars[3], PROCESS_SPARK_MIN_BAR_PERCENT, 'one message still renders above zero');
  assert.ok(lopsidedBars[3] > 0 && lopsidedBars[3] < 100);

  // Zero messages → NO bar at all and the empty state is what the UI gets.
  const empty = emptyProcessSpark();
  assert.equal(sparkHasData(empty), false);
  assert.ok(sparkBarPercents(empty).every((percent) => percent === 0), 'an empty session never paints a bar');
  assert.equal(sparkActiveBuckets(empty), 0);
  assert.equal(sparkActiveBuckets(withMessages), 1);

  // An unreadable IPC payload degrades to the empty reading, not to fake bars.
  const junk = normalizeSparkReading({ counts: 'broken', total: 99, firstMs: 'x' });
  assert.equal(junk.total, 0);
  assert.equal(sparkHasData(junk), false);
});

test('火花线③: the REAL SQL — 24 buckets, the last message never overflows (SQLite fixture)', (t) => {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite'));
  } catch {
    t.skip('node:sqlite unavailable on this runtime');
    return;
  }
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO cowork_messages (id, session_id, created_at) VALUES (?, ?, ?)');
    const HOUR = 3_600_000;
    const BASE = 1_700_000_000_000;
    // 'spread': 100 messages, one per hour → span 99h; the LAST one lands on
    // bucket 24 in raw SQL and MUST clamp to 23.
    for (let index = 0; index < 100; index += 1) {
      insert.run(`spread-${index}`, 'spread', BASE + index * HOUR);
    }
    // 'burst': 5 messages sharing one timestamp → zero span → NULL bucket.
    for (let index = 0; index < 5; index += 1) insert.run(`burst-${index}`, 'burst', BASE + 10);
    // 'single': one message → zero span as well.
    insert.run('single-0', 'single', BASE);

    const ids = normalizeSparkSessionIds(['spread', 'burst', 'single', 'no-messages', 42, '  ']);
    assert.deepEqual(ids, ['spread', 'burst', 'single', 'no-messages'], 'ids are validated + deduped');

    const bounds = buildSparkBoundsQuery(ids);
    const buckets = buildSparkBucketQuery(ids);
    const boundRows = db.prepare(bounds.sql).all(...bounds.params) as any[];
    const bucketRows = db.prepare(buckets.sql).all(...buckets.params) as any[];

    // The raw SQL really does hand back the overflowing index — this is the
    // regression the clamp exists for, asserted rather than assumed.
    assert.ok(
      bucketRows.some((row) => row.bucket === 24),
      'raw SQL produces bucket 24 for the last message (clamp is load-bearing)',
    );
    assert.ok(bucketRows.some((row) => row.bucket === null), 'zero-span sessions come back as NULL');

    const readings = assembleSparkReadings(boundRows, bucketRows, ids);
    assert.deepEqual(Object.keys(readings).sort(), ['burst', 'no-messages', 'single', 'spread']);

    for (const [id, reading] of Object.entries(readings)) {
      assert.equal(reading.counts.length, PROCESS_SPARK_BUCKET_COUNT, `${id}: exactly 24 buckets`);
      assert.equal(
        reading.counts.reduce((sum, value) => sum + value, 0),
        reading.total,
        `${id}: the tooltip total equals what the bars carry`,
      );
    }

    assert.equal(readings.spread.total, 100);
    assert.equal(readings.spread.counts[0], 5);
    assert.equal(readings.spread.counts[PROCESS_SPARK_BUCKET_COUNT - 1], 5, 'the clamped last message lands in slot 23');
    assert.equal(sparkActiveBuckets(readings.spread), PROCESS_SPARK_BUCKET_COUNT, 'a steady session fills every slot');

    assert.equal(readings.burst.counts[PROCESS_SPARK_BUCKET_COUNT - 1], 5, 'zero span → newest slot');
    assert.equal(sparkActiveBuckets(readings.burst), 1);
    assert.equal(readings.single.counts[PROCESS_SPARK_BUCKET_COUNT - 1], 1);
    assert.equal(readings.single.total, 1);

    // A session with no message rows is the EMPTY reading — not 24 bars.
    assert.deepEqual(readings['no-messages'], emptyProcessSpark());
    assert.equal(sparkHasData(readings['no-messages']), false);
  } finally {
    db.close();
  }
});

test('火花线④: one thin channel — preload → main → allowlist → contract', () => {
  const preload = readSource('src/main/preload.ts');
  assert.match(
    preload,
    /activitySpark: \(options: \{ sessionIds: string\[\] \}\) =>\s*\n\s*ipcRenderer\.invoke\('cowork:session:activitySpark', options\)/,
    'preload exposes the spark read on its own channel',
  );
  const main = readSource('src/main/main.ts');
  assert.match(
    main,
    /registerIpcHandler\('cowork:session:activitySpark'[\s\S]{0,400}listSessionActivitySpark\(/,
    'main registers the handler and delegates to the store',
  );
  assert.match(
    main,
    /registerIpcHandler\('cowork:session:activitySpark'[\s\S]{0,600}getStore\(\)\.getReadWorker\(\)/,
    'the read goes through the shared sqlite read worker (no new infrastructure)',
  );
  // The store owns the SQL; the channel stays thin.
  const store = readSource('src/main/coworkStore.ts');
  assert.match(store, /async listSessionActivitySpark\(/, 'store method exists');
  assert.match(store, /buildSparkBucketQuery\(sessionIds\)/, 'store runs the shared bucket SQL');
  // Mobile gateway tier: an untiered invoke channel warns (and would be dark).
  const allowlist = readSource('src/main/gateway/allowlist.ts');
  assert.match(allowlist, /'cowork:session:activitySpark': \{ tier: 'P1' \}/);
  // Contract is generated, so assert the generated artifact carries it too.
  const contract = JSON.parse(readSource('src/mobile/generated/ipc-contract.json')) as {
    methods: Array<{ path: string; channel: string }>;
  };
  assert.ok(
    contract.methods.some((method) => method.channel === 'cowork:session:activitySpark'),
    'ipc-contract.json carries the new channel',
  );
});

test('火花线⑤: both surfaces render the real reading; the 24-bar stub is gone', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  assert.doesNotMatch(panel, /Array\.from\(\{ length: 24 \}/, 'the equal-height stub is removed');
  assert.doesNotMatch(panel, /height: '25%'/, 'no fabricated bar height remains');
  assert.match(panel, /<ProcessSparkline\b[\s\S]{0,200}testId="process-row-spark"/, 'the row uses the shared renderer');
  assert.match(panel, /spark=\{sessionSparks\[entry\.session\.id\] \?\? null\}/, 'the row receives the fetched reading');
  assert.match(panel, /cowork\?\.activitySpark/, 'the panel reads the new channel');
  // The DEFAULT landing (动态) paints ProcessLiveRow, not ProcessRunRow — the
  // strip must be wired there too, or the owner never sees it on first open.
  assert.match(panel, /testId="process-live-spark"/, 'the 动态 live row carries the strip');
  assert.match(
    panel,
    /action=\{liveActionLines\[entry\.session\.id\]\}[\s\S]{0,200}spark=\{sessionSparks\[entry\.session\.id\] \?\? null\}/,
    '…fed by the same batched read',
  );
  // A row with nothing to show draws no container at all.
  assert.match(panel, /statusKind === 'live' \|\| sparkHasData\(spark\)/);

  const detail = readSource('src/renderer/components/cowork/CoworkSessionDetail.tsx');
  assert.match(detail, /<ProcessSparkPanel\b/, 'the dossier mounts the spark panel');
  assert.match(detail, /sessionId=\{currentSession\.id\}/, '…for the session being read');

  const sparkline = readSource('src/renderer/components/cowork/ProcessSparkline.tsx');
  assert.match(sparkline, /data-testid=\{testId\}/, 'bars carry a stable test hook');
  assert.match(sparkline, /data-testid=\{`\$\{testId\}-bar`\}/, 'each bar is individually addressable');
  assert.match(sparkline, /data-spark-empty="true"/, 'the empty state is explicit in the DOM');
  assert.match(sparkline, /height: percent > 0 \? `\$\{percent\}%` : 0/, 'a zero slot renders no height');

  // i18n: both languages carry every key this surface uses.
  const i18n = readSource('src/renderer/services/i18n.ts');
  for (const key of ['processSparkTitle', 'processSparkEmpty', 'processSparkEmptyHint', 'processSparkLabel', 'processSparkSummary']) {
    const occurrences = (i18n.match(new RegExp(`\\n\\s+${key}:`, 'g')) ?? []).length;
    assert.equal(occurrences, 2, `${key} exists in both zh and en`);
  }
});

test('火花线⑥ 批 A P0-1: the tooltip names the DISTRIBUTION, never liveness', () => {
  const i18n = readSource('src/renderer/services/i18n.ts');
  const lines = i18n.split('\n');
  const valueOf = (key: string): string[] => lines
    .filter((line) => line.trimStart().startsWith(`${key}:`))
    .map((line) => line);

  const titles = valueOf('processSparkTitle');
  assert.equal(titles.length, 2, 'one title per language');
  // zh: names the quantity (会话消息分布), the 24-bucket rule and the span rule
  // (首条→末条 — the strip is the session's OWN span, not a rolling clock window).
  assert.match(titles[0], /会话消息分布/);
  assert.match(titles[0], /\{buckets\} 桶/);
  assert.match(titles[0], /首条→末条/);
  assert.match(titles[0], /共 \{count\} 条/);
  assert.match(titles[0], /\{active\} 桶有活动/);
  assert.match(titles[1], /Session message distribution/);
  assert.match(titles[1], /\{buckets\} equal buckets, first → last message/);

  // The strip answers ONE question now: the dot owns "is it alive".
  for (const line of titles) {
    assert.doesNotMatch(line, /正在运行/, 'the strip title must not claim liveness (zh)');
    assert.doesNotMatch(line, /running/i, 'the strip title must not claim liveness (en)');
  }

  // Empty state, same rule: it says "no timestamps", never "running"/"idle".
  const emptyTitles = valueOf('processSparkEmpty');
  assert.equal(emptyTitles.length, 2);
  assert.match(emptyTitles[0], /无消息时间戳/);
  assert.match(emptyTitles[1], /No message timestamps/);
  for (const line of [...emptyTitles, ...valueOf('processSparkEmptyHint')]) {
    assert.doesNotMatch(line, /正在运行|running/i, 'the empty tooltip must not claim liveness either');
  }
  // …and the empty hint says out loud that an empty slot is not "no activity".
  assert.match(valueOf('processSparkEmptyHint')[0], /不表示没活动/);

  // The component spends those keys — the semantics live in one place, not in
  // a hard-coded string beside the bars.
  const sparkline = readSource('src/renderer/components/cowork/ProcessSparkline.tsx');
  assert.match(sparkline, /title=\{t\('processSparkTitle'\)/);
  assert.match(sparkline, /title=\{`\$\{emptyLabel\} — \$\{t\('processSparkEmptyHint'\)\}`\}/);
});

test('批 A P1-4: ONE count unit — runs — on the tabs, the section headings and the rail', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  const nav = readSource('src/renderer/components/sidebar/sidebarNavigation.js');
  const rail = readSource('src/renderer/components/layout/WorkspaceRail.tsx');

  // ① 三区页签: dynamic = running runs, a zone = its RUN count. The old unit was
  // the tree node count, which shifts with the fold heuristic (one group node
  // vs its N runs) — the same content reading two numbers.
  assert.match(
    panel,
    /key === 'autonomous'\s*\n\s*\? countAutonomousRuns\(autonomousModel, automationEntries\.length\)/,
    'tab badge unit = runs',
  );
  assert.doesNotMatch(
    panel,
    /const count = key === 'dynamic' \? dynamic\.running\.length : zones\[key\]\.nodes\.length;/,
    'the node-count unit is retired',
  );
  // The model already owned the run count — no new math, no new channel.
  const utils = readSource('src/renderer/utils/processCenter.ts');
  assert.match(utils, /orch: \{ zone: 'orch', nodes: buildProcessTree\(buckets\.orch\), runCount: buckets\.orch\.length \}/);
  assert.match(utils, /runCount: buckets\.scheduled\.length/);
  assert.match(utils, /runCount: buckets\.longterm\.length/);

  // ② 动态区: the 正在运行 header counts runs, and now says so in the DOM.
  assert.match(panel, /data-testid="process-live-heading-count" data-count-unit="runs"/);
  assert.match(panel, /processLiveSection'\)[\s\S]{0,80}data-testid="process-live-heading-count"[\s\S]{0,80}dynamic\.running\.length/);

  // ③ A zone's own heading must read the SAME number its tab shows.
  assert.match(panel, /data-testid="process-zone-heading"[\s\S]{0,200}data-count-unit="runs"/);
  assert.match(panel, /ZONE_LABEL_KEY\[zoneModel\.zone\]\)\} · \{zoneModel\.runCount\}/);
  assert.doesNotMatch(panel, /ZONE_LABEL_KEY\[zoneModel\.zone\]\)\} · \{zoneModel\.nodes\.length\}/);

  // Tab badges carry the unit explicitly, so a reader (or a probe) never has to
  // guess which of the three numbers it is looking at.
  assert.match(panel, /data-testid="process-tab-count"[\s\S]{0,120}data-count-unit="runs"/);

  // ④ rail: the 待你拍板 badge counts RUNS — and it now reaches BOTH faces.
  // (Before batch A the home face computed the count and dropped it, so the two
  // faces disagreed: one had a number, the other had none.)
  const home = nav.slice(nav.indexOf('export function getRailHomeNavModel'), nav.indexOf('export function getHomeSectionModel'));
  const internet = nav.slice(nav.indexOf('export function getRailInternetNavModel'), nav.indexOf('export function getRailHomeNavModel'));
  for (const [face, block] of [['internet', internet], ['home', home]] as const) {
    assert.match(block, /badgeCount: \w+ > 0 \? \w+ : undefined/, `${face}: the processes entry carries the count`);
    assert.match(block, /indicatorLabel: [\s\S]{0,120}t\('processCenterAwaitingBadge'\)\.replace\('\{count\}', String\(\w+\)\)/, `${face}: the label names the count`);
  }
  // The badge element declares the unit it renders. Since the 通知中心/进程中心
  // alignment (2026-11-24 00:38) the RailButton carries that unit as its
  // `countUnit` prop — 进程 = runs (the default, unchanged), 通知 = unread — so
  // the literal "runs" now lives in the destructuring default.
  assert.match(rail, /data-rail-badge-count=\{badgeCount\}[\s\S]{0,80}data-count-unit=\{countUnit\}/);
  assert.match(rail, /countUnit = 'runs',/);
  // …and the 进程 entry never overrides it: only the notification bell does.
  const processesMount = rail.slice(rail.indexOf('{processesItem ? ('), rail.indexOf('renderRailIcon(processesItem.icon)'));
  assert.ok(processesMount.length > 0, 'the 进程 mount is found');
  assert.doesNotMatch(processesMount, /countUnit=/, 'the 进程 entry keeps the runs unit');
  // Same source of truth as the panel (the awaiting bucket of the SAME model).
  assert.match(rail, /countAwaitingProcesses\(\s*\n?\s*splitProcessHub\(coworkSessions, decisionSessionIds, Date\.now\(\), undefined, lineageOverrides\),\s*\n?\s*\)/);

  // ⑤ The ONE number on that screen that stays a node count is the pagination
  // affordance ("显示更多（剩余 N）"): clicking it appends ROWS, and a collapsed
  // group row is one row for N runs. Documented here so the next reader does not
  // "fix" it into runs and make the budget lie.
  assert.match(panel, /i18nService\.t\('processShowMore'\)\.replace\('\{count\}', String\(zoneModel\.nodes\.length - nodes\.length\)\)/);
});
