/**
 * IM permission reply tests — the "微信里回允许没反应" real-device defect.
 *
 * Real-device evidence (2026-11-04, ~/Library/Logs/IDBots/main.log):
 *   - 03:56:33 a 231-char permission prompt was sent to WeChat;
 *   - 03:57:02 / 03:57:11 / 03:57:16 three inbound replies each produced the
 *     EXACT 29-char reminder "当前有待确认操作，请回复“允许”或“拒绝”（60 秒内）。"
 *     and NO "[IMCoworkHandler] 处理消息" line — i.e. consumed by the pending
 *     path and not recognised as an answer;
 *   - 04:01:38 the owner: "微信通道我回复允许的时候你并没有任何反应，你懂我意思吗，
 *     还是我手动电脑端点这个按钮的".
 *
 * What this file pins down:
 *  1. pending → 「我允许了」→ tool approved + ack in the chat + turn continues;
 *  2. pending → 「拒绝」→ denied + ack;
 *  3. pending → resolved on the desktop / timed out → explicit status, never a
 *     silent new turn;
 *  4. a standalone 「允许」with NO pending request is ordinary chat text;
 *  5. channel-level auto-allow: default OFF; when ON only the explicit regular
 *     allowlist skips the prompt — wallet/delete/publish/outbound/shell still do;
 *  6. <channel_capabilities> carries one line describing the current mode.
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
const {
  classifyImPermissionReply,
  classifyStrongImPermissionReply,
  resolveImPermissionMode,
  resolveSessionDisplayPermissionMode,
  imPlatformFromSessionChannel,
  describeImPermissionMode,
} = await import('../dist-electron/main/im/imPermissionPolicy.js');
const { buildChannelCapabilitiesBlock } = await import('../dist-electron/main/libs/experiencePromptBlocks.js');
const { shouldSkipToolApproval } = await import('../dist-electron/main/libs/toolApprovalPolicy.js');

const PLATFORM = 'weixin';
const CONVERSATION_ID = 'wx-owner-perm-1';
const SENDER_ID = 'wx-owner-perm-1';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-im-permission-'));
}

function makeMockCoworkStore(workingDirectory) {
  const sessions = new Map();
  const conversationMappings = new Map();
  const sourceContextBySession = new Map();
  let sessionCounter = 0;

  const mappingKey = (channel, externalConversationId, metabotId) =>
    `${channel}::${externalConversationId}::${metabotId ?? 'null'}`;

  return {
    sessions,
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
    getSessionMessagesPage() {
      return { messages: [], hasMoreBefore: false, beforeSequence: null, beforeTranscriptCursor: null };
    },
  };
}

function makeMockImStore() {
  const sessionMappings = new Map();
  const key = (conversationId, platform) => `${platform}::${conversationId}`;
  let settings = { skillsEnabled: false };

  return {
    getIMSettings() {
      return settings;
    },
    setSettings(next) {
      settings = next;
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

class MockCoworkRunner extends EventEmitter {
  constructor() {
    super();
    this.activeSessions = new Set();
    this.startedCalls = [];
    this.continuedCalls = [];
    this.responded = [];
    this.pendingRequests = new Map();
    this.stopped = [];
  }

  isSessionActive(sessionId) {
    return this.activeSessions.has(sessionId);
  }

  isPermissionPending(requestId) {
    return this.pendingRequests.has(requestId);
  }

  registerTextPermissionRelay() { /* no-op for test */ }

  unregisterTextPermissionRelay() { /* no-op for test */ }

  respondToPermission(requestId, result) {
    this.responded.push({ requestId, result });
    const sessionId = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    // The real runner emits permissionResolved from waitForPermissionResponse's
    // finalize(); mirror it so the handler's own resolution is exercised too.
    this.emit('permissionResolved', sessionId ?? '', requestId);
  }

  /** Raise a tool approval request on a live turn. */
  requestPermission(sessionId, request) {
    this.pendingRequests.set(request.requestId, sessionId);
    this.emit('permissionRequest', sessionId, request);
  }

  /** Finish the current turn with one assistant message. */
  completeTurn(sessionId, text) {
    this.emit('message', sessionId, {
      id: `msg-${sessionId}-${Date.now()}`,
      type: 'assistant',
      content: text,
      metadata: {},
    });
    this.emit('complete', sessionId);
  }

  async startSession(sessionId, content, options) {
    this.startedCalls.push({ sessionId, content, options });
    this.activeSessions.add(sessionId);
  }

  async continueSession(sessionId, content, options) {
    this.continuedCalls.push({ sessionId, content, options });
    this.activeSessions.add(sessionId);
  }

  stopSession(sessionId) {
    this.activeSessions.delete(sessionId);
    this.stopped.push(sessionId);
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

const flushAsyncWork = async (rounds = 4) => {
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

// tApp() renders zh or en depending on the host locale, which is 'en' under a
// bare node test run. Assertions therefore accept either rendering.
const isPermissionPrompt = (text) => /允许|confirmation/i.test(String(text));
const isAllowAck = (text) => /已允许|Allowed/i.test(String(text));
const isDenyAck = (text) => /已拒绝|Denied/i.test(String(text));
const isAlreadyEnded = (text) => /已经结束|already ended/i.test(String(text));
const isTimedOut = (text) => /已超时|timed out/i.test(String(text));

function makeSender(result = true) {
  const calls = [];
  const sendToConversation = async (target, text) => {
    calls.push({ target, text });
    return result;
  };
  return { calls, sendToConversation };
}

/**
 * Start a turn that blocks on a permission request: the handler's reply for the
 * first message IS the permission prompt (that is how the prompt reaches the
 * chat), and the turn stays open until the test completes it.
 */
async function openPermissionTurn({ handler, runner, sender, request, content = '帮我改一段代码' }) {
  const firstTurn = handler.processMessage(makeMessage(content), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  runner.requestPermission(sessionId, request);
  const prompt = await firstTurn;
  return { sessionId, prompt };
}

const BASH_REQUEST = {
  requestId: 'req-bash-1',
  toolName: 'Bash',
  toolInput: { command: 'ls -la' },
};

function withHarness(fn) {
  return async () => {
    const workspace = makeWorkspace();
    try {
      const coworkStore = makeMockCoworkStore(workspace);
      const imStore = makeMockImStore();
      const runner = new MockCoworkRunner();
      const sender = makeSender(true);
      await fn({ coworkStore, imStore, runner, sender, workspace });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Reply vocabulary + tool classification (pure policy)
// ---------------------------------------------------------------------------

test('permission answers: explicit vocabulary, whole-string only, length bound', () => {
  for (const allow of ['允许', '允许。', '我允许了', '允许了', '同意', '可以', '好的', 'yes', 'OK']) {
    assert.equal(classifyImPermissionReply(allow), 'allow', `${allow} must be an allow answer`);
  }
  for (const deny of ['拒绝', '我拒绝', '不同意', '不要', '不行', '取消', 'no', '不批准']) {
    assert.equal(classifyImPermissionReply(deny), 'deny', `${deny} must be a deny answer`);
  }
  // NOT answers: substring traps, questions, long instructions.
  // The strict classifier is narrower: conversational acknowledgements are not
  // permission words once the request is already dead.
  for (const strongOnly of ['好', '可以', 'ok', '行']) {
    assert.equal(classifyStrongImPermissionReply(strongOnly), null, `${strongOnly} must not be a late answer`);
  }
  assert.equal(classifyStrongImPermissionReply('我允许了'), 'allow');
  assert.equal(classifyStrongImPermissionReply('拒绝'), 'deny');

  for (const notAnswer of ['你好', '你好呀', '为什么不可以', '允许吗？这是为什么', '帮我允许一下这个操作然后继续跑测试']) {
    assert.equal(classifyImPermissionReply(notAnswer), null, `${notAnswer} must not be an answer`);
  }
  assert.equal(classifyImPermissionReply(''), null);
});

test('permission mode: inherit by default, override wins, unknown falls back to default', () => {
  // Global wins when the channel inherits (absent / 'inherit' / garbage).
  assert.equal(resolveImPermissionMode(undefined, 'bypassPermissions'), 'bypassPermissions');
  assert.equal(resolveImPermissionMode('inherit', 'bypassPermissions'), 'bypassPermissions');
  assert.equal(resolveImPermissionMode('nonsense', 'acceptEdits'), 'acceptEdits');
  // Per-channel override wins over the global mode.
  assert.equal(resolveImPermissionMode('default', 'bypassPermissions'), 'default');
  assert.equal(resolveImPermissionMode('bypassPermissions', 'default'), 'bypassPermissions');
  assert.equal(resolveImPermissionMode('plan', 'plan'), 'plan');
  // Unknown global mode reads as default (never as trust).
  assert.equal(resolveImPermissionMode(undefined, undefined), 'default');
  assert.equal(resolveImPermissionMode(undefined, 'whatever'), 'default');

  // The prompt-facing description names the mode the turn really runs under.
  assert.match(describeImPermissionMode('bypassPermissions'), /零弹窗/);
  assert.match(describeImPermissionMode('bypassPermissions'), /完全信任/);
  assert.match(describeImPermissionMode('default'), /需人工批准/);
  assert.match(describeImPermissionMode('plan'), /只读/);

  // acceptEdits is NOT edit-only. The predicate skips approval for every tool
  // (toolApprovalPolicy.ts:35) and the DSH policy asks only in `default`, so
  // this sentence is read by the model as fact. Pin the true statement AND
  // forbid the old "other tools still ask" claim: a weak /acceptEdits/ match
  // let that lie ship with the suite green.
  const acceptEditsText = describeImPermissionMode('acceptEdits');
  assert.match(acceptEditsText, /acceptEdits/);
  assert.match(acceptEditsText, /同样自动放行/, 'the text must say other tools are auto-allowed too');
  assert.match(acceptEditsText, /与电脑端一致/, 'the text must state it matches the desktop mode');
  assert.doesNotMatch(
    acceptEditsText,
    /其它工具仍会|其他工具仍会|仍会在这里问|仍会询问|其它工具.*询问/,
    'acceptEdits must not claim that other tools are still gated'
  );
});

test('session display: an IM row frozen at default shows the channel/global mode actually in force', () => {
  // Real-device defect 2026-11-04: channel saved bypassPermissions, the session
  // row still held 'default' (written at creation), so the window showed 默认.
  const bypassDisplay = resolveSessionDisplayPermissionMode({
    imChannel: 'im:weixin',
    sessionPermissionMode: 'default',
    channelOverride: 'bypassPermissions',
    globalMode: 'default',
  });
  assert.equal(bypassDisplay, 'bypassPermissions');
  // 展示 == 生效: the per-turn resolver answers the same for the same inputs.
  assert.equal(resolveImPermissionMode('bypassPermissions', 'default'), bypassDisplay);

  // Back to inherit: the display follows the persisted global mode.
  assert.equal(resolveSessionDisplayPermissionMode({
    imChannel: 'im:weixin:direct',
    sessionPermissionMode: 'default',
    channelOverride: 'inherit',
    globalMode: 'acceptEdits',
  }), 'acceptEdits');

  // Channel marker parsing (direct + group both exist in the mapping table).
  assert.equal(imPlatformFromSessionChannel('im:weixin:group'), 'weixin');
  assert.equal(imPlatformFromSessionChannel('im:qq'), 'qq');
  assert.equal(imPlatformFromSessionChannel('cowork_ui'), null);
  assert.equal(imPlatformFromSessionChannel(null), null);

  // Desktop sessions are untouched: no IM channel → keep the row's own value,
  // even when a channel override exists elsewhere.
  assert.equal(resolveSessionDisplayPermissionMode({
    imChannel: 'cowork_ui',
    sessionPermissionMode: 'plan',
    channelOverride: 'bypassPermissions',
    globalMode: 'bypassPermissions',
  }), 'plan');
  assert.equal(resolveSessionDisplayPermissionMode({
    imChannel: null,
    sessionPermissionMode: 'nonsense',
    channelOverride: 'inherit',
    globalMode: 'default',
  }), 'default');
});

test('pending → 「我允许了」approves the tool, acks the chat, and the turn continues', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { sessionId, prompt } = await openPermissionTurn({ handler, runner, sender, request: BASH_REQUEST });
  assert.ok(isPermissionPrompt(prompt), 'the chat must receive a permission prompt');
  assert.equal(runner.responded.length, 0, 'nothing may be approved before the owner answers');

  const answer = handler.processMessage(makeMessage('我允许了'), null);
  const ack = await waitFor(() => sender.calls.length > 0 && sender.calls[0], 'approval ack');
  assert.ok(isAllowAck(ack.text), 'the chat gets an explicit approval ack');
  assert.deepEqual(ack.target, { platform: PLATFORM, conversationId: CONVERSATION_ID });
  assert.equal(runner.responded.length, 1);
  assert.equal(runner.responded[0].requestId, BASH_REQUEST.requestId);
  assert.equal(runner.responded[0].result.behavior, 'allow');

  // The same turn keeps running: its final answer arrives as the reply.
  runner.completeTurn(sessionId, '工具执行完了，结果是 42');
  const finalReply = await answer;
  assert.match(finalReply, /42/);
  assert.equal(runner.responded.length, 1, 'one approval, not a second request');

  handler.destroy();
}));

test('pending → 「拒绝」denies the tool and acks the chat', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { prompt } = await openPermissionTurn({ handler, runner, sender, request: BASH_REQUEST });
  assert.ok(isPermissionPrompt(prompt));

  const reply = await handler.processMessage(makeMessage('拒绝'), null);
  // The ack went out immediately through the conversation sender, so the
  // turn's own reply is empty (the manager never pushes an empty bubble).
  assert.equal(reply, '');
  assert.equal(runner.responded.length, 1);
  assert.equal(runner.responded[0].result.behavior, 'deny');
  assert.equal(sender.calls.length, 1, 'the ack went out through the conversation sender');
  assert.ok(isDenyAck(sender.calls[0].text));

  handler.destroy();
}));

test('pending → resolved on the desktop → 「允许」gets an explicit status, not a silent new turn', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { sessionId } = await openPermissionTurn({ handler, runner, sender, request: BASH_REQUEST });

  // The owner clicks Allow in the desktop overlay: the runner settles it and
  // broadcasts permissionResolved.
  runner.pendingRequests.delete(BASH_REQUEST.requestId);
  runner.emit('permissionResolved', sessionId, BASH_REQUEST.requestId);
  await flushAsyncWork();

  const startsBefore = runner.startedCalls.length;
  const continuedBefore = runner.continuedCalls.length;
  const reply = await handler.processMessage(makeMessage('允许'), null);
  assert.ok(isAlreadyEnded(reply), 'a late answer must state the real outcome');
  assert.equal(runner.startedCalls.length, startsBefore, 'no new turn may start');
  assert.equal(runner.continuedCalls.length, continuedBefore, 'no continuation may start');
  assert.equal(runner.responded.length, 0, 'a dead request must not be answered');

  handler.destroy();
}));

