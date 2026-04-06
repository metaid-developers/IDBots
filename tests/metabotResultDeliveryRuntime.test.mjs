import test from 'node:test';
import assert from 'node:assert/strict';

test('writePortableDeliveryRecord writes a simplemsg delivery and marks seller delivered', async () => {
  const calls = [];
  const { writePortableDeliveryRecord } = await import('../dist-electron/metabotRuntime/resultDeliveryRuntime.js');

  const result = await writePortableDeliveryRecord({
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
      paymentProof: { txid: 'free-order-1', chain: 'mvc', amount: '0', currency: 'SPACE', orderMessage: '', orderMessagePinId: 'order-pin-1' },
      userTask: 'summarize',
      taskContext: 'context',
      executionMode: 'free',
    },
    delivery: { text: 'done', attachments: ['metafile://pin123'] },
    trace: {
      markSellerDelivered(input) {
        calls.push(['markSellerDelivered', input]);
      },
    },
    deps: {
      buildDeliveryMessage(input) {
        calls.push(['buildDeliveryMessage', input]);
        return JSON.stringify(input);
      },
      async createPin(_store, _metabotId, pinInput) {
        calls.push(['createPin', pinInput]);
        return { pinId: 'delivery-pin-1' };
      },
    },
  });

  assert.equal(calls[1][1].path, '/protocols/simplemsg');
  assert.equal(result.deliveryWrite.deliveryMessagePinId, 'delivery-pin-1');
  assert.equal(result.deliveryWrite.requesterSessionId, 'session-1');
  assert.equal(calls[2][0], 'markSellerDelivered');
});
