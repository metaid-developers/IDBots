import test from 'node:test';
import assert from 'node:assert/strict';

let appendPrivateChatA2AMessage;
let endPrivateChatA2AConversation;
let analyzePrivateChatA2AConversation;
let buildPrivateChatA2ASystemPrompt;
let waitBeforePrivateChatReply;
let getPrivateChatReplyDelayMs;
let shouldSkipPrivateChatAutoReplyText;
let hasNewerPrivateChatMessage;
let evaluatePrivateChatAutoReplyPolicy;
let hasPriorNonHandshakePrivateChatOutbound;
let hasPriorPrivateChatA2AOutbound;
try {
  ({
    appendPrivateChatA2AMessage,
    endPrivateChatA2AConversation,
    analyzePrivateChatA2AConversation,
    buildPrivateChatA2ASystemPrompt,
    waitBeforePrivateChatReply,
    getPrivateChatReplyDelayMs,
    shouldSkipPrivateChatAutoReplyText,
    hasNewerPrivateChatMessage,
    evaluatePrivateChatAutoReplyPolicy,
    hasPriorNonHandshakePrivateChatOutbound,
    hasPriorPrivateChatA2AOutbound,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    appendPrivateChatA2AMessage,
    endPrivateChatA2AConversation,
    analyzePrivateChatA2AConversation,
    buildPrivateChatA2ASystemPrompt,
    waitBeforePrivateChatReply,
    getPrivateChatReplyDelayMs,
    shouldSkipPrivateChatAutoReplyText,
    hasNewerPrivateChatMessage,
    evaluatePrivateChatAutoReplyPolicy,
    hasPriorNonHandshakePrivateChatOutbound,
    hasPriorPrivateChatA2AOutbound,
  } = await import('../dist-electron/services/privateChatDaemon.js'));
}

function createCoworkStoreHarness() {
  const stored = [];
  return {
    stored,
    coworkStore: {
      addMessage(sessionId, message) {
        const created = {
          id: `msg-${stored.length + 1}`,
          timestamp: 1_770_000_000_000 + stored.length,
          ...message,
        };
        stored.push({ sessionId, message: created });
        return created;
      },
    },
  };
}

test('regular private chat A2A messages are emitted live with display direction metadata', () => {
  const { coworkStore, stored } = createCoworkStoreHarness();
  const emitted = [];
  const emitToRenderer = (channel, data) => emitted.push({ channel, data });

  const incoming = appendPrivateChatA2AMessage({
    coworkStore,
    sessionId: 'session-private-1',
    externalConversationId: 'metaweb-private:peer-global-1',
    type: 'user',
    content: '你好呀',
    senderGlobalMetaId: 'peer-global-1',
    senderName: 'Sunny',
    senderAvatar: '/content/avatar.png',
    emitToRenderer,
  });
  const outgoing = appendPrivateChatA2AMessage({
    coworkStore,
    sessionId: 'session-private-1',
    externalConversationId: 'metaweb-private:peer-global-1',
    type: 'assistant',
    content: '你好，我在。',
    emitToRenderer,
  });

  assert.equal(stored.length, 2);
  assert.equal(incoming.metadata.sourceChannel, 'metaweb_private');
  assert.equal(incoming.metadata.externalConversationId, 'metaweb-private:peer-global-1');
  assert.equal(incoming.metadata.direction, 'incoming');
  assert.equal(incoming.metadata.senderGlobalMetaId, 'peer-global-1');
  assert.equal(incoming.metadata.senderName, 'Sunny');
  assert.equal(incoming.metadata.senderAvatar, '/content/avatar.png');
  assert.equal(incoming.metadata.suppressRunningStatus, true);
  assert.equal(outgoing.metadata.direction, 'outgoing');

  assert.deepEqual(emitted, [
    {
      channel: 'cowork:stream:message',
      data: { sessionId: 'session-private-1', message: incoming },
    },
    {
      channel: 'cowork:stream:message',
      data: { sessionId: 'session-private-1', message: outgoing },
    },
  ]);
});

