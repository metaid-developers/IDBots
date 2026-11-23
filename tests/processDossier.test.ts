// 进程详情 · 档案层 (design: process-detail-body-redesign, Friday 2026-11-22;
// owner ruling 2026-11-22 22:46: 1A / 2A / 3A / 4A).
//
// Two halves, and both are pinned here:
//   1. the PURE model — check-state derivation, round folding, anchor
//      classification and pin-id extraction. These are the parts that can be
//      WRONG (a row that claims a verdict it never got, a round that loses its
//      endpoint, a truncated id on the clipboard).
//   2. the WIRING — the tab template, the default layer, the three data-gap
//      channels (N1/N2/N3) and the N4 field. A green model over an unwired
//      panel would be a design that never shipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOSSIER_ROUND_FOLD_LIMIT,
  anchorClassOf,
  buildAnchorRows,
  buildCheckModel,
  buildDossierRounds,
  dossierCheckStateOf,
  dossierTierOf,
  foldRoundProgress,
  formatDossierStamp,
  pinIdOf,
  workerIdOfActor,
} from '../src/renderer/utils/processDossier';
import type { LongTermEvent, LongTermSubtask } from '../src/renderer/types/longTermTask';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const mkSubtask = (patch: Partial<LongTermSubtask> = {}): LongTermSubtask => ({
  id: 'lts_1',
  taskId: 'ltt_1',
  ordinal: 1,
  title: '子项目一',
  description: '',
  acceptanceCriteria: ['标准 A', '标准 B', '标准 C'],
  status: 'in_progress',
  dependsOn: [],
  preferredChannel: 'delegate_bot',
  evidence: [],
  sessionId: 'sess-1',
  sessionHistory: [],
  waitNote: '',
  waitUntil: null,
  notes: '',
  expectedMinutes: null,
  metataskRoot: null,
  acceptedBy: null,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:00:00.000Z',
  acceptedAt: null,
  ...patch,
});

let eventId = 0;
const mkEvent = (patch: Partial<LongTermEvent>): LongTermEvent => ({
  id: ++eventId,
  taskId: 'ltt_1',
  subtaskId: 'lts_1',
  kind: 'progress',
  actor: 'twin',
  detail: '',
  createdAt: '2026-11-22T10:00:00.000Z',
  ...patch,
});

// ── 1. 验收清单 ────────────────────────────────────────────────────────────

test('check states: 7 stored statuses fold to 6, and pending/in_progress are the same 未验', () => {
  assert.equal(dossierCheckStateOf('accepted'), 'passed');
  assert.equal(dossierCheckStateOf('waiting_owner'), 'awaiting');
  assert.equal(dossierCheckStateOf('rejected'), 'rejected');
  assert.equal(dossierCheckStateOf('skipped'), 'skipped');
  assert.equal(dossierCheckStateOf('waiting_external'), 'external');
  assert.equal(dossierCheckStateOf('pending'), 'unverified');
  assert.equal(dossierCheckStateOf('in_progress'), 'unverified');
});

test('2A: without a criterionIndex every row inherits the卷 state and is marked inferred', () => {
  const model = buildCheckModel(mkSubtask({
    status: 'accepted',
    evidence: [{ kind: 'pin', uri: 'pin://a'.padEnd(72, '0') }],
  }));
  assert.equal(model.total, 3);
  assert.equal(model.passed, 3);
  assert.equal(model.inferred, true);
  assert.ok(model.rows.every((row) => row.inferred && row.anchors === 0));

  // No evidence at all → nothing is claimed as inferred evidence; the empty
  // boxes still carry the卷 state.
  const bare = buildCheckModel(mkSubtask({ status: 'in_progress' }));
  assert.equal(bare.inferred, false);
  assert.ok(bare.rows.every((row) => row.state === 'unverified' && row.inferred));
});