test('after a resolution, a conversational 「好」is still ordinary chat (strict late-answer scope)', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { sessionId } = await openPermissionTurn({ handler, runner, sender, request: BASH_REQUEST });
  runner.pendingRequests.delete(BASH_REQUEST.requestId);
  runner.emit('permissionResolved', sessionId, BASH_REQUEST.requestId);
  await flushAsyncWork();

  const continuedBefore = runner.continuedCalls.length;
  const turn = handler.processMessage(makeMessage('好'), null);
  const carried = await waitFor(() => runner.continuedCalls[continuedBefore], 'continuation');
  assert.equal(carried.content, '好', 'conversational 「好」reaches the model as a normal message');
  runner.completeTurn(sessionId, '收到。');
  await turn;

  handler.destroy();
}));

test('pending → IM watchdog timeout → 「允许」reports the timeout instead of silence', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  // Short confirmation window (test seam): the branch under test is the
  // handler's own 60 s watchdog, not its duration.
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
    permissionConfirmTimeoutMs: 600,
  });
  const { prompt } = await openPermissionTurn({ handler, runner, sender, request: BASH_REQUEST });
  assert.ok(isPermissionPrompt(prompt));

  // Let the handler's watchdog fire: it denies at the runner and records a
  // timeout for the conversation.
  await waitFor(() => runner.responded.length === 1, 'watchdog deny');
  assert.equal(runner.responded[0].result.behavior, 'deny');
  assert.match(String(runner.responded[0].result.message), /timed out/);

  const startsBefore = runner.startedCalls.length;
  const reply = await handler.processMessage(makeMessage('允许'), null);
  assert.ok(isTimedOut(reply), 'a late answer must name the timeout');
  assert.equal(runner.startedCalls.length, startsBefore, 'no new turn may start');
  assert.equal(runner.responded.length, 1, 'the dead request is not answered twice');

  handler.destroy();
}));

