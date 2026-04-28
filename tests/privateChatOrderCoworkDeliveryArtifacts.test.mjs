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
