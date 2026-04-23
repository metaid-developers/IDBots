import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
