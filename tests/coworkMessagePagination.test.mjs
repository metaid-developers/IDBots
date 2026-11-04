import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getCompiledStores,
  getIndexNames,
} from './memoryTestUtils.mjs';

const {
  buildA2AConversationThreadId,
  buildA2AParticipantPairKey,
} = getCompiledStores();

const insertMetabot = (db, id, globalMetaId) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [
      id,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `pk-${id}`,
      `chatpk-${id}`,
      `bot-${id}`,
      `metaid-${id}`,
      globalMetaId,
    ],
  );
};

test('message pagination index is created idempotently', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    createCoworkStore(db);
    createCoworkStore(db);
    const names = getIndexNames(db, 'cowork_messages');
    assert.equal(names.filter((name) => name === 'idx_cowork_messages_session_sequence').length, 1);
  } finally {
    cleanup();
  }
});

test('A2A identity keys separate local perspective while retaining a pair-wide key', () => {
  assert.notEqual(
    buildA2AConversationThreadId('IDQ1LOCAL', 'idq1peer'),
    buildA2AConversationThreadId('idq1peer', 'idq1local'),
  );
  assert.equal(
    buildA2AParticipantPairKey('IDQ1LOCAL', 'idq1peer'),
    buildA2AParticipantPairKey('idq1peer', 'idq1local'),
  );
});

test('legacy canonical A2A sessions are idempotently backfilled into logical threads', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 1, 'idq1local');
    const session = store.createSession(
      'Legacy peer',
      '/tmp/a2a',
      '',
      'local',
      [],
      1,
      'a2a',
      'idq1peer',
    );
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: 'metaweb-private:idq1peer',
      metabotId: 1,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        a2aConversationId: 'metaweb-private:idq1peer',
        episodeIndex: 1,
        episodeStartedAt: session.createdAt,
      }),
    });

    const migrated = createCoworkStore(db);
    createCoworkStore(db);
    const thread = migrated.getA2AConversationThreadBySession(session.id);
    assert.equal(thread?.localGlobalMetaId, 'idq1local');
    assert.equal(thread?.peerGlobalMetaId, 'idq1peer');
    assert.equal(migrated.listA2AConversationEpisodes(session.id).length, 1);
  } finally {
    cleanup();
  }
});

