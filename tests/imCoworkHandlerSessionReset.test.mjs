import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const { IMCoworkHandler } = await import('../dist-electron/im/imCoworkHandler.js');

const PLATFORM = 'telegram';
const CONVERSATION_ID = 'telegram:chat:42';
const SENDER_ID = 'tg-user-42';
const SENDER_NAME = 'Alice';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-im-cowork-test-'));
}

function makeMockCoworkStore(workingDirectory) {
  const sessions = new Map();
  const conversationMappings = new Map();
  let sessionCounter = 0;

  const mappingKey = (channel, externalConversationId, metabotId) =>
    `${channel}::${externalConversationId}::${metabotId ?? 'null'}`;

  return {
    sessions,
    conversationMappings,
    getConfig() {
      return { workingDirectory, systemPrompt: '' };
    },
    getSession(id) {
      return sessions.get(id) ?? null;
    },
    createSession(
      title,
      cwd,
      systemPrompt,
      executionMode,
      activeSkillIds,
      metabotId,
      sessionType,
      peerGlobalMetaId,
      peerName,
      peerAvatar,
    ) {
      sessionCounter += 1;
      const id = `session-${sessionCounter}`;
      const session = {
        id,
        title,
        cwd,
        systemPrompt,
        executionMode,
        activeSkillIds,
        metabotId,
        sessionType,
        peerGlobalMetaId,
        peerName,
        peerAvatar,
        claudeSessionId: null,
        status: 'idle',
      };
      sessions.set(id, session);
      return session;
    },
    updateSession(id, patch) {
      const session = sessions.get(id);
      if (!session) return;
      Object.assign(session, patch);
    },
    getConversationMapping(channel, externalConversationId, metabotId) {
      return conversationMappings.get(mappingKey(channel, externalConversationId, metabotId)) ?? null;
    },
    upsertConversationMapping({ channel, externalConversationId, metabotId, coworkSessionId }) {
      conversationMappings.set(
        mappingKey(channel, externalConversationId, metabotId),
        { channel, externalConversationId, metabotId: metabotId ?? null, coworkSessionId },
      );
    },
    touchConversationMapping() {
      /* no-op for test */
    },
    deleteConversationMapping(channel, externalConversationId, metabotId) {
      conversationMappings.delete(mappingKey(channel, externalConversationId, metabotId));
    },
  };
}

function makeMockImStore() {
  const sessionMappings = new Map();
  const key = (conversationId, platform) => `${platform}::${conversationId}`;

  return {
    sessionMappings,
    getIMSettings() {
      return { skillsEnabled: false };
    },
    getSessionMapping(conversationId, platform) {
      return sessionMappings.get(key(conversationId, platform)) ?? null;
    },
    createSessionMapping(conversationId, platform, coworkSessionId, metabotId) {
      const mapping = {
        imConversationId: conversationId,
        platform,
        coworkSessionId,
        metabotId: metabotId ?? null,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      sessionMappings.set(key(conversationId, platform), mapping);
      return mapping;
    },
    updateSessionLastActive(conversationId, platform) {
      const mapping = sessionMappings.get(key(conversationId, platform));
      if (mapping) mapping.lastActiveAt = Date.now();
    },
    deleteSessionMapping(conversationId, platform) {
      sessionMappings.delete(key(conversationId, platform));
    },
  };
}

class MockCoworkRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.activeSessions = new Set();
    this.startedCalls = [];
    this.continuedCalls = [];
    this.stoppedSessions = [];
    // When set, the next start/continueSession emits an 'error' event instead
    // of an automatic 'complete', so tests can exercise the error path.
    this.nextOutcome = options.nextOutcome ?? 'complete';
  }

  isSessionActive(sessionId) {
    return this.activeSessions.has(sessionId);
  }

  _emitTurnOutcome(sessionId, replyContent) {
    const outcome = this.nextOutcome;
    this.nextOutcome = 'complete';
    queueMicrotask(() => {
      if (outcome === 'error') {
        this.emit('error', sessionId, 'mock failure');
        return;
      }
      this.emit('message', sessionId, {
        id: `msg-${sessionId}-${Date.now()}`,
        type: 'assistant',
        content: replyContent,
        metadata: {},
      });
      this.emit('complete', sessionId);
    });
  }

  async startSession(sessionId, content, options) {
    this.startedCalls.push({ sessionId, content, options });
    this.activeSessions.add(sessionId);
    this._emitTurnOutcome(sessionId, `reply for ${content}`);
  }

  async continueSession(sessionId, content, options) {
    this.continuedCalls.push({ sessionId, content, options });
    this._emitTurnOutcome(sessionId, `continued reply for ${content}`);
  }

  stopSession(sessionId) {
    this.activeSessions.delete(sessionId);
    this.stoppedSessions.push(sessionId);
  }
}

