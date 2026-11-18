import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const { MetawebSurfStore } = await import('../dist-electron/main/metawebSurfStore.js');
const { SurfService } = await import('../dist-electron/main/services/surfService.js');

const NOW_MS = Date.parse('2026-09-13T01:00:00.000Z');
const NOW_SEC = Math.floor(NOW_MS / 1000);

const makeItem = (pinId, createdAt, protocolKey = 'alpha') => ({
  pinId,
  protocolKey,
  chainName: 'mvc',
  title: `Title ${pinId}`,
  summary: '',
  authorName: '',
  authorGlobalMetaId: 'idq-test',
  createdAt,
  likeCount: null,
  commentCount: null,
  extra: null,
});

const setup = (registry) => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new MetawebSurfStore(db, () => {});
  const events = [];
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: (id) => (id === 7 ? { id: 7, name: 'Tester' } : null),
      getMetabotSetting: () => null,
    },
    broadcast: (payload) => events.push(payload),
    registry,
    nowMs: () => NOW_MS,
  });
  return { store, service, events };
};

const alphaDescriptor = (items) => ({
  key: 'alpha',
  displayName: 'Fake alpha',
  paths: ['/protocols/alpha'],
  interactions: ['like'],
  relevanceHint: 'hint',
  fetchFresh: async () => ({ items, hasMore: false, nextCursor: null }),
});

test('digest-only run: report written, watermark advanced, events broadcast', async () => {
  const { store, service, events } = setup([alphaDescriptor([makeItem('pin-a', NOW_SEC - 100), makeItem('pin-b', NOW_SEC - 50)])]);
  const run = await service.runSurfAndWait(7, 'manual-ui');

  assert.equal(run.status, 'done');
  assert.equal(run.stats.fetched, 2);
  // Digest-only runs (no injected session) keep the digest in its own
  // column; the report itself is empty (live-audit round 1 separation).
  assert.equal(run.reportMarkdown, null);
  assert.match(run.briefingMarkdown, /# Surf digest/);
  assert.match(run.briefingMarkdown, /pin-a/);

  const state = store.getProtocolState(7, 'alpha');
  assert.equal(state.lastSeenTs, NOW_SEC - 100, 'watermark advances to the oldest kept item (cap defers, never drops)');

  assert.deepEqual(events.map((e) => e.status), ['running', 'done']);
  assert.equal(events[0].trigger, 'manual-ui');
});

test('second surf finds nothing new (watermark + seen ledger)', async () => {
  const { service } = setup([alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])]);
  await service.runSurfAndWait(7, 'manual-ui');
  const second = await service.runSurfAndWait(7, 'pre-dream');
  assert.equal(second.status, 'done');
  assert.equal(second.stats.fetched, 0);
});

test('failed protocol fetch keeps its watermark for retry', async () => {
  const failing = {
    key: 'broken',
    displayName: 'Broken',
    paths: ['/protocols/broken'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: async () => { throw new Error('boom'); },
  };
  const { store, service } = setup([failing]);
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done', 'protocol failure is a section error, not a run failure');
  assert.equal(store.getProtocolState(7, 'broken'), null);
});

test('per-bot mutex: a second start while running throws', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = {
    key: 'slow',
    displayName: 'Slow',
    paths: ['/protocols/slow'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: () => gate.then(() => ({ items: [], hasMore: false, nextCursor: null })),
  };
  const { service } = setup([slow]);
  service.startSurf(7, 'manual-ui');
  assert.throws(() => service.startSurf(7, 'manual-ui'), /already in progress/);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotThrow(() => service.startSurf(7, 'manual-ui'));
});

test('unknown bot is rejected', async () => {
  const { service } = setup([]);
  await assert.rejects(() => service.runSurfAndWait(9, 'manual-ui'), /not found/);
});

test('pre-dream surf toggle defaults twin-only: unset = ON for the Twin / OFF for others, explicit values always win', () => {
  // Owner decision (2026-10-26 nightly-token audit): the 2026-09-28
  // default-on flips to twin-only. Bots that predate the flip carry an
  // explicit '1' from the MetabotStore legacy-pin migration and keep
  // surfing until they opt out; bots created after it ride the type
  // default. An explicit '0' opts any bot out; '1' opts any bot in.
  const settings = new Map();
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: (id, key) => settings.get(key) ?? null,
      isTwinMetabot: (id) => id === 7,
    },
    broadcast: () => {},
    registry: [],
    nowMs: () => NOW_MS,
  });
  assert.equal(service.shouldPreDreamSurf(7), true, 'unset + Twin means ON');
  assert.equal(service.shouldPreDreamSurf(8), false, 'unset + non-Twin means OFF');
  settings.set('surf_before_dream_enabled', '1');
  assert.equal(service.shouldPreDreamSurf(8), true, 'explicit 1 opts a non-Twin in');
  settings.set('surf_before_dream_enabled', '0');
  assert.equal(service.shouldPreDreamSurf(7), false, 'explicit 0 opts the Twin out');
  // A stub without the twin probe (legacy harnesses) resolves to OFF — the
  // safe side of the default.
  const legacyService = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [],
    nowMs: () => NOW_MS,
  });
  assert.equal(legacyService.shouldPreDreamSurf(7), false, 'no twin probe reads as non-Twin');
});

