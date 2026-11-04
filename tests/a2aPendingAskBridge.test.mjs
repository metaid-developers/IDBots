// A2A / OpenTeam bridge turns must not drop owner questions.
//
// Regression coverage for the silent-loss class this task fixes:
//   - a structured ask_user_question raised inside a bridge turn (A2A private
//     chat, OpenTeam guest, group-task worker, Twin delegation) used to be
//     answered by the orchestrator text relay with an invisible transcript
//     prompt and a 60s auto-deny — the model saw "the user declined" and the
//     owner was never asked;
//   - with the relay fixed, the question stays pending on the EXISTING
//     AskUserQuestion card, and pendingOwnerAskBridge pushes one desktop
//     notification for unattended turns (no second dialog system);
//   - when the skill-turn watchdog settles while the question is still open,
//     the owner gets an explicit "timed out, still answerable" notice instead
//     of the question vanishing.
//
// The bridge itself is driven with an EventEmitter runner (the same harness
// style as orchestratorCoworkBridgeWrapUp.test.mjs) so the emit → answer →
// resume chain is deterministic.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runSkillTurnInExistingSession,
  SkillTurnTimeoutError,
} = require('../dist-electron/main/services/orchestratorCoworkBridge.js');
const {
  installOwnerAskBridge,
  hasPendingOwnerAsk,
  noteOwnerAskCancelled,
} = require('../dist-electron/main/services/pendingOwnerAskBridge.js');
const {
  createOwnerAskNotifier,
} = require('../dist-electron/main/services/ownerAskNotifier.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SESSION_ID = 'a2a-session-1';

function makeHarness({ language = 'zh' } = {}) {
  const runner = new EventEmitter();
  const notifications = [];
  const responses = [];
  const session = {
    id: SESSION_ID,
    messages: [],
    // Auto-origin is irrelevant for A2A; keep it undefined so the runner's
    // follow-up marker path is a no-op in this harness.
  };
  const store = {
    getAppLanguage() { return language; },
    getSession(sessionId) {
      return sessionId === SESSION_ID ? { ...session, messages: session.messages } : null;
    },
    getSessionWithoutMessages() { return null; },
    addMessage(sessionId, message) {
      assert.equal(sessionId, SESSION_ID);
      const record = { id: `m-${session.messages.length + 1}`, timestamp: Date.now(), ...message };
      session.messages.push(record);
      return record;
    },
    updateSession() {},
    setSessionAutoOrigin() {},
    setSessionFollowUp() {},
    clearSessionFollowUp() {},
    setSessionHiddenFromList() {},
  };

  const pending = new Map();
  runner.isPermissionPending = (requestId) => pending.has(requestId);
  runner.isPermissionSuspended = () => false;
  runner.hasTextPermissionRelay = () => false;
  runner.startSession = async (sessionId, userMessage) => {
    runner.lastStart = { sessionId, userMessage };
  };
  runner.respondToPermission = (requestId, result) => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    responses.push({ requestId, result });
    pending.delete(requestId);
    entry.resolve(result);
    runner.emit('permissionResolved', entry.sessionId, requestId);
    return true;
  };

  installOwnerAskBridge(runner, {
    notify: (notification) => notifications.push(notification),
    getAppLanguage: () => language,
  });

  /** Raise an ask exactly like coworkRunner's onAskRequest does. */
  const emitAsk = (options = {}) => {
    const requestId = options.requestId ?? 'ask-1';
    const questions = options.questions ?? [{ question: 'Deploy the build to production?' }];
    const request = {
      requestId,
      toolName: options.toolName ?? 'AskUserQuestion',
      toolInput: {
        questions,
        ...(options.context ? { context: options.context } : {}),
      },
    };
    let resolveAsk;
    const answered = new Promise((resolve) => { resolveAsk = resolve; });
    pending.set(requestId, { sessionId: SESSION_ID, resolve: resolveAsk });
    runner.emit('permissionRequest', SESSION_ID, request);
    return { request, answered };
  };

  const pushAssistantReply = (content) => {
    session.messages.push({
      id: `assistant-${session.messages.length + 1}`,
      type: 'assistant',
      content,
      timestamp: Date.now(),
    });
    runner.emit('complete', SESSION_ID);
  };

  return { runner, store, session, notifications, responses, pending, emitAsk, pushAssistantReply };
}

const baseTurnParams = (extra = {}) => ({
  sessionId: SESSION_ID,
  systemPrompt: 'bridge system prompt',
  userMessage: 'do the delegated step',
  cwd: '/tmp/idbots-a2a-worker',
  activeSkillIds: [],
  ...extra,
});

