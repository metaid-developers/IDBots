/**
 * IM turn budget tests — "Request timed out" must not throw the turn away.
 *
 * Real-device evidence (2026-11-04, WeChat channel): the bot had just listed
 * three long-running jobs; the owner's follow-up version question was answered
 * twice with 「处理消息时出错: Request timed out」, the desktop logged
 * 「Turn aborted: IM message accumulation timed out」, and 「继续」 hit the same
 * wall — because the timed-out turn rejected, its already-produced content was
 * dropped, and the retry restarted from zero into the same 120 s limit.
 *
 * What this file pins down:
 *  1. the budget is configurable (IMSettings.turnTimeoutMs) and re-read on every
 *     turn, with invalid values falling back to the CHANNEL default instead of
 *     collapsing to 0: 600 s on WeChat (this file's channel), 120 s on every
 *     other channel (pinned in tests/imWeixinChannelTurnTimeout.test.mjs);
 *  2. a timed-out turn RESOLVES with whatever it had already produced, and that
 *     text travels the gateway's normal reply path (no "处理消息时出错" branch);
 *  3. a timed-out turn with no output still names the seconds limit and tells
 *     the user how to get a clean restart;
 *  4. the timed-out session is stopped, so the next message starts a new turn
 *     instead of colliding with the abandoned one.
 *
 * Timers are mocked (node:test mock.timers), so no test waits real minutes.
 * Run: npm run compile:electron && node --test tests/imCoworkTurnTimeout.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const { IMCoworkHandler } = await import('../dist-electron/main/im/imCoworkHandler.js');

// The public contract under test, spelled as literals on purpose: the test must
// fail against an implementation that ignores the setting, not follow whatever
// constants that implementation happens to export.
const DEFAULT_TURN_TIMEOUT_MS = 120_000;            // every non-WeChat channel
const WEIXIN_DEFAULT_TURN_TIMEOUT_MS = 600_000;     // this file's channel
const MIN_TURN_TIMEOUT_MS = 10_000;
const MAX_TURN_TIMEOUT_MS = 30 * 60_000;

const PLATFORM = 'weixin';
const CONVERSATION_ID = 'wx-turn-budget-1';
const SENDER_ID = 'wx-owner-turn-budget';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-im-turn-timeout-'));
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

/**
 * IMStore double. `settings.turnTimeoutMs` is mutable so a test can change the
 * persisted budget between turns, exactly as a settings edit would.
 */