test('fresh-install deferral: pre-dream surf is skipped while the gate reports a reason', async () => {
  // 2026-10-12 fresh-install incident: the nightly pre-dream surf is part of
  // the background pipeline and must wait out the deferral window; a MANUAL
  // surf stays available (it is a user action, not background automation).
  let deferredReason = 'install is 0h old; 24h0m left of the 24h fresh-install window';
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      // Surf explicitly enabled: this test exercises the deferral gate, not
      // the (twin-only) toggle default.
      getMetabotSetting: (id, key) => (key === 'surf_before_dream_enabled' ? '1' : null),
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    backgroundDeferral: () => deferredReason,
    nowMs: () => NOW_MS,
  });

  assert.equal(service.shouldPreDreamSurf(7), false, 'pre-dream surf is deferred');
  assert.equal(store.listRunsByMetabot(7).length, 0, 'the deferred pre-dream trigger left no run row');

  // Manual triggers are user actions: they run even inside the window.
  const manual = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(manual.status, 'done', 'a manual trigger still runs while deferred');

  // Once the window elapses the pre-dream gate reopens — the deferral is a
  // wait, not a permanent opt-out. (The manual run above then suppresses it
  // via the normal 20h recency dedupe, so this asserts the gate itself by
  // reading it with the recency anchor still in place.)
  deferredReason = null;
  assert.equal(service.shouldPreDreamSurf(7), false, 'the manual run keeps the pre-dream dedupe');
  assert.equal(service.shouldPreDreamSurf(8), true, 'a bot with no recent run is surfable again');
});

test('memory-disabled bot: manual surf runs degraded, pre-dream stays gated (review 2, item 9B)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      // Surf explicitly enabled: this test exercises the memory gate, not
      // the (twin-only) toggle default.
      getMetabotSetting: (id, key) => (key === 'surf_before_dream_enabled' ? '1' : null),
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    isMemoryEnabled: () => false,
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done', 'manual triggers RUN even with memory off (degraded, option B)');
  assert.equal(store.getSeenAction(7, 'pin-a'), 'presented');
  assert.throws(() => service.startSurf(7, 'pre-dream'), /requires memory/);
  assert.equal(store.listRunsByMetabot(7).length, 1, 'the rejected pre-dream trigger left no run row');
  assert.equal(service.shouldPreDreamSurf(7), false, 'pre-dream path stays memory-gated');
});

test('injected session overrides digest stats and prepends its report', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    runSurfSession: async () => ({
      stats: { savedToKb: 1, liked: 2 },
      reportMarkdown: '# Session report',
      reportJson: '{"liked":2}',
    }),
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.stats.fetched, 1);
  assert.equal(run.stats.savedToKb, 1);
  assert.equal(run.stats.liked, 2);
  assert.match(run.reportMarkdown, /^# Session report/);
  assert.doesNotMatch(run.reportMarkdown, /# Surf digest/);
  assert.match(run.briefingMarkdown, /# Surf digest/);
  assert.equal(run.reportJson, '{"liked":2}');
});

test('session failure fails the run without advancing watermarks', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    runSurfSession: async () => { throw new Error('llm down'); },
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /llm down/);
  assert.equal(store.getProtocolState(7, 'alpha'), null);
});

