// Store-level pins for CoworkStore.searchSessionMessages — the verbatim
// in-conversation recall behind the conversation_recall tool. Long sessions
// compact silently, so early turns survive only in cowork_messages; the
// search must return owner/assistant rows only, skip hidden row classes,
// and rank by matched-term count then recency. Run
// `pnpm run compile:electron` first (mirrors metabotAutoReplyDefault.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  const coworkStore = new CoworkStore(db, save);
  return { coworkStore, sqliteStore, dir };
}

/**
 * Windows teardown: close the sql.js store before the tolerant rm so a
 * lingering handle cannot turn cleanup into EPERM (house pattern from
 * tests/metabotAutoReplyDefault.test.mjs).
 */
function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering Windows handle must never fail the test during cleanup
  }
}

function seedSession(store) {
  return store.createSession('Recall test', process.cwd());
}

test('searchSessionMessages returns owner and assistant hits with recall metadata', async () => {
  const { coworkStore, sqliteStore, dir } = await openStore('idbots-recall-');
  try {
    const session = seedSession(coworkStore);
    const other = seedSession(coworkStore);
    coworkStore.addMessage(session.id, { type: 'user', content: '我们决定用蓝色主题上线。', metadata: {} });
    coworkStore.addMessage(session.id, { type: 'assistant', content: '好的，蓝色主题已经记下了。', metadata: {} });
    coworkStore.addMessage(session.id, { type: 'user', content: 'worker report mentioning 蓝色 too', metadata: { origin: 'cross_session', sourceChannel: 'idbots_cross_session' } });
    // Noise that must never surface: other types, other sessions, empty rows.
    coworkStore.addMessage(session.id, { type: 'system', content: 'system note about 蓝色', metadata: {} });
    coworkStore.addMessage(other.id, { type: 'user', content: '蓝色 in another session', metadata: {} });
    coworkStore.insertHistoricalCoworkMessage(session.id, { type: 'assistant', content: '   ', timestamp: Date.now(), metadata: {} });

    const hits = coworkStore.searchSessionMessages(session.id, { terms: ['蓝色'], limit: 8 });
    assert.equal(hits.length, 3);
    assert.equal(hits.filter((hit) => hit.type === 'user').length, 2);
    assert.equal(hits.filter((hit) => hit.type === 'assistant').length, 1);
    const workerReport = hits.find((hit) => hit.metadata?.origin === 'cross_session');
    assert.ok(workerReport, 'worker-report metadata rides along for speaker labelling');
    assert.equal(workerReport.type, 'user');
    assert.ok(hits.every((hit) => typeof hit.id === 'string' && hit.id.length > 0));
    assert.ok(hits.every((hit) => typeof hit.createdAt === 'number' && hit.createdAt > 0));
    assert.ok(hits.every((hit) => !hit.content.includes('system note') && !hit.content.includes('another session')));
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('searchSessionMessages excludes thinking, sandbox-hidden and delegation-internal rows', async () => {
  const { coworkStore, sqliteStore, dir } = await openStore('idbots-recall-');
  try {
    const session = seedSession(coworkStore);
    coworkStore.addMessage(session.id, { type: 'assistant', content: 'visible answer about 青铜', metadata: {} });
    coworkStore.addMessage(session.id, { type: 'assistant', content: 'thinking draft about 青铜', metadata: { isThinking: true } });
    coworkStore.addMessage(session.id, { type: 'user', content: 'hidden owner note about 青铜', metadata: { excludeFromSandboxHistory: true } });
    coworkStore.addMessage(session.id, { type: 'assistant', content: 'delegation internals about 青铜', metadata: { isDelegationInternal: true } });

    const hits = coworkStore.searchSessionMessages(session.id, { terms: ['青铜'], limit: 8 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, 'visible answer about 青铜');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('searchSessionMessages ranks by matched-term count, then recency', async () => {
  const { coworkStore, sqliteStore, dir } = await openStore('idbots-recall-');
  try {
    const session = seedSession(coworkStore);
    const t0 = Date.now() - 60_000;
    // Older row matches BOTH terms; newer row matches only one — the older
    // two-term hit must rank first.
    coworkStore.insertHistoricalCoworkMessage(session.id, {
      type: 'user', content: 'launch date is March 3 and the codename is falcon', timestamp: t0, metadata: {},
    });
    coworkStore.insertHistoricalCoworkMessage(session.id, {
      type: 'assistant', content: 'noted: the codename is falcon', timestamp: t0 + 30_000, metadata: {},
    });
    coworkStore.insertHistoricalCoworkMessage(session.id, {
      type: 'user', content: 'unrelated chatter about the weather', timestamp: t0 + 45_000, metadata: {},
    });

    const hits = coworkStore.searchSessionMessages(session.id, { terms: ['codename', 'march'], limit: 8 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].content, 'launch date is March 3 and the codename is falcon', 'two matched terms beat one');
    assert.equal(hits[1].content, 'noted: the codename is falcon');

    // Same term count → newest first.
    const single = coworkStore.searchSessionMessages(session.id, { terms: ['codename'], limit: 8 });
    assert.equal(single.length, 2);
    assert.equal(single[0].content, 'noted: the codename is falcon', 'recency breaks the tie');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('searchSessionMessages honours the limit and returns [] for empty terms', async () => {
  const { coworkStore, sqliteStore, dir } = await openStore('idbots-recall-');
  try {
    const session = seedSession(coworkStore);
    for (let index = 0; index < 5; index += 1) {
      coworkStore.addMessage(session.id, { type: 'user', content: `repeat needle ${index}`, metadata: {} });
    }
    assert.equal(coworkStore.searchSessionMessages(session.id, { terms: ['needle'], limit: 3 }).length, 3);
    assert.equal(coworkStore.searchSessionMessages(session.id, { terms: [], limit: 8 }).length, 0);
    assert.equal(coworkStore.searchSessionMessages(session.id, { terms: ['absent'], limit: 8 }).length, 0);
    assert.equal(coworkStore.searchSessionMessages('', { terms: ['needle'], limit: 8 }).length, 0);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});
