import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonJ, innerHash, outerHash, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');
const { replayMetaTask } = require('../dist-electron/main/services/metatask/engine.js');
const { estimateMetaTaskShares } = require('../dist-electron/main/services/metatask/estimate.js');
const {
  collectMetaTaskEvents,
  normalizeChainEvent,
  rosterPinsFromEvents,
} = require('../dist-electron/main/services/metatask/collector.js');
const { METATASK_COLLECTED_PATHS } = require('../dist-electron/main/services/metatask/constants.js');

/**
 * MetaTask TS engine — conformance vectors (P1).
 *
 * Hash vectors are the five FROZEN calibration values from the v1.2
 * registration draft Appendix A (measured on Python 3.14.3, 2026-09-22):
 * the TS implementation must reproduce them byte-for-byte. Replay vectors
 * port the reference Python engine's discriminator set plus the v1.2
 * H_ACT2-gated features (supersede / amend / challenge / settlement).
 */

// ── frozen hash calibration vectors (Appendix A) ─────────────────────────────

test('hash canon: appendix A positive vectors reproduce exactly', () => {
  const pos1 = { node: 'n4', type: 'counterexample', n: 8, candidates: 28, primes_found: 0, samples: [259, 289] };
  const pos1WithHash = { ...pos1, hash: innerHash(pos1) };
  assert.equal(innerHash(pos1), '6ccdb15eaebd14d0c1b5d3c629d708c6e66af4be53f10ab5a4c7dade3a3e371c');
  assert.equal(outerHash(pos1WithHash), '80df13f4a673b804920607ec260c99348724e96e1f165383d3fdbaa0e8df5ede');

  const pos2 = { node: '节点甲', type: 'triage', well_defined: false, note: null };
  const pos2WithHash = { ...pos2, hash: innerHash(pos2) };
  assert.equal(innerHash(pos2), '72778ba8597bebe051efbafd729b2c510aaa9202cc4e105d6506efeb19127609');
  assert.equal(outerHash(pos2WithHash), '07740603fd75770dd206dd6ee60392b082d0cc1282dc00fcf8f6c67324cb57df');
});

test('hash canon: key insertion order never matters (sort_keys parity)', () => {
  const a = { b: 1, a: 2 };
  const b = { a: 2, b: 1 };
  assert.equal(sha256Hex(canonJ(a)), sha256Hex(canonJ(b)));
});

// ── event scaffolding ────────────────────────────────────────────────────────

let pinCounter = 0;
const nextPinId = () => `pin${String(++pinCounter).padStart(4, '0')}0i0`;

const ev = (path, body, over = {}) => ({
  pinId: over.pinId ?? nextPinId(),
  path,
  author: over.author ?? 'idq1defaultbot',
  height: over.height ?? 189_900,
  txIndex: over.txIndex ?? 0,
  timestampMs: over.timestampMs ?? 1_790_000_000_000,
  body,
});

const P = 'idq1publisheraa';
const S = 'idq1submitterbb';
const R1 = 'idq1reviewercc';
const R2 = 'idq1reviewerdd';
const C = 'idq1challengerE';

const buildTask = (over = {}) => {
  const treePinId = over.treePinId ?? nextPinId();
  const rootPinId = over.rootPinId ?? nextPinId();
  const nodes = over.nodes ?? [
    { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
    { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 7000 },
  ];
  const tree = ev('tree', { root: nodes[0]?.id ?? 'r1', nodes }, { pinId: treePinId, author: P, height: 189_800 });
  const task = ev(
    'task',
    {
      title: over.title ?? 'vector task',
      brief: '',
      treeid: treePinId,
      policy: {
        verify_quorum: over.quorum ?? 2,
        claim_ttl_hours: over.ttlHours ?? 48,
        verify_window_hours: over.windowHours ?? 72,
        ...(over.split ? { split: over.split } : {}),
      },
      tags: [],
    },
    { pinId: rootPinId, author: P, height: 189_801 }
  );
  return { tree, task, rootPinId, treePinId };
};

const claimOn = (rootPinId, node, author, over = {}) =>
  ev('claim', { taskid: rootPinId, node }, { author, ...over });

const submitOn = (rootPinId, node, claimPinId, author, over = {}) => {
  const childIds = Array.isArray(over.childIds) ? over.childIds : [];
  const resultBody = {
    type: 'table',
    hash: '0'.repeat(64),
    rows: [],
    ...(childIds.length > 0 ? { childids: childIds } : {}),
  };
  return ev(
    'submission',
    {
      taskid: rootPinId,
      node,
      claimid: claimPinId,
      result: resultBody,
      hash: '1'.repeat(64),
      contentType: 'application/json;utf-8',
      attachment: null,
      childids: childIds,
      ...(over.supersedeid ? { supersedeid: over.supersedeid } : {}),
    },
    { author, ...over },
  );
};

const voteOn = (targetPinId, verdict, author, over = {}) =>
  ev(
    'verify',
    {
      targetid: targetPinId,
      verdict,
      method: 'replayed spec; hashes match',
      ...(over.semanticCheck === false ? {} : { semantic_check: 'statement matches; definitions aligned' }),
      ...(verdict === 'fail' ? { failreason: over.failreason ?? 'counterexample found in row 3' } : {}),
    },
    { author, ...over }
  );

// ── baseline replay states (pre-H_ACT heights: v1.1 semantics) ──────────────

test('replay: open → claimed → verified baseline', () => {
  const { tree, task, rootPinId } = buildTask();
  const events = [tree, task];
  let projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'open');

  const claim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  projection = replayMetaTask([...events, claim], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'claimed');

  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_910 });
  projection = replayMetaTask([...events, claim, sub], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'claimed');

  const votes = [
    voteOn(sub.pinId, 'pass', R1, { height: 189_920 }),
    voteOn(sub.pinId, 'pass', R2, { height: 189_921 }),
  ];
  projection = replayMetaTask([...events, claim, sub, ...votes], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t1.passVotes, 2);
});

test('replay: release reopens; ignored claim never resurrects', () => {
  const { tree, task, rootPinId } = buildTask();
  const claimA = claimOn(rootPinId, 't1', S, { height: 189_900, txIndex: 0 });
  const claimB = claimOn(rootPinId, 't1', R1, { height: 189_901, txIndex: 0 });
  const release = ev('release', { taskid: rootPinId, node: 't1', claimid: claimA.pinId }, { author: S, height: 189_902 });
  const projection = replayMetaTask([tree, task, claimA, claimB, release], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'open'); // B lost the race; A released
});

test('replay: claim TTL expiry reopens (guard semantics)', () => {
  const { tree, task, rootPinId } = buildTask({ ttlHours: 48 });
  const claim = claimOn(rootPinId, 't1', S, { height: 189_900, timestampMs: 1_790_000_000_000 });
  const now = 1_790_000_000_000 + 49 * 3_600_000;
  const projection = replayMetaTask([tree, task, claim], { rootPinId, now });
  assert.equal(projection.nodeStates.t1.status, 'open');
});

test('replay: review-window expiry without quorum reopens', () => {
  const { tree, task, rootPinId } = buildTask({ windowHours: 72, quorum: 2 });
  const claim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_910, timestampMs: 1_790_000_000_000 });
  const one = voteOn(sub.pinId, 'pass', R1, { height: 189_920 });
  const now = 1_790_000_000_000 + 73 * 3_600_000;
  const projection = replayMetaTask([tree, task, claim, sub, one], { rootPinId, now });
  assert.equal(projection.nodeStates.t1.status, 'open');
});

// ── #8/#9 vote gates (heights at/after H_ACT=190000) ─────────────────────────

test('gates: #9 missing semantic_check -> stored but not counted (post H_ACT)', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 190_010 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_020 });
  const bad = voteOn(sub.pinId, 'pass', R1, { height: 190_030, semanticCheck: false });
  const good = voteOn(sub.pinId, 'pass', R2, { height: 190_031 });
  const projection = replayMetaTask([tree, task, claim, sub, bad, good], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'claimed'); // only 1 counted pass < quorum 2
  assert.ok(projection.ignoredEvents.some((e) => e.pinId === bad.pinId && e.reason === 'missing_semantic_check'));
});

