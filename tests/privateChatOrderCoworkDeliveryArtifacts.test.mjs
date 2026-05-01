import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PrivateChatOrderCowork } = require('../dist-electron/services/privateChatOrderCowork.js');

class FakeCoworkRunner extends EventEmitter {
  constructor() {
    super();
    this.startSessionCalls = [];
    this.stopSessionCalls = [];
    this.deferredStartCount = 0;
    this.startResolvers = [];
  }

  startSession(sessionId, prompt, options) {
    this.startSessionCalls.push({ sessionId, prompt, options });
    if (this.deferredStartCount > 0) {
      this.deferredStartCount -= 1;
      return new Promise((resolve) => {
        this.startResolvers.push(resolve);
      });
    }
    return Promise.resolve();
  }

  resolveStart(index = 0) {
    const resolve = this.startResolvers[index];
    if (resolve) resolve();
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
    this.hiddenSessionIds = new Set();
    this.mappingCalls = [];
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

  upsertConversationMapping(mapping) {
    this.mappingCalls.push(mapping);
  }

  setSessionHiddenFromList(sessionId, hidden) {
    if (hidden) {
      this.hiddenSessionIds.add(sessionId);
    } else {
      this.hiddenSessionIds.delete(sessionId);
    }
  }

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
    return { id: 1, name: 'Provider Bot' };
  }
}

test('runOrder uploads image output artifacts and returns a metafile delivery summary', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-delivery-'));
  const imagePath = path.join(cwd, 'rocket_launch.png');
  fs.writeFileSync(imagePath, 'png');

  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const sessionId = store.createTestSession(cwd);
  const uploadCalls = [];
  const rendererEvents = [];
  const remoteStatusUpdates = [];
  const deliverySequence = [];

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    emitToRenderer: (channel, payload) => {
      rendererEvents.push({ channel, payload });
    },
    uploadDeliveryArtifact: async (artifact) => {
      deliverySequence.push('upload');
      uploadCalls.push(artifact);
      return {
        pinId: 'aabbccddeeff00112233445566778899i0',
        previewUrl: 'https://file.metaid.io/metafile-indexer/api/v1/files/content/aabbccddeeff00112233445566778899i0',
        uploadMode: 'direct',
      };
    },
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-order-image',
    existingSessionId: sessionId,
    prompt: '[ORDER] 帮我生成一张火箭发射的图片',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'Sunny',
    peerAvatar: null,
    expectedOutputType: 'image',
    sendStatusUpdate: async (text) => {
      deliverySequence.push('status');
      remoteStatusUpdates.push(text);
    },
  });

  runner.emit('message', sessionId, {
    id: 'assistant-final',
    type: 'assistant',
    content: '火箭发射图片已生成，保存在 rocket_launch.png。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', sessionId);

  const result = await runPromise;

  assert.equal(result.isDeliverable, true);
  assert.equal(uploadCalls.length, 1);
  assert.deepEqual(deliverySequence, ['status', 'upload']);
  assert.equal(remoteStatusUpdates.length, 1);
  assert.match(remoteStatusUpdates[0], /数字成果已生成/);
  assert.match(remoteStatusUpdates[0], /上传链上交付/);
  assert.equal(uploadCalls[0].filePath, imagePath);
  assert.match(result.serviceReply, /metafile:\/\/aabbccddeeff00112233445566778899i0\.png/);
  assert.match(result.serviceReply, /PINID:\s*aabbccddeeff00112233445566778899i0/);

  const session = store.getSession(sessionId);
  const uploadNotice = session.messages.find((message) => message.metadata?.orderDeliveryUploadNotice);
  assert.ok(uploadNotice, 'expected upload notice to be added to the session');
  assert.match(uploadNotice.content, /数字成果已生成/);
  assert.match(uploadNotice.content, /上传链上交付/);

  const hasUploadNoticeEvent = rendererEvents.some((event) =>
    event.channel === 'cowork:stream:message' &&
    event.payload?.message?.metadata?.orderDeliveryUploadNotice
  );
  assert.equal(hasUploadNoticeEvent, true);
});