test('ending a private chat A2A conversation marks the mapping closed and emits the local bye turn', () => {
  const emitted = [];
  const metadataUpdates = [];
  const addedMessages = [];
  const session = {
    id: 'session-private-1',
    sessionType: 'a2a',
    metabotId: 7,
    peerGlobalMetaId: 'peer-global-1',
  };
  const mapping = {
    channel: 'metaweb_private',
    externalConversationId: 'metaweb-private:peer-global-1',
    metabotId: 7,
    coworkSessionId: 'session-private-1',
    metadataJson: JSON.stringify({ peerGlobalMetaId: 'peer-global-1', peerName: 'Peer Bot' }),
  };
  const coworkStore = {
    getSession(id) {
      return id === session.id ? session : null;
    },
    getConversationSourceContextBySession(id) {
      assert.equal(id, session.id);
      return {
        sourceChannel: 'metaweb_private',
        externalConversationId: mapping.externalConversationId,
      };
    },
    getConversationMapping(channel, externalConversationId, metabotId) {
      assert.equal(channel, 'metaweb_private');
      assert.equal(externalConversationId, mapping.externalConversationId);
      assert.equal(metabotId, 7);
      return mapping;
    },
    updateConversationMappingMetadata(channel, externalConversationId, metabotId, metadata) {
      metadataUpdates.push({ channel, externalConversationId, metabotId, metadata });
    },
    updateSession(id, updates) {
      assert.equal(id, session.id);
      session.status = updates.status;
    },
    addMessage(sessionId, message) {
      const created = {
        id: `end-msg-${addedMessages.length + 1}`,
        timestamp: 1_770_000_000_000 + addedMessages.length,
        ...message,
      };
      addedMessages.push({ sessionId, message: created });
      return created;
    },
  };

  const result = endPrivateChatA2AConversation({
    coworkStore,
    sessionId: session.id,
    now: () => 1_770_000_000_000,
    emitToRenderer: (channel, data) => emitted.push({ channel, data }),
  });

  assert.equal(result.success, true);
  assert.equal(result.externalConversationId, mapping.externalConversationId);
  assert.equal(result.peerGlobalMetaId, 'peer-global-1');
  assert.deepEqual(metadataUpdates, [{
    channel: 'metaweb_private',
    externalConversationId: mapping.externalConversationId,
    metabotId: 7,
    metadata: {
      peerGlobalMetaId: 'peer-global-1',
      peerName: 'Peer Bot',
      byeSent: true,
      endedByHuman: true,
      endedAt: 1_770_000_000_000,
    },
  }]);
  assert.equal(session.status, 'completed');
  assert.equal(addedMessages.length, 2);
  assert.equal(addedMessages[0].message.content, 'bye');
  assert.equal(addedMessages[0].message.metadata.direction, 'outgoing');
  assert.equal(addedMessages[0].message.metadata.a2aConversationEnded, true);
  assert.match(addedMessages[1].message.content, /已结束/);
  assert.equal(addedMessages[1].message.metadata.a2aConversationEndSystemNotice, true);
  assert.deepEqual(emitted.map((entry) => entry.channel), [
    'cowork:stream:message',
    'cowork:stream:message',
    'cowork:stream:complete',
  ]);
});

test('private chat reply delay scales with active incoming turn count', async () => {
  assert.equal(getPrivateChatReplyDelayMs(1), 5000);
  assert.equal(getPrivateChatReplyDelayMs(10), 5000);
  assert.equal(getPrivateChatReplyDelayMs(11), 10000);
  assert.equal(getPrivateChatReplyDelayMs(20), 10000);
  assert.equal(getPrivateChatReplyDelayMs(21), 15000);
  assert.equal(getPrivateChatReplyDelayMs(30), 15000);
  assert.equal(getPrivateChatReplyDelayMs(31), 20000);
  assert.equal(getPrivateChatReplyDelayMs(40), 20000);
  assert.equal(getPrivateChatReplyDelayMs(41), 25000);
  assert.equal(getPrivateChatReplyDelayMs(50), 25000);

  const delays = [];
  await waitBeforePrivateChatReply(21, (ms) => {
    delays.push(ms);
    return Promise.resolve();
  });

  assert.deepEqual(delays, [15000]);
});

test('private chat prompt includes recent A2A context and topic-ending policy', () => {
  const analysis = analyzePrivateChatA2AConversation({
    messages: [
      {
        id: 'm1',
        type: 'user',
        content: '我们讨论一下比特币生态的索引器吧',
        timestamp: 1_770_000_000_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private', senderName: 'Peer Bot' },
      },
      {
        id: 'm2',
        type: 'assistant',
        content: '可以，先从链上数据可用性说起。',
        timestamp: 1_770_000_001_000,
        metadata: { direction: 'outgoing', sourceChannel: 'metaweb_private' },
      },
      {
        id: 'm3',
        type: 'user',
        content: '那缓存策略呢？',
        timestamp: 1_770_000_002_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private', senderName: 'Peer Bot' },
      },
    ],
    now: 1_770_000_002_000,
  });

  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: {
      name: 'Local Bot',
      role: 'Technical partner',
      soul: 'direct',
      goal: 'useful discussion',
      background: 'MetaID',
    },
    memoryContext: '<contactMemories />',
    analysis,
  });

  assert.match(prompt, /private-chat MetaBot/);
  assert.match(prompt, /valuable discussion/i);
  assert.match(prompt, /coherent topic/i);
  assert.match(prompt, /do not need to reply to every message/i);
  assert.match(prompt, /latest meaningful message/i);
  assert.match(prompt, /Thinking\.\.\./);
  assert.match(prompt, /\.\.\.\./);
  assert.match(prompt, /say exactly "bye"/i);
  assert.match(prompt, /50 turns/i);
  assert.match(prompt, /Peer Bot: 我们讨论一下比特币生态的索引器吧/);
  assert.match(prompt, /Local Bot: 可以，先从链上数据可用性说起。/);
  assert.match(prompt, /Peer Bot: 那缓存策略呢？/);
  assert.match(prompt, /<contactMemories \/>/);
});