test('gates: same shape below H_ACT still counts (boundary pair)', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 189_990 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_991 });
  const noSc = voteOn(sub.pinId, 'pass', R1, { height: 189_999, semanticCheck: false });
  const good = voteOn(sub.pinId, 'pass', R2, { height: 189_998 });
  const projection = replayMetaTask([tree, task, claim, sub, noSc, good], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified'); // v1.1 semantics: both count
});

test('gates: #8 fail missing failreason -> invalid, does not block verification', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 190_010 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_020 });
  const malformedFail = ev(
    'verify',
    { targetid: sub.pinId, verdict: 'fail', method: 'x', semantic_check: 'checked' },
    { author: R1, height: 190_030 }
  );
  const pass = voteOn(sub.pinId, 'pass', R2, { height: 190_031 });
  const projection = replayMetaTask([tree, task, claim, sub, malformedFail, pass], { rootPinId });
  // quorum 2 but only 1 valid pass -> claimed (malformed fail neither blocks nor counts)
  assert.equal(projection.nodeStates.t1.status, 'claimed');
});

test('gates: valid fail with failreason reopens immediately', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 190_010 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_020 });
  const passes = [voteOn(sub.pinId, 'pass', R1, { height: 190_030 }), voteOn(sub.pinId, 'pass', R2, { height: 190_031 })];
  const fail = voteOn(sub.pinId, 'fail', C, { height: 190_040 });
  const projection = replayMetaTask([tree, task, claim, sub, ...passes, fail], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'open');
});

test('votes: last valid vote per bot wins (pilot #01 fail-then-pass pattern)', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_910 });
  const votes = [
    voteOn(sub.pinId, 'fail', R1, { height: 189_920 }),
    voteOn(sub.pinId, 'fail', R2, { height: 189_921 }),
    voteOn(sub.pinId, 'pass', R1, { height: 189_930 }),
    voteOn(sub.pinId, 'pass', R2, { height: 189_931 }),
  ];
  const projection = replayMetaTask([tree, task, claim, sub, ...votes], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t1.failVotes, 0);
});

test('votes: submitter and root author pass votes never count', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_910 });
  const selfVote = voteOn(sub.pinId, 'pass', S, { height: 189_920 });
  const publisherVote = voteOn(sub.pinId, 'pass', P, { height: 189_921 });
  const real = voteOn(sub.pinId, 'pass', R1, { height: 189_922 });
  const projection = replayMetaTask([tree, task, claim, sub, selfVote, publisherVote, real], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'claimed'); // 1 counted pass < 2
});

// ── settlement (v1.2 §11) ────────────────────────────────────────────────────

const settledTwoNodeTask = () => {
  const { tree, task, rootPinId } = buildTask(); // r1:3000 aggregate, t1:7000 leaf
  const claimT1 = claimOn(rootPinId, 't1', S, { height: 190_100 });
  const subT1 = submitOn(rootPinId, 't1', claimT1.pinId, S, { height: 190_110 });
  const claimR1 = claimOn(rootPinId, 'r1', S, { height: 190_120 });
  const subR1 = submitOn(rootPinId, 'r1', claimR1.pinId, S, { height: 190_130 });
  const events = [
    tree,
    task,
    claimT1,
    subT1,
    voteOn(subT1.pinId, 'pass', R1, { height: 190_140 }),
    voteOn(subT1.pinId, 'pass', R2, { height: 190_141 }),
    claimR1,
    subR1,
    voteOn(subR1.pinId, 'pass', R1, { height: 190_150 }),
    voteOn(subR1.pinId, 'pass', R2, { height: 190_151 }),
  ];
  return { events, rootPinId };
};

test('settlement: integer split, self-check invariant, byte-exact totals', () => {
  const { events, rootPinId } = settledTwoNodeTask();
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.taskComplete, true);
  const manifest = projection.settlement;
  assert.ok(manifest, 'task complete with no open challenges must settle');
  // t1 (7000bp): submitter 5600, pool 1400 -> 700+700 equal accuracy reviewers
  // r1 (3000bp): submitter 2400, pool 600 -> 300+300
  const shares = Object.fromEntries(manifest.shares.map((s) => [s.metaId, s]));
  assert.equal(shares[S].from.submittedBP, 8000);
  assert.equal(shares[S].shareBP, 8000);
  assert.equal(shares[R1].from.reviewedBP, 1000);
  assert.equal(shares[R2].from.reviewedBP, 1000);
  assert.equal(shares[R1].shareBP, 1000);
  const total = manifest.shares.reduce((sum, s) => sum + s.shareBP, 0);
  assert.equal(total, 10000);
  for (const share of manifest.shares) {
    assert.equal(share.shareBP, share.from.submittedBP + share.from.reviewedBP);
  }
});

test('settlement: legacy uniform weights discard the residue', () => {
  const nodes = ['a', 'b', 'c'].map((id, index) => ({
    id,
    parent: index === 0 ? null : 'a',
    title: id,
    kind: index === 0 ? 'aggregate' : 'proof',
    specid: null,
    params: {},
    deps: [],
    // no weight field: pre-H_ACT2 legacy task
  }));
  const treePinId = nextPinId();
  const rootPinId = nextPinId();
  const tree = ev('tree', { root: 'a', nodes }, { pinId: treePinId, author: P, height: 189_800 });
  const task = ev(
    'task',
    { title: 'legacy', treeid: treePinId, policy: { verify_quorum: 1, claim_ttl_hours: 48, verify_window_hours: 72 }, tags: [] },
    { pinId: rootPinId, author: P, height: 189_801 }
  );
  const events = [tree, task];
  const submitters = ['idq1legacyaa', 'idq1legacybb', 'idq1legacycc'];
  const reviewer = 'idq1legacyrev';
  for (let i = 0; i < 3; i += 1) {
    const node = nodes[i].id;
    const claim = claimOn(rootPinId, node, submitters[i], { height: 189_900 + i });
    const sub = submitOn(rootPinId, node, claim.pinId, submitters[i], { height: 189_910 + i });
    events.push(claim, sub, voteOn(sub.pinId, 'pass', reviewer, { height: 189_920 + i }));
  }
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.taskComplete, true);
  const total = projection.settlement.shares.reduce((sum, s) => sum + s.shareBP, 0);
  // uniform floor(10000/3) = 3333 per node; per node sub 2666 + pool 667 = 3333
  // total distributed 9999, the 1bp residue is discarded (rev-2 ruling)
  assert.equal(total, 9999);
});

test('settlement: rework cycles pay only the effective submitter (unpaid history)', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 1 });
  const claim1 = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const sub1 = submitOn(rootPinId, 't1', claim1.pinId, S, { height: 189_910, pinId: 'sub1cyclei0' });
  const fail = voteOn(sub1.pinId, 'fail', R1, { height: 189_920 }); // pre-H_ACT: no failreason needed
  const claim2 = claimOn(rootPinId, 't1', S, { height: 189_930 });
  const sub2 = submitOn(rootPinId, 't1', claim2.pinId, S, { height: 189_940 });
  const pass = voteOn(sub2.pinId, 'pass', R1, { height: 189_950 });
  const events = [tree, task, claim1, sub1, fail, claim2, sub2, pass];
  // also verify the aggregate so the task completes
  const claimR = claimOn(rootPinId, 'r1', S, { height: 189_960 });
  const subR = submitOn(rootPinId, 'r1', claimR.pinId, S, { height: 189_970 });
  const passR = voteOn(subR.pinId, 'pass', R2, { height: 189_980 });
  const projection = replayMetaTask([...events, claimR, subR, passR], { rootPinId });
  assert.equal(projection.taskComplete, true);
  assert.ok(projection.settlement.unpaidHistory.some((h) => h.pinId === 'sub1cyclei0' && h.reason === 'rework_cycle'));
  const shares = Object.fromEntries(projection.settlement.shares.map((s) => [s.metaId, s]));
  // t1 7000bp: sub 5600 + pool 1400 to R1 (only reviewer); r1 3000bp: 2400 + 600 to R2
  assert.equal(shares[S].shareBP, 8000);
  assert.equal(shares[R1].shareBP, 1400);
  assert.equal(shares[R2].shareBP, 600);
});