test('A2A bridge turn: ask is pushed once, answering it resumes the turn', async () => {
  const { runner, store, notifications, responses, emitAsk, pushAssistantReply } = makeHarness();

  const turn = runSkillTurnInExistingSession(runner, store, baseTurnParams());
  await sleep(5); // claimManagedOrchestratorSession runs before startSession

  const { request, answered } = emitAsk();

  assert.equal(notifications.length, 1, 'one active push for the pending owner question');
  assert.equal(notifications[0].kind, 'ask');
  assert.equal(notifications[0].sessionId, SESSION_ID);
  assert.equal(notifications[0].requestId, request.requestId);
  assert.ok(notifications[0].title.includes('需要你拍板'), 'zh title');
  assert.ok(notifications[0].body.includes('Deploy the build to production?'), 'question text rides the push');
  assert.ok(notifications[0].body.includes('确认卡片'), 'push points at the existing permission card');
  assert.equal(hasPendingOwnerAsk(runner, SESSION_ID), true);
  assert.equal(responses.length, 0, 'no auto-deny / auto-answer may resolve the ask');

  // The owner answers through the existing overlay/modal channel.
  runner.respondToPermission(request.requestId, {
    behavior: 'allow',
    updatedInput: { answers: { 'Deploy the build to production?': 'Yes' } },
  });
  const answer = await answered;
  assert.equal(answer.behavior, 'allow');
  assert.equal(hasPendingOwnerAsk(runner, SESSION_ID), false, 'answered ask leaves the pending set');

  // The model continues after the answer and the bridge resolves normally.
  pushAssistantReply('Deployed after the owner confirmed.');
  const result = await turn;
  assert.equal(result.replyText, 'Deployed after the owner confirmed.');
  assert.equal(responses.length, 1, 'exactly one owner response reached the runner');
  assert.equal(notifications.filter((entry) => entry.kind === 'timeout').length, 0);
});

test('A2A bridge turn: skill-turn timeout tells the owner explicitly and keeps the ask answerable', async () => {
  const { runner, store, notifications, responses, pending, emitAsk } = makeHarness();

  const turn = runSkillTurnInExistingSession(
    runner,
    store,
    baseTurnParams({ skillTurnTimeoutMs: 40, lateCompletionTimeoutMs: 0 }),
  );
  await sleep(5);
  const { request } = emitAsk({ questions: [{ question: 'Rotate the production key now?' }] });

  await assert.rejects(turn, (error) => error instanceof SkillTurnTimeoutError);

  const timeoutNotices = notifications.filter((entry) => entry.kind === 'timeout');
  assert.equal(timeoutNotices.length, 1, 'owner is pushed the timeout, not left with silence');
  assert.equal(timeoutNotices[0].requestId, request.requestId);
  assert.ok(timeoutNotices[0].body.includes('Rotate the production key now?'));

  const transcriptNotice = store.getSession(SESSION_ID).messages.find(
    (message) => message.metadata?.ownerAskTurnTimeout,
  );
  assert.ok(transcriptNotice, 'honest timeout notice is recorded in the transcript');
  assert.ok(transcriptNotice.content.includes('已超时'));
  assert.ok(transcriptNotice.content.includes('不会重放本轮'));

  // The timeout must NOT fabricate an owner refusal: no respondToPermission
  // deny was issued and the question is still pending/answerable.
  assert.equal(responses.length, 0, 'no fabricated deny on timeout');
  assert.equal(pending.has(request.requestId), true, 'ask stays pending for a late answer');
  assert.equal(hasPendingOwnerAsk(runner, SESSION_ID), true);
});

test('kernel-cancelled ask is reported as unanswered, never as an owner refusal', async () => {
  const { runner, store, notifications, responses, emitAsk } = makeHarness();

  const turn = runSkillTurnInExistingSession(runner, store, baseTurnParams());
  await sleep(5);
  const { request } = emitAsk({ questions: [{ question: 'Which region should the deploy target?' }] });
  assert.equal(notifications.length, 1);

  // Mirrors coworkRunner.onAskCancelled (kernel deadline / turn teardown).
  const noted = noteOwnerAskCancelled(runner, SESSION_ID, request.requestId, store);
  assert.equal(noted, true);
  assert.equal(hasPendingOwnerAsk(runner, SESSION_ID), false);

  const timeoutPush = notifications.filter((entry) => entry.kind === 'timeout');
  assert.equal(timeoutPush.length, 1);
  const transcriptNotice = store.getSession(SESSION_ID).messages.find(
    (message) => message.metadata?.ownerAskUnanswered,
  );
  assert.ok(transcriptNotice);
  assert.ok(transcriptNotice.content.includes('未获回答'));
  assert.equal(responses.length, 0, 'cancellation never fabricates an answer');

  // The turn can still settle through its own timeout without a second push
  // (the request is no longer tracked as an owner ask).
  const secondPass = noteOwnerAskCancelled(runner, SESSION_ID, request.requestId, store);
  assert.equal(secondPass, false);

  // Release the still-pending bridge turn so its 300s watchdog timer does not
  // pin the test process (a real turn would settle through the same event).
  runner.emit('stopped', SESSION_ID, 'test cleanup');
  await turn.catch(() => undefined);
});

