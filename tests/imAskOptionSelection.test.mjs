/**
 * AskUserQuestion over IM — numbered options.
 *
 * The defect this pins: IM collapsed every AskUserQuestion into the generic
 * 「允许/拒绝」 confirmation. The owner could approve the QUESTION but had no way
 * to choose an ANSWER — the tool always received a hard-coded option (the label
 * containing 「允许本次操作」, else the first one). On a text channel the only
 * faithful encoding of a choice is its number, so the prompt renders the options
 * numbered and the reply parser maps the number back to the exact label.
 *
 * What this file pins down:
 *  1. numbering is shared and GLOBAL across questions (1..N, never reused), so a
 *     number can only ever mean one (question, option) pair;
 *  2. Arabic, full-width Arabic and Chinese numerals are accepted as a
 *     whole-string reply; ordinary text and negations are NOT option answers;
 *  3. a partial / out-of-range / duplicate numeric reply does NOT resolve the
 *     request — the owner gets what is still missing, nothing is guessed;
 *  4. the picked label is what lands in `updatedInput.answers`;
 *  5. the legacy vocabulary (「允许」, 「拒绝」 and an option literally labelled
 *     「允许本次操作」) behaves exactly as before;
 *  6. a request WITHOUT options produces the byte-identical legacy prompt, and a
 *     bare "1" never resolves a non-ask request.
 *
 * Run: npm run compile:electron && node --test tests/imAskOptionSelection.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const { IMCoworkHandler } = await import('../dist-electron/main/im/imCoworkHandler.js');
const {
  collectImAskOptions,
  firstNumberPerQuestion,
  optionQuestionIndexes,
  parseImAskOptionReply,
  parseImNumeralToken,
} = await import('../dist-electron/main/im/imAskOptions.js');

const PLATFORM = 'weixin';
const CONVERSATION_ID = 'wx-ask-options-1';
const SENDER_ID = 'wx-owner-ask-options-1';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-im-ask-options-'));
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

class MockCoworkRunner extends EventEmitter {
  constructor() {
    super();
    this.activeSessions = new Set();
    this.startedCalls = [];
    this.continuedCalls = [];
    this.responded = [];
    this.pendingRequests = new Map();
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
    this.emit('permissionResolved', sessionId ?? '', requestId);
  }

  requestPermission(sessionId, request) {
    this.pendingRequests.set(request.requestId, sessionId);
    this.emit('permissionRequest', sessionId, request);
  }

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
  }
}

function makeMessage(content) {
  return {
    platform: PLATFORM,
    conversationId: CONVERSATION_ID,
    chatType: 'direct',
    senderId: SENDER_ID,
    content,
    attachments: [],
  };
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met: ${label}`);
}

function makeSender(result = true) {
  const calls = [];
  const sendToConversation = async (target, text) => {
    calls.push({ target, text });
    return result;
  };
  return { calls, sendToConversation };
}

/** Start a turn that blocks on the given permission request. */
async function openPermissionTurn({ handler, runner, request, content = '帮我定一下方案' }) {
  const firstTurn = handler.processMessage(makeMessage(content), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  runner.requestPermission(sessionId, request);
  const prompt = await firstTurn;
  return { sessionId, prompt };
}

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

/** A fresh runner/store/handler per case, for tests that loop over replies. */
async function withFreshHandler(run) {
  const workspace = makeWorkspace();
  const coworkStore = makeMockCoworkStore(workspace);
  const imStore = makeMockImStore();
  const runner = new MockCoworkRunner();
  const sender = makeSender(true);
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });
  try {
    await run({ handler, runner, sender });
  } finally {
    handler.destroy();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// tApp() renders zh or en depending on the host locale, which is 'en' under a
// bare node test run. Tests detect it from a rendered prompt rather than
// assuming one language.
const isChinese = (text) => /需要安全确认的操作/.test(String(text));

const PLAN_QUESTION = '用哪种方案？';
const DEPLOY_QUESTION = '是否现在部署？';

const ONE_QUESTION = {
  requestId: 'req-ask-plan',
  toolName: 'AskUserQuestion',
  toolInput: {
    questions: [{
      question: PLAN_QUESTION,
      header: '方案',
      options: [
        { label: '方案 A', description: '最快，风险高' },
        { label: '方案 B' },
      ],
    }],
  },
};

const TWO_QUESTIONS = {
  requestId: 'req-ask-two',
  toolName: 'AskUserQuestion',
  toolInput: {
    questions: [
      { question: PLAN_QUESTION, options: [{ label: '方案 A' }, { label: '方案 B' }] },
      { question: DEPLOY_QUESTION, options: [{ label: '现在部署' }, { label: '稍后部署' }] },
    ],
  },
};

const LEGACY_APPROVAL_ASK = {
  requestId: 'req-ask-safety',
  toolName: 'AskUserQuestion',
  toolInput: {
    questions: [{
      question: '确认删除 build/ 目录？',
      options: [
        { label: '允许本次操作', description: '仅允许当前这一次操作。' },
        { label: '拒绝本次操作', description: '拒绝当前操作。' },
      ],
    }],
  },
};

const NO_OPTIONS_ASK = {
  requestId: 'req-ask-free-text',
  toolName: 'AskUserQuestion',
  toolInput: { questions: [{ question: '项目代号叫什么？', options: [] }] },
};

const BASH_REQUEST = {
  requestId: 'req-bash-options-1',
  toolName: 'Bash',
  toolInput: { command: 'ls -la' },
};

// ---------------------------------------------------------------------------
// Numbering + parsing (pure module)
// ---------------------------------------------------------------------------

test('numbering is global across questions: a number never belongs to two questions', () => {
  const options = collectImAskOptions(TWO_QUESTIONS.toolInput);
  assert.deepEqual(
    options.map((option) => ({
      number: option.number,
      questionIndex: option.questionIndex,
      optionIndex: option.optionIndex,
      label: option.label,
    })),
    [
      { number: 1, questionIndex: 0, optionIndex: 0, label: '方案 A' },
      { number: 2, questionIndex: 0, optionIndex: 1, label: '方案 B' },
      { number: 3, questionIndex: 1, optionIndex: 0, label: '现在部署' },
      { number: 4, questionIndex: 1, optionIndex: 1, label: '稍后部署' },
    ],
  );
  assert.deepEqual(optionQuestionIndexes(options), [0, 1]);
  assert.equal(new Set(options.map((option) => option.number)).size, options.length,
    'every number is unique across the whole request');
});

test('the reply example comes from the real numbering, not a hard-coded pair', () => {
  const options = collectImAskOptions({
    questions: [
      { question: '第一个问题', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
      { question: '第二个问题', options: [{ label: 'd' }, { label: 'e' }] },
    ],
  });
  assert.deepEqual(firstNumberPerQuestion(options), [1, 4],
    'question 1 owns 1–3, so the example for question 2 is 4 — "1 3" would hit one question twice');
});

test('numbering skips what a number cannot honestly address', () => {
  const options = collectImAskOptions({
    questions: [
      { question: '', options: [{ label: 'no question text' }] },
      { question: '无选项的问题', options: [] },
      { question: '截断载荷', options: ['[truncated-depth]', { label: '' }] },
      // Bare-string options are accepted (the desktop wizard accepts them too).
      { question: '继续吗？', options: ['继续', { label: '停止', description: '保留现状' }] },
    ],
  });
  assert.deepEqual(options.map((option) => [option.number, option.questionIndex, option.label]), [
    [1, 3, '继续'],
    [2, 3, '停止'],
  ]);
  assert.equal(options[1].description, '保留现状');
});

test('numerals: Arabic, full-width, and Chinese 一…九十九', () => {
  for (const [token, value] of [
    ['1', 1], ['12', 12], ['99', 99],
    ['一', 1], ['九', 9], ['十', 10], ['十一', 11], ['十九', 19],
    ['二十', 20], ['二十一', 21], ['九十九', 99],
  ]) {
    assert.equal(parseImNumeralToken(token), value, `${token} must be ${value}`);
  }
  for (const invalid of ['0', '00', '100', '01', '零', '〇', '十十', '二十一三', '第一个', 'a', '']) {
    assert.equal(parseImNumeralToken(invalid), null, `${invalid} must not be a numeral`);
  }
});

test('a whole-string number answers the question it belongs to', () => {
  const options = collectImAskOptions(ONE_QUESTION.toolInput);
  for (const reply of ['1', '一', '１', ' 1。']) {
    const parsed = parseImAskOptionReply(reply, options);
    assert.equal(parsed.kind, 'selected', `${reply} must be a selection`);
    assert.equal(parsed.byQuestion.get(0).label, '方案 A');
  }
  const second = parseImAskOptionReply('2', options);
  assert.equal(second.kind, 'selected');
  assert.equal(second.byQuestion.get(0).label, '方案 B');
});

test('multi-question replies carry one globally numbered pick per question', () => {
  const options = collectImAskOptions(TWO_QUESTIONS.toolInput);
  for (const reply of ['1 4', '1,4', '1，4', '1、4', '一 四']) {
    const parsed = parseImAskOptionReply(reply, options);
    assert.equal(parsed.kind, 'selected', `${reply} must select both questions`);
    assert.equal(parsed.byQuestion.get(0).label, '方案 A');
    assert.equal(parsed.byQuestion.get(1).label, '稍后部署');
  }
});

test('numeric replies that cannot resolve the ask are classified, never guessed', () => {
  const options = collectImAskOptions(TWO_QUESTIONS.toolInput);
  assert.deepEqual(parseImAskOptionReply('1', options), {
    kind: 'incomplete', numbers: [1], missingQuestionIndexes: [1],
  });
  assert.deepEqual(parseImAskOptionReply('9', options), {
    kind: 'invalid', numbers: [9], reason: 'out-of-range',
  });
  assert.deepEqual(parseImAskOptionReply('1 1', options), {
    kind: 'invalid', numbers: [1, 1], reason: 'duplicate-question',
  });
  assert.deepEqual(parseImAskOptionReply('1 2', options), {
    kind: 'invalid', numbers: [1, 2], reason: 'duplicate-question',
  });
  // Not option answers at all: ordinary chat, negations, label text, long text.
  for (const reply of ['', '第一个', '允许', '拒绝', '选 1', '方案 A', '1 和 2']) {
    assert.equal(parseImAskOptionReply(reply, options).kind, 'none', `${reply} must not be a selection`);
  }
});

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

test('the prompt numbers the options and keeps the disclosure lines', withHarness(async ({
  coworkStore, imStore, runner,
}) => {
  const handler = new IMCoworkHandler({ coworkRunner: runner, coworkStore, imStore });
  const { prompt } = await openPermissionTurn({ handler, runner, request: ONE_QUESTION });
  assert.match(prompt, /AskUserQuestion/, 'the tool is still disclosed');
  assert.match(prompt, new RegExp(PLAN_QUESTION), 'the question text is still disclosed');
  assert.match(prompt, /\n {2}1\. 方案 A — 最快，风险高\n/, 'option 1 carries its label and description');
  assert.match(prompt, /\n {2}2\. 方案 B\n/, 'option 2 is numbered');
  assert.match(prompt, /允许|yes/i, 'the legacy allow/deny vocabulary is still offered');
  assert.match(prompt, /(?:\. This request waits|。该请求会一直等待)/,
    'the instruction and the wait clause are separate sentences, never glued together');
  assert.doesNotMatch(prompt, /问题 1|Question 1/, 'a single question is not re-titled after 说明');

  handler.destroy();
}));

test('a multi-question ask prints a heading per question and keeps numbering global', withHarness(async ({
  coworkStore, imStore, runner,
}) => {
  const handler = new IMCoworkHandler({ coworkRunner: runner, coworkStore, imStore });
  const { prompt } = await openPermissionTurn({ handler, runner, request: TWO_QUESTIONS });
  assert.match(prompt, new RegExp(`问题 1: ${PLAN_QUESTION}|Question 1: ${PLAN_QUESTION}`));
  assert.match(prompt, new RegExp(`问题 2: ${DEPLOY_QUESTION}|Question 2: ${DEPLOY_QUESTION}`));
  assert.match(prompt, /\n {2}3\. 现在部署\n/);
  assert.match(prompt, /\n {2}4\. 稍后部署\n/);
  assert.match(prompt, /1 3/, 'the instruction shows the real per-question example');

  handler.destroy();
}));

test('a mixed ask (one free-text question, one with options) still labels its numbers', withHarness(async ({
  coworkStore, imStore, runner,
}) => {
  const handler = new IMCoworkHandler({ coworkRunner: runner, coworkStore, imStore });
  const mixed = {
    requestId: 'req-ask-mixed',
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [
        { question: '项目代号叫什么？', options: [] },
        { question: DEPLOY_QUESTION, options: [{ label: '现在部署' }, { label: '稍后部署' }] },
      ],
    },
  };
  const { prompt } = await openPermissionTurn({ handler, runner, request: mixed });

  // The 说明 line shows question 1; without the heading, "1." would look like
  // an answer to it.
  assert.match(prompt, new RegExp(`问题 2: ${DEPLOY_QUESTION}|Question 2: ${DEPLOY_QUESTION}`));
  assert.match(prompt, /\n {2}1\. 现在部署\n/);
  assert.doesNotMatch(prompt, /每个问题|one number per question/,
    'only one question can be answered by number');
  assert.match(prompt, /请回复序号|option number/i);

  handler.destroy();
}));

test('a question WITHOUT options keeps the legacy prompt byte for byte', withHarness(async ({
  coworkStore, imStore, runner,
}) => {
  const handler = new IMCoworkHandler({ coworkRunner: runner, coworkStore, imStore });
  const { prompt } = await openPermissionTurn({ handler, runner, request: NO_OPTIONS_ASK });

  const legacy = isChinese(prompt)
    ? `检测到需要安全确认的操作（工具: AskUserQuestion）。\n说明: 项目代号叫什么？\n请回复“允许”或“拒绝”。该请求会一直等待，直到你回复。`
    : `A safety confirmation is required (tool: AskUserQuestion).\nDetails: 项目代号叫什么？\nReply with "yes" or "no". This request waits until you answer.`;
  assert.equal(prompt, legacy);

  handler.destroy();
}));

// ---------------------------------------------------------------------------
// Reply handling
// ---------------------------------------------------------------------------

test('a numeric reply answers with the chosen label and acks the chat', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { sessionId, prompt } = await openPermissionTurn({ handler, runner, request: ONE_QUESTION });
  assert.match(prompt, /1\. 方案 A/);
  assert.equal(runner.responded.length, 0, 'nothing is answered before the owner replies');

  const answer = handler.processMessage(makeMessage('2'), null);
  const ack = await waitFor(() => sender.calls[0], 'selection ack');
  assert.match(ack.text, /方案 B/, 'the chat names the option that was handed to the tool');

  assert.equal(runner.responded.length, 1);
  const result = runner.responded[0].result;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput.answers, { [PLAN_QUESTION]: '方案 B' });

  runner.completeTurn(sessionId, '已按方案 B 继续。');
  assert.match(await answer, /方案 B/);

  handler.destroy();
}));

