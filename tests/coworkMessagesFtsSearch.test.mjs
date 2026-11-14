import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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

test('CoworkStore FTS5 trigram index serves CJK and English searches and keeps <3-char LIKE fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-fts-search-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const coworkStore = new CoworkStore(db, sqliteStore.getSaveFunction());
    assert.equal(coworkStore.isMessagesFtsReady(), true);

    const s1 = coworkStore.createSession('Performance Architecture', '/tmp', '', 'local', [], null);
    coworkStore.addMessage(s1.id, { type: 'user', content: '我们需要用 SQLite FTS5 优化全局检索速度' });
    coworkStore.addMessage(s1.id, { type: 'assistant', content: '已建立 trigram 倒排索引支持中英文子串匹配' });

    const cjkHits = coworkStore.conversationSearch({ query: '全局检索速度' });
    assert.equal(cjkHits.length, 1);
    assert.equal(cjkHits[0].sessionId, s1.id);

    const enHits = coworkStore.conversationSearch({ query: 'trigram' });
    assert.equal(enHits.length, 1);
    assert.equal(enHits[0].sessionId, s1.id);

    const shortSessionHits = coworkStore.searchSessionMessages(s1.id, { terms: ['优化'] });
    assert.equal(shortSessionHits.length, 1);

    const ftsSessionHits = coworkStore.searchSessionMessages(s1.id, { terms: ['倒排索引'] });
    assert.equal(ftsSessionHits.length, 1);

    // Verify incremental backfill over pre-existing rows when FTS state starts unbuilt.
    db.run("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('cowork.messagesFtsReady.v1', '\"0\"', 1)");
    db.run("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('cowork.messagesFtsCursorRowid.v1', '\"0\"', 1)");
    db.run("INSERT INTO cowork_messages_fts(cowork_messages_fts) VALUES('delete-all')");

    const reopenedStore = new CoworkStore(db, sqliteStore.getSaveFunction(), { deferHeavyStartupMaintenance: true });
    assert.equal(reopenedStore.isMessagesFtsReady(), false);
    const step = reopenedStore.backfillMessagesFtsBatch(100);
    assert.equal(step.done, true);
    assert.equal(reopenedStore.isMessagesFtsReady(), true);
    assert.equal(reopenedStore.conversationSearch({ query: '全局检索速度' }).length, 1);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});
