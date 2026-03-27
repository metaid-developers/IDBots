import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  computeOrderDeadlines,
  getTimedOutOrderTransition,
  hasUnresolvedRefund,
  shouldHideProviderForUnresolvedRefund,
  REFUND_HIDE_AFTER_MS,
} = require('../dist-electron/services/serviceOrderState.js');

test('computeOrderDeadlines returns fixed 5m/15m SLA windows', () => {
  const now = 1_770_000_000_000;
  const deadlines = computeOrderDeadlines(now);
  assert.equal(deadlines.firstResponseDeadlineAt, now + 5 * 60_000);
  assert.equal(deadlines.deliveryDeadlineAt, now + 15 * 60_000);
});

test('getTimedOutOrderTransition detects first-response timeout', () => {
  const transition = getTimedOutOrderTransition({
    status: 'awaiting_first_response',
    firstResponseDeadlineAt: 1000,
    deliveryDeadlineAt: 5000,
  }, 1001);
  assert.equal(transition, 'first_response_timeout');
});

test('getTimedOutOrderTransition detects delivery timeout', () => {
  const transition = getTimedOutOrderTransition({
    status: 'in_progress',
    firstResponseDeadlineAt: 1000,
    deliveryDeadlineAt: 5000,
  }, 5001);
  assert.equal(transition, 'delivery_timeout');
});

test('refund helpers split unresolved-risk from 72h hide threshold', () => {
  const now = 1_770_000_000_000;
  const freshPending = {
    status: 'refund_pending',
    refundRequestedAt: now - 1,
    refundCompletedAt: null,
  };
  const stalePending = {
    status: 'refund_pending',
    refundRequestedAt: now - REFUND_HIDE_AFTER_MS - 1,
    refundCompletedAt: null,
  };
  const resolved = {
    status: 'refunded',
    refundRequestedAt: now - REFUND_HIDE_AFTER_MS - 1,
    refundCompletedAt: now - 1,
  };

  assert.equal(hasUnresolvedRefund(freshPending), true);
  assert.equal(hasUnresolvedRefund(stalePending), true);
  assert.equal(hasUnresolvedRefund(resolved), false);
  assert.equal(shouldHideProviderForUnresolvedRefund(freshPending, now), false);
  assert.equal(shouldHideProviderForUnresolvedRefund(stalePending, now), true);
  assert.equal(shouldHideProviderForUnresolvedRefund(resolved, now), false);
});
