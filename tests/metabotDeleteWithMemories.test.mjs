import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { ensureStandingPageSchema } = require('../dist-electron/main/standingPageStore.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-delete-metabot-fk-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', createdAt }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      walletId,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `public-${id}`,
      `chat-public-${id}`,
      name,
      1,
      `metaid-${id}`,
      type,
      '0000',
      `${name} role`,
      `${name} soul`,
      createdAt,
      createdAt,
    ]
  );
};

const insertMemory = (db, { id, metabotId, text }) => {
  db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, metabotId, text, `fp-${id}`, 1700000000000 + id, 1700000000000 + id]
  );
};

// metaid_knowledge_entries is created by SqliteStore itself (via
// ensureMetaIDKnowledgeSchema); this IF NOT EXISTS mirror of the runtime
// schema (NOT NULL metabot_id, FK NO ACTION on metabots) only stays as a
// fallback for older schema-init paths and is normally a no-op.
const ensureKnowledgeTable = (db) => {
  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_knowledge_entries (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL REFERENCES metabots(id),
      topic TEXT NOT NULL,
      topic_fingerprint TEXT NOT NULL,
      summary TEXT NOT NULL,
      kind TEXT NOT NULL,
      category TEXT,
      tags_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'archived')),
      origin TEXT NOT NULL,
      source_dream_date TEXT,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);
};

const insertKnowledge = (db, { id, metabotId, topic }) => {
  db.run(
    `INSERT INTO metaid_knowledge_entries
      (id, metabot_id, topic, topic_fingerprint, summary, kind, tags_json, confidence, status, origin, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, metabotId, topic, `fp-${id}`, `summary-${id}`, 'know_how', '[]', 0.5, 'active', 'agent', 1, 1700000000000 + id, 1700000000000 + id]
  );
};

// metaid_knowledge_procedures is created by SqliteStore itself (via
// ensureMetaIDKnowledgeSchema), so the test inserts into the real table,
// providing every NOT NULL column from the runtime schema.
const insertProcedure = (db, { id, metabotId, title }) => {
  db.run(
    `INSERT INTO metaid_knowledge_procedures
      (id, metabot_id, title, title_fingerprint, trigger_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, metabotId, title, `fp-${id}`, `trigger-${id}`, 1700000000000, 1700000000000]
  );
};

// metabot_directives is a retired-feature table: the per-bot directives
// feature was reshaped into built-in code-owned defaults and its store was
// removed from the tree, but installs that ran the interim build keep the
// table (NOT NULL metabot_id, FK NO ACTION on metabots). Mirrored from the
// shipped schema so the delete path can be exercised against it.
const ensureDirectivesTable = (db) => {
  db.run(`
    CREATE TABLE IF NOT EXISTS metabot_directives (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL REFERENCES metabots(id),
      text TEXT NOT NULL CHECK (trim(text) <> ''),
      scope TEXT NOT NULL DEFAULT 'external' CHECK (scope IN ('external', 'all')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
};

const insertDirective = (db, { id, metabotId, text }) => {
  db.run(
    `INSERT INTO metabot_directives (id, metabot_id, text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, metabotId, text, 1700000000000, 1700000000000]
  );
};

// metabot_standing_pages is created lazily by the StandingPageStore
// constructor; tests create it via the real runtime ensureStandingPageSchema.
const insertStandingPage = (db, { id, metabotId, pageKey, spec }) => {
  db.run(
    `INSERT INTO metabot_standing_pages (
       id, metabot_id, page_key, spec, name, question, sections_json, content,
       status, is_default, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, '[]', '', 'active', 1, ?, ?)`,
    [id, metabotId, pageKey, spec, `${spec} page`, `${spec} question?`, 1700000000000, 1700000000000]
  );
};

const insertStandingPageRevision = (db, { id, pageId }) => {
  db.run(
    `INSERT INTO metabot_standing_page_revisions (id, page_id, reason, previous_sections_json, created_at)
     VALUES (?, ?, ?, '[]', ?)`,
    [id, pageId, 'test', 1700000000000]
  );
};

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());
  return { store, metabotStore, db: store.getDatabase() };
};

const foreignKeysEnabled = (db) => {
  const result = db.exec('PRAGMA foreign_keys;');
  return Number(result[0]?.values?.[0]?.[0]);
};

const countMemoriesForBot = (db, metabotId) => {
  const result = db.exec('SELECT COUNT(*) FROM user_memories WHERE metabot_id = ?', [metabotId]);
  return Number(result[0].values[0][0]);
};

