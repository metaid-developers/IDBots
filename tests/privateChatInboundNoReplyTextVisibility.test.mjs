/**
 * Inbound no-reply texts and absorbed repeat copies must still be rendered.
 *
 * Live failure shape (2026-10-31 瑞幸店员 incident, session e38b5e18 vs
 * 439c3541): of 28 chain envelopes the host received and marked processed,
 * 15 never appeared in the receiving session. Twelve older rows of
 * conversation backlogs were eaten by the pre-2026-10-29 "stale, newer
 * queued" skip (fixed by 24961715), but the three "bye" endings were eaten
 * by the no-op-text exit, which STILL ran before the inbound append after
 * that fix — and the absorbed second copy of a verbatim retransmission had
 * the same hole. The peer's own window kept showing every one of them.
 *
 * Contract pinned here:
 *   1. only a truly blank row may exit before the inbound append;
 *   2. no-op texts (bye / placeholder / peer sentinel echo) render first and
 *      only skip the reply turn, stamped privateChatNoReplyText;
 *   3. the absorbed second consecutive identical copy renders first too,
 *      stamped privateChatRepeatAbsorbed, and drives no reply (the third
 *      copy still escalates — covered by privateChatNoReplySentinel tests);
 *   4. none of these rows write to the chain or start a skill turn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonSourcePath = path.join(__dirname, '..', 'src', 'main', 'services', 'privateChatDaemon.ts');
const daemonSource = readFileSync(daemonSourcePath, 'utf8');

const {
  startPrivateChatDaemon,
  stopPrivateChatDaemon,
  shouldSkipPrivateChatAutoReplyText,
} = await import('../dist-electron/main/services/privateChatDaemon.js');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

test('classification: no-reply texts still gate the reply turn, blank stays blank', () => {
  assert.equal(shouldSkipPrivateChatAutoReplyText('bye'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('Bye '), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('thinking...'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('…'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('[NO_REPLY]'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText(''), true);
  // Real content never matches.
  assert.equal(shouldSkipPrivateChatAutoReplyText('bye bye, 明天见'), false);
  assert.equal(shouldSkipPrivateChatAutoReplyText('稍等，我帮你查一下'), false);
});

test('source order: blank skip sits before the append, every other no-reply exit sits after it', () => {
  const appendSite = daemonSource.indexOf('}) ?? appendPrivateChatA2AMessage({');
  assert.ok(appendSite > 0, 'inbound append site not found');

  const blankSkip = daemonSource.indexOf('Skipping blank private chat message');
  assert.ok(blankSkip > 0 && blankSkip < appendSite, 'blank rows must exit before the append (nothing renderable)');

  const noReplyTextExit = daemonSource.indexOf('Stored no-reply text ${row.id} without a reply turn');
  assert.ok(noReplyTextExit > appendSite, 'no-reply-text exit must run after the inbound append');

  const repeatExit = daemonSource.indexOf('Stored repeat copy ${row.id} without a reply');
  assert.ok(repeatExit > appendSite, 'repeat-absorption exit must run after the inbound append');

  // The old drop-before-render exits are gone.
  assert.ok(
    !daemonSource.includes('Skip no-op private chat message'),
    'no-op texts must no longer be dropped before rendering',
  );
  assert.ok(
    !daemonSource.includes('Skip message ${row.id}: identical to the previous inbound message'),
    'absorbed repeat copies must no longer be dropped before rendering',
  );

  // Renderer-facing markers exist for both new no-reply shapes.
  assert.ok(daemonSource.includes('privateChatNoReplyText: true'), 'no-reply-text marker missing');
  assert.ok(daemonSource.includes('privateChatRepeatAbsorbed: true'), 'repeat-absorbed marker missing');
});

function createDaemonHarness({ rowContent, seedMessages }) {
  const externalConversationId = 'metaweb-private:peer-global';
  const session = {
    id: 'session-private-1',
    sessionType: 'a2a',
    metabotId: 1,
    peerGlobalMetaId: 'peer-global',
    messages: seedMessages,
  };
  const mapping = {
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: 1,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({ peerGlobalMetaId: 'peer-global' }),
  };
  const row = {
    id: 424242,
    pin_id: 'b'.repeat(64),
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: '瑞幸店员',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: rowContent,
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
  const metabot = {
    id: 1,
    name: 'Local Bot',
    enabled: true,
    metaid: 'local-metaid',
    globalmetaid: 'local-global',
    allow_chat_skills: [],
    metabot_type: 'worker',
    soul: '',
    role: '',
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
      } else if (/UPDATE private_chat_messages SET is_processed = 0 WHERE id = \?/i.test(sql)) {
        row.is_processed = 0;
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
        timestamp: Date.now() + session.messages.length,
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

async function waitFor(predicate, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for private chat daemon test condition');
}

function startHarnessDaemon(harness, logs, skillTurnCalls) {
  let createPinCount = 0;
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
    async () => ({ prompt: '', activeSkillIds: [] }),
    async (params) => {
      skillTurnCalls.push(params);
      return { replyText: 'unexpected reply turn', assistantMessageId: null };
    },
    async () => '我需要查询一下，请稍等。'
  );
  return {
    get createPinCount() {
      return createPinCount;
    },
  };
}

// 2026-10-31 incident shape: the peer ends the conversation with "bye" —
// visible in its own window, invisible here, because the no-op exit ran
// before the append and marked the row processed. The bye must land in the
// transcript and drive neither a reply turn nor a chain write.
test('a "bye" from the peer is rendered and processed without a reply turn', async () => {
  const harness = createDaemonHarness({
    rowContent: 'bye',
    seedMessages: [
      {
        id: 'msg-seed-outbound',
        timestamp: Date.now() - 60_000,
        type: 'assistant',
        content: '好的，那今天就到这里，明天继续。',
        metadata: {
          sourceChannel: 'metaweb_private',
          externalConversationId: 'metaweb-private:peer-global',
          direction: 'outgoing',
          privateChatDeliveryStatus: 'sent',
        },
      },
    ],
  });
  const logs = [];
  const skillTurnCalls = [];
  const handle = startHarnessDaemon(harness, logs, skillTurnCalls);
  try {
    await waitFor(() => harness.row.is_processed === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  const byeBubble = harness.session.messages.find(
    (message) => message.type === 'user' && String(message.content ?? '').trim().toLowerCase() === 'bye'
  );
  assert.ok(byeBubble, 'the peer bye must be stored as a user bubble in the session');
  assert.equal(byeBubble.metadata?.privateChatNoReplyText, true, 'the bye bubble carries the no-reply-text marker');
  assert.equal(byeBubble.metadata?.autoReplySuppressed, undefined, 'a bye is not an auto-reply-policy suppression');
  assert.equal(skillTurnCalls.length, 0, 'no reply turn may run for a bye');
  assert.equal(handle.createPinCount, 0, 'no chain write may happen for a bye');
  assert.ok(
    logs.some((message) => message.includes(`Stored no-reply text ${harness.row.id}`)),
    'the post-append no-reply-text exit must be logged',
  );
});

// 2026-10-31 incident shape: the peer re-sends the same wording after a
// suspected delivery failure. The absorbed second copy used to vanish from
// the transcript; now it renders (no reply — the first copy drove it) and a
// third copy still escalates into a real reply turn.
test('an absorbed verbatim repeat copy is rendered without a reply turn', async () => {
  const repeatText = '1，重新下单——门店和商品都沿用。';
  const harness = createDaemonHarness({
    rowContent: repeatText,
    seedMessages: [
      {
        id: 'msg-seed-outbound',
        timestamp: Date.now() - 120_000,
        type: 'assistant',
        content: '收到，马上处理。',
        metadata: {
          sourceChannel: 'metaweb_private',
          externalConversationId: 'metaweb-private:peer-global',
          direction: 'outgoing',
          privateChatDeliveryStatus: 'sent',
        },
      },
      {
        // The first copy: recent enough to stay inside the conversation
        // segment, so this row is the second consecutive identical copy.
        id: 'msg-seed-inbound',
        timestamp: Date.now() - 30_000,
        type: 'user',
        content: repeatText,
        metadata: {
          sourceChannel: 'metaweb_private',
          externalConversationId: 'metaweb-private:peer-global',
          direction: 'incoming',
        },
      },
    ],
  });
  const logs = [];
  const skillTurnCalls = [];
  const handle = startHarnessDaemon(harness, logs, skillTurnCalls);
  try {
    await waitFor(() => harness.row.is_processed === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  const copies = harness.session.messages.filter(
    (message) => message.type === 'user' && String(message.content ?? '').trim() === repeatText
  );
  assert.equal(copies.length, 2, 'the absorbed second copy must be stored next to the first one');
  const absorbed = copies[copies.length - 1];
  assert.equal(absorbed.metadata?.privateChatRepeatAbsorbed, true, 'the absorbed copy carries the repeat marker');
  assert.equal(skillTurnCalls.length, 0, 'no reply turn may run for an absorbed repeat');
  assert.equal(handle.createPinCount, 0, 'no chain write may happen for an absorbed repeat');
  assert.ok(
    logs.some((message) => message.includes(`Stored repeat copy ${harness.row.id}`)),
    'the post-append repeat-absorption exit must be logged',
  );
});

// Truly blank rows have nothing to render — the decrypt stage drops them
// before any session work, silently. They must be marked processed and
// must not start a turn or a chain write.
test('a blank row is marked processed without a bubble', async () => {
  const harness = createDaemonHarness({ rowContent: '   ', seedMessages: [] });
  const logs = [];
  const skillTurnCalls = [];
  const handle = startHarnessDaemon(harness, logs, skillTurnCalls);
  try {
    await waitFor(() => harness.row.is_processed === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(harness.session.messages.length, 0, 'nothing renderable, nothing stored');
  assert.equal(skillTurnCalls.length, 0);
  assert.equal(handle.createPinCount, 0);
});
