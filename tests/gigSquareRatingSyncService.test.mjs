import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');

const {
  applyRatingDelta,
  parseRatingPin,
  syncGigSquareRatings,
} = require('../dist-electron/services/gigSquareRatingSyncService.js');

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sqlWasmPath = path.join(projectRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

function createRatingTables(db) {
  db.run(`
    CREATE TABLE remote_skill_service (
      id TEXT PRIMARY KEY,
      rating_avg REAL NOT NULL DEFAULT 0,
      rating_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE remote_skill_service_rating_seen (
      pin_id TEXT PRIMARY KEY,
      service_id TEXT,
      service_paid_tx TEXT,
      rate REAL,
      comment TEXT,
      rater_global_metaid TEXT,
      rater_metaid TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

test('parseRatingPin keeps serviceID, servicePaidTx, rate, and comment', () => {
  const parsed = parseRatingPin({
    id: 'pin-1',
    globalMetaId: 'buyer-global',
    contentSummary: JSON.stringify({
      serviceID: 'svc-1',
      servicePaidTx: 'a'.repeat(64),
      rate: '5',
      comment: 'Very good',
    }),
  });

  assert.equal(parsed.serviceId, 'svc-1');
  assert.equal(parsed.servicePaidTx, 'a'.repeat(64));
  assert.equal(parsed.rate, 5);
  assert.equal(parsed.comment, 'Very good');
});

test('applyRatingDelta updates aggregate rating fields after inserting rating detail', () => {
  const result = applyRatingDelta({ ratingAvg: 4, ratingCount: 2 }, { sum: 5, count: 1 });
  assert.equal(result.ratingAvg, 13 / 3);
  assert.equal(result.ratingCount, 3);
});

test('syncGigSquareRatings enriches an existing seen row without double-counting aggregates', async () => {
  const db = await createSqlDatabase();
  createRatingTables(db);
  db.run(
    'INSERT INTO remote_skill_service (id, rating_avg, rating_count) VALUES (?, ?, ?)',
    ['svc-1', 4, 2]
  );
  db.run(
    `INSERT INTO remote_skill_service_rating_seen (
      pin_id, service_id, service_paid_tx, rate, comment, rater_global_metaid, rater_metaid, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['pin-1', 'svc-1', null, 5, null, null, null, 1_710_000_000_000]
  );

  await syncGigSquareRatings({
    db,
    latestPinId: null,
    backfillCursor: null,
    maxPages: 1,
    fetchPage: async () => ({
      list: [{
        id: 'pin-1',
        metaid: 'buyer-meta',
        globalMetaId: 'buyer-global',
        timestamp: 1_710_000_000,
        contentSummary: JSON.stringify({
          serviceID: 'svc-1',
          servicePaidTx: 'a'.repeat(64),
          rate: '5',
          comment: 'Very good',
        }),
      }],
      nextCursor: null,
    }),
    setLatestPinId: () => {},
    setBackfillCursor: () => {},
    clearBackfillCursor: () => {},
  });

  const detailRow = db.exec(
    `SELECT service_paid_tx, comment, rater_global_metaid, rater_metaid
     FROM remote_skill_service_rating_seen
     WHERE pin_id = ?`,
    ['pin-1']
  )[0].values[0];
  assert.deepEqual(detailRow, ['a'.repeat(64), 'Very good', 'buyer-global', 'buyer-meta']);

  const aggregateRow = db.exec(
    'SELECT rating_avg, rating_count FROM remote_skill_service WHERE id = ?',
    ['svc-1']
  )[0].values[0];
  assert.deepEqual(aggregateRow, [4, 2]);
});

test('syncGigSquareRatings normalizes second-based timestamps to milliseconds for new writes', async () => {
  const db = await createSqlDatabase();
  createRatingTables(db);
  db.run(
    'INSERT INTO remote_skill_service (id, rating_avg, rating_count) VALUES (?, ?, ?)',
    ['svc-1', 0, 0]
  );

  await syncGigSquareRatings({
    db,
    latestPinId: null,
    backfillCursor: null,
    maxPages: 1,
    fetchPage: async () => ({
      list: [{
        id: 'pin-2',
        metaid: 'buyer-meta',
        globalMetaId: 'buyer-global',
        timestamp: 1_710_000_000,
        contentSummary: JSON.stringify({
          serviceID: 'svc-1',
          servicePaidTx: 'b'.repeat(64),
          rate: '4',
          comment: 'Good',
        }),
      }],
      nextCursor: null,
    }),
    setLatestPinId: () => {},
    setBackfillCursor: () => {},
    clearBackfillCursor: () => {},
  });

  const createdAt = db.exec(
    'SELECT created_at FROM remote_skill_service_rating_seen WHERE pin_id = ?',
    ['pin-2']
  )[0].values[0][0];
  assert.equal(createdAt, 1_710_000_000_000);
});
