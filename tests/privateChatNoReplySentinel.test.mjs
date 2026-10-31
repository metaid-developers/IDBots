import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
let PRIVATE_CHAT_NO_REPLY_SENTINEL;
let isPrivateChatNoReplySentinel;
let shouldSkipPrivateChatAutoReplyText;
let isRepeatPrivateChatInboundMessage;
let wouldCreatePrivateChatEchoLoop;
let buildPrivateChatA2ASystemPrompt;
let extractFinalAssistantReply;
let shouldHideA2AInternalMessage;
try {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    PRIVATE_CHAT_NO_REPLY_SENTINEL,
    isPrivateChatNoReplySentinel,
    shouldSkipPrivateChatAutoReplyText,
    isRepeatPrivateChatInboundMessage,
    wouldCreatePrivateChatEchoLoop,
    buildPrivateChatA2ASystemPrompt,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({ extractFinalAssistantReply } = await import('../dist-electron/main/services/orchestratorCoworkBridge.js'));
  ({ shouldHideA2AInternalMessage } = await import('../dist-electron/main/shared/a2aInternalMessageFilter.js'));
} catch {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    PRIVATE_CHAT_NO_REPLY_SENTINEL,
    isPrivateChatNoReplySentinel,
    shouldSkipPrivateChatAutoReplyText,
    isRepeatPrivateChatInboundMessage,
    wouldCreatePrivateChatEchoLoop,
    buildPrivateChatA2ASystemPrompt,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({ extractFinalAssistantReply } = await import('../dist-electron/main/services/orchestratorCoworkBridge.js'));
  ({ shouldHideA2AInternalMessage } = await import('../dist-electron/main/shared/a2aInternalMessageFilter.js'));
}

test('sentinel matches exact tag with cosmetic wrapping only', () => {
  assert.equal(PRIVATE_CHAT_NO_REPLY_SENTINEL, '[NO_REPLY]');
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY]'), true);
  assert.equal(isPrivateChatNoReplySentinel('  [NO_REPLY]  '), true);
  assert.equal(isPrivateChatNoReplySentinel('[no_reply]'), true);
  assert.equal(isPrivateChatNoReplySentinel('`[NO_REPLY]`'), true);
  assert.equal(isPrivateChatNoReplySentinel('“[NO_REPLY]”'), true);
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY].'), true);
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY]。'), true);
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY]！'), true);
  // Anything with real content is a genuine reply — never silently dropped.
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY] 好的，等我结果'), false);
  assert.equal(isPrivateChatNoReplySentinel('好的，[NO_REPLY]'), false);
  assert.equal(isPrivateChatNoReplySentinel('（保持静默。）'), false);
  assert.equal(isPrivateChatNoReplySentinel(''), false);
  assert.equal(isPrivateChatNoReplySentinel(null), false);
  assert.equal(isPrivateChatNoReplySentinel(undefined), false);
});

