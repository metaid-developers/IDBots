import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildPrivateChatA2AChainMetadata,
  sendSellerOrderAcknowledgement,
} = require('../dist-electron/services/privateChatDaemon.js');

test('sendSellerOrderAcknowledgement returns the simplemsg chain metadata from the transmitted acknowledgement', async () => {
  const txid = 'd'.repeat(64);
  const lifecycleCalls = [];
  const result = await sendSellerOrderAcknowledgement({
    metabot: { id: 7, name: 'SellerBot', llm_id: null },
    peerGlobalMetaId: 'idq1peer',
    peerName: 'AI_Sunny',
    plaintext: '[ORDER] 请生成图片',
    skillName: 'seedream',
    paymentTxid: 'e'.repeat(64),
    performChat: async () => ' 我已收到你的图片订单，马上开始处理。 ',
    sendEncryptedMsg: async (text) => {
      assert.equal(text, '我已收到你的图片订单，马上开始处理。');
      return {
        pinId: `${txid}i0`,
        txids: [txid],
      };
    },
    serviceOrderLifecycle: {
      markSellerOrderFirstResponseSent: (input) => lifecycleCalls.push(input),
    },
    now: () => 1234,
  });

  assert.equal(result.text, '我已收到你的图片订单，马上开始处理。');
  assert.equal(result.pinId, `${txid}i0`);
  assert.deepEqual(result.txids, [txid]);
  assert.equal(lifecycleCalls.length, 1);
  assert.equal(lifecycleCalls[0].sentAt, 1234);
});

test('buildPrivateChatA2AChainMetadata derives txid from pin id when txids are unavailable', () => {
  const txid = 'f'.repeat(64);
  assert.deepEqual(
    buildPrivateChatA2AChainMetadata({ pinId: `${txid}i0` }),
    {
      txid,
      txids: [txid],
      pinId: `${txid}i0`,
    },
  );
});
