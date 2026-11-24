// 浮窗化 · 第 2-3 步 (owner approval 2026-11-24 17:23; M1=B / M2=A / M3=A / M4=A).
//
// This suite pins the two halves that the shell + the three entries changed:
//
//   A. the PURE model — 自主 (定时 + 长期 + 做梦/冲浪), the STRICT 编排 filter with
//      the N6 read-time prefix fallback, the 人开会话 fallback strip, the per-face
//      floatwin view state, and the single-seat floatwin registry;
//   B. the WIRING — the 900×80vh shell's geometry/exit rules, the rail entry
//      becoming a control, mutual exclusion with Settings, and the automation
//      run projection (dream/surf) that reuses the run language.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PROCESS_HUB_VIEW_STATE,
  PROCESS_HUB_TAB_ORDER,
  PROCESS_HUB_TAB_LABEL_KEY,
  PROCESS_AUTONOMOUS_SOURCE_ORDER,
  PROCESS_AUTONOMOUS_SOURCE_LABEL_KEY,
  autonomousChipCounts,
  buildOrchestrationZone,
  buildProcessAutonomous,
  buildUnassignedHumanEntries,
  countAutonomousRuns,
  effectiveAutoOriginOf,
  isOrchestrationProcess,
  processFloatwinStateOf,
  splitProcessHub,
  type ProcessEntry,
} from '../src/renderer/utils/processCenter';
import {
  announceFloatwinOpen,
  subscribeFloatwinYield,
  __resetFloatwinRegistryForTests,
} from '../src/renderer/utils/floatwinRegistry';
import {
  automationEntriesFor,
  automationRunCounts,
  buildAutomationEntries,
  projectDreamRun,
  projectSurfRun,
} from '../src/renderer/utils/processAutomation';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const NOW = 1_700_000_000_000;

const mkSession = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 's',
  title: 'Task',
  status: 'completed',
  updatedAt: NOW,
  createdAt: NOW - 1000,
  autoOrigin: null,
  foldOverride: null,
  followUpState: null,
  metabotName: 'Bot',
  metabotAvatar: null,
  ...over,
});

const entryOf = (session: Record<string, unknown>): ProcessEntry => ({
  session: session as ProcessEntry['session'],
  kind: 'build',
  state: 'idle',
  statusKind: 'dead',
  error: false,
  stalePending: false,
  awaitingVerdict: false,
});

/* ═════════════ A. 三入口的数据判据 ═════════════ */

test('v6: the three entries are 动态 / 自主 / 编排 — in that order, one unit each', () => {
  assert.deepEqual([...PROCESS_HUB_TAB_ORDER], ['dynamic', 'autonomous', 'orch']);
  assert.equal(PROCESS_HUB_TAB_LABEL_KEY.dynamic, 'processTabDynamic');
  assert.equal(PROCESS_HUB_TAB_LABEL_KEY.autonomous, 'processTabAutonomous');
  assert.equal(PROCESS_HUB_TAB_LABEL_KEY.orch, 'processZoneOrch');
});

test('v6 自主: 定时 + 长期 split into their own buckets, newest-first', () => {
  const entries = [
    entryOf(mkSession({ id: 'a', autoOrigin: 'schedule', updatedAt: NOW - 10 })),
    entryOf(mkSession({ id: 'b', autoOrigin: 'longterm', updatedAt: NOW - 5 })),
    entryOf(mkSession({ id: 'c', autoOrigin: 'schedule', updatedAt: NOW - 1 })),
    entryOf(mkSession({ id: 'd', autoOrigin: 'orchestration', updatedAt: NOW - 2 })),
  ];
  const model = buildProcessAutonomous(entries);
  assert.deepEqual(model.scheduled.map((entry) => entry.session.id), ['c', 'a']);
  assert.deepEqual(model.longterm.map((entry) => entry.session.id), ['b']);
  assert.equal(model.totalRuns, 3, '定时 + 长期 only — orchestration is NOT 自主');
});

test('v6 自主: the badge = 定时 + 长期 + 做梦/冲浪 runs, and the chips carry subtotals', () => {
  const model = buildProcessAutonomous([
    entryOf(mkSession({ id: 'a', autoOrigin: 'schedule' })),
    entryOf(mkSession({ id: 'b', autoOrigin: 'longterm' })),
  ]);
  assert.equal(countAutonomousRuns(model, 5), 7);
  const chips = autonomousChipCounts(model, { dream: 2, surf: 3 });
  assert.deepEqual(chips, { all: 7, scheduled: 1, longterm: 1, dream: 2, surf: 3 });
  assert.deepEqual([...PROCESS_AUTONOMOUS_SOURCE_ORDER], ['scheduled', 'longterm', 'dream', 'surf']);
  for (const source of PROCESS_AUTONOMOUS_SOURCE_ORDER) {
    assert.ok(PROCESS_AUTONOMOUS_SOURCE_LABEL_KEY[source], `${source} has a label key`);
  }
});

