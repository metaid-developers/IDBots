import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { replayMetaTask } = require('../dist-electron/main/services/metatask/engine.js');
const { estimateMetaTaskShares } = require('../dist-electron/main/services/metatask/estimate.js');
const { nextTimeDeadlineMs } = require('../dist-electron/main/services/metatask/deadlines.js');

/**
 * MetaTask TS engine — competitive mode (protocol v1.3.0 draft §3/§8).
 *
 * All fixtures live at heights ≥ 191_600 so the v1.2 features (H_ACT2) are
 * live and the #8/#9 vote gates (H_ACT) apply. The draft gates competitive
 * mode on H_ACT3 for WRITERS only; the replay side intentionally has no
 * height gate (see constants.ts) so these pre-activation fixtures replay.
 */

// ── event scaffolding ────────────────────────────────────────────────────────

let pinCounter = 0;
const nextPinId = () => `cpin${String(++pinCounter).padStart(4, '0')}i0`;

const ev = (path, body, over = {}) => ({
  pinId: over.pinId ?? nextPinId(),
  path,
  author: over.author ?? 'idq1cdefaultbot',
  height: over.height ?? 191_600,
  txIndex: over.txIndex ?? 0,
  timestampMs: over.timestampMs ?? 1_790_000_000_000,
  body,
});

const P = 'idq1cpublisher';
const S1 = 'idq1csubmitter1';
const S2 = 'idq1csubmitter2';
const S3 = 'idq1csubmitter3';
const R1 = 'idq1creviewer1';
const R2 = 'idq1creviewer2';
const R3 = 'idq1creviewer3';
const C = 'idq1cchallenger';

/**
 * Default competitive tree: entry nodes a/b (deps []), terminal root r
 * (deps [a, b]) — r is the unique deps-sink and the designated finalnode.
 * Weights a 4000 / b 4000 / r 2000 (Σ = 10000).
 */
const buildCompTask = (over = {}) => {
  const treePinId = over.treePinId ?? nextPinId();
  const rootPinId = over.rootPinId ?? nextPinId();
  const nodes = over.nodes ?? [
    { id: 'r', parent: null, title: 'terminal', kind: 'aggregate', specid: null, params: {}, deps: ['a', 'b'], weight: 2000 },
    { id: 'a', parent: 'r', title: 'entry a', kind: 'proof', specid: null, params: {}, deps: [], weight: 4000 },
    { id: 'b', parent: 'r', title: 'entry b', kind: 'proof', specid: null, params: {}, deps: [], weight: 4000 },
  ];
  const tree = ev('tree', { root: over.treeRoot ?? 'r', nodes }, { pinId: treePinId, author: P, height: 191_590 });
  const policy = {
    mode: 'competitive',
    finalnode: 'r',
    verify_quorum: over.quorum ?? 2,
    // Deliberately set: competitive mode must ignore both clocks (§3.10).
    claim_ttl_hours: 48,
    verify_window_hours: 72,
    challenge_ttl_days: 14,
    reward_sat: 0,
    split: { submitterShareBP: 8000 },
    ...(over.policyExtra ?? {}),
  };
  if (over.noFinalnode) delete policy.finalnode;
  const task = ev(
    'task',
    { title: over.title ?? 'competitive task', brief: '', treeid: treePinId, policy, tags: [] },
    { pinId: rootPinId, author: P, height: 191_591 }
  );
  return { tree, task, rootPinId, treePinId };
};

const compSubmit = (rootPinId, node, author, over = {}) => {
  const { parentrefs, supersedeid, ...eventOver } = over;
  const body = {
    taskid: rootPinId,
    node,
    result: { type: 'metafile', hash: 'ab'.repeat(32) },
    hash: 'cd'.repeat(32),
    contentType: 'application/json;utf-8',
    attachment: 'metafile://artifact',
    ...(parentrefs !== undefined ? { parentrefs } : {}),
    ...(supersedeid ? { supersedeid } : {}),
  };
  return ev('submission', body, { author, ...eventOver });
};

const passVote = (target, author, over = {}) =>
  ev(
    'verify',
    { targetid: target, verdict: 'pass', method: 'replayed spec; hashes match', semantic_check: 'statement matches' },
    { author, ...over }
  );

const failVote = (target, author, over = {}) =>
  ev(
    'verify',
    {
      targetid: target,
      verdict: 'fail',
      method: 'replayed spec; mismatch',
      semantic_check: 'statement mismatch',
      failreason: 'counterexample found',
    },
    { author, ...over }
  );

const claimOn = (rootPinId, node, author, over = {}) =>
  ev('claim', { taskid: rootPinId, node }, { author, ...over });

const candidateOf = (projection, node, pinId) =>
  (projection.nodeStates[node]?.submissions ?? []).find((entry) => entry.pinId === pinId);

// ── mode selection / tree-mode parity ────────────────────────────────────────

test('mode: absent and "tree" replay identically; competitive reports its engine version', () => {
  const nodes = [
    { id: 'r', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 10000 },
  ];
  const buildTreeTask = (modeField) => {
    const treePinId = nextPinId();
    const rootPinId = nextPinId();
    const tree = ev('tree', { root: 'r', nodes }, { pinId: treePinId, author: P, height: 191_590 });
    const task = ev(
      'task',
      {
        title: 't',
        treeid: treePinId,
        policy: { verify_quorum: 1, ...(modeField ? { mode: modeField } : {}) },
        tags: [],
      },
      { pinId: rootPinId, author: P, height: 191_591 }
    );
    return { tree, task, rootPinId };
  };
  const absent = buildTreeTask(undefined);
  const explicit = buildTreeTask('tree');
  // Same pin ids => the two replays must be byte-identical projections.
  explicit.tree.pinId = absent.tree.pinId;
  explicit.task.pinId = absent.task.pinId;
  explicit.task.body.treeid = absent.tree.pinId;
  const claim = claimOn(absent.task.pinId, 'r', S1, { height: 191_600 });
  const sub = compSubmit(absent.task.pinId, 'r', S1, { height: 191_601 });
  sub.body.claimid = claim.pinId;
  const vote = passVote(sub.pinId, R1, { height: 191_602 });
  const eventsA = [absent.tree, absent.task, claim, sub, vote];
  const eventsB = [explicit.tree, explicit.task, claim, sub, vote];
  const fixed = { evaluatedAtMs: 1_790_100_000_000 };
  const projA = replayMetaTask(eventsA, { rootPinId: absent.task.pinId, ...fixed });
  const projB = replayMetaTask(eventsB, { rootPinId: explicit.task.pinId, ...fixed });
  assert.equal(projA.policy.mode, 'tree');
  assert.deepEqual(projB, projA);
  assert.equal(projA.settlement.engineAlgoVersion, 'idbots-metatask-engine/1.2.1');
  assert.equal('mode' in projA.settlement, false, 'tree manifests omit mode/winningChain');
  assert.equal('winningChain' in projA.settlement, false);
  assert.equal(projA.progress.satisfied, 1, 'tree mode: satisfied === verified count');
  // An unknown mode value falls back to tree.
  const weird = buildTreeTask('tournament');
  weird.tree.pinId = absent.tree.pinId;
  weird.task.pinId = absent.task.pinId;
  weird.task.body.treeid = absent.tree.pinId;
  const projW = replayMetaTask([weird.tree, weird.task, claim, sub, vote], { rootPinId: weird.task.pinId });
  assert.equal(projW.policy.mode, 'tree');
  // Tree-mode node projections keep the v1.2.1 shape: no candidate list.
  assert.equal('submissions' in projA.nodeStates.r, false);
});

// ── §3.2 claims are intent only ──────────────────────────────────────────────

