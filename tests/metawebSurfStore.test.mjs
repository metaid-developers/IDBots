import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const {
  MetawebSurfStore,
  ensureMetawebSurfSchema,
  emptySurfRunStats,
  SURF_SEEN_MAX_ROWS_PER_BOT,
} = await import('../dist-electron/main/metawebSurfStore.js');

const setup = () => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new MetawebSurfStore(db, () => {});
  return { db, store };
};

const NOW = '2026-09-13T01:00:00.000Z';

test('schema creation is idempotent', () => {
  const { db } = setup();
  ensureMetawebSurfSchema(db);
  ensureMetawebSurfSchema(db);
});

test('run lifecycle: create running, finish done with stats and report', () => {
  const { store } = setup();
  const run = store.createRun({ id: 'run-1', metabotId: 7, trigger: 'pre-dream', nowIso: NOW });
  assert.equal(run.status, 'running');
  assert.equal(run.trigger, 'pre-dream');

  const stats = { ...emptySurfRunStats(), fetched: 12, savedToKb: 3, liked: 2 };
  store.finishRun('run-1', {
    status: 'done',
    stats,
    reportMarkdown: '# Surf report',
    reportJson: '{"learned":3}',
    finishedAtIso: '2026-09-13T01:20:00.000Z',
  });
  const finished = store.getRun('run-1');
  assert.equal(finished.status, 'done');
  assert.equal(finished.stats.fetched, 12);
  assert.equal(finished.stats.savedToKb, 3);
  assert.equal(finished.reportMarkdown, '# Surf report');
  assert.equal(store.getLatestFinishedRun(7).id, 'run-1');
  assert.equal(store.getLatestFinishedRun(8), null);
});

