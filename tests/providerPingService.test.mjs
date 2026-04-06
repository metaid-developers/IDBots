import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadProviderPingService() {
  return require('../dist-electron/services/providerPingService.js');
}

function createClock() {
  let nowMs = 0;

  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
  };
}

test('provider ping resolves true when pong arrives before timeout', async () => {
  const { ProviderPingService } = loadProviderPingService();
  const clock = createClock();
  const pendingMessages = [];
  const createPinCalls = [];

  const service = new ProviderPingService({
    pollIntervalMs: 1000,
    now: () => clock.now(),
    sleep: async (ms) => {
      clock.advance(ms);
      pendingMessages.splice(0, pendingMessages.length, {
        from_global_metaid: 'idq1provider',
        to_global_metaid: 'idq1buyer',
        content: 'pong',
        from_chat_pubkey: 'provider-pubkey',
      });
    },
    getWallet: () => ({
      mnemonic: 'test mnemonic',
      path: "m/44'/10001'/0'/0/0",
    }),
    getLocalGlobalMetaId: () => 'idq1buyer',
    derivePrivateKeyBuffer: async () => Buffer.from('buyer-private-key'),
    computeSharedSecretSha256: () => 'shared-secret',
    computeSharedSecret: () => 'raw-shared-secret',
    encrypt: (plainText) => `encrypted:${plainText}`,
    decrypt: (cipherText) => cipherText,
    buildPrivateMessagePayload: (to, encryptedContent) => JSON.stringify({ to, encryptedContent }),
    createPin: async (metabotId, payload) => {
      createPinCalls.push({ metabotId, payload });
    },
    listPendingMessages: () => pendingMessages.map((message) => ({ ...message })),
  });

  const result = await service.pingProvider({
    metabotId: 7,
    toGlobalMetaId: 'idq1provider',
    toChatPubkey: 'provider-pubkey',
    timeoutMs: 2500,
  });

  assert.equal(result, true);
  assert.deepEqual(createPinCalls, [
    {
      metabotId: 7,
      payload: JSON.stringify({ to: 'idq1provider', encryptedContent: 'encrypted:ping' }),
    },
  ]);
});

test('provider ping resolves false when timeout expires without pong', async () => {
  const { ProviderPingService } = loadProviderPingService();
  const clock = createClock();
  let listPendingMessagesCalls = 0;

  const service = new ProviderPingService({
    pollIntervalMs: 1000,
    now: () => clock.now(),
    sleep: async (ms) => {
      clock.advance(ms);
    },
    getWallet: () => ({
      mnemonic: 'test mnemonic',
      path: "m/44'/10001'/0'/0/0",
    }),
    getLocalGlobalMetaId: () => 'idq1buyer',
    derivePrivateKeyBuffer: async () => Buffer.from('buyer-private-key'),
    computeSharedSecretSha256: () => 'shared-secret',
    computeSharedSecret: () => 'raw-shared-secret',
    encrypt: (plainText) => `encrypted:${plainText}`,
    decrypt: (cipherText) => cipherText,
    buildPrivateMessagePayload: (to, encryptedContent) => JSON.stringify({ to, encryptedContent }),
    createPin: async () => undefined,
    listPendingMessages: () => {
      listPendingMessagesCalls += 1;
      return [];
    },
  });

  const result = await service.pingProvider({
    metabotId: 9,
    toGlobalMetaId: 'idq1provider',
    toChatPubkey: 'provider-pubkey',
    timeoutMs: 2500,
  });

  assert.equal(result, false);
  assert.equal(listPendingMessagesCalls >= 3, true);
});

test('provider ping matches provider and buyer globalMetaIds case-insensitively', async () => {
  const { ProviderPingService } = loadProviderPingService();
  const clock = createClock();
  const pendingMessages = [];
  const createPinCalls = [];

  const service = new ProviderPingService({
    pollIntervalMs: 1000,
    now: () => clock.now(),
    sleep: async (ms) => {
      clock.advance(ms);
      pendingMessages.splice(0, pendingMessages.length, {
        from_global_metaid: 'idq1provider',
        to_global_metaid: 'idq1buyer',
        content: 'pong',
        from_chat_pubkey: 'provider-pubkey',
      });
    },
    getWallet: () => ({
      mnemonic: 'test mnemonic',
      path: "m/44'/10001'/0'/0/0",
    }),
    getLocalGlobalMetaId: () => ' IDQ1Buyer ',
    derivePrivateKeyBuffer: async () => Buffer.from('buyer-private-key'),
    computeSharedSecretSha256: () => 'shared-secret',
    computeSharedSecret: () => 'raw-shared-secret',
    encrypt: (plainText) => `encrypted:${plainText}`,
    decrypt: (cipherText) => cipherText,
    buildPrivateMessagePayload: (to, encryptedContent) => JSON.stringify({ to, encryptedContent }),
    createPin: async (metabotId, payload) => {
      createPinCalls.push({ metabotId, payload });
    },
    listPendingMessages: () => pendingMessages.map((message) => ({ ...message })),
  });

  const result = await service.pingProvider({
    metabotId: 7,
    toGlobalMetaId: ' IDQ1Provider ',
    toChatPubkey: 'provider-pubkey',
    timeoutMs: 2500,
  });

  assert.equal(result, true);
  assert.deepEqual(createPinCalls, [
    {
      metabotId: 7,
      payload: JSON.stringify({ to: 'idq1provider', encryptedContent: 'encrypted:ping' }),
    },
  ]);
});