test('competitive: claims/releases carry no lock semantics and never expire work', () => {
  const { tree, task, rootPinId } = buildCompTask();
  // A claim by S1, then a submission by S2 WITHOUT any claim: both accepted,
  // the claim gates nothing. A release is a no-op.
  const claim = claimOn(rootPinId, 'a', S1, { height: 191_600, timestampMs: 1_790_000_000_000 });
  const release = ev('release', { taskid: rootPinId, node: 'a', claimid: claim.pinId }, { author: S1, height: 191_601 });
  const sub = compSubmit(rootPinId, 'a', S2, { height: 191_602 });
  const farFuture = 1_790_000_000_000 + 10_000 * 3_600_000; // way past claim_ttl_hours 48
  const projection = replayMetaTask([tree, task, claim, release, sub], { rootPinId, now: farFuture });
  const nodeA = projection.nodeStates.a;
  assert.equal(nodeA.holder, null, 'no lock state in competitive mode');
  assert.equal(nodeA.submissions.length, 1);
  assert.equal(nodeA.submissions[0].pinId, sub.pinId);
  assert.equal(nodeA.status, 'claimed', 'a live unverified candidate reads as work-in-flight');
  assert.equal(
    projection.participants.find((p) => p.metaId === S1)?.effectiveClaims ?? 0,
    0,
    'intent-only claims never count as effective claims'
  );
  // The claim is still an eventSetHash member: removing it must change the hash.
  const withoutClaim = replayMetaTask([tree, task, sub], { rootPinId, now: farFuture });
  assert.notEqual(projection.freshness.eventSetHash, withoutClaim.freshness.eventSetHash);
  // A claim on an invented node is still recorded as unknown_node.
  const ghost = claimOn(rootPinId, 'invented', S1, { height: 191_603 });
  const withGhost = replayMetaTask([tree, task, ghost], { rootPinId });
  assert.ok(withGhost.ignoredEvents.some((e) => e.pinId === ghost.pinId && e.reason === 'unknown_node'));
});

// ── §3.3 parentrefs structural validation ────────────────────────────────────

test('competitive: parentrefs admission matrix (ghost/missing/extra/wrong-node/entry)', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subB = compSubmit(rootPinId, 'b', S1, { height: 191_601 });
  const good = compSubmit(rootPinId, 'r', S2, { height: 191_602, parentrefs: { a: subA.pinId, b: subB.pinId } });
  const missing = compSubmit(rootPinId, 'r', S2, { height: 191_603, parentrefs: undefined });
  const oneKey = compSubmit(rootPinId, 'r', S2, { height: 191_604, parentrefs: { a: subA.pinId } });
  const extra = compSubmit(rootPinId, 'r', S2, {
    height: 191_605,
    parentrefs: { a: subA.pinId, b: subB.pinId, x: subA.pinId },
  });
  const ghost = compSubmit(rootPinId, 'r', S2, {
    height: 191_606,
    parentrefs: { a: subA.pinId, b: 'cpin0000ghost0i0' },
  });
  const wrongNode = compSubmit(rootPinId, 'r', S2, {
    height: 191_607,
    parentrefs: { a: subB.pinId, b: subA.pinId },
  });
  const nonString = compSubmit(rootPinId, 'r', S2, { height: 191_608, parentrefs: { a: 5, b: subB.pinId } });
  const entryWithRefs = compSubmit(rootPinId, 'a', S3, { height: 191_609, parentrefs: { a: subA.pinId } });
  // An empty object carries no references and counts as omitted.
  const entryEmptyRefs = compSubmit(rootPinId, 'a', S3, { height: 191_610, parentrefs: {} });
  const events = [tree, task, subA, subB, good, missing, oneKey, extra, ghost, wrongNode, nonString, entryWithRefs, entryEmptyRefs];
  const projection = replayMetaTask(events, { rootPinId });

  const reasons = new Map();
  for (const entry of projection.ignoredEvents) {
    if (!reasons.has(entry.pinId)) reasons.set(entry.pinId, entry.reason);
  }
  for (const bad of [missing, oneKey, extra, ghost, wrongNode, nonString, entryWithRefs]) {
    assert.equal(reasons.get(bad.pinId), 'invalid_reference', `${bad.pinId} must be invalid_reference`);
    assert.equal(candidateOf(projection, 'r', bad.pinId), undefined, 'invalid candidates carry no state');
  }
  assert.equal(candidateOf(projection, 'a', entryWithRefs.pinId), undefined);
  assert.ok(candidateOf(projection, 'r', good.pinId), 'a well-formed join submission is admitted');
  assert.ok(candidateOf(projection, 'a', entryEmptyRefs.pinId), 'entry node: {} counts as omitted');
  // invalid_reference submissions remain eventSetHash members.
  const withoutBad = replayMetaTask(events.filter((e) => e !== ghost), { rootPinId });
  assert.notEqual(projection.freshness.eventSetHash, withoutBad.freshness.eventSetHash);
});

test('competitive: submissions on unknown nodes are dropped as unknown_node', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const sub = compSubmit(rootPinId, 'invented', S1, { height: 191_600 });
  const projection = replayMetaTask([tree, task, sub], { rootPinId });
  assert.equal(projection.nodeStates.invented, undefined);
  assert.ok(projection.ignoredEvents.some((e) => e.pinId === sub.pinId && e.reason === 'unknown_node'));
  assert.equal(projection.progress.total, 3);
});

// ── §3.4/§3.6 fork race, tie-break, completion ───────────────────────────────

test('competitive: fork race — both candidates reach quorum, earliest verified time leads', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const subA1 = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subA2 = compSubmit(rootPinId, 'a', S2, { height: 191_601 });
  const events = [
    tree, task, subA1, subA2,
    passVote(subA1.pinId, R1, { height: 191_610 }),
    passVote(subA1.pinId, R2, { height: 191_611 }), // subA1 verified @611
    passVote(subA2.pinId, R1, { height: 191_612 }),
    passVote(subA2.pinId, R2, { height: 191_613 }), // subA2 verified @613
  ];
  const projection = replayMetaTask(events, { rootPinId });
  const nodeA = projection.nodeStates.a;
  assert.equal(nodeA.status, 'verified', 'satisfied: ≥1 chain-valid verified candidate');
  assert.equal(nodeA.submissions.length, 2);
  assert.equal(candidateOf(projection, 'a', subA1.pinId).verified, true);
  assert.equal(candidateOf(projection, 'a', subA2.pinId).verified, true);
  assert.equal(candidateOf(projection, 'a', subA2.pinId).chainValid, true, 'standing forks stay chain-valid');
  assert.equal(nodeA.submission.pinId, subA1.pinId, 'leader = smallest verified time');
  assert.equal(nodeA.passVotes, 2, 'node vote view mirrors the leader');
  assert.equal(projection.taskComplete, false, 'the terminal node is not satisfied yet');
  assert.equal(projection.progress.satisfied, 1);
});

test('competitive: verified-time tie breaks by the submission order key', () => {
  const { tree, task, rootPinId } = buildCompTask({ quorum: 1 });
  const subLate = compSubmit(rootPinId, 'a', S1, { height: 191_602, txIndex: 5 });
  const subEarly = compSubmit(rootPinId, 'a', S2, { height: 191_601, txIndex: 4 });
  // Both reach quorum at the SAME verified time (height, txIndex).
  const events = [
    tree, task, subLate, subEarly,
    passVote(subLate.pinId, R1, { height: 191_620, txIndex: 3 }),
    passVote(subEarly.pinId, R1, { height: 191_620, txIndex: 3 }),
  ];
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(
    projection.nodeStates.a.submission.pinId,
    subEarly.pinId,
    'equal verified times: the earlier submission pin wins'
  );
});

