import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  claimManagedOrchestratorSession,
  resolveOrchestratorPermissionReply,
  buildOrchestratorPermissionPrompt,
  isManagedOrchestratorSession,
  isStructuredOwnerQuestion,
} from '../src/main/services/orchestratorPermissionRelay';

/**
 * Regression coverage for the orchestrator text-relay channel: orchestrator /
 * group-task / private-chat (side panel) worker sessions run with
 * confirmationMode 'text' but had NO relay owner, so host safety gates (skill
 * install, delete, wallet external transfer) emitted permissionRequests that
 * were neither visible in any UI nor matched against chat replies — the 60s
 * watchdog auto-denied them. Run: npx tsx --test tests/orchestratorPermissionRelay.test.ts
 */

class StubRunner extends EventEmitter {
  responded: Array<{ requestId: string; result: any }> = [];
  pending = new Map<string, true>();
  private relays = new Set<string>();

  registerTextPermissionRelay(id: string) { this.relays.add(id); }
  unregisterTextPermissionRelay(id: string) { this.relays.delete(id); }
  hasTextPermissionRelay(id: string) { return this.relays.has(id); }
  isPermissionPending(requestId: string) { return this.pending.has(requestId); }
  respondToPermission(requestId: string, result: any) {
    this.responded.push({ requestId, result });
    this.pending.delete(requestId);
  }
}

function makeStore(lang = 'zh') {
  const transcript: Array<{ sessionId: string; message: any }> = [];
  return {
    transcript,
    addMessage(sessionId: string, message: any) {
      const record = { id: `m${transcript.length + 1}`, ...message };
      transcript.push({ sessionId, message: record });
      return record;
    },
    getAppLanguage: () => lang,
  };
}

const installGateRequest = (requestId = 'dsh-policy-1') => ({
  requestId,
  toolName: 'skill_tool',
  toolInput: { reason: 'install_skill requires owner confirmation' },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SESSION = 'orch-worker-1';

test('skill-install confirmation question is posted into the managed session transcript', () => {
  const runner = new StubRunner();
  const store = makeStore();
  const seenMessages: Array<[string, unknown]> = [];
  runner.on('message', (sessionId, message) => seenMessages.push([sessionId, message]));

  runner.pending.set('dsh-policy-1', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);
  runner.emit('permissionRequest', SESSION, installGateRequest());

  assert.equal(store.transcript.length, 1, 'question message injected into transcript');
  const injected = store.transcript[0]!;
  assert.equal(injected.sessionId, SESSION);
  assert.equal(injected.message.type, 'system');
  assert.ok(injected.message.content.includes('安全确认'), 'zh confirmation headline');
  assert.ok(injected.message.content.includes('skill_tool'), 'requested tool name');
  assert.ok(injected.message.content.includes('install_skill requires owner confirmation'), 'gate reason as detail');
  assert.ok(injected.message.content.includes('允许'), 'allow reply instruction');
  assert.deepEqual(injected.message.metadata.orchestratorPermissionRequest, {
    requestId: 'dsh-policy-1',
    toolName: 'skill_tool',
  });
  assert.equal(seenMessages.length, 1, 'question also emitted on the message stream');
  assert.equal(seenMessages[0]![0], SESSION);
});

test('a following chat message 允许 routes an allow result back to the runner', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('dsh-policy-1', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);
  runner.emit('permissionRequest', SESSION, installGateRequest());

  const reply = await resolveOrchestratorPermissionReply(runner as never, SESSION, '允许');
  assert.ok(reply, 'reply handled by the relay');
  assert.equal(reply!.assistantMessageId, null);
  assert.ok(reply!.replyText.includes('已允许'), 'canned confirmation reply');
  assert.equal(runner.responded.length, 1);
  assert.equal(runner.responded[0]!.requestId, 'dsh-policy-1');
  assert.equal(runner.responded[0]!.result.behavior, 'allow');
  assert.deepEqual(runner.responded[0]!.result.updatedInput, installGateRequest().toolInput);
});

test('拒绝 routes a deny result back to the runner', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('dsh-policy-1', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);
  runner.emit('permissionRequest', SESSION, installGateRequest());

  const reply = await resolveOrchestratorPermissionReply(runner as never, SESSION, '拒绝');
  assert.ok(reply);
  assert.ok(reply!.replyText.includes('已拒绝'));
  assert.equal(runner.responded[0]!.result.behavior, 'deny');
});