test('2A forward path: a criterionIndex names its row and clears the ≈ mark there only', () => {
  const model = buildCheckModel(mkSubtask({
    status: 'accepted',
    evidence: [
      { kind: 'pin', uri: 'pin://x', criterionIndex: 1 },
      { kind: 'pin', uri: 'pin://y', criterionIndex: 1 },
    ],
  }));
  assert.equal(model.rows[1].anchors, 2);
  assert.equal(model.rows[1].inferred, false);
  assert.equal(model.rows[0].inferred, true);
  assert.equal(model.rows[2].inferred, true);
  assert.equal(model.inferred, true, 'other rows are still inferred');

  // An out-of-range or non-integer index must be ignored, not clamped onto a row.
  const junk = buildCheckModel(mkSubtask({
    status: 'accepted',
    evidence: [
      { kind: 'pin', uri: 'pin://x', criterionIndex: 9 },
      { kind: 'pin', uri: 'pin://y', criterionIndex: 1.5 as unknown as number },
    ],
  }));
  assert.ok(junk.rows.every((row) => row.anchors === 0));
});

test('an empty checklist is total 0 — never a fabricated row', () => {
  const model = buildCheckModel(mkSubtask({ acceptanceCriteria: [] }));
  assert.deepEqual(model, { rows: [], passed: 0, total: 0, inferred: false });
  assert.deepEqual(buildCheckModel(null), { rows: [], passed: 0, total: 0, inferred: false });
});

// ── 2. 执行轮次 ────────────────────────────────────────────────────────────

test('3A: a round needs an endpoint — began → submitted → accepted is ONE round with 已验', () => {
  const rounds = buildDossierRounds([
    mkEvent({ kind: 'began', actor: 'twin', detail: '开始第一棒', createdAt: '2026-11-22T10:00:00.000Z' }),
    mkEvent({ kind: 'submitted', actor: 'worker:4', detail: '交付 11 文件', createdAt: '2026-11-22T11:00:00.000Z' }),
    mkEvent({ kind: 'accepted', actor: 'twin', detail: '复核通过', createdAt: '2026-11-22T12:00:00.000Z' }),
  ]);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].verdict, 'accepted');
  assert.equal(rounds[0].what, '复核通过', 'the verdict detail is the row text');
  assert.equal(rounds[0].startedAt, '2026-11-22T10:00:00.000Z');
  assert.equal(rounds[0].endedAt, '2026-11-22T12:00:00.000Z');
});

test('a second began inside an open round is progress, never a second round', () => {
  const rounds = buildDossierRounds([
    mkEvent({ kind: 'began', detail: '开始', createdAt: '2026-11-22T10:00:00.000Z' }),
    mkEvent({ kind: 'began', detail: '租约续期', createdAt: '2026-11-22T10:30:00.000Z' }),
    mkEvent({ kind: 'assigned', detail: '改派', createdAt: '2026-11-22T10:40:00.000Z' }),
  ]);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].verdict, 'running');
  assert.deepEqual(rounds[0].progress, ['租约续期', '改派']);
});

test('a verdict that arrives without its opening event still yields a round', () => {
  const rounds = buildDossierRounds([
    mkEvent({ kind: 'accepted', detail: '直接验收', createdAt: '2026-11-22T12:00:00.000Z' }),
    mkEvent({ kind: 'rejected', detail: '打回', createdAt: '2026-11-22T13:00:00.000Z' }),
  ]);
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds.map((round) => round.verdict), ['rejected', 'accepted'], 'newest first');
});

test('task-level events never become a round; the l2 chips ride along', () => {
  const rounds = buildDossierRounds(
    [
      mkEvent({ subtaskId: null, kind: 'created', detail: '任务创建' }),
      mkEvent({ subtaskId: null, kind: 'completed', detail: '任务完成' }),
      mkEvent({ kind: 'assigned', detail: '派给 Friday' }),
    ],
    new Map([['lts_1', { title: '子项目一', channel: 'delegate_bot' }]]),
  );
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].subtaskTitle, '子项目一');
  assert.equal(rounds[0].channel, 'delegate_bot');
  assert.equal(rounds[0].kind, 'assigned');
});