test('competitive: optimistic pipelining — child may verify before its parents', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subB = compSubmit(rootPinId, 'b', S2, { height: 191_601 });
  const subR = compSubmit(rootPinId, 'r', S3, { height: 191_602, parentrefs: { a: subA.pinId, b: subB.pinId } });
  // The child verifies while both parents are still unverified.
  const mid = replayMetaTask(
    [tree, task, subA, subB, subR, passVote(subR.pinId, R1, { height: 191_610 }), passVote(subR.pinId, R2, { height: 191_611 })],
    { rootPinId }
  );
  const midCandidate = candidateOf(mid, 'r', subR.pinId);
  assert.equal(midCandidate.verified, true);
  assert.equal(midCandidate.chainValid, false, 'verified but ancestors unverified: not chain-valid');
  assert.equal(mid.nodeStates.r.submission, null, 'no leader without chain-validity');
  assert.equal(mid.nodeStates.r.status, 'claimed');
  assert.equal(mid.taskComplete, false);

  // Parents verify afterwards: the pre-verified child turns chain-valid.
  const done = replayMetaTask(
    [
      tree, task, subA, subB, subR,
      passVote(subR.pinId, R1, { height: 191_610 }),
      passVote(subR.pinId, R2, { height: 191_611 }),
      passVote(subA.pinId, R1, { height: 191_620 }),
      passVote(subA.pinId, R2, { height: 191_621 }),
      passVote(subB.pinId, R1, { height: 191_622 }),
      passVote(subB.pinId, R2, { height: 191_623 }),
    ],
    { rootPinId }
  );
  assert.equal(done.taskComplete, true);
  assert.equal(done.nodeStates.r.submission.pinId, subR.pinId);
  assert.deepEqual(
    done.settlement.winningChain,
    [subA.pinId, subB.pinId, subR.pinId],
    'winningChain = winner + parentrefs closure, sorted by node id'
  );
  assert.equal(done.settlement.engineAlgoVersion, 'idbots-metatask-engine/1.3.0');
  assert.equal(done.settlement.mode, 'competitive');
});

test('competitive: a fail verdict kills only its target and cascades chain-invalidity', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subB = compSubmit(rootPinId, 'b', S2, { height: 191_601 });
  const subR = compSubmit(rootPinId, 'r', S3, { height: 191_602, parentrefs: { a: subA.pinId, b: subB.pinId } });
  const base = [
    tree, task, subA, subB, subR,
    passVote(subA.pinId, R1, { height: 191_610 }),
    passVote(subA.pinId, R2, { height: 191_611 }),
    passVote(subB.pinId, R1, { height: 191_612 }),
    passVote(subB.pinId, R2, { height: 191_613 }),
    passVote(subR.pinId, R1, { height: 191_614 }),
    passVote(subR.pinId, R2, { height: 191_615 }),
  ];
  const completed = replayMetaTask(base, { rootPinId });
  assert.equal(completed.taskComplete, true);
  assert.ok(completed.settlement);

  // The ancestor is killed afterwards: the completed chain unravels.
  const kill = failVote(subA.pinId, R3, { height: 191_620 });
  const unraveled = replayMetaTask([...base, kill], { rootPinId });
  assert.equal(candidateOf(unraveled, 'a', subA.pinId).failed, true);
  assert.equal(candidateOf(unraveled, 'a', subA.pinId).verified, false);
  assert.equal(unraveled.nodeStates.a.status, 'open', 'no live candidate remains on a');
  assert.equal(unraveled.nodeStates.a.submission, null);
  const orphanR = candidateOf(unraveled, 'r', subR.pinId);
  assert.equal(orphanR.verified, true, 'the child keeps its own verified flag');
  assert.equal(orphanR.chainValid, false, 'cascade: the killed ancestor invalidates the child');
  assert.equal(unraveled.nodeStates.r.status, 'claimed');
  assert.equal(unraveled.taskComplete, false, 'completion is boundary-evaluated');
  assert.equal(unraveled.settlement, null);

  // The ancestor POSITION is re-verified by a new submission, and a fresh child
  // pins the new parent (the orphan's parentrefs still name the dead pin).
  const subA2 = compSubmit(rootPinId, 'a', S2, { height: 191_630 });
  const subR2 = compSubmit(rootPinId, 'r', S1, { height: 191_631, parentrefs: { a: subA2.pinId, b: subB.pinId } });
  const rebuilt = replayMetaTask(
    [
      ...base, kill, subA2, subR2,
      passVote(subA2.pinId, R1, { height: 191_640 }),
      passVote(subA2.pinId, R2, { height: 191_641 }),
      passVote(subR2.pinId, R1, { height: 191_642 }),
      passVote(subR2.pinId, R2, { height: 191_643 }),
    ],
    { rootPinId }
  );
  assert.equal(candidateOf(rebuilt, 'r', subR.pinId).chainValid, false, 'the orphan never recovers');
  assert.equal(rebuilt.taskComplete, true);
  assert.deepEqual(rebuilt.settlement.winningChain, [subA2.pinId, subB.pinId, subR2.pinId]);
  const unpaid = Object.fromEntries(rebuilt.settlement.unpaidHistory.map((h) => [h.pinId, h.reason]));
  assert.equal(unpaid[subA.pinId], 'failed');
  assert.equal(unpaid[subR.pinId], 'losing_fork');
});

// ── §3.4 supersede on a fork ─────────────────────────────────────────────────

test('competitive: supersede replaces the author tip; descendants of a superseded parent stay invalid', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const subA1 = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subA2 = compSubmit(rootPinId, 'a', S1, { height: 191_602, supersedeid: subA1.pinId });
  const subB = compSubmit(rootPinId, 'b', S2, { height: 191_603 });
  const events = [
    tree, task, subA1, subA2, subB,
    passVote(subA1.pinId, R1, { height: 191_604 }), // one pass before the supersede…
    // …the superseded pin can still reach quorum afterwards (votes never gate),
    // but superseded keeps it out of candidacy and out of every chain.
    passVote(subA1.pinId, R2, { height: 191_605 }),
    passVote(subA2.pinId, R1, { height: 191_606 }),
    passVote(subA2.pinId, R2, { height: 191_607 }),
    passVote(subB.pinId, R1, { height: 191_608 }),
    passVote(subB.pinId, R2, { height: 191_609 }),
  ];
  const mid = replayMetaTask(events, { rootPinId });
  const replaced = candidateOf(mid, 'a', subA1.pinId);
  assert.equal(replaced.superseded, true);
  assert.equal(replaced.verified, true, 'quorum after supersede still flips the raw flag');
  assert.equal(replaced.chainValid, false, 'a superseded submission is never chain-valid');

  // A child pinning the superseded parent verifies but can never be chain-valid.
  const orphanR = compSubmit(rootPinId, 'r', S2, { height: 191_610, parentrefs: { a: subA1.pinId, b: subB.pinId } });
  const goodR = compSubmit(rootPinId, 'r', S3, { height: 191_611, parentrefs: { a: subA2.pinId, b: subB.pinId } });
  const done = replayMetaTask(
    [
      ...events, orphanR, goodR,
      passVote(orphanR.pinId, R1, { height: 191_612 }),
      passVote(orphanR.pinId, R2, { height: 191_613 }),
      passVote(goodR.pinId, R1, { height: 191_614 }),
      passVote(goodR.pinId, R2, { height: 191_615 }),
    ],
    { rootPinId }
  );
  assert.equal(candidateOf(done, 'r', orphanR.pinId).verified, true);
  assert.equal(candidateOf(done, 'r', orphanR.pinId).chainValid, false);
  assert.equal(done.nodeStates.r.submission.pinId, goodR.pinId);
  assert.deepEqual(done.settlement.winningChain, [subA2.pinId, subB.pinId, goodR.pinId]);
  const unpaid = Object.fromEntries(done.settlement.unpaidHistory.map((h) => [h.pinId, h.reason]));
  assert.equal(unpaid[subA1.pinId], 'superseded');
  assert.equal(unpaid[orphanR.pinId], 'losing_fork');
});

