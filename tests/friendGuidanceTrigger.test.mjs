import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

/**
 * S6 final-verification defect #4 regression suite: the deterministic
 * owner-guidance entry into the S5 friend-authorization chain.
 *
 * Real-device defect: after 啊明 approved AI_Sunny's invite (followsMe=true
 * on AI_Sunny's side), the owner typed 「请完成互相关注」 into the A2A private
 * chat — no authorization card, no chain write. Neither guidance delivery
 * path reaches the friend flow: the queued path only applies inside the next
 * INBOUND peer-message turn (the peer has just followed and stays silent),
 * and the restart path is a one-shot composer with no friend-tag protocol.
 *
 * These tests drive the REAL compiled trigger (triggerFriendActionFromGuidance
 * → runPendingFriendAction) across the three pre-friend pair states plus the
 * terminal gates, the deny branch, the pending dedupe, and the restart
 * message's friend-tag extraction.
 */

function loadCompiled(modulePath) {
  return require(modulePath);
}

const {
  triggerFriendActionFromGuidance,
} = loadCompiled('../dist-electron/main/services/privateChatDaemon.js');
const {
  composeA2AGuidanceRestartDelivery,
} = loadCompiled('../dist-electron/main/services/a2aGuidanceRestart.js');
const {
  FRIEND_FOLLOW_PIN_METADATA_KEY,
} = loadCompiled('../dist-electron/main/services/friendFollowService.js');

const PEER_GID = 'idq1peer0000000000000000000000000000000';
const LOCAL_GID = 'idq1local00000000000000000000000000000';
const SESSION_ID = 'session-guidance-1';
const EXTERNAL_CONVERSATION_ID = `metaweb-private:${PEER_GID}`;
const METABOT = { id: 7, name: 'AI_Sunny', globalmetaid: LOCAL_GID };

