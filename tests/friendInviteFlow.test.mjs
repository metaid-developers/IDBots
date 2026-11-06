import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let friendFollowService;
let startPrivateChatDaemon;
let stopPrivateChatDaemon;
let buildPrivateChatA2ASystemPrompt;
let shouldHideA2AInternalMessage;
try {
  friendFollowService = await import('../dist-electron/main/services/friendFollowService.js');
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    buildPrivateChatA2ASystemPrompt,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({ shouldHideA2AInternalMessage } = await import('../dist-electron/main/shared/a2aInternalMessageFilter.js'));
} catch {
  friendFollowService = await import('../dist-electron/main/services/friendFollowService.js');
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    buildPrivateChatA2ASystemPrompt,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({ shouldHideA2AInternalMessage } = await import('../dist-electron/main/shared/a2aInternalMessageFilter.js'));
}

const {
  FRIEND_INVITE_TAG,
  FRIEND_REMOVE_TAG,
  FRIEND_FOLLOW_PIN_METADATA_KEY,
  extractFriendActionTags,
  buildFollowCreatePayload,
  buildFollowRevokePayload,
  readFriendFollowRecord,
} = friendFollowService;

// ---------------------------------------------------------------------------
// Unit: tag extraction
// ---------------------------------------------------------------------------

test('extractFriendActionTags strips standalone invite tag and keeps prose', () => {
  const { text, action } = extractFriendActionTags('好啊，我们加好友吧！\n[FRIEND_INVITE]\n回头聊。');
  assert.equal(action, 'invite');
  assert.equal(text, '好啊，我们加好友吧！\n回头聊。');
});

test('extractFriendActionTags tolerates cosmetic wrapping around the tag line', () => {
  assert.equal(extractFriendActionTags('好。\n`[FRIEND_INVITE]`').action, 'invite');
  assert.equal(extractFriendActionTags('好。\n"[friend_invite]"').action, 'invite');
  assert.equal(extractFriendActionTags('好。\n（[FRIEND_REMOVE]）').action, 'remove');
  // Inline (not standalone) tags are content, not protocol.
  assert.equal(extractFriendActionTags('看这个 [FRIEND_INVITE] 例子').action, null);
  assert.equal(extractFriendActionTags('看这个 [FRIEND_INVITE] 例子').text.includes('[FRIEND_INVITE]'), true);
  // Invite wins when both tags appear.
  assert.equal(extractFriendActionTags('[FRIEND_REMOVE]\n[FRIEND_INVITE]').action, 'invite');
  // No tags: text unchanged.
  assert.deepEqual(extractFriendActionTags('plain reply'), { text: 'plain reply', action: null });
});

// ---------------------------------------------------------------------------
// Unit: follow/revoke payloads (spec §2.4/§3.1 — GlobalMetaID 口径)
// ---------------------------------------------------------------------------

const PEER_GID = 'idq1peer0000000000000000000000000000000';
const LOCAL_GID = 'idq1local00000000000000000000000000000';
const FOLLOW_PIN_ID = `${'a'.repeat(64)}i0`;

test('buildFollowCreatePayload writes the peer GlobalMetaID as plain-string contentBody', () => {
  const payload = buildFollowCreatePayload(PEER_GID.toUpperCase());
  assert.equal(payload.operation, 'create');
  assert.equal(payload.path, '/follow');
  assert.equal(payload.payload, PEER_GID);
  assert.equal(typeof payload.payload, 'string');
  // Never a JSON object, never a legacy hex id, never an address.
  assert.throws(() => buildFollowCreatePayload('0123456789abcdef'.repeat(4)), /Invalid peer GlobalMetaID/);
  assert.throws(() => buildFollowCreatePayload('1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx'), /Invalid peer GlobalMetaID/);
});

test('buildFollowRevokePayload targets /follow@<originalFollowPinId> with operation revoke', () => {
  const payload = buildFollowRevokePayload(FOLLOW_PIN_ID);
  assert.equal(payload.operation, 'revoke');
  assert.equal(payload.path, `/follow@${FOLLOW_PIN_ID}`);
  assert.equal(payload.payload, '');
  assert.throws(() => buildFollowRevokePayload('not-a-pin'), /Invalid original/);
});

