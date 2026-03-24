import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeliveryMessage,
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
