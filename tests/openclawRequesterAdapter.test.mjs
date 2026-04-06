import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('local-first success stays local', async () => {
  const { evaluateRequesterRouting } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');

  const result = evaluateRequesterRouting({
    localExecution: { status: 'success' },
    remoteCandidates: [
      { pinId: 'pin-remote-1', displayName: 'Remote One' },
    ],
  });

  assert.equal(result.action, 'use_local');
});

test('automatic recommendation appears only after a pre-execution local miss', async () => {
  const { evaluateRequesterRouting } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');

  const noMiss = evaluateRequesterRouting({
    localExecution: { status: 'idle' },
    remoteCandidates: [
      { pinId: 'pin-remote-1', displayName: 'Remote One' },
    ],
  });
  const miss = evaluateRequesterRouting({
    localExecution: { status: 'miss' },
    remoteCandidates: [
      { pinId: 'pin-remote-1', displayName: 'Remote One' },
    ],
  });

  assert.equal(noMiss.action, 'wait_local');
  assert.equal(miss.action, 'recommend_remote');
  assert.equal(miss.recommendedService.pinId, 'pin-remote-1');
});

test('explicit remote selection bypasses recommendation', async () => {
  const { evaluateRequesterRouting } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');

  const result = evaluateRequesterRouting({
    localExecution: { status: 'miss' },
    remoteCandidates: [
      { pinId: 'pin-remote-1', displayName: 'Remote One' },
      { pinId: 'pin-remote-2', displayName: 'Remote Two' },
    ],
    explicitRemoteServicePinId: 'pin-remote-2',
  });

  assert.equal(result.action, 'await_confirmation');
  assert.equal(result.selectedService.pinId, 'pin-remote-2');
});

test('explicit remote selection does not override a local success', async () => {
  const { evaluateRequesterRouting } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');

  const result = evaluateRequesterRouting({
    localExecution: { status: 'success' },
    remoteCandidates: [
      { pinId: 'pin-remote-1', displayName: 'Remote One' },
    ],
    explicitRemoteServicePinId: 'pin-remote-1',
  });

  assert.equal(result.action, 'use_local');
});

test('buildRequesterResultInjection succeeds only when request_id and requester_session_id match the pending request', async () => {
  const { buildRequesterResultInjection } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');

  const result = buildRequesterResultInjection({
    delivery: {
      request_id: 'req-1',
      requester_session_id: 'requester-session-1',
      requester_conversation_id: 'conversation-1',
      text: 'done',
      attachments: ['metafile://pin123'],
    },
    pendingRequest: {
      requestId: 'req-1',
      requesterSessionId: 'requester-session-1',
      requesterConversationId: 'conversation-1',
      targetSessionId: 'openclaw-session-1',
    },
  });

  assert.equal(result.targetSessionId, 'openclaw-session-1');
  assert.equal(result.message.text, 'done');
});

test('buildRequesterResultInjection rejects mismatched request_id or requester_session_id', async () => {
  const { buildRequesterResultInjection } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');

  const mismatchedRequest = buildRequesterResultInjection({
    delivery: {
      request_id: 'req-2',
      requester_session_id: 'requester-session-1',
      text: 'done',
    },
    pendingRequest: {
      requestId: 'req-1',
      requesterSessionId: 'requester-session-1',
      targetSessionId: 'openclaw-session-1',
    },
  });
  const mismatchedSession = buildRequesterResultInjection({
    delivery: {
      request_id: 'req-1',
      requester_session_id: 'requester-session-2',
      text: 'done',
    },
    pendingRequest: {
      requestId: 'req-1',
      requesterSessionId: 'requester-session-1',
      targetSessionId: 'openclaw-session-1',
    },
  });

  assert.equal(mismatchedRequest, null);
  assert.equal(mismatchedSession, null);
});

test('buildRequesterResultInjection rejects missing request_id or requester_session_id', async () => {
  const { buildRequesterResultInjection } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');

  const missingRequestId = buildRequesterResultInjection({
    delivery: {
      request_id: '   ',
      requester_session_id: 'requester-session-1',
      text: 'done',
    },
    pendingRequest: {
      requestId: 'req-1',
      requesterSessionId: 'requester-session-1',
      targetSessionId: 'openclaw-session-1',
    },
  });
  const missingRequesterSessionId = buildRequesterResultInjection({
    delivery: {
      request_id: 'req-1',
      requester_session_id: '',
      text: 'done',
    },
    pendingRequest: {
      requestId: 'req-1',
      requesterSessionId: 'requester-session-1',
      targetSessionId: 'openclaw-session-1',
    },
  });

  assert.equal(missingRequestId, null);
  assert.equal(missingRequesterSessionId, null);
});

