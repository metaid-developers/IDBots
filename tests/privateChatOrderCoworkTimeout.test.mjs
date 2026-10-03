import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The electron compile output lives under dist-electron/main/ (tsc rootDir=src
// since the src/main+src/renderer split). Probe the current layout first and
// fall back to the legacy flat path for older checkouts.
let privateChatOrderCoworkModule;
try {
  privateChatOrderCoworkModule = require('../dist-electron/main/services/privateChatOrderCowork.js');
} catch {
  privateChatOrderCoworkModule = require('../dist-electron/main/services/privateChatOrderCowork.js');
}
const {
  DEFAULT_ORDER_TIMEOUT_MS,
  VIDEO_ORDER_STATUS_INTERVAL_MS,
  VIDEO_ORDER_TIMEOUT_MS,
  PrivateChatOrderCowork,
  resolveOrderExecutionTimeoutMs,
} = privateChatOrderCoworkModule;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  registerTextPermissionRelay() {}
  unregisterTextPermissionRelay() {}
  isPermissionPending() { return false; }
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

test('resolveOrderExecutionTimeoutMs uses 5 minutes by default and 20 minutes for video', () => {
  assert.equal(DEFAULT_ORDER_TIMEOUT_MS, 5 * 60_000);
  assert.equal(VIDEO_ORDER_TIMEOUT_MS, 20 * 60_000);
  assert.equal(VIDEO_ORDER_STATUS_INTERVAL_MS, 120_000);
  assert.equal(resolveOrderExecutionTimeoutMs({ expectedOutputType: 'text' }), 5 * 60_000);
  assert.equal(resolveOrderExecutionTimeoutMs({ expectedOutputType: 'image' }), 5 * 60_000);
  assert.equal(resolveOrderExecutionTimeoutMs({ expectedOutputType: 'video' }), 20 * 60_000);
  assert.equal(
    resolveOrderExecutionTimeoutMs(
      { expectedOutputType: 'video' },
      { defaultTimeoutMs: 30, videoTimeoutMs: 40 },
    ),
    40,
  );
});

test('runOrder sends long-video notice and recurring scoped ORDER_STATUS updates', async () => {
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(process.cwd());
  const sessionId = store.createTestSession(process.cwd());
  const orderTxid = 'a'.repeat(64);
  const remoteStatusUpdates = [];

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    videoStatusIntervalMs: 20,
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-video-order-test',
    existingSessionId: sessionId,
    prompt: '[ORDER] 请生成一个海边短视频',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'eric',
    peerAvatar: null,
    expectedOutputType: 'video',
    orderTxid,
    orderPinId: 'video-order-pin-i0',
    sendStatusUpdate: async (text) => {
      remoteStatusUpdates.push(text);
      return {
        txids: [String(remoteStatusUpdates.length).padStart(64, '0')],
        pinId: `${String(remoteStatusUpdates.length).padStart(64, '0')}i0`,
      };
    },
  });

  await sleep(55);
  runner.emit('message', sessionId, {
    id: 'assistant-progress',
    type: 'assistant',
    content: '视频还在生成中。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', sessionId);

  await runPromise;
  const statusCountAtComplete = remoteStatusUpdates.length;
  await sleep(45);

  assert.ok(statusCountAtComplete >= 3, `expected initial notice plus recurring updates, got ${statusCountAtComplete}`);
  assert.equal(remoteStatusUpdates.length, statusCountAtComplete);
  assert.match(remoteStatusUpdates[0], new RegExp(`^\\[ORDER_STATUS:${orderTxid}\\]`));
  // Order notices are English-only since 8ac69ff7 ("match A2A service language").
  assert.match(remoteStatusUpdates[0], /video task/);
  assert.match(remoteStatusUpdates[0], /may take longer/);
  assert.ok(remoteStatusUpdates.slice(1).some((text) => /still processing/.test(text)));
  assert.ok(remoteStatusUpdates.every((text) => /order pin id: video-order-pin-i0/.test(text)));
});

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
  assert.match(result.serviceReply, /service execution timed out/);
  assert.match(result.serviceReply, /guangzhou/i);
  assert.deepEqual(runner.stopSessionCalls, [{
    sessionId,
    options: { finalStatus: 'completed', reason: 'private chat order finished (timeout fallback)' },
  }]);

  const session = store.getSession(sessionId);
  const lastMessage = session.messages[session.messages.length - 1];
  assert.equal(lastMessage.type, 'assistant');
  assert.equal(lastMessage.metadata?.orderTimeoutFallback, true);
  assert.match(lastMessage.content, /service execution timed out/);

  const hasCompleteEvent = rendererEvents.some((event) => event.channel === 'cowork:stream:complete');
  assert.equal(hasCompleteEvent, true);
});