const countNulledMemories = (db) => {
  const result = db.exec('SELECT COUNT(*) FROM user_memories WHERE metabot_id IS NULL');
  return Number(result[0].values[0][0]);
};

test('deleteMetabot on a bot with attached user_memories succeeds and preserves the rows (metabot_id nulled)', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    // The regression env must enforce foreign keys, or this test proves nothing.
    assert.equal(foreignKeysEnabled(db), 1);

    insertWallet(db, 1);
    insertMetabot(db, { id: 7, walletId: 1, name: 'Memoried Bot', createdAt: 1000 });
    insertMemory(db, { id: 'mem-1', metabotId: 7, text: 'prefers morning standups' });
    insertMemory(db, { id: 'mem-2', metabotId: 7, text: 'dislikes noisy rooms' });

    assert.equal(countMemoriesForBot(db, 7), 2);

    const deleted = metabotStore.deleteMetabot(7);

    assert.equal(deleted, true);
    assert.equal(metabotStore.getMetabotById(7), null);
    // Memory rows survive the bot as history, detached from the deleted bot.
    assert.equal(countMemoriesForBot(db, 7), 0);
    assert.equal(countNulledMemories(db), 2);
    const rows = db.exec('SELECT id, text FROM user_memories WHERE id IN (?, ?)', ['mem-1', 'mem-2'])[0].values;
    assert.deepEqual(new Set(rows.map((r) => r[1])), new Set(['prefers morning standups', 'dislikes noisy rooms']));
  } finally {
    store.close();
  }
});

test('raw DELETE of a referenced bot is rejected while memories still reference it (FK NO ACTION enforced)', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    assert.equal(foreignKeysEnabled(db), 1);

    insertWallet(db, 1);
    insertMetabot(db, { id: 7, walletId: 1, name: 'Referenced Bot', createdAt: 1000 });
    insertMemory(db, { id: 'mem-1', metabotId: 7, text: 'keeps me pinned' });

    // Without the app-layer detach, the delete is refused by the constraint.
    assert.throws(() => db.run('DELETE FROM metabots WHERE id = ?', [7]), /FOREIGN KEY constraint failed/);
    assert.equal(metabotStore.getMetabotById(7) !== null, true);

    // After the fix path detaches the memory, the delete goes through.
    assert.equal(metabotStore.deleteMetabot(7), true);
    assert.equal(countNulledMemories(db), 1);
  } finally {
    store.close();
  }
});

test('deleteMetabot also removes the bot metaid_knowledge_entries rows (NOT NULL metabot_id)', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    assert.equal(foreignKeysEnabled(db), 1);

    ensureKnowledgeTable(db);
    insertWallet(db, 1);
    insertMetabot(db, { id: 7, walletId: 1, name: 'Knowledgeable Bot', createdAt: 1000 });
    insertKnowledge(db, { id: 'k-1', metabotId: 7, topic: 'sqlite fk pitfall' });

    const before = db.exec('SELECT COUNT(*) FROM metaid_knowledge_entries WHERE metabot_id = 7');
    assert.equal(Number(before[0].values[0][0]), 1);

    assert.equal(metabotStore.deleteMetabot(7), true);
    assert.equal(metabotStore.getMetabotById(7), null);
    const after = db.exec('SELECT COUNT(*) FROM metaid_knowledge_entries WHERE metabot_id = 7');
    assert.equal(Number(after[0].values[0][0]), 0);
    // The knowledge table survives with no orphaned references.
    const orphans = db.exec("SELECT COUNT(*) FROM pragma_foreign_key_check WHERE parent = 'metabots'");
    assert.equal(Number(orphans[0].values[0][0]), 0);
  } finally {
    store.close();
  }
});

test('deleteMetabot also removes the bot metaid_knowledge_procedures rows (NOT NULL metabot_id)', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    assert.equal(foreignKeysEnabled(db), 1);

    insertWallet(db, 1);
    insertMetabot(db, { id: 7, walletId: 1, name: 'Procedural Bot', createdAt: 1000 });
    insertProcedure(db, { id: 'p-1', metabotId: 7, title: 'nightly reindex' });

    const before = db.exec('SELECT COUNT(*) FROM metaid_knowledge_procedures WHERE metabot_id = 7');
    assert.equal(Number(before[0].values[0][0]), 1);
    // Without the cleanup this delete is refused by the NO ACTION constraint.
    assert.throws(() => db.run('DELETE FROM metabots WHERE id = ?', [7]), /FOREIGN KEY constraint failed/);

    assert.equal(metabotStore.deleteMetabot(7), true);
    assert.equal(metabotStore.getMetabotById(7), null);
    const after = db.exec('SELECT COUNT(*) FROM metaid_knowledge_procedures WHERE metabot_id = 7');
    assert.equal(Number(after[0].values[0][0]), 0);
  } finally {
    store.close();
  }
});