test('the round row is TWO lines (design §04): l1 who+what, l2 ONE chip line', () => {
  const body = readSource('src/renderer/components/cowork/ProcessDossierBody.tsx');
  // l1 + one nowrap chip line + min-h 32 is the 32/48 equation, not a stack.
  assert.match(body, /className="grid min-h-\[32px\] grid-cols-\[52px_11\.25px_1fr_auto\] items-start gap-x-\[7\.5px\] py-\[5\.625px\]"/);
  assert.match(body, /mt-\[1\.875px\] flex min-w-0 items-center gap-\[5px\] overflow-hidden whitespace-nowrap text-\[11\.25px\]/);
  // Progress is FOLDED, never dumped as a paragraph.
  assert.doesNotMatch(body, /folded\.visible\.map/);
  assert.match(body, /processDossierFoldProgress/);
});

test('rounds sort newest first even when the event window arrives oldest-last', () => {
  const rounds = buildDossierRounds([
    mkEvent({ kind: 'began', detail: '第一轮', createdAt: '2026-11-22T10:00:00.000Z' }),
    mkEvent({ kind: 'accepted', detail: '第一轮验收', createdAt: '2026-11-22T11:00:00.000Z' }),
    mkEvent({ kind: 'began', detail: '第二轮', createdAt: '2026-11-22T12:00:00.000Z' }),
  ]);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].what, '第二轮');
  assert.equal(rounds[0].verdict, 'running');
  assert.equal(rounds[1].verdict, 'accepted');
});

