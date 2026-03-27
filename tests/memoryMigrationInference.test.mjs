import fs from 'node:fs';
import path from 'node:path';
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

test('scoped backfill preserves rows that already carry non-default scope metadata', async () => {
  const db = await createLegacyMemoryDb();
  const now = Date.now();

  db.run("ALTER TABLE user_memories ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'owner'");
  db.run("ALTER TABLE user_memories ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'owner:self'");
  db.run("ALTER TABLE user_memories ADD COLUMN usage_class TEXT NOT NULL DEFAULT 'profile_fact'");
  db.run("ALTER TABLE user_memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'local_only'");

  db.run(`
    INSERT INTO cowork_sessions (
      id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode, active_skill_ids,
      metabot_id, session_type, peer_global_metaid, peer_name, peer_avatar, created_at, updated_at
    ) VALUES (?, ?, NULL, 'idle', 0, ?, '', 'local', '[]', ?, 'a2a', ?, NULL, NULL, ?, ?)
  `, ['session-3', 'Private chat', process.cwd(), 1, 'peer-999', now, now]);

  db.run(`
    INSERT INTO user_memories (
      id, metabot_id, text, fingerprint, confidence, is_explicit, status,
      scope_kind, scope_key, usage_class, visibility, created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `, [
    'memory-3',
    1,
    'Keep this conversation scoped',
    'fp-3',
    0.7,
    0,
    'created',
    'conversation',
    'metaweb_order:conversation:already-scoped',
    'operational_preference',
    'external_safe',
    now,
    now,
  ]);

  db.run(`
    INSERT INTO user_memory_sources (
      id, memory_id, metabot_id, session_id, source_channel, source_type, external_conversation_id, source_id,
      message_id, role, is_active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `, [
    'source-3',
    'memory-3',
    1,
    'session-3',
    'metaweb_private',
    'session_turn',
    'metaweb-private:peer-999',
    'msg-3',
    'msg-3',
    'user',
    now,
  ]);

  createCoworkStore(db);

  const migrated = getRow(db, `
    SELECT scope_kind, scope_key, usage_class, visibility
    FROM user_memories
    WHERE id = ?
  `, ['memory-3']);

  assert.equal(migrated?.scope_kind, 'conversation');
  assert.equal(migrated?.scope_key, 'metaweb_order:conversation:already-scoped');
  assert.equal(migrated?.usage_class, 'operational_preference');
  assert.equal(migrated?.visibility, 'external_safe');
});

test('legacy MEMORY.md migration only marks completion after a successful import', async () => {
  const { db, store, userDataPath, cleanup } = await createSqliteStore();
  const now = Date.now();

  try {
    fs.writeFileSync(path.join(userDataPath, 'MEMORY.md'), '- remember this fact\n');

    db.run(`
      INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
      VALUES (?, ?, ?, ?)
    `, [1, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', "m/44'/10001'/0'/0/0", now]);

    db.run(`
      INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, chat_public_key_pin_id,
        name, avatar, enabled, metaid, globalmetaid, metabot_info_pinid, metabot_type, created_by, role, soul,
        goal, background, boss_id, llm_id, tools, skills, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 1, ?, NULL, NULL, 'twin', ?, ?, ?, NULL, NULL, NULL, NULL, '[]', '[]', ?, ?)
    `, [
      1,
      1,
      'mvc-1',
      'btc-1',
      'doge-1',
      'pub-1',
      'chat-pub-1',
      'Twin Bot',
      'metaid-1',
      'user',
      'assistant',
      'helpful soul',
      now,
      now,
    ]);

    store.delete('userMemories.migration.v1.completed');
    db.run('DROP TABLE user_memory_sources');

    store.migrateLegacyMemoryFileToUserMemories();

    assert.equal(store.get('userMemories.migration.v1.completed'), undefined);
  } finally {
    cleanup();
  }
});