test('a session that returns no report and no receipts fails the run and keeps the window (live-audit round 1)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    runSurfSession: async () => ({
      stats: { deepRead: 0, savedToKb: 0, liked: 0, commented: 0, answered: 0, posted: 0, challenged: 0, inboxHandled: 0, tasksScheduled: 0 },
      reportMarkdown: null,
      reportJson: null,
    }),
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /without a report and without any host-verifiable activity/);
  // Nothing consumed: no seen-ledger marks, no watermark, next run re-presents.
  assert.equal(store.getSeenAction(7, 'pin-a'), null);
  assert.equal(store.getProtocolState(7, 'alpha'), null);
  // A sibling run WITH receipts (even without a report) still completes —
  // host-verifiable work must not be punished for the missing JSON fence.
  const service2 = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-b', NOW_SEC - 50)])],
    runSurfSession: async () => ({ stats: { deepRead: 1 }, reportMarkdown: null, reportJson: null }),
    nowMs: () => NOW_MS,
  });
  const run2 = await service2.runSurfAndWait(7, 'manual-ui');
  assert.equal(run2.status, 'done');
  assert.equal(run2.stats.deepRead, 1);
});

test('a failed run re-presents the same window on the next surf (P1 regression)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const metabotStore = {
    getMetabotById: () => ({ id: 7, name: 'Tester' }),
    getMetabotSetting: () => null,
  };
  const registry = [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100), makeItem('pin-b', NOW_SEC - 50)])];
  const failing = new SurfService({
    store,
    metabotStore,
    broadcast: () => {},
    registry,
    runSurfSession: async () => { throw new Error('llm down'); },
    nowMs: () => NOW_MS,
  });
  const failed = await failing.runSurfAndWait(7, 'manual-ui');
  assert.equal(failed.status, 'failed');
  assert.equal(store.getSeenAction(7, 'pin-a'), null, 'failed run must not mark pins presented');
  assert.equal(store.getSeenAction(7, 'pin-b'), null);

  const digestOnly = new SurfService({
    store,
    metabotStore,
    broadcast: () => {},
    registry,
    nowMs: () => NOW_MS,
  });
  const retry = await digestOnly.runSurfAndWait(7, 'pre-dream');
  assert.equal(retry.status, 'done');
  assert.equal(retry.stats.fetched, 2, 'the lost window is presented again after the failure');
  assert.match(retry.briefingMarkdown, /pin-a/);
  assert.equal(store.getSeenAction(7, 'pin-a'), 'presented', 'success path marks presented');
  assert.equal(store.getProtocolState(7, 'alpha').lastSeenTs, NOW_SEC - 100, 'watermark lands on the oldest kept item');
});

test('crash recovery fails stale running rows', () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  store.createRun({ id: 'stale-1', metabotId: 7, trigger: 'manual-ui', nowIso: '2026-09-12T01:00:00.000Z' });
  const service = new SurfService({
    store,
    metabotStore: { getMetabotById: () => null, getMetabotSetting: () => null },
    broadcast: () => {},
    registry: [],
    nowMs: () => NOW_MS,
  });
  assert.equal(service.recoverAfterRestart(), 1);
  assert.equal(store.getRun('stale-1').status, 'failed');
});

test('a failed run keeps the real partial stats attached to the session error (round 3)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    runSurfSession: async () => {
      const error = new Error('Skill turn timed out after 3600s');
      error.surfPartialStats = { deepRead: 26, savedToKb: 2, liked: 6, commented: 1 };
      throw error;
    },
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'failed');
  assert.equal(run.stats.fetched, 1, 'fetched comes from the briefing even on failure');
  assert.equal(run.stats.deepRead, 26, 'host-vouched partial stats land on the failed row');
  assert.equal(run.stats.savedToKb, 2);
  assert.equal(run.stats.liked, 6);
  assert.equal(run.stats.commented, 1);
  assert.equal(run.stats.answered, 0, 'untouched classes stay zero');
  assert.equal(store.getSeenAction(7, 'pin-a'), null, 'partial stats never touch the seen ledger');
});