test('competitive: supersede predicate failures are ignored with the tree-mode reason', () => {
  const { tree, task, rootPinId } = buildCompTask({ quorum: 1 });
  const subA1 = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const events = [tree, task, subA1];
  // Not the author's own submission.
  const foreign = compSubmit(rootPinId, 'a', S2, { height: 191_601, supersedeid: subA1.pinId });
  // A ghost target.
  const ghost = compSubmit(rootPinId, 'a', S1, { height: 191_602, supersedeid: 'cpin0000ghost0i0' });
  // Below H_ACT2: both pins must be at/after the gate.
  const subPre = compSubmit(rootPinId, 'b', S1, { height: 191_400 });
  const gated = compSubmit(rootPinId, 'b', S1, { height: 191_401, supersedeid: subPre.pinId });
  // The target already reached quorum.
  const subA2 = compSubmit(rootPinId, 'a', S1, { height: 191_604, supersedeid: subA1.pinId });
  const projection = replayMetaTask(
    [...events, foreign, ghost, subPre, gated, passVote(subA1.pinId, R1, { height: 191_603 }), subA2],
    { rootPinId }
  );
  const reasons = new Map(projection.ignoredEvents.map((e) => [e.pinId, e.reason]));
  assert.equal(reasons.get(foreign.pinId), 'supersede_predicate_failed');
  assert.equal(reasons.get(ghost.pinId), 'supersede_predicate_failed');
  assert.equal(reasons.get(gated.pinId), 'supersede_predicate_failed');
  assert.equal(reasons.get(subA2.pinId), 'supersede_predicate_failed', 'a verified target cannot be replaced');
  // Same-author duplicates WITHOUT supersedeid are fine (unbounded competition).
  const dup = compSubmit(rootPinId, 'a', S1, { height: 191_605 });
  const withDup = replayMetaTask([...events, dup], { rootPinId });
  assert.equal(withDup.nodeStates.a.submissions.length, 2);
});

// ── §3.5 verify semantics (identity + last-valid-vote in competitive) ────────

test('competitive: identity filters and last-valid-vote mirror tree mode', () => {
  const { tree, task, rootPinId } = buildCompTask({ quorum: 2 });
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const selfVote = passVote(subA.pinId, S1, { height: 191_601 });
  const publisherVote = passVote(subA.pinId, P, { height: 191_602 });
  const real = passVote(subA.pinId, R1, { height: 191_603 });
  let projection = replayMetaTask([tree, task, subA, selfVote, publisherVote, real], { rootPinId });
  assert.equal(candidateOf(projection, 'a', subA.pinId).verified, false, 'self/publisher passes never count');
  assert.equal(candidateOf(projection, 'a', subA.pinId).passVotes, 1);

  // fail-then-pass from the same voter: only the last valid vote acts.
  const flipToPass = [
    failVote(subA.pinId, R2, { height: 191_604 }),
    passVote(subA.pinId, R2, { height: 191_605 }),
  ];
  projection = replayMetaTask([tree, task, subA, real, ...flipToPass, passVote(subA.pinId, R3, { height: 191_606 })], { rootPinId });
  assert.equal(candidateOf(projection, 'a', subA.pinId).verified, true, 'R2 pass + R3 pass reach quorum');

  // pass-then-fail: the last valid fail kills the target.
  const kill = replayMetaTask(
    [tree, task, subA, passVote(subA.pinId, R1, { height: 191_603 }), passVote(subA.pinId, R2, { height: 191_604 }), failVote(subA.pinId, R2, { height: 191_605 })],
    { rootPinId }
  );
  assert.equal(candidateOf(kill, 'a', subA.pinId).failed, true);
  assert.equal(candidateOf(kill, 'a', subA.pinId).verified, false);

  // Ruling-three parity: a fail verdict is NOT identity-filtered — even the
  // submitter's own last-valid fail kills the submission.
  const selfKill = replayMetaTask([tree, task, subA, failVote(subA.pinId, S1, { height: 191_601 })], { rootPinId });
  assert.equal(candidateOf(selfKill, 'a', subA.pinId).failed, true);
});

// ── §3.9 amend in competitive mode ───────────────────────────────────────────

test('competitive: amend freeze follows chain-valid verified submissions (point-in-time)', () => {
  const { tree, task, rootPinId, treePinId } = buildCompTask();
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subB = compSubmit(rootPinId, 'b', S2, { height: 191_601 });
  const verifyA = [passVote(subA.pinId, R1, { height: 191_605 }), passVote(subA.pinId, R2, { height: 191_606 })];
  // amend1 lands while b is UNVERIFIED: reweighting b must apply (and must KEEP
  // applying after b verifies — satisfaction is judged strictly before the amend).
  const amend1 = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [
      { op: 'reweight', node: 'b', weight: 4500 },
      { op: 'reweight', node: 'r', weight: 1500 },
    ] },
    { author: P, height: 191_610 }
  );
  // amend2 touches the verified node a: rejected as a whole (including its
  // well-formed second op), keeping amend1's weights.
  const amend2 = ev(
    'amend',
    { taskid: rootPinId, bases: amend1.pinId, ops: [
      { op: 'reweight', node: 'a', weight: 4500 },
      { op: 'reweight', node: 'b', weight: 4000 },
    ] },
    { author: P, height: 191_611 }
  );
  // remove_node b is rejected: r lists b in deps.
  const amend3 = ev(
    'amend',
    { taskid: rootPinId, bases: amend1.pinId, ops: [{ op: 'remove_node', node: 'b' }, { op: 'reweight', node: 'r', weight: 6000 }] },
    { author: P, height: 191_612 }
  );
  // add_node with a deps edge onto the frozen node a: rejected.
  const amend4 = ev(
    'amend',
    { taskid: rootPinId, bases: amend1.pinId, ops: [
      { op: 'add_node', node: { id: 'c', parent: 'r', title: 'c', kind: 'proof', specid: null, params: {}, deps: ['a'], weight: 1000 } },
      { op: 'reweight', node: 'r', weight: 500 },
    ] },
    { author: P, height: 191_613 }
  );
  // Middle-layer add_node (deps onto the UNFROZEN entry b — the finalnode is
  // not among them) keeps the sink pinned at r and applies; respec on the
  // unfrozen node b applies too.
  const amend5 = ev(
    'amend',
    { taskid: rootPinId, bases: amend1.pinId, ops: [
      { op: 'add_node', node: { id: 'c', parent: 'r', title: 'c', kind: 'proof', specid: null, params: {}, deps: ['b'], weight: 1000 } },
      { op: 'reweight', node: 'r', weight: 500 },
      { op: 'respec', node: 'b', specid: 'specpin-new' },
    ] },
    { author: P, height: 191_614 }
  );
  // add_node ABOVE the finalnode (deps [r]) would move the sink off the
  // finalnode — rejected outright (draft §3.9 terminal pinning).
  const amendSinkMove = ev(
    'amend',
    { taskid: rootPinId, bases: amend5.pinId, ops: [
      { op: 'add_node', node: { id: 'd', parent: 'r', title: 'd', kind: 'proof', specid: null, params: {}, deps: ['r'], weight: 100 } },
      { op: 'reweight', node: 'r', weight: 400 },
    ] },
    { author: P, height: 191_615 }
  );
  // respec on the verified node a is rejected (frozen).
  const amend6 = ev(
    'amend',
    { taskid: rootPinId, bases: amend5.pinId, ops: [{ op: 'respec', node: 'a', specid: 'specpin-x' }] },
    { author: P, height: 191_616 }
  );
  const verifyB = [passVote(subB.pinId, R1, { height: 191_620 }), passVote(subB.pinId, R2, { height: 191_621 })];
  const events = [tree, task, subA, subB, ...verifyA, amend1, amend2, amend3, amend4, amend5, amendSinkMove, amend6, ...verifyB];
  const projection = replayMetaTask(events, { rootPinId });

  const byId = Object.fromEntries(projection.nodes.map((node) => [node.id, node]));
  assert.equal(byId.a.weight, 4000, 'the verified node a is frozen for amends');
  assert.equal(byId.b.weight, 4500, 'amend1 applied while b was unverified (point-in-time freeze)');
  assert.equal(byId.r.weight, 500);
  assert.equal(byId.b.specid, 'specpin-new', 'respec on an unfrozen node applies');
  assert.ok(byId.c, 'middle-layer add_node (deps onto an unfrozen non-final node) keeps the sink at the finalnode and applies');
  assert.deepEqual(byId.c.deps, ['b']);
  assert.equal(byId.d, undefined, 'add_node above the finalnode is folded away');
  assert.equal(projection.amendHead, amend5.pinId);
  const reasons = new Map(projection.ignoredEvents.map((e) => [e.pinId, e.reason]));
  assert.equal(reasons.get(amend2.pinId), 'amend_invariant_violation');
  assert.equal(reasons.get(amend3.pinId), 'amend_invariant_violation', 'remove_node referenced in deps is rejected');
  assert.equal(reasons.get(amend4.pinId), 'amend_invariant_violation', 'deps edge onto a frozen node is rejected');
  assert.equal(reasons.get(amendSinkMove.pinId), 'amend_invariant_violation', 'a new layer above the finalnode moves the sink off it and is rejected');
  assert.equal(reasons.get(amend6.pinId), 'amend_invariant_violation');
});

