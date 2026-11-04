/**
 * S3 escrow order state machine — unit tests (design docs 03 + 04).
 *
 * Pins the contract acceptance asked for:
 *   1. every LEGAL transition passes for exactly its trigger actor,
 *   2. ILLEGAL transitions are rejected: unknown action, skipped step, wrong
 *      actor, terminal replay,
 *   3. each state's timeout fires the right branch (T1/T2 auto-cancel in the
 *      safety zone; T3/T4 escalate to DISPUTED — never auto-release, never
 *      auto-refund), plus the 50% / −2h reminder ladders,
 *   4. rollback points: mutual/unilateral cancel only before payment evidence,
 *      not after (hard boundary), and arbitration is the only exit there,
 *   5. the five invariants (zero funds flow, goods-before-payment, proof
 *      chain, terminal idempotency, exact-amount evidence anchor),
 *   6. orders are serializable (plain JSON round-trip keeps behavior).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCROW_DEFAULT_TIMERS,
  ESCROW_RULING_LEVELS,
  ESCROW_TIMEOUT_ACTIONS,
  ESCROW_TRANSITIONS,
  applyEscrowReminder,
  applyEscrowTransition,
  assertEscrowInvariants,
  assertEvidenceAnchor,
  assertNoPaymentBeforeEscrow,
  assertProofChainComplete,
  assertTerminalIdempotent,
  assertZeroFundsFlow,
  createEscrowOrder,
  escrowActiveTimerOf,
  escrowClockScan,
  escrowDueTimeoutAt,
  escrowNextStep,
  isEscrowTerminalState,
  type EscrowOrder,
} from '../src/main/libs/escrowOrderStateMachine';

const TXID = (ch: string) => ch.repeat(64);
const T0 = 1_793_640_000_000; // fixed epoch for deterministic timers
const HOUR = 3_600_000;

const newOrder = (overrides: Partial<Parameters<typeof createEscrowOrder>[0]> = {}): EscrowOrder =>
  createEscrowOrder({
    orderId: 'esc-001',
    goodsKind: 'mrc721',
    amountCents: 9900,
    roles: { seller: 'seller-甲', buyer: 'buyer-乙', escrowAgent: 'escrow-bot' },
    title: '星球系列 #3',
    now: T0,
    ...overrides,
  });

/** Drive a fresh order to the requested state through LEGAL moves only. */
const driveTo = (target: 'ITEM_ESCROWED' | 'PAID_EVIDENCE_UPLOADED' | 'SELLER_CONFIRMED' | 'DISPUTED' | 'RELEASED'): EscrowOrder => {
  let order = newOrder();
  const step = (event: Parameters<typeof applyEscrowTransition>[1]): void => {
    const result = applyEscrowTransition(order, event);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    if (result.ok) order = result.order;
  };
  step({ actor: 'seller', action: 'escrow_goods', proof: TXID('a'), basisMemo: '备注 esc-001', at: T0 + 1 });
  if (target === 'ITEM_ESCROWED') return order;
  step({ actor: 'buyer', action: 'upload_payment_evidence', proof: 'receipt-1.png', basisMemo: '转账备注 esc-001', at: T0 + 2 });
  if (target === 'PAID_EVIDENCE_UPLOADED') return order;
  step({ actor: 'seller', action: 'confirm_received', proof: 'confirm-log-1', basisMemo: '金额 99.00 备注 esc-001', basisAmountCents: 9900, basis: 'amount=9900 到账核对一致', at: T0 + 3 });
  if (target === 'SELLER_CONFIRMED') return order;
  if (target === 'RELEASED') {
    step({ actor: 'escrow_agent', action: 'release_goods', proof: TXID('b'), at: T0 + 4 });
    return order;
  }
  // DISPUTED
  step({ actor: 'buyer', action: 'dispute_open', proof: 'claim-buyer-1', basis: 'buyer: 货未按约定交付', note: '货未按约定交付', at: T0 + 4 });
  return order;
};

// ---------------------------------------------------------------------------
// 1. Legal transitions + actor permissions
// ---------------------------------------------------------------------------

test('happy path: seller escrow → buyer evidence → seller confirm → agent release, each trigger actor only', () => {
  const order = driveTo('RELEASED');
  assert.equal(order.state, 'RELEASED');
  assert.deepEqual(
    order.timeline.map((e) => `${e.from}->${e.to}@${e.actor}`),
    [
      'CREATED->ITEM_ESCROWED@seller',
      'ITEM_ESCROWED->PAID_EVIDENCE_UPLOADED@buyer',
      'PAID_EVIDENCE_UPLOADED->SELLER_CONFIRMED@seller',
      'SELLER_CONFIRMED->RELEASED@escrow_agent',
    ],
  );
  assert.equal(assertEscrowInvariants(order), true);
});