test('v6 编排: STRICTLY autoOrigin=orchestration — a human row never lands there', () => {
  const human = entryOf(mkSession({ id: 'h', autoOrigin: null, title: 'A chat' }));
  const orch = entryOf(mkSession({ id: 'o', autoOrigin: 'orchestration', title: '[编排任务] X' }));
  const scheduled = entryOf(mkSession({ id: 's', autoOrigin: 'schedule' }));
  const zone = buildOrchestrationZone([human, orch, scheduled]);
  assert.equal(zone.runCount, 1);
  assert.deepEqual(zone.nodes.flatMap((node) => node.children.map((child) => child.session.id)), ['o']);
});

test('N6: a NULL-origin row with the orchestration prefix is backfilled AT READ TIME', () => {
  assert.equal(effectiveAutoOriginOf({ autoOrigin: null, title: '[编排任务] Worker Alpha' } as any), 'orchestration');
  assert.equal(effectiveAutoOriginOf({ autoOrigin: null, title: '[督办] long-term board' } as any), 'orchestration');
  assert.equal(effectiveAutoOriginOf({ autoOrigin: null, title: 'A human chat' } as any), null);
  assert.equal(effectiveAutoOriginOf({ autoOrigin: 'schedule', title: '[编排任务] X' } as any), 'schedule',
    'a stored origin always wins over the title');
  assert.equal(isOrchestrationProcess({ autoOrigin: null, title: '[编排任务] Y' } as any), true);
  // No DB write is involved: the model is pure and the function has no side effect.
  const model = readSource('src/renderer/utils/processCenter.ts');
  assert.match(model, /The judgment is READ-TIME only \(no DB backfill\)/);
  assert.doesNotMatch(model, /UPDATE cowork_sessions/);
});

test('v6 M4=A 兜底: 人开的 process rows are collected for the dynamic page strip', () => {
  const human = entryOf(mkSession({ id: 'h', autoOrigin: null, title: 'Human work' }));
  const prefixed = entryOf(mkSession({ id: 'p', autoOrigin: null, title: '[编排任务] legacy' }));
  const bot = entryOf(mkSession({ id: 'b', autoOrigin: 'schedule' }));
  assert.deepEqual(
    buildUnassignedHumanEntries([human, prefixed, bot]).map((entry) => entry.session.id),
    ['h'],
    'only rows that are genuinely unattributed stay in the strip',
  );
});

test('v6: splitProcessHub still owns membership — the three entries read ONE split', () => {
  const sessions = [
    mkSession({ id: 'live', autoOrigin: 'schedule', status: 'running', updatedAt: NOW }),
    mkSession({ id: 'human', autoOrigin: null, status: 'completed', foldOverride: 'in' }),
    mkSession({ id: 'pending', autoOrigin: 'longterm', followUpState: 'pending' }),
  ] as any;
  const model = splitProcessHub(sessions, undefined, NOW, undefined, { pending: 'human' });
  assert.deepEqual(model.running.map((entry) => entry.session.id).sort(), ['human', 'live']);
  assert.deepEqual(model.awaiting.map((entry) => entry.session.id), ['pending']);
  // The three entries are views over `model.running`, so a row can never be
  // both 自主 and 编排 — the split happens once, above them.
  assert.equal(buildProcessAutonomous(model.running).totalRuns, 1);
  assert.equal(buildOrchestrationZone(model.running).runCount, 0);
  assert.deepEqual(buildUnassignedHumanEntries(model.running).map((entry) => entry.session.id), ['human']);
});

/* ═════════════ N4 浮窗状态（按面持久化） ═════════════ */

test('N4: the view state grows a floatwin slice, and old refs degrade safely', () => {
  assert.deepEqual(DEFAULT_PROCESS_HUB_VIEW_STATE.floatwin, { open: false, lastSessionId: null });
  assert.deepEqual(processFloatwinStateOf(undefined), { open: false, lastSessionId: null });
  assert.deepEqual(processFloatwinStateOf({}), { open: false, lastSessionId: null });
  assert.deepEqual(
    processFloatwinStateOf({ floatwin: { open: true, lastSessionId: ' s-1 ' } }),
    { open: true, lastSessionId: 's-1' },
  );
  assert.deepEqual(processFloatwinStateOf({ floatwin: { open: 'yes', lastSessionId: 4 } as any }),
    { open: false, lastSessionId: null });
});