test('briefing digest is stored separately; oversized texts carry an explicit truncation marker (live-audit round 1)', () => {
  const { store } = setup();
  store.createRun({ id: 'run-sep', metabotId: 7, trigger: 'pre-dream', nowIso: NOW });
  store.finishRun('run-sep', {
    status: 'done',
    stats: emptySurfRunStats(),
    reportMarkdown: '# Surf report',
    briefingMarkdown: '# Surf digest\n- pin a',
    finishedAtIso: '2026-09-13T01:20:00.000Z',
  });
  const separated = store.getRun('run-sep');
  assert.equal(separated.reportMarkdown, '# Surf report');
  assert.equal(separated.briefingMarkdown, '# Surf digest\n- pin a');

  // A digest over the 64k cap keeps its head with an in-band marker —
  // never a silent mid-pin-id cut (the old behavior on report_markdown).
  store.createRun({ id: 'run-big', metabotId: 7, trigger: 'pre-dream', nowIso: NOW });
  const bigDigest = 'x'.repeat(80_000);
  store.finishRun('run-big', {
    status: 'done',
    stats: emptySurfRunStats(),
    briefingMarkdown: bigDigest,
    finishedAtIso: '2026-09-13T01:25:00.000Z',
  });
  const capped = store.getRun('run-big');
  assert.ok(capped.briefingMarkdown.length <= 64_000);
  assert.match(capped.briefingMarkdown, /\[briefing digest truncated at 64000 chars to fit storage/);
  // A capped report likewise carries its own marker instead of a bare slice.
  store.createRun({ id: 'run-big2', metabotId: 7, trigger: 'pre-dream', nowIso: NOW });
  store.finishRun('run-big2', {
    status: 'done',
    stats: emptySurfRunStats(),
    reportMarkdown: 'y'.repeat(30_000),
    finishedAtIso: '2026-09-13T01:30:00.000Z',
  });
  const cappedReport = store.getRun('run-big2');
  assert.ok(cappedReport.reportMarkdown.length <= 20_000);
  assert.match(cappedReport.reportMarkdown, /\[report truncated at 20000 chars to fit storage/);
});

test('listRunsByMetabot is newest first and capped', () => {
  const { store } = setup();
  for (let i = 0; i < 5; i += 1) {
    store.createRun({
      id: `run-${i}`,
      metabotId: 7,
      trigger: 'manual-ui',
      nowIso: `2026-09-1${i}T01:00:00.000Z`,
    });
  }
  const runs = store.listRunsByMetabot(7, 3);
  assert.equal(runs.length, 3);
  assert.equal(runs[0].id, 'run-4');
});

test('listRunsByMetabotAndDay returns one day newest first over a half-open range', () => {
  const { store } = setup();
  // Two runs inside the day, one just past its end, one for another bot.
  store.createRun({ id: 'day-a-late', metabotId: 7, trigger: 'pre-dream', nowIso: '2026-09-13T23:30:00.000Z' });
  store.createRun({ id: 'day-a-early', metabotId: 7, trigger: 'manual-ui', nowIso: '2026-09-13T02:10:00.000Z' });
  store.createRun({ id: 'day-b', metabotId: 7, trigger: 'pre-dream', nowIso: '2026-09-14T01:00:00.000Z' });
  store.createRun({ id: 'other-bot', metabotId: 8, trigger: 'pre-dream', nowIso: '2026-09-13T05:00:00.000Z' });

  const dayRuns = store.listRunsByMetabotAndDay(7, '2026-09-13T00:00:00.000Z', '2026-09-14T00:00:00.000Z');
  assert.deepEqual(
    dayRuns.map((run) => run.id),
    ['day-a-late', 'day-a-early'],
    'the day view lists exactly that day\'s runs for that bot, newest first',
  );
  // Half-open: the end boundary itself is excluded (created_at < dayEndIso).
  const touchingEnd = store.listRunsByMetabotAndDay(7, '2026-09-14T00:59:00.000Z', '2026-09-14T01:00:00.000Z');
  assert.deepEqual(touchingEnd.map((run) => run.id), []);
  // A day with no runs comes back empty rather than erroring.
  assert.deepEqual(store.listRunsByMetabotAndDay(7, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'), []);
});

test('listRunDays lists distinct UTC days newest first, per bot', () => {
  const { store } = setup();
  store.createRun({ id: 'r1', metabotId: 7, trigger: 'pre-dream', nowIso: '2026-09-13T23:30:00.000Z' });
  store.createRun({ id: 'r2', metabotId: 7, trigger: 'manual-chat', nowIso: '2026-09-13T02:10:00.000Z' });
  store.createRun({ id: 'r3', metabotId: 7, trigger: 'pre-dream', nowIso: '2026-09-11T01:00:00.000Z' });
  store.createRun({ id: 'r4', metabotId: 8, trigger: 'pre-dream', nowIso: '2026-09-13T01:00:00.000Z' });

  assert.deepEqual(
    store.listRunDays(7),
    ['2026-09-13', '2026-09-11'],
    'multiple runs on one day collapse to a single marker, newest day first',
  );
  assert.deepEqual(store.listRunDays(8), ['2026-09-13']);
  assert.deepEqual(store.listRunDays(9), [], 'a bot with no runs marks no days');
});

test('stale running runs fail on crash recovery', () => {
  const { store } = setup();
  store.createRun({ id: 'run-live', metabotId: 7, trigger: 'manual-chat', nowIso: NOW });
  store.createRun({ id: 'run-stale', metabotId: 7, trigger: 'manual-chat', nowIso: NOW });
  const recovered = store.failStaleRunningRuns({
    error: 'process restarted',
    nowIso: '2026-09-13T02:00:00.000Z',
    excludeId: 'run-live',
  });
  assert.equal(recovered, 1);
  assert.equal(store.getRun('run-stale').status, 'failed');
  assert.equal(store.getRun('run-live').status, 'running');
});

test('protocol watermark advances but never rewinds', () => {
  const { store } = setup();
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 1000, lastPinId: 'pin-a', nowIso: NOW });
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 500, lastPinId: 'pin-old', nowIso: NOW });
  let state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.lastSeenTs, 1000);

  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 2000, lastPinId: 'pin-b', nowIso: NOW });
  state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.lastSeenTs, 2000);
  assert.equal(state.lastPinId, 'pin-b');
  assert.equal(store.listProtocolStates(7).length, 1);
});

test('protocol backlog cursor: store verbatim, clear, and leave-untouched semantics (surf-reads migration)', () => {
  const { store } = setup();
  // Old-code call shape (no cursor field) leaves the cursor untouched.
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 1000, lastPinId: 'pin-a', nowIso: NOW });
  let state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.backlogCursor, null);

  // Register debt (window page reported hasMore).
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 2000, lastPinId: null, nowIso: NOW, backlogCursor: 'opaque-cursor-2' });
  state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.backlogCursor, 'opaque-cursor-2', 'cursor stored verbatim');
  assert.equal(state.lastSeenTs, 2000, 'watermark still advances in the same write');

  // Backlog page: watermark untouched, cursor updated.
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: null, nowIso: NOW, backlogCursor: 'opaque-cursor-3' });
  state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.lastSeenTs, 2000, 'lastSeenTs: null leaves the watermark unchanged');
  assert.equal(state.backlogCursor, 'opaque-cursor-3');

  // Drained: clear the cursor without touching the watermark.
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: null, nowIso: NOW, backlogCursor: null });
  state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.backlogCursor, null);
  assert.equal(state.lastSeenTs, 2000);

  // Preserve: a no-op cursor field (undefined) leaves whatever is stored.
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 3000, nowIso: NOW });
  state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.backlogCursor, null);
  assert.equal(state.lastSeenTs, 3000);
});