test('runOrder uses transmitted acknowledgement and status update chain metadata for local A2A bubbles', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-chain-metadata-'));
  const imagePath = path.join(cwd, 'robot.png');
  fs.writeFileSync(imagePath, 'png');

  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const sessionId = store.createTestSession(cwd);
  const ackTxid = 'a'.repeat(64);
  const statusTxid = 'b'.repeat(64);

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    uploadDeliveryArtifact: async () => ({
      pinId: 'c'.repeat(64) + 'i0',
      uploadMode: 'direct',
    }),
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-order-chain-metadata',
    existingSessionId: sessionId,
    prompt: '[ORDER] 帮我生成一张机器人图片',
    systemPrompt: 'test system prompt',
    expectedOutputType: 'image',
    processingNotice: {
      content: '链上确认：我已收到订单，马上开始创作。',
      metadata: {
        txid: ackTxid,
        txids: [ackTxid],
        pinId: `${ackTxid}i0`,
      },
    },
    sendStatusUpdate: async () => ({
      txids: [statusTxid],
      pinId: `${statusTxid}i0`,
    }),
  });

  runner.emit('message', sessionId, {
    id: 'assistant-final',
    type: 'assistant',
    content: '机器人图片已生成，保存在 robot.png。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', sessionId);

  await runPromise;

  const session = store.getSession(sessionId);
  const acknowledgement = session.messages.find((message) => message.metadata?.orderProcessingNotice);
  assert.ok(acknowledgement, 'expected processing acknowledgement bubble');
  assert.equal(acknowledgement.content, '链上确认：我已收到订单，马上开始创作。');
  assert.equal(acknowledgement.metadata.txid, ackTxid);
  assert.equal(acknowledgement.metadata.pinId, `${ackTxid}i0`);

  const uploadNotice = session.messages.find((message) => message.metadata?.orderDeliveryUploadNotice);
  assert.ok(uploadNotice, 'expected upload status bubble');
  assert.equal(uploadNotice.metadata.txid, statusTxid);
  assert.deepEqual(uploadNotice.metadata.txids, [statusTxid]);
  assert.equal(uploadNotice.metadata.pinId, `${statusTxid}i0`);
});

test('runOrder retries media delivery upload when the first PINID cannot be verified', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-delivery-retry-'));
  const imagePath = path.join(cwd, 'portrait.png');
  fs.writeFileSync(imagePath, 'png');

  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const sessionId = store.createTestSession(cwd);
  const uploadCalls = [];
  const verifyCalls = [];

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    uploadDeliveryArtifact: async (artifact) => {
      uploadCalls.push(artifact);
      const suffix = uploadCalls.length === 1 ? 'bad' : 'good';
      return {
        pinId: `aabbccddeeff00112233445566778899${suffix}i0`,
        uploadMode: 'direct',
      };
    },
    verifyDeliveryArtifactUpload: async (upload) => {
      verifyCalls.push(upload);
      return String(upload.pinId || '').includes('good');
    },
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-order-retry',
    existingSessionId: sessionId,
    prompt: '[ORDER] 帮我生成一张肖像图',
    systemPrompt: 'test system prompt',
    expectedOutputType: 'image',
  });

  runner.emit('message', sessionId, {
    id: 'assistant-final',
    type: 'assistant',
    content: '肖像图已生成，保存在 portrait.png。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', sessionId);

  const result = await runPromise;

  assert.equal(result.isDeliverable, true);
  assert.equal(uploadCalls.length, 2);
  assert.equal(verifyCalls.length, 2);
  assert.match(result.serviceReply, /goodi0\.png/);
});