test('Chinese numerals and full-width digits answer the same way', async () => {
  for (const [reply, expected] of [['一', '方案 A'], ['１', '方案 A'], ['二', '方案 B']]) {
    await withFreshHandler(async ({ handler, runner }) => {
      const { sessionId, prompt } = await openPermissionTurn({ handler, runner, request: ONE_QUESTION });
      assert.match(prompt, /1\. 方案 A/);

      const answer = handler.processMessage(makeMessage(reply), null);
      await waitFor(() => runner.responded.length === 1, `selection via ${reply}`);
      assert.deepEqual(
        runner.responded[0].result.updatedInput.answers,
        { [PLAN_QUESTION]: expected },
        `${reply} must select ${expected}`,
      );
      runner.completeTurn(sessionId, '继续。');
      await answer;
    });
  }
});

test('two questions answered in one reply: each number lands on its own question', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { sessionId, prompt } = await openPermissionTurn({ handler, runner, request: TWO_QUESTIONS });
  assert.match(prompt, /问题 2|Question 2/);

  const answer = handler.processMessage(makeMessage('1 4'), null);
  await waitFor(() => runner.responded.length === 1, 'multi-question selection');
  assert.deepEqual(runner.responded[0].result.updatedInput.answers, {
    [PLAN_QUESTION]: '方案 A',
    [DEPLOY_QUESTION]: '稍后部署',
  });
  const ack = await waitFor(() => sender.calls[0], 'selection ack');
  assert.match(ack.text, /方案 A/);
  assert.match(ack.text, /稍后部署/);

  runner.completeTurn(sessionId, '好，按方案 A 稍后部署。');
  await answer;
  handler.destroy();
}));

