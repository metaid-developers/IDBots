/**
 * Channel-level IM turn-budget defaults.
 *
 * Motivation (2026-11-04, owner's real WeChat channel): main.log 10:13–10:17
 * shows two consecutive turns cut at exactly 120 s while the bot was still
 * producing — the generic IM default was the thing deciding a WeChat turn's
 * wall clock. The partial-result behaviour (708fe79ab) already returns what a
 * timed-out turn produced; this file pins the OTHER half of the fix: the
 * budget itself is layered per channel.
 *
 * Contract under test (`IMCoworkHandler.resolveTurnTimeout`, precedence top to
 * bottom):
 *
 *   | # | cell                     | configured turnTimeoutMs | platform | expected budget |
 *   |---|--------------------------|--------------------------|----------|-----------------|
 *   | 1 | WeChat channel default   | unset                    | weixin   | 600 s           |
 *   | 2 | every other channel      | unset                    | telegram | 120 s           |
 *   | 3 | explicit setting wins    | 240 s                    | weixin   | 240 s           |
 *   | 4 | explicit low clamp       | 2 s                      | weixin   | 10 s (MIN)      |
 *   | 5 | explicit high clamp      | 2 h                      | weixin   | 1800 s (MAX)    |
 *
 * Each cell is proven behaviourally, not by reading a private number: with
 * node:test mock timers the turn must still be open one millisecond before the
 * expected budget and must settle exactly on it, and the timeout reply must
 * name the same seconds figure. A wrong budget cannot pass both halves.
 *
 * The generic constant must NOT move: DEFAULT_IM_TURN_TIMEOUT_MS stays 120 s;
 * WeChat gets its own default (DEFAULT_WEIXIN_IM_TURN_TIMEOUT_MS = 600 s).
 *
 * Timers are mocked, so no test waits real minutes.
 * Run: npm run compile:electron && node --test tests/imWeixinChannelTurnTimeout.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const { IMCoworkHandler } = await import('../dist-electron/main/im/imCoworkHandler.js');
const {
  DEFAULT_IM_TURN_TIMEOUT_MS,
  DEFAULT_WEIXIN_IM_TURN_TIMEOUT_MS,
  MIN_IM_TURN_TIMEOUT_MS,
  MAX_IM_TURN_TIMEOUT_MS,
} = await import('../dist-electron/main/im/types.js');

const WEIXIN_DEFAULT_TURN_TIMEOUT_MS = 600_000;
const OTHER_CHANNEL_DEFAULT_TURN_TIMEOUT_MS = 120_000;
const MIN_TURN_TIMEOUT_MS = 10_000;
const MAX_TURN_TIMEOUT_MS = 30 * 60_000;

const CONVERSATION_ID = 'wx-channel-budget-1';
const SENDER_ID = 'wx-owner-channel-budget';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-im-channel-timeout-'));
}

/** Minimal CoworkStore double: sessions + conversation mappings, nothing else. */
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
    createSession(title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) {
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
        sessionType: 'im',
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
 * Minimal IMStore double. `turnTimeoutMs` is mutable and left unset unless a
 * cell explicitly configures it — the two default cells must see "no config".
 */
function makeMockImStore() {
  const sessionMappings = new Map();
  const key = (conversationId, platform) => `${platform}::${conversationId}`;
  const state = { settings: { skillsEnabled: false } };

  return {
    state,
    setTurnTimeoutMs(value) {
      state.settings.turnTimeoutMs = value;
    },
    getIMSettings() {
      return { ...state.settings };
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

/**
 * A runner whose turn never finishes on its own, so the handler's own budget
 * is the only thing that can settle the reply.
 */
class MockCoworkRunner extends EventEmitter {
  constructor() {
    super();
    this.activeSessions = new Set();
    this.startedCalls = [];
    this.stoppedSessions = [];
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

  hasTextPermissionRelay() {
    return false;
  }

  async startSession(sessionId, content, options) {
    this.startedCalls.push({ sessionId, content, options });
    this.activeSessions.add(sessionId);
  }

  async continueSession(sessionId, content, options) {
    this.startedCalls.push({ sessionId, content, options });
  }

  stopSession(sessionId, options) {
    this.activeSessions.delete(sessionId);
    this.stoppedSessions.push({ sessionId, options });
  }
}

function makeMessage(platform, content) {
  return {
    platform,
    conversationId: CONVERSATION_ID,
    chatType: 'direct',
    senderId: SENDER_ID,
    senderName: 'Owner',
    content,
    attachments: [],
  };
}

function makeHandler(workspace) {
  const coworkStore = makeMockCoworkStore(workspace);
  const imStore = makeMockImStore();
  const coworkRunner = new MockCoworkRunner();
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

/**
 * Drive one turn and prove its budget is exactly `expectedMs`:
 *  - still open at expectedMs - 1,
 *  - settled exactly at expectedMs,
 *  - resolves (never rejects) and the reply names expectedMs / 1000 seconds.
 */
async function assertTurnBudget(t, { platform, turnTimeoutMs, expectedMs, label }) {
  const workspace = makeWorkspace();
  try {
    const { handler, coworkRunner, imStore } = makeHandler(workspace);
    if (turnTimeoutMs !== undefined) {
      imStore.setTurnTimeoutMs(turnTimeoutMs);
    }

    const outcome = observe(handler.processMessage(makeMessage(platform, label), null));
    await waitFor(() => coworkRunner.startedCalls.length === 1, `${label}: turn start`);

    t.mock.timers.tick(expectedMs - 1);
    await flushMicrotasks();
    assert.equal(
      outcome.settled,
      false,
      `${label}: the turn must still be open at ${expectedMs - 1} ms (budget is ${expectedMs} ms)`,
    );

    t.mock.timers.tick(1);
    await waitFor(() => outcome.settled, `${label}: timeout resolution`);

    assert.equal(outcome.error, undefined, `${label}: a timed-out turn must RESOLVE, never reject`);
    assert.equal(typeof outcome.value, 'string');
    assert.match(
      outcome.value,
      new RegExp(String(expectedMs / 1000)),
      `${label}: the reply must name the ${expectedMs / 1000} s limit it hit`,
    );
    assert.equal(coworkRunner.stoppedSessions.length, 1, `${label}: the abandoned turn must be stopped once`);
    return outcome.value;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('cell 1 — WeChat with no configuration gets the 600 s channel default', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Turn must outlive the old generic 120 s mark: a regression to the flat
    // default would settle there instead of at 600 s.
    const workspace = makeWorkspace();
    try {
      const { handler, coworkRunner } = makeHandler(workspace);
      const outcome = observe(handler.processMessage(makeMessage('weixin', '微信默认预算'), null));
      await waitFor(() => coworkRunner.startedCalls.length === 1, 'weixin default: turn start');
      t.mock.timers.tick(OTHER_CHANNEL_DEFAULT_TURN_TIMEOUT_MS);
      await flushMicrotasks();
      assert.equal(
        outcome.settled,
        false,
        'weixin: the channel default must outlast the generic 120 s budget',
      );
      t.mock.timers.tick(WEIXIN_DEFAULT_TURN_TIMEOUT_MS - OTHER_CHANNEL_DEFAULT_TURN_TIMEOUT_MS - 1);
      await flushMicrotasks();
      assert.equal(outcome.settled, false, 'weixin: still open one millisecond before 600 s');
      t.mock.timers.tick(1);
      await waitFor(() => outcome.settled, 'weixin default: timeout');
      assert.equal(outcome.error, undefined);
      assert.match(outcome.value, /600/, 'weixin: the reply must name the 600 s channel default');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  } finally {
    t.mock.timers.reset();
  }
});

test('cell 2 — a non-WeChat channel with no configuration keeps the 120 s default', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assertTurnBudget(t, {
      platform: 'telegram',
      turnTimeoutMs: undefined,
      expectedMs: OTHER_CHANNEL_DEFAULT_TURN_TIMEOUT_MS,
      label: 'telegram 默认预算',
    });
  } finally {
    t.mock.timers.reset();
  }
});

test('cell 3 — an explicit turnTimeoutMs outranks the WeChat channel default', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const reply = await assertTurnBudget(t, {
      platform: 'weixin',
      turnTimeoutMs: 240_000,
      expectedMs: 240_000,
      label: '微信显式预算',
    });
    assert.doesNotMatch(reply, /600/, 'the explicit 240 s setting must not fall back to the 600 s default');
  } finally {
    t.mock.timers.reset();
  }
});

test('cell 4 — an explicit value below the floor is raised to MIN (10 s)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assertTurnBudget(t, {
      platform: 'weixin',
      turnTimeoutMs: 2_000,
      expectedMs: MIN_TURN_TIMEOUT_MS,
      label: '微信显式夹底',
    });
  } finally {
    t.mock.timers.reset();
  }
});

test('cell 5 — an explicit value above the ceiling is clamped to MAX (30 min)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const reply = await assertTurnBudget(t, {
      platform: 'weixin',
      turnTimeoutMs: 2 * 60 * 60_000,
      expectedMs: MAX_TURN_TIMEOUT_MS,
      label: '微信显式封顶',
    });
    assert.doesNotMatch(reply, /7200/, 'a two-hour value must be clamped, not honoured');
  } finally {
    t.mock.timers.reset();
  }
});

test('the generic default constant stays 120 s; WeChat gets its own 600 s default', () => {
  // pin the exported contract, not a re-implementation detail
  assert.equal(DEFAULT_IM_TURN_TIMEOUT_MS, 120_000, 'DEFAULT_IM_TURN_TIMEOUT_MS must stay 120 s');
  assert.equal(
    DEFAULT_WEIXIN_IM_TURN_TIMEOUT_MS,
    600_000,
    'the WeChat channel default must be 600 s',
  );
  assert.equal(MIN_IM_TURN_TIMEOUT_MS, 10_000);
  assert.equal(MAX_IM_TURN_TIMEOUT_MS, 1_800_000);
});
