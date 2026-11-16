/**
 * Owner-only safety gates: a delegated worker / group-task session relays host
 * confirmations into its transcript as text, and the delegating bot's next
 * message ("允许") would answer them. For the multisig sign/broadcast gate that
 * would let a BOT satisfy an owner approval. Owner-only gates must be skipped
 * by the text relay and stay with the renderer overlay + the 60s deny watchdog.
 *
 * Run: npx tsx --test tests/orchestratorPermissionOwnerOnly.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  claimManagedOrchestratorSession,
  resolveOrchestratorPermissionReply,
} from '../src/main/services/orchestratorPermissionRelay';

class StubRunner extends EventEmitter {
  responded: Array<{ requestId: string; result: any }> = [];
  pending = new Map<string, true>();
  ownerOnly = new Set<string>();
  private relays = new Set<string>();

  registerTextPermissionRelay(id: string) { this.relays.add(id); }
  unregisterTextPermissionRelay(id: string) { this.relays.delete(id); }
  hasTextPermissionRelay(id: string) { return this.relays.has(id); }
  isPermissionPending(requestId: string) { return this.pending.has(requestId); }
  isPermissionSuspended() { return false; }
  isPermissionOwnerOnly(requestId: string) { return this.ownerOnly.has(requestId); }
  respondToPermission(requestId: string, result: any) {
    this.responded.push({ requestId, result });
    this.pending.delete(requestId);
  }
}

function makeStore() {
  const transcript: Array<{ sessionId: string; message: any }> = [];
  return {
    transcript,
    addMessage(sessionId: string, message: any) {
      const record = { id: `m${transcript.length + 1}`, ...message };
      transcript.push({ sessionId, message: record });
      return record;
    },
    getAppLanguage: () => 'zh',
  };
}

const SESSION = 'delegated-worker-1';

function broadcastGate() {
  return {
    requestId: 'gate-broadcast-1',
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [{ question: '广播这笔交易？', options: [{ label: '允许本次操作' }, { label: '拒绝本次操作' }] }],
      answers: {},
      context: { requestedToolName: 'wallet_btc_broadcast' },
    },
    timeoutDefault: 'deny',
  };
}

test('an owner-only gate is never posted into the delegated-session transcript', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('gate-broadcast-1', true);
  runner.ownerOnly.add('gate-broadcast-1');
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);

  runner.emit('permissionRequest', SESSION, broadcastGate());

  assert.equal(store.transcript.length, 0, 'no text prompt a bot could answer');
  const reply = await resolveOrchestratorPermissionReply(runner as never, SESSION, '允许');
  assert.equal(reply, null, 'a bot message does not resolve the gate');
  assert.equal(runner.responded.length, 0);
});

test('a normal (non owner-only) gate still relays as before', async () => {
  const runner = new StubRunner();
  const store = makeStore();
  runner.pending.set('gate-broadcast-2', true);
  claimManagedOrchestratorSession(runner as never, SESSION, store as never);

  runner.emit('permissionRequest', SESSION, { ...broadcastGate(), requestId: 'gate-broadcast-2' });

  assert.equal(store.transcript.length, 1);
  const reply = await resolveOrchestratorPermissionReply(runner as never, SESSION, '允许');
  assert.ok(reply);
  assert.equal(runner.responded.length, 1);
  assert.equal(runner.responded[0]!.result.behavior, 'allow');
});
