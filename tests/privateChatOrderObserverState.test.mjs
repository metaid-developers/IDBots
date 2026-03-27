import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDeliveryMessage,
  isNeedsRatingMessage,
  shouldCompleteBuyerOrderObserverSession,
} from '../src/main/services/privateChatOrderObserverState.js';

test('buyer observer session completes when seller sends a delivery or needs-rating terminal message', () => {
  assert.equal(
    shouldCompleteBuyerOrderObserverSession('[DELIVERY] {"paymentTxid":"abc","result":"done"}'),
    true
  );
  assert.equal(shouldCompleteBuyerOrderObserverSession('[NeedsRating] 服务已完成，请给个评价吧！'), true);
  assert.equal(shouldCompleteBuyerOrderObserverSession('服务已完成，结果如下'), false);
});

test('needs-rating prefix matching is whitespace tolerant and case insensitive', () => {
  assert.equal(isNeedsRatingMessage('  [needsrating] please rate this service'), true);
  assert.equal(isNeedsRatingMessage('[ORDER] txid=abc123'), false);
});

test('delivery prefix matching is whitespace tolerant and parse-backed', () => {
  assert.equal(isDeliveryMessage('  [DELIVERY] {"paymentTxid":"abc","result":"done"}'), true);
  assert.equal(isDeliveryMessage('[NeedsRating] please rate this service'), false);
});