test('competitive: amend keeps the sink pinned at the finalnode (no layer above it)', () => {
  const { tree, task, rootPinId, treePinId } = buildCompTask();
  // A middle-layer add_node (deps onto the unfrozen entry a — the finalnode r
  // is NOT among them) leaves r a deps sink: applies (draft §3.9).
  const growSide = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [
      { op: 'add_node', node: { id: 'c', parent: 'r', title: 'c', kind: 'proof', specid: null, params: {}, deps: ['a'], weight: 1000 } },
      { op: 'reweight', node: 'r', weight: 1000 },
    ] },
    { author: P, height: 191_600 }
  );
  // Growing a new layer ABOVE the finalnode (the new node lists r in deps)
  // moves the sink off r — the whole amend is ignored.
  const growAbove = ev(
    'amend',
    { taskid: rootPinId, bases: growSide.pinId, ops: [
      { op: 'add_node', node: { id: 'd', parent: 'r', title: 'd', kind: 'proof', specid: null, params: {}, deps: ['r'], weight: 500 } },
      { op: 'reweight', node: 'a', weight: 3500 },
    ] },
    { author: P, height: 191_601 }
  );
  // Pruning the side branch again is legal (nothing lists it in deps and the
  // terminal structure is untouched).
  const pruneSide = ev(
    'amend',
    { taskid: rootPinId, bases: growSide.pinId, ops: [
      { op: 'remove_node', node: 'c' },
      { op: 'reweight', node: 'r', weight: 2000 },
    ] },
    { author: P, height: 191_602 }
  );
  const projection = replayMetaTask([tree, task, growSide, growAbove, pruneSide], { rootPinId });
  const byId = Object.fromEntries(projection.nodes.map((node) => [node.id, node]));
  assert.equal(byId.c, undefined, 'the side branch was pruned again');
  assert.equal(byId.d, undefined, 'the layer above the finalnode never landed');
  assert.equal(byId.r.weight, 2000);
  assert.equal(projection.amendHead, pruneSide.pinId);
  const reasons = new Map(projection.ignoredEvents.map((e) => [e.pinId, e.reason]));
  assert.equal(reasons.get(growAbove.pinId), 'amend_invariant_violation', 'the sink must stay the finalnode');
  assert.equal(reasons.get(growSide.pinId), undefined);
  assert.equal(reasons.get(pruneSide.pinId), undefined);
});

test('competitive: amend cannot remove the finalnode even when nothing deps on it', () => {
  // The finalnode is NOT the tree root here and no node lists it in deps, so
  // only the terminal-pinning invariant stands between it and removal.
  const nodes = [
    { id: 'pkg', parent: null, title: 'root container', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 2000 },
    { id: 'f', parent: 'pkg', title: 'terminal', kind: 'proof', specid: null, params: {}, deps: ['x'], weight: 5000 },
    { id: 'x', parent: 'pkg', title: 'entry', kind: 'proof', specid: null, params: {}, deps: [], weight: 3000 },
  ];
  const { tree, task, rootPinId, treePinId } = buildCompTask({ nodes, treeRoot: 'pkg', policyExtra: { finalnode: 'f' } });
  const dropFinal = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [
      { op: 'remove_node', node: 'f' },
      { op: 'reweight', node: 'pkg', weight: 7000 },
    ] },
    { author: P, height: 191_600 }
  );
  const projection = replayMetaTask([tree, task, dropFinal], { rootPinId });
  assert.equal(projection.amendHead, treePinId, 'the amend is ignored');
  assert.ok(projection.nodes.some((node) => node.id === 'f'), 'the finalnode survives');
  assert.ok(
    projection.ignoredEvents.some((e) => e.pinId === dropFinal.pinId && e.reason === 'amend_invariant_violation'),
    'removing the designated terminal node violates the fold invariants'
  );
});

test('competitive: amend gates (publisher, H_ACT2, bases) and amend_task_finalized', () => {
  const nodes = [{ id: 'r', parent: null, title: 'root', kind: 'proof', specid: null, params: {}, deps: [], weight: 10000 }];
  const { tree, task, rootPinId, treePinId } = buildCompTask({ nodes });
  const subR = compSubmit(rootPinId, 'r', S1, { height: 191_600 });
  const votes = [passVote(subR.pinId, R1, { height: 191_601 }), passVote(subR.pinId, R2, { height: 191_602 })];
  const rogue = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [{ op: 'retitle', node: 'r', title: 'x' }] },
    { author: S1, height: 191_603 }
  );
  const preAct = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [{ op: 'retitle', node: 'r', title: 'x' }] },
    { author: P, height: 191_400 }
  );
  const afterDone = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [{ op: 'retitle', node: 'r', title: 'renamed' }] },
    { author: P, height: 191_605 }
  );
  const projection = replayMetaTask([tree, task, subR, ...votes, rogue, preAct, afterDone], { rootPinId });
  assert.equal(projection.taskComplete, true);
  const reasons = new Map(projection.ignoredEvents.map((e) => [e.pinId, e.reason]));
  assert.equal(reasons.get(rogue.pinId), 'amend_not_publisher');
  assert.equal(reasons.get(preAct.pinId), 'below_h_act2');
  assert.equal(reasons.get(afterDone.pinId), 'amend_task_finalized', 'a satisfied terminal node freezes all amends');
  assert.equal(projection.nodes[0].title, 'root');

  // Stale/conflict bases on a task that is NOT finalized (the finalized gate
  // runs first, mirroring tree mode's rootVerified ordering).
  const open = buildCompTask();
  const stale = ev(
    'amend',
    { taskid: open.rootPinId, bases: 'cpin0000stale0i0', ops: [{ op: 'retitle', node: 'r', title: 'x' }] },
    { author: P, height: 191_604 }
  );
  const goodAmend = ev(
    'amend',
    { taskid: open.rootPinId, bases: open.treePinId, ops: [{ op: 'retitle', node: 'r', title: 'renamed' }] },
    { author: P, height: 191_605 }
  );
  const conflict = ev(
    'amend',
    { taskid: open.rootPinId, bases: open.treePinId, ops: [{ op: 'retitle', node: 'r', title: 'twice' }] },
    { author: P, height: 191_606 }
  );
  const openProj = replayMetaTask([open.tree, open.task, stale, goodAmend, conflict], { rootPinId: open.rootPinId });
  const openReasons = new Map(openProj.ignoredEvents.map((e) => [e.pinId, e.reason]));
  assert.equal(openReasons.get(stale.pinId), 'amend_stale');
  assert.equal(openReasons.get(conflict.pinId), 'amend_conflict');
  assert.equal(openProj.nodes.find((n) => n.id === 'r').title, 'renamed');
  assert.equal(openProj.amendHead, goodAmend.pinId);
});