test('a non-answer while pending keeps waiting and names the tool (never silent)', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { prompt } = await openPermissionTurn({ handler, runner, sender, request: BASH_REQUEST });
  assert.ok(isPermissionPrompt(prompt));

  const startsBefore = runner.startedCalls.length;
  const continuedBefore = runner.continuedCalls.length;
  const reply = await handler.processMessage(makeMessage('这个到底是在等什么'), null);
  assert.ok(isPermissionPrompt(reply), 'the owner is told a confirmation is still pending');
  assert.match(reply, /Bash/, 'the reminder names the tool that is waiting');
  assert.equal(runner.responded.length, 0, 'a non-answer never resolves the request');
  assert.equal(runner.startedCalls.length, startsBefore, 'no new turn');
  assert.equal(runner.continuedCalls.length, continuedBefore, 'no continuation');
  assert.equal(sender.calls.length, 0, 'nothing was acknowledged as an answer');

  handler.destroy();
}));

test('a standalone 「允许」with no pending request is ordinary chat text', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  // First turn finishes normally.
  const firstTurn = handler.processMessage(makeMessage('你好'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  runner.completeTurn(sessionId, '在，董事长。');
  await firstTurn;

  const reply = handler.processMessage(makeMessage('允许'), null);
  const secondCall = await waitFor(() => runner.continuedCalls[0], 'continuation');
  assert.equal(secondCall.content, '允许', 'the text reaches the model verbatim');
  assert.equal(runner.responded.length, 0, 'no permission was answered');
  runner.completeTurn(sessionId, '好的。');
  await reply;

  handler.destroy();
}));