test('actor permissions: each legal action is rejected for every non-trigger actor', () => {
  // escrow_goods: seller only
  for (const actor of ['buyer', 'escrow_agent', 'system'] as const) {
    const blocked = applyEscrowTransition(newOrder(), { actor, action: 'escrow_goods', proof: TXID('a'), basisMemo: 'esc-001' });
    assert.equal(blocked.ok, false, `${actor} must not escrow goods`);
  }
  // upload_payment_evidence: buyer only
  for (const actor of ['seller', 'escrow_agent', 'system'] as const) {
    const blocked = applyEscrowTransition(driveTo('ITEM_ESCROWED'), { actor, action: 'upload_payment_evidence', proof: 'receipt', basisMemo: 'esc-001' });
    assert.equal(blocked.ok, false, `${actor} must not upload buyer payment evidence`);
  }
  // confirm_received: seller only (the key human confirmation point)
  for (const actor of ['buyer', 'escrow_agent', 'system'] as const) {
    const blocked = applyEscrowTransition(driveTo('PAID_EVIDENCE_UPLOADED'), {
      actor, action: 'confirm_received', proof: 'log', basisMemo: 'esc-001', basisAmountCents: 9900, basis: 'amount=9900',
    });
    assert.equal(blocked.ok, false, `${actor} must not confirm receipt`);
  }
  // release_goods: escrow agent only
  for (const actor of ['seller', 'buyer', 'system'] as const) {
    const blocked = applyEscrowTransition(driveTo('SELLER_CONFIRMED'), { actor, action: 'release_goods', proof: TXID('b') });
    assert.equal(blocked.ok, false, `${actor} must not release goods`);
  }
});

// ---------------------------------------------------------------------------
// 2. Illegal transitions (no skip, no replay)
// ---------------------------------------------------------------------------

test('no-skip: every table (from, action) pair is the only legal shape — jumps rejected from any earlier state', () => {
  const jumps: Array<[EscrowOrder, Parameters<typeof applyEscrowTransition>[1]]> = [
    [newOrder(), { actor: 'buyer', action: 'upload_payment_evidence', proof: 'r', basisMemo: 'esc-001' }], // pay before escrow (invariant 2)
    [newOrder(), { actor: 'seller', action: 'confirm_received', proof: 'c', basisMemo: 'esc-001', basisAmountCents: 9900, basis: 'amount=9900' }],
    [newOrder(), { actor: 'escrow_agent', action: 'release_goods', proof: TXID('b') }],
    [driveTo('ITEM_ESCROWED'), { actor: 'seller', action: 'confirm_received', proof: 'c', basisMemo: 'esc-001', basisAmountCents: 9900, basis: 'amount=9900' }],
    [driveTo('ITEM_ESCROWED'), { actor: 'escrow_agent', action: 'release_goods', proof: TXID('b') }],
    [driveTo('PAID_EVIDENCE_UPLOADED'), { actor: 'escrow_agent', action: 'release_goods', proof: TXID('b') }],
  ];
  for (const [order, event] of jumps) {
    const result = applyEscrowTransition(order, event);
    assert.equal(result.ok, false, `jump ${order.state}/${event.action} must be rejected`);
    assert.match(result.ok ? '' : result.reason, /illegal transition/);
  }
});

test('unknown actions and terminal replay are rejected (idempotent finals)', () => {
  const bogus = applyEscrowTransition(newOrder(), { actor: 'seller', action: 'move_funds' as never, proof: 'x' });
  assert.equal(bogus.ok, false);

  const released = driveTo('RELEASED');
  for (const event of [
    { actor: 'escrow_agent', action: 'release_goods', proof: TXID('c') },
    { actor: 'buyer', action: 'dispute_open', proof: 'p', basis: 'again', note: '再次申诉' },
    { actor: 'system', action: 'timeout_t4_escalate', proof: 't' },
  ] as const) {
    const rejected = applyEscrowTransition(released, { ...event, at: T0 + 10 });
    assert.equal(rejected.ok, false);
    assert.match(rejected.ok ? '' : rejected.reason, /terminal state/);
  }

  const cancelled = applyEscrowTransition(newOrder(), { actor: 'system', action: 'timeout_t1_cancel', proof: 'orderlog:t1', at: T0 + 24 * HOUR });
  assert.equal(cancelled.ok, true);
  const replay = applyEscrowTransition(cancelled.ok ? cancelled.order : newOrder(), { actor: 'seller', action: 'escrow_goods', proof: TXID('a'), basisMemo: 'esc-001' });
  assert.equal(replay.ok, false);
});