test('readFriendFollowRecord round-trips the mapping metadata record', () => {
  assert.equal(readFriendFollowRecord(null), null);
  assert.equal(readFriendFollowRecord({}), null);
  assert.equal(readFriendFollowRecord({ [FRIEND_FOLLOW_PIN_METADATA_KEY]: { pinId: 'garbage' } }), null);
  const record = readFriendFollowRecord({
    [FRIEND_FOLLOW_PIN_METADATA_KEY]: { pinId: FOLLOW_PIN_ID, txid: 'b'.repeat(64), followedAt: 123 },
  });
  assert.deepEqual(record, { pinId: FOLLOW_PIN_ID, txid: 'b'.repeat(64), followedAt: 123 });
});

// ---------------------------------------------------------------------------
// Unit: system prompt carries the friend-action capability rule
// ---------------------------------------------------------------------------

const analysisBase = {
  contextMessages: [],
  incomingTurnCount: 1,
  shouldForceBye: false,
};

test('A2A system prompt instructs the friend invite/remove tags on normal turns only', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local' },
    analysis: analysisBase,
  });
  assert.match(prompt, /\[FRIEND_INVITE\]/);
  assert.match(prompt, /\[FRIEND_REMOVE\]/);
  assert.match(prompt, /owner's? on-device confirmation|owner.*approv/i);

  const byePrompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local' },
    analysis: { ...analysisBase, shouldForceBye: true },
  });
  assert.doesNotMatch(byePrompt, /\[FRIEND_INVITE\]/);
});

// ---------------------------------------------------------------------------
// Unit: friend notices stay visible in the A2A transcript
// ---------------------------------------------------------------------------

test('friend-action notices are exempt from the A2A internal-message hide rules', () => {
  const notice = {
    type: 'system',
    content: '[Host] notice',
    metadata: { privateChatFriendNotice: true, direction: 'outgoing' },
  };
  assert.equal(shouldHideA2AInternalMessage(notice, { chainBackedConversation: true }), false);
  const plainSystem = { type: 'system', content: '[Host] notice', metadata: {} };
  assert.equal(shouldHideA2AInternalMessage(plainSystem, { chainBackedConversation: true }), true);
});