// ---------------------------------------------------------------------------
// Channel-level pre-grant
// ---------------------------------------------------------------------------

test('IM turn inherits the global mode: 完全信任 on the desktop reaches the runner', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
    getGlobalPermissionMode: () => 'bypassPermissions',
  });

  const turn = handler.processMessage(makeMessage('把这段代码改了'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  assert.equal(runner.startedCalls[0].options.permissionMode, 'bypassPermissions',
    'the IM turn must run in the same mode the desktop uses');
  assert.equal(runner.startedCalls[0].options.confirmationMode, 'text',
    'the confirmation channel is still plain text');

  // A bypass turn produces no permission request; the reply just comes back.
  runner.completeTurn(sessionId, '改好了');
  assert.match(await turn, /改好了/);
  assert.equal(runner.responded.length, 0);

  handler.destroy();
}));

test('a later turn re-reads the global mode: desktop switch applies to the next message', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  let globalMode = 'default';
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
    getGlobalPermissionMode: () => globalMode,
  });

  const first = handler.processMessage(makeMessage('第一条'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  assert.equal(runner.startedCalls[0].options.permissionMode, 'default');
  runner.completeTurn(sessionId, 'ok');
  await first;

  globalMode = 'bypassPermissions';
  const second = handler.processMessage(makeMessage('第二条'), null);
  const continued = await waitFor(() => runner.continuedCalls[0], 'continuation');
  assert.equal(continued.options.permissionMode, 'bypassPermissions');
  runner.completeTurn(sessionId, 'ok2');
  await second;

  handler.destroy();
}));

