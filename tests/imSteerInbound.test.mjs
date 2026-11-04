/**
 * IM interjection (steer) tests — 「微信里发第二条只能排队 / 被顶掉」.
 *
 * Real-device evidence (2026-11-04 ~/Library/Logs/IDBots/main.log):
 *   - 06:57:43.228 处理消息 "用户发送了图片 1 张" isActive=true
 *     → [error] Cannot continue session 668c878f-…: active local turn is still running.
 *   - 06:57:46.922 处理消息 "你看一下这个图的内容" isActive=true
 *     → [error] Cannot continue session 668c878f-…: active local turn is still running.
 *   i.e. the interjection was REJECTED (and answered with 处理消息时出错), not
 *   queued — the running turn's accumulator had already been replaced.
 *
 * What this file pins down:
 *  1. a second direct-chat message that arrives while the turn runs is STEERED
 *     into that turn (one transcript, one reply) instead of opening a second
 *     turn or rejecting the running turn;
 *  2. 收到 1 / 收到 2 / 收到 3 stay one continuous context (steer order kept);
 *  3. a pending permission request is NOT clobbered by an interjection, and
 *     「允许」 still resolves the request (permission regression);
 *  4. group chats keep the legacy behaviour (no steer);
 *  5. degradation is explicit: a closed steer window falls back to the next
 *     turn's input instead of erroring or silently queueing.
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
const CONVERSATION_ID = 'wx-owner-steer-1';
const SENDER_ID = 'wx-owner-steer-1';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-im-steer-'));
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
    messagesBySession,
    getConfig() {
      return { workingDirectory, systemPrompt: '' };
    },
    getSession(id) {
      return sessions.get(id) ?? null;
    },
    createSession(
      title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId,
      sessionType, peerGlobalMetaId, peerName,
    ) {
      sessionCounter += 1;
      const id = `session-${sessionCounter}`;
      const session = {
        id, title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId,
        sessionType, peerGlobalMetaId, peerName, claudeSessionId: null, status: 'idle',
      };
      sessions.set(id, session);
      messagesBySession.set(id, []);
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
    getConversationMapping(channel, externalConversationId, metabotId) {
      return conversationMappings.get(mappingKey(channel, externalConversationId, metabotId)) ?? null;
    },
    upsertConversationMapping({ channel, externalConversationId, metabotId, coworkSessionId }) {
      conversationMappings.set(
        mappingKey(channel, externalConversationId, metabotId),
        { channel, externalConversationId, metabotId: metabotId ?? null, coworkSessionId },
      );
      const current = sourceContextBySession.get(coworkSessionId);
      if (channel.startsWith('im:') || !current) {
        sourceContextBySession.set(coworkSessionId, {
          sourceChannel: channel,
          externalConversationId,
        });
      }
    },
    touchConversationMapping() { /* no-op for test */ },
    deleteConversationMapping(channel, externalConversationId, metabotId) {
      conversationMappings.delete(mappingKey(channel, externalConversationId, metabotId));
    },
    addMessage(sessionId, message) {
      const list = messagesBySession.get(sessionId) ?? [];
      const stored = {
        id: `msg-${list.length + 1}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp: Date.now(),
        ...message,
      };
      list.push(stored);
      messagesBySession.set(sessionId, list);
      return stored;
    },
    updateMessage(sessionId, messageId, updates) {
      const list = messagesBySession.get(sessionId) ?? [];
      const found = list.find((entry) => entry.id === messageId);
      if (!found) return;
      if (updates.content !== undefined) found.content = updates.content;
      if (updates.metadata !== undefined) found.metadata = updates.metadata;
    },
    getSessionMessagesPage() {
      return { messages: [], hasMoreBefore: false, beforeSequence: null, beforeTranscriptCursor: null };
    },
  };
}

function makeMockImStore() {
  const sessionMappings = new Map();
  const key = (conversationId, platform) => `${platform}::${conversationId}`;
  const settings = { skillsEnabled: false };

  return {
    getIMSettings() {
      return settings;
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
    updateSessionLastActive() { /* no-op for test */ },
    deleteSessionMapping(conversationId, platform) {
      sessionMappings.delete(key(conversationId, platform));
    },
  };
}

/**
 * Mirrors the real runner where it matters for this defect:
 *  - startSession/continueSession persist the user message (as the real one does);
 *  - getSteerCapability reflects the live turn;
 *  - trySubmitSteer is the desktop steer admission path.
 */
class MockCoworkRunner extends EventEmitter {
  constructor({ steerCapability = 'open-local', steerDelivery = 'accept' } = {}) {
    super();
    this.activeSessions = new Set();
    this.startedCalls = [];
    this.continuedCalls = [];
    this.steerCalls = [];
    this.settlementWaits = [];
    this.pendingRequests = new Map();
    this.steerCapability = steerCapability;
    this.steerDelivery = steerDelivery;
    this.settlementReply = '收到 1';
    /** A kernel-initiated turn: busy, but no host turn object to steer. */
    this.kernelBusy = false;
    this.kernelInterrupts = [];
    this.store = null;
  }

  attachStore(store) {
    this.store = store;
  }

  isSessionActive(sessionId) {
    return this.kernelBusy || this.activeSessions.has(sessionId);
  }

  getSteerCapability() {
    if (this.kernelBusy) return 'inactive';
    return this.activeSessions.size > 0 ? this.steerCapability : 'inactive';
  }

  interruptKernelTurnForHumanInput(sessionId) {
    this.kernelInterrupts.push(sessionId);
    this.kernelBusy = false;
    return Promise.resolve(true);
  }

  trySubmitSteer(sessionId, submissionId, text) {
    this.steerCalls.push({ sessionId, submissionId, text });
    if (this.steerDelivery === 'fail') {
      return { accepted: true, delivered: Promise.reject(new Error('steer window closed')) };
    }
    return { accepted: true, delivered: Promise.resolve() };
  }

  /**
   * Mirrors the real runner: the returned promise settles when the live turn
   * has ENDED (its accumulator resolves first, via `complete`). A test turn is
   * ended by emitting the settlement reply here.
   */
  waitForActiveTurnSettlement(sessionId) {
    this.settlementWaits.push(sessionId);
    if (!this.activeSessions.has(sessionId)) return Promise.resolve();
    this.completeTurn(sessionId, this.settlementReply);
    return Promise.resolve();
  }

  isPermissionPending(requestId) {
    return this.pendingRequests.has(requestId);
  }

  registerTextPermissionRelay() { /* no-op for test */ }

  unregisterTextPermissionRelay() { /* no-op for test */ }

  respondToPermission(requestId, result) {
    const sessionId = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    this.responded = this.responded ?? [];
    this.responded.push({ requestId, result });
    this.emit('permissionResolved', sessionId ?? '', requestId);
  }

  requestPermission(sessionId, request) {
    this.pendingRequests.set(request.requestId, sessionId);
    this.emit('permissionRequest', sessionId, request);
  }

  completeTurn(sessionId, text) {
    this.store?.addMessage(sessionId, {
      type: 'assistant',
      content: text,
      metadata: {},
    });
    this.activeSessions.delete(sessionId);
    this.emit('message', sessionId, {
      id: `assistant-${sessionId}-${Date.now()}`,
      type: 'assistant',
      content: text,
      metadata: {},
    });
    this.emit('complete', sessionId);
  }

  async startSession(sessionId, content) {
    this.startedCalls.push({ sessionId, content });
    this.store?.addMessage(sessionId, { type: 'user', content, metadata: {} });
    this.activeSessions.add(sessionId);
  }

  async continueSession(sessionId, content, options) {
    this.continuedCalls.push({ sessionId, content, options });
    if (!options?.skipUserMessage) {
      this.store?.addMessage(sessionId, { type: 'user', content, metadata: {} });
    }
    this.activeSessions.add(sessionId);
  }

  stopSession(sessionId) {
    this.activeSessions.delete(sessionId);
  }
}

function makeMessage(content, overrides = {}) {
  return {
    platform: PLATFORM,
    conversationId: CONVERSATION_ID,
    chatType: 'direct',
    senderId: SENDER_ID,
    content,
    attachments: [],
    ...overrides,
  };
}

const flushAsyncWork = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met: ${label}`);
}