test('a failed run without attached partial stats reports fetched only', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100), makeItem('pin-b', NOW_SEC - 50)])],
    runSurfSession: async () => { throw new Error('llm down'); },
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'failed');
  assert.equal(run.stats.fetched, 2);
  assert.equal(run.stats.deepRead, 0);
  assert.equal(run.stats.liked, 0);
});

test('the next run inherits the notes written by the previous DONE run (round 3)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  store.createRun({ id: 'done-1', metabotId: 7, trigger: 'manual-ui', nowIso: '2026-09-12T01:00:00.000Z' });
  store.finishRun('done-1', {
    status: 'done',
    stats: {},
    reportMarkdown: '# old report',
    reportJson: JSON.stringify({ summary: 'old', notes: 'E-4/E-5 errata still pending implementation — check again' }),
    finishedAtIso: '2026-09-12T01:30:00.000Z',
  });
  let seenContext = null;
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    runSurfSession: async (context) => {
      seenContext = context;
      return { stats: {}, reportMarkdown: '# Report', reportJson: '{"summary":"ok"}' };
    },
    nowMs: () => NOW_MS,
  });
  await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(seenContext.previousNotes, 'E-4/E-5 errata still pending implementation — check again');
});

test('pre-briefing reconciliation backfills lost receipts and filters own posts (round 3)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([
      makeItem('pin-orphan-liked', NOW_SEC - 100),
      makeItem('pin-own-post', NOW_SEC - 90),
      makeItem('pin-fresh', NOW_SEC - 80),
    ])],
    // A crash/orphan scenario: the bot DID like pin-orphan-liked and publish
    // pin-own-post, but neither receipt ever reached the seen ledger.
    listChainWritesForSurf: () => [
      { pinId: 'reaction-1', path: '/protocols/paylike', contentText: JSON.stringify({ isLike: 1, likeTo: 'pin-orphan-liked' }) },
      { pinId: 'pin-own-post', path: '/protocols/simplebuzz', contentText: '{"content":"mine"}' },
    ],
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done');
  assert.equal(store.getSeenAction(7, 'pin-orphan-liked'), 'liked', 'lost like receipt restored locally');
  assert.equal(store.getSeenAction(7, 'pin-own-post'), 'posted', 'own post marked posted');
  assert.equal(store.getSeenAction(7, 'reaction-1'), 'posted', 'the reaction pin itself is own content');
  assert.deepEqual(
    JSON.parse(JSON.stringify(run.stats)).fetched,
    1,
    'only the genuinely fresh pin is presented — reconciled pins stay out of the digest',
  );
});

test('a run with no reconciliation dep simply skips it', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done');
  assert.equal(run.stats.fetched, 1);
});

// ---------------------------------------------------------------------------
// Surf-reads backend migration: backlog cursor lifecycle, deterministic inbox,
// protocol radar (service level — what the success path persists)
// ---------------------------------------------------------------------------

const makeInboxItem = (pinId, createdAt) => ({
  type: 'simpleanswer',
  pinId,
  targetPinId: 'own-question-1',
  actorName: 'Alice',
  actorGlobalMetaId: 'idq-alice',
  createdAt,
  excerpt: 'try the pipeline route',
});