test('runOrder rejects media delivery after one failed upload retry', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-delivery-failed-'));
  const imagePath = path.join(cwd, 'failed.png');
  fs.writeFileSync(imagePath, 'png');

  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const sessionId = store.createTestSession(cwd);
  const uploadCalls = [];

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    uploadDeliveryArtifact: async (artifact) => {
      uploadCalls.push(artifact);
      return { pinId: '' };
    },
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-order-failed',
    existingSessionId: sessionId,
    prompt: '[ORDER] 帮我生成一张图片',
    systemPrompt: 'test system prompt',
    expectedOutputType: 'image',
  });

  runner.emit('message', sessionId, {
    id: 'assistant-final',
    type: 'assistant',
    content: '图片已生成，保存在 failed.png。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', sessionId);

  const result = await runPromise;

  assert.equal(result.isDeliverable, false);
  assert.equal(uploadCalls.length, 2);
  assert.match(result.serviceReply, /上传链上交付失败/);
  assert.match(result.serviceReply, /退款流程/);
});

test('runOrder isolates concurrent same-peer orders into separate execution sessions with one display session', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-concurrent-'));
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const displaySessionId = store.createTestSession(cwd);

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  const first = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb_order:seller:1:peer:1111111111111111',
    displaySessionId,
    prompt: '[ORDER] first order',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'Sunny',
    orderTxid: '1'.repeat(64),
  });
  const second = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb_order:seller:1:peer:2222222222222222',
    displaySessionId,
    prompt: '[ORDER] second order',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'Sunny',
    orderTxid: '2'.repeat(64),
  });

  assert.equal(runner.startSessionCalls.length, 2);
  const firstExecutionSessionId = runner.startSessionCalls[0].sessionId;
  const secondExecutionSessionId = runner.startSessionCalls[1].sessionId;
  assert.notEqual(firstExecutionSessionId, displaySessionId);
  assert.notEqual(secondExecutionSessionId, displaySessionId);
  assert.notEqual(firstExecutionSessionId, secondExecutionSessionId);
  assert.equal(store.hiddenSessionIds.has(firstExecutionSessionId), true);
  assert.equal(store.hiddenSessionIds.has(secondExecutionSessionId), true);
  assert.equal(runner.startSessionCalls[0].options.disableMemoryUpdates, true);
  assert.equal(runner.startSessionCalls[1].options.disableMemoryUpdates, true);

  runner.emit('message', firstExecutionSessionId, {
    id: 'assistant-first',
    type: 'assistant',
    content: 'first result',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('message', secondExecutionSessionId, {
    id: 'assistant-second',
    type: 'assistant',
    content: 'second result',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', secondExecutionSessionId);
  runner.emit('complete', firstExecutionSessionId);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.serviceReply, 'first result');
  assert.equal(secondResult.serviceReply, 'second result');

  const displaySession = store.getSession(displaySessionId);
  const notices = displaySession.messages.filter((message) => message.metadata?.orderProcessingNotice);
  assert.equal(notices.length, 2);
  assert.deepEqual(
    notices.map((message) => message.metadata?.orderTxid),
    ['1'.repeat(64), '2'.repeat(64)],
  );
});

test('runOrder mirrors internal execution messages into the canonical seller display session', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-visible-execution-'));
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const displaySessionId = store.createTestSession(cwd);
  const rendererEvents = [];

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    emitToRenderer: (channel, payload) => {
      rendererEvents.push({ channel, payload });
    },
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb_order:seller:1:peer:visible-trace',
    displaySessionId,
    prompt: '[ORDER] 查询天气',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'Sunny',
    orderTxid: '4'.repeat(64),
  });

  const executionSessionId = runner.startSessionCalls[0].sessionId;
  runner.emit('message', executionSessionId, {
    id: 'assistant-trace',
    type: 'assistant',
    content: 'I am reading the weather skill before execution.',
    timestamp: Date.now(),
    metadata: { isThinking: true },
  });
  runner.emit('messageUpdate', executionSessionId, 'assistant-trace', 'I read the weather skill and will run it now.');
  runner.emit('message', executionSessionId, {
    id: 'tool-result',
    type: 'tool_result',
    content: 'beijing: ☀️ +27°C',
    timestamp: Date.now(),
    metadata: { isError: false },
  });
  runner.emit('message', executionSessionId, {
    id: 'assistant-final',
    type: 'assistant',
    content: '北京当前天气：晴，27°C。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', executionSessionId);

  const result = await runPromise;
  assert.equal(result.isDeliverable, true);
  assert.equal(result.serviceReply, '北京当前天气：晴，27°C。');

  const displaySession = store.getSession(displaySessionId);
  const mirroredTrace = displaySession.messages.find((message) => message.content.includes('will run it now'));
  assert.ok(mirroredTrace, 'expected internal assistant trace to be mirrored into display session');
  assert.equal(mirroredTrace.metadata?.orderExecutionTrace, true);
  assert.equal(mirroredTrace.metadata?.sourceChannel, 'metaweb_order_execution');
  assert.equal(mirroredTrace.metadata?.direction, undefined);
  assert.equal(mirroredTrace.metadata?.orderTxid, '4'.repeat(64));

  assert.equal(
    rendererEvents.some((event) =>
      event.channel === 'cowork:stream:message' &&
      event.payload?.sessionId === displaySessionId &&
      event.payload?.message?.metadata?.orderExecutionTrace === true
    ),
    true,
  );
  assert.equal(
    rendererEvents.some((event) =>
      event.channel === 'cowork:stream:message' &&
      event.payload?.sessionId === executionSessionId
    ),
    false,
  );
});