// ── §3.8 challenge ───────────────────────────────────────────────────────────

const completedChainFixture = () => {
  const { tree, task, rootPinId } = buildCompTask();
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subB = compSubmit(rootPinId, 'b', S2, { height: 191_601 });
  const subR = compSubmit(rootPinId, 'r', S3, { height: 191_602, parentrefs: { a: subA.pinId, b: subB.pinId } });
  const events = [
    tree, task, subA, subB, subR,
    passVote(subA.pinId, R1, { height: 191_610 }),
    passVote(subA.pinId, R2, { height: 191_611 }),
    passVote(subB.pinId, R1, { height: 191_612 }),
    passVote(subB.pinId, R2, { height: 191_613 }),
    passVote(subR.pinId, R1, { height: 191_614 }),
    passVote(subR.pinId, R2, { height: 191_615 }),
  ];
  return { events, rootPinId, subA, subB, subR };
};

test('competitive: an open challenge blocks the manifest; withdraw and expiry lift it', () => {
  const { events, rootPinId, subR } = completedChainFixture();
  const challenge = ev(
    'challenge',
    { targetid: subR.pinId, category: 'correctness', reason: 'spec gap', evidence: 'metafile://evidence' },
    { author: C, height: 191_620, timestampMs: 1_790_000_000_000 }
  );
  const held = replayMetaTask([...events, challenge], { rootPinId });
  assert.equal(held.taskComplete, true);
  assert.equal(held.settlement, null, 'an open challenge blocks settlement');
  assert.equal(held.nodeStates.r.disputed, true);
  assert.equal(held.progress.disputed, 1);

  const withdrawn = ev(
    'challenge',
    { targetid: subR.pinId, category: 'correctness', reason: 'withdraw', evidence: 'metafile://evidence', withdraw: true },
    { author: C, height: 191_621 }
  );
  const lifted = replayMetaTask([...events, challenge, withdrawn], { rootPinId });
  assert.ok(lifted.settlement, 'withdraw lifts the holdout');

  const expired = replayMetaTask([...events, challenge], {
    rootPinId,
    now: 1_790_000_000_000 + 15 * 86_400_000,
  });
  assert.ok(expired.settlement, 'an expired challenge lifts the holdout');
  assert.ok(expired.ignoredEvents.some((e) => e.pinId === challenge.pinId && e.reason === 'challenge_expired'));
});

test('competitive: challenge gates and target resolution', () => {
  const { events, rootPinId, subA, subR } = completedChainFixture();
  const { tree, task, rootPinId: root2 } = buildCompTask();
  const pending = compSubmit(root2, 'a', S1, { height: 191_600 });
  // The target must be a CURRENT chain-valid verified submission.
  const onPending = ev(
    'challenge',
    { targetid: pending.pinId, category: 'correctness', reason: 'x', evidence: 'metafile://e' },
    { author: C, height: 191_601 }
  );
  const pendingProj = replayMetaTask([tree, task, pending, onPending], { rootPinId: root2 });
  assert.ok(pendingProj.ignoredEvents.some((e) => e.pinId === onPending.pinId && e.reason === 'target_not_active_verified'));

  // Identity gate: submitter and publisher cannot challenge; evidence required.
  const bySubmitter = ev(
    'challenge',
    { targetid: subR.pinId, category: 'correctness', reason: 'x', evidence: 'metafile://e' },
    { author: S3, height: 191_620 }
  );
  const noEvidence = ev(
    'challenge',
    { targetid: subR.pinId, category: 'correctness', reason: 'x', evidence: '' },
    { author: C, height: 191_620 }
  );
  const gated = replayMetaTask([...events, bySubmitter, noEvidence], { rootPinId });
  const reasons = new Map(gated.ignoredEvents.map((e) => [e.pinId, e.reason]));
  assert.equal(reasons.get(bySubmitter.pinId), 'challenge_gate_failed');
  assert.equal(reasons.get(noEvidence.pinId), 'challenge_gate_failed');

  // A target killed by a fail verdict resolves the challenge (overturned path):
  // the challenge never stands and never blocks.
  const challengeOnA = ev(
    'challenge',
    { targetid: subA.pinId, category: 'correctness', reason: 'x', evidence: 'metafile://e' },
    { author: C, height: 191_616, timestampMs: 1_790_000_000_000 }
  );
  const kill = failVote(subA.pinId, R3, { height: 191_617 });
  const killed = replayMetaTask([...events, challengeOnA, kill], { rootPinId });
  assert.equal(killed.nodeStates.a.disputed, false, 'the killed target resolves its challenge');
  assert.equal(killed.settlement, null, '…but the task is incomplete now, so still no manifest');
  assert.ok(killed.ignoredEvents.every((e) => e.pinId !== challengeOnA.pinId || e.reason === 'target_not_active_verified'));
});

test('competitive: a challenge on a standing losing fork is valid and blocks settlement', () => {
  const { events, rootPinId, subA, subB } = completedChainFixture();
  // A second verified candidate on b — a standing fork that loses.
  const subB2 = compSubmit(rootPinId, 'b', S1, { height: 191_603 });
  const fork = [subB2, passVote(subB2.pinId, R3, { height: 191_616 }), passVote(subB2.pinId, R2, { height: 191_617 })];
  const challenge = ev(
    'challenge',
    { targetid: subB2.pinId, category: 'correctness', reason: 'fork is wrong', evidence: 'metafile://e' },
    { author: C, height: 191_618 }
  );
  const projection = replayMetaTask([...events, ...fork, challenge], { rootPinId });
  assert.equal(candidateOf(projection, 'b', subB2.pinId).chainValid, true, 'the fork stands on its own');
  assert.equal(projection.settlement, null, 'any open challenge blocks the manifest');
  assert.equal(projection.nodeStates.b.disputed, true);
  // Sanity: without the challenge the fork is just unpaid history.
  const clean = replayMetaTask([...events, ...fork], { rootPinId });
  const unpaid = Object.fromEntries(clean.settlement.unpaidHistory.map((h) => [h.pinId, h.reason]));
  assert.equal(unpaid[subB2.pinId], 'losing_fork');
  assert.equal(unpaid[subA.pinId], undefined);
  assert.equal(unpaid[subB.pinId], undefined);
});

// ── §3.7 settlement math (hand-computed to basis points) ─────────────────────