test('split A2A episodes persist as generations (no startup consolidation) and aggregate as one thread', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 1, 'idq1local');
    const original = store.createSession(
      'Peer Bot', '/tmp/a2a', '', 'local', [], 1, 'a2a', 'idq1peer', 'Old Peer',
    );
    const split = store.createSession(
      'Peer Bot', '/tmp/a2a', '', 'local', [], 1, 'a2a', 'idq1peer', 'New Peer', 'new-avatar',
    );
    store.addMessage(original.id, {
      type: 'user',
      content: 'original history',
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
    });
    store.addMessage(split.id, {
      type: 'assistant',
      content: 'split history',
      metadata: {
        sourceChannel: 'metaweb_private',
        direction: 'outgoing',
        pinId: `${'ab'.repeat(32)}i0`,
        txid: 'ab'.repeat(32),
      },
    });

    const firstEpisode = store.registerA2AEpisode({
      sessionId: original.id,
      localMetabotId: 1,
      localGlobalMetaId: 'idq1local',
      peerGlobalMetaId: 'idq1peer',
      episodeIndex: 1,
      startedAt: 100,
    });
    store.registerA2AEpisode({
      sessionId: split.id,
      localMetabotId: 1,
      localGlobalMetaId: 'idq1local',
      peerGlobalMetaId: 'idq1peer',
      episodeIndex: 2,
      previousSessionId: original.id,
      startedAt: 200,
      previousCloseReason: 'rollover',
    });
    store.updateA2AEpisodeSummary(original.id, 'Topics done. OPEN COMMITTMENTS: deliver results.');
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: 'metaweb-private:idq1peer',
      metabotId: 1,
      coworkSessionId: split.id,
      metadataJson: JSON.stringify({
        a2aThreadId: firstEpisode.threadId,
        episodeIndex: 2,
        previousEpisodeSessionId: original.id,
        peerName: 'New Peer',
      }),
    });

    // Reopen the store: episodes must survive (the retired consolidation
    // that used to collapse them back into one session is gone).
    const migrated = createCoworkStore(db);
    createCoworkStore(db);

    assert.ok(migrated.getSessionWithoutMessages(split.id));
    assert.ok(migrated.getSessionWithoutMessages(original.id));
    assert.equal(
      migrated.getConversationMapping('metaweb_private', 'metaweb-private:idq1peer', 1)?.coworkSessionId,
      split.id,
    );
    assert.deepEqual(migrated.listA2AConversationEpisodes(split.id).map((episode) => ({
      sessionId: episode.sessionId,
      episodeIndex: episode.episodeIndex,
      closeReason: episode.closeReason,
      summary: episode.summary,
    })), [{
      sessionId: original.id,
      episodeIndex: 1,
      closeReason: 'rollover',
      summary: 'Topics done. OPEN COMMITTMENTS: deliver results.',
    }, {
      sessionId: split.id,
      episodeIndex: 2,
      closeReason: null,
      summary: null,
    }]);

    // Thread aggregation in the session list: the superseded episode is not
    // listed on its own — the latest episode entry represents the thread.
    const listedIds = migrated.listSessions().map((summary) => summary.id);
    assert.ok(listedIds.includes(split.id));
    assert.ok(!listedIds.includes(original.id));

    // Opening the successor fills the display page from the previous episode,
    // so a short new episode does not hide the rest of the thread.
    const view = migrated.getSessionView(split.id, 10);
    assert.deepEqual(view?.messages.map((message) => message.content), ['original history', 'split history']);
    assert.equal(view?.messageHistory?.hasMoreBefore, false);
    assert.equal(view?.messageHistory?.beforeSequence, null);
    assert.equal(view?.messages[0]?.metadata?.a2aEpisodeIndex, 1);

    // Cross-episode paging: the null-null cursor returns the first page
    // strictly below the successor episode, oldest-first, with a real cursor.
    const below = migrated.getA2AConversationHistoryPage(split.id, {
      beforeCursor: { episodeIndex: null, beforeSequence: null },
      limit: 10,
    });
    assert.deepEqual(below?.messages.map((entry) => entry.message.content), ['original history']);
    assert.equal(below?.messages[0]?.episodeIndex, 1);
    assert.equal(below?.hasMoreBefore, false);
    assert.equal(below?.beforeCursor, null);

    // Thread-tail reader spans both generations, oldest-first.
    assert.deepEqual(
      migrated.getRecentA2AThreadMessages(split.id, 10).map((message) => message.content),
      ['original history', 'split history'],
    );
  } finally {
    cleanup();
  }
});

test('cross-episode history pages spend their budget on VISIBLE messages only', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 1, 'idq1local');
    const original = store.createSession(
      'Peer Bot', '/tmp/a2a', '', 'local', [], 1, 'a2a', 'idq1peer', 'Old Peer',
    );
    const split = store.createSession(
      'Peer Bot', '/tmp/a2a', '', 'local', [], 1, 'a2a', 'idq1peer', 'New Peer',
    );
    const firstEpisode = store.registerA2AEpisode({
      sessionId: original.id,
      localMetabotId: 1,
      localGlobalMetaId: 'idq1local',
      peerGlobalMetaId: 'idq1peer',
      episodeIndex: 1,
      startedAt: 100,
    });
    store.registerA2AEpisode({
      sessionId: split.id,
      localMetabotId: 1,
      localGlobalMetaId: 'idq1local',
      peerGlobalMetaId: 'idq1peer',
      episodeIndex: 2,
      previousSessionId: original.id,
      startedAt: 200,
      previousCloseReason: 'rollover',
    });
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: 'metaweb-private:idq1peer',
      metabotId: 1,
      coworkSessionId: split.id,
      metadataJson: JSON.stringify({
        a2aThreadId: firstEpisode.threadId,
        episodeIndex: 2,
        previousEpisodeSessionId: original.id,
        peerName: 'New Peer',
      }),
    });
    // A skill-heavy old episode: hidden internals (tool_use / tool_result /
    // system / thinking) interleaved with the three visible bubbles. Pre-fix,
    // a hidden row consumed the page budget and "load earlier" rendered an
    // empty page while hasMoreBefore burned down.
    const seed = [
      { type: 'tool_use', content: 'run web-search' },
      { type: 'user', content: 'visible-1' },
      { type: 'tool_result', content: 'search results…' },
      { type: 'system', content: 'internal notice' },
      { type: 'assistant', content: 'visible-2' },
      { type: 'assistant', content: 'thinking-only', metadata: { isThinking: true } },
      { type: 'assistant', content: 'visible-3' },
    ];
    for (const message of seed) {
      store.addMessage(original.id, message);
    }
    store.addMessage(split.id, { type: 'assistant', content: 'split history' });

    // First cross-episode page, limit 2: only visible rows, newest first,
    // hasMore true, cursor points BELOW the last returned visible row.
    const page1 = store.getA2AConversationHistoryPage(split.id, {
      beforeCursor: { episodeIndex: null, beforeSequence: null },
      limit: 2,
    });
    assert.deepEqual(page1.messages.map((entry) => entry.message.content), ['visible-2', 'visible-3']);
    assert.equal(page1.hasMoreBefore, true);
    assert.ok(page1.beforeCursor, 'a real cursor continues the chain');

    const page2 = store.getA2AConversationHistoryPage(split.id, {
      beforeCursor: page1.beforeCursor,
      limit: 2,
    });
    assert.deepEqual(page2.messages.map((entry) => entry.message.content), ['visible-1']);
    assert.equal(page2.hasMoreBefore, false, 'raw history exhausted — chain ends cleanly');
    assert.equal(page2.beforeCursor, null);
  } finally {
    cleanup();
  }
});