test('schema migration: an old protocol_state table gains last_fresh_cursor idempotently (user DB continuity)', () => {
  const { db, store } = setup();
  // Simulate a pre-migration user database: drop the new column, keep a row.
  db.run('ALTER TABLE metaweb_surf_protocol_state RENAME TO _old_protocol_state;');
  db.run(`
    CREATE TABLE metaweb_surf_protocol_state (
      metabot_id INTEGER NOT NULL,
      protocol_key TEXT NOT NULL,
      last_seen_ts INTEGER,
      last_pin_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (metabot_id, protocol_key)
    );
  `);
  db.run(`INSERT INTO metaweb_surf_protocol_state
    (metabot_id, protocol_key, last_seen_ts, last_pin_id, updated_at)
    VALUES (7, 'simplebuzz', 1000, 'pin-a', '2026-09-01T00:00:00.000Z');`);
  db.run('DROP TABLE _old_protocol_state;');

  // The idempotent schema run must add the column WITHOUT touching the row.
  ensureMetawebSurfSchema(db);
  const state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.lastSeenTs, 1000, 'existing watermark survives the migration');
  assert.equal(state.lastPinId, 'pin-a');
  assert.equal(state.backlogCursor, null, 'old rows start with no registered debt');

  // And the new column is writable through the normal path.
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 2000, nowIso: NOW, backlogCursor: 'cursor-x' });
  assert.equal(store.getProtocolState(7, 'simplebuzz').backlogCursor, 'cursor-x');

  // Second run is a no-op (idempotent).
  ensureMetawebSurfSchema(db);
  assert.equal(store.getProtocolState(7, 'simplebuzz').backlogCursor, 'cursor-x');
});

test('seen ledger upgrades to the strongest action and filters unseen', () => {
  const { store } = setup();
  store.markSeen(7, 'pin-1', 'presented', NOW);
  store.markSeen(7, 'pin-1', 'read', NOW);
  store.markSeen(7, 'pin-1', 'presented', NOW);
  assert.equal(store.getSeenAction(7, 'pin-1'), 'read');

  store.markSeen(7, 'pin-2', 'liked', NOW);
  store.markSeen(7, 'pin-2', 'read', NOW);
  assert.equal(store.getSeenAction(7, 'pin-2'), 'liked', 'interaction must not downgrade to read');

  const unseen = store.filterUnseen(7, ['pin-1', 'pin-2', 'pin-3', '']);
  assert.deepEqual(unseen, ['pin-3']);
});

test('seen ledger prunes by retention window and per-bot cap', () => {
  const { store } = setup();
  store.markSeen(7, 'pin-old', 'read', '2026-01-01T00:00:00.000Z');
  store.markSeen(7, 'pin-new', 'read', NOW);
  store.pruneSeenPins(7, NOW);
  assert.equal(store.getSeenAction(7, 'pin-old'), null, 'older than retention window');
  assert.equal(store.getSeenAction(7, 'pin-new'), 'read');

  for (let i = 0; i < SURF_SEEN_MAX_ROWS_PER_BOT + 10; i += 1) {
    store.markSeen(9, `bulk-${i}`, 'presented', `2026-09-13T02:${String(i % 60).padStart(2, '0')}:00.000Z`);
  }
  store.pruneSeenPins(9, NOW);
  const remaining = store.filterUnseen(9, Array.from({ length: SURF_SEEN_MAX_ROWS_PER_BOT + 10 }, (_, i) => `bulk-${i}`));
  assert.equal(remaining.length, 10, 'oldest 10 pruned, cap holds');
});

test('markSeenBatch writes a run batch with strongest-action-wins and one save', () => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  let saves = 0;
  const store = new MetawebSurfStore(db, () => { saves += 1; });

  saves = 0;
  store.markSeenBatch(7, [
    { pinId: 'pin-1', action: 'presented' },
    { pinId: 'pin-1', action: 'liked' },
    { pinId: 'pin-2', action: 'presented' },
    { pinId: ' pin-3 ', action: 'read' },
    { pinId: '', action: 'presented' },
  ], NOW);
  assert.equal(store.getSeenAction(7, 'pin-1'), 'liked', 'strongest action inside the batch wins');
  assert.equal(store.getSeenAction(7, 'pin-2'), 'presented');
  assert.equal(store.getSeenAction(7, 'pin-3'), 'read', 'pin ids are trimmed');
  assert.equal(saves, 1, 'the whole batch persists with a single saveDb');

  saves = 0;
  store.markSeenBatch(7, [
    { pinId: 'pin-1', action: 'read' },
    { pinId: 'pin-2', action: 'saved' },
  ], NOW);
  assert.equal(store.getSeenAction(7, 'pin-1'), 'liked', 'batch never downgrades a stored action');
  assert.equal(store.getSeenAction(7, 'pin-2'), 'saved');
  assert.equal(saves, 1, 'still one save even when only some rows change');

  saves = 0;
  store.markSeenBatch(7, [{ pinId: 'pin-1', action: 'presented' }], NOW);
  assert.equal(saves, 0, 'a no-op batch skips the save entirely');
  store.markSeenBatch(7, [], NOW);
  assert.equal(saves, 0);
});
