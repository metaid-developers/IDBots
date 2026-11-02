import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSqliteStore,
  getRow,
} from './memoryTestUtils.mjs';

let computeUnprocessedAfterTimestampSec;
let createPrivateChatBackfillLoop;
try {
  ({
    computeUnprocessedAfterTimestampSec,
    createPrivateChatBackfillLoop,
  } = await import('../dist-electron/main/services/privateChatBackfillService.js'));
} catch {
  ({
    computeUnprocessedAfterTimestampSec,
    createPrivateChatBackfillLoop,
  } = await import('../dist-electron/main/services/privateChatBackfillService.js'));
}

const LOCAL_GLOBAL_META_ID = 'idq1local';
const PEER_GLOBAL_META_ID = 'idq1peer';
const MAPPED_PEER_GLOBAL_META_ID = 'idq1mappeer';
const LOCAL_IDENTITY = { metabotId: 1, globalMetaId: LOCAL_GLOBAL_META_ID };

function seedPrivateChatRow(db, input) {
  db.run(
    `INSERT INTO private_chat_messages (
      pin_id, tx_id, from_metaid, from_global_metaid, from_name, from_avatar, from_chat_pubkey,
      to_metaid, to_global_metaid, protocol, content, content_type, encryption, reply_pin,
      chain_timestamp, chain, raw_data, is_processed
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, 'ecdh', '', ?, 'mvc', '{}', ?)`,
    [
      input.pinId,
      input.txId ?? null,
      input.fromMetaId ?? '',
      input.fromGlobalMetaId ?? null,
      input.toMetaId ?? '',
      input.toGlobalMetaId ?? null,
      input.protocol ?? '/protocols/simplemsg',
      input.content ?? 'cipher',
      input.chainTimestamp ?? null,
      input.isProcessed ?? 1,
    ],
  );
}

function historyMessage(pinId, timestamp) {
  return {
    index: 1,
    txId: pinId.replace(/i\d+$/, ''),
    pinId,
    from: 'peer-meta',
    fromGlobalMetaId: PEER_GLOBAL_META_ID,
    fromUserInfo: {},
    to: 'local-meta',
    toGlobalMetaId: LOCAL_GLOBAL_META_ID,
    toUserInfo: {},
    protocol: '/protocols/simplemsg',
    content: 'U2FsdGVkX1cipher',
    contentType: 'text/markdown',
    encryption: 'ecdh',
    replyPin: '',
    timestamp,
    chain: 'mvc',
    raw: { pinId },
  };
}

function getProcessedFlag(db, pinId) {
  return getRow(db, 'SELECT is_processed FROM private_chat_messages WHERE pin_id = ?', [pinId])
    ?.is_processed;
}

function createHarness(overrides = {}) {
  const directoryCalls = [];
  const historyCalls = [];
  const state = {
    nowMs: overrides.nowMs ?? 1_785_000_000_000,
    directoryList: overrides.directoryList ?? [],
    directoryFails: overrides.directoryFails ?? false,
    historyMessages: overrides.historyMessages ?? [],
  };
  const deps = {
    getLocalIdentities: () => [LOCAL_IDENTITY],
    historySync: {
      async fetchRecentConversationMessages(params) {
        historyCalls.push(params);
        return typeof state.historyMessages === 'function'
          ? state.historyMessages(params)
          : state.historyMessages;
      },
    },
    fetchDirectoryJson: async (url) => {
      directoryCalls.push(url);
      if (state.directoryFails) {
        throw new Error('directory offline');
      }
      return { data: { list: state.directoryList } };
    },
    now: () => state.nowMs,
    emitLog: () => undefined,
    ...(overrides.deps ?? {}),
  };
  return { state, deps, directoryCalls, historyCalls };
}

test('computeUnprocessedAfterTimestampSec uses overlap behind the latest stored timestamp', () => {
  assert.equal(
    computeUnprocessedAfterTimestampSec({
      latestLocalTimestampSec: 10_000,
      nowSec: 20_000,
    }),
    9_700,
  );
  assert.equal(
    computeUnprocessedAfterTimestampSec({
      latestLocalTimestampSec: 10_000,
      nowSec: 20_000,
      overlapSec: 0,
    }),
    10_000,
  );
});

