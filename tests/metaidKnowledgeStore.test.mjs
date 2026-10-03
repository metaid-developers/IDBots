import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLegacyMemoryDb,
  createSqliteStore,
  getColumns,
  getIndexNames,
} from './memoryTestUtils.mjs';

let MetaIDKnowledgeStore;
let ensureMetaIDKnowledgeSchema;
try {
  ({ MetaIDKnowledgeStore, ensureMetaIDKnowledgeSchema } =
    await import('../dist-electron/main/metaidKnowledgeStore.js'));
} catch {
  ({ MetaIDKnowledgeStore, ensureMetaIDKnowledgeSchema } =
    await import('../dist-electron/main/metaidKnowledgeStore.js'));
}

const KNOWLEDGE_TABLES = [
  'metaid_knowledge_entries',
  'metaid_knowledge_procedures',
  'metaid_knowledge_revisions',
  'metaid_knowledge_sources',
];

test('SqliteStore creates the knowledge schema and repeated initialization is idempotent', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    for (const table of KNOWLEDGE_TABLES) {
      assert.ok(getColumns(db, table).length > 0, `missing table ${table}`);
    }
    assert.ok(getColumns(db, 'metaid_knowledge_entries').includes('topic_fingerprint'));
    assert.ok(getColumns(db, 'metaid_knowledge_entries').includes('kind'));
    assert.ok(getColumns(db, 'metaid_knowledge_entries').includes('version'));
    assert.ok(getColumns(db, 'metaid_knowledge_revisions').includes('version'));

    ensureMetaIDKnowledgeSchema(db);
    const tables = db.exec(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'metaid_knowledge_%'
      ORDER BY name
    `)[0].values.map((row) => row[0]).sort();
    assert.deepEqual(tables, KNOWLEDGE_TABLES);
  } finally {
    harness.cleanup();
  }
});

test('legacy databases receive additive knowledge tables without changing existing rows', async () => {
  const db = await createLegacyMemoryDb();
  db.run(`INSERT INTO user_memories (id, metabot_id, text, fingerprint, created_at, updated_at)
          VALUES ('legacy-memory', 1, 'keep me', 'legacy-fingerprint', 10, 10)`);
  new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  assert.equal(db.exec("SELECT text FROM user_memories WHERE id = 'legacy-memory'")[0].values[0][0], 'keep me');
  assert.ok(getColumns(db, 'metaid_knowledge_entries').length > 0);
});

test('upsert creates a new knowledge entry on first write (version 1)', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  const result = store.upsertKnowledge({
    metabotId: 1,
    topic: '快速开发 3D 网页游戏的最快路径',
    summary: '使用 React Three Fiber + Vite，比裸 WebGL 快一个量级。',
    kind: 'know_how',
    category: '技术栈',
    tags: ['3D', 'R3F'],
    origin: 'agent',
    sources: [{ sessionId: 'sess-1', sourceChannel: 'cowork', relevance: '主对话验证' }],
  });

  assert.equal(result.created, true);
  assert.equal(result.revised, false);
  assert.equal(result.entry.version, 1);
  assert.equal(result.entry.status, 'active');
  assert.equal(result.entry.kind, 'know_how');
  assert.deepEqual(result.entry.tags, ['3D', 'R3F']);
  const sources = store.listKnowledgeSources(result.entry.id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].sessionId, 'sess-1');
});

test('upsert revises an existing topic: bumps version and archives the prior text as a revision', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  store.upsertKnowledge({
    metabotId: 1,
    topic: '用户喜欢的网页设计风格',
    summary: '偏好简约风。',
    kind: 'know_how',
  });
  const revised = store.upsertKnowledge({
    metabotId: 1,
    topic: '用户喜欢的网页设计风格',
    summary: '偏好简约风：大量留白、最多两种主色、圆角卡片。',
    kind: 'principle',
    category: '设计',
    origin: 'dream',
    sourceDreamDate: '2026-08-13',
  });

  assert.equal(revised.created, false);
  assert.equal(revised.revised, true);
  assert.equal(revised.entry.version, 2);
  assert.equal(revised.entry.kind, 'principle');
  assert.equal(revised.entry.summary, '偏好简约风：大量留白、最多两种主色、圆角卡片。');

  const revisions = store.listKnowledgeRevisions(revised.entry.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].version, 1);
  assert.equal(revisions[0].summary, '偏好简约风。');
});

test('upsert is a no-op when topic + summary + kind are unchanged (no fake revision)', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  const first = store.upsertKnowledge({
    metabotId: 1,
    topic: '部署 Electron 自动更新',
    summary: '用 electron-updater + GitHub releases。',
    kind: 'know_how',
  });
  const second = store.upsertKnowledge({
    metabotId: 1,
    topic: '部署 Electron 自动更新',
    summary: '用 electron-updater + GitHub releases。',
    kind: 'know_how',
    tags: ['electron'], // extra tags alone do not count as a content change
  });

  assert.equal(second.created, false);
  assert.equal(second.revised, false);
  assert.equal(second.entry.version, 1);
  assert.equal(store.listKnowledgeRevisions(first.entry.id).length, 0);
});

test('topic fingerprint matching is case- and whitespace-insensitive', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  const first = store.upsertKnowledge({
    metabotId: 1,
    topic: 'WebGL Context Loss 处理',
    summary: '监听 webglcontextlost 并阻止默认行为。',
    kind: 'pitfall',
  });
  const again = store.upsertKnowledge({
    metabotId: 1,
    topic: '  webgl   context  loss  处理 ',
    summary: '监听 webglcontextlost，阻止默认行为，并在 restored 后重建场景。',
    kind: 'pitfall',
  });

  assert.equal(again.created, false);
  assert.equal(again.revised, true);
  assert.equal(again.entry.id, first.entry.id);
});

test('pitfall is a first-class kind and is preserved through upsert', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  const { entry } = store.upsertKnowledge({
    metabotId: 1,
    topic: '不要在 SSR 产物里直接访问 window',
    summary: '会直接崩溃，必须用 typeof window === "undefined" 守卫。',
    kind: 'pitfall',
  });
  assert.equal(entry.kind, 'pitfall');
  const listed = store.listKnowledge({ metabotId: 1, kind: 'pitfall' });
  assert.equal(listed.length, 1);
});

test('upsert reactivates an archived topic when rewritten', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  const { entry } = store.upsertKnowledge({
    metabotId: 1,
    topic: '临时结论',
    summary: 'v1',
    kind: 'know_how',
  });
  store.archiveKnowledge({ id: entry.id, metabotId: 1 });
  assert.equal(store.getKnowledge(entry.id).status, 'archived');
  assert.equal(store.listKnowledge({ metabotId: 1, status: 'active' }).length, 0);

  const revived = store.upsertKnowledge({
    metabotId: 1,
    topic: '临时结论',
    summary: 'v2 复活了',
    kind: 'know_how',
  });
  assert.equal(revived.entry.status, 'active');
  assert.equal(revived.entry.version, 2);
});

test('listKnowledge filters by query and touches last_used_at on recall', async () => {
  const db = await createLegacyMemoryDb();
  let clock = 1000;
  const store = new MetaIDKnowledgeStore(db, () => {}, () => clock);

  store.upsertKnowledge({ metabotId: 1, topic: 'Three.js 性能优化', summary: '用 InstancedMesh 合批。', kind: 'know_how' });
  store.upsertKnowledge({ metabotId: 1, topic: 'Git rebase 冲突', summary: '先 fetch 再 rebase。', kind: 'know_how' });

  const hits = store.searchKnowledge({ metabotId: 1, query: 'three', touchLastUsed: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].topic, 'Three.js 性能优化');
  assert.equal(hits[0].lastUsedAt, 1000);

  clock = 2000;
  const all = store.listKnowledge({ metabotId: 1, limit: 10 });
  assert.equal(all.length, 2);
});

test('countActive and listKnowledgeForDream expose a compact active view', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  store.upsertKnowledge({ metabotId: 1, topic: 'A', summary: 'a', kind: 'know_how' });
  store.upsertKnowledge({ metabotId: 1, topic: 'B', summary: 'b', kind: 'pitfall' });
  const archived = store.upsertKnowledge({ metabotId: 1, topic: 'C', summary: 'c', kind: 'know_how' });
  store.archiveKnowledge({ id: archived.entry.id, metabotId: 1 });

  assert.equal(store.countActive(1), 2);
  const dreamView = store.listKnowledgeForDream(1);
  assert.equal(dreamView.length, 2);
  assert.ok(dreamView.some((item) => item.kind === 'pitfall'));
  for (const item of dreamView) {
    assert.ok(item.topic);
    assert.ok(item.summary);
    assert.ok(typeof item.version === 'number');
  }
});

test('listKnowledge includeArchived widens active to active+archived, never superseded', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  store.upsertKnowledge({ metabotId: 1, topic: '活跃点', summary: 'a', kind: 'know_how' });
  const archived = store.upsertKnowledge({ metabotId: 1, topic: '归档点', summary: 'b', kind: 'pitfall' });
  store.archiveKnowledge({ id: archived.entry.id, metabotId: 1 });
  const superseded = store.upsertKnowledge({ metabotId: 1, topic: '被替代点', summary: 'c', kind: 'know_how' });
  db.run(`UPDATE metaid_knowledge_entries SET status = 'superseded' WHERE id = ?`, [superseded.entry.id]);

  const activeOnly = store.listKnowledge({ metabotId: 1 }).map((entry) => entry.topic);
  assert.deepEqual(activeOnly, ['活跃点'], 'default listing hides archived and superseded');

  const cold = store.listKnowledge({ metabotId: 1, includeArchived: true });
  assert.deepEqual(
    cold.map((entry) => entry.topic).sort(),
    ['归档点', '活跃点'],
    'cold channel returns archived alongside active, superseded stays hidden'
  );
  assert.equal(cold.find((entry) => entry.topic === '归档点').status, 'archived');

  const explicitArchived = store.listKnowledge({ metabotId: 1, status: 'archived', includeArchived: true });
  assert.deepEqual(explicitArchived.map((entry) => entry.topic), ['归档点'], 'explicit status wins over the widening');
});

test('invalid kind/origin values are rejected by the schema CHECK constraints', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDKnowledgeStore(db, () => {}, () => 1000);

  const { entry } = store.upsertKnowledge({ metabotId: 1, topic: 'T', summary: 's', kind: 'know_how' });
  // Bypass the normalizer to exercise the DB-level CHECK constraint.
  assert.throws(() => {
    db.run('UPDATE metaid_knowledge_entries SET kind = ? WHERE id = ?', ['bogus', entry.id]);
  }, /constraint/i);
});

test('pruneKnowledgeRevisions keeps the newest N revisions per entry', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const store = new MetaIDKnowledgeStore(db, () => {});
    for (let version = 1; version <= 5; version += 1) {
      store.upsertKnowledge({
        metabotId: 1,
        topic: 'release checklist',
        summary: `checklist v${version}`,
        kind: 'know_how',
        origin: 'dream',
      });
    }
    for (let version = 1; version <= 2; version += 1) {
      store.upsertKnowledge({
        metabotId: 1,
        topic: 'small topic',
        summary: `small v${version}`,
        kind: 'principle',
        origin: 'dream',
      });
    }
    const count = (where = '') => Number(
      db.exec(`SELECT COUNT(*) AS n FROM metaid_knowledge_revisions ${where}`)[0]?.values?.[0]?.[0]
    );
    assert.equal(count(), 5, 'main topic 4 rewrites + small topic 1 rewrite leave 5 revisions');

    const result = store.pruneKnowledgeRevisions({ keepPerEntry: 2 });
    assert.equal(result.entriesPruned, 1, 'only the overflowing entry prunes');
    assert.equal(result.revisionsDeleted, 2);
    assert.equal(count(), 3, 'newest two main revisions plus the small one survive');
    assert.ok(
      db.exec("SELECT summary FROM metaid_knowledge_revisions WHERE summary LIKE 'checklist v%'")
        [0]?.values?.every((row) => ['checklist v3', 'checklist v4'].includes(row[0])),
      'kept revisions are the newest by version'
    );
    const live = store.listKnowledgeForDream(1).find((entry) => entry.topic.includes('release'));
    assert.equal(live?.summary, 'checklist v5', 'the live entry text is untouched');

    const again = store.pruneKnowledgeRevisions({ keepPerEntry: 2 });
    assert.equal(again.revisionsDeleted, 0, 'idempotent');
  } finally {
    harness.cleanup();
  }
});
