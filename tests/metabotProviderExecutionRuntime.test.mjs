import test from 'node:test';
import assert from 'node:assert/strict';

const PAID_REQUEST = {
  correlation: {
    requestId: 'req-paid-1',
    requesterSessionId: 'session-paid-1',
    requesterConversationId: 'conversation-paid-1',
  },
  servicePinId: 'pin-1',
  requesterGlobalMetaId: 'idq1buyer',
  price: '0.01',
  currency: 'DOGE',
  paymentProof: {
    txid: 'a'.repeat(64),
    chain: 'doge',
    amount: '0.01',
    currency: 'DOGE',
    orderMessage: '[ORDER]\npayment amount: 0.01 DOGE\nservice pin id: pin-1',
    orderMessagePinId: 'order-pin-1',
  },
  userTask: 'summarize the filing',
  taskContext: 'full filing text',
  executionMode: 'paid',
};

test('executeProviderRequest auto-starts a host session and waits for exactly one result', async () => {
  const calls = [];
  const { executeProviderRequest } = await import('../dist-electron/metabotRuntime/providerExecutionRuntime.js');

  const result = await executeProviderRequest({
    request: PAID_REQUEST,
    verification: {
      executable: true,
      reason: 'verified',
      payment: {
        paid: true,
        txid: 'a'.repeat(64),
        reason: 'verified',
        chain: 'doge',
        amountSats: 1_000_000,
      },
      orderSkillId: 'pin-1',
      orderReferenceId: null,
    },
    providerContext: {
      metabotId: 7,
      source: 'metaweb_private',
      counterpartyGlobalMetaId: 'idq1buyer',
      serviceName: 'Service One',
      paymentTxid: 'a'.repeat(64),
      paymentChain: 'doge',
      paymentAmount: '0.01',
      paymentCurrency: 'DOGE',
      orderMessagePinId: 'order-pin-1',
      coworkSessionId: 'seller-session-1',
      externalConversationId: 'metaweb_order:seller:1',
      prompt: 'do the work',
      systemPrompt: 'you are the provider',
    },
    trace: {
      createSellerOrder(input) {
        calls.push(['createSellerOrder', input]);
        return { id: 'seller-order-1' };
      },
    },
    hostAdapter: {
      async startProviderSession(input) {
        calls.push(['startProviderSession', input]);
        return { sessionId: 'provider-session-1' };
      },
      async waitForProviderResult(sessionId) {
        calls.push(['waitForProviderResult', sessionId]);
        return {
          sessionId,
          text: 'done',
          attachments: ['metafile://pin123', 'https://example.com/not-allowed'],
        };
      },
    },
  });

  assert.deepEqual(calls.map(([name]) => name), [
    'createSellerOrder',
    'startProviderSession',
    'waitForProviderResult',
  ]);
  assert.equal(result.sessionId, 'provider-session-1');
  assert.equal(result.text, 'done');
  assert.deepEqual(result.attachments, ['metafile://pin123']);
});

test('executeProviderRequest rejects a non-executable paid request before host start', async () => {
  const { executeProviderRequest } = await import('../dist-electron/metabotRuntime/providerExecutionRuntime.js');
  let hostStarted = false;
  let traceStarted = false;

  const result = await executeProviderRequest({
    request: PAID_REQUEST,
    verification: {
      executable: false,
      reason: 'invalid_or_missing_txid',
      payment: {
        paid: false,
        txid: null,
        reason: 'invalid_or_missing_txid',
      },
      orderSkillId: 'pin-1',
      orderReferenceId: null,
    },
    providerContext: {
      metabotId: 7,
      source: 'metaweb_private',
      counterpartyGlobalMetaId: 'idq1buyer',
      serviceName: 'Service One',
      paymentTxid: null,
      paymentChain: 'doge',
      paymentAmount: '0.01',
      paymentCurrency: 'DOGE',
      orderMessagePinId: 'order-pin-1',
      prompt: 'do the work',
      systemPrompt: 'you are the provider',
    },
    trace: {
      createSellerOrder() {
        traceStarted = true;
        return { id: 'seller-order-1' };
      },
    },
    hostAdapter: {
      async startProviderSession() {
        hostStarted = true;
        return { sessionId: 'provider-session-1' };
      },
      async waitForProviderResult() {
        hostStarted = true;
        return { sessionId: 'provider-session-1', text: 'done' };
      },
    },
  });

  assert.equal(traceStarted, false);
  assert.equal(hostStarted, false);
  assert.equal(result.executable, false);
  assert.equal(result.reason, 'invalid_or_missing_txid');
});

