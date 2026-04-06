import test from 'node:test';
import assert from 'node:assert/strict';

test('buildProviderWakeUpEnvelope uses the persisted request-write record, not caller-only fields', async () => {
  const { buildProviderWakeUpEnvelope } = await import('../dist-electron/metabotRuntime/transportRuntime.js');
  const envelope = buildProviderWakeUpEnvelope({
    request: {
      correlation: {
        requestId: 'req-1',
        requesterSessionId: 'session-1',
        requesterConversationId: 'conversation-1',
      },
      servicePinId: 'pin-1',
      requesterGlobalMetaId: 'idq1requester',
      price: '0',
      currency: 'SPACE',
      paymentProof: { txid: null, chain: null, amount: '0', currency: 'SPACE', orderMessage: '', orderMessagePinId: null },
      userTask: 'summarize',
      taskContext: 'context',
      executionMode: 'free',
    },
    requestWrite: {
      requestId: 'req-1',
      requesterSessionId: 'session-1',
      requesterConversationId: 'conversation-1',
      servicePinId: 'pin-1',
      orderMessagePinId: 'order-pin-1',
      paymentTxid: null,
    },
  });

  assert.equal(envelope.request_id, 'req-1');
  assert.equal(envelope.requester_session_id, 'session-1');
  assert.equal(envelope.order_message_pin_id, 'order-pin-1');
});

test('buildDeliveryTransportEnvelope carries the persisted delivery-write correlation fields', async () => {
  const { buildDeliveryTransportEnvelope } = await import('../dist-electron/metabotRuntime/transportRuntime.js');
  const envelope = buildDeliveryTransportEnvelope({
    request: {
      correlation: { requestId: 'req-2', requesterSessionId: 'session-2', requesterConversationId: 'conversation-2' },
      servicePinId: 'pin-1',
      requesterGlobalMetaId: 'idq1requester',
      price: '0',
      currency: 'SPACE',
      paymentProof: { txid: 'order-2', chain: 'mvc', amount: '0', currency: 'SPACE', orderMessage: '', orderMessagePinId: 'order-pin-2' },
      userTask: 'summarize',
      taskContext: 'context',
      executionMode: 'free',
    },
    deliveryWrite: {
      requestId: 'req-2',
      requesterSessionId: 'session-2',
      requesterConversationId: 'conversation-2',
      servicePinId: 'pin-1',
      paymentTxid: 'order-2',
      deliveryMessagePinId: 'delivery-pin-2',
      text: 'done',
      attachments: ['metafile://pin123'],
      deliveredAt: 1700000000,
    },
  });

  assert.equal(envelope.request_id, 'req-2');
  assert.equal(envelope.requester_session_id, 'session-2');
  assert.equal(envelope.delivery_message_pin_id, 'delivery-pin-2');
});

test('resolveRequesterDeliveryTarget rejects mismatched request/session pairs', async () => {
  const { resolveRequesterDeliveryTarget } = await import('../dist-electron/metabotRuntime/transportRuntime.js');

  const ok = resolveRequesterDeliveryTarget({
    delivery: { request_id: 'req-1', requester_session_id: 'session-1' },
    pendingRequest: { requestId: 'req-1', requesterSessionId: 'session-1', targetSessionId: 'session-1' },
  });
  const mismatch = resolveRequesterDeliveryTarget({
    delivery: { request_id: 'req-1', requester_session_id: 'session-2' },
    pendingRequest: { requestId: 'req-1', requesterSessionId: 'session-1', targetSessionId: 'session-1' },
  });

  assert.equal(ok.targetSessionId, 'session-1');
  assert.equal(mismatch, null);
});

test('normalizeProviderWakeUpEnvelope round-trips the shared daemon JSONL contract', async () => {
  const { normalizeProviderWakeUpEnvelope } = await import('../dist-electron/metabotRuntime/transportRuntime.js');
  const request = normalizeProviderWakeUpEnvelope({
    type: 'provider_wakeup',
    request_id: 'req-3',
    requester_session_id: 'session-3',
    requester_conversation_id: 'conversation-3',
    service_pin_id: 'pin-3',
    requester_global_metaid: 'idq1requester',
    user_task: 'summarize',
    task_context: 'context',
    price: '0.01',
    currency: 'DOGE',
    payment: {
      txid: 'c'.repeat(64),
      chain: 'doge',
      order_message: '[ORDER]\\npayment amount: 0.01 DOGE\\nservice pin id: pin-3',
      order_message_pin_id: 'order-pin-3',
    },
  });

  assert.equal(request.correlation.requestId, 'req-3');
  assert.equal(request.correlation.requesterSessionId, 'session-3');
  assert.equal(request.servicePinId, 'pin-3');
  assert.equal(request.paymentProof.txid, 'c'.repeat(64));
});