// ---------------------------------------------------------------------------
// 3. Timeout branches T1–T4 + reminder ladders
// ---------------------------------------------------------------------------

test('T1 expiry (CREATED) → auto cancel with no aftermath; only from CREATED', () => {
  const order = newOrder();
  assert.deepEqual(ESCROW_DEFAULT_TIMERS, { t1Hours: 24, t2Hours: 24, t3Hours: 48, t4Hours: 24 });
  const before = escrowDueTimeoutAt(order, T0 + 24 * HOUR - 1);
  assert.equal(before, null);
  const due = escrowDueTimeoutAt(order, T0 + 24 * HOUR);
  assert.equal(due?.dueAction, 'timeout_t1_cancel');
  assert.equal(due?.timer, 't1');

  const applied = applyEscrowTransition(order, { actor: 'system', action: due!.dueAction!, proof: 'orderlog:t1:esc-001', at: T0 + 24 * HOUR });
  assert.equal(applied.ok, true);
  const after = applied.ok ? applied.order : order;
  assert.equal(after.state, 'CANCELLED');
  assert.equal(after.negativeRecords.at(-1)?.kind, 'timeout_cancel');
});

test('T2 expiry (ITEM_ESCROWED) → goods return + cancel, return descriptor follows goods kind', () => {
  const nft = driveTo('ITEM_ESCROWED');
  const dueNft = escrowDueTimeoutAt(nft, T0 + 1 + 24 * HOUR);
  assert.equal(dueNft?.dueAction, 'timeout_t2_return_goods');
  assert.match(dueNft?.goodsReturn ?? '', /PIN 转回卖方/);

  const digital = createEscrowOrder({ orderId: 'esc-d1', goodsKind: 'digital', amountCents: 100, roles: nft.roles, now: T0 });
  const digitalEscrowed = applyEscrowTransition(digital, { actor: 'seller', action: 'escrow_goods', proof: TXID('c'), basisMemo: 'esc-d1', at: T0 + 1 });
  assert.equal(digitalEscrowed.ok, true);
  const dueDigital = escrowDueTimeoutAt(digitalEscrowed.ok ? digitalEscrowed.order : digital, T0 + 1 + 24 * HOUR);
  assert.match(dueDigital?.goodsReturn ?? '', /密钥归还卖方/);

  const applied = applyEscrowTransition(nft, { actor: 'system', action: 'timeout_t2_return_goods', proof: TXID('d'), at: T0 + 1 + 24 * HOUR });
  assert.equal(applied.ok, true);
  assert.equal(applied.ok ? applied.order.state : '', 'CANCELLED');
});

test('T3 expiry (PAID_EVIDENCE_UPLOADED) → DISPUTED, never auto-release / auto-refund', () => {
  const order = driveTo('PAID_EVIDENCE_UPLOADED');
  const due = escrowDueTimeoutAt(order, T0 + 2 + 48 * HOUR);
  assert.equal(due?.dueAction, 'timeout_t3_dispute');

  const applied = applyEscrowTransition(order, { actor: 'system', action: 'timeout_t3_dispute', proof: 'orderlog:t3', at: T0 + 2 + 48 * HOUR });
  assert.equal(applied.ok, true);
  assert.equal(applied.ok ? applied.order.state : '', 'DISPUTED');
  // The timeout branch has no release/refund action at all — only arbitration follows.
  assert.notEqual(ESCROW_TIMEOUT_ACTIONS.t3.action, 'ruling_release');
  assert.notEqual(ESCROW_TIMEOUT_ACTIONS.t3.action, 'ruling_rollback');
  const earlyRelease = applyEscrowTransition(applied.ok ? applied.order : order, { actor: 'escrow_agent', action: 'release_goods', proof: TXID('b') });
  assert.equal(earlyRelease.ok, false); // must rule from DISPUTED, not reuse release_goods
});

