// 批 B · P0-3 — 决策卡第一落点回 Live Stage (owner ruling 2026-11-23 22:23:
// 「决策要回到 Live Stage，这才是真正做决策的地方」).
//
// This suite pins the three properties the ruling names:
//   1. the stage hosts ONE inline decision card, chosen by a deterministic
//      precedence over the SAME open-queue rows the Process Hub lists;
//   2. the card is a VIEW — stage.js only emits an intent, the bridge relays
//      it, and the renderer submits through the SAME `longtermTask:decisionResolve`
//      IPC the hub uses (one resolve channel, one truth);
//   3. the cross-surface entries exist: the Studio badge is a button that
//      reveals the Live Stage, and the Process Hub keeps the summary block.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  buildLiveStageDecisionCard,
  buildStudioLiveTaskHud,
} = require('../dist-electron/main/services/studioLiveStageModel.js');

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const item = (over = {}) => ({
  id: 'dec-1',
  kind: 'acceptance',
  title: '批 B 验收',
  question: '是否通过？',
  recommendation: '通过',
  backgroundSummary: '背景',
  options: [
    { label: '通过', recommended: true },
    { label: '退回重做' },
  ],
  evidence: [
    { kind: 'dir', uri: '/tmp/report.md', note: '报告' },
    { kind: 'pin', uri: 'pin://abc' },
  ],
  longtermTaskId: 'ltt_a',
  originStudioSessionId: 's1',
  ...over,
});

// ── 1. selection precedence ───────────────────────────────────────────────

test('decision card: this session\'s own queue item wins', () => {
  const card = buildLiveStageDecisionCard({
    items: [
      item({ id: 'other', originStudioSessionId: 's2', longtermTaskId: 'ltt_b' }),
      item({ id: 'mine', originStudioSessionId: 's1', longtermTaskId: 'ltt_a' }),
    ],
    sessionId: 's1',
    sessionOwnedTaskIds: new Set(['ltt_a']),
  });
  assert.equal(card.id, 'mine');
  assert.equal(card.foreign, undefined);
});

test('decision card: a session-owned task outranks an unrelated queue item', () => {
  const card = buildLiveStageDecisionCard({
    items: [
      item({ id: 'foreign', originStudioSessionId: 's9', longtermTaskId: 'ltt_x' }),
      item({ id: 'owned', originStudioSessionId: 's9', longtermTaskId: 'ltt_a' }),
    ],
    sessionId: 's1',
    sessionOwnedTaskIds: new Set(['ltt_a']),
  });
  assert.equal(card.id, 'owned');
  assert.equal(card.foreign, undefined);
});

test('decision card: exactly one machine-wide decision is hosted and marked foreign', () => {
  const card = buildLiveStageDecisionCard({
    items: [item({ id: 'solo', originStudioSessionId: 's9', longtermTaskId: 'ltt_x' })],
    sessionId: 's1',
    sessionOwnedTaskIds: new Set(),
  });
  assert.equal(card.id, 'solo');
  assert.equal(card.foreign, true);
});

test('decision card: several foreign decisions stay in the Process Hub list (null here)', () => {
  const card = buildLiveStageDecisionCard({
    items: [
      item({ id: 'a', originStudioSessionId: 's9', longtermTaskId: 'ltt_x' }),
      item({ id: 'b', originStudioSessionId: 's8', longtermTaskId: 'ltt_y' }),
    ],
    sessionId: 's1',
    sessionOwnedTaskIds: new Set(),
  });
  assert.equal(card, null);
});

test('decision card: empty queue → no card', () => {
  assert.equal(buildLiveStageDecisionCard({ items: [], sessionId: 's1', sessionOwnedTaskIds: new Set() }), null);
});

// ── 2. card shape ─────────────────────────────────────────────────────────

