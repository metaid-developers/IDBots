import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createLegacyMemoryDb,
  getRow,
} from './memoryTestUtils.mjs';

test('dedupe and list matching stay inside one metabot and scope bucket', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  const ownerEntry = store.createUserMemory({
    metabotId: 1,
    text: 'The client prefers English',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  const contactEntry = store.createUserMemory({
    metabotId: 1,
    text: 'The client prefers English',
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:peer-123',
  });

  assert.notEqual(ownerEntry.id, contactEntry.id);

  const ownerEntries = store.listUserMemories({
    metabotId: 1,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  const contactEntries = store.listUserMemories({
    metabotId: 1,
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:peer-123',
  });

  assert.deepEqual(ownerEntries.map((entry) => entry.id), [ownerEntry.id]);
  assert.deepEqual(contactEntries.map((entry) => entry.id), [contactEntry.id]);
});

test('delete stays inside the requested scope bucket and returns true when the memory row changes', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  const entry = store.createUserMemory({
    metabotId: 1,
    text: 'I prefer concise replies',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });

  db.run('DELETE FROM user_memory_sources WHERE memory_id = ?', [entry.id]);

  const wrongScopeDeleted = store.deleteUserMemory({
    id: entry.id,
    metabotId: 1,
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:peer-123',
  });
  assert.equal(wrongScopeDeleted, false);
  assert.equal(getRow(db, 'SELECT status FROM user_memories WHERE id = ?', [entry.id])?.status, 'created');

  const deleted = store.deleteUserMemory({
    id: entry.id,
    metabotId: 1,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  assert.equal(deleted, true);
  assert.equal(getRow(db, 'SELECT status FROM user_memories WHERE id = ?', [entry.id])?.status, 'deleted');
});

test('scoped stats and housekeeping stay inside the requested scope bucket', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  const ownerImplicit = store.createUserMemory({
    metabotId: 1,
    text: 'I prefer concise replies',
    isExplicit: false,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  const contactImplicit = store.createUserMemory({
    metabotId: 1,
    text: 'The client prefers concise replies',
    isExplicit: false,
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:peer-123',
  });

  db.run('DELETE FROM user_memory_sources WHERE memory_id IN (?, ?)', [
    ownerImplicit.id,
    contactImplicit.id,
  ]);

  store.markOrphanImplicitMemoriesStale(1, {
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  assert.equal(getRow(db, 'SELECT status FROM user_memories WHERE id = ?', [ownerImplicit.id])?.status, 'stale');
  assert.equal(getRow(db, 'SELECT status FROM user_memories WHERE id = ?', [contactImplicit.id])?.status, 'created');

  const ownerStats = store.getUserMemoryStats({
    metabotId: 1,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  const contactStats = store.getUserMemoryStats({
    metabotId: 1,
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:peer-123',
  });

  assert.equal(ownerStats.stale, 1);
  assert.equal(contactStats.created, 1);
});

test('create derives importance from class/origin/explicit, override wins, revive keeps the max', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  const explicit = store.createUserMemory({
    metabotId: 1, text: '用户明确交代每周五发布版本', scopeKind: 'owner', scopeKey: 'owner:self', isExplicit: true,
  });
  assert.equal(explicit.importance, 0.9);

  const identity = store.createUserMemory({
    metabotId: 1, text: '我是用户的专属助手', scopeKind: 'owner', scopeKey: 'owner:self',
    usageClass: 'self_identity', origin: 'dream', forceNew: true,
  });
  assert.equal(identity.importance, 1.0);

  const review = store.createUserMemory({
    metabotId: 1, text: '工作评价:交付获得高度赞扬', scopeKind: 'owner', scopeKey: 'owner:self',
    usageClass: 'work_review', origin: 'dream', forceNew: true,
  });
  assert.equal(review.importance, 0.7);

  const overridden = store.createUserMemory({
    metabotId: 1, text: '手动调低重要度的一条记录', scopeKind: 'owner', scopeKey: 'owner:self',
    importance: 0.3, forceNew: true,
  });
  assert.equal(overridden.importance, 0.3);

  const plain = store.createUserMemory({
    metabotId: 1, text: '后来被用户再次强调的事实', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  assert.equal(plain.importance, 0.5);
  const raised = store.createUserMemory({
    metabotId: 1, text: '后来被用户再次强调的事实', scopeKind: 'owner', scopeKey: 'owner:self', isExplicit: true,
  });
  assert.equal(raised.id, plain.id, 'restatement revives the same row');
  assert.equal(raised.importance, 0.9, 'revive raises to the newly derived value');

  const lowered = store.createUserMemory({
    metabotId: 1, text: '后来被用户再次强调的事实', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  assert.equal(lowered.importance, 0.9, 'revive never lowers stored importance');
});

test('listUserMemories orders by last use so injected memories do not age out', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  const stale = store.createUserMemory({
    metabotId: 1, text: '最老创建但天天被注入使用', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  const newest = store.createUserMemory({
    metabotId: 1, text: '昨晚刚写入的新记忆', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  db.run('UPDATE user_memories SET updated_at = ? WHERE id = ?', [1000, stale.id]);
  db.run('UPDATE user_memories SET updated_at = ? WHERE id = ?', [2000, newest.id]);

  const listIds = () => store
    .listUserMemories({ metabotId: 1, scopeKind: 'owner', scopeKey: 'owner:self' })
    .map((memory) => memory.id);

  assert.deepEqual(listIds(), [newest.id, stale.id], 'without a usage signal, freshest edit leads');

  db.run('UPDATE user_memories SET last_used_at = ? WHERE id = ?', [3000, stale.id]);
  assert.deepEqual(listIds(), [stale.id, newest.id], 'a used memory outranks a fresher untouched edit');
});
