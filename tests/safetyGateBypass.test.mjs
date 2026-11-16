/**
 * Regression: a free-form message in the chat composer must NOT approve a
 * pending safety gate (wallet_btc_broadcast / wallet_btc_sign_psbt and every
 * other gate). Before the fix, trySubmitSteer answered ANY pending
 * AskUserQuestion with `behavior: 'allow'`, and requestSafetyApproval treats a
 * bare `allow` as approval — so typing "不要广播" approved the broadcast.
 *
 * Runs against the compiled runner (dist-electron), like the other runner
 * tests. Run: pnpm run compile:electron && node --test tests/safetyGateBypass.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'safety-gate-bypass-test-user-data'),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadCompiledModule('../dist-electron/main/libs/coworkRunner.js');

function gateRequest() {
  return {
    requestId: 'req-broadcast-1',
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [{
        header: '安全确认',
        question: '允许广播吗？',
        options: [{ label: '允许本次操作' }, { label: '拒绝本次操作' }],
      }],
      answers: {},
      context: { requestedToolName: 'wallet_btc_broadcast', requestedToolInput: {}, destructive: false },
    },
    timeoutDefault: 'deny',
  };
}

function runnerWithPendingGate() {
  const runner = Object.create(CoworkRunner.prototype);
  runner.activeSessions = new Map();
  runner.pendingPermissions = new Map();
  runner.sandboxPermissions = new Map();
  runner.dshActiveTurns = new Set();
  runner.emit = () => {};
  const session = {
    sessionId: 's1',
    executionMode: 'local',
    localTurnState: 'none',
    pendingPermission: gateRequest(),
    abortController: new AbortController(),
  };
  runner.activeSessions.set('s1', session);
  const resolved = { value: null };
  runner.pendingPermissions.set('req-broadcast-1', {
    sessionId: 's1',
    resolve: (result) => {
      resolved.value = result;
    },
    suspended: false,
  });
  return { runner, session, resolved };
}

test('free-form composer text leaves the broadcast gate pending', () => {
  const { runner, resolved } = runnerWithPendingGate();
  const outcome = runner.trySubmitSteer('s1', 'sub-1', '不要广播，等我确认');

  assert.equal(resolved.value, null, 'the gate must not resolve on free-form text');
  assert.equal(runner.pendingPermissions.has('req-broadcast-1'), true, 'the gate is still waiting for the owner');
  assert.equal(outcome.accepted, false);
});

test('the exact allow option still answers the gate from the composer', () => {
  const { runner, session, resolved } = runnerWithPendingGate();
  const outcome = runner.trySubmitSteer('s1', 'sub-2', '允许本次操作');

  assert.deepEqual(resolved.value, {
    behavior: 'allow',
    updatedInput: { answers: { '允许广播吗？': '允许本次操作' } },
  });
  assert.equal(session.pendingPermission, null);
  assert.equal(outcome.accepted, true);
});

test('the exact deny option denies the gate instead of approving it', () => {
  const { runner, resolved } = runnerWithPendingGate();
  runner.trySubmitSteer('s1', 'sub-3', '拒绝本次操作');
  assert.equal(resolved.value?.behavior, 'deny');
});