test('backlog lifecycle: window debt registered → backlog page next run → drained clears; watermark untouched by backlog', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const metabotStore = {
    getMetabotById: () => ({ id: 7, name: 'Tester' }),
    getMetabotSetting: () => null,
  };
  const calls = [];
  // Run 1: window fetch reports hasMore → debt registered. Run 2: backlog page
  // (hasMore) → next cursor stored. Run 3: backlog drained → cursor cleared.
  let runIndex = 0;
  const pagedDescriptor = {
    key: 'alpha',
    displayName: 'Fake alpha',
    paths: ['/protocols/alpha'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: async (input) => {
      calls.push({ run: runIndex, ...input });
      runIndex += 1;
      if (runIndex === 1) {
        return { items: [makeItem('pin-window', NOW_SEC - 100)], hasMore: true, nextCursor: 'cursor-page-2' };
      }
      if (runIndex === 2) {
        assert.equal(input.backlogCursor, 'cursor-page-2', 'run 2 continues the registered backlog page');
        return { items: [makeItem('pin-backlog', NOW_SEC - 900)], hasMore: true, nextCursor: 'cursor-page-3' };
      }
      assert.equal(input.backlogCursor, 'cursor-page-3');
      return { items: [makeItem('pin-backlog-2', NOW_SEC - 950)], hasMore: false, nextCursor: null };
    },
  };
  const service = new SurfService({
    store,
    metabotStore,
    broadcast: () => {},
    registry: [pagedDescriptor],
    nowMs: () => NOW_MS,
  });

  const first = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(first.status, 'done');
  let state = store.getProtocolState(7, 'alpha');
  assert.equal(state.lastSeenTs, NOW_SEC - 100, 'window run advances the watermark normally');
  assert.equal(state.backlogCursor, 'cursor-page-2', 'debt registered on the success path');

  const second = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(second.status, 'done');
  state = store.getProtocolState(7, 'alpha');
  assert.equal(state.lastSeenTs, NOW_SEC - 100, 'backlog page NEVER moves the watermark');
  assert.equal(state.backlogCursor, 'cursor-page-3', 'continued backlog debt stored verbatim');

  const third = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(third.status, 'done');
  state = store.getProtocolState(7, 'alpha');
  assert.equal(state.lastSeenTs, NOW_SEC - 100);
  assert.equal(state.backlogCursor, null, 'drained backlog clears the debt');
  assert.equal(store.getSeenAction(7, 'pin-window'), 'presented');
  assert.equal(store.getSeenAction(7, 'pin-backlog'), 'presented', 'backlog items are still marked presented');
  assert.equal(store.getSeenAction(7, 'pin-backlog-2'), 'presented');
});

test('backlog cursor survives a failed run (side-effect discipline)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  store.advanceProtocolState(7, 'alpha', {
    lastSeenTs: NOW_SEC - 500,
    lastPinId: null,
    nowIso: '2026-09-12T01:00:00.000Z',
    backlogCursor: 'cursor-page-2',
  });
  const failing = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    runSurfSession: async () => { throw new Error('llm down'); },
    nowMs: () => NOW_MS,
  });
  const run = await failing.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'failed');
  const state = store.getProtocolState(7, 'alpha');
  assert.equal(state.backlogCursor, 'cursor-page-2', 'failed run leaves the cursor untouched');
  assert.equal(state.lastSeenTs, NOW_SEC - 500, 'failed run leaves the watermark untouched');
});

test('inbox: baseline is the previous run START (createdAt), owner from identity, items folded into the same markSeenBatch', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  store.createRun({ id: 'prev-run', metabotId: 7, trigger: 'manual-ui', nowIso: '2026-09-12T00:30:00.000Z' });
  store.finishRun('prev-run', {
    status: 'done',
    stats: {},
    finishedAtIso: '2026-09-12T01:30:00.000Z',
  });
  const inboxCalls = [];
  let seenBriefing = null;
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    getBotIdentity: () => ({ address: '0xABC', globalMetaId: 'idq-tester' }),
    fetchSurfInbox: async ({ owner, sinceTs }) => {
      inboxCalls.push({ owner, sinceTs });
      return [makeInboxItem('inbox-1', NOW_SEC - 200)];
    },
    runSurfSession: async (context) => {
      seenBriefing = context.briefing;
      return { stats: {}, reportMarkdown: '# Report', reportJson: '{"summary":"ok"}' };
    },
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done');
  assert.deepEqual(inboxCalls, [
    { owner: '0xABC', sinceTs: Math.floor(Date.parse('2026-09-12T00:30:00.000Z') / 1000) },
  ], 'baseline = the previous run START (createdAt), NOT finishedAt; owner = identity address');
  assert.equal(seenBriefing.inbox.items.length, 1);
  assert.equal(seenBriefing.inbox.items[0].pinId, 'inbox-1');
  assert.equal(run.stats.inboxPresented, 1, 'host-computed inbox count lands in run stats');
  assert.equal(store.getSeenAction(7, 'inbox-1'), 'presented', 'inbox pins fold into the same success-path batch');

  // Next run: the same interaction is ledger-filtered (exactly-once) and the
  // baseline moved to THIS run's start.
  const secondCalls = [];
  const secondService = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([])],
    getBotIdentity: () => ({ address: null, globalMetaId: 'idq-tester' }),
    fetchSurfInbox: async ({ owner, sinceTs }) => {
      secondCalls.push({ owner, sinceTs });
      return [makeInboxItem('inbox-1', NOW_SEC - 200), makeInboxItem('inbox-2', NOW_SEC - 50)];
    },
    runSurfSession: async (context) => {
      seenBriefing = context.briefing;
      return { stats: {}, reportMarkdown: '# Report', reportJson: '{"summary":"ok"}' };
    },
    nowMs: () => NOW_MS,
  });
  await secondService.runSurfAndWait(7, 'manual-ui');
  assert.deepEqual(secondCalls[0].owner, 'idq-tester', 'globalMetaId fallback when the address is missing');
  assert.deepEqual(
    seenBriefing.inbox.items.map((item) => item.pinId),
    ['inbox-2'],
    'the already-presented interaction never surfaces twice',
  );
});