function makeMessage(content) {
  return {
    platform: PLATFORM,
    conversationId: CONVERSATION_ID,
    chatType: 'direct',
    senderId: SENDER_ID,
    senderName: SENDER_NAME,
    content,
    attachments: [],
  };
}

test('requestSessionReset returns false for unknown session ids', () => {
  const workspace = makeWorkspace();
  try {
    const coworkStore = makeMockCoworkStore(workspace);
    const imStore = makeMockImStore();
    const coworkRunner = new MockCoworkRunner();
    const handler = new IMCoworkHandler({ coworkRunner, coworkStore, imStore });

    assert.equal(handler.requestSessionReset('does-not-exist'), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('start_new_im_session teardown forces a fresh cowork session on next inbound message', async () => {
  const workspace = makeWorkspace();
  try {
    const coworkStore = makeMockCoworkStore(workspace);
    const imStore = makeMockImStore();
    const coworkRunner = new MockCoworkRunner();
    const handler = new IMCoworkHandler({ coworkRunner, coworkStore, imStore });

    const reply1 = await handler.processMessage(makeMessage('hello world'), null);
    assert.match(reply1, /reply for/);
    assert.equal(coworkRunner.startedCalls.length, 1);
    const firstSessionId = coworkRunner.startedCalls[0].sessionId;

    const mappingAfterFirst = imStore.getSessionMapping(CONVERSATION_ID, PLATFORM);
    assert.ok(mappingAfterFirst, 'first message should register an IM session mapping');
    assert.equal(mappingAfterFirst.coworkSessionId, firstSessionId);

    assert.equal(
      handler.requestSessionReset(firstSessionId),
      true,
      'reset request for an active IM session should be staged',
    );

    // Trigger another turn so handleComplete fires while reset is staged.
    coworkRunner.activeSessions.add(firstSessionId);
    const reply2 = await handler.processMessage(makeMessage('one more thing'), null);
    assert.match(reply2, /continued reply for/);

    assert.equal(
      imStore.getSessionMapping(CONVERSATION_ID, PLATFORM),
      null,
      'IM session mapping must be torn down after the reset-staged turn completes',
    );

    const reply3 = await handler.processMessage(makeMessage('a brand new topic'), null);
    assert.match(reply3, /reply for/);
    assert.equal(
      coworkRunner.startedCalls.length,
      2,
      'a new cowork session should be started for the next inbound message',
    );
    const secondSessionId = coworkRunner.startedCalls[1].sessionId;
    assert.notEqual(
      secondSessionId,
      firstSessionId,
      'the rotated session id must differ from the original',
    );

    const mappingAfterReset = imStore.getSessionMapping(CONVERSATION_ID, PLATFORM);
    assert.ok(mappingAfterReset, 'a fresh mapping should exist for the new session');
    assert.equal(mappingAfterReset.coworkSessionId, secondSessionId);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('handleError clears the staged reset flag without tearing down the mapping', async () => {
  const workspace = makeWorkspace();
  try {
    const coworkStore = makeMockCoworkStore(workspace);
    const imStore = makeMockImStore();
    const coworkRunner = new MockCoworkRunner();
    const handler = new IMCoworkHandler({ coworkRunner, coworkStore, imStore });

    await handler.processMessage(makeMessage('hello'), null);
    const sessionId = coworkRunner.startedCalls[0].sessionId;

    assert.equal(handler.requestSessionReset(sessionId), true);

    coworkRunner.activeSessions.add(sessionId);
    coworkRunner.nextOutcome = 'error';
    await assert.rejects(
      handler.processMessage(makeMessage('boom'), null),
      /mock failure/,
    );

    assert.ok(
      imStore.getSessionMapping(CONVERSATION_ID, PLATFORM),
      'IM session mapping must survive an errored turn so the user can retry',
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