test('deleteMetabot also removes the bot metabot_standing_pages rows and their revisions (NOT NULL metabot_id)', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    assert.equal(foreignKeysEnabled(db), 1);

    ensureStandingPageSchema(db);
    insertWallet(db, 1);
    insertMetabot(db, { id: 7, walletId: 1, name: 'Briefed Bot', createdAt: 1000 });
    // The three default pages the memory hygiene pass seeds per bot.
    insertStandingPage(db, { id: 'page-1', metabotId: 7, pageKey: 'owner_profile', spec: 'owner_profile' });
    insertStandingPage(db, { id: 'page-2', metabotId: 7, pageKey: 'work_threads', spec: 'work_threads' });
    insertStandingPageRevision(db, { id: 'rev-1', pageId: 'page-1' });

    // Without the cleanup this delete is refused by the NO ACTION constraint
    // (the 2026-11 standing-pages regression: deletion of any bot the hygiene
    // pass had seeded failed with FOREIGN KEY constraint failed).
    assert.throws(() => db.run('DELETE FROM metabots WHERE id = ?', [7]), /FOREIGN KEY constraint failed/);
    assert.equal(metabotStore.getMetabotById(7) !== null, true);

    assert.equal(metabotStore.deleteMetabot(7), true);
    assert.equal(metabotStore.getMetabotById(7), null);
    const pages = db.exec('SELECT COUNT(*) FROM metabot_standing_pages WHERE metabot_id = 7');
    assert.equal(Number(pages[0].values[0][0]), 0);
    // Revisions follow their page via ON DELETE CASCADE.
    const revisions = db.exec("SELECT COUNT(*) FROM metabot_standing_page_revisions WHERE id = 'rev-1'");
    assert.equal(Number(revisions[0].values[0][0]), 0);
    const orphans = db.exec("SELECT COUNT(*) FROM pragma_foreign_key_check WHERE parent = 'metabots'");
    assert.equal(Number(orphans[0].values[0][0]), 0);
  } finally {
    store.close();
  }
});

test('deleteMetabot also removes the bot metabot_directives rows (retired-feature table, NOT NULL metabot_id)', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    assert.equal(foreignKeysEnabled(db), 1);

    ensureDirectivesTable(db);
    insertWallet(db, 1);
    insertMetabot(db, { id: 7, walletId: 1, name: 'Directed Bot', createdAt: 1000 });
    insertDirective(db, { id: 'dir-1', metabotId: 7, text: 'never quote prices' });

    assert.throws(() => db.run('DELETE FROM metabots WHERE id = ?', [7]), /FOREIGN KEY constraint failed/);

    assert.equal(metabotStore.deleteMetabot(7), true);
    assert.equal(metabotStore.getMetabotById(7), null);
    const after = db.exec('SELECT COUNT(*) FROM metabot_directives WHERE metabot_id = 7');
    assert.equal(Number(after[0].values[0][0]), 0);
  } finally {
    store.close();
  }
});

test('deleteMetabot succeeds when the lazily-created reference tables were never created', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    assert.equal(foreignKeysEnabled(db), 1);

    // Sanity: this fresh store never touched the standing-page or directives
    // features, so their tables do not exist — the best-effort cleanups must
    // tolerate that instead of failing the delete.
    const absent = db.exec(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('metabot_standing_pages', 'metabot_directives')"
    );
    assert.equal(Number(absent[0].values[0][0]), 0);

    insertWallet(db, 1);
    insertMetabot(db, { id: 9, walletId: 1, name: 'Fresh Bot', createdAt: 1000 });

    assert.equal(metabotStore.deleteMetabot(9), true);
    assert.equal(metabotStore.getMetabotById(9), null);
  } finally {
    store.close();
  }
});

test('deleteMetabot on an unknown id is a no-op returning false', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore } = await openStores(tempDir);
  try {
    assert.equal(metabotStore.deleteMetabot(424242), false);
  } finally {
    store.close();
  }
});
