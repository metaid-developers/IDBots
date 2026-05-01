import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanonicalPrivateConversationExternalConversationId,
  buildOrderProtocolDisplayMetadata,
  classifySimplemsgContent,
  isServiceOrderActiveForPrivateChatSuppression,
} from '../src/main/services/simplemsgPeerConversation';

test('classifySimplemsgContent recognizes scoped order protocol tags', () => {
  const orderTxid = 'a'.repeat(64);

  assert.deepEqual(classifySimplemsgContent('[ORDER] do work'), {
    kind: 'order_protocol',
    tag: 'ORDER',
  });
  assert.equal(
    classifySimplemsgContent(`[ORDER_STATUS:${orderTxid}] processing`).orderTxid,
    orderTxid,
  );
  assert.equal(
    classifySimplemsgContent(`[DELIVERY:${orderTxid}] {"result":"done"}`).tag,
    'DELIVERY',
  );
  assert.equal(
    classifySimplemsgContent(`[NeedsRating:${orderTxid}] please rate`).tag,
    'NeedsRating',
  );
  assert.deepEqual(
    classifySimplemsgContent(`[ORDER_END:${orderTxid} rated] thanks`),
    {
      kind: 'order_protocol',
      tag: 'ORDER_END',
      orderTxid,
      reason: 'rated',
    },
  );
});

test('classifySimplemsgContent leaves ordinary private chat untagged', () => {
  assert.deepEqual(classifySimplemsgContent('hello there'), { kind: 'private_chat' });
});

test('buildCanonicalPrivateConversationExternalConversationId uses peer global metaid', () => {
  assert.equal(
    buildCanonicalPrivateConversationExternalConversationId(' idq-peer '),
    'metaweb-private:idq-peer',
  );
});

test('buildOrderProtocolDisplayMetadata marks order events inside peer conversations', () => {
  assert.deepEqual(
    buildOrderProtocolDisplayMetadata({
      peerGlobalMetaId: 'peer-global',
      direction: 'outgoing',
      tag: 'DELIVERY',
      orderTxid: 'a'.repeat(64),
      orderRole: 'seller',
      paymentTxid: 'b'.repeat(64),
      orderMappingExternalConversationId: 'metaweb_order:seller:1:peer-global:aaaaaaaaaaaaaaaa',
      extra: { pinId: 'pin-1' },
    }),
    {
      sourceChannel: 'metaweb_private',
      externalConversationId: 'metaweb-private:peer-global',
      direction: 'outgoing',
      simplemsgKind: 'order_protocol',
      orderProtocolTag: 'DELIVERY',
      orderTxid: 'a'.repeat(64),
      orderRole: 'seller',
      paymentTxid: 'b'.repeat(64),
      orderPaymentTxid: 'b'.repeat(64),
      orderMappingExternalConversationId: 'metaweb_order:seller:1:peer-global:aaaaaaaaaaaaaaaa',
      pinId: 'pin-1',
    },
  );
});

test('isServiceOrderActiveForPrivateChatSuppression matches current order statuses', () => {
  const base = {
    role: 'buyer',
    status: 'awaiting_first_response',
    refundRequestPinId: null,
    refundTxid: null,
    refundCompletedAt: null,
  };

  for (const status of ['awaiting_first_response', 'in_progress', 'rating_pending', 'refund_pending']) {
    assert.equal(isServiceOrderActiveForPrivateChatSuppression({ ...base, status }), true);
  }

  assert.equal(isServiceOrderActiveForPrivateChatSuppression({ ...base, status: 'completed' }), false);
  assert.equal(isServiceOrderActiveForPrivateChatSuppression({ ...base, status: 'refunded' }), false);
  assert.equal(isServiceOrderActiveForPrivateChatSuppression({ ...base, status: 'failed' }), true);
  assert.equal(
    isServiceOrderActiveForPrivateChatSuppression({
      ...base,
      status: 'failed',
      refundRequestPinId: 'pin',
    }),
    false,
  );
});