test('runOrder treats completed text orders without a final assistant reply as non-deliverable', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-text-no-final-'));
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const displaySessionId = store.createTestSession(cwd);
  let ratingInviteCalls = 0;

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    buildRatingInvite: async () => {
      ratingInviteCalls += 1;
      return '[NeedsRating] 请评价本次服务。';
    },
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb_order:seller:1:peer:text-no-final',
    displaySessionId,
    prompt: '[ORDER] 查询纽约未来 5 天天气',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'Sunny',
    expectedOutputType: 'text',
    orderTxid: '7'.repeat(64),
  });

  const executionSessionId = runner.startSessionCalls[0].sessionId;
  runner.emit('message', executionSessionId, {
    id: 'assistant-thinking',
    type: 'assistant',
    content: 'The weather command returned HTML; I need to extract the forecast.',
    timestamp: Date.now(),
    metadata: { isThinking: true },
  });
  runner.emit('message', executionSessionId, {
    id: 'tool-result',
    type: 'tool_result',
    content: '<html><body>New York: ☀ +27°C</body></html>',
    timestamp: Date.now(),
    metadata: { isError: false },
  });
  runner.emit('complete', executionSessionId);

  const result = await runPromise;
  assert.equal(result.isDeliverable, false);
  assert.equal(result.ratingInvite, '');
  assert.equal(ratingInviteCalls, 0);
  assert.doesNotMatch(result.serviceReply, /处理完成，但没有生成回复/);
  assert.match(result.serviceReply, /未能按约定交付 text 服务结果/);
  assert.match(result.serviceReply, /没有生成可交付的最终回复/);
  assert.match(result.serviceReply, /退款流程/);

  const displaySession = store.getSession(displaySessionId);
  const failureNotice = displaySession.messages.find((message) => message.metadata?.orderDeliveryFailed);
  assert.ok(failureNotice, 'expected a local order failure notice');
  assert.equal(failureNotice.metadata?.orderTxid, '7'.repeat(64));
});