test('computeUnprocessedAfterTimestampSec falls back to the catch-up window for new pairs', () => {
  assert.equal(
    computeUnprocessedAfterTimestampSec({
      latestLocalTimestampSec: null,
      nowSec: 100_000,
      catchUpWindowSec: 3_600,
    }),
    96_400,
  );
});

test('backfill recovers a directory peer whose last pin is missing locally', async () => {
  const sqlite = await createSqliteStore();
  try {
    const storedExperienceBatches = [];
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-old',
      fromGlobalMetaId: LOCAL_GLOBAL_META_ID,
      toGlobalMetaId: PEER_GLOBAL_META_ID,
      chainTimestamp: 10_000,
    });
    const harness = createHarness({
      directoryList: [{
        globalMetaId: PEER_GLOBAL_META_ID,
        groupId: '',
        lastMessagePinId: 'pin-c',
        timestamp: 9_900,
      }],
      historyMessages: [
        historyMessage('pin-a', 9_800),
        historyMessage('pin-b', 9_000),
        historyMessage('pin-c', 9_900),
      ],
    });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      onMessagesStored: (batch) => storedExperienceBatches.push(batch),
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 1);
    assert.equal(result.inserted, 3);
    assert.equal(result.failedPeers, 0);
    assert.deepEqual(storedExperienceBatches, [{
      identity: LOCAL_IDENTITY,
      peerGlobalMetaID: PEER_GLOBAL_META_ID,
      inserted: 3,
      archivedPinIds: ['pin-b'],
    }]);
    assert.deepEqual(
      harness.historyCalls.map((call) => [call.metaId, call.otherMetaId]),
      [[LOCAL_GLOBAL_META_ID, PEER_GLOBAL_META_ID]],
    );
    assert.ok(harness.directoryCalls.every((url) => url.includes(`metaId=${LOCAL_GLOBAL_META_ID}`)));
    // Threshold = latest local (10_000) - overlap (300) = 9_700: the two
    // fresher rows are queued for the daemon, the older one is archived.
    assert.equal(getProcessedFlag(sqlite.db, 'pin-a'), 0);
    assert.equal(getProcessedFlag(sqlite.db, 'pin-c'), 0);
    assert.equal(getProcessedFlag(sqlite.db, 'pin-b'), 1);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill skips a directory peer whose last pin is already stored', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-seen',
      fromGlobalMetaId: PEER_GLOBAL_META_ID,
      toGlobalMetaId: LOCAL_GLOBAL_META_ID,
      chainTimestamp: 10_000,
    });
    const harness = createHarness({
      directoryList: [{
        globalMetaId: PEER_GLOBAL_META_ID,
        groupId: '',
        lastMessagePinId: 'pin-seen',
        timestamp: 10_000,
      }],
    });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 0);
    assert.equal(result.inserted, 0);
    assert.equal(harness.historyCalls.length, 0);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill only treats recent messages from a brand-new peer as live', async () => {
  const sqlite = await createSqliteStore();
  try {
    const nowMs = 1_785_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const harness = createHarness({
      nowMs,
      directoryList: [{
        globalMetaId: PEER_GLOBAL_META_ID,
        groupId: '',
        lastMessagePinId: 'pin-new',
        timestamp: nowSec - 3_600,
      }],
      historyMessages: [
        historyMessage('pin-new', nowSec - 3_600),
        historyMessage('pin-ancient', nowSec - 7 * 3_600),
      ],
    });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 1);
    assert.equal(result.inserted, 2);
    assert.equal(getProcessedFlag(sqlite.db, 'pin-new'), 0);
    assert.equal(getProcessedFlag(sqlite.db, 'pin-ancient'), 1);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill throttles probes for local-only peers the directory does not list', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-x',
      fromGlobalMetaId: PEER_GLOBAL_META_ID,
      toGlobalMetaId: LOCAL_GLOBAL_META_ID,
      chainTimestamp: 5_000,
    });
    const harness = createHarness({ directoryList: [] });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const first = await loop.syncOnce();
    assert.equal(first.probedPeers, 1);

    const second = await loop.syncOnce();
    assert.equal(second.probedPeers, 0);

    harness.state.nowMs += 61_000;
    const third = await loop.syncOnce();
    assert.equal(third.probedPeers, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill probes local peers when the directory is unavailable', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-x',
      fromGlobalMetaId: PEER_GLOBAL_META_ID,
      toGlobalMetaId: LOCAL_GLOBAL_META_ID,
      chainTimestamp: 5_000,
    });
    const harness = createHarness({ directoryFails: true });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 1);
    assert.equal(harness.historyCalls.length, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill discovers peers from A2A session mappings', async () => {
  const sqlite = await createSqliteStore();
  try {
    sqlite.db.run(
      `INSERT INTO cowork_conversation_mappings (
        channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
      ) VALUES ('metaweb_private', ?, 1, 'session-1', '{}', 1, 1)`,
      [`metaweb-private:${MAPPED_PEER_GLOBAL_META_ID}`],
    );
    const harness = createHarness({ directoryList: [] });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 1);
    assert.deepEqual(
      harness.historyCalls.map((call) => call.otherMetaId),
      [MAPPED_PEER_GLOBAL_META_ID],
    );
  } finally {
    sqlite.cleanup();
  }
});