test('a non-matching reply keeps the confirmation pending', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('dsh-policy-1', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);
  runner.emit('permissionRequest', SESSION, installGateRequest());

  const reply = await resolveOrchestratorPermissionReply(runner as never, SESSION, '再想想');
  assert.ok(reply);
  assert.ok(reply!.replyText.includes('待确认'));
  assert.equal(runner.responded.length, 0, 'no answer routed');
});

test('sessions without a relay owner (answered elsewhere) fall through to a normal turn', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('dsh-policy-1', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);
  runner.emit('permissionRequest', SESSION, installGateRequest());

  // The prompt was answered elsewhere (renderer overlay): the runner no
  // longer holds the request.
  runner.pending.delete('dsh-policy-1');
  const reply = await resolveOrchestratorPermissionReply(runner as never, SESSION, '允许');
  assert.equal(reply, null, 'stale local record dropped, message flows into a normal turn');
  assert.equal(runner.responded.length, 0, 'no duplicate respond');
});

test('unmanaged and IM-owned sessions are not relayed', () => {
  const runner = new StubRunner();
  const store = makeStore();

  runner.pending.set('req-a', true);
  runner.emit('permissionRequest', 'unclaimed-session', installGateRequest('req-a'));
  assert.equal(store.transcript.length, 0, 'unmanaged session untouched');

  runner.pending.set('req-b', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);
  runner.registerTextPermissionRelay(SESSION); // IM/order own this session
  runner.emit('permissionRequest', SESSION, installGateRequest('req-b'));
  assert.equal(store.transcript.length, 0, 'relay-owned session skipped');
});

test('a second permission request keeps the first card instead of denying it', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('dsh-policy-1', true);
  runner.pending.set('dsh-policy-2', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never, { timeoutMs: 5000 });
  runner.emit('permissionRequest', SESSION, installGateRequest('dsh-policy-1'));
  runner.emit('permissionRequest', SESSION, installGateRequest('dsh-policy-2'));

  assert.equal(runner.responded.length, 0, 'the older request is not superseded');
  assert.equal(store.transcript.length, 2, 'both prompts are posted');

  const reply = await resolveOrchestratorPermissionReply(runner as never, SESSION, '允许');
  assert.ok(reply);
  assert.equal(runner.responded.length, 1);
  assert.equal(runner.responded[0]!.requestId, 'dsh-policy-1', 'text reply answers the oldest card');
  assert.equal(runner.pending.has('dsh-policy-2'), true);
});

test('an ordinary tool approval times out as deny (fail-closed, 2026-11-03 review)', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('appr-1', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never, { timeoutMs: 15 });
  runner.emit('permissionRequest', SESSION, {
    requestId: 'appr-1',
    toolName: 'Bash',
    toolInput: { reason: 'run a command' },
    timeoutDefault: 'deny',
  });

  await sleep(50);
  assert.equal(runner.responded.length, 1);
  assert.equal(runner.responded[0]!.result.behavior, 'deny');
});

test('a question with no default is not auto-answered', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('ask-1', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never, { timeoutMs: 15 });
  runner.emit('permissionRequest', SESSION, {
    requestId: 'ask-1',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Which color?' }] },
  });

  await sleep(50);
  assert.equal(runner.responded.length, 0, 'questions wait for a person');
  assert.ok(store.transcript[0]!.message.content.includes('一直等待'));
});

test('unanswered confirmations auto-deny after the configured window', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('dsh-policy-1', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never, { timeoutMs: 15 });
  runner.emit('permissionRequest', SESSION, installGateRequest());

  await sleep(50);
  assert.equal(runner.responded.length, 1);
  assert.equal(runner.responded[0]!.result.behavior, 'deny');
  assert.match(runner.responded[0]!.result.message, /timed out/);
});