test('message pages use a stable cursor and preserve chronological order', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('long A2A chat', '/tmp/a2a', '', 'local', [], 1, 'a2a');
    const ids = [];
    for (let index = 1; index <= 7; index += 1) {
      ids.push(store.addMessage(session.id, {
        type: index % 2 === 0 ? 'assistant' : 'user',
        content: `message-${index}`,
      }).id);
    }

    // Every session opens on a bounded newest-messages window; the page that
    // walks below it answers with the cursor for its own order. Non-A2A windows
    // page in transcript order, the A2A display window in sequence order.
    const latest = store.getSessionMessagesPage(session.id, { limit: 3 });
    assert.deepEqual(latest.messages.map((message) => message.content), ['message-5', 'message-6', 'message-7']);
    assert.equal(latest.hasMoreBefore, true);
    assert.equal(latest.beforeSequence, null);
    assert.equal(typeof latest.beforeTranscriptCursor, 'string');

    const middle = store.getSessionMessagesPage(session.id, {
      beforeTranscriptCursor: latest.beforeTranscriptCursor,
      limit: 3,
    });
    assert.deepEqual(middle.messages.map((message) => message.content), ['message-2', 'message-3', 'message-4']);
    assert.equal(middle.hasMoreBefore, true);
    assert.equal(typeof middle.beforeTranscriptCursor, 'string');

    const oldest = store.getSessionMessagesPage(session.id, {
      beforeTranscriptCursor: middle.beforeTranscriptCursor,
      limit: 3,
    });
    assert.deepEqual(oldest.messages.map((message) => message.content), ['message-1']);
    assert.equal(oldest.hasMoreBefore, false);
    assert.equal(oldest.beforeTranscriptCursor, null);

    // The A2A display window keeps its sequence cursor over the same rows.
    const displayLatest = store.getSessionMessagesPage(session.id, { limit: 3, displayWindow: true });
    assert.deepEqual(displayLatest.messages.map((message) => message.content), ['message-5', 'message-6', 'message-7']);
    assert.equal(displayLatest.hasMoreBefore, true);
    assert.equal(displayLatest.beforeSequence, 5);
    const displayMiddle = store.getSessionMessagesPage(session.id, {
      beforeSequence: displayLatest.beforeSequence,
      limit: 3,
      displayWindow: true,
    });
    assert.deepEqual(displayMiddle.messages.map((message) => message.content), ['message-2', 'message-3', 'message-4']);
    assert.equal(displayMiddle.beforeSequence, 2);

    const view = store.getSessionView(session.id, 3);
    assert.deepEqual(view?.messages.map((message) => message.content), ['message-5', 'message-6', 'message-7']);
    assert.deepEqual(view?.messageHistory, {
      hasMoreBefore: true,
      beforeSequence: 5,
      beforeEpisodeIndex: null,
      pageSize: 3,
    });
    assert.deepEqual(store.getSession(session.id)?.messages.map((message) => message.id), ids);
  } finally {
    cleanup();
  }
});