test('backfill is a no-op while private chats are disabled', async () => {
  const sqlite = await createSqliteStore();
  try {
    const harness = createHarness({
      directoryList: [{
        globalMetaId: PEER_GLOBAL_META_ID,
        groupId: '',
        lastMessagePinId: 'pin-new',
        timestamp: 9_900,
      }],
    });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      shouldRun: () => false,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.deepEqual(result, { identities: 0, probedPeers: 0, inserted: 0, failedPeers: 0, failedDirectories: 0 });
    assert.equal(harness.historyCalls.length, 0);
    assert.equal(harness.directoryCalls.length, 0);
  } finally {
    sqlite.cleanup();
  }
});

// ── issue #24: backoff ladder + circuit breaker on the poll loop ──────────────

const { PollBackoffController } = await import('../dist-electron/main/services/pollBackoffController.js');

test('issue #24: total-failure ticks (directory AND peer fetches all fail) escalate the ladder', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-old',
      fromGlobalMetaId: LOCAL_GLOBAL_META_ID,
      toGlobalMetaId: PEER_GLOBAL_META_ID,
      chainTimestamp: 10_000,
    });
    const clock = { value: 1_785_000_000_000 };
    const logs = [];
    const backoff = new PollBackoffController({
      name: 'test-private-backfill',
      baseMs: 15_000,
      now: () => clock.value,
      random: () => 0.5,
      emitLog: (line) => logs.push(line),
    });
    const harness = createHarness({
      directoryFails: true,
      historyMessages: () => { throw new Error('history offline'); },
    });
    const loop = createPrivateChatBackfillLoop({
      ...harness.deps,
      db: sqlite.db,
      saveDb: () => {},
      intervalMs: 15_000,
      backoff,
    });

    // shape: one direct syncOnce proves the new failure signal is surfaced
    const shape = await loop.syncOnce();
    assert.equal(shape.failedDirectories, 1, 'directory failure surfaced in the result');
    assert.equal(shape.failedPeers, 1, 'peer failure surfaced in the result');
    const delays = [];
    for (let i = 1; i <= 3; i += 1) {
      await loop.runTick();
      delays.push(backoff.nextDelayMs());
      clock.value += backoff.nextDelayMs() + 1;
    }
    assert.deepEqual(delays, [30_000, 60_000, 120_000], '>= 3 strictly growing tiers');
    assert.ok(logs.some((l) => l.includes('[PollBackoff:test-private-backfill]') && l.includes('backing off after failure #3')));
  } finally {
    sqlite.close?.();
  }
});

