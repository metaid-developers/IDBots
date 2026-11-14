import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { NativeSqliteDatabase } = require('../dist-electron/main/nativeSqliteDatabase.js');
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');

function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows handle tolerance
  }
}

test('NativeSqliteDatabase reuses cached prepared statements and clears cache on schema DDL', () => {
  let prepareCalls = 0;
  const statements = new Map();
  const fakeModule = {
    DatabaseSync: class FakeDb {
      exec() {}
      prepare(sql) {
        prepareCalls += 1;
        const stmt = {
          sourceSQL: sql,
          all: () => [{ id: 1, name: 'ok' }],
          run: () => ({ changes: 1 }),
          columns: () => [{ name: 'id' }, { name: 'name' }],
        };
        statements.set(sql, stmt);
        return stmt;
      }
      close() {}
    },
  };

  const db = new NativeSqliteDatabase(':memory:', fakeModule);
  try {
    db.exec('SELECT id, name FROM demo WHERE id = ?', [1]);
    db.exec('SELECT id, name FROM demo WHERE id = ?', [2]);
    db.exec('SELECT id, name FROM demo WHERE id = ?', [3]);
    assert.equal(prepareCalls, 1, 'identical SELECT should prepare once and hit statement cache');

    db.run('ALTER TABLE demo ADD COLUMN extra TEXT');
    db.exec('SELECT id, name FROM demo WHERE id = ?', [1]);
    assert.equal(prepareCalls, 3, 'schema DDL must invalidate cached prepared statements');
  } finally {
    db.close();
  }
});

test('CoworkStore creates partial visible-session indexes and preserves IM group precedence in listSessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sqlite-perf-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const save = sqliteStore.getSaveFunction();
    const coworkStore = new CoworkStore(db, save);

    const indexRows = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cowork_sessions'",
    )[0]?.values ?? [];
    const indexNames = new Set(indexRows.map((row) => String(row[0])));
    assert.ok(indexNames.has('idx_cowork_sessions_visible_activity'));
    assert.ok(indexNames.has('idx_cowork_sessions_visible_metabot_activity'));
    assert.ok(indexNames.has('idx_cowork_sessions_null_activity'));
    assert.ok(indexNames.has('idx_cowork_sessions_null_metabot'));
    assert.ok(indexNames.has('idx_cowork_sessions_fork_parent'));

    const s1 = coworkStore.createSession('IM Group Session', '/tmp', '', 'local', [], null);
    db.run(
      `INSERT INTO cowork_conversation_mappings (channel, external_conversation_id, cowork_session_id, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['im:qq', 'conv-direct', s1.id, 1000, 2000],
    );
    db.run(
      `INSERT INTO cowork_conversation_mappings (channel, external_conversation_id, cowork_session_id, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['im:qq:group', 'conv-group', s1.id, 1000, 1500],
    );

    const listed = coworkStore.listSessions();
    const found = listed.find((entry) => entry.id === s1.id);
    assert.ok(found);
    assert.equal(found.imChannel, 'im:qq:group');
    assert.equal(found.imConversationId, 'conv-group');

    const planRows = db.exec(`
      EXPLAIN QUERY PLAN
      SELECT s.id
      FROM cowork_sessions s
      WHERE COALESCE(s.hidden_from_session_list, 0) = 0
        AND s.archived_at IS NULL
      ORDER BY s.pinned DESC, COALESCE(s.activity_at, s.updated_at) DESC, s.updated_at DESC, s.created_at DESC, s.id DESC
    `)[0]?.values ?? [];
    const planText = planRows.map((row) => row.join(' ')).join('\n');
    assert.match(planText, /idx_cowork_sessions_visible_activity/);
    assert.doesNotMatch(planText, /USE TEMP B-TREE FOR ORDER BY/);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});
