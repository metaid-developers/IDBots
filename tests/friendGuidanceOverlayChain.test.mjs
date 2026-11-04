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
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'friend-guidance-overlay-chain-test-user-data'),
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
const {
  triggerFriendActionFromGuidance,
} = loadCompiledModule('../dist-electron/main/services/privateChatDaemon.js');

/**
 * Real-chain regression suite for the S6 final-verification defect #4: the
 * owner typed 「请完成互相关注」 into the AI_Sunny↔啊明 A2A private chat AFTER
 * 啊明's /follow was already on-chain (followsMe=true) — no authorization
 * card ever popped and nothing was written.
 *
 * These tests drive the REAL compiled CoworkRunner's requestSuspendedApproval
 * (the exact bridge requestDaemonFriendActionApproval wires in main.ts)
 * together with the REAL compiled daemon trigger, across the defect's pair
 * state: the card MUST surface as a pending suspended permissionRequest, and
 * the owner's explicit deny / allow clicks MUST resolve it to the matching
 * chain behavior.
 */

class RecordingStore {
  constructor() {
    this.messages = [];
    this.sessionUpdates = [];
  }
  getSession() {
    return { messages: this.messages };
  }
  addMessage(_sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: 1_700_000_000_000, ...message };
    this.messages.push(stored);
    return stored;
  }
  getSessionUsageStats() {
    return null;
  }
  updateSession(sessionId, patch) {
    this.sessionUpdates.push({ sessionId, patch });
  }
}

const PEER_GID = 'idq1peer0000000000000000000000000000000';
const LOCAL_GID = 'idq1local00000000000000000000000000000';
const SESSION_ID = 'sess-a2a-sunny-aming';
const EXTERNAL_CONVERSATION_ID = `metaweb-private:${PEER_GID}`;
const METABOT = { id: 3, name: 'AI_Sunny', globalmetaid: LOCAL_GID };

const buildHarness = () => {
  const store = new RecordingStore();
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0 });
  const capturedRequests = [];
  runner.on('permissionRequest', (sessionId, request) => {
    if (sessionId === SESSION_ID) capturedRequests.push(request);
  });
  const createPinCalls = [];
  const coworkStoreFacade = {
    addMessage: (sessionId, message) => store.addMessage(sessionId, message),
    getConversationMapping: () => ({ metadataJson: JSON.stringify({ peerGlobalMetaId: PEER_GID }) }),
    updateConversationMappingMetadata: () => {},
  };
  const logs = [];
  // The bridge mirrors requestDaemonFriendActionApproval in main.ts: the
  // runner's SUSPENDED approval (overlay seat, no 60s watchdog).
  const requestFriendActionApproval = (params) => runner.requestSuspendedApproval({
    sessionId: params.sessionId,
    header: '好友确认',
    question: `机器人「${params.metabotName}」请求与「${params.peerName ?? params.peerGlobalMetaId.slice(0, 12)}」互加好友：授权后将用该机器人的钱包写链 /follow（contentBody=对方 GlobalMetaID，链上公开且不可撤销）。是否授权？`,
    context: {
      action: params.action,
      peerGlobalMetaId: params.peerGlobalMetaId,
      peerName: params.peerName ?? null,
      metabotId: params.metabotId,
    },
  });
  const launchTrigger = () => triggerFriendActionFromGuidance({
    coworkStore: coworkStoreFacade,
    sessionId: SESSION_ID,
    externalConversationId: EXTERNAL_CONVERSATION_ID,
    metabot: METABOT,
    peerGlobalMetaId: PEER_GID,
    peerName: '啊明',
    action: 'invite',
    createPin: async (_store, _metabotId, payload) => {
      createPinCalls.push(payload);
      return { txids: ['f'.repeat(64)], pinId: `${'e'.repeat(64)}i3` };
    },
    metabotStore: {},
    requestFriendActionApproval,
    resolveFriendPairState: async () => ({
      // The exact defect state: the peer ALREADY follows the local bot.
      status: 'not_confirmed', blocking: false, blockedBy: false,
      followsMe: true, followedByMe: false,
    }),
    emitLog: (msg) => logs.push(msg),
    emitToRenderer: () => {},
  });
  return { store, runner, capturedRequests, createPinCalls, logs, launchTrigger };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const followCreatePayloads = (calls) => calls.filter((payload) => payload.path === '/follow');
const waitFor = async (predicate, timeoutMs = 10_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail('timed out waiting for the real-chain friend guidance condition');
};

test('followsMe=true + owner instruction: the authorization card surfaces as a suspended permissionRequest', async () => {
  const harness = buildHarness();
  assert.equal(harness.launchTrigger(), true);
  await waitFor(() => harness.capturedRequests.length === 1);

  const request = harness.capturedRequests[0];
  assert.equal(request.toolName, 'AskUserQuestion');
  assert.equal(request.toolInput.context.action, 'invite');
  assert.equal(request.toolInput.context.peerGlobalMetaId, PEER_GID);
  // Suspended semantics: no watchdog ever auto-answers the owner's card.
  await sleep(200);
  assert.equal(harness.runner.isPermissionPending(request.requestId), true, 'card stays pending for the owner');
  assert.equal(harness.runner.isPermissionSuspended(request.requestId), true, 'card is a suspended owner-gated approval');

  // The owner clicks DENY on the card: nothing is written.
  harness.runner.respondToPermission(request.requestId, { behavior: 'deny', message: 'Permission denied' });
  await waitFor(() => harness.logs.some((line) => line.includes('not authorized')));
  await sleep(100);
  assert.equal(followCreatePayloads(harness.createPinCalls).length, 0, 'deny writes no /follow');
});

test('followsMe=true + owner instruction: owner ALLOW resolves approved and the reverse /follow hits the chain', async () => {
  const harness = buildHarness();
  assert.equal(harness.launchTrigger(), true);
  await waitFor(() => harness.capturedRequests.length === 1);

  const request = harness.capturedRequests[0];
  const question = request.toolInput.questions[0].question;
  const allowOption = request.toolInput.questions[0].options[0].label;
  harness.runner.respondToPermission(request.requestId, {
    behavior: 'allow',
    updatedInput: { ...request.toolInput, answers: { [question]: allowOption } },
  });
  await waitFor(() => followCreatePayloads(harness.createPinCalls).length === 1);
  assert.equal(followCreatePayloads(harness.createPinCalls)[0].payload, PEER_GID);
  assert.equal(harness.runner.isPermissionPending(request.requestId), false);
});

test('the suspended card survives well past any watchdog window before the owner acts', async () => {
  const harness = buildHarness();
  harness.launchTrigger();
  await waitFor(() => harness.capturedRequests.length === 1);
  // No relay is claimed in this scenario, but the suspended approval must
  // never carry its own timeout either — wait far past the classic 60ms test
  // relay window and far past a hypothetical short watchdog.
  await sleep(400);
  assert.equal(harness.runner.isPermissionPending(harness.capturedRequests[0].requestId), true);
  assert.equal(followCreatePayloads(harness.createPinCalls).length, 0, 'no write without the owner click');
});