test('prompt builder surfaces the safety-context tool name for AskUserQuestion gates', () => {
  const prompt = buildOrchestratorPermissionPrompt({
    requestId: 'ask-1',
    toolName: 'AskUserQuestion',
    toolInput: {
      context: { requestedToolName: 'Bash', requestedToolInput: { command: 'rm -rf build' } },
      questions: [{ question: '允许删除任务目录外的路径吗？', options: [{ label: '允许' }, { label: '拒绝' }] }],
    },
  }, 'zh');
  assert.ok(prompt.includes('Bash'), 'safety-context tool name wins over AskUserQuestion');
  assert.ok(prompt.includes('允许删除任务目录外的路径吗？'), 'question text as detail');

  const en = buildOrchestratorPermissionPrompt({
    requestId: 'ask-2',
    toolName: 'skill_tool',
    toolInput: { reason: 'needs confirmation' },
  }, 'en');
  assert.ok(en.includes('A safety confirmation is required'), 'english prompt for en sessions');
});


/**
 * A2A / OpenTeam bridge turns: a STRUCTURED ask_user_question (the model asking
 * the owner a real question, no safety context) must never be turned into a
 * transcript yes/no prompt + 60s auto-deny — the A2A view hides system
 * messages, so that path fabricated "the user declined" with the owner never
 * asked (the same defect class as the 2026-10-30 friend-invite auto-deny).
 */
test('structured owner questions wait for a person and are never auto-denied', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('ask-structured', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never, { timeoutMs: 15 });

  const ask = {
    requestId: 'ask-structured',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Deploy the build to production?' }] },
  };
  assert.equal(isStructuredOwnerQuestion(ask), true, 'no safety context = owner question');
  runner.emit('permissionRequest', SESSION, ask);

  await sleep(50);
  // Merge composition (2026-11-04): main's relay keeps the question as a
  // wait-forever transcript record; the bridge's desktop push
  // (tests/a2aPendingAskBridge.test.mjs) is the proactive surface. What both
  // sides agree on is pinned here: nothing may fabricate an answer.
  assert.equal(runner.responded.length, 0, 'no fabricated decline after the relay window');
  assert.equal(store.transcript.length, 1, 'the question stays on the record');
  assert.equal(runner.isPermissionPending('ask-structured'), true);
});

test('safety gates riding AskUserQuestion keep the text relay and its timeout', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('ask-safety', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never, { timeoutMs: 15 });

  const ask = {
    requestId: 'ask-safety',
    toolName: 'AskUserQuestion',
    // Since the 2026-11-03 fail-closed review, every tool-approval-derived ask
    // is stamped timeoutDefault 'deny' by the runner (stampPermissionDeadline);
    // the relay arms its countdown from that stamp.
    timeoutDefault: 'deny',
    toolInput: {
      context: { requestedToolName: 'Bash', requestedToolInput: { command: 'rm -rf build' } },
      questions: [{ question: '允许删除任务目录外的路径吗？', options: [{ label: '允许' }, { label: '拒绝' }] }],
    },
  };
  assert.equal(isStructuredOwnerQuestion(ask), false, 'safety context keeps yes/no semantics');
  runner.emit('permissionRequest', SESSION, ask);

  assert.equal(store.transcript.length, 1, 'safety confirmation is posted into the transcript');
  await sleep(50);
  assert.equal(runner.responded.length, 1);
  assert.equal(runner.responded[0]!.result.behavior, 'deny');
  assert.match(runner.responded[0]!.result.message, /timed out/);
});

test('managed-session registry drives the bridge push predicate', () => {
  const runner = new StubRunner();
  const store = makeStore();
  assert.equal(isManagedOrchestratorSession(runner as never, SESSION), false, 'unclaimed = cowork_ui');
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);
  assert.equal(isManagedOrchestratorSession(runner as never, SESSION), true, 'bridge turn = managed');
  assert.equal(isManagedOrchestratorSession(runner as never, 'other-session'), false);
});
