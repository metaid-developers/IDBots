import test from 'node:test';
import assert from 'node:assert/strict';

let runSkillTurnInExistingSession;
let extractFinalAssistantReply;
try {
  ({
    runSkillTurnInExistingSession,
    extractFinalAssistantReply,
  } = await import('../dist-electron/main/services/orchestratorCoworkBridge.js'));
} catch {
  ({
    runSkillTurnInExistingSession,
    extractFinalAssistantReply,
  } = await import('../dist-electron/main/services/orchestratorCoworkBridge.js'));
}

/**
 * Skill wait-notice cancellation contract (2026-11-20 23:53 incident): the
 * notice pipeline (LLM ack generation + chain broadcast) runs concurrently
 * with the skill turn and can outlive a fast turn. The bridge must flip the
 * cancellation flag the moment the turn settles (complete), errors or stops,
 * so the daemon drops a not-yet-broadcast notice instead of trailing the
 * turn's outcome with a "wait for my answer" promise. A notice already past
 * its broadcast keeps its notice-before-reply chain order via the join.
 */

const SESSION_ID = 'session-wait-notice-cancel-1';
const REPLY_TEXT = '更正已递。回你三处：①紧迫度认账 ②充值闸 ③读数必带时刻';

function createFakeRunner() {
  const handlers = new Map();
  const emit = (name, ...args) => {
    for (const handler of [...(handlers.get(name) ?? [])]) handler(...args);
  };
  return {
    runner: {
      on(name, handler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      off(name, handler) {
        const list = handlers.get(name) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      },
      async startSession() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        emit('message', SESSION_ID, { type: 'tool_use' });
      },
    },
    emit,
  };
}

function createFakeStore() {
  return {
    getSession: (sid) => (sid === SESSION_ID
      ? {
        id: SESSION_ID,
        sessionType: 'a2a',
        messages: [{ id: 'm1', type: 'assistant', content: REPLY_TEXT, metadata: {} }],
      }
      : null),
    updateSession() {},
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('wait notice is cancelled when the turn completes before the notice settles', async () => {
  const { runner, emit } = createFakeRunner();
  const store = createFakeStore();
  let capturedControls = null;
  let resolveNotice;
  const noticePromise = new Promise((resolve) => { resolveNotice = resolve; });

  const bridgePromise = runSkillTurnInExistingSession(runner, store, {
    sessionId: SESSION_ID,
    systemPrompt: '',
    userMessage: 'peer message',
    cwd: '/tmp/wait-notice-cancel',
    activeSkillIds: ['metaid-master-wiki'],
    onSkillExecutionStart: (controls) => {
      capturedControls = controls;
      return noticePromise;
    },
  });

  await sleep(60);
  assert.ok(capturedControls, 'the notice callback must receive cancellation controls');
  assert.equal(capturedControls.cancelRequested, false, 'a running turn must not cancel its notice');

  emit('complete', SESSION_ID);
  await sleep(20);
  assert.equal(
    capturedControls.cancelRequested,
    true,
    'the turn settling must cancel the not-yet-broadcast notice',
  );

  resolveNotice();
  const result = await bridgePromise;
  assert.equal(result.replyText, REPLY_TEXT);
});

test('wait notice already settled before the turn completes keeps the reply flowing', async () => {
  const { runner, emit } = createFakeRunner();
  const store = createFakeStore();
  let capturedControls = null;
  let resolveNotice;
  const noticePromise = new Promise((resolve) => { resolveNotice = resolve; });

  const bridgePromise = runSkillTurnInExistingSession(runner, store, {
    sessionId: SESSION_ID,
    systemPrompt: '',
    userMessage: 'peer message',
    cwd: '/tmp/wait-notice-cancel',
    activeSkillIds: ['metaid-master-wiki'],
    onSkillExecutionStart: (controls) => {
      capturedControls = controls;
      return noticePromise;
    },
  });

  await sleep(60);
  resolveNotice();
  await sleep(20);
  assert.equal(capturedControls.cancelRequested, false, 'cancellation only happens at settle time');

  emit('complete', SESSION_ID);
  const result = await bridgePromise;
  assert.equal(result.replyText, REPLY_TEXT);
  assert.equal(capturedControls.cancelRequested, true);
});

test('a turn error cancels the pending notice and rejects the bridge promise', async () => {
  const { runner, emit } = createFakeRunner();
  const store = createFakeStore();
  let capturedControls = null;
  const noticePromise = new Promise((resolve) => { setTimeout(() => resolve(), 500); });

  const bridgePromise = runSkillTurnInExistingSession(runner, store, {
    sessionId: SESSION_ID,
    systemPrompt: '',
    userMessage: 'peer message',
    cwd: '/tmp/wait-notice-cancel',
    activeSkillIds: ['metaid-master-wiki'],
    onSkillExecutionStart: (controls) => {
      capturedControls = controls;
      return noticePromise;
    },
  });

  await sleep(60);
  emit('error', SESSION_ID, 'model exploded');
  await assert.rejects(bridgePromise, /model exploded/);
  assert.equal(capturedControls.cancelRequested, true, 'a failed turn must cancel its stale notice');
});

test('a stopped turn cancels the pending notice', async () => {
  const { runner, emit } = createFakeRunner();
  const store = createFakeStore();
  let capturedControls = null;
  const noticePromise = new Promise((resolve) => { setTimeout(() => resolve(), 500); });

  const bridgePromise = runSkillTurnInExistingSession(runner, store, {
    sessionId: SESSION_ID,
    systemPrompt: '',
    userMessage: 'peer message',
    cwd: '/tmp/wait-notice-cancel',
    activeSkillIds: ['metaid-master-wiki'],
    onSkillExecutionStart: (controls) => {
      capturedControls = controls;
      return noticePromise;
    },
  });

  await sleep(60);
  emit('stopped', SESSION_ID, 'owner stop');
  await assert.rejects(bridgePromise, /stopped/);
  assert.equal(capturedControls.cancelRequested, true);
});

test('extractFinalAssistantReply skips the wait-notice retraction row', () => {
  const messages = [
    { id: 'm0', type: 'assistant', content: 'intermediate', metadata: {} },
    { id: 'm1', type: 'tool_use', content: '', metadata: {} },
    { id: 'm2', type: 'tool_result', content: '', metadata: {} },
    { id: 'm3', type: 'assistant', content: '更正已递。回你三处', metadata: { isFinal: true } },
    {
      id: 'm4',
      type: 'assistant',
      content: '补充说明：刚才那条「稍后回复」不用专门等了。',
      metadata: { privateChatWaitNoticeRetraction: true, privateChatDeliveryStatus: 'sent' },
    },
  ];
  const extracted = extractFinalAssistantReply(messages);
  assert.equal(extracted.replyText, '更正已递。回你三处');
  assert.equal(extracted.assistantMessageId, 'm3');
});
