import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const seed = async () => {
  const { db, cleanup } = await createSqliteStore();
  const store = createCoworkStore(db);

  const active = store.createSession('活跃的会话', '/tmp/a', '', 'local', [], 5);
  const arch1 = store.createSession('发布 MetaApp 复盘', '/tmp/b', '', 'local', [], 5);
  const arch2 = store.createSession('和 Nova 闲聊', '/tmp/c', '', 'local', [], 5, 'a2a', 'nova-gmid', 'Nova', null);
  const arch3 = store.createSession('别的 bot 的归档', '/tmp/d', '', 'local', [], 6);

  for (const id of [arch1.id, arch2.id, arch3.id]) {
    store.archiveSession(id);
    // ensure deterministic archived_at ordering
    db.run('UPDATE cowork_sessions SET archived_at = ? WHERE id = ?', [
      id === arch1.id ? 1000 : id === arch2.id ? 2000 : 3000,
      id,
    ]);
  }
  return { db, cleanup, store, active, arch1, arch2, arch3 };
};

test('listArchivedSessions returns only archived sessions, newest archive first', async () => {
  const { db, cleanup, store, active, arch1, arch2, arch3 } = await seed();
  try {
    const all = store.listArchivedSessions();
    assert.deepEqual(all.map((s) => s.id), [arch3.id, arch2.id, arch1.id]);
    assert.ok(!all.some((s) => s.id === active.id), 'active session excluded');
    assert.ok(all.every((s) => typeof s.archivedAt === 'number'), 'archivedAt populated');
    assert.equal(all[0].peerName, null);
    assert.equal(all[1].peerName, 'Nova');
    assert.equal(all[1].sessionType, 'a2a');
  } finally {
    cleanup();
  }
});

test('setSessionModel stores a per-session model without touching other sessions', async () => {
  const { db, cleanup, store, arch1, arch2 } = await seed();
  try {
    // Fresh sessions inherit the global default (model = null).
    assert.equal(store.getSession(arch1.id).model, null);
    assert.equal(store.getSession(arch2.id).model, null);

    // Setting a model on one session must not affect the other.
    store.setSessionModel(arch1.id, 'deepseek-v4-pro');
    assert.equal(store.getSession(arch1.id).model, 'deepseek-v4-pro');
    assert.equal(store.getSession(arch2.id).model, null, 'other session untouched');

    // Clearing the override falls back to the global default again.
    store.setSessionModel(arch1.id, null);
    assert.equal(store.getSession(arch1.id).model, null, 'cleared override');
    assert.equal(store.getSession(arch1.id).modelProvider, null, 'cleared provider');
  } finally {
    cleanup();
  }
});

test('setSessionModel stores the provider key so colliding model ids stay disambiguated', async () => {
  const { cleanup, store, arch1, arch2 } = await seed();
  try {
    store.setSessionModel(arch1.id, 'deepseek-v4-flash', null, 'opencode');
    const session = store.getSession(arch1.id);
    assert.equal(session.model, 'deepseek-v4-flash');
    assert.equal(session.modelProvider, 'opencode');
    assert.equal(store.getSession(arch2.id).modelProvider, null, 'other session untouched');

    const listed = store.listArchivedSessions().find((row) => row.id === arch1.id);
    assert.equal(listed?.modelProvider, 'opencode');

    const live = store.createSession(
      'live collision',
      '/tmp/e',
      '',
      'local',
      [],
      5,
      'standard',
      null,
      null,
      null,
      'default',
      'deepseek-v4-flash',
      null,
      'opencode',
    );
    assert.equal(live.modelProvider, 'opencode');
    assert.equal(store.getSession(live.id).modelProvider, 'opencode');
    assert.equal(
      store.listSessions().find((row) => row.id === live.id)?.modelProvider,
      'opencode',
    );

    store.setSessionModel(arch1.id, null);
    assert.equal(store.getSession(arch1.id).modelProvider, null, 'cleared provider with model');
  } finally {
    cleanup();
  }
});

test('listArchivedSessions filters by sessionType a2a, and unarchive restores it out of the list', async () => {
  const { db, cleanup, store, arch1, arch2, arch3 } = await seed();
  try {
    // Only the archived A2A session matches the filter.
    assert.deepEqual(store.listArchivedSessions({ sessionType: 'a2a' }).map((s) => s.id), [arch2.id]);
    assert.equal(store.countArchivedSessions({ sessionType: 'a2a' }), 1);

    // Unarchive clears archived_at: the session leaves the archived list again.
    store.unarchiveSession(arch2.id);
    assert.equal(store.isSessionArchived(arch2.id), false);
    assert.deepEqual(store.listArchivedSessions({ sessionType: 'a2a' }).map((s) => s.id), []);
  } finally {
    cleanup();
  }
});

test('listArchivedSessions filters by metabot and by title/peer query', async () => {
  const { db, cleanup, store, arch1, arch2, arch3 } = await seed();
  try {
    assert.deepEqual(store.listArchivedSessions({ metabotId: 5 }).map((s) => s.id), [arch2.id, arch1.id]);
    assert.deepEqual(store.listArchivedSessions({ metabotId: 6 }).map((s) => s.id), [arch3.id]);

    assert.deepEqual(store.listArchivedSessions({ query: 'metaapp' }).map((s) => s.id), [arch1.id], 'title LIKE, case-insensitive');
    assert.deepEqual(store.listArchivedSessions({ query: 'nova' }).map((s) => s.id), [arch2.id], 'peer name LIKE');
    assert.deepEqual(store.listArchivedSessions({ query: '%' }).length, 0, 'wildcards escaped');
    assert.deepEqual(store.listArchivedSessions({ query: '不存在' }).length, 0);
  } finally {
    cleanup();
  }
});