test('per-channel override beats the global mode', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  imStore.setSettings({
    skillsEnabled: true,
    channelPermissions: { weixinPermissionMode: 'default' },
  });
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
    getGlobalPermissionMode: () => 'bypassPermissions',
  });

  const turn = handler.processMessage(makeMessage('改一下'), null);
  await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  assert.equal(runner.startedCalls[0].options.permissionMode, 'default',
    'the channel override must win over the global mode');
  runner.completeTurn(runner.startedCalls[0].sessionId, '好的');
  await turn;

  handler.destroy();
}));

test('a request that still reaches the handler is never auto-answered, even in full trust', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
    getGlobalPermissionMode: () => 'bypassPermissions',
  });

  // Owner-gated / suspended asks are raised regardless of the mode; they must
  // stay a human decision instead of being swallowed by a channel policy.
  const turn = handler.processMessage(makeMessage('邀请一个好友'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  runner.requestPermission(sessionId, {
    requestId: 'req-suspended-1',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: '允许添加好友？', options: [{ label: '允许本次操作' }] }] },
    timeoutDefault: null,
  });
  const prompt = await turn;
  assert.ok(isPermissionPrompt(prompt), 'the owner is still asked');
  assert.equal(runner.responded.length, 0, 'nothing is auto-approved');

  const answer = handler.processMessage(makeMessage('允许'), null);
  await waitFor(() => runner.responded.length === 1, 'chat answer resolves the request');
  assert.equal(runner.responded[0].result.behavior, 'allow');
  assert.equal(sender.calls.length, 1, 'the ack went out immediately');
  // The turn continues and its own reply closes the accumulator.
  runner.completeTurn(sessionId, '邀请已发送');
  assert.match(await answer, /邀请已发送/);

  handler.destroy();
}));

