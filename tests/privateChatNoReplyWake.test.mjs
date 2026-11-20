import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
let buildPrivateChatA2AWakeNotice;
let buildPrivateChatA2ASystemPrompt;
let nextPrivateChatA2AWakeAt;
let setPrivateChatA2AWakeDelaysForTests;
let setPrivateChatA2APromiseWakeDelaysForTests;
let PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS;
let PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS;
try {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    buildPrivateChatA2AWakeNotice,
    buildPrivateChatA2ASystemPrompt,
    nextPrivateChatA2AWakeAt,
    setPrivateChatA2AWakeDelaysForTests,
    setPrivateChatA2APromiseWakeDelaysForTests,
    PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS,
    PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    buildPrivateChatA2AWakeNotice,
    buildPrivateChatA2ASystemPrompt,
    nextPrivateChatA2AWakeAt,
    setPrivateChatA2AWakeDelaysForTests,
    setPrivateChatA2APromiseWakeDelaysForTests,
    PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS,
    PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
}

test('A2A system prompt forbids silence while a deferred answer is owed', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local Bot' },
    analysis: {
      contextMessages: [],
      incomingTurnCount: 1,
      shouldForceBye: false,
    },
  });
  assert.ok(
    prompt.includes('check what YOU still owe the peer'),
    'the owed-reply check should precede the silence decision in every A2A turn prompt'
  );
  assert.ok(prompt.includes('leaves both sides waiting forever'));
  assert.ok(prompt.includes('needs no answer AND you owe the peer nothing'));
});

test('wake notice explains the timer, the owed-reply option, and the exits', () => {
  const notice = buildPrivateChatA2AWakeNotice(2);
  assert.ok(notice.includes('Host Wake Check 2'), 'notice should name the fire');
  assert.ok(notice.includes('no new peer message arrived'));
  assert.ok(notice.includes('deliver it now as your final text'));
  assert.ok(notice.includes('"bye"'));
  assert.ok(notice.includes('[NO_REPLY]'));
  assert.ok(buildPrivateChatA2AWakeNotice(Number.NaN).includes('Host Wake Check 1'));
});