test('runOrder continues media execution once when the first turn ends before generating an artifact', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-media-continuation-'));
  const imagePath = path.join(cwd, 'metabot_avatar.png');
  const runner = new FakeCoworkRunner();
  runner.deferredStartCount = 1;
  const store = new FakeCoworkStore(cwd);
  const displaySessionId = store.createTestSession(cwd);
  const uploadCalls = [];

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    uploadDeliveryArtifact: async (artifact) => {
      uploadCalls.push(artifact);
      return {
        pinId: 'd'.repeat(64) + 'i0',
        uploadMode: 'direct',
      };
    },
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb_order:seller:1:peer:image-continuation',
    displaySessionId,
    prompt: '[ORDER] 生成 MetaBot 头像图片',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'Sunny',
    expectedOutputType: 'image',
    orderTxid: '5'.repeat(64),
  });
  let settled = false;
  runPromise.finally(() => {
    settled = true;
  });

  const executionSessionId = runner.startSessionCalls[0].sessionId;
  runner.emit('message', executionSessionId, {
    id: 'assistant-started',
    type: 'assistant',
    content: 'API Key 已就绪，开始生成 MetaBot 头像。',
    timestamp: Date.now(),
    metadata: { isFinal: true },
  });
  runner.emit('complete', executionSessionId);
  assert.equal(
    runner.startSessionCalls.length,
    1,
    'continuation should not start synchronously inside the previous complete event',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    runner.startSessionCalls.length,
    1,
    'continuation should wait until the previous startSession promise settles',
  );

  runner.resolveStart(0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false, 'order should continue instead of failing before an image exists');
  assert.equal(runner.startSessionCalls.length, 2);
  assert.equal(runner.startSessionCalls[1].sessionId, executionSessionId);
  assert.equal(runner.startSessionCalls[1].options.skipInitialUserMessage, true);
  assert.match(runner.startSessionCalls[1].prompt, /generate a real image file/i);

  fs.writeFileSync(imagePath, 'png');
  runner.emit('message', executionSessionId, {
    id: 'assistant-final-image',
    type: 'assistant',
    content: `图片已生成，保存在 ${imagePath}。`,
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', executionSessionId);

  const result = await runPromise;
  assert.equal(result.isDeliverable, true);
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].filePath, imagePath);
  assert.match(result.serviceReply, /metafile:\/\/d{64}i0\.png/);
});

test('runOrder does not continue media execution when the assistant reports an explicit generation failure', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-media-explicit-failure-'));
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const displaySessionId = store.createTestSession(cwd);

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    uploadDeliveryArtifact: async () => {
      throw new Error('should not upload without an artifact');
    },
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb_order:seller:1:peer:image-explicit-failure',
    displaySessionId,
    prompt: '[ORDER] 生成 MetaBot 头像图片',
    systemPrompt: 'test system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'Sunny',
    expectedOutputType: 'image',
    orderTxid: '6'.repeat(64),
  });

  const executionSessionId = runner.startSessionCalls[0].sessionId;
  runner.emit('message', executionSessionId, {
    id: 'assistant-explicit-failure',
    type: 'assistant',
    content: '未能生成图片，因为缺少有效的 ARK_API_KEY。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', executionSessionId);
  await new Promise((resolve) => setImmediate(resolve));

  const result = await runPromise;
  assert.equal(runner.startSessionCalls.length, 1);
  assert.equal(result.isDeliverable, false);
  assert.match(result.serviceReply, /未找到符合 image 交付格式的数字成果/);
});

test('runOrder rejects metaweb_private orders that are missing a canonical peer display session', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-missing-display-'));
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(cwd);
  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 10,
    buildRatingInvite: async () => '[NeedsRating] 请评价本次服务。',
  });

  await assert.rejects(
    handler.runOrder({
      metabotId: 1,
      source: 'metaweb_private',
      externalConversationId: 'metaweb_order:seller:1:peer:missing-display',
      prompt: '[ORDER] missing display session',
      systemPrompt: 'test system prompt',
      peerGlobalMetaId: 'peer-gmid',
      peerName: 'Sunny',
      orderTxid: '3'.repeat(64),
    }),
    /canonical peer conversation session/i,
  );

  assert.equal(runner.startSessionCalls.length, 0);
  assert.equal(store.sessions.size, 0);
  assert.deepEqual(store.mappingCalls, []);
});