test('inbound sentinel from an unupgraded peer is skipped like a placeholder', () => {
  assert.equal(shouldSkipPrivateChatAutoReplyText('[NO_REPLY]'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('[no_reply] '), true);
});

test('inbound verbatim retransmission of the previous inbound message is detected by byte equality only', () => {
  const now = 1_790_000_000_000;
  const incoming = (id, content, timestamp) => ({
    id,
    type: 'user',
    content,
    timestamp,
    metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
  });
  const outgoing = (id, content, timestamp) => ({
    id,
    type: 'assistant',
    content,
    timestamp,
    metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', privateChatDeliveryStatus: 'sent' },
  });
  // 2026-09-17 loop shape: the peer re-sends the same silence note.
  const messages = [
    incoming('i1', '（静默。）', now - 90_000),
    outgoing('o1', '（静默。）', now - 80_000),
    incoming('i2', '（静默。）', now - 30_000),
  ];
  assert.equal(isRepeatPrivateChatInboundMessage({ messages, plaintext: '（静默。）', now }), true);
  // Any different text (whitespace aside) is new information.
  assert.equal(isRepeatPrivateChatInboundMessage({ messages, plaintext: '（静默——我先等等。）', now }), false);
  assert.equal(isRepeatPrivateChatInboundMessage({ messages, plaintext: '  （静默。）  ', now }), true);
  // The comparison target is the previous INBOUND message, not our own reply.
  assert.equal(isRepeatPrivateChatInboundMessage({ messages, plaintext: 'nudge', now }), false);
  // A retransmission after the conversation gap (5 min) starts a new segment.
  const staleSegment = [
    incoming('i1', '（静默。）', now - 10 * 60_000),
    outgoing('o1', '（静默。）', now - 9 * 60_000),
    incoming('i2', '（静默。）', now - 8 * 60_000),
  ];
  assert.equal(isRepeatPrivateChatInboundMessage({ messages: staleSegment, plaintext: '（静默。）', now }), false);
  // No prior inbound at all → never a repeat.
  assert.equal(isRepeatPrivateChatInboundMessage({ messages: [outgoing('o1', 'x', now - 1000)], plaintext: 'x', now }), false);
  assert.equal(isRepeatPrivateChatInboundMessage({ messages: [], plaintext: 'x', now }), false);
});

test('echo-loop guard fires only on a verbatim repeat of delivered outgoing replies', () => {
  const now = 1_790_000_000_000;
  const mk = (id, content, timestamp, metadata = {}) => ({
    id,
    type: 'assistant',
    content,
    timestamp,
    metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', privateChatDeliveryStatus: 'sent', ...metadata },
  });
  const incoming = (id, content, timestamp) => ({
    id,
    type: 'user',
    content,
    timestamp,
    metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
  });
  const silence = '（静默。）';
  // Converged loop tail: two identical delivered replies interleaved with inbound notes.
  const loopTail = [
    mk('o1', silence, now - 90_000),
    incoming('i1', silence, now - 80_000),
    mk('o2', silence, now - 70_000),
    incoming('i2', silence, now - 30_000),
  ];
  assert.equal(wouldCreatePrivateChatEchoLoop({ messages: loopTail, replyText: silence }), true);
  // A single prior identical delivery is allowed (acknowledgements can repeat).
  const single = [mk('o1', silence, now - 90_000), incoming('i1', silence, now - 30_000)];
  assert.equal(wouldCreatePrivateChatEchoLoop({ messages: single, replyText: silence }), false);
  // Different trailing reply text resets the run.
  const varied = [mk('o1', silence, now - 90_000), mk('o2', '收到，稍等。', now - 70_000)];
  assert.equal(wouldCreatePrivateChatEchoLoop({ messages: varied, replyText: silence }), false);
  // Suppressed no-reply bubbles and failed deliveries never reached the peer, so they do not count.
  const suppressedOnly = [
    mk('o1', silence, now - 90_000),
    mk('o2', silence, now - 70_000, { privateChatNoReply: true }),
    mk('o3', silence, now - 50_000, { privateChatDeliveryStatus: 'failed' }),
  ];
  assert.equal(wouldCreatePrivateChatEchoLoop({ messages: suppressedOnly, replyText: silence }), false);
  // Skill wait notices interleave without breaking the delivered-reply run.
  const withWaitNotice = [
    mk('o1', silence, now - 90_000),
    mk('w1', '我需要查询一下，请稍等。', now - 80_000, { privateChatSkillWaitNotice: true }),
    mk('o2', silence, now - 70_000),
  ];
  assert.equal(wouldCreatePrivateChatEchoLoop({ messages: withWaitNotice, replyText: silence }), true);
  assert.equal(wouldCreatePrivateChatEchoLoop({ messages: loopTail, replyText: '' }), false);
});

test('A2A system prompt forbids mirroring the peer silence notation', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local Bot' },
    analysis: { contextMessages: [], incomingTurnCount: 0, shouldForceBye: false },
  });
  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /Never mirror or reuse the peer's silence notation/);
  assert.match(prompt, /a silence\/hold announcement in any wording or notation/);
});