test('progress folding keeps the NEWEST lines and reports the rest', () => {
  assert.deepEqual(foldRoundProgress(['a', 'b', 'c']), { visible: ['a', 'b', 'c'], folded: 0 });
  const folded = foldRoundProgress(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(folded.visible, ['c', 'd', 'e']);
  assert.equal(folded.folded, 2);
  assert.equal(DOSSIER_ROUND_FOLD_LIMIT, 3);
});

test('worker actors resolve to a bot id; everyone else resolves to a role key', () => {
  assert.equal(workerIdOfActor('worker:12'), 12);
  assert.equal(workerIdOfActor('twin'), null);
  assert.equal(workerIdOfActor('owner'), null);
  assert.equal(workerIdOfActor('system'), null);
});

// ── 3. 证据锚 ──────────────────────────────────────────────────────────────

const PIN_A = `${'a'.repeat(64)}i0`;
const PIN_B = `${'b'.repeat(64)}i1`;

test('4A: pinIdOf extracts the FULL 66-char id from every chain scheme and refuses truncation', () => {
  assert.equal(pinIdOf(`pin://${PIN_A}`), PIN_A);
  assert.equal(pinIdOf(`metafile://${PIN_A}`), PIN_A);
  assert.equal(pinIdOf(`metaapp://${PIN_A}`), PIN_A);
  assert.equal(pinIdOf(PIN_A), PIN_A);
  assert.equal(pinIdOf(`pin://${PIN_A.toUpperCase()}`), PIN_A, 'normalized to lowercase');
  assert.equal(pinIdOf(`pin://${PIN_A.slice(0, 8)}…`), null, 'a truncated id is NOT a copyable id');
  assert.equal(pinIdOf('pin://abc'), null);
  assert.equal(pinIdOf('/Users/wufeng/report.md'), null);
  assert.equal(pinIdOf(null), null);
});

test('anchor classes: metafile is a PIN (same on-chain object), dir/url/metaapp map to their own tags', () => {
  assert.equal(anchorClassOf('pin'), 'PIN');
  assert.equal(anchorClassOf('metafile'), 'PIN');
  assert.equal(anchorClassOf('dir'), 'DIR');
  assert.equal(anchorClassOf('url'), 'URL');
  assert.equal(anchorClassOf('metaapp'), 'APP');
  assert.equal(anchorClassOf('file'), 'FILE');
  assert.equal(anchorClassOf('something-new'), 'OTHER');
});

test('anchor rows merge evidence + artifacts, de-duplicate, and never invent a sha256', () => {
  const rows = buildAnchorRows(
    [
      { kind: 'pin', uri: `pin://${PIN_A}`, note: '设计稿' },
      { kind: 'pin', uri: `pin://${PIN_A}`, note: 'dup' },
      { kind: 'dir', uri: '/Users/wufeng/reports' },
    ],
    [
      { kind: 'pin', uri: `pin://${PIN_B}`, label: '报告', sha256: 'c'.repeat(64) },
      { kind: 'url', uri: 'https://example.com/x', sha256: 'not-a-hash' },
    ],
  );
  assert.equal(rows.length, 4, 'the duplicate (kind,uri) collapses');
  const first = rows.find((row) => row.uri === `pin://${PIN_A}`);
  assert.equal(first?.pinId, PIN_A);
  assert.equal(first?.label, PIN_A, 'a pin with no label falls back to its id, never a made-up title');
  assert.equal(first?.hasLabel, false, 'the id is a FALLBACK — a resolved pin title may replace it on screen');
  assert.equal(first?.note, '设计稿');
  assert.equal(first?.source, 'evidence');
  const artifact = rows.find((row) => row.uri === `pin://${PIN_B}`);
  assert.equal(artifact?.label, '报告');
  assert.equal(artifact?.hasLabel, true, 'an author-supplied label wins over the pin title');
  assert.equal(artifact?.sha256, 'c'.repeat(64));
  assert.equal(artifact?.source, 'artifact');
  const url = rows.find((row) => row.uri === 'https://example.com/x');
  assert.equal(url?.sha256, null, 'a malformed hash is dropped, not displayed');
  assert.equal(url?.label, 'x', 'basename fallback');
  const dir = rows.find((row) => row.cls === 'DIR');
  assert.equal(dir?.pinId, null);
});

// ── 4. 时间 / 档位 ─────────────────────────────────────────────────────────

test('the 52px stamp splits into date + time and refuses an unparsable input', () => {
  const stamp = formatDossierStamp('2026-11-22T14:47:23.042Z');
  assert.match(stamp?.date ?? '', /^\d{2}-\d{2}$/);
  assert.match(stamp?.time ?? '', /^\d{2}:\d{2}$/);
  assert.equal(formatDossierStamp(''), null);
  assert.equal(formatDossierStamp('not-a-date'), null);
});

test('the dossier tier comes from the SAME autoOrigin the hub groups by', () => {
  assert.equal(dossierTierOf('longterm'), 'task');
  assert.equal(dossierTierOf('orchestration'), 'orchestration');
  assert.equal(dossierTierOf('schedule'), 'schedule');
  assert.equal(dossierTierOf(null), 'none');
  assert.equal(dossierTierOf('something-else'), 'none');
});

// ── 5. Wiring ──────────────────────────────────────────────────────────────

test('1A: the dossier is the default layer and the message stream is only HIDDEN, never rebuilt', () => {
  const detail = readSource('src/renderer/components/cowork/CoworkSessionDetail.tsx');

  // The tab state defaults to the dossier and resets when the process changes.
  assert.match(detail, /const \[processDossierTab, setProcessDossierTab\] = useState<'archive' \| 'raw'>\('archive'\);/);
  assert.match(detail, /setProcessDossierTab\('archive'\);/);
  // The segmented template: 32px, md radius, two equal cells (design §07 #2).
  assert.match(detail, /data-testid="process-dossier-tabs"/);
  assert.match(detail, /className="mx-auto grid h-\[32px\] w-full max-w-\[clamp\(680px,64%,920px\)\] grid-cols-2 gap-0 overflow-hidden rounded-\[var\(--shape-radius-md\)\]/);
  // The archive pane stays MOUNTED; the raw tab only hides it (no refetch, no
  // scroll reset, and the message stream keeps its refs and handlers).
  assert.match(detail, /className=\{processDossierTab === 'archive' \? 'flex min-h-0 flex-1 flex-col' : 'hidden'\}/);
  assert.match(detail, /<ProcessDossierBody\s*\n\s*view=\{processDossier\}/);
  // The stream keeps its exact ref + handlers; only a conditional `hidden` is
  // appended, so the raw record is byte-identical when shown.
  assert.match(detail, /ref=\{scrollContainerRef\}[\s\S]{0,240}onScroll=\{handleMessagesScroll\}[\s\S]{0,240}className=\{`flex-1 overflow-y-auto overflow-anchor-none min-h-0 pt-3 \$\{isProcessSessionReadOnly && processDossierTab === 'archive' \? 'hidden' : ''\}`\}/);
  // The read-only bar is still the only 只读 statement and the only jump.
  assert.match(detail, /data-testid="process-read-only-bar"/);
  assert.match(detail, /data-testid="process-jump-to-twin"/);
});

test('the dossier body renders the four blocks in fixed order, with honest empty states', () => {
  const body = readSource('src/renderer/components/cowork/ProcessDossierBody.tsx');
  const order = [
    'testId="process-dossier-goal"',
    'testId="process-dossier-checklist"',
    'testId="process-dossier-rounds"',
    'testId="process-dossier-evidence"',
  ].map((needle) => body.indexOf(needle));
  assert.ok(order.every((index) => index > 0), 'all four blocks exist');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'fixed order: 目标 → 清单 → 轮次 → 证据');

  // Never an empty checklist drawn as a checklist: each block has its own
  // sentence, and the no-task tier says why it has no dossier.
  for (const key of [
    'processDossierNoSubtask',
    'processDossierNoChecklist',
    'processDossierNoRounds',
    'processDossierNoEvidence',
    'processDossierNoTask',
    'processDossierNoTaskOrchestration',
    'processDossierNoTaskSchedule',
  ]) {
    assert.match(body, new RegExp(`t\\('${key}'\\)`), `${key} rendered`);
  }
  // 2A's ≈ mark exists and is explained in its title.
  assert.match(body, /data-testid="process-dossier-inferred"/);
  assert.match(body, /processDossierInferredTitle/);
  // The copy key hands over the FULL id, never the truncated label.
  assert.match(body, /const value = \(row\.pinId \?\? row\.uri\)\.trim\(\);/);
  assert.match(body, /navigator\.clipboard\.writeText\(value\)/);
});

test('N1/N2/N3: the three read channels are exposed, registered, and tier-resolved', () => {
  const preload = readSource('src/main/preload.ts');
  const main = readSource('src/main/main.ts');
  const allowlist = readSource('src/main/gateway/allowlist.ts');

  assert.match(preload, /events: \(input: \{ taskId: string; limit\?: number \}\) => ipcRenderer\.invoke\('longtermTask:events', input\)/);
  assert.match(preload, /processDossier: \{\s*\n\s*get: \(input: \{ sessionId: string; eventLimit\?: number \}\) => ipcRenderer\.invoke\('processDossier:get', input\),/);
  assert.match(preload, /pinInfo: \(input: \{ pinId: string \}\) => ipcRenderer\.invoke\('metaweb:pinInfo', input\)/);

  assert.match(main, /registerIpcHandler\('longtermTask:events'/);
  assert.match(main, /registerIpcHandler\('processDossier:get'/);
  assert.match(main, /registerIpcHandler\('metaweb:pinInfo'/);
  // The dossier handler is READ-ONLY: no store mutation call anywhere in it.
  const dossierStart = main.indexOf("registerIpcHandler('processDossier:get'");
  const dossierEnd = main.indexOf("registerIpcHandler('metaweb:pinInfo'", dossierStart);
  const dossierBody = main.slice(dossierStart, dossierEnd);
  assert.ok(dossierBody.length > 500, 'handler body found');
  assert.doesNotMatch(dossierBody, /\.(acceptSubtask|rejectSubtask|proposeSubtask|updateTask|beginSubtask)\(/);
  // The pin naming handler refuses a malformed id before any network call.
  assert.match(main, /if \(!\/\^\[0-9a-f\]\{64\}i\\d\+\$\/\.test\(pinId\)\)/);

  // Both new families carry an allowlist rule (the contract test would fail
  // on an unresolved channel; this pins the intent next to the code).
  assert.match(allowlist, /\{ prefix: 'processDossier:', entry: \{ tier: 'N'/);
  assert.match(allowlist, /\{ prefix: 'metaweb:', entry: \{ tier: 'N'/);
});

test('N4: criterionIndex is optional, typed, and carried by the write-side schemas', () => {
  const types = readSource('src/renderer/types/longTermTask.ts');
  const tools = readSource('src/main/libs/longTermTaskAgentTools.ts');
  const store = readSource('src/main/longTermTaskStore.ts');

  assert.match(types, /criterionIndex\?: number;/);
  // Every evidence-bearing tool schema carries the field (goal closure, propose,
  // worker submit, worker propose).
  const occurrences = (tools.match(/criterionIndex: z\.number\(\)\.int\(\)\.min\(0\)\.optional\(\)/g) ?? []).length;
  assert.ok(occurrences >= 4, `expected ≥4 schema sites, got ${occurrences}`);
  // And the store rejects a junk value instead of persisting a mis-binding.
  assert.match(store, /criterionIndex must be a non-negative integer when present/);
  // Zero migration: the field lives inside evidence_json (no ALTER anywhere).
  assert.doesNotMatch(store, /ALTER TABLE long_term_subtasks[^\n]*criterion/i);
});

test('i18n: every dossier key exists exactly once per language pack', () => {
  const i18n = readSource('src/renderer/services/i18n.ts');
  const keys = [
    'processDossierTabArchive',
    'processDossierTabRaw',
    'processDossierGoal',
    'processDossierChecklist',
    'processDossierRounds',
    'processDossierEvidence',
    'processDossierRunFacts',
    'processDossierPassedShort',
    'processDossierCheckUnverified',
    'processDossierVerdictRunning',
    'processDossierVerdictSubmitted',
    'processDossierVerdictAccepted',
    'processDossierVerdictRejected',
    'processDossierVerdictSkipped',
    'processDossierActorOwner',
    'processDossierActorTwin',
    'processDossierActorSystem',
    'processDossierChannelDelegate',
    'processDossierChannelGroup',
    'processDossierChannelOwnerExternal',
    'processDossierChannelOwnerTogether',
    'processDossierFactChannel',
    'processDossierFactDispatch',
    'processDossierFactExpected',
    'processDossierFactCurrent',
    'processDossierExpectedMinutes',
    'processDossierNoTask',
    'processDossierNoTaskOrchestration',
    'processDossierNoTaskSchedule',
    'processDossierNoSubtask',
    'processDossierNoChecklist',
    'processDossierNoRounds',
    'processDossierNoEvidence',
    'processDossierEventsCapped',
    'processDossierInferredTitle',
    'processDossierAnchorCountTitle',
    'processDossierUnnamed',
    'processDossierUnreachable',
    'processDossierShaRegistered',
    'processDossierCopy',
    'processDossierCopied',
    'processDossierOpen',
    'processDossierRetry',
    'processDossierLoadFailed',
    'processDossierChannelOffline',
    'processDossierLoading',
    'processDossierFoldProgress',
  ];
  for (const key of keys) {
    const count = (i18n.match(new RegExp(`\\n\\s*${key}:`, 'g')) ?? []).length;
    assert.equal(count, 2, `${key}: one per locale`);
  }
  // The five reused check-state labels must still exist in both packs — the
  // dossier deliberately borrows the board's vocabulary instead of forking it.
  for (const key of ['accepted', 'waitingOwner', 'rejected', 'skipped', 'waitingExternal']) {
    const count = (i18n.match(new RegExp(`\\n\\s*'longTermTask\\.status\\.${key}':`, 'g')) ?? []).length;
    assert.equal(count, 2, `longTermTask.status.${key}: one per locale`);
  }
});