// ── v1.2 features (H_ACT2-gated) ─────────────────────────────────────────────

test('supersede: valid chain re-anchors; below H_ACT2 stays ignored', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 1 });
  const claim = claimOn(rootPinId, 't1', S, { height: 190_200 });
  const sub1 = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_201, pinId: 'superseded01i0' });
  const sub2 = submitOn(rootPinId, 't1', claim.pinId, S, {
    height: 190_202,
    pinId: 'superseder02i0',
    supersedeid: 'superseded01i0',
  });
  const passOnSub2 = voteOn('superseder02i0', 'pass', R1, { height: 190_203 });

  const active = replayMetaTask([tree, task, claim, sub1, sub2, passOnSub2], { rootPinId, hAct2: 190_200 });
  assert.equal(active.nodeStates.t1.submission.pinId, 'superseder02i0');
  assert.equal(active.nodeStates.t1.status, 'verified');
  assert.ok(active.ignoredEvents.every((e) => e.pinId !== 'superseder02i0'));

  const gated = replayMetaTask([tree, task, claim, sub1, sub2, passOnSub2], { rootPinId, hAct2: 190_300 });
  assert.equal(gated.nodeStates.t1.submission.pinId, 'superseded01i0');
  assert.ok(gated.ignoredEvents.some((e) => e.pinId === 'superseder02i0' && e.reason === 'supersede_predicate_failed'));
});

test('amend: publisher folds ops; frozen and non-publisher amends ignored', () => {
  const { tree, task, rootPinId, treePinId } = buildTask(); // r1:3000 t1:4000... (t1:7000)
  const validAmend = ev(
    'amend',
    {
      taskid: rootPinId,
      bases: treePinId,
      ops: [
        { op: 'reweight', node: 't1', weight: 6000 },
        { op: 'add_node', node: { id: 't2', parent: 'r1', title: 'added', kind: 'proof', specid: null, params: {}, deps: [], weight: 1000 } },
      ],
    },
    { author: P, height: 190_210 }
  );
  const projection = replayMetaTask([tree, task, validAmend], { rootPinId, hAct2: 190_200 });
  const t2 = projection.nodes.find((node) => node.id === 't2');
  assert.ok(t2, 'add_node applied');
  assert.equal(t2.weight, 1000);
  assert.equal(projection.nodes.find((node) => node.id === 't1').weight, 6000);

  // Once t1 is claimed it is frozen: reweight ignored, whole amend drops.
  const claim = claimOn(rootPinId, 't1', S, { height: 190_215 });
  const frozenAmend = ev(
    'amend',
    { taskid: rootPinId, bases: validAmend.pinId, ops: [{ op: 'reweight', node: 't1', weight: 5000 }] },
    { author: P, height: 190_220 }
  );
  const frozen = replayMetaTask([tree, task, validAmend, claim, frozenAmend], { rootPinId, hAct2: 190_200 });
  assert.equal(frozen.nodes.find((node) => node.id === 't1').weight, 6000);
  assert.ok(frozen.ignoredEvents.some((e) => e.pinId === frozenAmend.pinId && e.reason === 'amend_invariant_violation'));

  // Non-publisher amend: ignored outright.
  const rogue = ev(
    'amend',
    { taskid: rootPinId, bases: validAmend.pinId, ops: [{ op: 'reweight', node: 't2', weight: 900 }] },
    { author: S, height: 190_225 }
  );
  const guarded = replayMetaTask([tree, task, validAmend, rogue], { rootPinId, hAct2: 190_200 });
  assert.equal(guarded.nodes.find((node) => node.id === 't2').weight, 1000);
  assert.ok(guarded.ignoredEvents.some((e) => e.pinId === rogue.pinId && e.reason === 'amend_not_publisher'));
});

test('challenge: holdout blocks settlement; withdraw and expiry lift it', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 1 });
  const claim = claimOn(rootPinId, 't1', S, { height: 190_300 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_310, pinId: 'challengedsub0i0' });
  const claimR = claimOn(rootPinId, 'r1', S, { height: 190_315 });
  const subR = submitOn(rootPinId, 'r1', claimR.pinId, S, { height: 190_316, childIds: ['challengedsub0i0'] });
  const base = [
    tree,
    task,
    claim,
    sub,
    voteOn('challengedsub0i0', 'pass', R1, { height: 190_320 }),
    claimR,
    subR,
    voteOn(subR.pinId, 'pass', R2, { height: 190_321 }),
  ];
  const challenge = ev(
    'challenge',
    { targetid: 'challengedsub0i0', category: 'correctness', reason: 'lemma gap', evidence: 'metafile://abc' },
    { author: C, height: 190_330, timestampMs: 1_790_000_000_000 }
  );

  const held = replayMetaTask([...base, challenge], { rootPinId, hAct2: 190_200 });
  assert.equal(held.taskComplete, true);
  assert.equal(held.nodeStates.t1.disputed, true);
  assert.equal(held.settlement, null, 'open challenge blocks finalization');

  const withdrawn = ev(
    'challenge',
    { targetid: 'challengedsub0i0', category: 'correctness', reason: 'withdraw', evidence: 'metafile://abc', withdraw: true },
    { author: C, height: 190_340 }
  );
  const lifted = replayMetaTask([...base, challenge, withdrawn], { rootPinId, hAct2: 190_200 });
  assert.ok(lifted.settlement, 'withdrawn challenge lifts the holdout');

  const nowPast = 1_790_000_000_000 + 15 * 86_400_000; // > default 14d TTL
  const expired = replayMetaTask([...base, challenge], { rootPinId, hAct2: 190_200, now: nowPast });
  assert.ok(expired.settlement, 'expired challenge equals withdrawal');
});

// ── eventSetHash determinism ─────────────────────────────────────────────────

test('eventSetHash: order-independent input, deterministic output', () => {
  const { events, rootPinId } = settledTwoNodeTask();
  const forward = replayMetaTask(events, { rootPinId });
  const shuffled = [...events].reverse();
  const backward = replayMetaTask(shuffled, { rootPinId });
  assert.equal(forward.freshness.eventSetHash, backward.freshness.eventSetHash);
  assert.equal(forward.freshness.boundaryBlock, 190_151);
  assert.match(forward.freshness.eventSetHash, /^[0-9a-f]{64}$/);
});

// ── v1.2.1: aggregation precondition (registration paths.aggregationPrecondition) ──

const buildAggregationTask = (over = {}) => {
  const nodes = [
    { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
    { id: 't1', parent: 'r1', title: 'a', kind: 'proof', specid: null, params: {}, deps: [], weight: 3500 },
    { id: 't2', parent: 'r1', title: 'b', kind: 'proof', specid: null, params: {}, deps: [], weight: 3500 },
  ];
  return buildTask({ nodes, quorum: 1, ...over });
};

const aggEvents = ({ base, t2Verified, childIds }) => {
  const { tree, task, rootPinId } = buildAggregationTask();
  const c1 = claimOn(rootPinId, 't1', S, { height: base + 10 });
  const s1 = submitOn(rootPinId, 't1', c1.pinId, S, { height: base + 11, pinId: 'aggt1sub00000000000000000000000000i0' });
  const v1 = voteOn('aggt1sub00000000000000000000000000i0', 'pass', R1, { height: base + 12 });
  const events = [tree, task, c1, s1, v1];
  if (t2Verified) {
    const c2 = claimOn(rootPinId, 't2', S, { height: base + 13 });
    const s2 = submitOn(rootPinId, 't2', c2.pinId, S, { height: base + 14, pinId: 'aggt2sub00000000000000000000000000i0' });
    const v2 = voteOn('aggt2sub00000000000000000000000000i0', 'pass', R2, { height: base + 15 });
    events.push(c2, s2, v2);
  } else {
    events.push(claimOn(rootPinId, 't2', R2, { height: base + 13 }));
  }
  const cr = claimOn(rootPinId, 'r1', S, { height: base + 20 });
  const sr = submitOn(rootPinId, 'r1', cr.pinId, S, { height: base + 21, childIds });
  const vr = voteOn(sr.pinId, 'pass', R1, { height: base + 22 });
  events.push(cr, sr, vr);
  return { events, rootPinId };
};

test('v1.2.1 aggregation precondition: unverified child blocks the parent (H_ACT2 era)', () => {
  const { events, rootPinId } = aggEvents({ base: 191_600, t2Verified: false, childIds: ['aggt1sub00000000000000000000000000i0'] });
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t2.status, 'claimed');
  // Parent passed its own quorum but the precondition demotes it: not verified.
  assert.equal(projection.nodeStates.r1.status, 'claimed');
  assert.equal(projection.taskComplete, false);
  assert.equal(projection.settlement, null);
});

