import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCoworkServiceOrderTone,
  getRefundCardVariant,
  shouldShowRefundStatusCard,
} from '../src/renderer/components/cowork/coworkServiceOrderPresentation.js';
import {
  getCoworkSessionTitleClassName,
} from '../src/renderer/components/cowork/coworkSessionPresentation.js';

test('refund-pending sessions use warning tone and show the refund card', () => {
  assert.equal(getCoworkServiceOrderTone({ status: 'refund_pending' }), 'warning');
  assert.equal(shouldShowRefundStatusCard({ status: 'refund_pending' }), true);
});

test('refunded sessions use success tone and keep the refund card visible', () => {
  assert.equal(getCoworkServiceOrderTone({ status: 'refunded' }), 'success');
  assert.equal(shouldShowRefundStatusCard({ status: 'refunded' }), true);
});

test('warning sessions switch the title class from blue A2A to orange refund warning', () => {
  assert.match(
    getCoworkSessionTitleClassName({
      sessionType: 'a2a',
      serviceOrderStatus: 'refund_pending',
    }),
    /orange|amber/
  );
  assert.doesNotMatch(
    getCoworkSessionTitleClassName({
      sessionType: 'a2a',
      serviceOrderStatus: 'completed',
    }),
    /orange|amber/
  );
});

test('buyer refund card shows waiting copy while seller refund card shows action-required copy', () => {
  assert.equal(
    getRefundCardVariant({ role: 'buyer', status: 'refund_pending' }),
    'buyer-pending'
  );
  assert.equal(
    getRefundCardVariant({ role: 'seller', status: 'refund_pending' }),
    'seller-action'
  );
  assert.equal(
    getRefundCardVariant({ role: 'buyer', status: 'refunded' }),
    'refunded'
  );
});