test('regular private chat skips placeholder latest messages without an LLM reply', () => {
  assert.equal(shouldSkipPrivateChatAutoReplyText('Thinking...'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText(' thinking… '), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('....'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('……'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('bye'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('I am thinking about indexer caching.'), false);
  assert.equal(shouldSkipPrivateChatAutoReplyText('Can you compare these options?'), false);
});

test('regular private chat skips older turns when a newer peer message exists', () => {
  const execCalls = [];
  const db = {
    exec(sql, params) {
      execCalls.push({ sql, params });
      return [{ columns: ['found'], values: [[1]] }];
    },
  };

  assert.equal(
    hasNewerPrivateChatMessage(db, {
      currentRowId: 10,
      fromGlobalMetaId: 'peer-global',
      fromMetaId: 'peer-meta',
      toGlobalMetaId: 'local-global',
      toMetaId: 'local-meta',
    }),
    true,
  );
  assert.match(execCalls[0].sql, /private_chat_messages/);
  assert.match(execCalls[0].sql, /id > \?/);
  assert.deepEqual(execCalls[0].params, [
    10,
    'peer-global',
    'peer-meta',
    'local-global',
    'local-meta',
  ]);
});

test('private chat analysis requests bye at fifty incoming turns and resets after inactivity', () => {
  const base = 1_770_000_000_000;
  const longRun = Array.from({ length: 50 }, (_value, index) => ({
    id: `incoming-${index + 1}`,
    type: 'user',
    content: `turn ${index + 1}`,
    timestamp: base + index * 10_000,
    metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
  }));

  const longRunAnalysis = analyzePrivateChatA2AConversation({
    messages: longRun,
    now: base + 500_000,
  });
  assert.equal(longRunAnalysis.shouldForceBye, true);
  assert.equal(longRunAnalysis.incomingTurnCount, 50);

  const resetAnalysis = analyzePrivateChatA2AConversation({
    messages: [
      ...longRun,
      {
        id: 'after-gap',
        type: 'user',
        content: 'new topic after a long gap',
        timestamp: base + 50 * 10_000 + 11 * 60_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
    ],
    now: base + 50 * 10_000 + 11 * 60_000,
  });

  assert.equal(resetAnalysis.shouldForceBye, false);
  assert.equal(resetAnalysis.incomingTurnCount, 1);
  assert.deepEqual(
    resetAnalysis.contextMessages.map((message) => message.content),
    ['new topic after a long gap']
  );
});

test('private chat analysis resets after an outgoing bye', () => {
  const analysis = analyzePrivateChatA2AConversation({
    messages: [
      {
        id: 'before-bye',
        type: 'user',
        content: 'old topic',
        timestamp: 1_770_000_000_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
      {
        id: 'bye',
        type: 'assistant',
        content: 'bye',
        timestamp: 1_770_000_001_000,
        metadata: { direction: 'outgoing', sourceChannel: 'metaweb_private' },
      },
      {
        id: 'after-bye',
        type: 'user',
        content: 'new topic',
        timestamp: 1_770_000_002_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
    ],
    now: 1_770_000_002_000,
  });

  assert.equal(analysis.incomingTurnCount, 1);
  assert.deepEqual(analysis.contextMessages.map((message) => message.content), ['new topic']);
});

test('regular private chat auto-reply policy blocks strangers when the global switch is off', () => {
  const result = evaluatePrivateChatAutoReplyPolicy({
    metabot: {
      enabled: true,
      boss_id: null,
      boss_global_metaid: null,
      globalmetaid: 'local-global',
      metaid: 'local-meta',
    },
    senderGlobalMetaId: 'peer-global',
    senderMetaId: 'peer-meta',
    listenerConfig: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
      respondToStrangerPrivateChats: false,
    },
    metabotStore: {
      getMetabotById() {
        throw new Error('boss lookup should not be needed');
      },
    },
    hasPriorLocalOutbound: false,
  });

  assert.deepEqual(result, {
    shouldReply: false,
    reason: 'stranger_blocked',
  });
});

test('regular private chat auto-reply policy lets owners and known peers bypass the stranger switch', () => {
  const base = {
    metabot: {
      enabled: true,
      boss_id: 42,
      boss_global_metaid: null,
      globalmetaid: 'local-global',
      metaid: 'local-meta',
    },
    listenerConfig: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
      respondToStrangerPrivateChats: false,
    },
    metabotStore: {
      getMetabotById(id) {
        assert.equal(id, 42);
        return { globalmetaid: 'boss-global', metaid: 'boss-meta' };
      },
    },
  };

  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      senderGlobalMetaId: 'boss-global',
      senderMetaId: 'anything',
      hasPriorLocalOutbound: false,
    }),
    { shouldReply: true, reason: 'owner' },
  );

  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      metabot: {
        ...base.metabot,
        boss_id: null,
        boss_global_metaid: 'external-owner-global',
      },
      senderGlobalMetaId: 'external-owner-global',
      senderMetaId: 'anything',
      hasPriorLocalOutbound: false,
    }),
    { shouldReply: true, reason: 'owner' },
  );

  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      senderGlobalMetaId: 'peer-global',
      senderMetaId: 'peer-meta',
      hasPriorLocalOutbound: true,
    }),
    { shouldReply: true, reason: 'prior_local_outbound' },
  );
});

