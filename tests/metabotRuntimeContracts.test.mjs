import test from 'node:test';
import assert from 'node:assert/strict';

test('normalizeServiceRequestContract preserves free and paid order shapes', async () => {
  const { normalizeServiceRequestContract } = await import('../dist-electron/metabotRuntime/contracts.js');

  const free = normalizeServiceRequestContract({
    correlation: {
      requestId: 'req-free-1',
      requesterSessionId: 'session-free-1',
      requesterConversationId: 'conversation-free-1',
    },
    servicePinId: 'pin-1',
    requesterGlobalMetaId: 'idq1requester',
    price: '0',
    currency: 'SPACE',
    userTask: 'summarize this paper',
    taskContext: 'paper text',
  });

  const paid = normalizeServiceRequestContract({
    correlation: {
      requestId: 'req-paid-1',
      requesterSessionId: 'session-paid-1',
      requesterConversationId: 'conversation-paid-1',
    },
    servicePinId: 'pin-2',
    requesterGlobalMetaId: 'idq1requester',
    price: '0.01',
    currency: 'DOGE',
    paymentProof: {
      txid: 'a'.repeat(64),
      chain: 'doge',
      amount: '0.01',
      currency: 'DOGE',
      orderMessage: '[ORDER]\npayment amount: 0.01 DOGE\nservice pin id: pin-2',
      orderMessagePinId: 'order-pin-2',
    },
    userTask: 'translate this',
    taskContext: 'source text',
  });

  assert.equal(free.executionMode, 'free');
  assert.equal(free.correlation.requestId, 'req-free-1');
  assert.equal(paid.executionMode, 'paid');
  assert.equal(paid.paymentProof.txid, 'a'.repeat(64));
  assert.equal(paid.paymentProof.chain, 'doge');
  assert.equal(paid.correlation.requesterSessionId, 'session-paid-1');
  assert.match(paid.paymentProof.orderMessage, /\[ORDER\]/);
});

test('normalizeAttachmentRefs only keeps V1 metafile references', async () => {
  const { normalizeAttachmentRefs } = await import('../dist-electron/metabotRuntime/attachmentRefs.js');
  assert.deepEqual(
    normalizeAttachmentRefs(['metafile://pin123', '', 'http://example.com/not-v1']),
    ['metafile://pin123']
  );
});
