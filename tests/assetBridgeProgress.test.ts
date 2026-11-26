import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAssetBridgeProgress } from '../src/renderer/components/chat/assetBridgeProgress';

const MIN = 60_000;
const base = {
  state: 'bridging' as const,
  stage: 'confirming' as const,
  requiredConfirmations: 3,
  confirmations: 0,
  broadcastAt: 1_000_000,
  lastConfirmationAt: 1_000_000,
};

test('asset bridge progress: zero confirmations starts empty and advances mid-block', () => {
  const start = computeAssetBridgeProgress({ ...base, now: 1_000_000 });
  assert.equal(start.percent, 0);
  assert.equal(start.blocksDone, 0);
  assert.equal(start.currentBlockIndex, 1);
  assert.equal(start.currentFraction, 0);
  assert.equal(start.pinned, false);
  assert.equal(start.remainingMinutes, 31);

  const mid = computeAssetBridgeProgress({ ...base, now: 1_000_000 + 5 * MIN });
  assert.equal(mid.currentFraction, 0.5);
  assert.ok(Math.abs(mid.percent - (0.5 / 3.5) * 100) < 0.000001);
  assert.equal(mid.remainingMinutes, 26);
  assert.ok(mid.percent > start.percent);
});

test('asset bridge progress: current block pins at ninety percent after nine minutes', () => {
  const pinned = computeAssetBridgeProgress({ ...base, now: 1_000_000 + 9.5 * MIN });
  assert.equal(pinned.currentFraction, 0.9);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.remainingMinutes, null);
  assert.ok(Math.abs(pinned.percent - (0.9 / 3.5) * 100) < 0.000001);
});

test('asset bridge progress: confirmation advances reset to the next block', () => {
  const twoDone = computeAssetBridgeProgress({
    ...base,
    confirmations: 2,
    lastConfirmationAt: 2_000_000,
    now: 2_000_000 + 2 * MIN,
  });
  assert.equal(twoDone.blocksDone, 2);
  assert.equal(twoDone.currentBlockIndex, 3);
  assert.equal(twoDone.currentFraction, 0.2);
  assert.ok(Math.abs(twoDone.percent - (2.2 / 3.5) * 100) < 0.000001);
  assert.equal(twoDone.pinned, false);
});

test('asset bridge progress: paying out uses the half-unit payout segment', () => {
  const payout = computeAssetBridgeProgress({
    ...base,
    stage: 'paying_out',
    confirmations: 3,
    lastConfirmationAt: 2_000_000,
    now: 2_000_000 + 30_000,
  });
  assert.equal(payout.payoutActive, true);
  assert.equal(payout.blocksDone, 3);
  assert.equal(payout.currentFraction, 0.5);
  assert.ok(Math.abs(payout.percent - ((3 + 0.25) / 3.5) * 100) < 0.000001);
  assert.equal(payout.remainingMinutes, 1);
});

test('asset bridge progress: completed is exactly one hundred percent', () => {
  const done = computeAssetBridgeProgress({ ...base, state: 'completed', now: 3_000_000 });
  assert.equal(done.percent, 100);
  assert.equal(done.blocksDone, 3);
  assert.equal(done.currentFraction, 1);
});

test('asset bridge progress: clamps null, negative, and backwards clock inputs', () => {
  const clamped = computeAssetBridgeProgress({
    state: 'bridging',
    stage: 'confirming',
    requiredConfirmations: -4,
    confirmations: -2,
    lastConfirmationAt: 5_000,
    broadcastAt: null,
    now: 1_000,
  });
  assert.equal(clamped.percent, 0);
  assert.equal(clamped.blocksDone, 0);
  assert.equal(clamped.currentBlockIndex, 1);
  assert.equal(clamped.currentFraction, 0);
  assert.equal(clamped.pinned, false);

  const nulls = computeAssetBridgeProgress({
    state: 'bridging',
    stage: 'confirming',
    requiredConfirmations: null,
    confirmations: null,
    lastConfirmationAt: null,
    broadcastAt: null,
    now: Number.NaN,
  });
  assert.equal(nulls.percent, 0);
  assert.equal(nulls.remainingMinutes, 11);
});

test('asset bridge progress: percent is monotonic for increasing now with fixed inputs', () => {
  let previous = -1;
  for (let minute = 0; minute <= 20; minute += 1) {
    const value = computeAssetBridgeProgress({ ...base, now: base.lastConfirmationAt + minute * MIN });
    assert.ok(value.percent >= previous);
    previous = value.percent;
  }
});