test('T4 expiry (SELLER_CONFIRMED) → DISPUTED escalation with owner-review marker', () => {
  const order = driveTo('SELLER_CONFIRMED');
  const due = escrowDueTimeoutAt(order, T0 + 3 + 24 * HOUR);
  assert.equal(due?.dueAction, 'timeout_t4_escalate');

  const applied = applyEscrowTransition(order, { actor: 'system', action: 'timeout_t4_escalate', proof: 'orderlog:t4', at: T0 + 3 + 24 * HOUR });
  assert.equal(applied.ok, true);
  const after = applied.ok ? applied.order : order;
  assert.equal(after.state, 'DISPUTED');
  assert.ok(after.ownerReview?.reason.includes('T4'));
});

test('reminders: 50% then −2h, one per stage, never mutate state', () => {
  const order = driveTo('ITEM_ESCROWED'); // T2 = 24h from T0+1
  const start = T0 + 1;
  assert.deepEqual(escrowClockScan(order, start + 11 * HOUR), []);
  const at50 = escrowClockScan(order, start + 12 * HOUR);
  assert.deepEqual(at50.map((e) => `${e.timer}:${e.stage}`), ['t2:50%']);
  const withReminder = applyEscrowReminder(order, 't2', '50%', start + 12 * HOUR);
  assert.equal(withReminder.state, order.state);
  assert.equal(withReminder.timeline.at(-1)?.reminder, true);
  // dedupe: same stage never fires twice
  assert.deepEqual(escrowClockScan(withReminder, start + 13 * HOUR), []);
  assert.equal(applyEscrowReminder(withReminder, 't2', '50%', start + 14 * HOUR), withReminder);

  const at2h = escrowClockScan(withReminder, start + 22 * HOUR);
  assert.deepEqual(at2h.map((e) => `${e.timer}:${e.stage}`), ['t2:-2h']);

  const terminal = driveTo('RELEASED');
  assert.deepEqual(escrowClockScan(terminal, T0 + 1000 * HOUR), []);
});

// ---------------------------------------------------------------------------
// 4. Rollback points (doc 04 branch 2 hard boundary)
// ---------------------------------------------------------------------------

test('cancel paths exist only before payment evidence; after it, only arbitration', () => {
  // mutual cancel in the safety zone, gated on BOTH confirmations
  const noMutual = applyEscrowTransition(newOrder(), { actor: 'seller', action: 'cancel_mutual', proof: 'msg-1', mutualConfirmed: false });
  assert.equal(noMutual.ok, false);
  const mutual = applyEscrowTransition(newOrder(), { actor: 'seller', action: 'cancel_mutual', proof: 'msg-1+msg-2', mutualConfirmed: true });
  assert.equal(mutual.ok, true);
  assert.equal(mutual.ok ? mutual.order.state : '', 'CANCELLED');

  // unilateral request (record only) → 12h silence ⇒ auto cancel, still only in the safety zone
  const requested = applyEscrowTransition(driveTo('ITEM_ESCROWED'), { actor: 'seller', action: 'cancel_request', proof: 'req-1', at: T0 + 2 });
  assert.equal(requested.ok, true);
  const requestedOrder = requested.ok ? requested.order : newOrder();
  assert.equal(requestedOrder.state, 'ITEM_ESCROWED'); // state NOT moved
  assert.equal(escrowDueTimeoutAt(requestedOrder, T0 + 2 + 12 * HOUR)?.dueAction, 'cancel_unilateral_timeout');
  const autoCancelled = applyEscrowTransition(requestedOrder, { actor: 'system', action: 'cancel_unilateral_timeout', proof: 'orderlog:cancel-timeout', at: T0 + 2 + 12 * HOUR });
  assert.equal(autoCancelled.ok, true);

  // after payment evidence the safety-zone exits are gone; no automatic rollback exists
  const paid = driveTo('PAID_EVIDENCE_UPLOADED');
  for (const action of ['cancel_mutual', 'cancel_request', 'cancel_unilateral_timeout', 'timeout_t2_return_goods', 'timeout_t1_cancel'] as const) {
    const rejected = applyEscrowTransition(paid, { actor: 'system', action, proof: 'x', mutualConfirmed: true });
    assert.equal(rejected.ok, false, `${action} must not exist after payment evidence`);
  }
});