test('approval gate: 完全信任 raises NO permission request; default still asks', () => {
  // The predicate the DSH approval gate uses to decide whether a request is
  // emitted at all — this is what "no permission request under full trust" means.
  assert.equal(shouldSkipToolApproval({ mode: 'bypassPermissions', toolName: 'Bash' }), true);
  assert.equal(shouldSkipToolApproval({ mode: 'acceptEdits', toolName: 'Bash' }), true);
  assert.equal(shouldSkipToolApproval({ mode: 'default', toolName: 'Bash' }), false);
  assert.equal(shouldSkipToolApproval({ mode: 'plan', toolName: 'Bash' }), false);
  assert.equal(shouldSkipToolApproval({ mode: undefined, toolName: 'Bash' }), false);
  assert.equal(shouldSkipToolApproval({ mode: 'bypassPermissions', toolName: 'wallet_transfer' }), true,
    'full trust is full trust: no tool-specific exception');
  assert.equal(shouldSkipToolApproval({ mode: 'default', toolName: 'Read', autoApprove: true }), true);
  assert.equal(shouldSkipToolApproval({ mode: 'default', toolName: 'Read', autoApproveTools: new Set(['read']) }), true);

  // Static wiring: the gate must be the thing onApprovalRequest consults before
  // emitting, otherwise this predicate could pass while production regressed.
  const runnerSource = fs.readFileSync(
    path.join(process.cwd(), 'src/main/libs/coworkRunner.ts'),
    'utf8',
  );
  const gateIndex = runnerSource.indexOf('onApprovalRequest: (ask) =>');
  assert.ok(gateIndex > 0, 'onApprovalRequest exists');
  const gateBody = runnerSource.slice(gateIndex, gateIndex + 2000);
  assert.match(gateBody, /shouldSkipToolApproval\(/);
  assert.ok(
    gateBody.indexOf('shouldSkipToolApproval(') < gateBody.indexOf("this.emit('permissionRequest'"),
    'the skip gate must be evaluated before the permission request is emitted',
  );
});

test('default mode: a request is raised and the chat answer approves it', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
    getGlobalPermissionMode: () => 'default',
  });

  const turn = handler.processMessage(makeMessage('跑一下测试'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  assert.equal(runner.startedCalls[0].options.permissionMode, 'default');
  // Default mode does raise the request (the runner gate returns false).
  assert.equal(shouldSkipToolApproval({ mode: runner.startedCalls[0].options.permissionMode, toolName: 'Bash' }), false);
  runner.requestPermission(sessionId, BASH_REQUEST);
  const prompt = await turn;
  assert.ok(isPermissionPrompt(prompt));

  const answer = handler.processMessage(makeMessage('允许'), null);
  await waitFor(() => runner.responded.length === 1, 'text approval');
  assert.equal(runner.responded[0].result.behavior, 'allow');
  runner.completeTurn(sessionId, '测试通过');
  assert.match(await answer, /测试通过/);

  handler.destroy();
}));

