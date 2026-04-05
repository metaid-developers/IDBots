import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { bootstrapMetabot } = require('../dist-electron/services/metabotBootstrapFacade.js');

test('bootstrapMetabot preserves the created metabot when sync still needs manual follow-up', async () => {
  let walletId = 0;
  let metabotId = 0;
  const storedMetabots = new Map();

  const store = {
    insertMetabotWallet(input) {
      walletId += 1;
      return { id: walletId, ...input };
    },
    createMetabot(input) {
      metabotId += 1;
      const metabot = {
        id: metabotId,
        ...input
      };
      storedMetabots.set(metabot.id, metabot);
      return metabot;
    },
    getMetabotById(id) {
      return storedMetabots.get(id) ?? null;
    }
  };

  let syncAttempts = 0;
  const result = await bootstrapMetabot(
    {
      name: 'Alice',
      avatar: null,
      role: 'Guide',
      soul: '',
      llmId: 'provider:model',
      metabotType: 'twin'
    },
    {
      store,
      wait: async () => {},
      syncRetryDelayMs: 1,
      createWallet: async () => ({
        mnemonic: 'secret phrase',
        path: "m/44'/10001'/0'/0/0",
        public_key: 'pub',
        chat_public_key: 'chat-pub',
        mvc_address: 'mvc-address',
        btc_address: 'btc-address',
        doge_address: 'doge-address',
        metaid: 'meta-id',
        globalmetaid: 'idq1970463ym8fqmgawe4lylktne97ahhw4kqehkch',
        chat_public_key_pin_id: ''
      }),
      requestSubsidy: async () => ({ success: true }),
      syncToChain: async () => {
        syncAttempts += 1;
        return {
          success: false,
          error: 'avatar pin failed',
          canSkip: true
        };
      },
      syncP2PRuntimeConfig: async () => {}
    }
  );

  assert.equal(syncAttempts, 2);
  assert.equal(result.success, false);
  assert.equal(result.retryable, true);
  assert.equal(result.manualActionRequired, true);
  assert.equal(result.canSkip, true);
  assert.equal(result.error, 'avatar pin failed');
  assert.equal(result.metabot?.name, 'Alice');
  assert.equal(result.metabot?.metabot_type, 'twin');
  assert.deepEqual(result.subsidy, { success: true });
});