test('dispute → ruling: release or rollback (rollback requires return proof + written basis)', () => {
  const disputed = driveTo('DISPUTED');
  const noBasis = applyEscrowTransition(disputed, { actor: 'escrow_agent', action: 'ruling_release', proof: 'rule-log' });
  assert.equal(noBasis.ok, false);

  const released = applyEscrowTransition(disputed, {
    actor: 'escrow_agent', action: 'ruling_release', proof: 'rule-log-1', basis: '凭证齐全且卖方确认过到账，放行优先',
  });
  assert.equal(released.ok, true);
  assert.equal(released.ok ? released.order.state : '', 'RELEASED');

  const rolledBack = applyEscrowTransition(disputed, {
    actor: 'escrow_agent', action: 'ruling_rollback', proof: TXID('e'), basis: 'owner: 凭证存疑，回退优先（货回卖方，退款由卖方手动退）',
  });
  assert.equal(rolledBack.ok, true);
  const final = rolledBack.ok ? rolledBack.order : disputed;
  assert.equal(final.state, 'REFUND_ROLLED_BACK');
  // owner-level basis is archived at the owner level; refund stays a human instruction, never a platform move
  assert.equal(final.negativeRecords.at(-1)?.subject, 'ruling:owner');
  assert.equal(assertZeroFundsFlow(final), true);
  // closing archiver still allowed on the refund final; nothing else is
  const closed = applyEscrowTransition(final, { actor: 'buyer', action: 'refund_confirmed', proof: 'refund-receipt-1', at: T0 + 99 });
  assert.equal(closed.ok, true);
  const replay = applyEscrowTransition(closed.ok ? closed.order : final, { actor: 'seller', action: 'escrow_goods', proof: TXID('a'), basisMemo: 'esc-001' });
  assert.equal(replay.ok, false);
  assert.deepEqual([...ESCROW_RULING_LEVELS], ['first', 'owner']);
});

test('dispute counters: 2 per party max, second one needs new evidence', () => {
  let order = driveTo('PAID_EVIDENCE_UPLOADED');
  const attempt = (note: string, at: number) => applyEscrowTransition(order, {
    actor: 'buyer', action: 'dispute_open', proof: `claim-${at}`, basis: note, note, at,
  });

  // 1st appeal: free-form reason, lands DISPUTED
  const first = attempt('第一次：货未交付', T0 + 10);
  assert.equal(first.ok, true);
  order = first.ok ? first.order : order;
  assert.equal(order.state, 'DISPUTED');
  assert.equal(order.disputesByParty.buyer, 1);

  // 2nd appeal = owner-review request; same reason (no new evidence) is refused
  const sameEvidence = attempt('第一次：货未交付', T0 + 11);
  assert.equal(sameEvidence.ok, false);
  assert.match(sameEvidence.ok ? '' : sameEvidence.reason, /新证据/);
  const emptyReason = attempt('', T0 + 12);
  assert.equal(emptyReason.ok, false);

  // …with new evidence it goes through and marks owner review
  const second = attempt('新证据：对方承认未发货的聊天截图', T0 + 13);
  assert.equal(second.ok, true);
  order = second.ok ? second.order : order;
  assert.equal(order.state, 'DISPUTED');
  assert.equal(order.disputesByParty.buyer, 2);
  assert.match(order.ownerReview?.reason ?? '', /owner review/);

  // 3rd appeal: hard cap
  const third = attempt('第三次：又一次申诉', T0 + 14);
  assert.equal(third.ok, false);
  assert.match(third.ok ? '' : third.reason, /上限 2 次/);
});

// ---------------------------------------------------------------------------
// 5. Five invariants
// ---------------------------------------------------------------------------

test('invariant 1 (zero funds flow): scan catches any funds-through-platform record', () => {
  const clean = driveTo('SELLER_CONFIRMED');
  assert.equal(assertZeroFundsFlow(clean), true);
  const dirty: EscrowOrder = {
    ...clean,
    timeline: [...clean.timeline, { from: 'SELLER_CONFIRMED', to: 'SELLER_CONFIRMED', actor: 'escrow_agent', action: 'record_note', basis: 'platform_transfer 100 CNY to seller', at: T0 + 40 }],
  };
  assert.match(String(assertZeroFundsFlow(dirty)), /invariant 1/);
});