test('final-reply extraction returns the sentinel instead of walking back to earlier text', () => {
  // 2026-09-15 incident shape: an earlier decision-narration bubble, then the
  // model's final sentinel. The extractor must surface the sentinel (the
  // daemon then delivers nothing) — treating it as a "non-answer" would walk
  // backwards and broadcast the earlier internal note instead.
  const messages = [
    { id: 'm1', type: 'assistant', content: 'BOT-009 这条是工作中信号，无需回应，等他回来再接招。' },
    { id: 'm2', type: 'tool_use', content: 'Using tool: Read' },
    { id: 'm3', type: 'tool_result', content: 'ok' },
    { id: 'm4', type: 'assistant', content: '[NO_REPLY]' },
  ];
  const result = extractFinalAssistantReply(messages);
  assert.equal(result.replyText, '[NO_REPLY]');
  assert.equal(result.assistantMessageId, 'm4');
});

test('A2A view hides the persisted no-reply sentinel bubble', () => {
  const noReplyBubble = {
    type: 'assistant',
    content: '[NO_REPLY]',
    metadata: { privateChatNoReply: true, sourceChannel: 'metaweb_private' },
  };
  assert.equal(shouldHideA2AInternalMessage(noReplyBubble), true);
  // Untagged bubbles stay visible (no content heuristics on the render path).
  const deliveredBubble = {
    type: 'assistant',
    content: '（保持静默。）',
    metadata: {
      sourceChannel: 'metaweb_private',
      direction: 'outgoing',
      txid: 'c'.repeat(64),
    },
  };
  assert.equal(shouldHideA2AInternalMessage(deliveredBubble), false);
});