test('no push for cowork_ui sessions, IM text-relay sessions, suspended approvals, or safety gates', async () => {
  // Unclaimed (cowork_ui) session: the normal desktop card is the only seat.
  {
    const { runner, notifications, emitAsk } = makeHarness();
    emitAsk();
    assert.equal(notifications.length, 0, 'cowork_ui keeps its normal popup only');
  }

  // IM / gig session: the text relay owns the channel end to end.
  {
    const { runner, store, notifications, emitAsk } = makeHarness();
    const turn = runSkillTurnInExistingSession(runner, store, baseTurnParams()).catch(() => undefined);
    await sleep(5);
    runner.hasTextPermissionRelay = () => true;
    emitAsk();
    assert.equal(notifications.length, 0, 'IM text relay is not double-pushed');
    runner.emit('stopped', SESSION_ID, 'test cleanup');
    await turn;
  }

  // Suspended owner approval (friend invite): owner-gated, already exempt.
  {
    const { runner, store, notifications, emitAsk } = makeHarness();
    const turn = runSkillTurnInExistingSession(runner, store, baseTurnParams()).catch(() => undefined);
    await sleep(5);
    runner.isPermissionSuspended = () => true;
    emitAsk();
    assert.equal(notifications.length, 0, 'suspended approvals keep their own overlay path');
    runner.emit('stopped', SESSION_ID, 'test cleanup');
    await turn;
  }

  // Safety gate riding AskUserQuestion: yes/no relay semantics stay untouched.
  {
    const { runner, store, notifications, emitAsk } = makeHarness();
    const turn = runSkillTurnInExistingSession(runner, store, baseTurnParams()).catch(() => undefined);
    await sleep(5);
    emitAsk({ context: { requestedToolName: 'Bash', requestedToolInput: { command: 'rm -rf build' } } });
    assert.equal(notifications.length, 0, 'safety confirmation is handled by the text relay, not the ask push');
    runner.emit('stopped', SESSION_ID, 'test cleanup');
    await turn;
  }
});

test('desktop push is suppressed while the app is foreground and raises the window on click', () => {
  const shown = [];
  const clicks = [];
  let raised = 0;
  let foreground = true;
  const notify = createOwnerAskNotifier({
    isSupported: () => true,
    isWindowForeground: () => foreground,
    createNotification: ({ title, body }) => {
      const entry = { title, body };
      return {
        on(event, listener) {
          if (event === 'click') clicks.push(listener);
        },
        show() { shown.push(entry); },
      };
    },
    showWindow: () => { raised += 1; },
  });

  const payload = {
    kind: 'ask',
    sessionId: SESSION_ID,
    requestId: 'ask-foreground',
    title: '需要你拍板',
    body: 'Deploy the build to production? —— 打开 IDBots，在弹出的确认卡片里回答。',
  };
  notify(payload);
  assert.equal(shown.length, 0, 'foreground app already shows the in-app card — no double popup');

  foreground = false;
  notify(payload);
  assert.equal(shown.length, 1, 'background app gets exactly one desktop push');
  assert.equal(clicks.length, 1);
  clicks[0]();
  assert.equal(raised, 1, 'clicking the push raises the same app window, no new dialog');

  const unsupported = createOwnerAskNotifier({
    isSupported: () => false,
    isWindowForeground: () => false,
    createNotification: () => { throw new Error('must not be called'); },
    showWindow: () => { throw new Error('must not be called'); },
  });
  unsupported(payload);
  assert.equal(shown.length, 1, 'unsupported hosts stay silent without throwing');
});

test('main process wires the owner-ask push to the real desktop Notification API', () => {
  const mainSource = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'main', 'main.ts'),
    'utf8',
  );
  assert.match(mainSource, /installOwnerAskBridge\(coworkRunner,/);
  assert.match(mainSource, /Notification\.isSupported\(\)/);
  assert.match(mainSource, /new Notification\(\{ title, body \}\)/);
  // Foreground = the in-app card already has the seat; the push is skipped.
  assert.match(mainSource, /mainWindow\.isVisible\(\) && mainWindow\.isFocused\(\)/);
});