test('v1.2.1 aggregation precondition: pre-H_ACT2 parent grandfathered (pilot #01 pattern)', () => {
  const { events, rootPinId } = aggEvents({ base: 189_600, t2Verified: false, childIds: ['aggt1sub00000000000000000000000000i0'] });
  const projection = replayMetaTask(events, { rootPinId });
  // Grandfathered: the parent keeps its recorded vote-level verified state.
  assert.equal(projection.nodeStates.r1.status, 'verified');
  assert.equal(projection.taskComplete, true); // root verified, even though t2 is not
  assert.equal(projection.progress.verified, 2); // r1 + t1 only
});

test('v1.2.1 aggregation precondition: all children verified + childids match -> parent verified + settlement', () => {
  const { events, rootPinId } = aggEvents({
    base: 191_600,
    t2Verified: true,
    childIds: ['aggt1sub00000000000000000000000000i0', 'aggt2sub00000000000000000000000000i0'],
  });
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.nodeStates.r1.status, 'verified');
  assert.equal(projection.taskComplete, true);
  assert.ok(projection.settlement);
  const total = projection.settlement.shares.reduce((sum, s) => sum + s.shareBP, 0);
  assert.equal(total, 10000);
});

test('v1.2.1 aggregation precondition: childids mismatch blocks the parent', () => {
  const { events, rootPinId } = aggEvents({
    base: 191_600,
    t2Verified: true,
    childIds: ['aggt1sub00000000000000000000000000i0', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefi0'],
  });
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t2.status, 'verified');
  assert.equal(projection.nodeStates.r1.status, 'claimed'); // listed set != children's verified pins
  assert.equal(projection.taskComplete, false);
});

test('v1.2.2 ruling 2: the top-level↔result childids MIRROR comparison is positional', () => {
  const t1pin = 'aggt1sub00000000000000000000000000i0';
  const t2pin = 'aggt2sub00000000000000000000000000i0';
  const aggMirrorEvents = ({ topIds, resultIds }) => {
    const { tree, task, rootPinId } = buildAggregationTask();
    const c1 = claimOn(rootPinId, 't1', S, { height: 191_610 });
    const s1 = submitOn(rootPinId, 't1', c1.pinId, S, { height: 191_611, pinId: t1pin });
    const v1 = voteOn(t1pin, 'pass', R1, { height: 191_612 });
    const c2 = claimOn(rootPinId, 't2', S, { height: 191_613 });
    const s2 = submitOn(rootPinId, 't2', c2.pinId, S, { height: 191_614, pinId: t2pin });
    const v2 = voteOn(t2pin, 'pass', R2, { height: 191_615 });
    const cr = claimOn(rootPinId, 'r1', S, { height: 191_620 });
    const sr = ev(
      'submission',
      {
        taskid: rootPinId,
        node: 'r1',
        claimid: cr.pinId,
        result: { type: 'table', hash: '0'.repeat(64), rows: [], childids: resultIds },
        hash: '1'.repeat(64),
        contentType: 'application/json;utf-8',
        attachment: null,
        childids: topIds,
      },
      { author: S, height: 191_621, pinId: 'aggrsubmirror0000000000000000000000i0' }
    );
    const vr = voteOn(sr.pinId, 'pass', R1, { height: 191_622 });
    return { events: [tree, task, c1, s1, v1, c2, s2, v2, cr, sr, vr], rootPinId };
  };

  // Mirror positionally equal (same order): precondition can pass.
  {
    const { events, rootPinId } = aggMirrorEvents({ topIds: [t1pin, t2pin], resultIds: [t1pin, t2pin] });
    const projection = replayMetaTask(events, { rootPinId });
    assert.equal(projection.nodeStates.r1.status, 'verified');
  }
  // Mirror same elements but reordered: precondition FAILS (mirror is
  // positional, even though the precondition set-compare itself is not).
  {
    const { events, rootPinId } = aggMirrorEvents({ topIds: [t1pin, t2pin], resultIds: [t2pin, t1pin] });
    const projection = replayMetaTask(events, { rootPinId });
    assert.equal(projection.nodeStates.r1.status, 'claimed');
    assert.equal(projection.taskComplete, false);
  }
  // Only result.childids present: precondition set-compare stays order-insensitive.
  {
    const { tree, task, rootPinId } = buildAggregationTask();
    const c1 = claimOn(rootPinId, 't1', S, { height: 191_610 });
    const s1 = submitOn(rootPinId, 't1', c1.pinId, S, { height: 191_611, pinId: t1pin });
    const v1 = voteOn(t1pin, 'pass', R1, { height: 191_612 });
    const c2 = claimOn(rootPinId, 't2', S, { height: 191_613 });
    const s2 = submitOn(rootPinId, 't2', c2.pinId, S, { height: 191_614, pinId: t2pin });
    const v2 = voteOn(t2pin, 'pass', R2, { height: 191_615 });
    const cr = claimOn(rootPinId, 'r1', S, { height: 191_620 });
    const sr = ev(
      'submission',
      {
        taskid: rootPinId,
        node: 'r1',
        claimid: cr.pinId,
        result: { type: 'table', hash: '0'.repeat(64), rows: [], childids: [t2pin, t1pin] },
        hash: '1'.repeat(64),
        contentType: 'application/json;utf-8',
        attachment: null,
      },
      { author: S, height: 191_621, pinId: 'aggrsubsetonly000000000000000000000i0' }
    );
    const vr = voteOn(sr.pinId, 'pass', R1, { height: 191_622 });
    const projection = replayMetaTask([tree, task, c1, s1, v1, c2, s2, v2, cr, sr, vr], { rootPinId });
    assert.equal(projection.nodeStates.r1.status, 'verified');
  }
});

test('v1.2.1 amend: conflict on shared bases, stale on foreign bases', () => {
  const { tree, task, rootPinId, treePinId } = buildTask();
  const first = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [{ op: 'retitle', node: 't1', title: 'renamed once' }] },
    { author: P, height: 191_610 }
  );
  const conflicting = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [{ op: 'retitle', node: 't1', title: 'renamed twice' }] },
    { author: P, height: 191_620 }
  );
  const stale = ev(
    'amend',
    { taskid: rootPinId, bases: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0', ops: [{ op: 'retitle', node: 't1', title: 'x' }] },
    { author: P, height: 191_630 }
  );
  const projection = replayMetaTask([tree, task, first, conflicting, stale], { rootPinId });
  assert.equal(projection.nodes.find((node) => node.id === 't1').title, 'renamed once');
  const reasons = Object.fromEntries(projection.ignoredEvents.map((e) => [e.pinId, e.reason]));
  assert.equal(reasons[conflicting.pinId], 'amend_conflict');
  assert.equal(reasons[stale.pinId], 'amend_stale');
});

// ── consensus-critical: ghost claims / effective-tree membership ─────────────
// A claim (or release/submission) naming a node that is not in the task's
// effective (post-amend) tree is a chain fact about a node this task does not
// have. It must not create node state, appear in openNodes, inflate
// progress.total, or force the settlement weight table off the tree weights.

const sharesOf = (projection) =>
  Object.fromEntries(projection.settlement.shares.map((share) => [share.metaId, share]));