test('A2A view hides assistant monologue that never reached the chain', () => {
  // Production shape (2026-10-25): intermediate working notes between tool
  // calls carry no chain metadata — they rendered as "内部状态" blocks below
  // the delivered reply they belonged to. They are internal state now.
  const monologue = {
    type: 'assistant',
    content: '任务建好但会话绑定落空（将跑新会话）——修正报告路由：改为直达私聊，不依赖会话落点。',
    metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', isFinal: true },
  };
  const chainBacked = { chainBackedConversation: true };
  assert.equal(shouldHideA2AInternalMessage(monologue, chainBacked), true);
  // Without the chain-backed session context the txid rule stays off —
  // owner-facing local turns (weather answers, artifact handoffs) never
  // broadcast and must keep rendering.
  assert.equal(shouldHideA2AInternalMessage(monologue), false);
  // Delivered replies anchor on a chain txid (direct, txids array, or pin id).
  assert.equal(shouldHideA2AInternalMessage({
    ...monologue,
    metadata: { ...monologue.metadata, txid: 'a'.repeat(64) },
  }, chainBacked), false);
  assert.equal(shouldHideA2AInternalMessage({
    ...monologue,
    metadata: { ...monologue.metadata, txids: ['b'.repeat(64)] },
  }, chainBacked), false);
  assert.equal(shouldHideA2AInternalMessage({
    ...monologue,
    metadata: { ...monologue.metadata, pinId: `c${'d'.repeat(63)}i0` },
  }, chainBacked), false);
  // Order-flow messages keep their traceability regardless of txid presence.
  assert.equal(shouldHideA2AInternalMessage({
    ...monologue,
    metadata: { ...monologue.metadata, orderTxid: 'e'.repeat(64) },
  }, chainBacked), false);
  // Incoming peer messages are never hidden by the txid rule.
  assert.equal(shouldHideA2AInternalMessage({
    type: 'user',
    content: '你好',
    metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
  }, chainBacked), false);
});

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createSentinelDaemonHarness() {
  const row = {
    id: 1,
    pin_id: 'incoming-pin-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: '（保持静默。）',
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
    messages: [],
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
  return { db, row, coworkStore, metabotStore, metabot, session };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for private chat daemon test condition');
}

test('daemon delivers nothing for a sentinel reply and marks the turn silent', async () => {
  const { db, row, coworkStore, metabotStore, session } = createSentinelDaemonHarness();
  const logs = [];
  let createPinCount = 0;

  startPrivateChatDaemon(
    db,
    () => {},
    coworkStore,
    metabotStore,
    { on() {}, off() {} },
    async () => {
      createPinCount += 1;
      throw new Error('no on-chain pin should be created for a silent turn');
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
      // Mirror the real skill-turn bridge: the runner persists the model's
      // final text as an assistant bubble and returns it as the reply.
      const persisted = coworkStore.addMessage(params.sessionId, {
        type: 'assistant',
        content: '[NO_REPLY]',
        metadata: { isStreaming: false, isFinal: true },
      });
      return { replyText: '[NO_REPLY]', assistantMessageId: persisted.id };
    },
    async () => '我需要查询一下，请稍等。'
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('chose silence')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(createPinCount, 0);
  const outgoing = session.messages.filter((message) => message.metadata?.direction === 'outgoing');
  assert.equal(outgoing.length, 0);
  const sentinelBubble = session.messages.find((message) => message.content === '[NO_REPLY]');
  assert.equal(sentinelBubble?.metadata?.privateChatNoReply, true);
  assert.equal(sentinelBubble?.metadata?.privateChatDeliveryStatus, undefined);
});

test('daemon absorbs a verbatim retransmission of the previous inbound message without a turn', async () => {
  const { db, row, coworkStore, metabotStore, session } = createSentinelDaemonHarness();
  const externalConversationId = 'metaweb-private:peer-global';
  row.content = '（静默。）';
  // Previous turn already handled the first copy of this silence note.
  session.messages.push({
    id: 'seed-in-1',
    type: 'user',
    content: '（静默。）',
    timestamp: Date.now() - 60_000,
    metadata: { sourceChannel: 'metaweb_private', direction: 'incoming', externalConversationId },
  });
  const logs = [];
  let createPinCount = 0;
  let turnAttempts = 0;

  startPrivateChatDaemon(
    db,
    () => {},
    coworkStore,
    metabotStore,
    { on() {}, off() {} },
    async () => {
      createPinCount += 1;
      throw new Error('no on-chain pin should be created for an absorbed retransmission');
    },
    (message) => logs.push(message),
    null,
    undefined,
    undefined,
    () => ({ respondToStrangerPrivateChats: true }),
    undefined,
    undefined,
    undefined,
    async () => {
      turnAttempts += 1;
      throw new Error('no LLM turn should run for an absorbed retransmission');
    },
    async () => {
      turnAttempts += 1;
      throw new Error('no skill turn should run for an absorbed retransmission');
    },
    async () => '我需要查询一下，请稍等。'
  );

  try {
    // Wait for the deterministic end state (the row is processed) instead of
    // the absorption log: the log fires just before the copy is appended, so
    // waiting on it raced the render step (visibility-first 2026-10-31).
    await waitFor(() => row.is_processed === 1);
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(createPinCount, 0);
  assert.equal(turnAttempts, 0);
  // Visibility-first (2026-10-31): the absorbed copy IS stored next to the
  // first one — the peer's own window shows its outgoing copy — but it drove
  // no reply turn (the loop protection the 2026-09-17 fix introduced).
  const inboundCopies = session.messages.filter(
    (message) => message.type === 'user' && message.content === '（静默。）'
  );
  assert.equal(inboundCopies.length, 2);
  assert.equal(inboundCopies[inboundCopies.length - 1].metadata?.privateChatRepeatAbsorbed, true);
});

test('daemon escalates the third consecutive identical copy into a real reply turn (insistent re-ask)', async () => {
  const { db, row, coworkStore, metabotStore, session } = createSentinelDaemonHarness();
  const externalConversationId = 'metaweb-private:peer-global';
  row.content = '请把昨天的报告再发一次';
  // Copy #1 was already answered in a previous turn.
  session.messages.push({
    id: 'seed-ask-1',
    type: 'user',
    content: '请把昨天的报告再发一次',
    timestamp: Date.now() - 60_000,
    metadata: { sourceChannel: 'metaweb_private', direction: 'incoming', externalConversationId },
  });
  const logs = [];
  let createPinCount = 0;
  let skillTurnAttempts = 0;

  startPrivateChatDaemon(
    db,
    () => {},
    coworkStore,
    metabotStore,
    { on() {}, off() {} },
    async () => {
      createPinCount += 1;
      throw new Error('no on-chain pin should be created for a sentinel reply');
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
      skillTurnAttempts += 1;
      const persisted = coworkStore.addMessage(params.sessionId, {
        type: 'assistant',
        content: '[NO_REPLY]',
        metadata: { isStreaming: false, isFinal: true },
      });
      return { replyText: '[NO_REPLY]', assistantMessageId: persisted.id };
    },
    async () => '我需要查询一下，请稍等。'
  );

  try {
    // Copy #2 is absorbed exactly as before (loop protection intact). Wait
    // for the row to be fully processed, not for the absorption log: the log
    // fires just before the copy is appended (visibility-first 2026-10-31),
    // and flipping the row below mid-processing would corrupt its bookkeeping.
    await waitFor(() => row.is_processed === 1);
    // Copy #3 — a NEW chain row with the identical wording — must escalate.
    row.id = 2;
    row.pin_id = 'incoming-pin-2';
    row.is_processed = 0;
    await waitFor(() => logs.some((message) => message.includes('insistent re-ask')));
    await waitFor(() => logs.some((message) => message.includes('chose silence')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1, 'the escalated copy was processed');
  assert.equal(skillTurnAttempts, 1, 'the third consecutive identical copy ran a real reply turn');
  assert.equal(createPinCount, 0, 'the sentinel reply delivered nothing (turn ran, silence chosen)');
});

test('daemon suppresses a reply that would repeat the last delivered outgoing messages verbatim', async () => {
  const { db, row, coworkStore, metabotStore, session } = createSentinelDaemonHarness();
  const base = Date.now() - 120_000;
  // Converged 2026-09-17 loop tail: the model keeps mirroring the peer's
  // silence note instead of emitting the sentinel.
  session.messages.push(
    {
      id: 'seed-in-1',
      type: 'user',
      content: 'nudge-1',
      timestamp: base,
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
    },
    {
      id: 'seed-out-1',
      type: 'assistant',
      content: '（静默。）',
      timestamp: base + 1_000,
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', privateChatDeliveryStatus: 'sent' },
    },
    {
      id: 'seed-in-2',
      type: 'user',
      content: 'nudge-2',
      timestamp: base + 2_000,
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
    },
    {
      id: 'seed-out-2',
      type: 'assistant',
      content: '（静默。）',
      timestamp: base + 3_000,
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', privateChatDeliveryStatus: 'sent' },
    }
  );
  row.content = 'nudge-3';
  const logs = [];
  let createPinCount = 0;

  startPrivateChatDaemon(
    db,
    () => {},
    coworkStore,
    metabotStore,
    { on() {}, off() {} },
    async () => {
      createPinCount += 1;
      throw new Error('no on-chain pin should be created for an echo-loop reply');
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
      const persisted = coworkStore.addMessage(params.sessionId, {
        type: 'assistant',
        content: '（静默。）',
        metadata: { isStreaming: false, isFinal: true },
      });
      return { replyText: '（静默。）', assistantMessageId: persisted.id };
    },
    async () => '我需要查询一下，请稍等。'
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('Echo-loop guard matched')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(createPinCount, 0);
  const mirroredBubble = session.messages
    .filter((message) => message.content === '（静默。）')
    .find((message) => message.metadata?.privateChatNoReply === true);
  assert.ok(mirroredBubble, 'the suppressed echo bubble must be tagged privateChatNoReply');
  assert.equal(mirroredBubble.metadata.privateChatDeliveryStatus, undefined);
  // No third copy of the silence note was delivered on-chain.
  const deliveredSilenceNotes = session.messages.filter((message) => (
    message.metadata?.direction === 'outgoing'
      && message.metadata?.privateChatDeliveryStatus === 'sent'
      && message.content === '（静默。）'
  ));
  assert.equal(deliveredSilenceNotes.length, 2);
});