test('competitive: winner-chain-only settlement with the Laplace reviewer split', () => {
  const { tree, task, rootPinId } = buildCompTask(); // a 4000 / b 4000 / r 2000, σ 8000, quorum 2
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subB1 = compSubmit(rootPinId, 'b', S2, { height: 191_601 });
  const subB2 = compSubmit(rootPinId, 'b', S3, { height: 191_602 });
  const subR = compSubmit(rootPinId, 'r', S1, { height: 191_603, parentrefs: { a: subA.pinId, b: subB1.pinId } });
  const events = [
    tree, task, subA, subB1, subB2, subR,
    passVote(subA.pinId, R1, { height: 191_610 }),
    passVote(subA.pinId, R2, { height: 191_611 }),
    passVote(subB1.pinId, R1, { height: 191_612 }),
    passVote(subB1.pinId, R3, { height: 191_613 }),
    passVote(subB2.pinId, R2, { height: 191_614 }),
    passVote(subB2.pinId, R1, { height: 191_615 }), // subB2 verified later: standing fork
    passVote(subR.pinId, R1, { height: 191_616 }),
    passVote(subR.pinId, R2, { height: 191_617 }),
  ];
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.taskComplete, true);
  const manifest = projection.settlement;
  assert.ok(manifest);
  assert.equal(manifest.engineAlgoVersion, 'idbots-metatask-engine/1.3.0');
  assert.equal(manifest.mode, 'competitive');
  assert.deepEqual(manifest.winningChain, [subA.pinId, subB1.pinId, subR.pinId]);
  assert.deepEqual(manifest.disputed, []);

  // Hand computation (all arithmetic floor()):
  //   accuracy: R1 4/4 -> floor(10000*5/6) = 8333; R2 3/3 -> 8000; R3 1/1 -> 6666.
  //   a (4000): sub S1 3200; pool 800 over {R1 8333, R2 8000}, accSum 16333
  //     -> R1 floor(800*8333/16333) = 408, R2 floor(800*8000/16333) = 391.
  //   b (4000): sub S2 3200; pool 800 over {R1 8333, R3 6666}, accSum 14999
  //     -> R1 floor(800*8333/14999) = 444, R3 floor(800*6666/14999) = 355.
  //   r (2000): sub S1 1600; pool 400 over {R1, R2}
  //     -> R1 floor(400*8333/16333) = 204, R2 floor(400*8000/16333) = 195.
  //   The losing fork subB2 pays nobody.
  const shares = Object.fromEntries(manifest.shares.map((share) => [share.metaId, share]));
  assert.deepEqual(shares[S1].from, { submittedBP: 4800, reviewedBP: 0 });
  assert.equal(shares[S1].shareBP, 4800);
  assert.deepEqual(shares[S2].from, { submittedBP: 3200, reviewedBP: 0 });
  assert.deepEqual(shares[S3], undefined, 'the losing fork submitter earns nothing');
  assert.deepEqual(shares[R1].from, { submittedBP: 0, reviewedBP: 1056 });
  assert.deepEqual(shares[R2].from, { submittedBP: 0, reviewedBP: 586 });
  assert.deepEqual(shares[R3].from, { submittedBP: 0, reviewedBP: 355 });
  const total = manifest.shares.reduce((sum, share) => sum + share.shareBP, 0);
  assert.equal(total, 9997, '3bp of floor residue is discarded across the three pools');
  const unpaid = Object.fromEntries(manifest.unpaidHistory.map((h) => [h.pinId, h.reason]));
  assert.deepEqual(unpaid, { [subB2.pinId]: 'losing_fork' });

  // Participant stats accumulate per candidate (no claim cycles exist).
  const stats = Object.fromEntries(projection.participants.map((p) => [p.metaId, p]));
  assert.equal(stats[S1].submissions, 2);
  assert.equal(stats[S1].verifiedContrib, 2);
  assert.equal(stats[S3].submissions, 1);
  assert.equal(stats[S3].verifiedContrib, 1, 'a standing fork is still a verified contribution');
  assert.equal(stats[S1].effectiveClaims, 0);
  assert.deepEqual([stats[R1].reviewVotes, stats[R1].reviewTerminal, stats[R1].reviewCorrect], [4, 4, 4]);
  assert.deepEqual([stats[R2].reviewVotes, stats[R2].reviewTerminal, stats[R2].reviewCorrect], [3, 3, 3]);
  assert.deepEqual([stats[R3].reviewVotes, stats[R3].reviewTerminal, stats[R3].reviewCorrect], [1, 1, 1]);
});

// ── §3.7 mid-task estimation (leading partial chain) ─────────────────────────

test('competitive: mid-task estimation pays the leading partial chain; completed task equals the manifest', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const events = [
    tree, task, subA,
    passVote(subA.pinId, R1, { height: 191_610 }),
    passVote(subA.pinId, R2, { height: 191_611 }),
  ];
  const mid = replayMetaTask(events, { rootPinId });
  assert.equal(mid.settlement, null);
  const estimation = estimateMetaTaskShares(mid);
  assert.equal(estimation.basis, 'weighted');
  // Only the satisfied node a pays: sub floor(4000*8000/10000) = 3200, pool 800
  // over R1/R2 at a(r) = 6666 each -> exactly 400 each.
  assert.deepEqual(estimation.shares, [
    { metaId: S1, shareBP: 3200, from: { submittedBP: 3200, reviewedBP: 0 } },
    { metaId: R1, shareBP: 400, from: { submittedBP: 0, reviewedBP: 400 } },
    { metaId: R2, shareBP: 400, from: { submittedBP: 0, reviewedBP: 400 } },
  ]);
  assert.equal(estimation.shares.reduce((sum, share) => sum + share.shareBP, 0), 4000);

  // On a completed task the estimate equals the manifest exactly.
  const { events: full, rootPinId: root2 } = completedChainFixture();
  const done = replayMetaTask(full, { rootPinId: root2 });
  const normalize = (shares) =>
    [...shares]
      .map((share) => ({ metaId: share.metaId, shareBP: share.shareBP, from: { ...share.from } }))
      .sort((a, b) => (a.metaId < b.metaId ? -1 : 1));
  assert.deepEqual(normalize(estimateMetaTaskShares(done).shares), normalize(done.settlement.shares));
});

// ── multi-dep join node ──────────────────────────────────────────────────────

test('competitive: a three-dep join settles the full chain (5 nodes, one pin each)', () => {
  const nodes = [
    { id: 'r', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: ['j'], weight: 2000 },
    { id: 'j', parent: 'r', title: 'join', kind: 'proof', specid: null, params: {}, deps: ['a', 'b', 'c'], weight: 2000 },
    { id: 'a', parent: 'j', title: 'a', kind: 'proof', specid: null, params: {}, deps: [], weight: 2000 },
    { id: 'b', parent: 'j', title: 'b', kind: 'proof', specid: null, params: {}, deps: [], weight: 2000 },
    { id: 'c', parent: 'j', title: 'c', kind: 'proof', specid: null, params: {}, deps: [], weight: 2000 },
  ];
  const { tree, task, rootPinId } = buildCompTask({ nodes, quorum: 1 });
  const subA = compSubmit(rootPinId, 'a', S1, { height: 191_600 });
  const subB = compSubmit(rootPinId, 'b', S1, { height: 191_601 });
  const subC = compSubmit(rootPinId, 'c', S1, { height: 191_602 });
  const subJ = compSubmit(rootPinId, 'j', S2, { height: 191_603, parentrefs: { a: subA.pinId, b: subB.pinId, c: subC.pinId } });
  const subR = compSubmit(rootPinId, 'r', S1, { height: 191_604, parentrefs: { j: subJ.pinId } });
  const events = [
    tree, task, subA, subB, subC, subJ, subR,
    passVote(subA.pinId, R1, { height: 191_610 }),
    passVote(subB.pinId, R1, { height: 191_611 }),
    passVote(subC.pinId, R1, { height: 191_612 }),
    passVote(subJ.pinId, R1, { height: 191_613 }),
    passVote(subR.pinId, R1, { height: 191_614 }),
  ];
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.taskComplete, true);
  assert.deepEqual(
    projection.settlement.winningChain,
    [subA.pinId, subB.pinId, subC.pinId, subJ.pinId, subR.pinId]
  );
  const shares = Object.fromEntries(projection.settlement.shares.map((share) => [share.metaId, share]));
  // 5 nodes at 2000bp, quorum 1: sub 1600 each, pool 400 to the single reviewer.
  assert.equal(shares[S1].from.submittedBP, 6400);
  assert.equal(shares[S2].from.submittedBP, 1600);
  assert.equal(shares[R1].from.reviewedBP, 2000);
  assert.equal(projection.settlement.shares.reduce((sum, share) => sum + share.shareBP, 0), 10000);

  // A join submission missing one dep key is invalid_reference.
  const badJoin = compSubmit(rootPinId, 'j', S3, { height: 191_605, parentrefs: { a: subA.pinId, b: subB.pinId } });
  const withBad = replayMetaTask([...events, badJoin], { rootPinId });
  assert.ok(withBad.ignoredEvents.some((e) => e.pinId === badJoin.pinId && e.reason === 'invalid_reference'));
});