// ---------------------------------------------------------------------------
// Daemon-level harness (two local bots simulated down to the daemon layer)
// ---------------------------------------------------------------------------

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createFriendInviteHarness(options = {}) {
  const peerName = options.peerName ?? 'Peer Bot';
  const row = {
    id: 1,
    pin_id: 'incoming-pin-1',
    tx_id: 'c'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: PEER_GID,
    from_name: peerName,
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: LOCAL_GID,
    content: options.inbound ?? '我们加个好友吧，以后合作方便！',
    encryption: null,
    reply_pin: '',
    raw_data: null,
    is_processed: 0,
  };
  const columns = [
    'id', 'pin_id', 'tx_id', 'from_metaid', 'from_global_metaid', 'from_name',
    'from_avatar', 'from_chat_pubkey', 'to_metaid', 'to_global_metaid',
    'content', 'encryption', 'reply_pin', 'raw_data',
  ];
  const externalConversationId = `metaweb-private:${PEER_GID}`;
  const session = {
    id: 'session-private-1',
    sessionType: 'a2a',
    metabotId: 1,
    peerGlobalMetaId: PEER_GID,
    messages: [],
  };
  const mapping = {
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: 1,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify(options.initialMappingMeta ?? { peerGlobalMetaId: PEER_GID }),
  };
  const metabot = {
    id: 1,
    name: 'Local Bot',
    enabled: true,
    metaid: 'local-metaid',
    globalmetaid: LOCAL_GID,
    allow_chat_skills: ['test-skill'],
  };
  const db = {
    exec(sql) {
      if (/FROM private_chat_messages WHERE is_processed = 0/i.test(sql)) {
        return row.is_processed
          ? []
          : [{ columns, values: [columns.map((column) => row[column])] }];
      }
      return [{ columns: ['found'], values: [] }];
    },
    run(sql, params) {
      if (/UPDATE private_chat_messages SET is_processed = 1 WHERE id = \?/i.test(sql)) {
        row.is_processed = 1;
        assert.deepEqual(params, [row.id]);
      }
    },
  };
  const coworkStore = {
    getConversationMapping(channel, conversationId, metabotId) {
      return channel === 'metaweb_private' && conversationId === externalConversationId && metabotId === 1
        ? mapping
        : null;
    },
    updateConversationMappingMetadata(channel, conversationId, metabotId, metadata) {
      if (channel === 'metaweb_private' && conversationId === externalConversationId && metabotId === 1) {
        mapping.metadataJson = JSON.stringify(metadata);
      }
    },
    getSession(sessionId) {
      return sessionId === session.id ? session : null;
    },
    getSessionWithoutMessages(sessionId) {
      return sessionId === session.id ? session : null;
    },
    getSessionView(sessionId) {
      return sessionId === session.id ? { messages: session.messages } : null;
    },
    getSessionMessagesMatchingMetadataValues() {
      return [];
    },
    getRecentA2AThreadMessages(sessionId, limit = 400) {
      return this.getRecentPrivateA2AMessages(sessionId, limit);
    },
    listA2AConversationEpisodes() {
      return [];
    },
    getRecentPrivateA2AMessages(sessionId, requestedLimit = 100) {
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(1000, Math.floor(requestedLimit)))
        : 100;
      return session.messages
        .filter((message) => (
          (message.type === 'user' || message.type === 'assistant')
          && message.metadata?.sourceChannel === 'metaweb_private'
          && message.metadata?.orderExecutionTrace !== true
        ))
        .slice(-limit);
    },
    getMessageById(sessionId, messageId) {
      return session.messages.find((message) => message.id === messageId) ?? null;
    },
    getConversationSourceContextBySession() {
      return { sourceChannel: 'metaweb_private', externalConversationId };
    },
    isSessionArchived() {
      return false;
    },
    unarchiveSession() {},
    registerA2AEpisode() {},
    isDelegationBlocking() {
      return false;
    },
    setDelegationBlocking() {},
    updateSession(sessionId, updates) {
      if (sessionId === session.id) Object.assign(session, updates);
    },
    upsertConversationMapping() {},
    touchConversationMapping() {},
    deleteConversationMapping() {},
    createSession() {
      return { id: 'session-created-1', messages: [] };
    },
    findOrderSessionByOrderPinId() {
      return null;
    },
    findOrderSessionByOrderTxid() {
      return null;
    },
    findOrderSessionByPeer() {
      return null;
    },
    hasPriorPrivateA2AOutboundMessage() {
      return false;
    },
    ensureCanonicalPeerSessionShape() {
      return true;
    },
    addMessage(sessionId, message) {
      const created = {
        id: `msg-${session.messages.length + 1}`,
        timestamp: 1_770_000_000_000 + session.messages.length,
        ...message,
      };
      session.messages.push(created);
      return created;
    },
    updateMessage(sessionId, messageId, updates) {
      const message = session.messages.find((item) => item.id === messageId);
      if (message) Object.assign(message, updates);
    },
    getConfig() {
      return { workingDirectory: '/tmp/idbots-test' };
    },
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForMetabot() {
          return { memoryEnabled: false };
        },
      };
    },
  };
  const metabotStore = {
    getMetabotByGlobalMetaId(globalMetaId) {
      return globalMetaId === metabot.globalmetaid ? metabot : null;
    },
    getMetabotById() {
      return metabot;
    },
    getMetabotWalletByMetabotId(id) {
      assert.equal(id, metabot.id);
      return { mnemonic: TEST_MNEMONIC, path: "m/44'/10001'/0'/0/0" };
    },
  };
  return {
    db, row, coworkStore, metabotStore, metabot, session, mapping, externalConversationId,
  };
}

