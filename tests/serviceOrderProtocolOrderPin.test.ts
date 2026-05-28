import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNeedsRatingMessage,
  buildOrderEndMessage,
  buildOrderStatusMessage,
  parseNeedsRatingMessage,
  parseOrderEndMessage,
  parseOrderStatusMessage,
} from '../src/main/services/serviceOrderProtocols.js';

test('order status, rating, and order end messages carry a parsable service order pin id', () => {
  const orderPinId = 'free-order-pin-i0';

  const status = buildOrderStatusMessage('', '正在处理免费订单。', orderPinId);
  assert.match(status, /order pin id:\s*free-order-pin-i0/i);
  assert.equal(parseOrderStatusMessage(status)?.orderPinId, orderPinId);
  assert.equal(parseOrderStatusMessage(status)?.content, '正在处理免费订单。');

  const needsRating = buildNeedsRatingMessage('', '服务已完成，请评价。', orderPinId);
  assert.match(needsRating, /order pin id:\s*free-order-pin-i0/i);
  assert.equal(parseNeedsRatingMessage(needsRating)?.orderPinId, orderPinId);
  assert.equal(parseNeedsRatingMessage(needsRating)?.content, '服务已完成，请评价。');

  const orderEnd = buildOrderEndMessage('', 'rated', '评分：5分。', orderPinId);
  assert.match(orderEnd, /order pin id:\s*free-order-pin-i0/i);
  assert.equal(parseOrderEndMessage(orderEnd)?.orderPinId, orderPinId);
  assert.equal(parseOrderEndMessage(orderEnd)?.reason, 'rated');
  assert.equal(parseOrderEndMessage(orderEnd)?.content, '评分：5分。');
});

test('legacy txid-tagged order protocol messages still parse order txid', () => {
  const orderTxid = 'a'.repeat(64);
  const status = buildOrderStatusMessage(orderTxid, 'paid order status');

  const parsed = parseOrderStatusMessage(status);
  assert.equal(parsed?.orderTxid, orderTxid);
  assert.equal(parsed?.orderPinId, undefined);
  assert.equal(parsed?.content, 'paid order status');
});