// ── terminal-node resolution: finalnode missing / multi-sink ─────────────────

test('competitive: finalnode absent falls back to the unique sink; multi-sink never completes', () => {
  // Single sink, no finalnode: the unique deps-sink completes the task.
  const single = buildCompTask({ noFinalnode: true });
  const subA = compSubmit(single.rootPinId, 'a', S1, { height: 191_600 });
  const subB = compSubmit(single.rootPinId, 'b', S1, { height: 191_601 });
  const subR = compSubmit(single.rootPinId, 'r', S1, { height: 191_602, parentrefs: { a: subA.pinId, b: subB.pinId } });
  const done = replayMetaTask(
    [
      single.tree, single.task, subA, subB, subR,
      passVote(subA.pinId, R1, { height: 191_610 }),
      passVote(subB.pinId, R1, { height: 191_611 }),
      passVote(subR.pinId, R1, { height: 191_612 }),
      passVote(subA.pinId, R2, { height: 191_613 }),
      passVote(subB.pinId, R2, { height: 191_614 }),
      passVote(subR.pinId, R2, { height: 191_615 }),
    ],
    { rootPinId: single.rootPinId }
  );
  assert.equal(done.policy.finalNode, null);
  assert.equal(done.taskComplete, true, 'the unique sink substitutes for a missing finalnode');

  // Two sinks (both nodes are entries), no finalnode: deterministic non-completion.
  const twoSinkNodes = [
    { id: 'r', parent: null, title: 'r', kind: 'proof', specid: null, params: {}, deps: [], weight: 5000 },
    { id: 'a', parent: 'r', title: 'a', kind: 'proof', specid: null, params: {}, deps: [], weight: 5000 },
  ];
  const multi = buildCompTask({ nodes: twoSinkNodes, noFinalnode: true, quorum: 1 });
  const subR2 = compSubmit(multi.rootPinId, 'r', S1, { height: 191_600 });
  const subA2 = compSubmit(multi.rootPinId, 'a', S1, { height: 191_601 });
  const stalled = replayMetaTask(
    [multi.tree, multi.task, subR2, subA2, passVote(subR2.pinId, R1, { height: 191_610 }), passVote(subA2.pinId, R1, { height: 191_611 })],
    { rootPinId: multi.rootPinId }
  );
  assert.equal(stalled.nodeStates.r.status, 'verified', 'nodes still satisfy individually');
  assert.equal(stalled.nodeStates.a.status, 'verified');
  assert.equal(stalled.progress.satisfied, 2);
  assert.equal(stalled.taskComplete, false, 'multi-sink without finalnode can never complete');
  assert.equal(stalled.settlement, null);

  // A finalnode naming a nonexistent node behaves the same.
  const ghostFinal = buildCompTask({ nodes: twoSinkNodes, quorum: 1, policyExtra: { finalnode: 'ghost' } });
  const stalled2 = replayMetaTask(
    [ghostFinal.tree, ghostFinal.task, compSubmit(ghostFinal.rootPinId, 'r', S1, { height: 191_600 })],
    { rootPinId: ghostFinal.rootPinId }
  );
  assert.equal(stalled2.taskComplete, false);

  // finalnode present and live: it wins even when the tree has extra sinks.
  const designated = buildCompTask({ nodes: twoSinkNodes, quorum: 1 });
  const subR3 = compSubmit(designated.rootPinId, 'r', S1, { height: 191_600 });
  const subA3 = compSubmit(designated.rootPinId, 'a', S1, { height: 191_601 });
  const decided = replayMetaTask(
    [
      designated.tree, designated.task, subR3, subA3,
      passVote(subR3.pinId, R1, { height: 191_610 }),
      passVote(subA3.pinId, R1, { height: 191_611 }),
    ],
    { rootPinId: designated.rootPinId }
  );
  assert.equal(decided.taskComplete, true, 'the designated finalnode decides, extra sinks aside');
  assert.deepEqual(decided.settlement.winningChain, [subR3.pinId]);
  const unpaid = Object.fromEntries(decided.settlement.unpaidHistory.map((h) => [h.pinId, h.reason]));
  assert.equal(unpaid[subA3.pinId], 'losing_fork', 'nodes outside the winning chain contribute nothing');
  const total = decided.settlement.shares.reduce((sum, share) => sum + share.shareBP, 0);
  assert.equal(total, 5000, 'only the winning-chain node weight is distributed');
});

// ── deadlines / eventSetHash / freshness ─────────────────────────────────────

test('competitive: no claim/review deadlines; the challenge TTL still applies', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const claim = claimOn(rootPinId, 'a', S1, { height: 191_600, timestampMs: 1_790_000_000_000 });
  const sub = compSubmit(rootPinId, 'a', S2, { height: 191_601, timestampMs: 1_790_000_000_000 });
  const projection = replayMetaTask([tree, task, claim, sub], { rootPinId });
  assert.equal(projection.policy.claimTtlHours, 48, 'reported as published');
  assert.equal(projection.policy.verifyWindowHours, 72);
  assert.equal(nextTimeDeadlineMs(projection), null, 'competitive mode has no claim/review clocks');
  const withChallenge = nextTimeDeadlineMs(projection, { challengeTimestampsMs: [1_790_000_000_000] });
  assert.equal(withChallenge, 1_790_000_000_000 + 14 * 86_400_000);
});

test('competitive: eventSetHash keeps claim/release/invalid submissions as members', () => {
  const { tree, task, rootPinId } = buildCompTask();
  const claim = claimOn(rootPinId, 'a', S1, { height: 191_600 });
  const release = ev('release', { taskid: rootPinId, node: 'a', claimid: claim.pinId }, { author: S1, height: 191_601 });
  const subA = compSubmit(rootPinId, 'a', S2, { height: 191_602 });
  const invalid = compSubmit(rootPinId, 'r', S2, { height: 191_603, parentrefs: { a: subA.pinId } }); // missing b
  const full = replayMetaTask([tree, task, claim, release, subA, invalid], { rootPinId });
  const bare = replayMetaTask([tree, task, subA], { rootPinId });
  assert.notEqual(full.freshness.eventSetHash, bare.freshness.eventSetHash);
  assert.ok(full.ignoredEvents.some((e) => e.pinId === invalid.pinId && e.reason === 'invalid_reference'));
  // Order-independent input, deterministic output.
  const shuffled = replayMetaTask([invalid, release, subA, claim, task, tree], { rootPinId });
  assert.equal(shuffled.freshness.eventSetHash, full.freshness.eventSetHash);
});