async function waitFor(predicate, timeoutMs = 15_000, diagnose) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diag = diagnose ? `\n${diagnose()}` : '';
  assert.fail(`timed out waiting for private chat daemon test condition${diag}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drive the daemon with a scripted A2A reply (the skill-turn seam is the
 * injectable reply path in tests) plus injectable approval/pair-state deps —
 * the daemon/permission layer depth of the S5 verification.
 */
function startFriendInviteDaemon(harness, script) {
  const logs = [];
  const rendererEvents = [];
  const createPinCalls = [];
  const approvalCalls = [];
  const {
    replyText,
    replyTexts,
    approval, // 'approved' | 'denied' | Deferred | undefined (no bridge)
    pairState,
  } = script;
  // Per-turn scripted replies: replyTexts queues distinct lines so later
  // turns don't trip the daemon's verbatim echo-loop guard; replyText is the
  // single-turn shorthand.
  const scriptedReplies = Array.isArray(replyTexts) && replyTexts.length > 0
    ? [...replyTexts]
    : [replyText];
  const createPin = async (_metabotStore, _metabotId, payload, _options) => {
    createPinCalls.push(payload);
    if (payload.path === '/follow') {
      return { txids: ['f'.repeat(64)], pinId: `${'e'.repeat(64)}i3` };
    }
    if (payload.operation === 'revoke') {
      return { txids: ['7'.repeat(64)], pinId: `${'9'.repeat(64)}i1` };
    }
    return { txids: ['5'.repeat(64)], pinId: `${'3'.repeat(64)}i0` };
  };
  const runPrivateChatSkillTurn = async (params) => {
    const turnReplyText = scriptedReplies.length > 1
      ? scriptedReplies.shift()
      : scriptedReplies[0];
    const persisted = harness.coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: turnReplyText,
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: turnReplyText, assistantMessageId: persisted.id };
  };
  const requestFriendActionApproval = approval === undefined
    ? undefined
    : async (params) => {
      approvalCalls.push(params);
      const outcome = typeof approval === 'string' ? approval : await approval.promise;
      return outcome;
    };
  const resolveFriendPairState = pairState === undefined
    ? undefined
    : async () => pairState;
  const stop = startPrivateChatDaemon(
    harness.db,
    () => {},
    harness.coworkStore,
    harness.metabotStore,
    { on() {}, off() {} },
    createPin,
    (message) => logs.push(message),
    null,
    undefined,
    (channel, data) => rendererEvents.push({ channel, data }),
    () => ({ respondToStrangerPrivateChats: true }),
    undefined,
    undefined,
    undefined,
    async () => ({
      prompt: '<available_skills><skill><id>test-skill</id></skill></available_skills>',
      activeSkillIds: ['test-skill'],
    }),
    runPrivateChatSkillTurn,
    // positions 17-23: generateWaitNotice / consumeA2AGuidance /
    // getRecentDailySummaries / refreshA2APeerProfile /
    // getMetaIDCognitionPromptBlock / cerebellumMemoryRanker / getKnowledgeStore
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    requestFriendActionApproval,
    resolveFriendPairState
  );
  return { logs, rendererEvents, createPinCalls, approvalCalls };
}

const followCreateCalls = (calls) => calls.filter((payload) => payload.path === '/follow');
const followRevokeCalls = (calls) => calls.filter((payload) => payload.operation === 'revoke');
const friendNotices = (harness) => harness.session.messages.filter(
  (message) => message.metadata?.privateChatFriendNotice === true
);

test('daemon-approved invite: tag stripped from the delivered reply, /follow written with GlobalMetaID contentBody, mapping records the pin', async () => {
  const harness = createFriendInviteHarness();
  const script = startFriendInviteDaemon(harness, {
    replyText: '好啊，我们加好友吧！\n[FRIEND_INVITE]',
    approval: 'approved',
  });
  try {
    await waitFor(
      () => followCreateCalls(script.createPinCalls).length === 1,
      15_000,
      () => `logs:\n${script.logs.map((line) => '  ' + line).join('\n')}\npins: ${JSON.stringify(script.createPinCalls.map((p) => p.path))}`
    );
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  // The peer-visible reply carries no protocol tag.
  const replyPinCalls = script.createPinCalls.filter((payload) => payload.path === '/protocols/simplemsg');
  assert.equal(replyPinCalls.length, 1);
  assert.equal(replyPinCalls[0].payload.includes('FRIEND_INVITE'), false);
  const assistantBubble = harness.session.messages.find(
    (message) => message.type === 'assistant' && message.metadata?.direction === 'outgoing'
  );
  assert.ok(assistantBubble, 'assistant bubble persisted');
  assert.equal(assistantBubble.content, '好啊，我们加好友吧！');

  // The follow write: create /follow, plain-string GlobalMetaID contentBody.
  const followCalls = followCreateCalls(script.createPinCalls);
  assert.equal(followCalls.length, 1);
  assert.equal(followCalls[0].operation, 'create');
  assert.equal(followCalls[0].payload, PEER_GID);

  // The conversation mapping records the follow pin for later revoke.
  const mappingMeta = JSON.parse(harness.mapping.metadataJson);
  const record = readFriendFollowRecord(mappingMeta);
  assert.equal(record?.pinId, `${'e'.repeat(64)}i3`);

  // One approval was requested for the invite with the peer identity.
  assert.equal(script.approvalCalls.length, 1);
  assert.equal(script.approvalCalls[0].action, 'invite');
  assert.equal(script.approvalCalls[0].peerGlobalMetaId, PEER_GID);

  // Owner-facing local notices: pending + written.
  const notices = friendNotices(harness);
  assert.ok(notices.length >= 2, 'pending + written notices present');
  assert.match(notices[0].content, /已向主人发起|Owner authorization requested/);
  assert.match(notices[notices.length - 1].content, /已写 \/follow|\/follow written/);
  assert.equal(harness.row.is_processed, 1);
});

test('daemon-denied invite: no /follow write, denial notice, reply still delivered', async () => {
  const harness = createFriendInviteHarness();
  const script = startFriendInviteDaemon(harness, {
    replyText: '我们加好友吧，我等我主人确认。\n[FRIEND_INVITE]',
    approval: 'denied',
  });
  try {
    await waitFor(() => friendNotices(harness).some(
      (message) => /未授权|did not authorize/.test(String(message.content))
    ));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(followCreateCalls(script.createPinCalls).length, 0);
  assert.equal(script.approvalCalls.length, 1);
  // The natural-language reply still went out (unauthorized ≠ silent).
  assert.equal(script.createPinCalls.filter((payload) => payload.path === '/protocols/simplemsg').length, 1);
  assert.equal(harness.row.is_processed, 1);
  // No follow pin recorded in the mapping.
  assert.equal(readFriendFollowRecord(JSON.parse(harness.mapping.metadataJson)), null);
});

test('daemon-suspended invite: approval waits unbounded, daemon keeps answering, second invite deduped; late deny writes nothing', async () => {
  const harness = createFriendInviteHarness();
  const gate = deferred();
  const script = startFriendInviteDaemon(harness, {
    replyTexts: [
      '邀请已发出，等我主人确认哈。\n[FRIEND_INVITE]',
      '再催一下我的主人。\n[FRIEND_INVITE]',
      '主人看过授权框了，马上有结果。\n[FRIEND_INVITE]',
    ],
    approval: gate,
  });
  try {
    await waitFor(() => script.approvalCalls.length === 1);
    // The approval is suspended (not resolved) yet the row is fully processed
    // and the reply was delivered — the daemon never blocks on the owner.
    await waitFor(() => harness.row.is_processed === 1);
    assert.equal(script.createPinCalls.filter((payload) => payload.path === '/protocols/simplemsg').length, 1);
    assert.equal(followCreateCalls(script.createPinCalls).length, 0);

    // A second invite while the first authorization is pending is deduped.
    harness.row.is_processed = 0;
    harness.row.id = 2;
    harness.row.pin_id = 'incoming-pin-2';
    await waitFor(() => script.logs.some((line) => /already pending/.test(line)));
    assert.equal(script.approvalCalls.length, 1);

    // The owner finally clicks deny — nothing is written, map is released.
    gate.resolve('denied');
    await waitFor(() => friendNotices(harness).some(
      (message) => /未授权|did not authorize/.test(String(message.content))
    ));
    assert.equal(followCreateCalls(script.createPinCalls).length, 0);

    // After release, a fresh invite may ask again (dedupe key cleared).
    harness.row.is_processed = 0;
    harness.row.id = 3;
    harness.row.pin_id = 'incoming-pin-3';
    await waitFor(() => script.approvalCalls.length === 2);
    gate.resolve('denied');
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }
  assert.equal(script.approvalCalls.length >= 2, true);
});

test('invite gate: already-friends pair skips the owner ask entirely', async () => {
  const harness = createFriendInviteHarness();
  const script = startFriendInviteDaemon(harness, {
    replyText: '好啊！\n[FRIEND_INVITE]',
    approval: 'approved',
    pairState: { status: 'confirmed', blocking: false, blockedBy: false },
  });
  try {
    await waitFor(() => friendNotices(harness).some(
      (message) => /已经是链上好友|Already on-chain friends/.test(String(message.content))
    ));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }
  assert.equal(script.approvalCalls.length, 0);
  assert.equal(followCreateCalls(script.createPinCalls).length, 0);
});

test('invite gate: blocked pair (either direction) skips the owner ask', async () => {
  const harness = createFriendInviteHarness();
  const script = startFriendInviteDaemon(harness, {
    replyText: '加好友吧\n[FRIEND_INVITE]',
    approval: 'approved',
    pairState: { status: 'not_confirmed', blocking: null, blockedBy: true },
  });
  try {
    await waitFor(() => friendNotices(harness).some(
      (message) => /拉黑|block is active/.test(String(message.content))
    ));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }
  assert.equal(script.approvalCalls.length, 0);
  assert.equal(followCreateCalls(script.createPinCalls).length, 0);
});

test('remove flow: approved revoke targets the recorded follow pin and clears the mapping record', async () => {
  const harness = createFriendInviteHarness({
    initialMappingMeta: {
      peerGlobalMetaId: PEER_GID,
      [FRIEND_FOLLOW_PIN_METADATA_KEY]: { pinId: FOLLOW_PIN_ID, txid: 'b'.repeat(64), followedAt: 1 },
    },
  });
  const script = startFriendInviteDaemon(harness, {
    replyText: '我们到此为止吧。\n[FRIEND_REMOVE]',
    approval: 'approved',
  });
  try {
    await waitFor(() => followRevokeCalls(script.createPinCalls).length === 1);
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }
  const revokeCalls = followRevokeCalls(script.createPinCalls);
  assert.equal(revokeCalls.length, 1);
  assert.equal(revokeCalls[0].path, `/follow@${FOLLOW_PIN_ID}`);
  assert.equal(script.approvalCalls[0].action, 'remove');
  assert.equal(readFriendFollowRecord(JSON.parse(harness.mapping.metadataJson)), null);
  assert.match(
    friendNotices(harness).at(-1).content,
    /已取消关注|Unfollowed/
  );
});

test('remove without a recorded follow pin asks nobody and writes nothing', async () => {
  const harness = createFriendInviteHarness();
  const script = startFriendInviteDaemon(harness, {
    replyText: '就此别过。\n[FRIEND_REMOVE]',
    approval: 'approved',
  });
  try {
    await waitFor(() => friendNotices(harness).some(
      (message) => /没有记录到|no locally recorded/i.test(String(message.content))
    ));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }
  assert.equal(script.approvalCalls.length, 0);
  assert.equal(script.createPinCalls.filter((payload) => payload.operation === 'revoke').length, 0);
});

test('no approval bridge wired (older harness): tag still stripped, no crash, no chain write', async () => {
  const harness = createFriendInviteHarness();
  const script = startFriendInviteDaemon(harness, {
    replyText: '加好友吧\n[FRIEND_INVITE]',
    approval: undefined,
  });
  try {
    await waitFor(() => harness.row.is_processed === 1);
    await waitFor(() => script.logs.some((line) => /no approval bridge/.test(line)));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }
  assert.equal(followCreateCalls(script.createPinCalls).length, 0);
  const replyPinCalls = script.createPinCalls.filter((payload) => payload.path === '/protocols/simplemsg');
  assert.equal(replyPinCalls.length, 1);
  assert.equal(replyPinCalls[0].payload.includes('FRIEND_INVITE'), false);
});

test('bare invite tag with no prose still delivers a fallback sentence to the peer', async () => {
  const harness = createFriendInviteHarness();
  const script = startFriendInviteDaemon(harness, {
    replyText: '[FRIEND_INVITE]',
    approval: 'denied',
  });
  try {
    await waitFor(() => harness.row.is_processed === 1);
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }
  const replyPinCalls = script.createPinCalls.filter((payload) => payload.path === '/protocols/simplemsg');
  assert.equal(replyPinCalls.length, 1);
  const assistantBubble = harness.session.messages.find(
    (message) => message.type === 'assistant' && message.metadata?.direction === 'outgoing'
  );
  assert.ok(assistantBubble.content.length > 10, 'fallback sentence delivered');
  assert.equal(assistantBubble.content.includes('FRIEND_INVITE'), false);
});


test('ordinary private-chat skill turns advertise generic owner approval without double-requesting friend actions', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local' },
    analysis: analysisBase,
    skillsPrompt: '<available_skills>skill-a</available_skills>',
  });
  assert.match(prompt, /request_user_permission/);
  assert.match(prompt, /OWNER_APPROVED/);
  assert.match(prompt, /OWNER_DENIED/);
  assert.match(prompt, /payments? or transfers|payment\/transfer/i);
  assert.match(prompt, /larger than 20 MiB/);
  assert.match(prompt, /file_size_bytes/);
  assert.match(prompt, /Ordinary chain writes and file uploads at or below 20 MiB proceed directly/);
  assert.doesNotMatch(prompt, /paid or irreversible chain write/);
  assert.match(prompt, /keep using the dedicated friend tags/);
  assert.match(prompt, /must not be doubled/);

  const byePrompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local' },
    analysis: { ...analysisBase, shouldForceBye: true },
    skillsPrompt: '<available_skills>skill-a</available_skills>',
  });
  assert.doesNotMatch(byePrompt, /request_user_permission/);

  const noToolPrompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local' },
    analysis: analysisBase,
  });
  assert.doesNotMatch(noToolPrompt, /request_user_permission/);
});