/** r1 (3000 aggregate) + t1 (7000 leaf), both submitted by S and verified. */
const verifiedTwoNodeEvents = () => {
  const { tree, task, rootPinId } = buildTask();
  const claimT1 = claimOn(rootPinId, 't1', S, { height: 190_100 });
  const subT1 = submitOn(rootPinId, 't1', claimT1.pinId, S, { height: 190_110 });
  const claimR1 = claimOn(rootPinId, 'r1', S, { height: 190_120 });
  const subR1 = submitOn(rootPinId, 'r1', claimR1.pinId, S, { height: 190_130 });
  const events = [
    tree,
    task,
    claimT1,
    subT1,
    voteOn(subT1.pinId, 'pass', R1, { height: 190_140 }),
    voteOn(subT1.pinId, 'pass', R2, { height: 190_141 }),
    claimR1,
    subR1,
    voteOn(subR1.pinId, 'pass', R1, { height: 190_150 }),
    voteOn(subR1.pinId, 'pass', R2, { height: 190_151 }),
  ];
  return { events, rootPinId };
};

test('ghost claim: an invented node id never creates state or poisons the weight table', () => {
  const { events, rootPinId } = verifiedTwoNodeEvents();
  const ghost = claimOn(rootPinId, 'invented-node', R2, { height: 190_135 });
  // Ghost claim interleaved BEFORE the task is fully verified.
  const projection = replayMetaTask([...events, ghost], { rootPinId });

  assert.equal(projection.progress.total, 2, 'progress.total counts effective-tree nodes only');
  assert.deepEqual(Object.keys(projection.nodeStates).sort(), ['r1', 't1']);
  assert.equal(projection.nodeStates['invented-node'], undefined);
  assert.equal(projection.nodes.length, 2);
  assert.ok(projection.ignoredEvents.some((e) => e.pinId === ghost.pinId && e.reason === 'unknown_node'));
  // ...and the ghost claimant is not credited with a claim.
  assert.equal(projection.participants.find((p) => p.metaId === R2).effectiveClaims, 0);

  // The 8000/1000/1000 split survives; without the filter nodeCount would be 3
  // and every task would silently fall back to uniform floor(10000/3) weights.
  assert.equal(projection.taskComplete, true);
  const shares = sharesOf(projection);
  assert.equal(shares[S].from.submittedBP, 8000);
  assert.equal(shares[R1].from.reviewedBP, 1000);
  assert.equal(shares[R2].from.reviewedBP, 1000);
  assert.equal(projection.settlement.weightsTableHash, replayMetaTask(events, { rootPinId }).settlement.weightsTableHash);
});

test('ghost claim: arriving AFTER verification changes neither progress nor the split', () => {
  const { events, rootPinId } = verifiedTwoNodeEvents();
  const clean = replayMetaTask(events, { rootPinId });
  const ghost = claimOn(rootPinId, 'invented-node', C, { height: 190_400 });
  const poisoned = replayMetaTask([...events, ghost], { rootPinId });

  assert.ok(poisoned.ignoredEvents.some((e) => e.pinId === ghost.pinId && e.reason === 'unknown_node'));
  assert.deepEqual(poisoned.progress, clean.progress);
  assert.deepEqual(Object.keys(poisoned.nodeStates).sort(), Object.keys(clean.nodeStates).sort());
  assert.deepEqual(poisoned.settlement.shares, clean.settlement.shares);
  assert.equal(poisoned.settlement.weightsTableHash, clean.settlement.weightsTableHash);
});

test('amend remove_node: the removed node stops being claimable, counted, or weighted', () => {
  const { tree, task, rootPinId, treePinId } = buildTask(); // r1:3000, t1:7000
  const amend = ev(
    'amend',
    {
      taskid: rootPinId,
      bases: treePinId,
      ops: [
        { op: 'remove_node', node: 't1' },
        { op: 'reweight', node: 'r1', weight: 10000 },
      ],
    },
    { author: P, height: 191_610 }
  );
  const amended = replayMetaTask([tree, task, amend], { rootPinId });
  // The effective tree (the settlement weight source) is exactly one node at
  // 10000bp: the amended-away node leaves no residual row and no uniform
  // floor(10000/2) fallback.
  assert.deepEqual(amended.nodes.map((node) => [node.id, node.weight]), [['r1', 10000]]);
  assert.equal(amended.nodeStates.t1, undefined);
  assert.equal(amended.progress.total, 1);
  assert.equal(amended.progress.open, 1);

  // A claim that was valid when published but whose node the amend removed is
  // simply dropped (no crash, no zombie "open" node)...
  const zombieClaim = claimOn(rootPinId, 't1', S, { height: 191_620 });
  const withZombie = replayMetaTask([tree, task, amend, zombieClaim], { rootPinId });
  assert.equal(withZombie.nodeStates.t1, undefined);
  assert.ok(withZombie.ignoredEvents.some((e) => e.pinId === zombieClaim.pinId && e.reason === 'unknown_node'));
  assert.deepEqual(withZombie.progress, amended.progress);
  assert.equal(withZombie.participants.find((p) => p.metaId === S)?.effectiveClaims ?? 0, 0);
  // ...and the node is not claimable: the claimable set is the effective tree.
  assert.deepEqual(
    Object.values(withZombie.nodeStates).filter((node) => node.status === 'open').map((node) => node.id),
    ['r1']
  );
});

test('amend remove_node: an effective amend and a verified root cannot coexist (deferred hindsight fold)', () => {
  const { tree, task, rootPinId, treePinId } = buildTask({ quorum: 1 });
  const amend = ev(
    'amend',
    {
      taskid: rootPinId,
      bases: treePinId,
      ops: [
        { op: 'remove_node', node: 't1' },
        { op: 'reweight', node: 'r1', weight: 10000 },
      ],
    },
    { author: P, height: 191_610 }
  );
  const claimR1 = claimOn(rootPinId, 'r1', S, { height: 191_620 });
  const subR1 = submitOn(rootPinId, 'r1', claimR1.pinId, S, { height: 191_621 });
  const pass = voteOn(subR1.pinId, 'pass', R1, { height: 191_622 });
  const projection = replayMetaTask([tree, task, amend, claimR1, subR1, pass], { rootPinId });

  // DEFERRED (out of scope; protocol v1.2.2 ruling pending): the amend fold
  // reads the hindsight vote-level verified set, so NO amend folds once the
  // initial root has been vote-verified — which is exactly the situation in
  // which a settlement manifest exists. Pinned as an observation so the
  // deferred fix has to update this expectation deliberately. Consequence for
  // the effective-tree filter: the removed node's weight can never have been
  // silently replaced by uniform weights (settlement cannot be reached), but
  // the node id used to leak into progress/openNodes — covered above.
  assert.ok(
    projection.ignoredEvents.some((e) => e.pinId === amend.pinId && e.reason === 'amend_task_finalized')
  );
  assert.deepEqual(projection.nodes.map((node) => node.id), ['r1', 't1']);
});

// ── consensus-critical: reviewer accuracy identity filter ────────────────────

