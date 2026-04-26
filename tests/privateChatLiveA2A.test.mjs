import test from 'node:test';
import assert from 'node:assert/strict';

let appendPrivateChatA2AMessage;
try {
  ({ appendPrivateChatA2AMessage } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({ appendPrivateChatA2AMessage } = await import('../dist-electron/services/privateChatDaemon.js'));
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