test('inbox: no identity or no fetcher → no inbox section, run still succeeds', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  let seenBriefing = null;
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    getBotIdentity: () => ({ address: null, globalMetaId: null }),
    fetchSurfInbox: async () => { throw new Error('must not be called without an owner'); },
    runSurfSession: async (context) => {
      seenBriefing = context.briefing;
      return { stats: {}, reportMarkdown: '# Report', reportJson: '{"summary":"ok"}' };
    },
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done');
  assert.equal(seenBriefing.inbox, undefined, 'no owner → no inbox fetch at all');
});

test('radar: fetchProtocolRadar flows into the briefing and a failure still finishes the run', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  let seenBriefing = null;
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    fetchProtocolRadar: async () => ({
      items: [
        { path: '/protocols/alpha', title: 'Alpha', protocolName: 'alpha', intro: 'i', version: '1', authorName: 'Bob', createdAt: NOW_SEC - 10 },
      ],
      rejectedCount: 0,
    }),
    runSurfSession: async (context) => {
      seenBriefing = context.briefing;
      return { stats: {}, reportMarkdown: '# Report', reportJson: '{"summary":"ok"}' };
    },
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done');
  assert.equal(seenBriefing.protocolRadar.items.length, 1);
  assert.match(run.briefingMarkdown, /## Protocol radar — 1 registered protocol\(s\)/, 'radar lands in the digest appendix');

  const failingRadar = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([])],
    fetchProtocolRadar: async () => { throw new Error('radar down'); },
    nowMs: () => NOW_MS,
  });
  const second = await failingRadar.runSurfAndWait(7, 'manual-ui');
  assert.equal(second.status, 'done', 'a sick radar backend never fails the run');
  assert.match(second.briefingMarkdown, /radar fetch failed: radar down/);
});

// --- Empty-briefing skip (nightly-token audit 2026-10-25) ---------------------

const sessionRecorder = () => {
  const calls = [];
  const runSurfSession = async (context) => {
    calls.push(context);
    return { stats: { deepRead: 1 }, reportMarkdown: '# Report', reportJson: '{"summary":"ok"}' };
  };
  return { calls, runSurfSession };
};

const sessionService = (store, registry, extra = {}) => new SurfService({
  store,
  metabotStore: {
    getMetabotById: () => ({ id: 7, name: 'Tester' }),
    // Surf explicitly enabled: these tests exercise the empty-briefing skip,
    // not the (twin-only) toggle default.
    getMetabotSetting: (id, key) => (key === 'surf_before_dream_enabled' ? '1' : null),
  },
  broadcast: () => {},
  registry,
  nowMs: () => NOW_MS,
  ...extra,
});

