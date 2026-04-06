import test from 'node:test';
import assert from 'node:assert/strict';

test('createPinWithMvcSubsidyRetry retries once after a successful subsidy request', async () => {
  const { createPinWithMvcSubsidyRetry } = await import('../dist-electron/services/privateChatSubsidizedPin.js');

  const calls = [];
  let attempts = 0;

  const result = await createPinWithMvcSubsidyRetry({
    metabot: {
      name: '10th bot',
      mvc_address: '1BLoQMNePNqFMj4nJMoBa6BxvbikVGkEso',
    },
    wallet: {
      mnemonic: 'test mnemonic',
      path: "m/44'/10001'/0'/0/0",
    },
    createPin: async () => {
      attempts += 1;
      calls.push(`create:${attempts}`);
      if (attempts === 1) {
        throw new Error('Not enough balance');
      }
      return { pinId: 'pong-pin' };
    },
    requestMvcGasSubsidy: async () => {
      calls.push('subsidy');
      return { success: true };
    },
  });

  assert.deepEqual(calls, ['create:1', 'subsidy', 'create:2']);
  assert.deepEqual(result, { pinId: 'pong-pin' });
});

test('createPinWithMvcSubsidyRetry does not request subsidy for unrelated failures', async () => {
  const { createPinWithMvcSubsidyRetry } = await import('../dist-electron/services/privateChatSubsidizedPin.js');

  let subsidyCalls = 0;

  await assert.rejects(
    () => createPinWithMvcSubsidyRetry({
      metabot: {
        name: '10th bot',
        mvc_address: '1BLoQMNePNqFMj4nJMoBa6BxvbikVGkEso',
      },
      wallet: {
        mnemonic: 'test mnemonic',
        path: "m/44'/10001'/0'/0/0",
      },
      createPin: async () => {
        throw new Error('network broken');
      },
      requestMvcGasSubsidy: async () => {
        subsidyCalls += 1;
        return { success: true };
      },
    }),
    /network broken/,
  );

  assert.equal(subsidyCalls, 0);
});
