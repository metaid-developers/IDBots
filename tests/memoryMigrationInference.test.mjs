import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createLegacyMemoryDb,
  createSqliteStore,
  getColumns,
  getIndexNames,
  getRow,
} from './memoryTestUtils.mjs';

test('sqlite store initializes scoped memory columns and indexes for fresh databases', async () => {
  const { db, cleanup } = await createSqliteStore();

  try {
    const columns = getColumns(db, 'user_memories');
    assert(columns.includes('scope_kind'));
    assert(columns.includes('scope_key'));
    assert(columns.includes('usage_class'));
    assert(columns.includes('visibility'));

    const indexNames = getIndexNames(db, 'user_memories');
    assert(indexNames.includes('idx_user_memories_scope_status_updated'));
    assert(indexNames.includes('idx_user_memories_scope_fingerprint'));
    assert(indexNames.includes('idx_user_memories_usage_visibility'));
  } finally {
    cleanup();
  }
});

test('legacy memory rows backfill to contact scope when source channel identifies a stable peer', async () => {
  const db = await createLegacyMemoryDb();
  const now = Date.now();

  db.run(`
    INSERT INTO cowork_sessions (
      id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode, active_skill_ids,
      metabot_id, session_type, peer_global_metaid, peer_name, peer_avatar, created_at, updated_at
    ) VALUES (?, ?, NULL, 'idle', 0, ?, '', 'local', '[]', ?, 'a2a', ?, NULL, NULL, ?, ?)
  `, ['session-1', 'Private chat', process.cwd(), 1, 'peer-123', now, now]);

  db.run(`
    INSERT INTO user_memories (
      id, metabot_id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `, ['memory-1', 1, 'The client prefers English', 'fp-1', 0.9, 1, 'created', now, now]);

  db.run(`
    INSERT INTO user_memory_sources (
      id, memory_id, metabot_id, session_id, source_channel, source_type, external_conversation_id, source_id,
      message_id, role, is_active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `, [
    'source-1',
    'memory-1',
    1,
    'session-1',
    'metaweb_private',
    'session_turn',
    'metaweb-private:peer-123',
    'msg-1',
    'msg-1',
    'user',
    now,
  ]);

  createCoworkStore(db);

  const migrated = getRow(db, `
    SELECT scope_kind, scope_key, usage_class, visibility
    FROM user_memories
    WHERE id = ?
  `, ['memory-1']);

  assert.equal(migrated?.scope_kind, 'contact');
  assert.equal(migrated?.scope_key, 'metaweb_private:peer:peer-123');
  assert.equal(migrated?.usage_class, 'preference');
  assert.equal(migrated?.visibility, 'local_only');
});

test('legacy cowork ui memories stay in owner scope even when a conversation mapping row exists', async () => {
  const db = await createLegacyMemoryDb();
  const now = Date.now();

  db.run(`
    INSERT INTO cowork_sessions (
      id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode, active_skill_ids,
      metabot_id, session_type, peer_global_metaid, peer_name, peer_avatar, created_at, updated_at
    ) VALUES (?, ?, NULL, 'idle', 0, ?, '', 'local', '[]', ?, 'standard', NULL, NULL, NULL, ?, ?)
  `, ['session-1', 'Owner session', process.cwd(), 1, now, now]);

  db.run(`
    INSERT INTO cowork_conversation_mappings (
      channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?)
  `, ['cowork_ui', 'session-1', 1, 'session-1', now, now]);

  db.run(`
    INSERT INTO user_memories (
      id, metabot_id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `, ['memory-2', 1, 'I prefer concise replies', 'fp-2', 0.8, 0, 'created', now, now]);

  db.run(`
    INSERT INTO user_memory_sources (
      id, memory_id, metabot_id, session_id, source_channel, source_type, external_conversation_id, source_id,
      message_id, role, is_active, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, 1, ?)
  `, ['source-2', 'memory-2', 1, 'session-1', 'session_turn', 'msg-2', 'user', now]);

  createCoworkStore(db);

  const migrated = getRow(db, `
    SELECT scope_kind, scope_key
    FROM user_memories
    WHERE id = ?
  `, ['memory-2']);

  assert.equal(migrated?.scope_kind, 'owner');
  assert.equal(migrated?.scope_key, 'owner:self');
});