test('provider ping can observe a fresh pong from recent messages after the daemon already processed it', async () => {
  const { ProviderPingService } = loadProviderPingService();
  const clock = createClock();
  const recentMessages = [{
    id: 5,
    from_global_metaid: 'idq1provider',
    to_global_metaid: 'idq1buyer',
    content: 'pong',
    from_chat_pubkey: 'provider-pubkey',
  }];

  const service = new ProviderPingService({
    pollIntervalMs: 1000,
    now: () => clock.now(),
    sleep: async (ms) => {
      clock.advance(ms);
      recentMessages.splice(0, recentMessages.length, {
        id: 5,
        from_global_metaid: 'idq1provider',
        to_global_metaid: 'idq1buyer',
        content: 'pong',
        from_chat_pubkey: 'provider-pubkey',
      }, {
        id: 6,
        from_global_metaid: 'idq1provider',
        to_global_metaid: 'idq1buyer',
        content: 'pong',
        from_chat_pubkey: 'provider-pubkey',
      });
    },
    getWallet: () => ({
      mnemonic: 'test mnemonic',
      path: "m/44'/10001'/0'/0/0",
    }),
    getLocalGlobalMetaId: () => 'idq1buyer',
    derivePrivateKeyBuffer: async () => Buffer.from('buyer-private-key'),
    computeSharedSecretSha256: () => 'shared-secret',
    computeSharedSecret: () => 'raw-shared-secret',
    encrypt: (plainText) => `encrypted:${plainText}`,
    decrypt: (cipherText) => cipherText,
    buildPrivateMessagePayload: (to, encryptedContent) => JSON.stringify({ to, encryptedContent }),
    createPin: async () => undefined,
    listPendingMessages: () => [],
    listRecentMessages: () => recentMessages.map((message) => ({ ...message })),
  });

  const result = await service.pingProvider({
    metabotId: 7,
    toGlobalMetaId: 'idq1provider',
    toChatPubkey: 'provider-pubkey',
    timeoutMs: 2500,
  });

  assert.equal(result, true);
});

test('provider ping ignores stale recent pong messages that existed before the current ping started', async () => {
  const { ProviderPingService } = loadProviderPingService();
  const clock = createClock();
  const recentMessages = [{
    id: 5,
    from_global_metaid: 'idq1provider',
    to_global_metaid: 'idq1buyer',
    content: 'pong',
    from_chat_pubkey: 'provider-pubkey',
  }];

  const service = new ProviderPingService({
    pollIntervalMs: 1000,
    now: () => clock.now(),
    sleep: async (ms) => {
      clock.advance(ms);
    },
    getWallet: () => ({
      mnemonic: 'test mnemonic',
      path: "m/44'/10001'/0'/0/0",
    }),
    getLocalGlobalMetaId: () => 'idq1buyer',
    derivePrivateKeyBuffer: async () => Buffer.from('buyer-private-key'),
    computeSharedSecretSha256: () => 'shared-secret',
    computeSharedSecret: () => 'raw-shared-secret',
    encrypt: (plainText) => `encrypted:${plainText}`,
    decrypt: (cipherText) => cipherText,
    buildPrivateMessagePayload: (to, encryptedContent) => JSON.stringify({ to, encryptedContent }),
    createPin: async () => undefined,
    listPendingMessages: () => [],
    listRecentMessages: () => recentMessages.map((message) => ({ ...message })),
  });

  const result = await service.pingProvider({
    metabotId: 7,
    toGlobalMetaId: 'idq1provider',
    toChatPubkey: 'provider-pubkey',
    timeoutMs: 2500,
  });

  assert.equal(result, false);
});