test('listArchivedSessions honors limit and offset', async () => {
  const { db, cleanup, store, arch1, arch2, arch3 } = await seed();
  try {
    const page1 = store.listArchivedSessions({ limit: 2 });
    assert.deepEqual(page1.map((s) => s.id), [arch3.id, arch2.id]);
    const page2 = store.listArchivedSessions({ limit: 2, offset: 2 });
    assert.deepEqual(page2.map((s) => s.id), [arch1.id]);
  } finally {
    cleanup();
  }
});

test('listArchivedSessions searchContent matches message bodies only when enabled', async () => {
  const { db, cleanup, store, arch1, arch2 } = await seed();
  try {
    const bodyOnly = '只在正文出现的独特词 body-only-secret';
    const chineseBodyOnly = '正文独有中文词';
    db.run(
      "INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, 'assistant', ?, NULL, ?, 1)",
      ['m-body-1', arch1.id, `这段消息正文里包含 ${bodyOnly} 和 ${chineseBodyOnly}`, 5000],
    );
    db.run(
      "INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, 'user', ?, NULL, ?, 1)",
      ['m-body-2', arch2.id, bodyOnly, 5001],
    );

    // Without the toggle, body-only keywords must NOT match (title/peer search only).
    assert.equal(store.listArchivedSessions({ query: bodyOnly }).length, 0, 'body-only keyword misses without searchContent');
    assert.equal(store.countArchivedSessions({ query: bodyOnly }), 0, 'count agrees without searchContent');

    // With the toggle, both sessions whose bodies contain the keyword match.
    const hits = store.listArchivedSessions({ query: bodyOnly, searchContent: true }).map((s) => s.id).sort();
    assert.deepEqual(hits, [arch1.id, arch2.id].sort(), 'body-only keyword hits with searchContent');
    assert.equal(store.countArchivedSessions({ query: bodyOnly, searchContent: true }), 2, 'count agrees with searchContent');

    // Non-ASCII body content matches too.
    assert.deepEqual(
      store.listArchivedSessions({ query: chineseBodyOnly, searchContent: true }).map((s) => s.id),
      [arch1.id],
      'chinese body content matches with searchContent',
    );
    // Title matches still work alongside body search.
    assert.deepEqual(
      store.listArchivedSessions({ query: 'metaapp', searchContent: true }).map((s) => s.id),
      [arch1.id],
      'title match preserved when searchContent enabled',
    );
  } finally {
    cleanup();
  }
});

test('listArchivedSessions carries the orchestrator name, so an archived process row is not blank', async () => {
  // Regression pinned 2026-11-21 (1121-b 进程中心): the 已归档 tab renders the
  // same row anatomy as the live tabs — status dot + name + kind tag +
  // ORCHESTRATOR + latest activity. The archived reader used to select neither
  // `metabots` nor `mb.name`, so `metabotName` came back null for every
  // archived row and the orchestrator column rendered silently empty: no
  // error, no test failure, just a column that never filled in.
  const { db, cleanup, store } = await seed();
  try {
    // `createSqliteStore` seeds NO metabots (that INSERT lives only in
    // createLegacyMemoryDb), so this test owns its roster: id 1 gets a name the
    // join can resolve, id 5 deliberately has no row at all — the positive and
    // the negative control in one fixture. The real `metabots` table carries
    // NOT NULL columns without defaults, so the row states all of them.
    db.run(
      `INSERT INTO metabots
        (id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
         name, metaid, metabot_type, created_by, role, soul, created_at, updated_at)
       VALUES (1, 1, 'mvc-addr-1', 'btc-addr-1', 'doge-addr-1', 'pub-1', 'chat-pub-1',
         'Twin', 'metaid-1', 'twin', 'owner', 'twin', 'twin-soul', 0, 0)`,
    );
    const withBot = store.createSession('归档的进程会话', '/tmp/x', '', 'local', [], 1);
    const withoutBot = store.createSession('归档的孤儿会话', '/tmp/y', '', 'local', [], 5);
    for (const id of [withBot.id, withoutBot.id]) store.archiveSession(id);

    const rows = store.listArchivedSessions();
    const named = rows.find((row) => row.id === withBot.id);
    const orphan = rows.find((row) => row.id === withoutBot.id);

    assert.equal(named?.metabotName, 'Twin', 'the archived row carries its orchestrator name');
    assert.equal(named?.metabotId, 1, 'and keeps the id it resolves from');
    assert.equal(orphan?.metabotName, null, 'a session whose metabot row is gone degrades to null, not a crash');

    // The live list already promised this; the archived reader must agree, or
    // the two tabs describe the same session differently.
    const liveName = store.getSession(withBot.id)?.metabotName;
    assert.equal(liveName, 'Twin', 'live read agrees with the archived read');

    // The worker-backed page path runs its own SQL copy — it must carry the
    // join too, so the 已归档 tab does not lose the column on a big database.
    const page = await store.listArchivedSessionsPageAsync({ limit: 50 });
    const pagedNamed = page.sessions.find((row) => row.id === withBot.id);
    assert.equal(pagedNamed?.metabotName, 'Twin', 'the paginated SQL copy carries the name as well');
    assert.equal(page.total >= 2, true);
  } finally {
    cleanup();
  }
});