test('invariant 2 + 3: payment-before-escrow impossible; moves require proof (txid/hash/ref)', () => {
  assert.equal(assertNoPaymentBeforeEscrow(driveTo('PAID_EVIDENCE_UPLOADED')), true);
  const noProof = applyEscrowTransition(newOrder(), { actor: 'seller', action: 'escrow_goods', basisMemo: 'esc-001' });
  assert.equal(noProof.ok, false);
  assert.match(noProof.ok ? '' : noProof.reason, /requires proof/);
  // NFT moves demand a 64-hex txid, not an arbitrary string
  const badProof = applyEscrowTransition(newOrder(), { actor: 'seller', action: 'escrow_goods', proof: 'not-a-txid', basisMemo: 'esc-001' });
  assert.equal(badProof.ok, false);
  assert.match(badProof.ok ? '' : badProof.reason, /64-hex/);
  const broken: EscrowOrder = { ...newOrder(), timeline: [{ from: 'CREATED', to: 'ITEM_ESCROWED', actor: 'seller', action: 'escrow_goods', at: T0 + 1 }] };
  assert.match(String(assertProofChainComplete(broken)), /invariant 3/);
});

test('invariant 4 + 5: terminal replay scan + exact-to-cent / memo-anchor gates', () => {
  const released = driveTo('RELEASED');
  assert.equal(assertTerminalIdempotent(released), true);
  const ghost: EscrowOrder = {
    ...released,
    timeline: [...released.timeline, { from: 'RELEASED', to: 'CANCELLED', actor: 'system', action: 'record_note', at: T0 + 50 }],
  };
  assert.match(String(assertTerminalIdempotent(ghost)), /invariant 4/);

  const confirmWrongAmount = applyEscrowTransition(driveTo('PAID_EVIDENCE_UPLOADED'), {
    actor: 'seller', action: 'confirm_received', proof: 'log', basisMemo: 'esc-001', basisAmountCents: 9899, basis: 'amount=9899',
  });
  assert.equal(confirmWrongAmount.ok, false);
  assert.match(confirmWrongAmount.ok ? '' : confirmWrongAmount.reason, /amount mismatch/);

  const missingMemo = applyEscrowTransition(driveTo('ITEM_ESCROWED'), {
    actor: 'buyer', action: 'upload_payment_evidence', proof: 'receipt.png', basisMemo: '转给你了',
  });
  assert.equal(missingMemo.ok, false);
  assert.match(missingMemo.ok ? '' : missingMemo.reason, /orderId/);

  const missingAnchor = { ...driveTo('SELLER_CONFIRMED') };
  assert.equal(assertEvidenceAnchor(missingAnchor), true);
  const forged: EscrowOrder = {
    ...missingAnchor,
    timeline: missingAnchor.timeline.map((e, i, arr) => (i === arr.length - 1 ? { ...e, basis: undefined } : e)),
  };
  assert.match(String(assertEvidenceAnchor(forged)), /invariant 5/);
});

test('every entry in the transition table is reachable in principle (no dead rows) and terminal states have no exits', () => {
  const sources = new Set<string>();
  for (const spec of ESCROW_TRANSITIONS) {
    sources.add(spec.from);
    if (isEscrowTerminalState(spec.from) && spec.action !== 'refund_confirmed') {
      assert.fail(`terminal state ${spec.from} must not accept ${spec.action}`);
    }
  }
  // every non-terminal state except the merged-equivalent ones offers actions
  for (const state of ['CREATED', 'ITEM_ESCROWED', 'PAID_EVIDENCE_UPLOADED', 'SELLER_CONFIRMED', 'DISPUTED'] as const) {
    assert.ok(sources.has(state), `${state} must have at least one legal action`);
  }
  // next-step hints exist for live states only
  assert.equal(escrowNextStep(driveTo('ITEM_ESCROWED'))?.actor, '买方');
  assert.equal(escrowNextStep(driveTo('RELEASED')), null);
});

// ---------------------------------------------------------------------------
// 6. Serialization contract
// ---------------------------------------------------------------------------

test('order is plain JSON: round-trip through stringify keeps timers, transitions and invariants', () => {
  const order = driveTo('PAID_EVIDENCE_UPLOADED');
  const revived = JSON.parse(JSON.stringify(order)) as EscrowOrder;
  assert.deepEqual(revived, order);
  assert.equal(assertEscrowInvariants(revived), true);
  // deadlines are recomputed from fields, not stored: restart-safe
  assert.equal(escrowActiveTimerOf(revived)?.timer, 't3');
  assert.equal(escrowActiveTimerOf(revived)?.deadlineAt, order.stateEnteredAt + 48 * HOUR);
  const next = applyEscrowTransition(revived, {
    actor: 'seller', action: 'confirm_received', proof: 'log-2', basisMemo: 'esc-001', basisAmountCents: 9900, basis: 'amount=9900', at: T0 + 5,
  });
  assert.equal(next.ok, true);
});