test('missing artifact continuation consumes newly queued A2A guidance', async () => {
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(process.cwd());
  const displaySessionId = store.createTestSession(process.cwd());
  const consumed = [];
  let guidanceQueued = false;

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    consumeA2AGuidance: (sessionId, metabotId) => {
      if (!guidanceQueued) return null;
      guidanceQueued = false;
      consumed.push({ displaySessionId: sessionId, metabotId });
      return '如果没有生成图片，就立即继续调用工具生成真实文件。';
    },
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-image-order-test',
    displaySessionId,
    prompt: '[ORDER] 请生成一张海边图片',
    systemPrompt: 'test image system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'eric',
    peerAvatar: null,
    expectedOutputType: 'image',
    orderTxid: 'b'.repeat(64),
    orderPinId: 'image-order-pin-i0',
  });

  await sleep(25);
  assert.equal(runner.startSessionCalls.length, 1);
  const executionSessionId = runner.startSessionCalls[0].sessionId;
  guidanceQueued = true;
  runner.emit('message', executionSessionId, {
    id: 'assistant-progress',
    type: 'assistant',
    content: '图片已经开始生成。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', executionSessionId);

  await sleep(25);
  assert.equal(runner.startSessionCalls.length, 2);
  assert.deepEqual(consumed, [{ displaySessionId, metabotId: 1 }]);
  assert.match(runner.startSessionCalls[1].options.systemPrompt, /Human Operator Guidance/);
  assert.match(runner.startSessionCalls[1].options.systemPrompt, /立即继续调用工具生成真实文件/);
  // The missing-artifact continuation runs in the same read-only memory mode
  // as the initial order turn (audit P1).
  assert.equal(runner.startSessionCalls[0].options.memoryReadOnly, true);
  assert.equal(runner.startSessionCalls[1].options.memoryReadOnly, true);

  runner.emit('message', executionSessionId, {
    id: 'assistant-failure',
    type: 'assistant',
    content: '无法生成图片：缺少可用图片生成工具。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', executionSessionId);

  const result = await runPromise;
  assert.equal(result.isDeliverable, false);
});

test('missing artifact continuation does not reuse already consumed A2A guidance', async () => {
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(process.cwd());
  const displaySessionId = store.createTestSession(process.cwd());
  const consumeCalls = [];
  let pendingGuidance = '这条引导只应该用于第一次订单模型回合。';

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    consumeA2AGuidance: (sessionId, metabotId) => {
      consumeCalls.push({ displaySessionId: sessionId, metabotId });
      const guidance = pendingGuidance;
      pendingGuidance = null;
      return guidance;
    },
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-image-order-once-test',
    displaySessionId,
    prompt: '[ORDER] 请生成一张海边图片',
    systemPrompt: 'test image system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'eric',
    peerAvatar: null,
    expectedOutputType: 'image',
    orderTxid: 'c'.repeat(64),
    orderPinId: 'image-order-once-pin-i0',
  });

  await sleep(25);
  assert.equal(runner.startSessionCalls.length, 1);
  const executionSessionId = runner.startSessionCalls[0].sessionId;
  assert.deepEqual(consumeCalls, [{ displaySessionId, metabotId: 1 }]);
  assert.match(runner.startSessionCalls[0].options.systemPrompt, /Human Operator Guidance/);
  assert.match(runner.startSessionCalls[0].options.systemPrompt, /只应该用于第一次订单模型回合/);

  runner.emit('message', executionSessionId, {
    id: 'assistant-progress-once',
    type: 'assistant',
    content: '图片已经开始生成。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', executionSessionId);

  await sleep(25);
  assert.equal(runner.startSessionCalls.length, 2);
  assert.deepEqual(consumeCalls, [
    { displaySessionId, metabotId: 1 },
    { displaySessionId, metabotId: 1 },
  ]);
  assert.doesNotMatch(runner.startSessionCalls[1].options.systemPrompt, /Human Operator Guidance/);
  assert.doesNotMatch(runner.startSessionCalls[1].options.systemPrompt, /只应该用于第一次订单模型回合/);

  runner.emit('message', executionSessionId, {
    id: 'assistant-failure-once',
    type: 'assistant',
    content: '无法生成图片：缺少可用图片生成工具。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', executionSessionId);

  const result = await runPromise;
  assert.equal(result.isDeliverable, false);
});