/* ═════════════ 浮窗单席注册表（让位） ═════════════ */

test('floatwin registry: opening another floatwin yields; the same id does not', () => {
  __resetFloatwinRegistryForTests();
  let yields = 0;
  const unsubscribe = subscribeFloatwinYield('process-center', () => { yields += 1; });
  announceFloatwinOpen('process-center');
  assert.equal(yields, 0, 're-announcing itself is not a yield');
  announceFloatwinOpen('settings');
  assert.equal(yields, 1, 'Settings opening closes the hub');
  unsubscribe();
  announceFloatwinOpen('settings');
  assert.equal(yields, 1, 'an unsubscribed floatwin is never called again');
  __resetFloatwinRegistryForTests();
});

/* ═════════════ B. 浮窗壳的硬约束 ═════════════ */

test('shell: 900×80vh, v2 token radius, shadow-modal, scale-in — and the backdrop does NOT close', () => {
  const shell = readSource('src/renderer/components/cowork/ProcessCenterFloatwin.tsx');
  assert.match(shell, /fixed inset-0 z-50 modal-backdrop flex items-center justify-center/);
  assert.match(shell, /h-\[80vh\] w-\[900px\]/);
  assert.match(shell, /rounded-\[var\(--shape-radius-md\)\]/, 'M1=B: the radius is a v2 token, not 16px');
  assert.doesNotMatch(shell, /className="[^"]*rounded-2xl/, 'Settings\' 16px is deliberately NOT copied');
  assert.match(shell, /shadow-modal/);
  assert.match(shell, /modal-content/);
  // The exit rules: Esc + the explicit button + yield. Backdrop click does nothing.
  assert.match(shell, /if \(event\.key === 'Escape'\)/);
  assert.match(shell, /subscribeFloatwinYield\('process-center', onClose\)/);
  assert.doesNotMatch(shell, /onClick=\{onClose\}/, 'backdrop click must not close (M1=B)');
  assert.match(shell, /data-floatwin-backdrop-close="false"/);
});

