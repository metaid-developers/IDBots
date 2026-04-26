import test from 'node:test';
import assert from 'node:assert/strict';

let appendPrivateChatA2AMessage;
let endPrivateChatA2AConversation;
try {
  ({ appendPrivateChatA2AMessage, endPrivateChatA2AConversation } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({ appendPrivateChatA2AMessage, endPrivateChatA2AConversation } = await import('../dist-electron/services/privateChatDaemon.js'));
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