test('decision card: evidence and options are capped, blanks dropped', () => {
  const card = buildLiveStageDecisionCard({
    items: [item({
      options: [
        { label: ' 通过 ' },
        { label: '   ' },
        { label: 'B' },
        { label: 'C' },
        { label: 'D' },
      ],
      evidence: [
        { kind: 'dir', uri: ' /tmp/a ' },
        { kind: 'pin', uri: '' },
        { kind: 'pin', uri: 'pin://b' },
        { kind: 'pin', uri: 'pin://c' },
        { kind: 'pin', uri: 'pin://d' },
      ],
    })],
    sessionId: 's1',
    sessionOwnedTaskIds: new Set(['ltt_a']),
  });
  assert.deepEqual(card.options.map((option) => option.label), ['通过', 'B', 'C']);
  assert.deepEqual(card.evidence.map((entry) => entry.uri), ['/tmp/a', 'pin://b', 'pin://c']);
  assert.equal(card.evidence[0].kind, 'dir');
});

test('decision card: a missing title falls back to the question, never to empty', () => {
  const card = buildLiveStageDecisionCard({
    items: [item({ title: '   ', question: '要我继续吗？' })],
    sessionId: 's1',
    sessionOwnedTaskIds: new Set(['ltt_a']),
  });
  assert.equal(card.title, '要我继续吗？');
});

// ── 3. HUD carries the card ───────────────────────────────────────────────

test('task HUD: a decision alone keeps the HUD alive and rides taskHud.decision', () => {
  const decision = buildLiveStageDecisionCard({
    items: [item()],
    sessionId: 's1',
    sessionOwnedTaskIds: new Set(['ltt_a']),
  });
  const hud = buildStudioLiveTaskHud({
    cards: [],
    sessionOwnedTaskIds: new Set(),
    studioBusy: false,
    rawQueuedDecisions: 1,
    decision,
  });
  assert.ok(hud, 'a pending decision must not be hidden by an empty task list');
  assert.equal(hud.decision.id, 'dec-1');
  assert.equal(hud.queuedDecisions, 1);
});

test('task HUD: no decision → no decision key (the stage hides the card)', () => {
  const hud = buildStudioLiveTaskHud({
    cards: [],
    sessionOwnedTaskIds: new Set(),
    studioBusy: false,
    rawQueuedDecisions: 1,
    decision: null,
  });
  assert.ok(hud);
  assert.equal(Object.prototype.hasOwnProperty.call(hud, 'decision'), false);
});

// ── 4. wiring: one data source, one resolve channel ───────────────────────

