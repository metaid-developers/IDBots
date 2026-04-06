import test from 'node:test';
import assert from 'node:assert/strict';

test('normalizeOpenClawWakeUpEnvelope converts gateway payload into the shared request contract', async () => {
  const { normalizeOpenClawWakeUpEnvelope } = await import('../dist-electron/metabotRuntime/openclaw/openclawProviderAdapter.js');
  const request = normalizeOpenClawWakeUpEnvelope({
    request_id: 'req-1',
    requester_session_id: 'session-openclaw-1',
    requester_conversation_id: 'conversation-openclaw-1',
    service_pin_id: 'pin-1',
    requester_global_metaid: 'idq1requester',
    user_task: 'summarize the filing',
    task_context: 'full filing text',
    price: '0.01',
    currency: 'DOGE',
    payment: {
      txid: 'a'.repeat(64),
      chain: 'doge',
      order_message: '[ORDER]\npayment amount: 0.01 DOGE\nservice pin id: pin-1',
      order_message_pin_id: 'order-pin-1',
    },
  });

  assert.equal(request.correlation.requestId, 'req-1');
  assert.equal(request.correlation.requesterSessionId, 'session-openclaw-1');
  assert.equal(request.servicePinId, 'pin-1');
  assert.equal(request.paymentProof.txid, 'a'.repeat(64));
  assert.equal(request.executionMode, 'paid');
});

test('normalizeOpenClawWakeUpEnvelope requires request and requester session ids and derives free-mode defaults', async () => {
  const { normalizeOpenClawWakeUpEnvelope } = await import('../dist-electron/metabotRuntime/openclaw/openclawProviderAdapter.js');

  assert.throws(
    () => normalizeOpenClawWakeUpEnvelope({
      requester_session_id: 'session-openclaw-1',
      service_pin_id: 'pin-1',
    }),
    /request_id is required/,
  );

  const request = normalizeOpenClawWakeUpEnvelope({
    request_id: 'req-free-1',
    requester_session_id: 'session-openclaw-free-1',
    requester_conversation_id: '   ',
    service_pin_id: 'pin-free-1',
    requester_global_metaid: 'idq1requester',
    user_task: 'summarize the filing',
    task_context: 'full filing text',
    price: '0',
    currency: 'space',
    payment: {
      txid: '',
      chain: '',
      order_message: '',
      order_message_pin_id: '',
    },
  });

  assert.equal(request.correlation.requesterConversationId, null);
  assert.equal(request.paymentProof.amount, '0');
  assert.equal(request.paymentProof.currency, 'SPACE');
  assert.equal(request.executionMode, 'free');
});

test('createOpenClawProviderAdapter auto-creates a session, injects the prompt, and waits for a result', async () => {
  const calls = [];
  const { createOpenClawProviderAdapter } = await import('../dist-electron/metabotRuntime/openclaw/openclawProviderAdapter.js');

  const adapter = createOpenClawProviderAdapter({
    async createSession(input) {
      calls.push(['createSession', input]);
      return { sessionId: 'session-1' };
    },
    async injectPrompt(sessionId, prompt) {
      calls.push(['injectPrompt', sessionId, prompt]);
    },
    async waitForSessionResult(sessionId) {
      calls.push(['waitForSessionResult', sessionId]);
      return {
        sessionId: 'different-session-id',
        text: 'done',
        attachments: ['metafile://pin123', 'https://example.com/not-allowed'],
      };
    },
  });

  const session = await adapter.startProviderSession({
    servicePinId: 'pin-1',
    requesterGlobalMetaId: 'idq1requester',
    userTask: 'summarize the filing',
    taskContext: 'full filing text',
  });
  const result = await adapter.waitForProviderResult(session.sessionId);

  assert.deepEqual(calls.map(([name]) => name), ['createSession', 'injectPrompt', 'waitForSessionResult']);
  assert.equal(result.text, 'done');
  assert.equal(result.sessionId, 'session-1');
  assert.deepEqual(result.attachments, ['metafile://pin123']);
});