test('issue #24: partial failure (one identity directory up, one down) is NOT total failure', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-old',
      fromGlobalMetaId: LOCAL_GLOBAL_META_ID,
      toGlobalMetaId: PEER_GLOBAL_META_ID,
      chainTimestamp: 10_000,
    });
    const clock = { value: 1_785_000_000_000 };
    const backoff = new PollBackoffController({
      name: 'test-private-backfill',
      baseMs: 15_000,
      now: () => clock.value,
      random: () => 0.5,
      emitLog: () => {},
    });
    // Two identities: the first identity's directory fetch fails on every
    // endpoint, the second still serves. The tick is PARTIAL (one network
    // unit succeeded), so the ladder must not escalate. Note: a directory-
    // ONLY outage (every identity failing) IS total failure once peer probes
    // are throttled — that escalation is the intended behavior (retry storm).
    const SECOND_GLOBAL_META_ID = 'idq1second0000000000000000000000000';
    const historyCalls = [];
    const deps = {
      getLocalIdentities: () => [LOCAL_IDENTITY, { metabotId: 2, globalMetaId: SECOND_GLOBAL_META_ID }],
      historySync: {
        async fetchRecentConversationMessages(params) {
          historyCalls.push(params);
          return [];
        },
      },
      fetchDirectoryJson: async (url) => {
        if (String(url).includes(LOCAL_GLOBAL_META_ID)) {
          throw new Error('directory offline');
        }
        return { data: { list: [] } };
      },
      now: () => clock.value,
      emitLog: () => undefined,
    };
    const loop = createPrivateChatBackfillLoop({
      ...deps,
      db: sqlite.db,
      saveDb: () => {},
      intervalMs: 15_000,
      backoff,
    });
    const shape = await loop.syncOnce();
    assert.equal(shape.failedDirectories, 1);
    assert.equal(shape.failedPeers, 0);
    await loop.runTick();
    assert.equal(backoff.getState().consecutiveFailures, 0, 'partial failure must not escalate');
    assert.equal(backoff.nextDelayMs(), 15_000);
  } finally {
    sqlite.close?.();
  }
});

test('issue #24: shouldRun()=false ticks attempt nothing and keep the ladder state', async () => {
  const sqlite = await createSqliteStore();
  try {
    const clock = { value: 1_785_000_000_000 };
    const backoff = new PollBackoffController({
      name: 'test-private-backfill',
      baseMs: 15_000,
      now: () => clock.value,
      random: () => 0.5,
      emitLog: () => {},
    });
    const harness = createHarness({});
    const loop = createPrivateChatBackfillLoop({
      ...harness.deps,
      db: sqlite.db,
      saveDb: () => {},
      intervalMs: 15_000,
      backoff,
      shouldRun: () => false,
    });
    backoff.recordFailure();
    const allowedBefore = backoff.getState().nextAttemptAllowedAtMs;
    clock.value = allowedBefore + 1;
    await loop.runTick();
    assert.equal(backoff.getState().consecutiveFailures, 1, 'no-op tick must not reset');
    assert.equal(backoff.getState().nextAttemptAllowedAtMs, allowedBefore, 'no-op tick must not retime');
  } finally {
    sqlite.close?.();
  }
});

// ── issue #24 (review nit b): re-entry guard existence pinned per loop ───────

test('issue #24 (guard): a second runTick while one is in flight is skipped without new downstream calls (single-flight)', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-guard-single-flight',
      fromGlobalMetaId: LOCAL_GLOBAL_META_ID,
      toGlobalMetaId: PEER_GLOBAL_META_ID,
      chainTimestamp: 10_000,
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let downstreamCalls = 0;
    const clock = { value: 1_785_000_000_000 };
    const backoff = new PollBackoffController({
      name: 'test-private-backfill',
      baseMs: 15_000,
      now: () => clock.value,
      random: () => 0.5,
      emitLog: () => {},
    });
    const harness = createHarness({
      deps: {
        fetchDirectoryJson: async () => {
          downstreamCalls += 1;
          await gate; // park the directory round
          return { data: { list: [] } };
        },
      },
    });
    const loop = createPrivateChatBackfillLoop({
      ...harness.deps,
      db: sqlite.db,
      saveDb: () => {},
      intervalMs: 15_000,
      backoff,
    });

    const first = loop.runTick();
    await new Promise((resolve) => setImmediate(resolve));
    const callsWhileInFlight = downstreamCalls;
    assert.ok(callsWhileInFlight >= 1, 'the first tick reached the directory fetch');

    const second = loop.runTick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(downstreamCalls, callsWhileInFlight, 'the guarded second tick must not start new downstream calls');

    release();
    await Promise.all([first, second]);
    assert.equal(backoff.getState().circuit, 'closed');
  } finally {
    sqlite.close?.();
  }
});