function withHarness(fn, runnerOptions = {}) {
  return async () => {
    const workspace = makeWorkspace();
    try {
      const coworkStore = makeMockCoworkStore(workspace);
      const imStore = makeMockImStore();
      const runner = new MockCoworkRunner(runnerOptions);
      runner.attachStore(coworkStore);
      const handler = new IMCoworkHandler({
        coworkRunner: runner,
        coworkStore,
        imStore,
        // Short seams so a leaked accumulator/watchdog timer cannot keep the
        // test process alive for the production 60 s/120 s windows.
        timeout: 3000,
        permissionConfirmTimeoutMs: 3000,
      });
      await fn({ coworkStore, imStore, runner, handler, workspace });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };
}

function transcript(coworkStore, sessionId) {
  return (coworkStore.messagesBySession.get(sessionId) ?? []).map((m) => [m.type, m.content]);
}

// ---------------------------------------------------------------------------
// 1. The core defect: an interjection during a running turn
// ---------------------------------------------------------------------------

test('a second direct-chat message during a running turn is steered into it, not rejected', withHarness(async ({
  coworkStore, runner, handler,
}) => {
  const firstOutcomes = [];
  const first = handler.processMessage(makeMessage('收到 1'), null).then(
    (value) => firstOutcomes.push(['resolved', value]),
    (error) => firstOutcomes.push(['rejected', error.message]),
  );
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');

  // The turn is still running: exactly the real-device 06:57:43 / 06:57:46 state.
  assert.equal(runner.isSessionActive(sessionId), true);

  const second = handler.processMessage(makeMessage('收到 2'), null);
  await flushAsyncWork();

  // Steered: one steer admission, no second turn, no accumulator replacement.
  assert.deepEqual(runner.steerCalls.map((call) => call.text), ['收到 2']);
  assert.equal(runner.continuedCalls.length, 0, 'a steer must not open a second turn');
  assert.deepEqual(firstOutcomes, [], 'the running turn must not be resolved by the interjection');

  const secondValue = await second;
  assert.equal(secondValue, '', 'a steered message must not open its own reply bubble');

  // The interjection is in the transcript as a normal user message.
  assert.deepEqual(transcript(coworkStore, sessionId), [
    ['user', '收到 1'],
    ['user', '收到 2'],
  ]);
  const steered = coworkStore.messagesBySession.get(sessionId)[1];
  assert.equal(steered.metadata?.interactionKind, 'steer');
  assert.equal(steered.metadata?.submissionMode, 'steer');
  assert.equal(steered.metadata?.steerStatus, 'delivered');

  // One turn, one reply — the reply answers both messages.
  runner.completeTurn(sessionId, '收到 1、收到 2');
  await first;

  assert.deepEqual(firstOutcomes, [['resolved', '收到 1、收到 2']]);
  assert.equal(await second, '');
}));

test('收到 1 / 收到 2 / 收到 3 stay one continuous context inside a single turn', withHarness(async ({
  coworkStore, runner, handler,
}) => {
  const first = handler.processMessage(makeMessage('收到 1'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');

  const second = handler.processMessage(makeMessage('收到 2'), null);
  const third = handler.processMessage(makeMessage('收到 3'), null);
  await flushAsyncWork();

  assert.deepEqual(runner.steerCalls.map((call) => call.text), ['收到 2', '收到 3']);
  assert.deepEqual(runner.steerCalls.map((call) => call.sessionId), [sessionId, sessionId]);
  assert.equal(runner.continuedCalls.length, 0);
  assert.equal(runner.startedCalls.length, 1, 'all three messages belong to ONE turn');

  assert.deepEqual(transcript(coworkStore, sessionId), [
    ['user', '收到 1'],
    ['user', '收到 2'],
    ['user', '收到 3'],
  ]);

  runner.completeTurn(sessionId, '收到 1、收到 2、收到 3');
  assert.equal(await first, '收到 1、收到 2、收到 3');
  assert.equal(await second, '');
  assert.equal(await third, '');
}));

// ---------------------------------------------------------------------------
// 2. Permission regression: an interjection must not clobber 待批准
// ---------------------------------------------------------------------------

test('a pending approval is never barged past: chat waits, the approval still resolves', withHarness(async ({
  coworkStore, runner, handler,
}) => {
  const first = handler.processMessage(makeMessage('帮我改一段代码'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');

  // The turn blocks on a tool approval; the prompt IS the first reply.
  runner.requestPermission(sessionId, {
    requestId: 'req-steer-bash',
    toolName: 'Bash',
    toolInput: { command: 'ls -la' },
  });
  const prompt = await first;
  assert.match(String(prompt), /允许|confirmation/i);

  // A chat message while the approval is pending is answered with the
  // reminder, NOT steered and NOT allowed to clear the pending state — the
  // permission gate owns the conversation until it is answered.
  const interjection = await handler.processMessage(makeMessage('顺便说一下，先别删文件'), null);
  assert.match(String(interjection), /待确认|确认|允许|confirmation|pending/i);
  assert.equal(runner.steerCalls.length, 0, 'an interjection never bypasses a pending approval');
  assert.equal(runner.isPermissionPending('req-steer-bash'), true, 'the pending approval survives');
  assert.equal((coworkStore.messagesBySession.get(sessionId) ?? []).filter((m) => m.content === '顺便说一下，先别删文件').length, 0);

  // The approval itself still lands (the allow reply resolves with the turn,
  // because the ack folds into it when no per-conversation sender is wired).
  const allowReply = handler.processMessage(makeMessage('允许'), null);
  await waitFor(() => (runner.responded?.length ?? 0) > 0, 'tool approved');
  assert.equal(runner.responded[0].requestId, 'req-steer-bash');
  assert.equal(runner.isPermissionPending('req-steer-bash'), false);

  runner.completeTurn(sessionId, '好的，先不删文件');
  assert.match(String(await allowReply), /已允许|Allowed|先不删文件/);
  assert.match(String(await first), /允许|confirmation/i);
}));

// ---------------------------------------------------------------------------
// 3. Group chats keep the existing behaviour
// ---------------------------------------------------------------------------

test('group chats are not steered (unchanged behaviour)', withHarness(async ({
  runner, handler,
}) => {
  const groupMessage = (content) => makeMessage(content, { conversationId: 'wx-group-1', chatType: 'group' });
  const first = handler.processMessage(groupMessage('群里收到 1'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');

  const firstOutcomes = [];
  first.then(
    (value) => firstOutcomes.push(['resolved', value]),
    (error) => firstOutcomes.push(['rejected', error.message]),
  );
  const second = handler.processMessage(groupMessage('群里收到 2'), null);
  await flushAsyncWork();

  assert.equal(runner.steerCalls.length, 0, 'group turns must not steer');
  assert.equal(runner.continuedCalls.length, 1, 'group chats keep the legacy continue path');
  assert.equal(runner.continuedCalls[0].content, '群里收到 2');

  // Unchanged legacy semantics for a group turn that is already running: the
  // newer message owns the accumulator and the older promise is replaced.
  runner.completeTurn(sessionId, '群回复 2');
  assert.equal(await second, '群回复 2');
  assert.deepEqual(firstOutcomes, [['rejected', 'Replaced by a newer IM request']]);
}));

// ---------------------------------------------------------------------------
// 4. Explicit degradation (never a silent queue)
// ---------------------------------------------------------------------------

test('a closed steer window degrades to the next turn input instead of erroring', withHarness(async ({
  coworkStore, runner, handler,
}) => {
  const first = handler.processMessage(makeMessage('收到 1'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');

  const second = handler.processMessage(makeMessage('收到 2'), null);
  await flushAsyncWork();

  assert.equal(runner.steerCalls.length, 1);
  await waitFor(() => runner.settlementWaits.length > 0, 'turn settlement wait');
  await waitFor(() => runner.continuedCalls.length > 0, 'degraded continue');

  assert.equal(runner.continuedCalls[0].content, '收到 2');
  assert.equal(runner.continuedCalls[0].options?.skipUserMessage, true, 'the text is already in the transcript');
  assert.equal(await second, '', 'degradation is silent, the follow-up turn answers');

  const steered = coworkStore.messagesBySession.get(sessionId).find((m) => m.content === '收到 2');
  assert.equal(steered.metadata?.steerStatus, 'failed');
  assert.equal(steered.metadata?.submissionResult, 'failed');

  runner.completeTurn(sessionId, '收到 1');
  assert.equal(await first, '收到 1');
}, { steerDelivery: 'fail' }));

test('a kernel-initiated turn is interrupted so the interjection opens its own turn', withHarness(async ({
  runner, handler,
}) => {
  // Busy session with NO host turn object: the desktop composer interrupts the
  // kernel turn instead of colliding with it; IM must do the same.
  runner.kernelBusy = true;

  const messagePromise = handler.processMessage(makeMessage('收到 1'), null);
  const sessionId = await waitFor(() => runner.kernelInterrupts[0], 'kernel interrupt');

  assert.equal(runner.steerCalls.length, 0, 'a kernel turn has nothing to steer');
  assert.equal(runner.kernelInterrupts[0], sessionId);
  await waitFor(() => runner.continuedCalls.length > 0, 'turn opened after the interrupt');
  assert.equal(runner.continuedCalls[0].content, '收到 1');

  runner.completeTurn(runner.continuedCalls[0].sessionId, '收到 1');
  assert.equal(await messagePromise, '收到 1');
}));

test('a closing turn is waited out at the boundary, then answered as a normal turn', withHarness(async ({
  runner, handler,
}) => {
  const first = handler.processMessage(makeMessage('收到 1'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');

  const second = handler.processMessage(makeMessage('收到 2'), null);
  await waitFor(() => runner.settlementWaits.length > 0, 'boundary wait');
  // The settled turn ends, so the message is admitted as a NORMAL next turn on
  // the same session (isActive is recomputed after the wait).
  await waitFor(() => runner.startedCalls.length >= 2, 'follow-up turn');

  assert.equal(runner.steerCalls.length, 0, 'a closing turn cannot accept a steer');
  assert.equal(runner.startedCalls[1].content, '收到 2');
  assert.equal(await first, '收到 1');

  runner.completeTurn(sessionId, '收到 2');
  assert.equal(await second, '收到 2');
}, { steerCapability: 'closing-local' }));