function makeMockImStore() {
  const sessionMappings = new Map();
  const key = (conversationId, platform) => `${platform}::${conversationId}`;
  const state = {
    settings: { skillsEnabled: false },
    // Reading the field (not the settings object) is what resolveTurnTimeout
    // guards: a persisted config can be malformed, and a getter that throws is
    // the narrowest way to exercise that catch without breaking the earlier
    // settings reads the same turn performs (prompt build, permission mode).
    throwOnTurnTimeoutRead: false,
  };

  return {
    sessionMappings,
    state,
    setTurnTimeoutMs(value) {
      state.settings.turnTimeoutMs = value;
    },
    deleteTurnTimeoutMs() {
      delete state.settings.turnTimeoutMs;
    },
    getIMSettings() {
      const settings = { ...state.settings };
      return Object.defineProperty(settings, 'turnTimeoutMs', {
        enumerable: true,
        get() {
          if (state.throwOnTurnTimeoutRead) {
            throw new Error('mock unreadable turnTimeoutMs');
          }
          return state.settings.turnTimeoutMs;
        },
      });
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
    this.textPermissionRelaySessions = new Set();
    this.startedCalls = [];
    this.continuedCalls = [];
    this.stoppedSessions = [];
    /**
     * false = a turn that never finishes on its own, so the test can inject one
     * assistant message and let the handler's own budget abort the turn.
     */
    this.autoComplete = options.autoComplete ?? true;
    this.replyCounter = 0;
  }

  isSessionActive(sessionId) {
    return this.activeSessions.has(sessionId);
  }

  registerTextPermissionRelay(sessionId) {
    this.textPermissionRelaySessions.add(sessionId);
  }

  unregisterTextPermissionRelay(sessionId) {
    this.textPermissionRelaySessions.delete(sessionId);
  }

  hasTextPermissionRelay(sessionId) {
    return this.textPermissionRelaySessions.has(sessionId);
  }

  /** One assistant row, as CoworkRunner would emit it mid-turn. */
  emitAssistant(sessionId, content) {
    this.replyCounter += 1;
    this.emit('message', sessionId, {
      id: `msg-${sessionId}-${this.replyCounter}`,
      type: 'assistant',
      content,
      metadata: {},
    });
  }

  /** The turn ends normally (and is no longer active). */
  emitComplete(sessionId) {
    this.activeSessions.delete(sessionId);
    this.emit('complete', sessionId);
  }

  async startSession(sessionId, content, options) {
    this.startedCalls.push({ sessionId, content, options });
    this.activeSessions.add(sessionId);
    if (this.autoComplete) {
      queueMicrotask(() => {
        this.emitAssistant(sessionId, `reply for ${content}`);
        this.emitComplete(sessionId);
      });
    }
  }

  async continueSession(sessionId, content, options) {
    this.continuedCalls.push({ sessionId, content, options });
    if (this.autoComplete) {
      queueMicrotask(() => {
        this.emitAssistant(sessionId, `continued reply for ${content}`);
        this.emitComplete(sessionId);
      });
    }
  }

  stopSession(sessionId, options) {
    this.activeSessions.delete(sessionId);
    this.stoppedSessions.push({ sessionId, options });
  }
}

function makeMessage(content) {
  return {
    platform: PLATFORM,
    conversationId: CONVERSATION_ID,
    chatType: 'direct',
    senderId: SENDER_ID,
    senderName: 'Owner',
    content,
    attachments: [],
  };
}

function makeHandler(workspace, runnerOptions = {}) {
  const coworkStore = makeMockCoworkStore(workspace);
  const imStore = makeMockImStore();
  const coworkRunner = new MockCoworkRunner(runnerOptions);
  const handler = new IMCoworkHandler({ coworkRunner, coworkStore, imStore });
  return { handler, coworkRunner, coworkStore, imStore };
}

/** Let pending promise chains (admission, session creation) run to completion. */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * The exact contract of `IMGatewayManager`'s messageHandler:
 *
 *   response = await coworkHandler.processMessage(message, targetMetabotId)
 *   if (!response.trim()) return;
 *   await replyFn(response);
 *   // catch → replyFn(`处理消息时出错: ${error.message}`)
 *
 * Reproducing the branch choice here is what shows WHERE a timed-out turn
 * lands: the reply path (partial answer delivered) or the catch path (bare
 * error). The gateway file itself is not under test — only this contract.
 */
async function runThroughGatewayContract(handler, message) {
  const delivered = [];
  const replyFn = async (text) => {
    delivered.push(text);
  };
  try {
    const response = await handler.processMessage(message, null);
    if (typeof response === 'string' && !response.trim()) {
      return { delivered, error: null };
    }
    await replyFn(response);
    return { delivered, error: null };
  } catch (error) {
    await replyFn(`处理消息时出错: ${error.message}`);
    return { delivered, error };
  }
}

/** A promise's settlement, observed without deciding resolve-vs-reject ourselves. */
function observe(promise) {
  const box = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => {
      box.settled = true;
      box.value = value;
    },
    (error) => {
      box.settled = true;
      box.error = error;
    },
  );
  return box;
}