function buildHarness() {
  const sessionMessages = [];
  const mappingState = { metadataJson: JSON.stringify({ peerGlobalMetaId: PEER_GID }) };
  const coworkStore = {
    addMessage(sessionId, message) {
      assert.equal(sessionId, SESSION_ID);
      const created = { id: `notice-${sessionMessages.length + 1}`, timestamp: Date.now(), ...message };
      sessionMessages.push(created);
      return created;
    },
    getConversationMapping(channel, conversationId, metabotId) {
      assert.equal(channel, 'metaweb_private');
      assert.equal(conversationId, EXTERNAL_CONVERSATION_ID);
      assert.equal(metabotId, METABOT.id);
      return { metadataJson: mappingState.metadataJson };
    },
    updateConversationMappingMetadata(channel, conversationId, metabotId, metadata) {
      mappingState.metadataJson = JSON.stringify(metadata);
    },
  };
  const metabotStore = { getMetabotById: () => METABOT };
  const createPinCalls = [];
  const createPin = async (_store, _id, payload) => {
    createPinCalls.push(payload);
    return { txids: ['f'.repeat(64)], pinId: `${'e'.repeat(64)}i3` };
  };
  const logs = [];
  return {
    coworkStore,
    metabotStore,
    createPin,
    createPinCalls,
    logs,
    sessionMessages,
    mappingState,
    rendererEvents: [],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const baseTriggerParams = (harness, overrides = {}) => ({
  coworkStore: harness.coworkStore,
  sessionId: SESSION_ID,
  externalConversationId: EXTERNAL_CONVERSATION_ID,
  metabot: METABOT,
  peerGlobalMetaId: PEER_GID,
  peerName: '啊明',
  action: 'invite',
  createPin: harness.createPin,
  metabotStore: harness.metabotStore,
  emitLog: (msg) => harness.logs.push(msg),
  emitToRenderer: (channel, data) => harness.rendererEvents.push({ channel, data }),
  ...overrides,
});

const followCreatePayloads = (calls) => calls.filter((payload) => payload.path === '/follow');
const noticeTexts = (harness) => harness.sessionMessages.map((message) => message.content);
/** tApp falls back to English in tests (no store language wired) — match either locale. */
const hasNotice = (harness, ...needles) => noticeTexts(harness).some(
  (text) => needles.some((needle) => text.includes(needle)),
);

async function waitFor(predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for the friend guidance trigger condition');
}

// ---------------------------------------------------------------------------
// The three pre-friend states: owner instruction MUST reach the card.
// ---------------------------------------------------------------------------

test('state 1 (neither follows): owner instruction triggers the card; approval writes /follow with GlobalMetaID', async () => {
  const harness = buildHarness();
  const approvals = [];
  const launched = triggerFriendActionFromGuidance(baseTriggerParams(harness, {
    requestFriendActionApproval: async (params) => {
      approvals.push(params);
      return 'approved';
    },
    resolveFriendPairState: async () => ({
      status: 'not_confirmed', blocking: false, blockedBy: false,
      followsMe: false, followedByMe: false,
    }),
  }));
  assert.equal(launched, true);
  await waitFor(() => followCreatePayloads(harness.createPinCalls).length === 1);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action, 'invite');
  assert.equal(approvals[0].peerGlobalMetaId, PEER_GID);
  const payload = followCreatePayloads(harness.createPinCalls)[0];
  assert.equal(payload.payload, PEER_GID, '/follow contentBody is the peer GlobalMetaID');
  // The conversation mapping records the pin for a later FRIEND_REMOVE.
  const metadata = JSON.parse(harness.mappingState.metadataJson);
  assert.equal(metadata[FRIEND_FOLLOW_PIN_METADATA_KEY].pinId, `${'e'.repeat(64)}i3`);
});

test('state 2 — THE REAL-DEVICE DEFECT (peer already follows me): the card still fires and the write completes the mutual follow', async () => {
  const harness = buildHarness();
  const approvals = [];
  const launched = triggerFriendActionFromGuidance(baseTriggerParams(harness, {
    requestFriendActionApproval: async (params) => {
      approvals.push(params);
      return 'approved';
    },
    resolveFriendPairState: async () => ({
      status: 'not_confirmed', blocking: false, blockedBy: false,
      followsMe: true, followedByMe: false,
    }),
  }));
  assert.equal(launched, true);
  await waitFor(() => approvals.length === 1);
  await waitFor(() => followCreatePayloads(harness.createPinCalls).length === 1);
  // Diagnosis visibility: the daemon log names the directional state.
  assert.ok(
    harness.logs.some((line) => line.includes('followsMe=true') && line.includes('followedByMe=false')),
    'the proceeding log line carries the directional pair state',
  );
  assert.equal(followCreatePayloads(harness.createPinCalls)[0].payload, PEER_GID);
});

test('state 3 (I already follow the peer): the card still fires — a duplicate /follow is the owner-authorized design semantic', async () => {
  const harness = buildHarness();
  const approvals = [];
  triggerFriendActionFromGuidance(baseTriggerParams(harness, {
    requestFriendActionApproval: async (params) => {
      approvals.push(params);
      return 'approved';
    },
    resolveFriendPairState: async () => ({
      status: 'not_confirmed', blocking: false, blockedBy: false,
      followsMe: false, followedBy: true,
    }),
  }));
  await waitFor(() => approvals.length === 1);
  await waitFor(() => followCreatePayloads(harness.createPinCalls).length === 1);
});

// ---------------------------------------------------------------------------
// Terminal gates and guards.
// ---------------------------------------------------------------------------

test('already-confirmed friendship skips the card with a transcript notice', async () => {
  const harness = buildHarness();
  const approvals = [];
  triggerFriendActionFromGuidance(baseTriggerParams(harness, {
    requestFriendActionApproval: async (params) => { approvals.push(params); return 'approved'; },
    resolveFriendPairState: async () => ({
      status: 'confirmed', blocking: false, blockedBy: false,
      followsMe: true, followedByMe: true,
    }),
  }));
  await waitFor(() => hasNotice(harness, '已经是链上好友', 'Already on-chain friends'));
  assert.equal(approvals.length, 0, 'no authorization card for an already-friend pair');
  assert.equal(followCreatePayloads(harness.createPinCalls).length, 0);
});

test('an active simpleblock skips the card with a transcript notice', async () => {
  const harness = buildHarness();
  const approvals = [];
  triggerFriendActionFromGuidance(baseTriggerParams(harness, {
    requestFriendActionApproval: async (params) => { approvals.push(params); return 'approved'; },
    resolveFriendPairState: async () => ({
      status: 'not_confirmed', blocking: true, blockedBy: false,
      followsMe: false, followedByMe: false,
    }),
  }));
  await waitFor(() => hasNotice(harness, '拉黑', 'A block is active'));
  assert.equal(approvals.length, 0);
  assert.equal(followCreatePayloads(harness.createPinCalls).length, 0);
});

test('owner DENY on the card writes nothing and leaves a clear notice (the previously untestable branch)', async () => {
  const harness = buildHarness();
  const approvals = [];
  triggerFriendActionFromGuidance(baseTriggerParams(harness, {
    requestFriendActionApproval: async (params) => { approvals.push(params); return 'denied'; },
    resolveFriendPairState: async () => ({
      status: 'not_confirmed', blocking: false, blockedBy: false,
      followsMe: true, followedByMe: false,
    }),
  }));
  await waitFor(() => approvals.length === 1);
  await waitFor(() => hasNotice(harness, '主人未授权', 'did not authorize'));
  assert.equal(followCreatePayloads(harness.createPinCalls).length, 0, 'deny never writes /follow');
});

test('a second instruction while an authorization is pending is deduped, not stacked', async () => {
  const harness = buildHarness();
  const approvalGate = deferred();
  const approvals = [];
  const params = baseTriggerParams(harness, {
    requestFriendActionApproval: async (input) => {
      approvals.push(input);
      return approvalGate.promise;
    },
    resolveFriendPairState: async () => ({
      status: 'not_confirmed', blocking: false, blockedBy: false,
      followsMe: true, followedByMe: false,
    }),
  });
  assert.equal(triggerFriendActionFromGuidance(params), true);
  await waitFor(() => approvals.length === 1);
  // Owner re-sends the instruction while the card is still up.
  assert.equal(triggerFriendActionFromGuidance(params), true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(approvals.length, 1, 'pending approval dedupes the second launch');
  approvalGate.resolve('denied');
  await waitFor(() => hasNotice(harness, '主人未授权', 'did not authorize'));
  assert.equal(followCreatePayloads(harness.createPinCalls).length, 0);
});

test('guard rails: no approval bridge or an invalid peer id refuses to launch', async () => {
  const harness = buildHarness();
  const approvals = [];
  assert.equal(triggerFriendActionFromGuidance(baseTriggerParams(harness, {
    requestFriendActionApproval: undefined,
  })), false);
  assert.equal(triggerFriendActionFromGuidance(baseTriggerParams(harness, {
    peerGlobalMetaId: 'not-a-globalmetaid',
    requestFriendActionApproval: async (params) => { approvals.push(params); return 'approved'; },
  })), false);
  assert.equal(approvals.length, 0);
});

// ---------------------------------------------------------------------------
// Restart-path hardening: a leaked friend tag is stripped and routed.
// ---------------------------------------------------------------------------

test('composeA2AGuidanceRestartDelivery strips a leaked [FRIEND_INVITE] and routes the action', () => {
  const delivery = composeA2AGuidanceRestartDelivery('好的，我们互相 follow 吧！\n[FRIEND_INVITE]');
  assert.equal(delivery.friendAction, 'invite');
  assert.equal(delivery.text.includes('[FRIEND_INVITE]'), false, 'the tag never reaches the peer');
  assert.equal(delivery.text.includes('互相 follow'), true);
});

test('composeA2AGuidanceRestartDelivery routes a remove tag and passes clean text through', () => {
  assert.equal(composeA2AGuidanceRestartDelivery('一路顺风。\n[FRIEND_REMOVE]').friendAction, 'remove');
  const clean = composeA2AGuidanceRestartDelivery('Plain restart message, no tags.');
  assert.equal(clean.friendAction, null);
  assert.equal(clean.text, 'Plain restart message, no tags.');
});