test('pre-dream: an empty briefing skips the LLM session and finishes digest-only', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const registry = [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])];
  const { calls, runSurfSession } = sessionRecorder();
  const service = sessionService(store, registry, { runSurfSession });

  // Night 1: fresh content → the session runs.
  const first = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(first.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(first.stats.sessionSkipped, 0);

  // Night 2 (pre-dream): the same window is already presented → nothing to do.
  const second = await service.runSurfAndWait(7, 'pre-dream');
  assert.equal(second.status, 'done', 'a skipped run is a finished run, not a failure');
  assert.equal(calls.length, 1, 'no LLM session was launched for the empty briefing');
  assert.equal(second.stats.fetched, 0);
  assert.equal(second.stats.sessionSkipped, 1, 'the skip is recorded on the run stats');
  assert.equal(second.reportMarkdown, null, 'no report → the dream sees no surf activity');
  assert.match(second.briefingMarkdown ?? '', /./, 'the digest is still recorded');
  assert.equal(service.shouldPreDreamSurf(7), false, 'the finished skip run still holds the recency dedupe');
});

test('manual triggers always run the session, even on an empty briefing', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const registry = [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])];
  const { calls, runSurfSession } = sessionRecorder();
  const service = sessionService(store, registry, { runSurfSession });
  await service.runSurfAndWait(7, 'manual-ui');
  const second = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(second.status, 'done');
  assert.equal(second.stats.fetched, 0);
  assert.equal(calls.length, 2, 'the owner asked for a surf — it runs regardless of the briefing');
  assert.equal(second.stats.sessionSkipped, 0);
});

test('pre-dream: a protocol fetch error never qualifies as an empty briefing', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const broken = {
    key: 'broken',
    displayName: 'Broken',
    paths: ['/protocols/broken'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: async () => { throw new Error('backend down'); },
  };
  const { calls, runSurfSession } = sessionRecorder();
  const service = sessionService(store, [broken], { runSurfSession });
  const run = await service.runSurfAndWait(7, 'pre-dream');
  assert.equal(run.status, 'done');
  assert.equal(run.stats.fetched, 0);
  assert.equal(calls.length, 1, 'an unknown window is not an empty one — the session runs');
  assert.equal(run.stats.sessionSkipped, 0);
});

test('pre-dream: pending inbox items (or an inbox fetch error) keep the session running', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const registry = [alphaDescriptor([])];
  const { calls, runSurfSession } = sessionRecorder();
  const withInbox = sessionService(store, registry, {
    runSurfSession,
    getBotIdentity: () => ({ address: '0xABC', globalMetaId: 'idq-tester' }),
    fetchSurfInbox: async () => [makeInboxItem('inbox-1', NOW_SEC - 200)],
  });
  const run = await withInbox.runSurfAndWait(7, 'pre-dream');
  assert.equal(run.status, 'done');
  assert.equal(run.stats.fetched, 0);
  assert.equal(run.stats.inboxPresented, 1);
  assert.equal(calls.length, 1, 'a reply waiting in the inbox is work — the session runs');
  assert.equal(run.stats.sessionSkipped, 0);

  const db2 = createNativeSqliteDatabase(':memory:');
  const store2 = new MetawebSurfStore(db2, () => {});
  const recorder2 = sessionRecorder();
  const inboxError = sessionService(store2, registry, {
    runSurfSession: recorder2.runSurfSession,
    getBotIdentity: () => ({ address: '0xABC', globalMetaId: 'idq-tester' }),
    fetchSurfInbox: async () => { throw new Error('inbox api down'); },
  });
  const run2 = await inboxError.runSurfAndWait(7, 'pre-dream');
  assert.equal(run2.status, 'done');
  assert.equal(recorder2.calls.length, 1, 'an inbox fetch error is unknown work, not no work');
  assert.equal(run2.stats.sessionSkipped, 0);

  // Error-free empty inbox + no items → skip.
  const db3 = createNativeSqliteDatabase(':memory:');
  const store3 = new MetawebSurfStore(db3, () => {});
  const recorder3 = sessionRecorder();
  const emptyInbox = sessionService(store3, registry, {
    runSurfSession: recorder3.runSurfSession,
    getBotIdentity: () => ({ address: '0xABC', globalMetaId: 'idq-tester' }),
    fetchSurfInbox: async () => [],
  });
  const run3 = await emptyInbox.runSurfAndWait(7, 'pre-dream');
  assert.equal(run3.status, 'done');
  assert.equal(recorder3.calls.length, 0, 'empty items + error-free empty inbox → skipped');
  assert.equal(run3.stats.sessionSkipped, 1);
});