test('MetabotDaemon.handleWakeUp calls payment verification first, then writes delivery before emitting provider_delivery', async () => {
  const calls = [];
  const { MetabotDaemon } = await import('../dist-electron/metabotRuntime/metabotDaemon.js');

  const daemon = new MetabotDaemon({
    verifyPortablePaymentEligibility: async () => {
      calls.push('verify');
      return {
        executable: true,
        reason: 'verified',
        payment: {
          paid: true,
          txid: 'a'.repeat(64),
          reason: 'verified',
          chain: 'doge',
          amountSats: 1_000_000,
        },
        orderSkillId: 'pin-1',
        orderReferenceId: null,
      };
    },
    createServiceOrderTraceWriter: () => {
      calls.push('createTraceWriter');
      return {
        createSellerOrder() {
          calls.push('trace.createSellerOrder');
          return { id: 'seller-order-1' };
        },
        markSellerDelivered() {
          calls.push('trace.markSellerDelivered');
          return { id: 'seller-order-1', status: 'delivered' };
        },
      };
    },
    executeProviderRequest: async ({ trace }) => {
      calls.push('execute');
      trace.createSellerOrder({
        localMetabotId: 7,
        counterpartyGlobalMetaId: 'idq1buyer',
        servicePinId: 'pin-1',
        serviceName: 'Service One',
        paymentTxid: 'a'.repeat(64),
        paymentChain: 'doge',
        paymentAmount: '0.01',
        paymentCurrency: 'DOGE',
        orderMessagePinId: 'order-pin-1',
      });
      return {
        executable: true,
        request: PAID_REQUEST,
        paymentTxid: 'a'.repeat(64),
        sessionId: 'provider-session-1',
        text: 'done',
        attachments: ['metafile://pin123'],
      };
    },
    writePortableDeliveryRecord: async () => {
      calls.push('writeDelivery');
      return {
        request: PAID_REQUEST,
        deliveryWrite: {
          requestId: 'req-paid-1',
          requesterSessionId: 'session-paid-1',
          requesterConversationId: 'conversation-paid-1',
          servicePinId: 'pin-1',
          paymentTxid: 'a'.repeat(64),
          deliveryMessagePinId: 'delivery-pin-1',
          text: 'done',
          attachments: ['metafile://pin123'],
          deliveredAt: 1_700_000_000,
        },
      };
    },
    buildDeliveryTransportEnvelope: ({ deliveryWrite }) => {
      calls.push('emitDelivery');
      return {
        type: 'provider_delivery',
        request_id: deliveryWrite.requestId,
        requester_session_id: deliveryWrite.requesterSessionId,
        requester_conversation_id: deliveryWrite.requesterConversationId,
        service_pin_id: deliveryWrite.servicePinId,
        payment_txid: deliveryWrite.paymentTxid,
        delivery_message_pin_id: deliveryWrite.deliveryMessagePinId,
        text: deliveryWrite.text,
        attachments: deliveryWrite.attachments,
        delivered_at: deliveryWrite.deliveredAt,
      };
    },
  });

  const result = await daemon.handleWakeUp({
    request: PAID_REQUEST,
    providerContext: {
      metabotId: 7,
      metabotStore: { id: 'fake-store' },
      source: 'metaweb_private',
      counterpartyGlobalMetaId: 'idq1buyer',
      serviceName: 'Service One',
      paymentTxid: 'a'.repeat(64),
      paymentChain: 'doge',
      paymentAmount: '0.01',
      paymentCurrency: 'DOGE',
      orderMessagePinId: 'order-pin-1',
      prompt: 'do the work',
      systemPrompt: 'you are the provider',
    },
    hostAdapter: {
      async startProviderSession() {
        return { sessionId: 'provider-session-1' };
      },
      async waitForProviderResult() {
        return { sessionId: 'provider-session-1', text: 'done' };
      },
    },
  });

  assert.deepEqual(calls, [
    'verify',
    'createTraceWriter',
    'execute',
    'trace.createSellerOrder',
    'writeDelivery',
    'emitDelivery',
  ]);
  assert.equal(result.providerDelivery.type, 'provider_delivery');
  assert.equal(result.providerDelivery.delivery_message_pin_id, 'delivery-pin-1');
});