test('reviewer accuracy: a bot self-votes without changing a(r) or the manifest', () => {
  // t1 is submitted by S and reviewed by R1; r1 is submitted by R2 and reviewed
  // by S and R1 (quorum 1). The submitter of t1 (S) is therefore a REAL
  // reviewer elsewhere, so its Laplace accuracy a(r) moves the split of r1.
  const build = (selfVotes) => {
    const { tree, task, rootPinId } = buildTask({ quorum: 1 });
    const claimT1 = claimOn(rootPinId, 't1', S, { height: 190_100 });
    const subT1 = submitOn(rootPinId, 't1', claimT1.pinId, S, { height: 190_110, pinId: 'accfiltert1sub00000000000000000000i0' });
    const claimR1 = claimOn(rootPinId, 'r1', R2, { height: 190_120 });
    const subR1 = submitOn(rootPinId, 'r1', claimR1.pinId, R2, { height: 190_130, pinId: 'accfilterr1sub00000000000000000000i0' });
    const events = [
      tree,
      task,
      claimT1,
      subT1,
      voteOn(subT1.pinId, 'pass', R1, { height: 190_140 }),
      claimR1,
      subR1,
      voteOn(subR1.pinId, 'pass', S, { height: 190_150 }),
      voteOn(subR1.pinId, 'pass', R1, { height: 190_151 }),
      ...selfVotes(subT1.pinId),
    ];
    return replayMetaTask(events, { rootPinId });
  };

  const baseline = build(() => []);
  // S votes fail-then-pass on its OWN submission: the fail is dropped by
  // last-valid-vote resolution and the pass must be identity-filtered.
  const withSelfVotes = build((target) => [
    voteOn(target, 'fail', S, { height: 190_160 }),
    voteOn(target, 'pass', S, { height: 190_161 }),
  ]);

  assert.equal(baseline.taskComplete, true);
  assert.equal(withSelfVotes.taskComplete, true);
  const selfStats = withSelfVotes.participants.find((p) => p.metaId === S);
  const baseStats = baseline.participants.find((p) => p.metaId === S);
  assert.equal(selfStats.reviewCorrect, baseStats.reviewCorrect);
  assert.equal(selfStats.reviewTerminal, baseStats.reviewTerminal);
  // Self votes are not review participation either (node view `counted=false`).
  assert.equal(selfStats.reviewVotes, baseStats.reviewVotes);
  assert.deepEqual(withSelfVotes.settlement.shares, baseline.settlement.shares);
  assert.equal(withSelfVotes.settlement.weightsTableHash, baseline.settlement.weightsTableHash);
  // Sanity: with the self-vote counted, S's smoothed accuracy would be 7500
  // instead of the honest 6666 (1 correct of 1 terminal) — assert the honest
  // value is what the split is computed from.
  assert.equal(Math.floor((10000 * (selfStats.reviewCorrect + 1)) / (selfStats.reviewTerminal + 2)), 6666);
});

// ── consensus-critical: participation visibility (reviewVotes) ───────────────

test('participation: a counted vote on a still-open cycle is review activity', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 2 });
  const claim = claimOn(rootPinId, 't1', S, { height: 190_100 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_110 });
  const onePass = voteOn(sub.pinId, 'pass', R1, { height: 190_120 }); // still open: 1 < quorum 2
  const projection = replayMetaTask([tree, task, claim, sub, onePass], { rootPinId });

  assert.equal(projection.nodeStates.t1.status, 'claimed');
  const stats = projection.participants.find((p) => p.metaId === R1);
  assert.equal(stats.reviewVotes, 1, 'open-cycle votes are participation');
  // Accuracy inputs stay terminal-only.
  assert.equal(stats.reviewTerminal, 0);
  assert.equal(stats.reviewCorrect, 0);
});

// ── same-side roster (H_ACT2-gated), fed by collected roster pins ────────────

test('roster: the collector-shaped roster pin filters same-side votes at/after H_ACT2 only', () => {
  const rosterPinId = 'rosterpin00000000000000000000000000000000000000000000001i0';
  const peerOfSubmitter = 'idq1peerbotaa';
  const peerOfPublisher = 'idq1peerbotbb';
  // Exactly the body `metatask_publish` writes, round-tripped through the
  // collector's contentBody base64 decoding.
  const rosterBody = {
    groups: [[S, peerOfSubmitter], [P, peerOfPublisher]],
    owner: 'idbots-local-roster',
    createdAt: 1_790_000_000_000,
  };
  const rosterEvent = normalizeChainEvent(
    rosterPinId,
    {
      id: rosterPinId,
      path: '/protocols/metatask-roster',
      globalMetaId: P,
      genesisHeight: 191_400,
      txIndex: 0,
      timestamp: 1_790_000_000_000,
      contentBody: Buffer.from(JSON.stringify(rosterBody)).toString('base64'),
    },
    null
  );
  assert.equal(rosterEvent.path, 'metatask-roster');
  assert.deepEqual(rosterEvent.body, rosterBody);
  const rosterPins = rosterPinsFromEvents([rosterEvent]);
  assert.deepEqual(Object.keys(rosterPins), [rosterPinId]);

  const { tree, task, rootPinId } = buildTask({
    quorum: 1,
    split: { submitterShareBP: 8000, rosterid: rosterPinId },
  });
  const claim = claimOn(rootPinId, 't1', S, { height: 191_600 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 191_601 });
  const sameSideSubmitter = voteOn(sub.pinId, 'pass', peerOfSubmitter, { height: 191_602 });
  const sameSidePublisher = voteOn(sub.pinId, 'pass', peerOfPublisher, { height: 191_603 });
  const independent = voteOn(sub.pinId, 'pass', R1, { height: 191_604 });

  const gated = replayMetaTask([tree, task, claim, sub, sameSideSubmitter, sameSidePublisher], {
    rootPinId,
    rosterPins,
  });
  assert.equal(gated.nodeStates.t1.status, 'claimed', 'same-side passes do not reach quorum');
  const reasons = Object.fromEntries(gated.ignoredEvents.map((entry) => [entry.pinId, entry.reason]));
  assert.equal(reasons[sameSideSubmitter.pinId], 'same_side_roster');
  assert.equal(reasons[sameSidePublisher.pinId], 'same_side_roster');

  const withIndependent = replayMetaTask([tree, task, claim, sub, sameSideSubmitter, sameSidePublisher, independent], {
    rootPinId,
    rosterPins,
  });
  assert.equal(withIndependent.nodeStates.t1.status, 'verified', 'an independent reviewer still counts');

  // No roster supplied (e.g. an unreachable roster pin) = no filtering.
  const unmapped = replayMetaTask([tree, task, claim, sub, sameSideSubmitter], { rootPinId });
  assert.equal(unmapped.nodeStates.t1.status, 'verified');

  // Below H_ACT2 the roster rule does not exist: the pilots stay byte-identical.
  const preClaim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const preSub = submitOn(rootPinId, 't1', preClaim.pinId, S, { height: 189_901 });
  const preAct2 = [
    tree,
    task,
    preClaim,
    preSub,
    voteOn(preSub.pinId, 'pass', peerOfSubmitter, { height: 189_902 }),
  ];
  const grandfathered = replayMetaTask(preAct2, { rootPinId, rosterPins });
  assert.equal(grandfathered.nodeStates.t1.status, 'verified');
  assert.ok(grandfathered.ignoredEvents.every((entry) => entry.reason !== 'same_side_roster'));
});

// ── collector: ten pools + manapi-safe page size ─────────────────────────────

