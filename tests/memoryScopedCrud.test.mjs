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

  const ownerToolMemory = store.createUserMemory({
    metabotId: 1,
    text: 'use memory skill',
    isExplicit: false,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  const contactToolMemory = store.createUserMemory({
    metabotId: 1,
    text: 'use memory skill',
    isExplicit: false,
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:peer-123',
  });
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

  db.run('DELETE FROM user_memory_sources WHERE memory_id IN (?, ?, ?, ?)', [
    ownerToolMemory.id,
    contactToolMemory.id,
    ownerImplicit.id,
    contactImplicit.id,
  ]);

  const deleted = store.autoDeleteNonPersonalMemories(1, {
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  assert.equal(deleted, 1);
  assert.equal(getRow(db, 'SELECT status FROM user_memories WHERE id = ?', [ownerToolMemory.id])?.status, 'deleted');
  assert.equal(getRow(db, 'SELECT status FROM user_memories WHERE id = ?', [contactToolMemory.id])?.status, 'created');

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

  assert.equal(ownerStats.deleted, 1);
  assert.equal(ownerStats.stale, 1);
  assert.equal(contactStats.created, 2);
});