test('main: the stage HUD reads the SAME listOpen() rows the Process Hub is handed', () => {
  const main = read('src/main/main.ts');
  // The one open-queue read that feeds BOTH the stage card and the count.
  assert.match(main, /const openDecisionItems = twin \? getStudioDecisionQueueStore\(\)\.listOpen\(twin\.id\) : \[\];/);
  assert.match(main, /const decision = buildLiveStageDecisionCard\(\{/);
  assert.match(main, /items: openDecisionItems,/);
  assert.match(main, /sessionOwnedTaskIds: sessionOwnedIds,/);
  // studioStatus (the hub's read) still lists the same store.
  assert.match(main, /const openDecisions = twin \? getStudioDecisionQueueStore\(\)\.listOpen\(twin\.id\) : \[\];/);
  assert.match(main, /openDecisions,/);
});

test('stage: the card renders inline and emits an intent only (never resolves)', () => {
  const html = read('public/live-stage/stage.html');
  const js = read('public/live-stage/stage.js');
  const css = read('public/live-stage/stage.css');
  assert.match(html, /data-owner-stack/);
  assert.match(html, /<section class="decision-card" data-decision-card hidden><\/section>/);
  assert.match(js, /function renderDecision\(\)/);
  assert.match(js, /type: 'stage-decision'/);
  assert.match(js, /queueItemId/);
  assert.match(js, /resolutionNote/);
  // The stage must not own a resolve path: the sandboxed page has no IPC at
  // all, and it never calls a resolve — it emits an intent and stops.
  assert.equal(/window\.electron/.test(js), false);
  assert.equal(/decisionResolve\s*\(/.test(js), false);
  assert.match(css, /\.decision-card\{/);
  assert.match(css, /\.owner-stack\{/);
});

test('stage: the body flag can never collide with the card selector (live-run regression)', () => {
  const js = read('public/live-stage/stage.js');
  // 2026-11-23 live-run catch: `body.dataset.decisionCard = 'true'` writes a
  // `data-decision-card` attribute onto <body>, which then matches the card's
  // own `[data-decision-card]` selector — the SECOND patch resolved `$()` to
  // <body> and replaceChildren() wiped the whole stage. The body flag must use
  // a distinct dataset key, and only the section may carry data-decision-card.
  assert.equal(/body\.dataset\.decisionCard\s*=/.test(js), false, 'body flag must not alias data-decision-card');
  assert.match(js, /body\.dataset\.decisionCardOpen\s*=/);
  assert.match(read('public/live-stage/stage.css'), /body\[data-decision-card-open="true"\] \.core-copy/);
});

test('bridge + surface: Live Stage relays are handled BEFORE the iframe-bridge source gate', () => {
  const surface = read('src/renderer/features/botBrowser/BotBrowserSurface.tsx');
  const relayIndex = surface.indexOf("data.source === PARENT_SOURCE && data.type === 'stage-interaction'");
  const gateIndex = surface.indexOf("if (data.source !== 'idbots-browser-iframe-bridge') return;");
  assert.ok(relayIndex > 0 && gateIndex > 0, 'both anchors must exist');
  // The shell bridge re-posts with PARENT_SOURCE; a branch below the
  // iframe-bridge gate is unreachable (that is how the click relay was lost).
  assert.ok(relayIndex < gateIndex, 'stage relays must precede the iframe-bridge source gate');
  assert.match(surface, /data\.source === PARENT_SOURCE && data\.type === 'stage-decision'/);
});

test('bridge + surface: stage-decision relays to the SAME longtermTask:decisionResolve IPC', () => {
  const bridge = read('src/renderer/features/botBrowser/browserIframeBridge.ts');
  const surface = read('src/renderer/features/botBrowser/BotBrowserSurface.tsx');
  assert.match(bridge, /data\.type === 'stage-decision'/);
  assert.match(bridge, /type: 'stage-decision'/);
  assert.match(surface, /data\.type === 'stage-decision'/);
  assert.match(surface, /window\.electron\.longtermTask\.decisionResolve\(\{/);
  assert.match(surface, /queueItemId: data\.entry\.queueItemId/);
  assert.match(surface, /resolutionNote: data\.entry\.resolutionNote/);
  // The hub's decision card calls the exact same IPC — two seats, one channel.
  const hub = read('src/renderer/components/cowork/ProcessCenterPanel.tsx');
  assert.match(hub, /api\?\.decisionResolve\?\.\(\{ queueItemId: item\.id, resolutionNote: note \}\)/);
  assert.match(hub, /api\.studioStatus\(\{\}\)/);
});

test('cross-surface: the Studio badge is a button that reveals the Live Stage', () => {
  const sidebar = read('src/renderer/components/Sidebar.tsx');
  const start = sidebar.indexOf('data-slot="studio-decision-queue-badge"');
  assert.ok(start > 0, 'the badge slot must still exist');
  const slice = sidebar.slice(Math.max(0, start - 400), start + 700);
  assert.match(slice, /<button/);
  assert.match(slice, /sessionTabBinding\.revealSessionTab\(sessionId\)/);
  assert.match(slice, /studioDecisionBadgeJumpTitle/);
});

test('i18n: the Live Stage decision copy exists in BOTH languages', () => {
  const i18n = read('src/renderer/services/i18n.ts');
  for (const key of ['liveStageDecisionResolveFailed', 'studioDecisionBadgeJumpTitle']) {
    const hits = i18n.match(new RegExp(`^\\s+${key}:`, 'gm')) ?? [];
    assert.equal(hits.length, 2, `${key} must be defined once per language`);
  }
});