test('digest-only harness (no session injected) never reports a skip', async () => {
  const { service } = setup([alphaDescriptor([])]);
  const run = await service.runSurfAndWait(7, 'pre-dream');
  assert.equal(run.status, 'done');
  assert.equal(run.stats.sessionSkipped, 0, 'nothing to skip when no session is configured');
});

// ---------------------------------------------------------------------------
// Report disk copy (2026-11-18): the run row and the file are one report.
// ---------------------------------------------------------------------------

const tmpReportDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-surf-report-'));

test('a finished run writes <date>-<runId>.md whose markdown equals the stored row', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const dir = tmpReportDir();
  try {
    const reportMarkdown = '# Surf report\n\n- learned: one thing\n- engaged: one like';
    const service = sessionService(store, [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])], {
      reportDir: dir,
      runSurfSession: async () => ({ stats: { deepRead: 1 }, reportMarkdown, reportJson: '{"summary":"ok"}' }),
    });
    const run = await service.runSurfAndWait(7, 'manual-ui');
    assert.equal(run.status, 'done');
    assert.equal(run.reportMarkdown, reportMarkdown, 'the store row keeps the report verbatim');

    // Local date of the fixed clock (Asia/Shanghai test host → 2026-09-13).
    const dateKey = new Date(NOW_MS);
    const pad = (value) => String(value).padStart(2, '0');
    const expectedName = `${dateKey.getFullYear()}-${pad(dateKey.getMonth() + 1)}-${pad(dateKey.getDate())}-${run.id}.md`;
    const filePath = path.join(dir, expectedName);
    assert.ok(fs.existsSync(filePath), `report file missing: ${expectedName}`);
    assert.deepEqual(fs.readdirSync(dir), [expectedName], 'one file per run, nothing extra');
    assert.equal(fs.readFileSync(filePath, 'utf8'), run.reportMarkdown, 'file body must equal the stored markdown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a store-truncated report keeps the full text on disk with a truncation header', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const dir = tmpReportDir();
  try {
    // Over the store's 20k report cap, so finishRun clamps the row.
    const reportMarkdown = `# Big report\n\n${'tail '.repeat(6000)}`;
    assert.ok(reportMarkdown.length > 20_000);
    const service = sessionService(store, [alphaDescriptor([])], {
      reportDir: dir,
      runSurfSession: async () => ({ stats: { deepRead: 1 }, reportMarkdown }),
    });
    const run = await service.runSurfAndWait(7, 'manual-ui');
    assert.equal(run.status, 'done');
    // The row itself is unchanged by this feature: still the capped copy.
    assert.ok(run.reportMarkdown.length <= 20_000, 'store cap still applies to the row');
    assert.match(run.reportMarkdown, /\[report truncated at 20000 chars to fit storage — the tail was NOT stored\]/);

    const filePath = fs.readdirSync(dir).map((name) => path.join(dir, name));
    assert.equal(filePath.length, 1);
    const text = fs.readFileSync(filePath[0], 'utf8');
    assert.match(text, /^> \[!NOTE\] store copy truncated/);
    assert.match(text, /the stored row is unchanged/);
    assert.ok(text.includes(reportMarkdown), 'the file carries the FULL report');
    assert.ok(text.length > reportMarkdown.length, 'header rides on top, body stays whole');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no reportDir (or a failing write) never fails the run', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const { runSurfSession } = sessionRecorder();
  // A path under a file (not a directory) makes mkdir/write fail deterministically.
  const blockedDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-surf-bad-')), 'not-a-dir');
  fs.writeFileSync(blockedDir, 'x');
  try {
    const service = sessionService(store, [alphaDescriptor([])], { reportDir: blockedDir, runSurfSession });
    const run = await service.runSurfAndWait(7, 'manual-ui');
    assert.equal(run.status, 'done', 'a disk failure is best effort — the run still succeeds');
    assert.equal(run.reportMarkdown, '# Report');
  } finally {
    fs.rmSync(path.dirname(blockedDir), { recursive: true, force: true });
  }
});

