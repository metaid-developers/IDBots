import test from 'node:test';
import assert from 'node:assert/strict';

test('verifyPortablePaymentEligibility reuses IDBots payment verification semantics', async () => {
  const { verifyPortablePaymentEligibility } = await import('../dist-electron/metabotRuntime/paymentVerificationRuntime.js');

  const result = await verifyPortablePaymentEligibility({
    request: {
      correlation: {
        requestId: 'req-paid-1',
        requesterSessionId: 'session-paid-1',
        requesterConversationId: 'conversation-paid-1',
      },
      servicePinId: 'pin-paid',
      requesterGlobalMetaId: 'idq1buyer',
      price: '0.02',
      currency: 'DOGE',
      paymentProof: {
        txid: 'a'.repeat(64),
        chain: 'doge',
        amount: '0.02',
        currency: 'DOGE',
        orderMessage: '[ORDER]\npayment amount: 0.02 DOGE\nservice pin id: pin-paid',
        orderMessagePinId: 'order-pin-1',
      },
      userTask: 'translate',
      taskContext: 'context',
      executionMode: 'paid',
    },
    providerContext: {
      metabotId: 7,
      metabotStore: { id: 'fake-store' },
      source: 'metaweb_private',
    },
    checkOrderPaymentStatusImpl: async ({ txid, plaintext, metabotId }) => {
      assert.equal(txid, 'a'.repeat(64));
      assert.match(plaintext, /0.02 DOGE/);
      assert.equal(metabotId, 7);
      return { paid: true, txid, reason: 'verified', chain: 'doge', amountSats: 2_000_000 };
    },
  });

  assert.equal(result.executable, true);
  assert.equal(result.payment.reason, 'verified');
  assert.equal(result.payment.chain, 'doge');
});

test('verifyPortablePaymentEligibility rejects payment proofs for a different service pin', async () => {
  const { verifyPortablePaymentEligibility } = await import('../dist-electron/metabotRuntime/paymentVerificationRuntime.js');

  const result = await verifyPortablePaymentEligibility({
    request: {
      correlation: {
        requestId: 'req-paid-2',
        requesterSessionId: 'session-paid-2',
        requesterConversationId: 'conversation-paid-2',
      },
      servicePinId: 'pin-expected',
      requesterGlobalMetaId: 'idq1buyer',
      price: '0.02',
      currency: 'DOGE',
      paymentProof: {
        txid: 'b'.repeat(64),
        chain: 'doge',
        amount: '0.02',
        currency: 'DOGE',
        orderMessage: '[ORDER]\npayment amount: 0.02 DOGE\nservice pin id: pin-other',
        orderMessagePinId: 'order-pin-2',
      },
      userTask: 'translate',
      taskContext: 'context',
      executionMode: 'paid',
    },
    providerContext: {
      metabotId: 7,
      metabotStore: { id: 'fake-store' },
      source: 'metaweb_private',
    },
    checkOrderPaymentStatusImpl: async () => ({
      paid: true,
      txid: 'b'.repeat(64),
      reason: 'verified',
      chain: 'doge',
      amountSats: 2_000_000,
    }),
  });

  assert.equal(result.executable, false);
  assert.equal(result.reason, 'service_pin_mismatch');
});

test('verifyPortablePaymentEligibility rejects malformed free-order payloads that do not prove a free order', async () => {
  const { verifyPortablePaymentEligibility } = await import('../dist-electron/metabotRuntime/paymentVerificationRuntime.js');
  let called = false;

  const result = await verifyPortablePaymentEligibility({
    request: {
      correlation: {
        requestId: 'req-free-bad-1',
        requesterSessionId: 'session-free-bad-1',
        requesterConversationId: 'conversation-free-bad-1',
      },
      servicePinId: 'pin-free',
      requesterGlobalMetaId: 'idq1buyer',
      price: '0',
      currency: 'SPACE',
      paymentProof: {
        txid: null,
        chain: null,
        amount: '0',
        currency: 'SPACE',
        orderMessage: '[ORDER]\nservice pin id: pin-free',
        orderMessagePinId: 'order-pin-bad-1',
      },
      userTask: 'translate',
      taskContext: 'context',
      executionMode: 'free',
    },
    providerContext: {
      metabotId: 7,
      metabotStore: { id: 'fake-store' },
      source: 'metaweb_private',
    },
    checkOrderPaymentStatusImpl: async ({ txid, plaintext }) => {
      called = true;
      assert.equal(txid, null);
      assert.match(plaintext, /service pin id: pin-free/);
      return {
        paid: false,
        txid: null,
        reason: 'cannot_parse_amount_or_currency',
      };
    },
  });

  assert.equal(called, true);
  assert.equal(result.executable, false);
  assert.equal(result.reason, 'cannot_parse_amount_or_currency');
});