test('wake schedule is bounded by its delay ladder', () => {
  const now = Date.now();
  assert.equal(nextPrivateChatA2AWakeAt(0, now), now + PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS[0]);
  assert.equal(nextPrivateChatA2AWakeAt(1, now), now + PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS[1]);
  assert.equal(
    nextPrivateChatA2AWakeAt(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS.length, now),
    null,
    'budget exhausted after one fire per ladder step'
  );
  // D3: rows carrying an outstanding wait-notice promise use the denser
  // owed-reply ladder — every observed dangling promise died inside the
  // generic +2h gap.
  assert.equal(nextPrivateChatA2AWakeAt(0, now, PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS), now + PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS[0]);
  assert.equal(nextPrivateChatA2AWakeAt(2, now, PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS), now + PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS[2]);
  assert.equal(
    nextPrivateChatA2AWakeAt(PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS.length, now, PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS),
    null,
    'the promise ladder exhausts too'
  );
  try {
    setPrivateChatA2AWakeDelaysForTests([100, 200]);
    assert.equal(nextPrivateChatA2AWakeAt(1, now), now + 200);
    assert.equal(nextPrivateChatA2AWakeAt(2, now), null);
    // Non-positive entries are dropped from the test override.
    setPrivateChatA2AWakeDelaysForTests([100, -5]);
    assert.equal(nextPrivateChatA2AWakeAt(1, now), null);
    setPrivateChatA2APromiseWakeDelaysForTests([150]);
    assert.equal(nextPrivateChatA2AWakeAt(1, now, [150]), null);
  } finally {
    setPrivateChatA2AWakeDelaysForTests(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS);
    setPrivateChatA2APromiseWakeDelaysForTests(PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS);
  }
});

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createWakeDaemonHarness() {
  const row = {
    id: 1,
    pin_id: 'incoming-pin-wake-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: 'The verification anchors are ready — I will wait silently for your complete reply.',
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
  const externalConversationId = 'metaweb-private:peer-global';
  const session = {
    id: 'session-private-1',
    sessionType: 'a2a',
    metabotId: 1,
    peerGlobalMetaId: 'peer-global',
    messages: [
      // Established conversation: a prior delivered outbound so the daemon
      // treats this peer as one we are actively talking to (wake arming
      // requires prior local outbound).
      {
        id: 'msg-seed-outbound',
        timestamp: 1_770_000_000_000,
        type: 'assistant',
        content: 'Received — give me a moment to verify these points and I will come back with the complete reply.',
        metadata: {
          sourceChannel: 'metaweb_private',
          externalConversationId,
          direction: 'outgoing',
          privateChatDeliveryStatus: 'sent',
        },
      },
    ],
  };
  const mapping = {
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: 1,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({ peerGlobalMetaId: 'peer-global' }),
  };
  const metabot = {
    id: 1,
    name: 'Local Bot',
    enabled: true,
    metaid: 'local-metaid',
    globalmetaid: 'local-global',
    allow_chat_skills: ['metaid-master-wiki'],
  };
  const db = {
    exec(sql, params = []) {
      if (/FROM private_chat_messages WHERE is_processed = 0/i.test(sql)) {
        return row.is_processed
          ? []
          : [{ columns, values: [columns.map((column) => row[column])] }];
      }
      // Parameterized single-row lookups (owed-reply boot restore).
      if (/FROM private_chat_messages WHERE/i.test(sql)) {
        let match = true;
        let paramIndex = 0;
        if (/\bid = \?/i.test(sql)) {
          match = match && Number(params[paramIndex]) === row.id;
          paramIndex += 1;
        }
        if (/pin_id = \?/i.test(sql)) {
          match = match && String(params[paramIndex]) === row.pin_id;
          paramIndex += 1;
        }
        return match && row.id != null
          ? [{ columns, values: [columns.map((column) => row[column])] }]
          : [{ columns: ['id'], values: [] }];
      }
      return [{ columns: ['found'], values: [] }];
    },
    run(sql, params) {
      if (/UPDATE private_chat_messages SET is_processed = 1 WHERE id = \?/i.test(sql)) {
        row.is_processed = 1;
        assert.deepEqual(params, [row.id]);
      } else if (/UPDATE private_chat_messages SET is_processed = 0 WHERE id = \?/i.test(sql)) {
        row.is_processed = 0;
        assert.deepEqual(params, [row.id]);
      }
    },
  };
  const coworkStore = {
    // kv ledger backing (owed-reply promise records) — mirrors the real
    // CoworkStore's string-oriented kv contract.
    kvData: new Map(),
    getKvString(key) {
      return this.kvData.get(key) ?? null;
    },
    setKvString(key, value) {
      this.kvData.set(key, value);
    },
    deleteKvKey(key) {
      this.kvData.delete(key);
    },
    listKvKeysWithPrefix(prefix) {
      return [...this.kvData.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    listRecentUnfulfilledPrivateChatWaitNotices(sinceMs, limit = 200) {
      const notices = [];
      for (const message of session.messages) {
        const meta = message.metadata ?? {};
        if (message.type !== 'assistant' || meta.privateChatSkillWaitNotice !== true) continue;
        const pin = typeof meta.privateChatSkillWaitNoticeForPinId === 'string'
          ? meta.privateChatSkillWaitNoticeForPinId
          : '';
        if (!pin) continue;
        const hasReply = session.messages.some((item) => (
          item.metadata?.privateChatReplyForPinId === pin
          && item.metadata?.privateChatDeliveryStatus === 'sent'
        ));
        const hasRetraction = session.messages.some((item) => (
          item.metadata?.privateChatWaitNoticeRetractionForPinId === pin
        ));
        if (hasReply || hasRetraction) continue;
        const promisedAt = message.timestamp ?? 0;
        if (promisedAt <= sinceMs) continue;
        notices.push({
          sessionId: session.id,
          messageId: message.id,
          pinId: pin,
          externalConversationId: typeof meta.externalConversationId === 'string'
            ? meta.externalConversationId
            : null,
          promisedAt,
        });
        if (notices.length >= limit) break;
      }
      return notices;
    },
    getConversationMapping(channel, conversationId, metabotId) {
      return channel === 'metaweb_private' && conversationId === externalConversationId && metabotId === 1
        ? mapping
        : null;
    },
    getSession(sessionId) {
      return sessionId === session.id ? session : null;
    },
    getSessionWithoutMessages(sessionId) {
      return sessionId === session.id ? session : null;
    },
    getSessionMessagesMatchingMetadataValues(sessionId, values, limit = 50) {
      const needles = (Array.isArray(values) ? values : [values])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
      if (needles.length === 0) return [];
      return session.messages
        .filter((message) => needles.some((needle) => JSON.stringify(message.metadata ?? {}).includes(needle)))
        .reverse()
        .slice(0, limit);
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
    hasPriorPrivateA2AOutboundMessage(sessionId) {
      return session.messages.some((message) => (
        message.type === 'assistant'
        && message.metadata?.sourceChannel === 'metaweb_private'
        && String(message.content ?? '').trim() !== ''
      ));
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
    updateConversationMappingMetadata() {},
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
      return null;
    },
    getMetabotWalletByMetabotId(id) {
      assert.equal(id, metabot.id);
      return { mnemonic: TEST_MNEMONIC, path: "m/44'/10001'/0'/0/0" };
    },
  };
  return { db, row, coworkStore, metabotStore, metabot, session, externalConversationId };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for private chat daemon test condition');
}

function startWakeHarnessDaemon(harness, logs, skillTurnImpl, notifyOwner) {
  let createPinCount = 0;
  const skillTurnCalls = [];
  startPrivateChatDaemon(
    harness.db,
    () => {},
    harness.coworkStore,
    harness.metabotStore,
    { on() {}, off() {} },
    async () => {
      createPinCount += 1;
      return { txids: ['t'.repeat(64)], pinId: 'p'.repeat(64) + 'i0' };
    },
    (message) => logs.push(message),
    null,
    undefined,
    undefined,
    () => ({ respondToStrangerPrivateChats: true }),
    undefined,
    undefined,
    undefined,
    async () => ({
      prompt: '<available_skills><skill><id>metaid-master-wiki</id></skill></available_skills>',
      activeSkillIds: ['metaid-master-wiki'],
    }),
    async (params) => {
      skillTurnCalls.push(params);
      return skillTurnImpl(params, skillTurnCalls.length, harness.coworkStore);
    },
    async () => '我需要查询一下，请稍等。',
    // consumeA2AGuidance, getRecentDailySummaries, refreshA2APeerProfile,
    // getMetaIDCognitionPromptBlock, cerebellumMemoryRanker,
    // getKnowledgeStore, requestFriendActionApproval, resolveFriendPairState:
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    notifyOwner
  );
  return {
    get createPinCount() {
      return createPinCount;
    },
    skillTurnCalls,
  };
}

// 2026-09-16 deadlock shape: our bot promised a deferred answer, the peer's
// latest message says they will wait silently, and the model answers with
// [NO_REPLY]. Without a wake the conversation dies; with it, the host
// re-drives the same row on a timer and the model delivers the owed reply.
test('wake re-drives a silent decision and delivers the owed reply', async () => {
  setPrivateChatA2AWakeDelaysForTests([300]);
  const harness = createWakeDaemonHarness();
  const logs = [];
  const handle = startWakeHarnessDaemon(harness, logs, (params, call, coworkStore) => {
    if (call === 1) {
      coworkStore.addMessage(params.sessionId, {
        type: 'assistant',
        content: '[NO_REPLY]',
        metadata: { isStreaming: false, isFinal: true },
      });
      return { replyText: '[NO_REPLY]', assistantMessageId: null };
    }
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: 'Verification complete — here is the full reply I owed you.',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: 'Verification complete — here is the full reply I owed you.', assistantMessageId: persisted.id };
  });

  try {
    await waitFor(() => logs.some((message) => message.includes('Wake 1 scheduled')), 20_000);
    await waitFor(() => logs.some((message) => message.includes('Wake 1 fired')), 20_000);
    await waitFor(() => logs.some((message) => message.includes('Replied to')), 20_000);
    // The delivered reply cancels the wake: no further turns may run.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2AWakeDelaysForTests(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS);
  }

  assert.equal(handle.skillTurnCalls.length, 2, 'exactly one wake turn should follow the silent decision');
  assert.ok(!handle.skillTurnCalls[0].systemPrompt.includes('Host Wake Check'), 'original turn has no wake notice');
  assert.ok(handle.skillTurnCalls[1].systemPrompt.includes('Host Wake Check'), 'wake turn carries the wake notice');
  assert.ok(handle.skillTurnCalls[1].systemPrompt.includes('no new peer message arrived'));
  assert.equal(harness.row.is_processed, 1);
  assert.equal(handle.createPinCount, 1);
  assert.ok(
    harness.session.messages.some((message) => message.metadata?.privateChatWakeNotice === true),
    'a host wake bubble should be persisted for owner visibility'
  );
  const delivered = harness.session.messages.find(
    (message) => message.content === 'Verification complete — here is the full reply I owed you.'
  );
  assert.equal(delivered?.metadata?.privateChatDeliveryStatus, 'sent');
});

// A conversation that stays silent through every wake must stop after the
// budget is exhausted instead of polling the model forever.
test('wake budget is exhausted after the configured fires', async () => {
  setPrivateChatA2AWakeDelaysForTests([300, 300, 300]);
  const harness = createWakeDaemonHarness();
  const logs = [];
  const handle = startWakeHarnessDaemon(harness, logs, (params, call, coworkStore) => {
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: '[NO_REPLY]',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: '[NO_REPLY]', assistantMessageId: persisted.id };
  });

  try {
    await waitFor(() => logs.some((message) => message.includes('Wake budget exhausted')), 60_000);
    // No further wake may fire after exhaustion.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2AWakeDelaysForTests(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS);
  }

  assert.equal(handle.skillTurnCalls.length, 4, 'original turn + 3 wake fires, then stop');
  assert.equal(harness.row.is_processed, 1);
  assert.equal(handle.createPinCount, 0, 'a permanently silent conversation delivers nothing on-chain');
  const wakeTurns = handle.skillTurnCalls.filter((params) => params.systemPrompt.includes('Host Wake Check'));
  assert.equal(wakeTurns.length, 3);
});

// 2026-11-21 02:10 incident (full shape): the wait notice promised "稍后给你
// 确认", the turn settled [NO_REPLY], and the wake chain silently died. The
// fixed lifecycle: ordinary silent settlements keep the promise alive for the
// promise-aware wakes (the wake prompt carries the exact promise text and
// forbids [NO_REPLY]); the peer-facing retraction, the owner system row, the
// desktop push and the ledger clear all fire together ONLY at final death.
test('owed-reply promise: wake chain retracts only at final death and notifies the owner', async () => {
  setPrivateChatA2APromiseWakeDelaysForTests([300, 300]);
  const harness = createWakeDaemonHarness();
  const logs = [];
  const ownerNotifications = [];
  const handle = startWakeHarnessDaemon(harness, logs, async (params, call, coworkStore) => {
    if (call === 1) {
      // Skill execution starts: the wait-notice pipeline broadcasts the ack.
      await params.onSkillExecutionStart?.();
    }
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: '[NO_REPLY]',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: '[NO_REPLY]', assistantMessageId: persisted.id };
  }, (notification) => ownerNotifications.push(notification));

  try {
    await waitFor(() => logs.some((message) => message.includes('Sent wait-notice retraction')), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2APromiseWakeDelaysForTests(PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS);
  }

  const retractions = harness.session.messages.filter(
    (message) => message.metadata?.privateChatWaitNoticeRetraction === true,
  );
  assert.equal(retractions.length, 1, 'exactly one retraction, at final death only');
  assert.equal(retractions[0].metadata.privateChatWaitNoticeRetractionForPinId, harness.row.pin_id);
  assert.equal(retractions[0].metadata.privateChatDeliveryStatus, 'sent');

  // Fulfillment first: two wake turns ran BEFORE the retraction, and each of
  // them saw the promise text with the forbidden-silence instruction (D1).
  assert.equal(handle.skillTurnCalls.length, 3, 'original turn + two promise-ladder wakes');
  for (const wakeCall of handle.skillTurnCalls.slice(1)) {
    assert.ok(wakeCall.systemPrompt.includes('Host Wake Check'), 'wake turns carry the wake notice');
    assert.ok(
      wakeCall.systemPrompt.includes('我需要查询一下，请稍等。'),
      'the wake prompt carries the exact promise text (D1)',
    );
    assert.ok(
      wakeCall.systemPrompt.includes('must NOT answer `[NO_REPLY]`'),
      'the wake prompt forbids silence while the promise stands (D1)',
    );
  }
  const firstRetractionIndex = harness.session.messages.findIndex(
    (message) => message.metadata?.privateChatWaitNoticeRetraction === true,
  );
  const lastWakeBubbleIndex = harness.session.messages.reduce((last, message, index) => (
    message.metadata?.privateChatWakeNotice === true ? index : last
  ), -1);
  assert.ok(
    lastWakeBubbleIndex >= 0 && lastWakeBubbleIndex < firstRetractionIndex,
    'the retraction fires only after the wake chain ran out',
  );

  // D4: the human learns about the give-up via a session system row + push.
  const gaveUpRows = harness.session.messages.filter(
    (message) => message.metadata?.privateChatOwedReplyGaveUp === true,
  );
  assert.equal(gaveUpRows.length, 1, 'one give-up system row for the owner');
  assert.equal(ownerNotifications.length, 1, 'one desktop notification for the owner');
  assert.equal(ownerNotifications[0].sessionId, harness.session.id);

  // D2: the promise ledger is settled once the give-up ran.
  assert.equal(
    harness.coworkStore.kvData.has(`privateChatOwedReply/${harness.row.pin_id}`),
    false,
    'the promise ledger record is cleared at final death',
  );
  assert.equal(harness.row.is_processed, 1);
});

// A delivered reply fulfills the promise: no retraction, and the ledger
// record is settled at delivery time (not only at final death).
test('delivered reply after a wait notice sends no retraction and settles the ledger', async () => {
  setPrivateChatA2APromiseWakeDelaysForTests([300, 300]);
  const harness = createWakeDaemonHarness();
  const logs = [];
  const ownerNotifications = [];
  const replyText = '更正已递。回你三处：①紧迫度认账 ②充值闸三层 ③读数必带时刻';
  const handle = startWakeHarnessDaemon(harness, logs, async (params, call, coworkStore) => {
    if (call === 1) {
      await params.onSkillExecutionStart?.();
    }
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: replyText,
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText, assistantMessageId: persisted.id };
  }, (notification) => ownerNotifications.push(notification));

  try {
    // The whole turn (notice + record + reply + settle) completes within one
    // poll window; the recorded log proves the D2 write happened, and the
    // post-delivery assert below proves the ledger settled.
    await waitFor(() => logs.some((message) => message.includes('Owed-reply promise recorded')), 20_000);
    await waitFor(() => logs.some((message) => message.includes('Replied to')), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2APromiseWakeDelaysForTests(PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS);
  }

  assert.equal(handle.skillTurnCalls.length, 1, 'the delivered reply cancels the wake — no second turn');
  assert.equal(
    handle.createPinCount,
    2,
    'notice + reply broadcast only; no retraction pin',
  );
  assert.equal(
    harness.session.messages.some((message) => message.metadata?.privateChatWaitNoticeRetraction === true),
    false,
    'a delivered reply needs no retraction',
  );
  assert.equal(
    harness.coworkStore.kvData.has(`privateChatOwedReply/${harness.row.pin_id}`),
    false,
    'the promise ledger is settled on delivery (D2)',
  );
  assert.equal(ownerNotifications.length, 0, 'no owner push when the promise was fulfilled');
});

// D2 boot restore: a restart must resurrect the owed-reply wake chain from
// the kv ledger instead of letting the promise die with the old process
// (the exact 2026-11-21 03:10 failure).
test('boot restore re-arms the owed-reply wake from the ledger after a restart', async () => {
  setPrivateChatA2APromiseWakeDelaysForTests([300]);
  const harness = createWakeDaemonHarness();
  // The previous process already broadcast the promise and went silent.
  harness.row.is_processed = 1;
  harness.session.messages.push({
    id: 'msg-seeded-notice',
    timestamp: Date.now(),
    type: 'assistant',
    content: '我需要查询一下，请稍等。',
    metadata: {
      sourceChannel: 'metaweb_private',
      externalConversationId: harness.externalConversationId,
      direction: 'outgoing',
      privateChatSkillWaitNotice: true,
      privateChatSkillWaitNoticeForPinId: harness.row.pin_id,
      privateChatDeliveryStatus: 'sent',
      suppressRunningStatus: true,
    },
  });
  harness.coworkStore.setKvString(
    `privateChatOwedReply/${harness.row.pin_id}`,
    JSON.stringify({
      version: 1,
      pinId: harness.row.pin_id,
      sessionId: harness.session.id,
      metabotId: 1,
      externalConversationId: harness.externalConversationId,
      rowId: harness.row.id,
      fromGlobalMetaId: 'peer-global',
      fromMetaId: 'peer-metaid',
      toGlobalMetaId: 'local-global',
      toMetaId: 'local-metaid',
      promisedAt: Date.now(),
      fires: 0,
    }),
  );
  const logs = [];
  const handle = startWakeHarnessDaemon(harness, logs, async (params, call, coworkStore) => {
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: '核对完成：更新口径后的算式余量 ≈93,700 条，与你的复帧一致。',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: '核对完成：更新口径后的算式余量 ≈93,700 条，与你的复帧一致。', assistantMessageId: persisted.id };
  });

  try {
    await waitFor(() => logs.some((message) => message.includes('Wake 1 scheduled') && message.includes('owed-reply promise ladder')), 20_000);
    await waitFor(() => logs.some((message) => message.includes('Replied to')), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2APromiseWakeDelaysForTests(PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS);
  }

  assert.equal(handle.skillTurnCalls.length, 1, 'the restored wake delivered the promised reply');
  assert.ok(
    handle.skillTurnCalls[0].systemPrompt.includes('Host Wake Check'),
    'the restored turn runs as a wake turn',
  );
  assert.ok(
    handle.skillTurnCalls[0].systemPrompt.includes('我需要查询一下，请稍等。'),
    'the restored wake sees the promise text (D1)',
  );
  assert.equal(
    harness.coworkStore.kvData.has(`privateChatOwedReply/${harness.row.pin_id}`),
    false,
    'the fulfilled promise settles the ledger',
  );
  assert.equal(harness.row.is_processed, 1);
});

// D2 boot sweep: promises that predate the ledger (transcript-only, the
// shipped-code dangling shape) are seeded from the transcript within the TTL
// and re-armed; promises past the TTL are retired with a log line.
test('boot sweep seeds transcript-only promises and retires expired ones', async () => {
  setPrivateChatA2APromiseWakeDelaysForTests([300]);
  const harness = createWakeDaemonHarness();
  harness.row.is_processed = 1;
  harness.session.messages.push({
    id: 'msg-seeded-notice',
    timestamp: Date.now(),
    type: 'assistant',
    content: '收到，信息量不小，我需要一点时间核对这几项账目，稍等片刻再给你回执。',
    metadata: {
      sourceChannel: 'metaweb_private',
      externalConversationId: harness.externalConversationId,
      direction: 'outgoing',
      privateChatSkillWaitNotice: true,
      privateChatSkillWaitNoticeForPinId: harness.row.pin_id,
      privateChatDeliveryStatus: 'sent',
      suppressRunningStatus: true,
    },
  });
  const logs = [];
  const handle = startWakeHarnessDaemon(harness, logs, async (params, call, coworkStore) => {
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: '核对完毕：三项账目都对上了。',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: '核对完毕：三项账目都对上了。', assistantMessageId: persisted.id };
  });

  try {
    await waitFor(() => logs.some((message) => message.includes('Wake 1 scheduled') && message.includes('owed-reply promise ladder')), 20_000);
    assert.equal(
      harness.coworkStore.kvData.has(`privateChatOwedReply/${harness.row.pin_id}`),
      true,
      'the sweep seeds the ledger so the next restart resumes from it',
    );
    await waitFor(() => logs.some((message) => message.includes('Replied to')), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2APromiseWakeDelaysForTests(PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS);
  }

  assert.equal(handle.skillTurnCalls.length, 1, 'the swept promise delivered the promised reply');
});

test('boot restore retires promises older than the TTL without arming a wake', async () => {
  setPrivateChatA2APromiseWakeDelaysForTests([300]);
  const harness = createWakeDaemonHarness();
  harness.row.is_processed = 1;
  harness.session.messages.push({
    id: 'msg-seeded-notice',
    timestamp: Date.now() - 26 * 60 * 60_000,
    type: 'assistant',
    content: '收到，先核对。',
    metadata: {
      sourceChannel: 'metaweb_private',
      externalConversationId: harness.externalConversationId,
      direction: 'outgoing',
      privateChatSkillWaitNotice: true,
      privateChatSkillWaitNoticeForPinId: harness.row.pin_id,
      privateChatDeliveryStatus: 'sent',
      suppressRunningStatus: true,
    },
  });
  const logs = [];
  const handle = startWakeHarnessDaemon(harness, logs, async (params, call, coworkStore) => {
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: 'should never run',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: 'should never run', assistantMessageId: persisted.id };
  });

  try {
    await waitFor(() => logs.some((message) => message.includes('Owed-reply restore:')), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2APromiseWakeDelaysForTests(PRIVATE_CHAT_A2A_PROMISE_WAKE_DELAYS_MS);
  }

  assert.equal(handle.skillTurnCalls.length, 0, 'expired promises never re-arm a wake');
  assert.equal(
    harness.coworkStore.kvData.has(`privateChatOwedReply/${harness.row.pin_id}`),
    false,
    'expired promises are retired from the ledger',
  );
  assert.equal(harness.row.is_processed, 1, 'the row stays processed — no silent re-drive');
});