test('a partial numeric reply resolves nothing and says what is still missing', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { prompt } = await openPermissionTurn({ handler, runner, request: TWO_QUESTIONS });
  assert.match(prompt, /问题 2|Question 2/);

  const hint = await handler.processMessage(makeMessage('1'), null);
  assert.match(hint, /还有问题没有选择|still unanswered/);
  assert.match(hint, /问题 2|question 2/, 'the hint names the unanswered question');
  assert.match(hint, /3|4/, 'the hint lists the numbers that question still offers');
  assert.equal(runner.responded.length, 0, 'a partial answer must not resolve the request');
  assert.equal(sender.calls.length, 0, 'nothing was acknowledged as an answer');

  // The request is still live: the completing reply goes through.
  const answer = handler.processMessage(makeMessage('1 4'), null);
  await waitFor(() => runner.responded.length === 1, 'completing selection');
  assert.deepEqual(runner.responded[0].result.updatedInput.answers, {
    [PLAN_QUESTION]: '方案 A',
    [DEPLOY_QUESTION]: '稍后部署',
  });
  runner.completeTurn(runner.startedCalls[0].sessionId, '继续。');
  await answer;

  handler.destroy();
}));

test('an out-of-range number is answered with the valid range, request stays pending', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { prompt } = await openPermissionTurn({ handler, runner, request: ONE_QUESTION });
  assert.match(prompt, /1\. 方案 A/);

  const hint = await handler.processMessage(makeMessage('9'), null);
  assert.match(hint, /超出范围|out of range/);
  assert.match(hint, /1.*2/, 'the range is stated');
  assert.equal(runner.responded.length, 0);

  handler.destroy();
}));