test('disabled MetaBots do not auto-respond even to owners or known peers', () => {
  const result = evaluatePrivateChatAutoReplyPolicy({
    metabot: {
      enabled: false,
      boss_id: null,
      boss_global_metaid: 'owner-global',
      globalmetaid: 'local-global',
      metaid: 'local-meta',
    },
    senderGlobalMetaId: 'owner-global',
    senderMetaId: 'owner-meta',
    listenerConfig: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
      respondToStrangerPrivateChats: true,
    },
    metabotStore: {
      getMetabotById() {
        return null;
      },
    },
    hasPriorLocalOutbound: true,
  });

  assert.deepEqual(result, {
    shouldReply: false,
    reason: 'disabled_metabot',
  });
});

test('prior private chat outbound detection only counts local non-handshake sends to the peer', () => {
  const execCalls = [];
  const hitDb = {
    exec(sql, params) {
      execCalls.push({ sql, params });
      return [{ columns: ['found'], values: [[1]] }];
    },
  };

  assert.equal(
    hasPriorNonHandshakePrivateChatOutbound(hitDb, {
      localGlobalMetaId: 'local-global',
      localMetaId: 'local-meta',
      peerGlobalMetaId: 'peer-global',
      peerMetaId: 'peer-meta',
      currentRowId: 9,
    }),
    true,
  );
  assert.match(execCalls[0].sql, /private_chat_messages/);
  assert.match(execCalls[0].sql, /NOT IN\s*\(\s*'ping'\s*,\s*'pong'\s*\)/i);
  assert.deepEqual(execCalls[0].params, [
    9,
    'local-global',
    'local-meta',
    'peer-global',
    'peer-meta',
  ]);

  const missDb = {
    exec() {
      return [{ columns: ['found'], values: [] }];
    },
  };
  assert.equal(
    hasPriorNonHandshakePrivateChatOutbound(missDb, {
      localGlobalMetaId: 'local-global',
      localMetaId: 'local-meta',
      peerGlobalMetaId: 'peer-global',
      peerMetaId: 'peer-meta',
      currentRowId: 9,
    }),
    false,
  );
});

test('prior A2A outbound detection counts previous local private chat turns', () => {
  const coworkStore = {
    getConversationMapping(channel, externalConversationId, metabotId) {
      assert.equal(channel, 'metaweb_private');
      assert.equal(externalConversationId, 'metaweb-private:peer-global');
      assert.equal(metabotId, 7);
      return { coworkSessionId: 'session-1' };
    },
    getSession(sessionId) {
      assert.equal(sessionId, 'session-1');
      return {
        messages: [
          {
            id: 'm1',
            type: 'user',
            content: 'hello?',
            timestamp: 1,
            metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
          },
          {
            id: 'm2',
            type: 'assistant',
            content: 'pong',
            timestamp: 2,
            metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
          },
          {
            id: 'm3',
            type: 'assistant',
            content: 'local reply',
            timestamp: 3,
            metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
          },
        ],
      };
    },
  };

  assert.equal(
    hasPriorPrivateChatA2AOutbound(coworkStore, {
      externalConversationId: 'metaweb-private:peer-global',
      metabotId: 7,
    }),
    true,
  );
});
