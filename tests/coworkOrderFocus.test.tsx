import test from 'node:test';
import assert from 'node:assert/strict';
import type { CoworkMessage } from '../src/renderer/types/cowork';
import {
  buildOrderFocusRequestKey,
  findFocusedOrderMessageId,
  resolveMessageOrderTxid,
  shouldRunOrderFocusRequest,
} from '../src/renderer/components/cowork/CoworkSessionDetail';

const makeMessage = (id: string, content: string, metadata: Record<string, unknown> = {}): CoworkMessage => ({
  id,
  type: 'assistant',
  content,
  timestamp: 1,
  metadata,
});

test('resolveMessageOrderTxid prefers metadata and falls back to scoped order tags', () => {
  const orderTxid = 'a'.repeat(64);
  assert.equal(
    resolveMessageOrderTxid(makeMessage('metadata', 'plain status', { orderTxid })),
    orderTxid,
  );
  assert.equal(
    resolveMessageOrderTxid(makeMessage('status', `[ORDER_STATUS:${orderTxid}] processing`)),
    orderTxid,
  );
  assert.equal(
    resolveMessageOrderTxid(makeMessage('delivery', `[DELIVERY:${orderTxid}] {"result":"done"}`)),
    orderTxid,
  );
  assert.equal(
    resolveMessageOrderTxid(makeMessage('end', `[ORDER_END:${orderTxid} rated] done`)),
    orderTxid,
  );
  assert.equal(resolveMessageOrderTxid(makeMessage('ordinary', 'hello')), null);
});

test('findFocusedOrderMessageId returns the first message for a focused order', () => {
  const firstOrderTxid = '1'.repeat(64);
  const secondOrderTxid = '2'.repeat(64);
  const messages = [
    makeMessage('ordinary', 'hello'),
    makeMessage('first', `[ORDER_STATUS:${firstOrderTxid}] processing`),
    makeMessage('second', 'delivery ready', { orderTxid: secondOrderTxid }),
    makeMessage('first-later', `[DELIVERY:${firstOrderTxid}] {"result":"done"}`),
  ];

  assert.equal(findFocusedOrderMessageId(messages, firstOrderTxid), 'first');
  assert.equal(findFocusedOrderMessageId(messages, secondOrderTxid), 'second');
  assert.equal(findFocusedOrderMessageId(messages, '3'.repeat(64)), null);
  assert.equal(findFocusedOrderMessageId(messages, null), null);
});

test('order focus request helper only runs a session/order focus once', () => {
  const orderTxid = 'a'.repeat(64);
  const key = buildOrderFocusRequestKey(' session-1 ', ` ${orderTxid.toUpperCase()} `);

  assert.equal(key, `session-1:${orderTxid}`);
  assert.equal(shouldRunOrderFocusRequest(null, 'session-1', orderTxid), true);
  assert.equal(shouldRunOrderFocusRequest(key, 'session-1', orderTxid), false);
  assert.equal(shouldRunOrderFocusRequest(key, 'session-2', orderTxid), true);
  assert.equal(shouldRunOrderFocusRequest(key, 'session-1', 'b'.repeat(64)), true);
  assert.equal(shouldRunOrderFocusRequest(null, 'session-1', 'not-a-txid'), false);
});
