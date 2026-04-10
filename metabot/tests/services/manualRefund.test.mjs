import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { resolveManualRefundDecision } = require('../../dist/core/orders/manualRefund.js');

test('resolveManualRefundDecision marks seller refund_pending orders as manual_action_required', () => {
  const decision = resolveManualRefundDecision({
    id: 'order-1',
    role: 'seller',
    status: 'refund_pending',
    refundRequestPinId: 'refund-request-pin-id',
    coworkSessionId: 'seller-session-id',
    paymentTxid: 'a'.repeat(64),
  });

  assert.equal(decision.required, true);
  assert.equal(decision.state, 'manual_action_required');
  assert.equal(decision.code, 'manual_refund_required');
  assert.equal(decision.ui.kind, 'refund');
  assert.equal(decision.ui.orderId, 'order-1');
  assert.equal(decision.ui.sessionId, 'seller-session-id');
});

test('resolveManualRefundDecision reports no manual action for buyer-side refund_pending orders', () => {
  const decision = resolveManualRefundDecision({
    id: 'order-2',
    role: 'buyer',
    status: 'refund_pending',
    refundRequestPinId: 'refund-request-pin-id',
    coworkSessionId: 'buyer-session-id',
    paymentTxid: 'b'.repeat(64),
  });

  assert.equal(decision.required, false);
  assert.equal(decision.state, 'not_required');
});
