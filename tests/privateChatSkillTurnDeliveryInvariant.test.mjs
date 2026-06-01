import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
try {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
  } = await import('../dist-electron/services/privateChatDaemon.js'));
}

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createPrivateChatDbHarness() {
  const row = {
    id: 1,
    pin_id: 'incoming-pin-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: 'pop机制是怎样？',
    encryption: null,
    reply_pin: '',
    raw_data: null,
    is_processed: 0,
  };
  const columns = [
    'id',
    'pin_id',
    'tx_id',
    'from_metaid',
    'from_global_metaid',
    'from_name',
    'from_avatar',
    'from_chat_pubkey',
    'to_metaid',
    'to_global_metaid',
    'content',
    'encryption',
    'reply_pin',
    'raw_data',
  ];
  const values = columns.map((column) => row[column]);

  return {
    row,
    db: {
      exec(sql) {
        if (/FROM private_chat_messages WHERE is_processed = 0/i.test(sql)) {
          return row.is_processed
            ? []
            : [{ columns, values: [values] }];
        }
        return [{ columns: ['found'], values: [] }];
      },
      run(sql, params) {
        if (/UPDATE private_chat_messages SET is_processed = 1 WHERE id = \?/i.test(sql)) {
          assert.deepEqual(params, [row.id]);
          row.is_processed = 1;
        }
      },
    },
  };
}

function createCoworkStoreHarness() {
  const externalConversationId = 'metaweb-private:peer-global';
  const session = {
    id: 'session-private-1',
    sessionType: 'a2a',
    metabotId: 1,
    peerGlobalMetaId: 'peer-global',
    messages: [],
  };
  const mapping = {
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: 1,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({ peerGlobalMetaId: 'peer-global' }),
  };

  return {
    session,
    store: {
      getConversationMapping(channel, conversationId, metabotId) {
        if (
          channel === 'metaweb_private'
          && conversationId === externalConversationId
          && metabotId === 1
        ) {
          return mapping;
        }
        return null;
      },
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      ensureCanonicalPeerSessionShape() {
        return true;
      },
      touchConversationMapping() {},
      deleteConversationMapping() {},
      addMessage(sessionId, message) {
        const created = {
          id: `msg-${session.messages.length + 1}`,
          timestamp: 1_770_000_000_000 + session.messages.length,
          ...message,
        };
        assert.equal(sessionId, session.id);
        session.messages.push(created);
        return created;
      },
      updateMessage(sessionId, messageId, updates) {
        assert.equal(sessionId, session.id);
        const message = session.messages.find((item) => item.id === messageId);
        if (message) Object.assign(message, updates);
      },
      updateConversationMappingMetadata() {},
      getConfig() {
        return { workingDirectory: '/tmp/idbots-test' };
      },
      getMemoryBackend() {
        return {
          getEffectiveMemoryPolicyForMetabot() {
            return { memoryEnabled: false };
          },
        };
      },
    },
  };
}

function createMetabotStoreHarness() {
  const metabot = {
    id: 1,
    name: 'Local Bot',
    enabled: true,
    metaid: 'local-metaid',
    globalmetaid: 'local-global',
    allow_chat_skills: ['metaid-master-wiki'],
  };
  return {
    metabot,
    store: {
      getMetabotByGlobalMetaId(globalMetaId) {
        return globalMetaId === metabot.globalmetaid ? metabot : null;
      },
      getMetabotById() {
        return null;
      },
      getMetabotWalletByMetabotId(id) {
        assert.equal(id, metabot.id);
        return {
          mnemonic: TEST_MNEMONIC,
          path: "m/44'/10001'/0'/0/0",
        };
      },
    },
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for private chat daemon test condition');
}

test('regular private chat skill failures keep the inbound message retryable until a reply is sent', async () => {
  const { db, row } = createPrivateChatDbHarness();
  const { store: coworkStore } = createCoworkStoreHarness();
  const { store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  let saveCount = 0;

  startPrivateChatDaemon(
    db,
    () => {
      saveCount += 1;
    },
    coworkStore,
    metabotStore,
    {
      on() {},
      off() {},
    },
    async () => {
      throw new Error('createPin should not be called when the skill turn fails');
    },
    (message) => logs.push(message),
    null,
    undefined,
    undefined,
    () => ({ respondToStrangerPrivateChats: true }),
    undefined,
    undefined,
    undefined,
    async () => ({
      prompt: '<available_skills><skill><id>metaid-master-wiki</id></skill></available_skills>',
      activeSkillIds: ['metaid-master-wiki'],
    }),
    async () => {
      throw new Error('Skill turn timed out after 120s');
    },
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('LLM failed for message 1')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 0);
  assert.equal(saveCount, 0);
});

test('regular private chat broadcast failures keep the inbound skill reply retryable', async () => {
  const { db, row } = createPrivateChatDbHarness();
  const { store: coworkStore, session } = createCoworkStoreHarness();
  const { store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  let saveCount = 0;

  startPrivateChatDaemon(
    db,
    () => {
      saveCount += 1;
    },
    coworkStore,
    metabotStore,
    {
      on() {},
      off() {},
    },
    async () => {
      throw new Error('simulated broadcast failure');
    },
    (message) => logs.push(message),
    null,
    undefined,
    undefined,
    () => ({ respondToStrangerPrivateChats: true }),
    undefined,
    undefined,
    undefined,
    async () => ({
      prompt: '<available_skills><skill><id>metaid-master-wiki</id></skill></available_skills>',
      activeSkillIds: ['metaid-master-wiki'],
    }),
    async () => ({
      replyText: 'PoP 的全称是 Proof of PIN',
      assistantMessageId: null,
    }),
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('Failed to broadcast reply')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  const assistantMessage = session.messages.find((message) => message.type === 'assistant');
  assert.equal(row.is_processed, 0);
  assert.equal(saveCount, 0);
  assert.equal(assistantMessage?.metadata?.privateChatDeliveryStatus, 'failed');
  assert.match(String(assistantMessage?.metadata?.privateChatDeliveryError || ''), /simulated broadcast failure/);
});
