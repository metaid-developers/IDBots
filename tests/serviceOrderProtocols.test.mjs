import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeliveryMessage,
  buildRefundRequestPayload,
  parseDeliveryMessage,
} from '../src/main/services/serviceOrderProtocols.js';

test('buildDeliveryMessage emits a [DELIVERY] envelope with paymentTxid and servicePinId', () => {
  const text = buildDeliveryMessage({
    paymentTxid: 'a'.repeat(64),
    servicePinId: 'pin123',
    serviceName: 'Weather Pro',
    result: 'done',
    deliveredAt: 1_770_000_000,
  });

  assert.match(text, /^\[DELIVERY\]/);
  assert.deepEqual(parseDeliveryMessage(text), {
    paymentTxid: 'a'.repeat(64),
    servicePinId: 'pin123',
    serviceName: 'Weather Pro',
    result: 'done',
    deliveredAt: 1_770_000_000,
  });
});

test('parseDeliveryMessage ignores plain text and malformed envelopes', () => {
  assert.equal(parseDeliveryMessage('plain text result'), null);
  assert.equal(parseDeliveryMessage('[DELIVERY] not-json'), null);
});

test('buildRefundRequestPayload emits the agreed refund request shape', () => {
  const payload = buildRefundRequestPayload({
    paymentTxid: 'a'.repeat(64),
    servicePinId: 'service-pin-id',
    serviceName: 'Weather Pro',
    refundAmount: '12.34',
    refundCurrency: 'SPACE',
    refundToAddress: 'buyer-address',
    buyerGlobalMetaId: 'buyer-global-metaid',
    sellerGlobalMetaId: 'seller-global-metaid',
    orderMessagePinId: 'order-pin-id',
    failureReason: 'first_response_timeout',
    failureDetectedAt: 1_770_000_000,
    evidencePinIds: ['order-pin-id'],
  });

  assert.deepEqual(payload, {
    version: '1.0.0',
    paymentTxid: 'a'.repeat(64),
    servicePinId: 'service-pin-id',
    serviceName: 'Weather Pro',
    refundAmount: '12.34',
    refundCurrency: 'SPACE',
    refundToAddress: 'buyer-address',
    buyerGlobalMetaId: 'buyer-global-metaid',
    sellerGlobalMetaId: 'seller-global-metaid',
    orderMessagePinId: 'order-pin-id',
    failureReason: 'first_response_timeout',
    failureDetectedAt: 1_770_000_000,
    reasonComment: '服务超时',
    evidencePinIds: ['order-pin-id'],
  });
});
