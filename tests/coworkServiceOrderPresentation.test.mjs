import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCoworkServiceOrderTone,
  shouldShowRefundStatusCard,
} from '../src/renderer/components/cowork/coworkServiceOrderPresentation.js';

test('refund-pending sessions use warning tone and show the refund card', () => {
  assert.equal(getCoworkServiceOrderTone({ status: 'refund_pending' }), 'warning');
  assert.equal(shouldShowRefundStatusCard({ status: 'refund_pending' }), true);
});

test('refunded sessions use success tone and keep the refund card visible', () => {
  assert.equal(getCoworkServiceOrderTone({ status: 'refunded' }), 'success');
  assert.equal(shouldShowRefundStatusCard({ status: 'refunded' }), true);
});
