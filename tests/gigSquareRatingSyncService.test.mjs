import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const Module = require('node:module');

const {
  applyRatingDelta,
  parseRatingPin,
  repairServiceRatingAggregate,
  syncGigSquareRatings,
} = require('../dist-electron/services/gigSquareRatingSyncService.js');
const { DB_FILENAME } = require('../dist-electron/appConstants.js');

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

test('syncGigSquareRatings keeps scanning the first page after latestPinId to enrich older seen rows', async () => {
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
    ['pin-latest', 'svc-1', 'z'.repeat(64), 4, 'Latest', 'latest-global', 'latest-meta', 1_710_000_100_000]
  );
  db.run(
    `INSERT INTO remote_skill_service_rating_seen (
      pin_id, service_id, service_paid_tx, rate, comment, rater_global_metaid, rater_metaid, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['pin-old', 'svc-1', null, 5, null, null, null, 1_710_000_000_000]
  );

  const fetchCalls = [];
  await syncGigSquareRatings({
    db,
    latestPinId: 'pin-latest',
    backfillCursor: null,
    maxPages: 5,
    fetchPage: async (cursor) => {
      fetchCalls.push(cursor);
      if (!cursor) {
        return {
          list: [
            {
              id: 'pin-new',
              metaid: 'new-meta',
              globalMetaId: 'new-global',
              timestamp: 1_710_000_200,
              contentSummary: JSON.stringify({
                serviceID: 'svc-1',
                servicePaidTx: 'n'.repeat(64),
                rate: '3',
                comment: 'Fresh',
              }),
            },
            {
              id: 'pin-latest',
              metaid: 'latest-meta',
              globalMetaId: 'latest-global',
              timestamp: 1_710_000_150,
              contentSummary: JSON.stringify({
                serviceID: 'svc-1',
                servicePaidTx: 'z'.repeat(64),
                rate: '4',
                comment: 'Latest',
              }),
            },
            {
              id: 'pin-old',
              metaid: 'old-meta',
              globalMetaId: 'old-global',
              timestamp: 1_710_000_050,
              contentSummary: JSON.stringify({
                serviceID: 'svc-1',
                servicePaidTx: 'o'.repeat(64),
                rate: '5',
                comment: 'Older replay',
              }),
            },
          ],
          nextCursor: 'cursor-2',
        };
      }

      assert.equal(cursor, 'cursor-2');
      return {
        list: [],
        nextCursor: null,
      };
    },
    setLatestPinId: () => {},
    setBackfillCursor: () => {},
    clearBackfillCursor: () => {},
  });

  const oldRow = db.exec(
    `SELECT service_paid_tx, comment, rater_global_metaid, rater_metaid
     FROM remote_skill_service_rating_seen
     WHERE pin_id = ?`,
    ['pin-old']
  )[0].values[0];
  assert.deepEqual(oldRow, ['o'.repeat(64), 'Older replay', 'old-global', 'old-meta']);

  const aggregateRow = db.exec(
    'SELECT rating_avg, rating_count FROM remote_skill_service WHERE id = ?',
    ['svc-1']
  )[0].values[0];
  assert.deepEqual(aggregateRow, [11 / 3, 3]);

  assert.deepEqual(fetchCalls, [undefined, 'cursor-2']);
});

test('repairServiceRatingAggregate recovers aggregates when rating details arrive before the service row', async () => {
  const db = await createSqlDatabase();
  createRatingTables(db);

  await syncGigSquareRatings({
    db,
    latestPinId: null,
    backfillCursor: null,
    maxPages: 1,
    fetchPage: async () => ({
      list: [{
        id: 'pin-before-service',
        metaid: 'buyer-meta',
        globalMetaId: 'buyer-global',
        timestamp: 1_710_000_000,
        contentSummary: JSON.stringify({
          serviceID: 'svc-late',
          servicePaidTx: 'c'.repeat(64),
          rate: '5',
          comment: 'Before service row',
        }),
      }],
      nextCursor: null,
    }),
    setLatestPinId: () => {},
    setBackfillCursor: () => {},
    clearBackfillCursor: () => {},
  });

  const cachedBeforeService = db.exec(
    'SELECT service_id, rate FROM remote_skill_service_rating_seen WHERE pin_id = ?',
    ['pin-before-service']
  )[0].values[0];
  assert.deepEqual(cachedBeforeService, ['svc-late', 5]);

  db.run(
    'INSERT INTO remote_skill_service (id, rating_avg, rating_count) VALUES (?, ?, ?)',
    ['svc-late', 0, 0]
  );

  repairServiceRatingAggregate(db, 'svc-late');

  const aggregateRow = db.exec(
    'SELECT rating_avg, rating_count FROM remote_skill_service WHERE id = ?',
    ['svc-late']
  )[0].values[0];
  assert.deepEqual(aggregateRow, [5, 1]);
});

test('SqliteStore.create() upgrades legacy rating detail cache schema before creating paid-tx index', async () => {
  const legacyDb = await createSqlDatabase();
  legacyDb.run(`
    CREATE TABLE remote_skill_service_rating_seen (
      pin_id TEXT PRIMARY KEY,
      service_id TEXT,
      rate REAL,
      created_at INTEGER NOT NULL
    );
  `);
  legacyDb.run(
    'INSERT INTO remote_skill_service_rating_seen (pin_id, service_id, rate, created_at) VALUES (?, ?, ?, ?)',
    ['legacy-pin', 'svc-1', 5, 1_710_000_000_000]
  );

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sqlitestore-rating-cache-'));
  const dbPath = path.join(userDataPath, DB_FILENAME);
  fs.writeFileSync(dbPath, Buffer.from(legacyDb.export()));

  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => projectRoot,
          getPath: () => userDataPath,
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { SqliteStore } = require('../dist-electron/sqliteStore.js');
    const sqliteStore = await SqliteStore.create(userDataPath);
    const db = sqliteStore.getDatabase();

    const columns = db.exec('PRAGMA table_info(remote_skill_service_rating_seen)')[0].values.map((row) => row[1]);
    assert.ok(columns.includes('service_paid_tx'));
    assert.ok(columns.includes('comment'));
    assert.ok(columns.includes('rater_global_metaid'));
    assert.ok(columns.includes('rater_metaid'));

    const indexRows = db.exec(
      "SELECT name FROM pragma_index_list('remote_skill_service_rating_seen') WHERE name = 'idx_remote_skill_service_rating_paid_tx'"
    );
    assert.equal(indexRows[0]?.values?.length ?? 0, 1);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