test('a timed-out turn sends the part it already produced instead of an error', async (t) => {
  const workspace = makeWorkspace();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, coworkRunner } = makeHandler(workspace, { autoComplete: false });

    const pending = runThroughGatewayContract(handler, makeMessage('盘点三件在跑的活'));
    await waitFor(() => coworkRunner.startedCalls.length === 1, 'turn start');
    const sessionId = coworkRunner.startedCalls[0].sessionId;

    // The turn produced one visible assistant row before hitting the budget.
    coworkRunner.emitAssistant(sessionId, '第一件事：PR #132；第二件事：IM 通道。');
    await flushMicrotasks();

    const outcome = observe(pending);
    await flushMicrotasks();
    assert.equal(outcome.settled, false, 'the turn must stay open while work is being produced');

    // Nothing may fire before the whole WeChat channel budget (600 s) is spent
    // — and in particular not at the old generic 120 s default.
    t.mock.timers.tick(DEFAULT_TURN_TIMEOUT_MS);
    await flushMicrotasks();
    assert.equal(
      outcome.settled,
      false,
      'the WeChat channel default must outlast the generic 120 s budget',
    );
    t.mock.timers.tick(WEIXIN_DEFAULT_TURN_TIMEOUT_MS - DEFAULT_TURN_TIMEOUT_MS - 1);
    await flushMicrotasks();
    assert.equal(outcome.settled, false, 'the turn must stay open until its budget is spent');

    t.mock.timers.tick(1);
    await waitFor(() => outcome.settled, 'timeout resolution');

    assert.equal(outcome.error, undefined, 'a timed-out turn must RESOLVE, never reject');
    const delivery = outcome.value;
    assert.equal(delivery.error, null, 'the gateway catch branch must not be taken');
    assert.equal(delivery.delivered.length, 1, 'exactly one reply reaches the user');
    const reply = delivery.delivered[0];
    assert.match(reply, /timed out|已超时/i);
    assert.match(reply, /第一件事：PR #132/, 'partial assistant content must survive');
    assert.match(reply, /600/, 'the reply must name the WeChat default seconds limit');
    assert.doesNotMatch(reply, /^处理消息时出错:/);

    assert.deepEqual(
      coworkRunner.stoppedSessions.map((entry) => entry.sessionId),
      [sessionId],
      'the abandoned turn must be stopped exactly once',
    );
    assert.equal(coworkRunner.stoppedSessions[0].options.reason, 'IM message accumulation timed out');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a timed-out turn with no output names the seconds limit and the next step', async (t) => {
  const workspace = makeWorkspace();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, coworkRunner } = makeHandler(workspace, { autoComplete: false });

    const pending = runThroughGatewayContract(handler, makeMessage('版本号是多少'));
    await waitFor(() => coworkRunner.startedCalls.length === 1, 'turn start');

    t.mock.timers.tick(WEIXIN_DEFAULT_TURN_TIMEOUT_MS);
    const delivery = await pending;

    assert.equal(delivery.error, null);
    assert.equal(delivery.delivered.length, 1);
    const reply = delivery.delivered[0];
    assert.match(reply, /Request timed out/);
    assert.match(reply, /600/, 'the reply must name the WeChat default seconds limit');
    assert.match(
      reply,
      /单独问一件事|one thing at a time/i,
      'the reply must tell the user how to get a clean restart',
    );
  } finally {
    t.mock.timers.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('after a timeout the session is stopped and the next message starts a clean turn', async (t) => {
  const workspace = makeWorkspace();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, coworkRunner } = makeHandler(workspace, { autoComplete: false });

    const firstPending = runThroughGatewayContract(handler, makeMessage('先盘点一下'));
    await waitFor(() => coworkRunner.startedCalls.length === 1, 'first turn start');
    const sessionId = coworkRunner.startedCalls[0].sessionId;
    coworkRunner.emitAssistant(sessionId, '盘点到一半……');

    t.mock.timers.tick(WEIXIN_DEFAULT_TURN_TIMEOUT_MS);
    const firstDelivery = await firstPending;
    assert.equal(firstDelivery.error, null);
    assert.match(firstDelivery.delivered[0], /盘点到一半/);
    assert.equal(coworkRunner.activeSessions.has(sessionId), false, 'the abandoned turn must not stay active');

    // The follow-up message must start a fresh turn, not collide with the dead one.
    coworkRunner.autoComplete = true;
    const secondDelivery = await runThroughGatewayContract(handler, makeMessage('继续'));
    assert.equal(secondDelivery.error, null);
    assert.equal(secondDelivery.delivered.length, 1);
    assert.match(secondDelivery.delivered[0], /reply for 继续/);
    assert.doesNotMatch(secondDelivery.delivered[0], /timed out/i);
    assert.equal(coworkRunner.startedCalls.length, 2, 'the next message opens a new turn');
    assert.equal(coworkRunner.startedCalls[1].sessionId, sessionId, 'same conversation session, fresh turn');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('turnTimeoutMs is re-read every turn: default first, MIN applies to the next message', async (t) => {
  const workspace = makeWorkspace();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, coworkRunner, imStore } = makeHandler(workspace, { autoComplete: false });

    // Turn 1: nothing configured → the WeChat channel default (600 s). The turn
    // must outlive the old generic 120 s budget and stay open to 600 s.
    const first = observe(handler.processMessage(makeMessage('第一轮'), null));
    await waitFor(() => coworkRunner.startedCalls.length === 1, 'first turn start');
    const firstSessionId = coworkRunner.startedCalls[0].sessionId;
    t.mock.timers.tick(DEFAULT_TURN_TIMEOUT_MS);
    await flushMicrotasks();
    assert.equal(first.settled, false, 'the WeChat default must outlast the generic 120 s budget');
    t.mock.timers.tick(WEIXIN_DEFAULT_TURN_TIMEOUT_MS - DEFAULT_TURN_TIMEOUT_MS - 1);
    await flushMicrotasks();
    assert.equal(first.settled, false, 'the default budget must not be shorter than 600 s');

    coworkRunner.emitAssistant(firstSessionId, '第一轮的答案');
    coworkRunner.emitComplete(firstSessionId);
    await waitFor(() => first.settled, 'first turn completion');
    assert.equal(first.error, undefined);
    assert.equal(first.value, '第一轮的答案');

    // Turn 2: the persisted setting changes to the documented minimum; the very
    // next turn must use it without restarting anything.
    imStore.setTurnTimeoutMs(MIN_TURN_TIMEOUT_MS);
    const second = observe(handler.processMessage(makeMessage('第二轮'), null));
    await waitFor(() => coworkRunner.startedCalls.length === 2, 'second turn start');
    t.mock.timers.tick(MIN_TURN_TIMEOUT_MS - 1);
    await flushMicrotasks();
    assert.equal(second.settled, false, 'the configured minimum must be honoured, not undercut');
    t.mock.timers.tick(1);
    await waitFor(() => second.settled, 'second turn timeout');
    assert.equal(second.error, undefined);
    assert.match(second.value, /10/, 'the reply must name the configured 10 s limit');

    // Turn 3: an over-large value is clamped to the documented 30 min ceiling —
    // a two-hour "budget" must not park the chat for two hours.
    imStore.setTurnTimeoutMs(2 * 60 * 60_000);
    const third = observe(handler.processMessage(makeMessage('第三轮'), null));
    await waitFor(() => coworkRunner.startedCalls.length === 3, 'third turn start');
    t.mock.timers.tick(MAX_TURN_TIMEOUT_MS - 1);
    await flushMicrotasks();
    assert.equal(third.settled, false, 'a two-hour value must still be clamped, not honoured');
    t.mock.timers.tick(1);
    await waitFor(() => third.settled, 'third turn timeout');
    assert.equal(third.error, undefined);
    assert.match(third.value, /1800/, 'the reply must name the 30 min ceiling');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('invalid turnTimeoutMs values fall back to the default instead of collapsing to 0', async (t) => {
  const workspace = makeWorkspace();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, coworkRunner, imStore } = makeHandler(workspace, { autoComplete: false });

    const invalidValues = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'abc'];
    for (const invalid of invalidValues) {
      imStore.setTurnTimeoutMs(invalid);
      const before = coworkRunner.startedCalls.length;
      const outcome = observe(handler.processMessage(makeMessage(`非法配置 ${String(invalid)}`), null));
      await waitFor(() => coworkRunner.startedCalls.length === before + 1, 'turn start');

      // If the value were clamped down to MIN (or to 0), the turn would already
      // be dead after 10 s. It must still be alive past the generic 120 s mark
      // and only end at the WeChat channel default (600 s).
      t.mock.timers.tick(MIN_TURN_TIMEOUT_MS);
      await flushMicrotasks();
      assert.equal(
        outcome.settled,
        false,
        `turnTimeoutMs=${String(invalid)} must not shorten the budget to the minimum or to 0`,
      );

      t.mock.timers.tick(DEFAULT_TURN_TIMEOUT_MS - MIN_TURN_TIMEOUT_MS);
      await flushMicrotasks();
      assert.equal(
        outcome.settled,
        false,
        `turnTimeoutMs=${String(invalid)} must fall back to the WeChat channel default, not 120 s`,
      );

      t.mock.timers.tick(WEIXIN_DEFAULT_TURN_TIMEOUT_MS - DEFAULT_TURN_TIMEOUT_MS);
      await waitFor(() => outcome.settled, `timeout for invalid value ${String(invalid)}`);
      assert.equal(outcome.error, undefined, 'invalid config must still resolve, never reject');
      assert.match(outcome.value, /600/, 'the fallback must be the WeChat channel default (600 s)');
    }

    // A settings read that throws is the same contract: channel default, no crash.
    imStore.state.throwOnTurnTimeoutRead = true;
    const beforeThrow = coworkRunner.startedCalls.length;
    const thrown = observe(handler.processMessage(makeMessage('读配置抛异常'), null));
    await waitFor(() => coworkRunner.startedCalls.length === beforeThrow + 1, 'turn start after throw');
    t.mock.timers.tick(MIN_TURN_TIMEOUT_MS);
    await flushMicrotasks();
    assert.equal(thrown.settled, false, 'a failing settings read must fall back to the channel default budget');
    t.mock.timers.tick(WEIXIN_DEFAULT_TURN_TIMEOUT_MS - MIN_TURN_TIMEOUT_MS);
    await waitFor(() => thrown.settled, 'timeout after failing settings read');
    assert.equal(thrown.error, undefined);
    assert.match(thrown.value, /600/);
  } finally {
    t.mock.timers.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a completed turn with no assistant output keeps the original empty-turn fallback', async (t) => {
  const workspace = makeWorkspace();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { handler, coworkRunner } = makeHandler(workspace, { autoComplete: false });

    const pending = handler.processMessage(makeMessage('空回合'), null);
    await waitFor(() => coworkRunner.startedCalls.length === 1, 'turn start');
    const sessionId = coworkRunner.startedCalls[0].sessionId;

    // Complete with zero assistant rows: the accumulator's own fallback must
    // survive the new `fallback` parameter (formatReply default unchanged).
    coworkRunner.emitComplete(sessionId);
    await expectResolved(pending, '处理完成，但没有生成回复。');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

async function expectResolved(promise, expected) {
  const value = await promise;
  assert.equal(value, expected);
}
