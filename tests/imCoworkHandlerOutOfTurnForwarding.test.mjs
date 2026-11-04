/**
 * Out-of-turn IM delivery tests.
 *
 * A cowork turn that was NOT triggered by an inbound IM message (an
 * [ORCH-NOTIFY] cross-session injection, a scheduled wake, ...) has no message
 * accumulator. Its reply must reach the conversation the session is bound to,
 * through the platform-agnostic per-conversation sender, exactly once — while
 * the accumulator path keeps sending through its own closure and never
 * double-delivers through the new path.
 *
 * Routing is decided by the session's persisted origin channel
 * (cowork_ui / im:<platform>:<chatType>), never by "an IM gateway is connected
 * on this machine": a cowork_ui-origin turn must never reach WeChat.
 *
 * Run: npm run test:im-gateway
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const { IMCoworkHandler } = await import('../dist-electron/main/im/imCoworkHandler.js');

const PLATFORM = 'weixin';
const CONVERSATION_ID = 'wx-owner-42';
const SENDER_ID = 'wx-owner-42';
const SENDER_NAME = 'Owner';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-im-out-of-turn-'));
}

function makeMockCoworkStore(workingDirectory) {
  const sessions = new Map();
  const conversationMappings = new Map();
  const messagesBySession = new Map();
  const sourceContextBySession = new Map();
  let sessionCounter = 0;

  const mappingKey = (channel, externalConversationId, metabotId) =>
    `${channel}::${externalConversationId}::${metabotId ?? 'null'}`;

  return {
    sessions,
    conversationMappings,
    sourceContextBySession,
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
        claudeSessionId: null,
        status: 'idle',
      };
      sessions.set(id, session);
      // Mirrors CoworkStore.createSession: every session starts with a
      // cowork_ui conversation mapping.
      sourceContextBySession.set(id, { sourceChannel: 'cowork_ui', externalConversationId: id });
      return session;
    },
    updateSession(id, patch) {
      const session = sessions.get(id);
      if (!session) return;
      Object.assign(session, patch);
    },
    getConversationSourceContextBySession(sessionId) {
      return sourceContextBySession.get(sessionId)
        ?? { sourceChannel: 'cowork_ui', externalConversationId: sessionId };
    },
    /** Test seam: force a session's persisted origin (e.g. a stale mapping). */
    setSourceContext(sessionId, context) {
      if (context) sourceContextBySession.set(sessionId, context);
      else sourceContextBySession.delete(sessionId);
    },
    getConversationMapping(channel, externalConversationId, metabotId) {
      return conversationMappings.get(mappingKey(channel, externalConversationId, metabotId)) ?? null;
    },
    upsertConversationMapping({ channel, externalConversationId, metabotId, coworkSessionId }) {
      conversationMappings.set(
        mappingKey(channel, externalConversationId, metabotId),
        { channel, externalConversationId, metabotId: metabotId ?? null, coworkSessionId },
      );
      // Mirrors the store's resolution precedence: an im:* mapping outranks the
      // cowork_ui mapping every session is born with.
      const current = sourceContextBySession.get(coworkSessionId);
      if (channel.startsWith('im:') || !current) {
        sourceContextBySession.set(coworkSessionId, {
          sourceChannel: channel,
          externalConversationId,
        });
      }
    },
    touchConversationMapping() {
      /* no-op for test */
    },
    deleteConversationMapping(channel, externalConversationId, metabotId) {
      conversationMappings.delete(mappingKey(channel, externalConversationId, metabotId));
    },
    /** Seed transcript rows for a session, in transcript order. */
    appendMessages(sessionId, messages) {
      const list = messagesBySession.get(sessionId) ?? [];
      list.push(...messages);
      messagesBySession.set(sessionId, list);
    },
    getSessionMessagesPage(sessionId, options = {}) {
      const all = messagesBySession.get(sessionId) ?? [];
      const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 50;
      // The real store hands a page over oldest-first.
      const page = all.slice(Math.max(0, all.length - limit));
      return {
        messages: page,
        hasMoreBefore: all.length > page.length,
        beforeSequence: null,
        beforeTranscriptCursor: null,
      };
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
  constructor() {
    super();
    this.activeSessions = new Set();
    this.startedCalls = [];
    this.continuedCalls = [];
  }

  isSessionActive(sessionId) {
    return this.activeSessions.has(sessionId);
  }

  registerTextPermissionRelay() {
    /* no-op for test */
  }

  unregisterTextPermissionRelay() {
    /* no-op for test */
  }

  _emitTurnOutcome(sessionId, replyContent) {
    queueMicrotask(() => {
      this.emit('message', sessionId, {
        id: `msg-${sessionId}-${Date.now()}`,
        type: 'assistant',
        content: replyContent,
        metadata: {},
      });
      this.emit('complete', sessionId);
    });
  }

  async startSession(sessionId, content) {
    this.startedCalls.push({ sessionId, content });
    this.activeSessions.add(sessionId);
    this._emitTurnOutcome(sessionId, `reply for ${content}`);
  }

  async continueSession(sessionId, content) {
    this.continuedCalls.push({ sessionId, content });
    this._emitTurnOutcome(sessionId, `continued reply for ${content}`);
  }

  stopSession(sessionId) {
    this.activeSessions.delete(sessionId);
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

async function flushAsyncWork() {
  // The out-of-turn delivery is deliberately fire-and-forget: let its promise
  // chain (and the store read that precedes it) settle.
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeSender(result = true) {
  const calls = [];
  const sendToConversation = async (target, text) => {
    calls.push({ target, text });
    return result;
  };
  return { calls, sendToConversation };
}

/**
 * Establish an IM-managed session through the normal inbound path (the only
 * public way to register `imSessionIds` + the conversation mapping), then
 * return its id.
 */
async function establishImSession(coworkStore, imStore, runner, handlerOptions) {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    ...handlerOptions,
  });
  const reply = await handler.processMessage(makeMessage('hello'), null);
  assert.match(reply, /reply for/);
  assert.equal(runner.startedCalls.length, 1);
  return { handler, sessionId: runner.startedCalls[0].sessionId };
}

function withHarness(fn) {
  return async () => {
    const workspace = makeWorkspace();
    try {
      const coworkStore = makeMockCoworkStore(workspace);
      const imStore = makeMockImStore();
      const runner = new MockCoworkRunner();
      await fn({ coworkStore, imStore, runner });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };
}

test('out-of-turn IM turn forwards its reply to the bound conversation exactly once', withHarness(async ({
  coworkStore,
  imStore,
  runner,
}) => {
  const sender = makeSender(true);
  const { handler, sessionId } = await establishImSession(coworkStore, imStore, runner, {
    sendToConversation: sender.sendToConversation,
  });

  // The turn that follows has NO accumulator: a cross-session injection
  // inserted a user message and the assistant answered it.
  coworkStore.appendMessages(sessionId, [
    { id: 'u1', type: 'user', content: 'hello', timestamp: 1 },
    { id: 'a1', type: 'assistant', content: 'reply for hello', timestamp: 2 },
    { id: 'u-notify', type: 'user', content: '[ORCH-NOTIFY] worker finished task 42', timestamp: 3 },
    { id: 'a-final', type: 'assistant', content: 'done, verified against the chain', timestamp: 4 },
  ]);

  runner.emit('complete', sessionId);
  await flushAsyncWork();

  assert.equal(sender.calls.length, 1, 'the out-of-turn reply must be sent exactly once');
  assert.deepEqual(sender.calls[0].target, {
    platform: PLATFORM,
    conversationId: CONVERSATION_ID,
  });
  assert.equal(sender.calls[0].text, 'done, verified against the chain');

  // The injected notification is data, never an echo target.
  assert.doesNotMatch(sender.calls[0].text, /ORCH-NOTIFY/);

  // A duplicate `complete` for the same turn must not send it again.
  runner.emit('complete', sessionId);
  await flushAsyncWork();
  assert.equal(sender.calls.length, 1, 'a re-entrant complete must not double-send');

  handler.destroy();
}));

test('accumulator path sends through its reply closure and never through the conversation sender', withHarness(async ({
  coworkStore,
  imStore,
  runner,
}) => {
  const sender = makeSender(true);
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  // Seed a transcript that WOULD satisfy the out-of-turn reader, to prove the
  // accumulator path does not even consult it.
  const reply = await handler.processMessage(makeMessage('hello world'), null);
  const sessionId = runner.startedCalls[0].sessionId;
  coworkStore.appendMessages(sessionId, [
    { id: 'u1', type: 'user', content: 'hello world', timestamp: 1 },
    { id: 'a1', type: 'assistant', content: 'a reply that must not be duplicated', timestamp: 2 },
  ]);
  await flushAsyncWork();

  assert.match(reply, /reply for hello world/);
  assert.equal(sender.calls.length, 0, 'the inbound path must not use the out-of-turn sender');

  handler.destroy();
}));

test('a platform without per-conversation capability degrades to no send without throwing', withHarness(async ({
  coworkStore,
  imStore,
  runner,
}) => {
  const sender = makeSender(false);
  const { handler, sessionId } = await establishImSession(coworkStore, imStore, runner, {
    sendToConversation: sender.sendToConversation,
  });

  coworkStore.appendMessages(sessionId, [
    { id: 'u2', type: 'user', content: '[ORCH-NOTIFY] worker needs review', timestamp: 3 },
    { id: 'a2', type: 'assistant', content: 'reviewing now', timestamp: 4 },
  ]);

  runner.emit('complete', sessionId);
  await flushAsyncWork();

  assert.equal(sender.calls.length, 1, 'the capability check is attempted once');
  // The turn kept working: a later inbound message still resolves normally.
  const reply = await handler.processMessage(makeMessage('still there?'), null);
  assert.match(reply, /continued reply for/);

  handler.destroy();
}));

test('a turn without any assistant message is not forwarded', withHarness(async ({
  coworkStore,
  imStore,
  runner,
}) => {
  const sender = makeSender(true);
  const { handler, sessionId } = await establishImSession(coworkStore, imStore, runner, {
    sendToConversation: sender.sendToConversation,
  });

  coworkStore.appendMessages(sessionId, [
    { id: 'u3', type: 'user', content: '[ORCH-NOTIFY] worker still running', timestamp: 5 },
  ]);

  runner.emit('complete', sessionId);
  await flushAsyncWork();

  assert.equal(sender.calls.length, 0, 'nothing was generated, so nothing may be sent');

  handler.destroy();
}));

test('without a wired conversation sender the turn still completes silently', withHarness(async ({
  coworkStore,
  imStore,
  runner,
}) => {
  const { handler, sessionId } = await establishImSession(coworkStore, imStore, runner, {});

  coworkStore.appendMessages(sessionId, [
    { id: 'u4', type: 'user', content: '[ORCH-NOTIFY] worker done', timestamp: 6 },
    { id: 'a4', type: 'assistant', content: 'noted', timestamp: 7 },
  ]);

  assert.doesNotThrow(() => runner.emit('complete', sessionId));
  await flushAsyncWork();

  const reply = await handler.processMessage(makeMessage('ping'), null);
  assert.match(reply, /continued reply for/);

  handler.destroy();
}));

test('a cowork_ui-origin session never sends its turn to any IM channel', withHarness(async ({
  coworkStore,
  imStore,
  runner,
}) => {
  const sender = makeSender(true);
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  // A desktop-origin session that no IM conversation ever pointed at. Routing
  // must follow the session's own origin channel, not "a gateway is connected".
  const session = coworkStore.createSession(
    'Desktop task',
    os.tmpdir(),
    '',
    'local',
    [],
    null,
    'standard',
    null,
    null,
  );
  coworkStore.appendMessages(session.id, [
    { id: 'du1', type: 'user', content: 'do something on the desktop', timestamp: 8 },
    { id: 'da1', type: 'assistant', content: 'desktop-only answer', timestamp: 9 },
  ]);

  assert.doesNotThrow(() => runner.emit('complete', session.id));
  await flushAsyncWork();

  assert.deepEqual(
    coworkStore.getConversationSourceContextBySession(session.id),
    { sourceChannel: 'cowork_ui', externalConversationId: session.id },
  );
  assert.equal(sender.calls.length, 0, 'a cowork_ui-origin turn must never reach an IM channel');

  handler.destroy();
}));

test('a stale in-memory IM marker cannot override a cowork_ui origin', withHarness(async ({
  coworkStore,
  imStore,
  runner,
}) => {
  const sender = makeSender(true);
  const { handler, sessionId } = await establishImSession(coworkStore, imStore, runner, {
    sendToConversation: sender.sendToConversation,
  });

  // Force the persisted origin back to cowork_ui: the session is still in the
  // in-memory imSessionIds set, but routing must follow the stored channel.
  coworkStore.setSourceContext(sessionId, {
    sourceChannel: 'cowork_ui',
    externalConversationId: sessionId,
  });
  coworkStore.appendMessages(sessionId, [
    { id: 'su1', type: 'user', content: '[ORCH-NOTIFY] worker done', timestamp: 10 },
    { id: 'sa1', type: 'assistant', content: 'this must stay on the desktop', timestamp: 11 },
  ]);

  assert.doesNotThrow(() => runner.emit('complete', sessionId));
  await flushAsyncWork();

  assert.equal(sender.calls.length, 0, 'the origin channel, not the in-memory IM set, decides routing');

  handler.destroy();
}));

test('ensureDirectConversationSession creates the channel chat session with the normal IM title and both mappings', async () => {
  const workspace = makeWorkspace();
  const coworkStore = makeMockCoworkStore(workspace);
  const imStore = makeMockImStore();
  const handler = new IMCoworkHandler({
    coworkRunner: new MockCoworkRunner(),
    coworkStore,
    imStore,
  });

  // This is the path IMGatewayManager takes when a proactive send has no
  // mapping for the chat yet: the record still needs a real IM chat session.
  const sessionId = await handler.ensureDirectConversationSession('weixin', 'wx-owner-42', 7);
  assert.ok(sessionId, 'a session is created instead of dropping the record');

  const session = coworkStore.getSession(sessionId);
  assert.equal(session.title, 'WeChat · 私聊', 'the owner-facing IM session naming is reused');
  assert.equal(session.metabotId, 7);

  const canonical = coworkStore.getConversationMapping('im:weixin:direct', 'wx-owner-42', 7);
  assert.equal(canonical?.coworkSessionId, sessionId, 'the canonical mapping key resolves to it');
  assert.equal(
    imStore.getSessionMapping('wx-owner-42', 'weixin')?.coworkSessionId,
    sessionId,
    'the legacy per-platform mapping is kept in sync'
  );

  // The next lookup (or an inbound message) must reuse it, never fork a second
  // session for the same chat.
  const again = await handler.ensureDirectConversationSession('weixin', 'wx-owner-42', 7);
  assert.equal(again, sessionId);
  assert.equal(coworkStore.sessions.size, 1);

  handler.destroy();
});