test('A2A daemon queries stay bounded and preserve exact metadata for callers', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('bounded A2A chat', '/tmp/a2a', '', 'local', [], 1, 'a2a');
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'pong',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', pinId: 'pin-pong' },
    });
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'internal trace',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', orderExecutionTrace: true },
    });
    store.addMessage(session.id, {
      type: 'tool_result',
      content: 'large internal result',
      metadata: { sourceChannel: 'cowork_ui' },
    });
    assert.equal(store.hasPriorPrivateA2AOutboundMessage(session.id), false);
    store.addMessage(session.id, {
      type: 'user',
      content: 'peer question',
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming', pinId: 'pin-question' },
    });
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'useful reply',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', txid: 'tx-reply' },
    });

    assert.deepEqual(
      store.getRecentPrivateA2AMessages(session.id, 2).map((message) => message.content),
      ['peer question', 'useful reply'],
    );
    assert.deepEqual(
      store.getSessionMessagesMatchingMetadataValues(session.id, ['pin-question']).map((message) => message.content),
      ['peer question'],
    );
    assert.equal(store.hasPriorPrivateA2AOutboundMessage(session.id), true);
    assert.deepEqual(store.getSessionWithoutMessages(session.id)?.messages, []);

    const now = 1_800_000_000_000;
    db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency,
        cowork_session_id, status, first_response_deadline_at, delivery_deadline_at,
        created_at, updated_at
      ) VALUES (?, 'buyer', 1, 'idq1peer', 'Test service', 'tx-order', 'mvc', '1', 'SPACE', ?, 'rating_pending', ?, ?, ?, ?)
    `, ['order-1', session.id, now, now, now, now - 2 * 24 * 60 * 60 * 1000]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), false);
    db.run("UPDATE service_orders SET updated_at = ? WHERE id = 'order-1'", [now]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), true);
    db.run("UPDATE service_orders SET status = 'in_progress', updated_at = ? WHERE id = 'order-1'", [now - 2 * 24 * 60 * 60 * 1000]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), true);
  } finally {
    cleanup();
  }
});

test('A2A display window skips a hidden error flood and keeps visible conversation', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('error flood A2A', '/tmp/a2a', '', 'local', [], 1, 'a2a');
    store.addMessage(session.id, {
      type: 'user',
      content: 'please fix invite_remote',
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
    });
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'wait a moment',
      // A chain-backed A2A reply that was actually delivered carries a txid —
      // without one the shipped filter classifies it as undelivered monologue
      // and hides it (shouldHideA2AInternalMessage, chainBackedConversation).
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', txid: 'ab'.repeat(32) },
    });
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'internal reasoning',
      metadata: { isThinking: true },
    });
    store.addMessage(session.id, {
      type: 'tool_use',
      content: 'Using tool: bash',
      metadata: { toolName: 'bash', toolUseId: 'call-1' },
    });
    for (let index = 0; index < 120; index += 1) {
      store.addMessage(session.id, {
        type: 'system',
        content: 'Error: DSH turn failed: free_quota_exhausted',
        metadata: { error: 'DSH turn failed: {"code":"QUOTA"}' },
      });
    }

    const rawTail = store.getSessionMessagesPage(session.id, { limit: 100 });
    assert.equal(rawTail.messages.length, 100);
    assert.equal(rawTail.messages.every((message) => message.type === 'system'), true);

    const view = store.getSessionView(session.id, 20);
    const contents = view?.messages.map((message) => message.content) ?? [];
    assert.equal(contents.includes('please fix invite_remote'), true);
    assert.equal(contents.includes('wait a moment'), true);
    assert.equal(contents.includes('internal reasoning'), true);
    assert.equal(contents.includes('Using tool: bash'), true);
    assert.equal(contents.filter((content) => content.startsWith('Error:')).length, 1);
    assert.equal(view?.messageHistory?.hasMoreBefore, false);

    const earlier = store.getSessionMessagesPage(session.id, {
      beforeSequence: view?.messageHistory?.beforeSequence ?? undefined,
      limit: 20,
      displayWindow: true,
    });
    assert.equal(earlier.hasMoreBefore, false);
  } finally {
    cleanup();
  }
});