test('the confirmation prompt discloses a write target outside the workspace', withHarness(async ({
  coworkStore, imStore, runner, sender, workspace,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
    getGlobalPermissionMode: () => 'default',
  });

  const turn = handler.processMessage(makeMessage('改系统文件'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  runner.requestPermission(sessionId, {
    requestId: 'req-outside-1',
    toolName: 'Write',
    toolInput: { file_path: '/etc/hosts' },
  });
  const prompt = await turn;
  assert.match(prompt, /工作区之外|OUTSIDE the session workspace/, 'the owner sees where the write lands');
  assert.match(prompt, /\/etc\/hosts/);

  // Inside the workspace: no such warning.
  runner.pendingRequests.delete('req-outside-1');
  runner.emit('permissionResolved', sessionId, 'req-outside-1');
  runner.completeTurn(sessionId, '好的');

  const insideTurn = handler.processMessage(makeMessage('改工作区内文件'), null);
  await waitFor(() => runner.continuedCalls.length === 1, 'continuation');
  runner.requestPermission(sessionId, {
    requestId: 'req-inside-1',
    toolName: 'Write',
    toolInput: { file_path: path.join(workspace, 'a.md') },
  });
  const insidePrompt = await insideTurn;
  assert.doesNotMatch(insidePrompt, /工作区之外|OUTSIDE the session workspace/);

  handler.destroy();
}));

test('<channel_capabilities> states the permission mode actually in force', () => {
  const bypass = buildChannelCapabilitiesBlock('im:weixin:direct', { permissionMode: 'bypassPermissions' });
  assert.match(bypass, /- 权限模式：完全信任（零弹窗）/);

  const manual = buildChannelCapabilitiesBlock('im:weixin:direct', { permissionMode: 'default' });
  assert.match(manual, /- 权限模式：需人工批准/);

  const edits = buildChannelCapabilitiesBlock('im:weixin:direct', { permissionMode: 'acceptEdits' });
  assert.match(edits, /- 权限模式：自动接受编辑/);

  const plan = buildChannelCapabilitiesBlock('im:weixin:direct', { permissionMode: 'plan' });
  assert.match(plan, /- 权限模式：计划模式/);

  const defaulted = buildChannelCapabilitiesBlock('im:weixin:direct');
  assert.match(defaulted, /- 权限模式：需人工批准/, 'absent options read as default');

  // cowork_ui no longer returns '' — the desktop manifest is mandatory and
  // states "当前没有可用通道" when no IM inventory is supplied.
  assert.match(
    buildChannelCapabilitiesBlock('cowork_ui', { permissionMode: 'bypassPermissions' }),
    /当前没有可用通道/
  );
});
