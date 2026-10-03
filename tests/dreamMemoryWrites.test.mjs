import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const insertMetabot = (db, id, type = 'worker') => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'test', 'role', 'soul', 1, 1)`,
    [
      id,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `pk-${id}`,
      `chatpk-${id}`,
      `bot-${id}`,
      `metaid-${id}`,
      type,
    ]
  );
};

test('memory origin defaults to conversation and accepts dream', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const conversationEntry = store.createUserMemory({
      metabotId: 1,
      text: '用户喜欢简洁的回复',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
    });
    assert.equal(conversationEntry.origin, 'conversation');

    const dreamEntry = store.createUserMemory({
      metabotId: 1,
      text: '做梦时沉淀的重要事项',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      origin: 'dream',
    });
    assert.equal(dreamEntry.origin, 'dream');

    const dreamOnly = store.listUserMemories({
      metabotId: 1,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      origin: 'dream',
    });
    assert.deepEqual(dreamOnly.map((entry) => entry.id), [dreamEntry.id]);
  } finally {
    cleanup();
  }
});

test('reviving an existing memory keeps its original origin', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const original = store.createUserMemory({
      metabotId: 1,
      text: '用户偏好周五发布版本',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
    });
    // A dream write hitting the same fingerprint revives but must not rebrand origin.
    const revived = store.createUserMemory({
      metabotId: 1,
      text: '用户偏好周五发布版本',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      origin: 'dream',
    });
    assert.equal(revived.id, original.id);
    assert.equal(revived.origin, 'conversation');
  } finally {
    cleanup();
  }
});

test('restating an archived memory revives it back into the active list', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const original = store.createUserMemory({
      metabotId: 5, text: '用户偏好周五发布版本', scopeKind: 'owner', scopeKey: 'owner:self',
      origin: 'dream',
    });
    assert.equal(store.archiveUserMemories({ ids: [original.id], archivedAt: Date.now() }), 1);
    assert.equal(
      store.listUserMemories({ metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self' }).length,
      0,
      'archived memory leaves default listings'
    );

    const revived = store.createUserMemory({
      metabotId: 5, text: '用户偏好周五发布版本', scopeKind: 'owner', scopeKey: 'owner:self',
    });
    assert.equal(revived.id, original.id, 'restatement matches the archived row, no duplicate');
    assert.equal(revived.archivedAt, null, 'revive clears the archive mark');

    const active = store.listUserMemories({ metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self' });
    assert.deepEqual(active.map((entry) => entry.id), [original.id], 'the memory is visible again');

    const row = db.exec('SELECT archived_at FROM user_memories WHERE id = ?', [original.id]);
    assert.equal(row[0].values[0][0], null, 'archived_at is NULL in storage');
  } finally {
    cleanup();
  }
});

test('listUserMemories filters by usageClass', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    store.createUserMemory({
      metabotId: 1,
      text: '普通事实记忆',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
    });
    const review = store.createUserMemory({
      metabotId: 1,
      text: '工作评价:为用户制作了演示视频,对方高度赞扬',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
      origin: 'dream',
    });

    const reviews = store.listUserMemories({
      metabotId: 1,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
    });
    assert.deepEqual(reviews.map((entry) => entry.id), [review.id]);
    assert.equal(reviews[0].usageClass, 'work_review');
    assert.equal(reviews[0].origin, 'dream');
  } finally {
    cleanup();
  }
});

test('self_identity entries reject update and delete unless explicitly allowed', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const identity = store.createUserMemory({
      metabotId: 1,
      text: '我是一个专注于视频创作的 MetaBot,做事先验证再交付……',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'self_identity',
      origin: 'dream',
    });
    assert.equal(identity.usageClass, 'self_identity');

    // Tool / IPC / implicit paths (no allowProtected) are refused.
    assert.equal(
      store.updateUserMemory({ id: identity.id, metabotId: 1, text: '试图改写我是谁' }),
      null
    );
    assert.equal(store.deleteUserMemory({ id: identity.id, metabotId: 1 }), false);
    assert.equal(store.deleteUserMemory(identity.id, 1), false);

    // The dream service carries the internal escape hatch.
    const updated = store.updateUserMemory({
      id: identity.id,
      metabotId: 1,
      text: '做梦服务合法更新的自我认知',
      allowProtected: true,
    });
    assert.equal(updated?.text, '做梦服务合法更新的自我认知');
    assert.equal(updated?.usageClass, 'self_identity');

    assert.equal(store.deleteUserMemory({ id: identity.id, metabotId: 1, allowProtected: true }), true);
  } finally {
    cleanup();
  }
});

test('dream_enabled policy defaults on and is settable per bot', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 7, 'worker');

    assert.equal(store.getEffectiveMemoryPolicyForMetabot(7).dreamEnabled, true);
    assert.equal(store.getEffectiveMemoryPolicyForMetabot(null).dreamEnabled, true);

    const updated = store.setMemoryPolicyForMetabot(7, { dreamEnabled: false });
    assert.equal(updated.dreamEnabled, false);
    assert.equal(store.getEffectiveMemoryPolicyForMetabot(7).dreamEnabled, false);

    const reenabled = store.setMemoryPolicyForMetabot(7, { dreamEnabled: true });
    assert.equal(reenabled.dreamEnabled, true);
  } finally {
    cleanup();
  }
});


test('dream memories are tagged with dream_date and replaced per date', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/main/dreamStore.js'));
    new DreamStore(db, () => {}); // ensures the dream_date column exists

    const dreamSource = (dreamDate) => ({ sourceType: 'dream', sourceChannel: 'dream', dreamDate });
    const july30 = store.createUserMemory({
      metabotId: 5, text: '7月30日沉淀的记忆', scopeKind: 'owner', scopeKey: 'owner:self',
      origin: 'dream', source: dreamSource('2026-07-30'),
    });
    const july29 = store.createUserMemory({
      metabotId: 5, text: '7月29日沉淀的记忆', scopeKind: 'owner', scopeKey: 'owner:self',
      origin: 'dream', source: dreamSource('2026-07-29'),
    });
    const identity = store.createUserMemory({
      metabotId: 5, text: '做梦沉淀的我是谁', scopeKind: 'owner', scopeKey: 'owner:self',
      usageClass: 'self_identity', origin: 'dream', source: dreamSource('2026-07-30'),
    });

    const tagRows = db.exec(
      `SELECT dream_date FROM user_memory_sources WHERE memory_id = ? AND dream_date IS NOT NULL`,
      [july30.id]
    );
    assert.equal(tagRows[0].values[0][0], '2026-07-30', 'source row carries the dream date');

    assert.equal(store.softDeleteDreamMemoriesForDate(5, '2026-07-30'), 1);
    assert.equal(store.softDeleteDreamMemoriesForDate(5, '2026-07-30'), 0, 'second delete is a no-op');

    const byId = new Map(
      store.listUserMemories({ metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', status: 'all', includeDeleted: true })
        .map((m) => [m.id, m])
    );
    assert.equal(byId.get(july30.id).status, 'deleted', 'that day batch is removed');
    assert.equal(byId.get(july29.id).status, 'created', 'other days are untouched');
    assert.equal(byId.get(identity.id).status, 'created', 'self_identity is never batch-deleted');

    // conversation-origin memories tagged with a dream date are not swept up
    // (only origin='dream' rows are replaced by the dream pipeline).
    const manual = store.createUserMemory({
      metabotId: 5, text: '用户手动记录的事', scopeKind: 'owner', scopeKey: 'owner:self',
      source: dreamSource('2026-07-30'),
    });
    assert.equal(store.softDeleteDreamMemoriesForDate(5, '2026-07-30'), 0);
    assert.equal(
      store.listUserMemories({ metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', status: 'all', includeDeleted: true })
        .find((m) => m.id === manual.id).status,
      'created'
    );
  } finally {
    cleanup();
  }
});

test('forceNew skips revive dedup so dream batches never resurrect other dates', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const input = (forceNew) => ({
      metabotId: 5, text: '同样的记忆文本', scopeKind: 'owner', scopeKey: 'owner:self',
      origin: 'dream', forceNew, source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-07-30' },
    });

    const first = store.createUserMemory(input(true));
    const second = store.createUserMemory(input(true));
    assert.notEqual(first.id, second.id, 'forceNew always inserts');

    const revived = store.createUserMemory(input(false));
    assert.equal(
      store.listUserMemories({ metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', status: 'all' }).length,
      2,
      'default path still dedups by fingerprint'
    );
    assert.ok([first.id, second.id].includes(revived.id));
  } finally {
    cleanup();
  }
});

test('identity dream-date tag tracks the newest producing dream', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/main/dreamStore.js'));
    new DreamStore(db, () => {});

    assert.equal(store.getDreamIdentityLatestDate(5), null, 'untagged legacy identity reads as null');

    const identity = store.createUserMemory({
      metabotId: 5, text: '我是谁 v1', scopeKind: 'owner', scopeKey: 'owner:self',
      usageClass: 'self_identity', origin: 'dream',
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-07-29' },
    });
    assert.equal(store.getDreamIdentityLatestDate(5), '2026-07-29');

    store.updateUserMemory({
      id: identity.id, metabotId: 5, text: '我是谁 v2', allowProtected: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-07-30' },
    });
    assert.equal(store.getDreamIdentityLatestDate(5), '2026-07-30', 'update path records the newer dream date');
  } finally {
    cleanup();
  }
});

test('legacy untagged dream memories are attributed to a dream date on store init', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/main/dreamStore.js'));
    const dreamStore = new DreamStore(db, () => {});

    dreamStore.beginRun(5, '2026-07-30', null, 0);
    dreamStore.finishRun(5, '2026-07-30', 'completed');

    // A legacy dream memory: source_type='dream', no dream_date tag.
    const legacy = store.createUserMemory({
      metabotId: 5, text: '旧版本梦境留下的记忆', scopeKind: 'owner', scopeKey: 'owner:self',
      origin: 'dream', source: { sourceType: 'dream', sourceChannel: 'dream' },
    });
    const before = db.exec('SELECT dream_date FROM user_memory_sources WHERE memory_id = ?', [legacy.id]);
    assert.equal(before[0].values[0][0], null);

    // Re-initializing the dream store (app restart) backfills the attribution.
    new DreamStore(db, () => {});
    const after = db.exec('SELECT dream_date FROM user_memory_sources WHERE memory_id = ?', [legacy.id]);
    assert.equal(after[0].values[0][0], '2026-07-30', 'backfill attributes the memory to the run that wrote it');

    // The attributed batch is then replaceable by a re-dream of that date.
    assert.equal(store.softDeleteDreamMemoriesForDate(5, '2026-07-30'), 1);
  } finally {
    cleanup();
  }
});


test('self_identity survives the generic 360-char memory cap intact', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const longText = `我是 AI_Sunny。${'我在每一天的经历里持续修正自己,四段式蒸馏自我。'.repeat(24)}`; // ~600 chars
    assert.ok(longText.length > 360);

    const identity = store.createUserMemory({
      metabotId: 5, text: longText, scopeKind: 'owner', scopeKey: 'owner:self',
      usageClass: 'self_identity', origin: 'dream', forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-07-30' },
    });
    assert.equal(identity.text, longText, 'identity entry is stored in full');

    const fact = store.createUserMemory({
      metabotId: 5, text: longText, scopeKind: 'owner', scopeKey: 'owner:self',
      origin: 'dream', forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-07-30' },
    });
    assert.equal(fact.text.length, 360, 'other memory classes keep the 360-char cap');

    const longerText = `${longText}还有新的领悟。`;
    const updated = store.updateUserMemory({
      id: identity.id, metabotId: 5, text: longerText, allowProtected: true,
    });
    assert.equal(updated?.text, longerText, 'identity update path also preserves full text');
  } finally {
    cleanup();
  }
});

test('restoreMissingSelfIdentities revives the newest deleted identity only', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const older = store.createUserMemory({
      metabotId: 1,
      text: '旧的自我认知，已经被后续梦境覆盖。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'self_identity',
      origin: 'dream',
      forceNew: true,
    });
    store.deleteUserMemory({ id: older.id, metabotId: 1, allowProtected: true });

    const newer = store.createUserMemory({
      metabotId: 1,
      text: '我是 AI_Sunny，一个靠一手证据把事情推到闭环的推进者。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'self_identity',
      origin: 'dream',
      forceNew: true,
    });
    store.deleteUserMemory({ id: newer.id, metabotId: 1, allowProtected: true });

    const otherBot = store.createUserMemory({
      metabotId: 2,
      text: '我是另一个还活着的自我认知。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'self_identity',
      origin: 'dream',
      forceNew: true,
    });

    assert.equal(store.restoreMissingSelfIdentities(), 1);
    assert.equal(store.restoreMissingSelfIdentities(), 0, 'second restore is a no-op');

    const restored = store.listUserMemories({
      metabotId: 1, scopeKind: 'owner', scopeKey: 'owner:self',
      usageClass: 'self_identity', status: 'created',
    });
    assert.deepEqual(restored.map((entry) => entry.id), [newer.id]);
    assert.match(restored[0].text, /AI_Sunny/);

    const stillLive = store.listUserMemories({
      metabotId: 2, scopeKind: 'owner', scopeKey: 'owner:self',
      usageClass: 'self_identity', status: 'created',
    });
    assert.deepEqual(stillLive.map((entry) => entry.id), [otherBot.id]);
  } finally {
    cleanup();
  }
});