test('shell: the top-right close button lives in the header, gated on the floatwin mount', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  assert.match(panel, /onRequestClose\?: \(\) => void;/);
  assert.match(panel, /data-testid="process-floatwin-close"/);
  assert.match(panel, /aria-label=\{i18nService\.t\('processFloatwinClose'\)\}/);
  assert.match(panel, /\{onRequestClose \? \(/);
});

test('App: the rail entry opens the floatwin on BOTH faces; settings and the hub yield to each other', () => {
  const app = readSource('src/renderer/App.tsx');
  // Both rail callbacks intercept 'processes' and never switch the pane.
  const intercepts = app.match(/if \(pane === 'processes'\) \{\s*\n\s*openProcessFloatwin\('(?:home|browser)'\);\s*\n\s*return;/g) ?? [];
  assert.equal(intercepts.length, 2, 'both faces intercept the rail click');
  assert.match(app, /if \(section === 'processes'\) \{\s*\n\s*openProcessFloatwin\('home'\);/);
  assert.doesNotMatch(app, /setMainView\('processes'\)/, 'no path turns the hub back into a pane');
  // Mutual exclusion + overlay semantics.
  assert.match(app, /announceFloatwinOpen\('settings'\);/);
  assert.match(app, /announceFloatwinOpen\('process-center'\);/);
  assert.match(app, /const isOverlayActive = showSettings \|\| processFloatwinOpen \|\| showUpdateModal/);
  // A stale persisted destination converts into the floatwin exactly once.
  assert.match(app, /if \(botBrowserShell\.internetPane === 'processes'\) \{[\s\S]{0,200}openProcessFloatwin\('browser'\)/);
  // Per-face persistence (N4): one ref each, restored on a face switch.
  assert.match(app, /processHubViewRefHome/);
  assert.match(app, /processHubViewRefInternet/);
  assert.match(app, /setProcessFloatwinOpen\(processFloatwinStateOf\(processHubViewRefFor\(face\)\.current\)\.open\)/);
  // Stepping into a process is the overlay's exit.
  const opener = app.slice(app.indexOf('const openProcessReadOnly'), app.indexOf('const handleBackToProcessHub'));
  assert.match(opener, /setProcessFloatwinOpen\(false\)/);
  assert.match(opener, /lastSessionId: sessionId/);
});

test('rail: the entry reads ACTIVE from the floatwin, on both faces', () => {
  const rail = readSource('src/renderer/components/layout/WorkspaceRail.tsx');
  assert.match(rail, /active=\{processCenterActive \|\| \(mode === 'browser' && internetPane === 'processes'\)\}/);
});

/* ═════════════ 做梦 / 冲浪 的一等展示（复用 run 语义） ═════════════ */

test('automation: dream/surf runs project onto the SAME status language', () => {
  const dreamLive = projectDreamRun({ id: 'd1', metabotId: 1, dreamDate: '2026-11-24', status: 'running', startedAt: NOW });
  assert.equal(dreamLive.statusKind, 'live');
  assert.equal(dreamLive.error, false);
  assert.equal(dreamLive.detail, '2026-11-24');
  const dreamFailed = projectDreamRun({ id: 'd2', metabotId: 1, dreamDate: '2026-11-23', status: 'terminal-failed', error: 'x', startedAt: NOW - 1 });
  assert.equal(dreamFailed.statusKind, 'dead');
  assert.equal(dreamFailed.error, true);
  const surfLive = projectSurfRun({ id: 'r1', metabotId: 2, trigger: 'pre-dream', status: 'running', startedAt: new Date(NOW).toISOString() });
  assert.equal(surfLive.statusKind, 'live');
  assert.equal(surfLive.detail, 'pre-dream');
  const surfDone = projectSurfRun({ id: 'r2', metabotId: 2, trigger: 'manual-ui', status: 'done', startedAt: new Date(NOW - 5).toISOString(), finishedAt: new Date(NOW).toISOString() });
  assert.equal(surfDone.statusKind, 'dead');
  assert.equal(surfDone.error, false);
});

test('automation: merged order = live first then newest; chip filter and counts follow', () => {
  const entries = buildAutomationEntries(
    [{ id: 'd-old', metabotId: 1, dreamDate: '2026-11-22', status: 'completed', startedAt: NOW - 100 }],
    [
      { id: 'r-live', metabotId: 1, trigger: 'pre-dream', status: 'running', startedAt: new Date(NOW).toISOString() },
      { id: 'r-new', metabotId: 2, trigger: 'manual-ui', status: 'done', startedAt: new Date(NOW - 10).toISOString() },
    ],
  );
  assert.deepEqual(entries.map((entry) => entry.key), ['surf:r-live', 'surf:r-new', 'dream:d-old']);
  assert.deepEqual(automationRunCounts(entries), { dream: 1, surf: 2 });
  assert.deepEqual(automationEntriesFor(entries, 'dream').map((entry) => entry.key), ['dream:d-old']);
  assert.equal(automationEntriesFor(entries, null).length, 3);
});

test('panel: the 自主 tab renders dream/surf rows with the run language and no valve', () => {
  const panel = readSource('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  assert.match(panel, /data-testid="process-automation-row"/);
  assert.match(panel, /data-automation-source=\{entry\.source\}/);
  assert.match(panel, /data-testid="process-autonomous-automation"/);
  // No new channel: the two existing read IPC are used.
  assert.match(panel, /window\.electron\?\.dream\?\.listRuns\?\.\(\{ metabotId, limit: AUTOMATION_READ_PER_BOT \}\)/);
  assert.match(panel, /window\.electron\?\.surf\?\.listRuns\?\.\(metabotId, AUTOMATION_READ_PER_BOT\)/);
  const row = panel.slice(panel.indexOf('const ProcessAutomationRow'), panel.indexOf('const ProcessRunRow'));
  assert.doesNotMatch(row, /process-row-valve/, 'a dream/surf run has no archive/remove valve');
  assert.match(row, /w-\[86px\] flex-shrink-0 items-center justify-end/, 'bot signature uses the same 86px lane');
});

/* ═════════════ i18n 两语齐 ═════════════ */

test('i18n: every new key exists in BOTH languages', () => {
  const i18n = readSource('src/renderer/services/i18n.ts');
  const zh = i18n.slice(0, i18n.indexOf('  en: {'));
  const en = i18n.slice(i18n.indexOf('  en: {'));
  for (const key of [
    'processTabAutonomous',
    'processSourceAll',
    'processSourceScheduled',
    'processSourceLongterm',
    'processSourceDream',
    'processSourceSurf',
    'processAutomationSection',
    'processAutonomousEmpty',
    'processUnassignedHumans',
    'processFloatwinClose',
    'processRowDecideHint',
  ]) {
    assert.ok(zh.includes(`${key}:`), `zh has ${key}`);
    assert.ok(en.includes(`${key}:`), `en has ${key}`);
  }
});