test('the legacy 允许 vocabulary still approves exactly as before', async () => {
  for (const reply of ['允许', '允许本次操作']) {
    await withFreshHandler(async ({ handler, runner }) => {
      const { sessionId, prompt } = await openPermissionTurn({ handler, runner, request: LEGACY_APPROVAL_ASK });
      assert.match(prompt, /1\. 允许本次操作/, 'the legacy safety options are numbered too');

      const answer = handler.processMessage(makeMessage(reply), null);
      await waitFor(() => runner.responded.length === 1, `allow via ${reply}`);
      assert.equal(runner.responded[0].result.behavior, 'allow');
      assert.deepEqual(runner.responded[0].result.updatedInput.answers, {
        '确认删除 build/ 目录？': '允许本次操作',
      }, `${reply} must keep picking the 允许本次操作 option`);
      runner.completeTurn(sessionId, '继续。');
      await answer;
    });
  }
});

test('a numeric pick of the legacy safety question approves via its label', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { sessionId, prompt } = await openPermissionTurn({ handler, runner, request: LEGACY_APPROVAL_ASK });
  assert.match(prompt, /1\. 允许本次操作/);
  assert.match(prompt, /2\. 拒绝本次操作/);

  const answer = handler.processMessage(makeMessage('1'), null);
  await waitFor(() => runner.responded.length === 1, 'safety option 1');
  assert.deepEqual(runner.responded[0].result.updatedInput.answers, {
    '确认删除 build/ 目录？': '允许本次操作',
  });
  runner.completeTurn(sessionId, '已删除。');
  await answer;
  handler.destroy();
}));

