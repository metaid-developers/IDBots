// cowork_sessions.auto_origin — the origin marker that lets the sidebar fold
// auto-created sessions ([长期] long-term runs, [编排任务] orchestration runs,
// [定时] scheduled runs) into a collapsed "Autonomous Tasks" section. All three
// machine origins fold, scheduled runs included (policy change — see
// sessionAutoGrouping.ts FOLDED_AUTO_ORIGINS); this file validates the marker
// itself — the creation fact and its backfill classification — which the
// fold-policy move does not change.
//
// Contract under test:
//   a. a fresh database gets the column, and createSession still yields a
//      human-initiated (NULL) origin;
//   b. setSessionAutoOrigin round-trips through getSession + listSessions and
//      survives a reopen (real write-at-creation persistence);
//   c/d. the one-shot startup backfill classifies pre-existing rows (title
//      prefix OR session_type OR the scheduled_task_runs ledger link) and
//      never touches human rows; the column add is the run marker, so a later
//      startup does not re-run the backfill.
//
// Runs against the compiled output (pnpm run compile:electron first).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getColumns, getCompiledStores, getRow, getSqlJs } from './memoryTestUtils.mjs';

const { SqliteStore, CoworkStore } = getCompiledStores();

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-auto-origin-'));

const cleanupDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/**
 * Open (or create) the file-backed SqliteStore for `dir` the way a real
 * startup does: SqliteStore.create loads the DB file and replays
 * initializeTables, so every startup migration runs against the seeded data.
 */
async function openStartupStore(dir) {
  const SQL = await getSqlJs();
  const dbPath = path.join(dir, 'test.sqlite');
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  const store = new SqliteStore(db, dbPath);
  store.initializeTables(dir);
  return store;
}

const originOf = (db, id) => getRow(db, 'SELECT auto_origin FROM cowork_sessions WHERE id = ?', [id])?.auto_origin ?? null;

const insertSession = (db, id, title, sessionType, at) => db.run(
  `INSERT INTO cowork_sessions (id, title, cwd, system_prompt, session_type, created_at, updated_at)
   VALUES (?, ?, '/tmp', '', ?, ?, ?)`,
  [id, title, sessionType, at, at],
);

test('fresh DB: auto_origin exists and human sessions keep a NULL origin', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    assert.equal(getColumns(sqlite.getDatabase(), 'cowork_sessions').includes('auto_origin'), true);
    assert.equal(originOf(sqlite.getDatabase(), 'nonexistent'), null);

    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const session = cowork.createSession('Human chat', dir);
    assert.equal(session.autoOrigin, null, 'createSession reports the row as human-initiated');
    assert.equal(cowork.getSession(session.id)?.autoOrigin, null);
    assert.equal(cowork.listSessions().find((row) => row.id === session.id)?.autoOrigin, null);
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('setSessionAutoOrigin round-trips through getSession and listSessions, and persists', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const session = cowork.createSession('[长期] Ship the launch', dir, '', 'local', [], null, 'longterm');
    cowork.setSessionAutoOrigin(session.id, 'longterm');

    assert.equal(cowork.getSession(session.id)?.autoOrigin, 'longterm');
    assert.equal(cowork.listSessions().find((row) => row.id === session.id)?.autoOrigin, 'longterm');
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
  }

  // Reopen from disk: the marker was written, not just held in memory.
  const reopened = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(reopened.getDatabase(), reopened.getSaveFunction());
    assert.equal(cowork.getSession('nonexistent'), null);
    const listed = cowork.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].autoOrigin, 'longterm');
  } finally {
    try { reopened.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('startup backfill classifies pre-existing auto rows and spares human rows', async () => {
  const dir = makeTempDir();

  // Build the state an upgrading install is in: schema of the release that
  // introduced the column, minus the column itself.
  const seeded = await openStartupStore(dir);
  const seedDb = seeded.getDatabase();
  // CoworkStore adds session_type/model/... on a newer build's first launch,
  // so the upgrade path always sees session_type when auto_origin lands.
  new CoworkStore(seedDb, seeded.getSaveFunction());
  seedDb.run('ALTER TABLE cowork_sessions DROP COLUMN auto_origin');
  assert.equal(getColumns(seedDb, 'cowork_sessions').includes('auto_origin'), false);

  insertSession(seedDb, 'lt-prefix', '[长期] Ship the launch', 'standard', 1);
  insertSession(seedDb, 'lt-type', 'Mid-task run', 'longterm', 2);
  insertSession(seedDb, 'orch-zh', '[编排任务] Draft the plan', 'standard', 3);
  insertSession(seedDb, 'orch-en', '[Orchestration Task] Draft the plan', 'standard', 4);
  insertSession(seedDb, 'sched-prefix', '[定时] Morning report', 'standard', 5);
  insertSession(seedDb, 'sched-linked', 'Renamed by the owner', 'standard', 6);
  insertSession(seedDb, 'human', 'Human chat', 'standard', 7);
  insertSession(seedDb, 'human-mentions-prefix', 'Notes about [定时] runs', 'standard', 8);
  seedDb.run(
    `INSERT INTO scheduled_task_runs (id, task_id, session_id, status, started_at, trigger_type)
     VALUES ('run-1', 'task-1', 'sched-linked', 'completed', '2026-09-01T00:00:00.000Z', 'scheduled')`,
  );
  seeded.save();
  seeded.close();

  // Startup on the seeded database runs the backfill.
  const migrated = await openStartupStore(dir);
  try {
    const db = migrated.getDatabase();
    assert.equal(getColumns(db, 'cowork_sessions').includes('auto_origin'), true);
    assert.equal(originOf(db, 'lt-prefix'), 'longterm', 'title prefix alone is enough');
    assert.equal(originOf(db, 'lt-type'), 'longterm', 'session_type alone is enough');
    assert.equal(originOf(db, 'orch-zh'), 'orchestration');
    assert.equal(originOf(db, 'orch-en'), 'orchestration');
    assert.equal(originOf(db, 'sched-prefix'), 'schedule');
    assert.equal(originOf(db, 'sched-linked'), 'schedule', 'the run ledger link survives a rename');
    assert.equal(originOf(db, 'human'), null, 'a human session is never marked');
    assert.equal(originOf(db, 'human-mentions-prefix'), null, 'the LIKE prefix is anchored at the start');

    // Idempotency: the ALTER is the run marker, so a later startup leaves a
    // manually cleared value alone instead of re-classifying the row.
    db.run("UPDATE cowork_sessions SET auto_origin = NULL WHERE id = 'lt-prefix'");
    migrated.save();
  } finally {
    migrated.close();
  }

  const third = await openStartupStore(dir);
  try {
    const db = third.getDatabase();
    assert.equal(
      originOf(db, 'lt-prefix'),
      null,
      'the backfill does not re-run on every startup (a re-run would re-classify this row)',
    );
    assert.equal(originOf(db, 'human'), null, 'the human row stays human');
    assert.equal(originOf(db, 'orch-zh'), 'orchestration', 'earlier classifications stay intact');
    assert.equal(originOf(db, 'sched-linked'), 'schedule');
  } finally {
    third.close();
    cleanupDir(dir);
  }
});
