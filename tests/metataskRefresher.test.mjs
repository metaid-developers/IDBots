import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetaTaskProjectionStore } = require('../dist-electron/main/services/metatask/projectionStore.js');
const { MetaTaskRefresher } = require('../dist-electron/main/services/metatask/refresher.js');
const { nextTimeDeadlineMs } = require('../dist-electron/main/services/metatask/deadlines.js');
const { taskEventSet, taskDirtyKey, replayMetaTask } = require('../dist-electron/main/services/metatask/engine.js');
const { canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');

/**
 * MetaTask refresher scale hardening (P2): dirty-root skip, the deadline guard
 * that keeps time-driven transitions alive on a skipped root, and the
 * minimum-interval coalescing of ordinary callers.
 *
 * The harness drives the real pipeline (collector → store → engine) against a
 * fake indexer and an injected clock, so a "skipped" sweep is observable as an
 * untouched persisted row plus an unchanged fetch count.
 */

const T0 = 1_790_000_000_000;
const PUBLISHER = 'idq1publisherx0000000000000000000';
const WORKER = 'idq1workerbee00000000000000000000';
const REVIEWER = 'idq1reviewerzz0000000000000000000';

const TREE_PIN = 'tree0000000001i0';
const TASK_PIN = 'task0000000001i0';
const CLAIM_PIN = 'claim00000001i0';

const rawItem = (pinId, protocolPath, body, over = {}) => ({
  id: pinId,
  path: protocolPath,
  globalMetaId: over.author ?? PUBLISHER,
  genesisHeight: over.height ?? 190_000,
  txIndex: over.txIndex ?? 0,
  timestamp: over.timestampMs ?? T0,
  contentBody: Buffer.from(JSON.stringify(body)).toString('base64'),
});

const treeItem = () =>
  rawItem(
    TREE_PIN,
    '/protocols/metatask/tree',
    {
      root: 'r1',
      nodes: [
        { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
        { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 7000 },
      ],
    },
    { height: 189_900 }
  );

const taskItem = (over = {}) =>
  rawItem(
    TASK_PIN,
    '/protocols/metatask/task',
    {
      title: 'sweep fixture',
      treeid: TREE_PIN,
      // ttl 1h so a held node has a clock the deadline guard must respect.
      policy: { verify_quorum: 2, claim_ttl_hours: 1, verify_window_hours: 0 },
      tags: [],
    },
    { height: 189_901, ...over }
  );

const claimItem = (over = {}) =>
  rawItem(
    CLAIM_PIN,
    '/protocols/metatask/claim',
    { taskid: TASK_PIN, node: 't1' },
    { author: WORKER, height: 189_910, timestampMs: T0, ...over }
  );

const openHarness = async (clock, over = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metatask-refresher-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new MetaTaskProjectionStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const items = over.items ? [...over.items] : [treeItem(), taskItem(), claimItem()];
  // Content-download bodies the fake indexer serves: pinId -> decoded body
  // (a missing entry answers 404, i.e. an unrecoverable row).
  const contentBodies = over.contentBodies ?? {};
  let fetchCalls = 0;
  let contentCalls = 0;
  const fetchImpl = async (url) => {
    fetchCalls += 1;
    const href = String(url);
    if (href.includes('/content/')) {
      contentCalls += 1;
      const pinId = href.split('/content/').pop();
      const served = contentBodies[pinId];
      if (served === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(served), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const parsed = new URL(href);
    const poolPath = parsed.searchParams.get('path') ?? '';
    const segment = poolPath.split('/').pop();
    const list = items.filter((item) => String(item.path).split('/').pop() === segment);
    return new Response(JSON.stringify({ code: 1, data: { list } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const refresher = new MetaTaskRefresher({
    store: () => store,
    collectOptions: { fetchImpl },
    now: () => (over.frozenClock === false ? Date.now() : clock.value),
    minIntervalMs: over.minIntervalMs ?? 0,
  });
  return {
    dir,
    sqliteStore,
    store,
    refresher,
    items,
    fetchCount: () => fetchCalls,
    contentFetchCount: () => contentCalls,
    cleanup: () => {
      refresher.dispose();
      sqliteStore.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

const rowOf = (sqliteStore, rootPinId) => {
  const result = sqliteStore
    .getDatabase()
    .exec('SELECT title, dirty_key, event_set_hash, refreshed_at FROM metatask_task_projections WHERE root_pin_id = ?', [
      rootPinId,
    ]);
  return result[0]?.values?.[0] ?? null;
};

// ── dirty-root skip ──────────────────────────────────────────────────────────

test('sweep: an unchanged event set skips the replay and leaves the row untouched', async () => {
  const clock = { value: T0 + 60_000 };
  const h = await openHarness(clock);
  try {
    const first = await h.refresher.refreshOnce('test-first');
    assert.equal(first.ok, true, first.error ?? '');
    assert.equal(h.fetchCount(), 10, 'one pool walk per collected path');

    const projection = h.store.getProjection(TASK_PIN);
    assert.ok(projection);
    assert.equal(projection.nodeStates.t1.status, 'claimed');
    assert.equal(projection.freshness.evaluatedAtMs, clock.value);

    // Sentinel the row: a skipped sweep must not rewrite it.
    h.sqliteStore.getDatabase().run('UPDATE metatask_task_projections SET title = ? WHERE root_pin_id = ?', [
      'SENTINEL',
      TASK_PIN,
    ]);
    const before = rowOf(h.sqliteStore, TASK_PIN);
    assert.equal(String(before[0]), 'SENTINEL');

    clock.value += 60_000; // still far below the 1h claim TTL
    const second = await h.refresher.refreshOnce('test-second');
    assert.equal(second.ok, true, second.error ?? '');
    assert.equal(h.fetchCount(), 20, 'the pool walk still happens (chain is the source of truth)');

    const after = rowOf(h.sqliteStore, TASK_PIN);
    assert.equal(String(after[0]), 'SENTINEL', 'skipped root: the projection row was not rewritten');
    assert.equal(String(after[3]), String(before[3]), 'refreshed_at unchanged');
    // The board reads the persisted row, so it is identical across the skip.
    const board = h.refresher.board();
    assert.equal(board.tasks[0].rootPinId, TASK_PIN);
    assert.equal(board.tasks[0].progress.claimed, 1);
  } finally {
    h.cleanup();
  }
});

test('sweep: a changed event set replays and rewrites the row', async () => {
  const clock = { value: T0 + 60_000 };
  const h = await openHarness(clock);
  try {
    await h.refresher.refreshOnce('test-first');
    h.sqliteStore.getDatabase().run('UPDATE metatask_task_projections SET title = ? WHERE root_pin_id = ?', [
      'SENTINEL',
      TASK_PIN,
    ]);

    // A new chain fact for the same task (earliest-holds keeps the first claim
    // as the holder, so the event set — not the state — is what changes).
    h.items.push(rawItem(
      'claim00000009i0',
      '/protocols/metatask/claim',
      { taskid: TASK_PIN, node: 't1' },
      { author: REVIEWER, height: 189_915 }
    ));
    clock.value += 60_000;
    await h.refresher.refreshOnce('test-second');

    const after = rowOf(h.sqliteStore, TASK_PIN);
    assert.equal(String(after[0]), 'sweep fixture', 'dirty root: the row was rewritten from a fresh replay');
    assert.notEqual(String(after[1]), '', 'the written row carries its dirty key');
  } finally {
    h.cleanup();
  }
});

test('sweep: a claim TTL that has not elapsed yet does not replay', async () => {
  const clock = { value: T0 + 60_000 };
  const h = await openHarness(clock);
  try {
    await h.refresher.refreshOnce('test-first');
    h.sqliteStore.getDatabase().run('UPDATE metatask_task_projections SET title = ? WHERE root_pin_id = ?', [
      'SENTINEL',
      TASK_PIN,
    ]);

    // 30 min into a 1h TTL: the clock has not tripped yet.
    clock.value = T0 + 30 * 60_000;
    await h.refresher.refreshOnce('test-early');
    assert.equal(String(rowOf(h.sqliteStore, TASK_PIN)[0]), 'SENTINEL', 'no premature replay');

    // Past the 1h TTL: the node must reopen even though nothing hit the chain.
    clock.value = T0 + 2 * 3_600_000;
    await h.refresher.refreshOnce('test-late');
    const projection = h.store.getProjection(TASK_PIN);
    assert.equal(projection.nodeStates.t1.status, 'open', 'the TTL reopen was applied');
    assert.equal(projection.freshness.evaluatedAtMs, clock.value);
  } finally {
    h.cleanup();
  }
});

test('sweep: an unconfirmed (mempool) event dirties the root even though eventSetHash excludes it', async () => {
  const clock = { value: T0 + 60_000 };
  const h = await openHarness(clock);
  try {
    await h.refresher.refreshOnce('test-first');
    const before = h.store.getProjection(TASK_PIN);
    assert.equal(before.nodeStates.r1.status, 'open');

    // r1 is unclaimed on chain; a mempool claim on it must still be replayed.
    h.items.push(rawItem(
      'claim00000010i0',
      '/protocols/metatask/claim',
      { taskid: TASK_PIN, node: 'r1' },
      { author: REVIEWER, height: -1 }
    ));
    clock.value += 60_000;
    await h.refresher.refreshOnce('test-mempool');

    const after = h.store.getProjection(TASK_PIN);
    assert.equal(after.nodeStates.r1.status, 'claimed', 'the mempool claim acted in the walk');
    assert.equal(
      after.freshness.eventSetHash,
      before.freshness.eventSetHash,
      'the engine eventSetHash recipe still excludes unconfirmed pins'
    );
  } finally {
    h.cleanup();
  }
});

test('sweep: a late-arriving roster pin dirties the root that references it', async () => {
  const ROSTER_PIN = 'roster00000001i0';
  const PEER = 'idq1sameownerpeer0000000000000000';
  const clock = { value: T0 + 60_000 };
  // Task published at/after H_ACT2 with quorum 1 and a split that references a
  // roster pin: the peer's pass would count only while the roster is missing.
  const items = [
    rawItem(
      TREE_PIN,
      '/protocols/metatask/tree',
      {
        root: 'r1',
        nodes: [
          { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
          { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 7000 },
        ],
      },
      { height: 191_480 }
    ),
    rawItem(
      TASK_PIN,
      '/protocols/metatask/task',
      {
        title: 'roster fixture',
        treeid: TREE_PIN,
        policy: {
          verify_quorum: 1,
          claim_ttl_hours: 0,
          verify_window_hours: 0,
          split: { submitterShareBP: 8000, rosterid: ROSTER_PIN },
        },
        tags: [],
      },
      { height: 191_481 }
    ),
    rawItem(CLAIM_PIN, '/protocols/metatask/claim', { taskid: TASK_PIN, node: 't1' }, { author: WORKER, height: 191_500 }),
    rawItem(
      'submiss0000001i0',
      '/protocols/metatask/submission',
      { taskid: TASK_PIN, node: 't1', claimid: CLAIM_PIN, result: { type: 'table' }, hash: '7'.repeat(64) },
      { author: WORKER, height: 191_501 }
    ),
    rawItem(
      'verify00000001i0',
      '/protocols/metatask/verify',
      { targetid: 'submiss0000001i0', verdict: 'pass', method: 'ran the spec', semantic_check: 'checked' },
      { author: PEER, height: 191_502 }
    ),
  ];
  const h = await openHarness(clock, { items });
  try {
    await h.refresher.refreshOnce('test-first');
    assert.equal(
      h.store.getProjection(TASK_PIN).nodeStates.t1.status,
      'verified',
      'no roster collected yet: the peer vote counts'
    );
    h.sqliteStore.getDatabase().run('UPDATE metatask_task_projections SET title = ? WHERE root_pin_id = ?', [
      'SENTINEL',
      TASK_PIN,
    ]);

    // The roster pin lands in the cache on a later sweep. It is NOT part of the
    // task's own event set, so only the dirty key can catch it.
    h.items.push(rawItem(
      ROSTER_PIN,
      '/protocols/metatask-roster',
      { groups: [[WORKER, PEER]], owner: 'idbots-local-roster' },
      { author: PUBLISHER, height: 191_490 }
    ));
    clock.value += 60_000;
    await h.refresher.refreshOnce('test-roster-arrived');

    const projection = h.store.getProjection(TASK_PIN);
    assert.equal(projection.nodeStates.t1.status, 'claimed', 'the same-side vote is now filtered');
    const row = rowOf(h.sqliteStore, TASK_PIN);
    assert.equal(String(row[0]), 'roster fixture', 'the row was rewritten from a fresh replay');
  } finally {
    h.cleanup();
  }
});

test('membership: the dirty key hashes exactly the engine eventSetHash input', () => {
  const events = [
    { pinId: TREE_PIN, path: 'tree', author: PUBLISHER, height: 189_900, txIndex: 0, timestampMs: T0, body: JSON.parse(Buffer.from(treeItem().contentBody, 'base64').toString('utf-8')) },
    { pinId: TASK_PIN, path: 'task', author: PUBLISHER, height: 189_901, txIndex: 0, timestampMs: T0, body: JSON.parse(Buffer.from(taskItem().contentBody, 'base64').toString('utf-8')) },
    { pinId: CLAIM_PIN, path: 'claim', author: WORKER, height: 189_910, txIndex: 0, timestampMs: T0, body: { taskid: TASK_PIN, node: 't1' } },
    { pinId: 'claim00000011i0', path: 'claim', author: REVIEWER, height: -1, txIndex: 0, timestampMs: T0, body: { taskid: TASK_PIN, node: 'r1' } },
  ];
  const taskSet = taskEventSet(events, { rootPinId: TASK_PIN });
  const projection = replayMetaTask(events, { rootPinId: TASK_PIN });

  // The shared helper IS the engine's hash input: no drift possible.
  assert.equal(sha256Hex(canonJ(taskSet.hashEntries)), projection.freshness.eventSetHash);
  assert.equal(taskSet.boundaryBlock, projection.freshness.boundaryBlock);
  // The mempool pin is scoped (it acts in the walk) but not in the hash.
  assert.deepEqual(taskSet.mempoolPinIds, ['claim00000011i0']);
  assert.equal(taskSet.hashEntries.some((entry) => entry.pinId === 'claim00000011i0'), false);
  assert.notEqual(taskDirtyKey(taskSet), sha256Hex(canonJ(taskSet.hashEntries)));
});

test('dirty key: a body change with identical pin ids and heights flips the key', () => {
  const eventSet = (treeBody) => [
    { pinId: TREE_PIN, path: 'tree', author: PUBLISHER, height: 189_900, txIndex: 0, timestampMs: T0, body: treeBody },
    { pinId: TASK_PIN, path: 'task', author: PUBLISHER, height: 189_901, txIndex: 0, timestampMs: T0, body: JSON.parse(Buffer.from(taskItem().contentBody, 'base64').toString('utf-8')) },
    { pinId: CLAIM_PIN, path: 'claim', author: WORKER, height: 189_910, txIndex: 0, timestampMs: T0, body: { taskid: TASK_PIN, node: 't1' } },
  ];
  const treeBody = JSON.parse(Buffer.from(treeItem().contentBody, 'base64').toString('utf-8'));
  const keyOf = (events) => taskDirtyKey(taskEventSet(events, { rootPinId: TASK_PIN }), { rosterPins: {} });

  // Identical inputs (fresh objects) hash identically.
  assert.equal(keyOf(eventSet(treeBody)), keyOf(eventSet(JSON.parse(JSON.stringify(treeBody)))));

  // The degraded indexer body (truncated summary that never parsed) must
  // produce a DIFFERENT key than the recovered full body — same pin ids and
  // heights, only the content differs.
  const degraded = keyOf(eventSet({}));
  assert.notEqual(degraded, keyOf(eventSet(treeBody)));
  assert.notEqual(degraded, keyOf(eventSet({ ...treeBody, padding: 'y'.repeat(10) })));

  // ...while the protocol eventSetHash is body-insensitive by design.
  assert.equal(
    replayMetaTask(eventSet({}), { rootPinId: TASK_PIN }).freshness.eventSetHash,
    replayMetaTask(eventSet(treeBody), { rootPinId: TASK_PIN }).freshness.eventSetHash,
    'the recovery must not disturb the pinned protocol hash'
  );
});

test('dirty key: the projection-format salt invalidates pre-upgrade keys', () => {
  const events = [
    { pinId: TREE_PIN, path: 'tree', author: PUBLISHER, height: 189_900, txIndex: 0, timestampMs: T0, body: JSON.parse(Buffer.from(treeItem().contentBody, 'base64').toString('utf-8')) },
    { pinId: TASK_PIN, path: 'task', author: PUBLISHER, height: 189_901, txIndex: 0, timestampMs: T0, body: JSON.parse(Buffer.from(taskItem().contentBody, 'base64').toString('utf-8')) },
  ];
  const taskSet = taskEventSet(events, { rootPinId: TASK_PIN });

  // Reconstruct the pre-salt recipe inline (what an older build would have
  // stored): identical events, no formatVersion member.
  const legacyKey = sha256Hex(
    canonJ({
      confirmed: taskSet.hashEntries,
      unconfirmed: taskSet.mempoolPinIds,
      bodies: taskSet.scoped
        .map((pin) => ({ pinId: pin.pinId, bodyHash: sha256Hex(canonJ(pin.body)) }))
        .sort((a, b) => (a.pinId < b.pinId ? -1 : a.pinId > b.pinId ? 1 : 0)),
      rosterPin: null,
    })
  );
  assert.notEqual(taskDirtyKey(taskSet), legacyKey);
  // ...and the salted key is still stable for identical inputs.
  assert.equal(taskDirtyKey(taskSet), taskDirtyKey(taskEventSet(JSON.parse(JSON.stringify(events)), { rootPinId: TASK_PIN })));
});

// ── content recovery: end-to-end self-heal ───────────────────────────────────

const BIG_TREE_PIN = 'treebig0000001i0';

/** The f23e8ec list-row shape for a body longer than the summary window. */
const truncatedTreeRow = (fullBody) => {
  const json = JSON.stringify(fullBody);
  return {
    id: BIG_TREE_PIN,
    path: '/protocols/metatask/tree',
    globalMetaId: PUBLISHER,
    genesisHeight: 189_900,
    txIndex: 0,
    timestamp: T0,
    contentSummary: json.slice(0, 4096),
    contentBody: '',
    content: `https://manapi.metaid.io/content/${BIG_TREE_PIN}`,
    contentLength: Buffer.byteLength(json, 'utf8'),
  };
};

const bigTreeBody = () => ({
  root: 'r1',
  nodes: [
    { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
    { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 7000 },
    { id: 't2', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 1000 },
    { id: 't3', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 1000 },
  ],
  // Past the summary window, so the truncation cuts inside this string.
  padding: 'x'.repeat(5_000),
});

test('sweep: a poisoned tree body self-heals once the indexer serves the full content', async () => {
  const clock = { value: T0 + 60_000 };
  const treePin = BIG_TREE_PIN;
  const treeBody = bigTreeBody();
  const taskBody = {
    title: 'sweep fixture',
    treeid: treePin,
    policy: { verify_quorum: 2, claim_ttl_hours: 1, verify_window_hours: 0 },
    tags: [],
  };
  const items = [
    truncatedTreeRow(treeBody),
    { ...taskItem(), contentBody: Buffer.from(JSON.stringify(taskBody)).toString('base64') },
    claimItem(),
  ];
  const h = await openHarness(clock, { items, contentBodies: { [treePin]: treeBody } });
  try {
    // Seed the cache with the DEGRADED body an earlier sweep stored, and the
    // broken projection it produced (all nodes dropped as unknown_node).
    const poisonedEvents = [
      { pinId: treePin, path: 'tree', author: PUBLISHER, height: 189_900, txIndex: 0, timestampMs: T0, body: {} },
      { pinId: TASK_PIN, path: 'task', author: PUBLISHER, height: 189_901, txIndex: 0, timestampMs: T0, body: taskBody },
      { pinId: CLAIM_PIN, path: 'claim', author: WORKER, height: 189_910, txIndex: 0, timestampMs: T0, body: { taskid: TASK_PIN, node: 't1' } },
    ];
    h.store.upsertEvents(poisonedEvents);
    const broken = replayMetaTask(h.store.loadEvents(), { rootPinId: TASK_PIN });
    assert.equal(broken.progress.total, 0, 'the poisoned tree has no nodes');
    assert.equal(broken.freshness.eventSetHash, replayMetaTask(
      poisonedEvents.map((event) => (event.pinId === treePin ? { ...event, body: treeBody } : event)),
      { rootPinId: TASK_PIN }
    ).freshness.eventSetHash, 'same chain facts, different body');
    // Persist it with the dirty key the CURRENT content produces: the pin ids
    // and heights do not change during recovery, so only a body-sensitive key
    // can tell the sweep that this root needs another replay.
    h.store.saveProjections([broken], {
      liveRootIds: [TASK_PIN],
      dirtyKeys: {
        [TASK_PIN]: taskDirtyKey(taskEventSet(h.store.loadEvents(), { rootPinId: TASK_PIN }), { rosterPins: {} }),
      },
    });

    const result = await h.refresher.refreshOnce('self-heal');
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(h.contentFetchCount(), 1, 'exactly the poisoned pin was refetched');

    const healed = h.store.getProjection(TASK_PIN);
    assert.equal(healed.progress.total, 4, 'every tree node is back');
    assert.equal(healed.progress.claimed, 1, 'the claim is effective again');
    assert.deepEqual(Object.keys(healed.nodeStates).sort(), ['r1', 't1', 't2', 't3']);
    assert.equal(
      healed.freshness.eventSetHash,
      broken.freshness.eventSetHash,
      'the protocol hash never moved — only the recovered body did'
    );
    assert.deepEqual(
      h.store.loadEvents().find((event) => event.pinId === treePin).body,
      treeBody,
      'the cache now holds the full body'
    );
  } finally {
    h.cleanup();
  }
});

// ── nextTimeDeadlineMs: the three engine clocks ──────────────────────────────

const projectionFixture = (over = {}) => ({
  rootPinId: TASK_PIN,
  publisher: PUBLISHER,
  policy: {
    claimTtlHours: over.claimTtlHours ?? 0,
    verifyQuorum: over.verifyQuorum ?? 2,
    verifyWindowHours: over.verifyWindowHours ?? 0,
    rewardSat: 0,
    challengeTtlDays: over.challengeTtlDays ?? 14,
    hasSplit: false,
    rosterid: null,
    submitterShareBP: 8000,
  },
  nodes: [],
  nodeStates: over.nodeStates ?? {},
  participants: [],
  progress: { total: 0, verified: 0, claimed: 0, open: 0, disputed: 0 },
  freshness: { boundaryBlock: 1, evaluatedAtMs: 0, eventCount: 0, eventSetHash: 'h', expiryApplied: true },
  settlement: null,
  ignoredEvents: [],
});

const HOUR = 3_600_000;
const DAY = 86_400_000;

test('wiring: the heartbeat sweep bypasses the coalescing window and is jittered', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const mainSource = fs.readFileSync(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf-8');
  assert.match(
    mainSource,
    /name: 'metatask\.refresh',\n\s+intervalMs: 5 \* 60_000,\n\s+jitterMs: 45_000,/,
    'the 5-min sweep carries a jitter so instances do not walk the pools in lockstep'
  );
  assert.match(
    mainSource,
    /refreshOnce\('heartbeat-refresh', \{ bypassMinInterval: true \}\)/,
    'the heartbeat sweep must never be deferred by tool-triggered coalescing'
  );
  assert.match(mainSource, /name: 'metatask\.watch',\n\s+intervalMs: 10 \* 60_000,\n\s+jitterMs: 90_000,/);
});

test('deadlines: claimTTL is derived from the holder clock', () => {
  const projection = projectionFixture({
    claimTtlHours: 2,
    nodeStates: {
      t1: { id: 't1', status: 'claimed', disputed: false, holder: { pinId: CLAIM_PIN, claimant: WORKER, sinceMs: 1_000 }, submission: null, passVotes: 0, failVotes: 0, votes: [] },
    },
  });
  assert.equal(nextTimeDeadlineMs(projection), 1_000 + 2 * HOUR);
  assert.equal(nextTimeDeadlineMs(projectionFixture()), null, 'no holders and no challenges: no clock');
});

test('deadlines: reviewWindow only runs while the submission is short of quorum', () => {
  const node = (passVotes) => ({
    t1: {
      id: 't1',
      status: 'claimed',
      disputed: false,
      holder: { pinId: CLAIM_PIN, claimant: WORKER, sinceMs: 1_000 },
      submission: { pinId: 'sub000000001i0', submitter: WORKER, atMs: 5_000, superseded: false, result: null, hash: null, contentType: null, attachment: null },
      passVotes,
      failVotes: 0,
      votes: [],
    },
  });
  const short = projectionFixture({ verifyWindowHours: 1, verifyQuorum: 2, nodeStates: node(1) });
  assert.equal(nextTimeDeadlineMs(short), 5_000 + HOUR);
  const satisfied = projectionFixture({ verifyWindowHours: 1, verifyQuorum: 2, nodeStates: node(2) });
  assert.equal(nextTimeDeadlineMs(satisfied), null);
});

test('deadlines: challengeTTL comes from the scoped challenge timestamps', () => {
  const projection = projectionFixture({ challengeTtlDays: 3 });
  assert.equal(nextTimeDeadlineMs(projection, { challengeTimestampsMs: [1_000] }), 1_000 + 3 * DAY);
  // A pin without a timestamp carries no clock (the engine skips it too), and
  // the earliest of several candidates wins.
  assert.equal(nextTimeDeadlineMs(projection, { challengeTimestampsMs: [0, 4_000, 2_000] }), 2_000 + 3 * DAY);
});

// ── minimum-interval coalescing ──────────────────────────────────────────────

test('refreshOnce: ordinary callers coalesce into exactly one trailing sweep', async () => {
  const clock = { value: T0 + 60_000 };
  const h = await openHarness(clock, { minIntervalMs: 40 });
  try {
    await h.refresher.refreshOnce('tool-a');
    assert.equal(h.fetchCount(), 10);

    const trailingA = h.refresher.refreshOnce('tool-b');
    const trailingB = h.refresher.refreshOnce('tool-c');
    assert.equal(trailingA, trailingB, 'rapid callers share one trailing sweep');
    assert.equal(h.fetchCount(), 10, 'nothing runs inside the window');

    const result = await trailingA;
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(h.fetchCount(), 20, 'exactly one trailing sweep ran');
  } finally {
    h.cleanup();
  }
});

test('refreshOnce: heartbeat callers bypass the interval and never wait', async () => {
  const clock = { value: T0 + 60_000 };
  const h = await openHarness(clock, { minIntervalMs: 60_000 });
  try {
    await h.refresher.refreshOnce('tool-a');
    assert.equal(h.fetchCount(), 10);

    // Inside the 60s window, but the heartbeat's own cadence already spaces it.
    const result = await h.refresher.refreshOnce('heartbeat-refresh', { bypassMinInterval: true });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(h.fetchCount(), 20);

    // The bypassed sweep still resets the window for ordinary callers.
    const deferred = h.refresher.refreshOnce('tool-b');
    assert.equal(h.fetchCount(), 20, 'ordinary caller deferred behind the heartbeat sweep');
    assert.ok(deferred);
  } finally {
    // dispose() cancels the pending coalesced sweep (the timer is unref'd too).
    h.cleanup();
  }
});