test('拒绝 still denies an option-bearing ask', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const { prompt } = await openPermissionTurn({ handler, runner, request: ONE_QUESTION });
  assert.match(prompt, /1\. 方案 A/);

  await handler.processMessage(makeMessage('拒绝'), null);
  await waitFor(() => runner.responded.length === 1, 'deny');
  assert.equal(runner.responded[0].result.behavior, 'deny');
  assert.match(sender.calls[0].text, /已拒绝|Denied/);

  handler.destroy();
}));

test('a bare "1" never approves a non-ask request', async () => {
  await withFreshHandler(async ({ handler, runner }) => {
    const { prompt } = await openPermissionTurn({ handler, runner, request: BASH_REQUEST });
    assert.match(prompt, /允许|confirmation/i);
    const reply = await handler.processMessage(makeMessage('1'), null);
    assert.match(reply, /允许|yes/i, 'the reply is treated as a non-answer reminder');
    assert.equal(runner.responded.length, 0, 'a number never approves a Bash request');
  });
});

test('a bare "1" is not an answer to an ask with no options', async () => {
  await withFreshHandler(async ({ handler, runner }) => {
    const { prompt } = await openPermissionTurn({ handler, runner, request: NO_OPTIONS_ASK });
    assert.doesNotMatch(prompt, /\n {2}1\. /, 'no option list is rendered');
    const reply = await handler.processMessage(makeMessage('1'), null);
    assert.match(reply, /允许|yes/i);
    assert.equal(runner.responded.length, 0, 'a number is not an answer without options');
  });
});

test('a bare "1" with no pending request is ordinary chat text', withHarness(async ({
  coworkStore, imStore, runner, sender,
}) => {
  const handler = new IMCoworkHandler({
    coworkRunner: runner,
    coworkStore,
    imStore,
    sendToConversation: sender.sendToConversation,
  });

  const first = handler.processMessage(makeMessage('你好'), null);
  const sessionId = await waitFor(() => runner.startedCalls[0]?.sessionId, 'session start');
  runner.completeTurn(sessionId, '在。');
  await first;

  const turn = handler.processMessage(makeMessage('1'), null);
  const continuation = await waitFor(() => runner.continuedCalls[0], 'continuation');
  assert.equal(continuation.content, '1', 'the number reaches the model verbatim');
  assert.equal(runner.responded.length, 0, 'no permission was answered');
  runner.completeTurn(sessionId, '收到。');
  await turn;

  handler.destroy();
}));