test('collector: sweeps the ten pools (roster included) at page size 100', async () => {
  const rosterRawItem = {
    id: 'rosterpin00000000000000000000000000000000000000000000002i0',
    path: '/protocols/metatask-roster',
    globalMetaId: P,
    genesisHeight: 191_400,
    txIndex: 0,
    timestamp: 1_790_000_000_000,
    contentBody: Buffer.from(JSON.stringify({ groups: [[S]], owner: 'idbots-local-roster' })).toString('base64'),
  };
  const requestedPaths = new Set();
  const requestedSizes = new Set();
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    requestedPaths.add(parsed.searchParams.get('path'));
    requestedSizes.add(parsed.searchParams.get('size'));
    const list = parsed.searchParams.get('path') === '/protocols/metatask-roster' ? [rosterRawItem] : [];
    return new Response(JSON.stringify({ code: 1, data: { list } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const collected = await collectMetaTaskEvents({ fetchImpl });
  assert.deepEqual(
    collected.perPath.map((entry) => entry.path),
    [...METATASK_COLLECTED_PATHS]
  );
  assert.equal(collected.perPath.length, 10);
  assert.ok(requestedPaths.has('/protocols/metatask-roster'));
  assert.ok(!requestedPaths.has('/protocols/metatask/roster'));
  assert.deepEqual([...requestedSizes], ['100']);
  assert.equal(collected.events.length, 1);
  assert.equal(collected.events[0].path, 'metatask-roster');
  assert.deepEqual(collected.events[0].body.groups, [[S]]);
  assert.deepEqual(Object.keys(rosterPinsFromEvents(collected.events)), [rosterRawItem.id]);
});

// ── collector: content recovery (MAN-p2p f23e8ec truncated list rows) ────────
// List rows now carry a 4096-byte contentSummary, an empty contentBody and a
// `content` download URL. A truncated body silently drops every tree node, so
// the collector refetches exactly the rows that look truncated.

const CONTENT_HOST = 'https://manapi.metaid.io/content';

/** Fake indexer: serves one pool per path, plus the content URLs on demand. */
const collectWithIndexer = async (poolItems, contentBodies = {}) => {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/content/')) {
      const pinId = href.split('/content/').pop();
      const served = contentBodies[pinId];
      if (served === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(served), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const parsed = new URL(href);
    const segment = (parsed.searchParams.get('path') ?? '').split('/').pop();
    const list = poolItems.filter((item) => String(item.path).split('/').pop() === segment);
    return new Response(JSON.stringify({ code: 1, data: { list } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const collected = await collectMetaTaskEvents({ fetchImpl });
  return { collected, contentCalls: () => calls.filter((href) => href.includes('/content/')) };
};

const truncatedTreeRow = (pinId, body, over = {}) => {
  const json = JSON.stringify(body);
  return {
    id: pinId,
    path: '/protocols/metatask/tree',
    globalMetaId: P,
    genesisHeight: 189_900,
    txIndex: 0,
    timestamp: 1_790_000_000_000,
    contentSummary: over.contentSummary ?? json.slice(0, 4096),
    contentBody: '',
    content: `${CONTENT_HOST}/${pinId}`,
    contentLength: over.contentLength ?? Buffer.byteLength(json, 'utf8'),
  };
};

const bigTreeBody = () => ({
  root: 'r1',
  nodes: [
    { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
    { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 7000 },
  ],
  // Pushes the body past the 4096-byte summary window so the cut lands inside
  // this string and the truncated summary cannot parse.
  padding: 'x'.repeat(5_000),
});

test('collector: a truncated summary is recovered from the content URL (one request)', async () => {
  const full = bigTreeBody();
  const row = truncatedTreeRow('treebig0000001i0', full);
  const { collected, contentCalls } = await collectWithIndexer([row], { treebig0000001i0: full });

  const event = collected.events.find((candidate) => candidate.pinId === 'treebig0000001i0');
  assert.deepEqual(event.body, full, 'the full body replaced the truncated summary');
  assert.deepEqual(contentCalls(), [`${CONTENT_HOST}/treebig0000001i0`]);

  // A summary that still parses but is provably shorter than the declared body
  // is recovered too (same pin ids/heights, only the body differs).
  const shortRow = truncatedTreeRow('treeshort000001i0', full, {
    contentSummary: '{"root":"r1","nodes":[]}',
    contentLength: 18_660,
  });
  const second = await collectWithIndexer([shortRow], { treeshort000001i0: full });
  assert.deepEqual(second.collected.events[0].body, full);
  assert.equal(second.contentCalls().length, 1);
});

test('collector: a complete inline body costs zero content requests', async () => {
  const small = {
    root: 'r1',
    nodes: [{ id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 10_000 }],
  };
  const exact = truncatedTreeRow('treesmall00001i0', small, {
    contentSummary: JSON.stringify(small),
    contentLength: Buffer.byteLength(JSON.stringify(small), 'utf8'),
  });
  // JSON escaping can shift the byte count by a few bytes: inside the margin
  // the summary is still treated as complete.
  const withinMargin = truncatedTreeRow('treesmall00002i0', small, {
    contentSummary: JSON.stringify(small),
    contentLength: Buffer.byteLength(JSON.stringify(small), 'utf8') + 8,
  });
  // A pre-f23e8ec row carrying the full base64 body never qualifies either.
  const legacy = {
    id: 'treelegacy0001i0',
    path: '/protocols/metatask/tree',
    globalMetaId: P,
    genesisHeight: 189_900,
    txIndex: 0,
    timestamp: 1_790_000_000_000,
    contentSummary: JSON.stringify(small).slice(0, 10),
    contentBody: Buffer.from(JSON.stringify(small)).toString('base64'),
    content: `${CONTENT_HOST}/treelegacy0001i0`,
    contentLength: 5_000,
  };

  const { collected, contentCalls } = await collectWithIndexer([exact, withinMargin, legacy], {});
  assert.equal(contentCalls().length, 0, 'healthy rows never hit the content endpoint');
  for (const pinId of ['treesmall00001i0', 'treesmall00002i0', 'treelegacy0001i0']) {
    assert.deepEqual(
      collected.events.find((event) => event.pinId === pinId).body,
      small,
      `${pinId} parsed from its inline body`
    );
  }
});

test('collector: a failing content fetch keeps the inline body and the sweep completes', async () => {
  const row = truncatedTreeRow('treefail00001i0', bigTreeBody());
  const { collected, contentCalls } = await collectWithIndexer([row], {});

  assert.equal(contentCalls().length, 1, 'the recovery was attempted');
  const event = collected.events.find((candidate) => candidate.pinId === 'treefail00001i0');
  assert.deepEqual(event.body, {}, 'no body to keep — the truncated summary never parsed');
  assert.equal(collected.perPath.length, 10, 'the sweep still completed every pool');
});

// ── mid-task share estimates (estimate.ts) ───────────────────────────────────
// estimateMetaTaskShares is a pure derivation over a projection: it must
// reproduce the settlement formula exactly (so a completed task's estimate
// equals its manifest) while also answering "if it settled now" mid-task.

const normalizeShares = (shares) =>
  [...shares]
    .map((share) => ({ metaId: share.metaId, shareBP: share.shareBP, from: { ...share.from } }))
    .sort((a, b) => (a.metaId < b.metaId ? -1 : 1));

test('estimation: mid-task estimate matches the hand-computed split', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 1 }); // r1:3000, t1:7000
  const claim = claimOn(rootPinId, 't1', S, { height: 190_100 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_110 });
  const pass = voteOn(sub.pinId, 'pass', R1, { height: 190_120 });
  const projection = replayMetaTask([tree, task, claim, sub, pass], { rootPinId });

  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.r1.status, 'open');
  assert.equal(projection.settlement, null, 'mid-task: the root is not verified yet');
  assert.equal('estimation' in projection, false, 'replay output never carries estimation');

  const estimation = estimateMetaTaskShares(projection);
  assert.equal(estimation.basis, 'weighted');
  // t1 carries 7000bp: submitter floor(7000*8000/10000) = 5600, pool 1400.
  // R1's accuracy: 1 correct of 1 terminal -> floor(10000*2/3) = 6666, so the
  // single reviewer takes the whole pool.
  assert.deepEqual(estimation.shares, [
    { metaId: S, shareBP: 5600, from: { submittedBP: 5600, reviewedBP: 0 } },
    { metaId: R1, shareBP: 1400, from: { submittedBP: 0, reviewedBP: 1400 } },
  ]);
  // Only verified nodes pay out: the estimate sums to t1's weight, not 10000.
  assert.equal(estimation.shares.reduce((sum, share) => sum + share.shareBP, 0), 7000);
});

test('estimation: on a completed task the estimate equals the manifest, exactly', () => {
  const { events, rootPinId } = settledTwoNodeTask();
  const projection = replayMetaTask(events, { rootPinId });
  assert.ok(projection.settlement, 'fixture must settle');

  const estimation = estimateMetaTaskShares(projection);
  assert.equal(estimation.basis, 'weighted');
  assert.deepEqual(normalizeShares(estimation.shares), normalizeShares(projection.settlement.shares));
  assert.equal(estimation.shares.reduce((sum, share) => sum + share.shareBP, 0), 10000);
});

test('estimation: the persisted σ drives both the estimate and the manifest', () => {
  const buildCompleted = (split) => {
    const { tree, task, rootPinId } = buildTask({ quorum: 1, ...(split ? { split } : {}) });
    const claimT1 = claimOn(rootPinId, 't1', S, { height: 190_100 });
    const subT1 = submitOn(rootPinId, 't1', claimT1.pinId, S, { height: 190_110 });
    const claimR1 = claimOn(rootPinId, 'r1', S, { height: 190_120 });
    const subR1 = submitOn(rootPinId, 'r1', claimR1.pinId, S, { height: 190_130 });
    return replayMetaTask(
      [tree, task, claimT1, subT1, voteOn(subT1.pinId, 'pass', R1, { height: 190_140 }), claimR1, subR1, voteOn(subR1.pinId, 'pass', R1, { height: 190_150 })],
      { rootPinId }
    );
  };

  // σ = 6500 (inside the clamp): t1 4550 + r1 1950 to S, pools 2450 + 1050 to R1.
  const custom = buildCompleted({ submitterShareBP: 6500 });
  assert.equal(custom.policy.submitterShareBP, 6500);
  const customEstimate = estimateMetaTaskShares(custom);
  assert.deepEqual(
    customEstimate.shares.map((share) => [share.metaId, share.shareBP]),
    [[S, 6500], [R1, 3500]]
  );
  assert.deepEqual(normalizeShares(customEstimate.shares), normalizeShares(custom.settlement.shares));

  // Out-of-range σ clamps exactly like the engine (6000 floor / 9000 ceiling).
  assert.equal(buildCompleted({ submitterShareBP: 5000 }).policy.submitterShareBP, 6000);
  assert.equal(buildCompleted({ submitterShareBP: 9500 }).policy.submitterShareBP, 9000);
  // No split block at all: the protocol default.
  assert.equal(buildCompleted(null).policy.submitterShareBP, 8000);

  // A projection persisted BEFORE the σ field existed falls back to 8000 (the
  // documented caveat: a custom-split task's estimate assumes the default split
  // until the next refresh rewrites the projection).
  const stale = { ...custom, policy: { ...custom.policy } };
  delete stale.policy.submitterShareBP;
  assert.deepEqual(
    estimateMetaTaskShares(stale).shares.map((share) => [share.metaId, share.shareBP]),
    [[S, 8000], [R1, 2000]]
  );
});

test('estimation: weight-null (legacy) trees use the uniform basis', () => {
  const nodes = ['a', 'b', 'c'].map((id, index) => ({
    id,
    parent: index === 0 ? null : 'a',
    title: id,
    kind: index === 0 ? 'aggregate' : 'proof',
    specid: null,
    params: {},
    deps: [],
    // no weight field: pre-H_ACT2 legacy task
  }));
  const treePinId = nextPinId();
  const rootPinId = nextPinId();
  const tree = ev('tree', { root: 'a', nodes }, { pinId: treePinId, author: P, height: 189_800 });
  const task = ev(
    'task',
    { title: 'legacy', treeid: treePinId, policy: { verify_quorum: 1, claim_ttl_hours: 48, verify_window_hours: 72 }, tags: [] },
    { pinId: rootPinId, author: P, height: 189_801 }
  );
  const submitters = { b: 'idq1legacybb', c: 'idq1legacycc', a: 'idq1legacyaa' };
  const reviewer = 'idq1legacyrev';
  const events = [tree, task];
  let afterFirstLeaf = 0;
  // Verify the leaves first so a prefix replay stays genuinely mid-task.
  for (const node of ['b', 'c', 'a']) {
    const claim = claimOn(rootPinId, node, submitters[node], { height: 189_900 + events.length });
    const sub = submitOn(rootPinId, node, claim.pinId, submitters[node], { height: 189_910 + events.length });
    events.push(claim, sub, voteOn(sub.pinId, 'pass', reviewer, { height: 189_920 + events.length }));
    if (node === 'b') afterFirstLeaf = events.length;
  }

  const partial = replayMetaTask(events.slice(0, afterFirstLeaf), { rootPinId });
  assert.equal(partial.taskComplete, false);
  const partialEstimate = estimateMetaTaskShares(partial);
  assert.equal(partialEstimate.basis, 'uniform');
  // uniform floor(10000/3) = 3333 per node; submitter floor(3333*8000/10000) = 2666,
  // pool 667 to the single reviewer.
  assert.deepEqual(
    partialEstimate.shares.map((share) => [share.metaId, share.shareBP]),
    [[submitters.b, 2666], [reviewer, 667]]
  );

  const full = replayMetaTask(events, { rootPinId });
  assert.equal(full.taskComplete, true);
  const fullEstimate = estimateMetaTaskShares(full);
  assert.equal(fullEstimate.basis, 'uniform');
  assert.deepEqual(normalizeShares(fullEstimate.shares), normalizeShares(full.settlement.shares));
  // Legacy uniform weights discard the residue: 3 x 3333 = 9999 distributed.
  assert.equal(fullEstimate.shares.reduce((sum, share) => sum + share.shareBP, 0), 9999);
});

test('estimation: an empty reviewer pool pays the whole node to the submitter', () => {
  // Defensive branch: a verified node always carries at least one counted pass
  // vote, so the engine cannot produce this state — the estimate must still
  // never strand the pool.
  const projection = {
    rootPinId: 'task-synthetic',
    publisher: P,
    nodes: [{ id: 't1', parent: null, title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 10000 }],
    nodeStates: {
      t1: {
        id: 't1',
        parent: null,
        title: 'leaf',
        kind: 'proof',
        weight: 10000,
        params: null,
        specid: null,
        status: 'verified',
        disputed: false,
        holder: null,
        submission: { pinId: 'synthetic-sub', submitter: S, atMs: 1, superseded: false, result: null, hash: null, contentType: null, attachment: null },
        passVotes: 0,
        failVotes: 0,
        votes: [],
        cycleCount: 1,
      },
    },
    participants: [],
    policy: { claimTtlHours: 0, verifyQuorum: 1, verifyWindowHours: 0, rewardSat: 0, challengeTtlDays: 14, hasSplit: false, rosterid: null, submitterShareBP: 8000 },
  };
  const estimation = estimateMetaTaskShares(projection);
  assert.equal(estimation.basis, 'weighted');
  assert.deepEqual(estimation.shares, [
    { metaId: S, shareBP: 10000, from: { submittedBP: 10000, reviewedBP: 0 } },
  ]);
});

test('estimation: the reviewer pool splits by Laplace accuracy a(r)', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 2 }); // r1:3000, t1:7000
  // Cycle 1: R1's pass is followed by R2's valid fail, so the cycle is
  // rejected and R1's vote counts as an inaccuracy in its history.
  const claim1 = claimOn(rootPinId, 't1', S, { height: 190_100 });
  const sub1 = submitOn(rootPinId, 't1', claim1.pinId, S, { height: 190_101, pinId: 'reviewsplit1i0' });
  const earlyPass = voteOn('reviewsplit1i0', 'pass', R1, { height: 190_110 });
  const fail = voteOn('reviewsplit1i0', 'fail', R2, { height: 190_111 });
  // Cycle 2 verifies with both reviewers.
  const claim2 = claimOn(rootPinId, 't1', S, { height: 190_120 });
  const sub2 = submitOn(rootPinId, 't1', claim2.pinId, S, { height: 190_121, pinId: 'reviewsplit2i0' });
  const passR1 = voteOn('reviewsplit2i0', 'pass', R1, { height: 190_130 });
  const passR2 = voteOn('reviewsplit2i0', 'pass', R2, { height: 190_131 });
  const projection = replayMetaTask(
    [tree, task, claim1, sub1, earlyPass, fail, claim2, sub2, passR1, passR2],
    { rootPinId }
  );

  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t1.submission.pinId, 'reviewsplit2i0');
  const stats = Object.fromEntries(projection.participants.map((participant) => [participant.metaId, participant]));
  // R1: 1 correct of 2 terminal -> 5000. R2: 2 correct of 2 -> 7500.
  assert.deepEqual([stats[R1].reviewCorrect, stats[R1].reviewTerminal], [1, 2]);
  assert.deepEqual([stats[R2].reviewCorrect, stats[R2].reviewTerminal], [2, 2]);

  const estimation = estimateMetaTaskShares(projection);
  // t1 pool = 7000 - 5600 = 1400, accSum 12500:
  // R1 floor(1400*5000/12500) = 560, R2 floor(1400*7500/12500) = 840.
  assert.deepEqual(estimation.shares, [
    { metaId: S, shareBP: 5600, from: { submittedBP: 5600, reviewedBP: 0 } },
    { metaId: R2, shareBP: 840, from: { submittedBP: 0, reviewedBP: 840 } },
    { metaId: R1, shareBP: 560, from: { submittedBP: 0, reviewedBP: 560 } },
  ]);
  assert.equal(estimation.shares.reduce((sum, share) => sum + share.shareBP, 0), 7000);
});
