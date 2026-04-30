import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRefundStatusDismissKey,
  getRefundCardVariant,
  shouldShowRefundStatusCard,
} from '../src/renderer/components/cowork/coworkServiceOrderPresentation.js';

test('seller refund_pending summaries still render the seller action variant', () => {
  const summary = {
    role: 'seller',
    status: 'refund_pending',
    failureReason: 'delivery_timeout',
    refundRequestPinId: 'refund-pin-1',
    refundTxid: null,
  };

  assert.equal(shouldShowRefundStatusCard(summary), true);
  assert.equal(getRefundCardVariant(summary), 'seller-action');
});

test('buyer refund_pending and refunded summaries keep their legacy variants', () => {
  assert.equal(getRefundCardVariant({ role: 'buyer', status: 'refund_pending' }), 'buyer-pending');
  assert.equal(getRefundCardVariant({ role: 'buyer', status: 'refunded' }), 'refunded');
  assert.equal(getRefundCardVariant({ role: 'seller', status: 'refunded' }), 'refunded');
});

test('refund status dismiss key is stable for one order across refund status changes', () => {
  const paymentTxid = 'a'.repeat(64);
  const refundRequestPinId = 'b'.repeat(64) + 'i0';
  const pendingKey = buildRefundStatusDismissKey('session-1', {
    role: 'seller',
    status: 'refund_pending',
    paymentTxid,
    refundRequestPinId,
  });
  const refundedKey = buildRefundStatusDismissKey('session-1', {
    role: 'seller',
    status: 'refunded',
    paymentTxid,
    refundRequestPinId,
    refundTxid: 'c'.repeat(64),
  });

  assert.equal(pendingKey, refundedKey);
  assert.match(pendingKey, /session-1/);
  assert.match(pendingKey, new RegExp(paymentTxid));
});

test('dismissed refund status keys suppress the A2A refund status card', () => {
  const summary = {
    role: 'seller',
    status: 'refund_pending',
    paymentTxid: 'a'.repeat(64),
    refundRequestPinId: 'b'.repeat(64) + 'i0',
  };
  const dismissKey = buildRefundStatusDismissKey('session-1', summary);

  assert.equal(shouldShowRefundStatusCard(summary, {
    dismissKey,
    dismissedKeys: new Set([dismissKey]),
  }), false);
  assert.equal(shouldShowRefundStatusCard(summary, {
    dismissKey,
    dismissedKeys: new Set(['other-key']),
  }), true);
});
