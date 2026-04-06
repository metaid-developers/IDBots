import test from 'node:test';
import assert from 'node:assert/strict';

test('writePortableServiceRequest writes a simplemsg order and creates buyer trace', async () => {
  const calls = [];
  const { writePortableServiceRequest } = await import('../dist-electron/metabotRuntime/serviceRequestRuntime.js');

  const result = await writePortableServiceRequest({
    request: {
      correlation: {
        requestId: 'req-1',
        requesterSessionId: 'session-1',
        requesterConversationId: 'conversation-1',
      },
      servicePinId: 'pin-1',
      requesterGlobalMetaId: 'idq1buyer',
      price: '0',
      currency: 'SPACE',
      paymentProof: { txid: null, chain: null, amount: '0', currency: 'SPACE', orderMessage: '', orderMessagePinId: null },
      userTask: 'summarize',
      taskContext: 'context',
      executionMode: 'free',
    },
    trace: {
      createBuyerOrder(input) {
        calls.push(['createBuyerOrder', input]);
        return { id: 'buyer-order-1' };
      },
    },
    deps: {
      buildDelegationOrderPayload(input) {
        calls.push(['buildDelegationOrderPayload', input]);
        return '[ORDER]\npayment amount: 0 SPACE\nservice pin id: pin-1';
      },
      async createPin(_store, _metabotId, pinInput) {
        calls.push(['createPin', pinInput]);
        return { pinId: 'order-pin-1' };
      },
    },
  });

  assert.equal(calls[1][1].path, '/protocols/simplemsg');
  assert.equal(result.requestWrite.orderMessagePinId, 'order-pin-1');
  assert.equal(calls[2][0], 'createBuyerOrder');
});
