import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrivateChatOrderCowork } = require('../dist-electron/services/privateChatOrderCowork.js');

class FakeCoworkRunner extends EventEmitter {
  constructor() {
    super();
    this.startSessionCalls = [];
    this.stopSessionCalls = [];
  }

  startSession(sessionId, prompt, options) {
    this.startSessionCalls.push({ sessionId, prompt, options });
    return Promise.resolve();
  }

  stopSession(sessionId, options) {
    this.stopSessionCalls.push({ sessionId, options: options || null });
  }

  respondToPermission() {}
}

class FakeCoworkStore {
  constructor(workingDirectory) {
    this.workingDirectory = workingDirectory;
    this.sessions = new Map();
    this.messageCounter = 0;
  }

  getConfig() {
    return { workingDirectory: this.workingDirectory };
  }

  createSession(title, cwd) {
    const id = `session-${this.sessions.size + 1}`;
    const session = {
      id,
      title,
      cwd,
      messages: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  createTestSession(cwd) {
    return this.createSession('test', cwd).id;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  upsertConversationMapping() {}

  addMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const created = {
      id: `message-${++this.messageCounter}`,
      type: message.type,
      content: message.content,
      timestamp: Date.now(),
      metadata: message.metadata,
    };
    session.messages.push(created);
    return created;
  }

  updateMessage(sessionId, messageId, updates) {
    const session = this.getSession(sessionId);
    if (!session) return;
    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    if (updates.content !== undefined) {
      session.messages[index].content = updates.content;
    }
    if (updates.metadata !== undefined) {
      session.messages[index].metadata = updates.metadata;
    }
  }
}

class FakeMetabotStore {
  getMetabotById() {
    return null;
  }
}

test('runOrder resolves timeout with a visible non-deliverable fallback', async () => {
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(process.cwd());
  const sessionId = store.createTestSession(process.cwd());
  const rendererEvents = [];

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 20,
    emitToRenderer: (channel, payload) => {
      rendererEvents.push({ channel, payload });
    },
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-order-test',
    existingSessionId: sessionId,
    prompt: '[ORDER] 广州天气如何？',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'eric',
    peerAvatar: null,
  });

  runner.emit('message', sessionId, {
    id: 'thinking-1',
    type: 'assistant',
    content: '这是',
    timestamp: Date.now(),
    metadata: { isThinking: true, isStreaming: true },
  });
  runner.emit('message', sessionId, {
    id: 'tool-result-1',
    type: 'tool_result',
    content: 'guangzhou: ☀️ +26°C 74% ↑14km/h',
    timestamp: Date.now(),
    metadata: { isError: false },
  });

  const result = await runPromise;

  assert.equal(result.isDeliverable, false);
  assert.equal(result.ratingInvite, '');
  assert.match(result.serviceReply, /服务执行超时/);
  assert.match(result.serviceReply, /guangzhou/i);
  assert.deepEqual(runner.stopSessionCalls, [{ sessionId, options: { finalStatus: 'completed' } }]);

  const session = store.getSession(sessionId);
  const lastMessage = session.messages[session.messages.length - 1];
  assert.equal(lastMessage.type, 'assistant');
  assert.equal(lastMessage.metadata?.orderTimeoutFallback, true);
  assert.match(lastMessage.content, /服务执行超时/);

  const hasCompleteEvent = rendererEvents.some((event) => event.channel === 'cowork:stream:complete');
  assert.equal(hasCompleteEvent, true);
});