test('two concurrent pending sessions stay distinct', async () => {
  const { buildRequesterResultInjection } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');

  const first = buildRequesterResultInjection({
    delivery: {
      request_id: 'req-1',
      requester_session_id: 'requester-session-1',
      text: 'first',
    },
    pendingRequest: {
      requestId: 'req-1',
      requesterSessionId: 'requester-session-1',
      targetSessionId: 'openclaw-session-1',
    },
  });
  const second = buildRequesterResultInjection({
    delivery: {
      request_id: 'req-2',
      requester_session_id: 'requester-session-2',
      text: 'second',
    },
    pendingRequest: {
      requestId: 'req-2',
      requesterSessionId: 'requester-session-2',
      targetSessionId: 'openclaw-session-2',
    },
  });

  assert.equal(first.targetSessionId, 'openclaw-session-1');
  assert.equal(second.targetSessionId, 'openclaw-session-2');
});

test('submitRemoteRequest validates required routing fields before invoking request-service', async () => {
  const { createOpenClawRequesterBridge } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openclaw-requester-'));
  const pendingRequestsFile = path.join(tempDir, 'pending-requests.json');
  let requestServiceCalls = 0;

  try {
    const bridge = createOpenClawRequesterBridge({
      pendingRequestsFile,
      async listServices() {
        return { services: [] };
      },
      async requestService() {
        requestServiceCalls += 1;
        return {
          request_write: {
            requestId: 'req-1',
            requesterSessionId: 'requester-session-1',
            requesterConversationId: null,
            servicePinId: 'pin-1',
            paymentTxid: null,
            orderMessagePinId: null,
          },
          provider_wakeup: {
            type: 'provider_wakeup',
            request_id: 'req-1',
            requester_session_id: 'requester-session-1',
            requester_conversation_id: null,
            service_pin_id: 'pin-1',
            requester_global_metaid: 'idq1requester',
            order_message_pin_id: null,
            payment_txid: null,
            order_reference_id: null,
            user_task: 'summarize the filing',
            task_context: 'full filing text',
            price: '0',
            currency: 'SPACE',
            payment: {
              txid: null,
              chain: null,
              amount: '0',
              currency: 'SPACE',
              order_message: '',
              order_message_pin_id: null,
            },
          },
        };
      },
    });

    await assert.rejects(
      () => bridge.submitRemoteRequest({
        metabotId: 9,
        servicePinId: 'pin-1',
        requestId: 'req-1',
        requesterSessionId: 'requester-session-1',
        requesterGlobalMetaId: 'idq1requester',
        targetSessionId: '',
        userTask: 'summarize the filing',
        taskContext: 'full filing text',
        confirm: true,
      }),
      /targetSessionId is required/,
    );
    assert.equal(requestServiceCalls, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('submitRemoteRequest quarantines a corrupt pending registry and rewrites valid state', async () => {
  const { createOpenClawRequesterBridge } = await import('../dist-electron/metabotRuntime/openclaw/openclawRequesterAdapter.js');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openclaw-requester-'));
  const pendingRequestsFile = path.join(tempDir, 'pending-requests.json');

  try {
    fs.writeFileSync(pendingRequestsFile, '{not-valid-json', 'utf8');

    const bridge = createOpenClawRequesterBridge({
      pendingRequestsFile,
      async listServices() {
        return { services: [] };
      },
      async requestService() {
        return {
          request_write: {
            requestId: 'req-1',
            requesterSessionId: 'requester-session-1',
            requesterConversationId: null,
            servicePinId: 'pin-1',
            paymentTxid: null,
            orderMessagePinId: null,
          },
          provider_wakeup: {
            type: 'provider_wakeup',
            request_id: 'req-1',
            requester_session_id: 'requester-session-1',
            requester_conversation_id: null,
            service_pin_id: 'pin-1',
            requester_global_metaid: 'idq1requester',
            order_message_pin_id: null,
            payment_txid: null,
            order_reference_id: null,
            user_task: 'summarize the filing',
            task_context: 'full filing text',
            price: '0',
            currency: 'SPACE',
            payment: {
              txid: null,
              chain: null,
              amount: '0',
              currency: 'SPACE',
              order_message: '',
              order_message_pin_id: null,
            },
          },
        };
      },
    });

    const result = await bridge.submitRemoteRequest({
      metabotId: 9,
      servicePinId: 'pin-1',
      requestId: 'req-1',
      requesterSessionId: 'requester-session-1',
      requesterGlobalMetaId: 'idq1requester',
      targetSessionId: 'openclaw-session-1',
      userTask: 'summarize the filing',
      taskContext: 'full filing text',
      confirm: true,
    });

    assert.equal(result.pending_request.targetSessionId, 'openclaw-session-1');
    const rewritten = JSON.parse(fs.readFileSync(pendingRequestsFile, 'utf8'));
    assert.equal(rewritten.length, 1);
    assert.equal(rewritten[0].requestId, 'req-1');

    const quarantined = fs.readdirSync(tempDir).find((name) => name.startsWith('pending-requests.json.corrupt-'));
    assert.ok(quarantined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
