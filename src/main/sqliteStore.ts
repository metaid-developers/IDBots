import { app } from 'electron';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { DB_FILENAME } from './appConstants';
import { OWNER_SCOPE_KEY } from './memory/memoryScope';

type ChangePayload<T = unknown> = {
  key: string;
  newValue: T | undefined;
  oldValue: T | undefined;
};

const USER_MEMORIES_MIGRATION_KEY = 'userMemories.migration.v1.completed';

// Get the path to sql.js WASM file
function getWasmPath(): string {
  if (app.isPackaged) {
    // In production, the wasm file is in the unpacked resources
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm'
    );
  }
  // In development, use node_modules directly
  return path.join(app.getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm');
}

export class SqliteStore {
  private db: Database;
  private dbPath: string;
  private emitter = new EventEmitter();
  private static sqlPromise: Promise<SqlJsStatic> | null = null;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(userDataPath?: string): Promise<SqliteStore> {
    const basePath = userDataPath ?? app.getPath('userData');
    const dbPath = path.join(basePath, DB_FILENAME);

    // Initialize SQL.js with WASM file path (cached promise for reuse)
    if (!SqliteStore.sqlPromise) {
      const wasmPath = getWasmPath();
      SqliteStore.sqlPromise = initSqlJs({
        locateFile: () => wasmPath,
      });
    }
    const SQL = await SqliteStore.sqlPromise;

    // Load existing database or create new one
    let db: Database;
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    const store = new SqliteStore(db, dbPath);
    store.initializeTables(basePath);
    return store;
  }

  private initializeTables(basePath: string) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create cowork tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        execution_mode TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_id ON cowork_messages(session_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER REFERENCES metabots(id),
        text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.75,
        is_explicit INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'created',
        scope_kind TEXT NOT NULL DEFAULT 'owner',
        scope_key TEXT NOT NULL DEFAULT '${OWNER_SCOPE_KEY}',
        usage_class TEXT NOT NULL DEFAULT 'profile_fact',
        visibility TEXT NOT NULL DEFAULT 'local_only',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        metabot_id INTEGER,
        session_id TEXT,
        source_channel TEXT,
        source_type TEXT,
        external_conversation_id TEXT,
        source_id TEXT,
        message_id TEXT,
        role TEXT NOT NULL DEFAULT 'system',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES user_memories(id) ON DELETE CASCADE
      );
    `);

    let userMemorySourceColumns: string[] = [];
    try {
      const srcColsResult = this.db.exec("PRAGMA table_info(user_memory_sources);");
      userMemorySourceColumns = (srcColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
    } catch {
      userMemorySourceColumns = [];
    }

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memories_status_updated_at
      ON user_memories(status, updated_at DESC);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memories_fingerprint
      ON user_memories(fingerprint);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_session_id
      ON user_memory_sources(session_id, is_active);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_memory_id
      ON user_memory_sources(memory_id, is_active);
    `);
    if (userMemorySourceColumns.includes('source_channel') && userMemorySourceColumns.includes('external_conversation_id')) {
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_sources_channel_conversation
        ON user_memory_sources(source_channel, external_conversation_id, created_at DESC);
      `);
    }
    if (userMemorySourceColumns.includes('metabot_id')) {
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_sources_metabot
        ON user_memory_sources(metabot_id, created_at DESC);
      `);
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_memory_policies (
        metabot_id INTEGER PRIMARY KEY,
        memory_enabled INTEGER NOT NULL DEFAULT 1,
        memory_implicit_update_enabled INTEGER NOT NULL DEFAULT 1,
        memory_llm_judge_enabled INTEGER NOT NULL DEFAULT 1,
        memory_guard_level TEXT NOT NULL DEFAULT 'strict',
        memory_user_memories_max_items INTEGER NOT NULL DEFAULT 12,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (metabot_id) REFERENCES metabots(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_conversation_mappings (
        channel TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        metabot_id INTEGER NOT NULL DEFAULT 0,
        cowork_session_id TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (channel, external_conversation_id, metabot_id)
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cowork_conversation_mappings_session
      ON cowork_conversation_mappings(cowork_session_id);
    `);

    // Create scheduled tasks tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_json TEXT NOT NULL,
        prompt TEXT NOT NULL,
        working_directory TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        execution_mode TEXT NOT NULL DEFAULT 'auto',
        metabot_id INTEGER,
        expires_at TEXT,
        notify_platforms_json TEXT NOT NULL DEFAULT '[]',
        next_run_at_ms INTEGER,
        last_run_at_ms INTEGER,
        last_status TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        running_at_ms INTEGER,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
        ON scheduled_tasks(enabled, next_run_at_ms);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        trigger_type TEXT NOT NULL DEFAULT 'scheduled',
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id
        ON scheduled_task_runs(task_id, started_at DESC);
    `);

    // MetaWeb listener: group chat, private chat (SDD Task 11.5 - flattened + raw_data), protocol events
    // Do not DROP: preserve existing messages across restarts and when user stops listening
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin_id TEXT UNIQUE NOT NULL,
        tx_id TEXT,
        group_id TEXT NOT NULL,
        channel_id TEXT,
        sender_metaid TEXT NOT NULL,
        sender_global_metaid TEXT,
        sender_address TEXT,
        sender_name TEXT,
        sender_avatar TEXT,
        sender_chat_pubkey TEXT,
        protocol TEXT NOT NULL,
        content TEXT,
        content_type TEXT,
        encryption TEXT,
        reply_pin TEXT,
        mention TEXT,
        chain_timestamp INTEGER,
        chain TEXT,
        raw_data TEXT,
        is_processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS private_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin_id TEXT UNIQUE NOT NULL,
        tx_id TEXT,
        from_metaid TEXT NOT NULL,
        from_global_metaid TEXT,
        from_name TEXT,
        from_avatar TEXT,
        from_chat_pubkey TEXT,
        to_metaid TEXT NOT NULL,
        to_global_metaid TEXT,
        protocol TEXT NOT NULL,
        content TEXT,
        content_type TEXT,
        encryption TEXT,
        reply_pin TEXT,
        chain_timestamp INTEGER,
        chain TEXT,
        raw_data TEXT,
        is_processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS protocol_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin_id TEXT UNIQUE NOT NULL,
        txid TEXT NOT NULL,
        protocol_path TEXT NOT NULL,
        sender_metaid TEXT NOT NULL,
        target_metaid TEXT,
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        error_msg TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Cognitive Orchestrator: mission control for group chat (SDD Task 12.1)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_chat_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        metabot_id INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        reply_on_mention INTEGER NOT NULL DEFAULT 1,
        random_reply_probability REAL NOT NULL DEFAULT 0.1,
        cooldown_seconds INTEGER NOT NULL DEFAULT 15,
        context_message_count INTEGER NOT NULL DEFAULT 30,
        discussion_background TEXT,
        participation_goal TEXT,
        supervisor_metaid TEXT,
        supervisor_globalmetaid TEXT,
        allowed_skills TEXT,
        original_prompt TEXT,
        start_time TEXT DEFAULT (datetime('now')),
        last_replied_at TEXT,
        last_processed_msg_id INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.migrateGroupChatTasksSupervisorGlobalmetaid();

    // MetaID pins: full-field persistence from manapi.metaid.io
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metaid_pins (
        id TEXT PRIMARY KEY,
        number INTEGER,
        metaid TEXT,
        address TEXT,
        creator TEXT,
        createMetaId TEXT,
        globalMetaId TEXT,
        initialOwner TEXT,
        output TEXT,
        outputValue INTEGER,
        timestamp INTEGER,
        genesisFee INTEGER,
        genesisHeight INTEGER,
        genesisTransaction TEXT,
        txIndex INTEGER,
        txInIndex INTEGER,
        "offset" INTEGER,
        location TEXT,
        operation TEXT,
        path TEXT,
        parentPath TEXT,
        originalPath TEXT,
        encryption TEXT,
        version TEXT,
        contentType TEXT,
        contentTypeDetect TEXT,
        contentBody TEXT,
        contentLength INTEGER,
        contentSummary TEXT,
        originalContentBody TEXT,
        originalContentSummary TEXT,
        status INTEGER,
        originalId TEXT,
        isTransfered INTEGER,
        preview TEXT,
        content TEXT,
        pop TEXT,
        popLv INTEGER,
        popScore TEXT,
        popScoreV1 TEXT,
        chainName TEXT,
        dataValue INTEGER,
        mrc20MintId TEXT,
        host TEXT,
        blocked INTEGER,
        is_recommended INTEGER,
        modify_history TEXT
      );
    `);

    // Service Square: cache of remote skill-service API for offline-first list
    this.db.run(`
      CREATE TABLE IF NOT EXISTS remote_skill_service (
        id TEXT PRIMARY KEY,
        pin_id TEXT,
        metaid TEXT,
        global_metaid TEXT,
        address TEXT,
        create_address TEXT,
        service_name TEXT,
        display_name TEXT,
        description TEXT,
        price TEXT,
        currency TEXT,
        avatar TEXT,
        service_icon TEXT,
        provider_meta_bot TEXT,
        provider_skill TEXT,
        skill_document TEXT,
        input_type TEXT,
        output_type TEXT,
        endpoint TEXT,
        status INTEGER NOT NULL DEFAULT 0,
        operation TEXT,
        path TEXT,
        original_id TEXT,
        source_service_pin_id TEXT,
        available INTEGER NOT NULL DEFAULT 1,
        content_summary_json TEXT,
        payment_address TEXT,
        rating_count INTEGER NOT NULL DEFAULT 0,
        rating_avg REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS remote_skill_service_rating_seen (
        pin_id TEXT PRIMARY KEY,
        service_id TEXT,
        service_paid_tx TEXT,
        rate REAL,
        comment TEXT,
        rater_global_metaid TEXT,
        rater_metaid TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_remote_skill_service_rating_seen_service
      ON remote_skill_service_rating_seen(service_id);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_remote_skill_service_updated_at
        ON remote_skill_service(updated_at DESC);
    `);

    // Service order ledger (buyer/seller local runtime truth)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS service_orders (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
        local_metabot_id INTEGER NOT NULL,
        counterparty_global_metaid TEXT NOT NULL,
        service_pin_id TEXT,
        service_name TEXT NOT NULL,
        payment_txid TEXT NOT NULL,
        payment_chain TEXT NOT NULL CHECK (payment_chain IN ('mvc', 'btc', 'doge')),
        payment_amount TEXT NOT NULL,
        payment_currency TEXT NOT NULL CHECK (payment_currency IN ('SPACE', 'BTC', 'DOGE')),
        order_message_pin_id TEXT,
        cowork_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('awaiting_first_response', 'in_progress', 'completed', 'failed', 'refund_pending', 'refunded')),
        first_response_deadline_at INTEGER NOT NULL,
        delivery_deadline_at INTEGER NOT NULL,
        first_response_at INTEGER,
        delivery_message_pin_id TEXT,
        delivered_at INTEGER,
        failed_at INTEGER,
        failure_reason TEXT,
        refund_request_pin_id TEXT,
        refund_finalize_pin_id TEXT,
        refund_txid TEXT,
        refund_requested_at INTEGER,
        refund_completed_at INTEGER,
        refund_apply_retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_service_orders_status_updated_at
      ON service_orders(status, updated_at DESC);
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_chain = lower(trim(payment_chain))
      WHERE payment_chain IS NOT NULL;
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_chain = 'mvc'
      WHERE payment_chain NOT IN ('mvc', 'btc', 'doge');
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_currency = upper(trim(payment_currency))
      WHERE payment_currency IS NOT NULL;
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_currency = CASE
        WHEN payment_chain = 'btc' THEN 'BTC'
        WHEN payment_chain = 'doge' THEN 'DOGE'
        ELSE 'SPACE'
      END
      WHERE payment_currency NOT IN ('SPACE', 'BTC', 'DOGE')
         OR (payment_chain = 'mvc' AND payment_currency = 'MVC');
    `);
    this.db.run(`
      WITH ranked AS (
        SELECT
          rowid,
          ROW_NUMBER() OVER (
            PARTITION BY local_metabot_id, role, payment_txid
            ORDER BY updated_at DESC, created_at DESC, id DESC
          ) AS rank_in_group
        FROM service_orders
      )
      DELETE FROM service_orders
      WHERE rowid IN (
        SELECT rowid FROM ranked WHERE rank_in_group > 1
      );
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_dedupe_payment
      ON service_orders(local_metabot_id, role, payment_txid);
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_role_insert
      BEFORE INSERT ON service_orders
      WHEN NEW.role NOT IN ('buyer', 'seller')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.role');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_role_update
      BEFORE UPDATE OF role ON service_orders
      WHEN NEW.role NOT IN ('buyer', 'seller')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.role');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_status_insert
      BEFORE INSERT ON service_orders
      WHEN NEW.status NOT IN ('awaiting_first_response', 'in_progress', 'completed', 'failed', 'refund_pending', 'refunded')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.status');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_chain_insert
      BEFORE INSERT ON service_orders
      WHEN NEW.payment_chain NOT IN ('mvc', 'btc', 'doge')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_chain');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_chain_update
      BEFORE UPDATE OF payment_chain ON service_orders
      WHEN NEW.payment_chain NOT IN ('mvc', 'btc', 'doge')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_chain');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_currency_insert
      BEFORE INSERT ON service_orders
      WHEN NEW.payment_currency NOT IN ('SPACE', 'BTC', 'DOGE')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_currency');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_currency_update
      BEFORE UPDATE OF payment_currency ON service_orders
      WHEN NEW.payment_currency NOT IN ('SPACE', 'BTC', 'DOGE')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_currency');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_status_update
      BEFORE UPDATE OF status ON service_orders
      WHEN NEW.status NOT IN ('awaiting_first_response', 'in_progress', 'completed', 'failed', 'refund_pending', 'refunded')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.status');
      END;
    `);

    // MetaBot multi-agent architecture tables
    // Order: metabot_wallets first (wallet exists before metabot), then metabots with wallet_id FK.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mnemonic TEXT UNIQUE NOT NULL,
        path TEXT NOT NULL DEFAULT "m/44'/10001'/0'/0/0",
        created_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS prevent_metabot_wallets_update
      BEFORE UPDATE ON metabot_wallets
      BEGIN
        SELECT RAISE(ABORT, 'Security Error: metabot_wallets table is append-only. Updates are strictly prohibited.');
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS prevent_metabot_wallets_delete
      BEFORE DELETE ON metabot_wallets
      BEGIN
        SELECT RAISE(ABORT, 'Security Error: metabot_wallets table is append-only. Deletions are strictly prohibited.');
      END;
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL,
        mvc_address TEXT UNIQUE NOT NULL,
        btc_address TEXT UNIQUE NOT NULL,
        doge_address TEXT UNIQUE NOT NULL,
        public_key TEXT UNIQUE NOT NULL,
        chat_public_key TEXT UNIQUE NOT NULL,
        chat_public_key_pin_id TEXT,
        name TEXT UNIQUE NOT NULL,
        avatar BLOB,
        enabled INTEGER NOT NULL DEFAULT 1,
        metaid TEXT UNIQUE NOT NULL,
        globalmetaid TEXT UNIQUE,
        metabot_info_pinid TEXT,
        metabot_type TEXT CHECK(metabot_type IN ('twin', 'worker')) NOT NULL,
        created_by TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        goal TEXT,
        background TEXT,
        boss_id INTEGER,
        llm_id TEXT,
        tools TEXT DEFAULT '[]',
        skills TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (wallet_id) REFERENCES metabot_wallets(id) ON DELETE RESTRICT,
        FOREIGN KEY (boss_id) REFERENCES metabots(id)
      );
    `);

    // Migration: existing DBs with old schema (metabot_wallets.metabot_id, metabots without wallet_id, avatar TEXT)
    this.migrateMetabotWalletRelationAndAvatar(basePath);

    // Migration: make metabot_info_pinid optional (nullable, no UNIQUE) for new MetaBots without on-chain info pin
    this.migrateMetabotInfoPinidOptional();
    // Migration: make chat_public_key_pin_id optional (same pattern - placeholder before on-chain push)
    this.migrateChatPublicKeyPinIdOptional();

    // Migrations - safely add columns if they don't exist
    try {
      // Check if execution_mode column exists
      const colsResult = this.db.exec("PRAGMA table_info(cowork_sessions);");
      const columns = colsResult[0]?.values.map((row) => row[1]) || [];

      if (!columns.includes('execution_mode')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN execution_mode TEXT;');
        this.save();
      }

      if (!columns.includes('pinned')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
        this.save();
      }

      if (!columns.includes('active_skill_ids')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN active_skill_ids TEXT;');
        this.save();
      }

      if (!columns.includes('metabot_id')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN metabot_id INTEGER;');
        this.save();
      }

      // Migration: Add sequence column to cowork_messages
      const msgColsResult = this.db.exec("PRAGMA table_info(cowork_messages);");
      const msgColumns = msgColsResult[0]?.values.map((row) => row[1]) || [];

      if (!msgColumns.includes('sequence')) {
        this.db.run('ALTER TABLE cowork_messages ADD COLUMN sequence INTEGER');

        // 为现有消息按 created_at 和 ROWID 分配序列号
        this.db.run(`
          WITH numbered AS (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY session_id
              ORDER BY created_at ASC, ROWID ASC
            ) as seq
            FROM cowork_messages
          )
          UPDATE cowork_messages
          SET sequence = (SELECT seq FROM numbered WHERE numbered.id = cowork_messages.id)
        `);

        this.save();
      }
    } catch {
      // Column already exists or migration not needed.
    }

    try {
      this.db.run('UPDATE cowork_sessions SET pinned = 0 WHERE pinned IS NULL;');
    } catch {
      // Column might not exist yet.
    }

    try {
      this.db.run(`UPDATE cowork_sessions SET execution_mode = 'sandbox' WHERE execution_mode = 'container';`);
      this.db.run(`
        UPDATE cowork_config
        SET value = 'sandbox'
        WHERE key = 'executionMode' AND value = 'container';
      `);
    } catch (error) {
      console.warn('Failed to migrate cowork execution mode:', error);
    }

    // Migration: Add metabot_id to user_memories for MetaBot memory isolation
    try {
      const umColsResult = this.db.exec("PRAGMA table_info(user_memories);");
      const umColumns = (umColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!umColumns.includes('metabot_id')) {
        this.db.run('ALTER TABLE user_memories ADD COLUMN metabot_id INTEGER REFERENCES metabots(id);');
        const twinRow = this.db.exec("SELECT id FROM metabots WHERE metabot_type = 'twin' ORDER BY id ASC LIMIT 1");
        const twinId = twinRow[0]?.values?.[0]?.[0] as number | undefined;
        if (twinId != null) {
          this.db.run('UPDATE user_memories SET metabot_id = ? WHERE metabot_id IS NULL', [twinId]);
        }
        this.save();
      }
      if (!umColumns.includes('scope_kind')) {
        this.db.run("ALTER TABLE user_memories ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'owner';");
      }
      if (!umColumns.includes('scope_key')) {
        this.db.run(`ALTER TABLE user_memories ADD COLUMN scope_key TEXT NOT NULL DEFAULT '${OWNER_SCOPE_KEY}';`);
      }
      if (!umColumns.includes('usage_class')) {
        this.db.run("ALTER TABLE user_memories ADD COLUMN usage_class TEXT NOT NULL DEFAULT 'profile_fact';");
      }
      if (!umColumns.includes('visibility')) {
        this.db.run("ALTER TABLE user_memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'local_only';");
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memories_scope_status_updated
        ON user_memories(metabot_id, scope_kind, scope_key, status, updated_at DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memories_scope_fingerprint
        ON user_memories(metabot_id, scope_kind, scope_key, fingerprint)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memories_usage_visibility
        ON user_memories(metabot_id, usage_class, visibility, status, updated_at DESC)
      `);
    } catch (error) {
      console.warn('Failed to migrate user_memories metabot_id:', error);
    }

    // Migration: Ensure user_memory_sources has standardized source fields.
    try {
      const srcColsResult = this.db.exec("PRAGMA table_info(user_memory_sources);");
      const srcColumns = (srcColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!srcColumns.includes('metabot_id')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN metabot_id INTEGER');
      }
      if (!srcColumns.includes('source_channel')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN source_channel TEXT');
      }
      if (!srcColumns.includes('source_type')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN source_type TEXT');
      }
      if (!srcColumns.includes('external_conversation_id')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN external_conversation_id TEXT');
      }
      if (!srcColumns.includes('source_id')) {
        this.db.run('ALTER TABLE user_memory_sources ADD COLUMN source_id TEXT');
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_sources_channel_conversation
        ON user_memory_sources(source_channel, external_conversation_id, created_at DESC)
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_user_memory_sources_metabot
        ON user_memory_sources(metabot_id, created_at DESC)
      `);
      this.save();
    } catch (error) {
      console.warn('Failed to migrate user_memory_sources source fields:', error);
    }

    // Migration: Add expires_at, notify_platforms_json, and metabot_id columns to scheduled_tasks
    try {
      const stColsResult = this.db.exec("PRAGMA table_info(scheduled_tasks);");
      if (stColsResult[0]) {
        const stColumns = stColsResult[0].values.map((row) => row[1]) || [];

        if (!stColumns.includes('expires_at')) {
          this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN expires_at TEXT');
          this.save();
        }

        if (!stColumns.includes('notify_platforms_json')) {
          this.db.run("ALTER TABLE scheduled_tasks ADD COLUMN notify_platforms_json TEXT NOT NULL DEFAULT '[]'");
          this.save();
        }

        if (!stColumns.includes('metabot_id')) {
          this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN metabot_id INTEGER');
          this.save();
        }
      }
    } catch {
      // Migration not needed or table doesn't exist yet.
    }

    this.migrateLegacyMemoryFileToUserMemories();
    this.migrateFromElectronStore(basePath);

    // Migration: Add boss_global_metaid column to metabots
    try {
      const mbColsResult = this.db.exec('PRAGMA table_info(metabots)');
      const mbColumns = (mbColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!mbColumns.includes('boss_global_metaid')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN boss_global_metaid TEXT');
        this.save();
      }
    } catch (error) {
      console.warn('Failed to migrate metabots boss_global_metaid:', error);
    }

    // Migration: Add payment_address column to remote_skill_service
    try {
      const rssColsResult = this.db.exec('PRAGMA table_info(remote_skill_service)');
      const rssColumns = (rssColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!rssColumns.includes('pin_id')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN pin_id TEXT');
        this.save();
      }
      if (!rssColumns.includes('create_address')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN create_address TEXT');
        this.save();
      }
      if (!rssColumns.includes('payment_address')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN payment_address TEXT');
        this.save();
      }
      if (!rssColumns.includes('status')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN status INTEGER NOT NULL DEFAULT 0');
        this.save();
      }
      if (!rssColumns.includes('operation')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN operation TEXT');
        this.save();
      }
      if (!rssColumns.includes('path')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN path TEXT');
        this.save();
      }
      if (!rssColumns.includes('original_id')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN original_id TEXT');
        this.save();
      }
      if (!rssColumns.includes('source_service_pin_id')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN source_service_pin_id TEXT');
        this.save();
      }
      if (!rssColumns.includes('available')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN available INTEGER NOT NULL DEFAULT 1');
        this.save();
      }
      // Migration: Add rating columns to remote_skill_service
      if (!rssColumns.includes('rating_count')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0');
        this.save();
      }
      if (!rssColumns.includes('rating_avg')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN rating_avg REAL NOT NULL DEFAULT 0');
        this.save();
      }
      this.db.run(`
        UPDATE remote_skill_service
        SET pin_id = COALESCE(NULLIF(TRIM(pin_id), ''), id)
        WHERE pin_id IS NULL OR TRIM(pin_id) = ''
      `);
      this.db.run(`
        UPDATE remote_skill_service
        SET source_service_pin_id = COALESCE(
          NULLIF(TRIM(source_service_pin_id), ''),
          NULLIF(TRIM(original_id), ''),
          CASE
            WHEN path IS NOT NULL AND TRIM(path) <> '' AND substr(TRIM(path), 1, 1) = '@'
              THEN substr(TRIM(path), 2)
            ELSE pin_id
          END
        )
        WHERE source_service_pin_id IS NULL OR TRIM(source_service_pin_id) = ''
      `);
      this.db.run(`
        UPDATE remote_skill_service
        SET create_address = COALESCE(NULLIF(TRIM(create_address), ''), address)
        WHERE create_address IS NULL OR TRIM(create_address) = ''
      `);
      this.db.run(`
        UPDATE remote_skill_service
        SET available = CASE WHEN status < 0 THEN 0 ELSE 1 END
      `);
      this.save();
    } catch (error) {
      console.warn('Failed to migrate remote_skill_service payment_address:', error);
    }

    try {
      const ratingSeenColsResult = this.db.exec('PRAGMA table_info(remote_skill_service_rating_seen)');
      const ratingSeenColumns = (ratingSeenColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!ratingSeenColumns.includes('service_paid_tx')) {
        this.db.run('ALTER TABLE remote_skill_service_rating_seen ADD COLUMN service_paid_tx TEXT');
        this.save();
      }
      if (!ratingSeenColumns.includes('comment')) {
        this.db.run('ALTER TABLE remote_skill_service_rating_seen ADD COLUMN comment TEXT');
        this.save();
      }
      if (!ratingSeenColumns.includes('rater_global_metaid')) {
        this.db.run('ALTER TABLE remote_skill_service_rating_seen ADD COLUMN rater_global_metaid TEXT');
        this.save();
      }
      if (!ratingSeenColumns.includes('rater_metaid')) {
        this.db.run('ALTER TABLE remote_skill_service_rating_seen ADD COLUMN rater_metaid TEXT');
        this.save();
      }
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_remote_skill_service_rating_paid_tx
          ON remote_skill_service_rating_seen(service_paid_tx)
      `);
      this.save();
    } catch (error) {
      console.warn('Failed to migrate remote_skill_service_rating_seen detail columns:', error);
    }

    // Migration: Add heartbeat_enabled column to metabots
    try {
      const hbColsResult = this.db.exec('PRAGMA table_info(metabots)');
      const hbColumns = (hbColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!hbColumns.includes('heartbeat_enabled')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN heartbeat_enabled INTEGER DEFAULT 0');
        this.save();
      }
    } catch (error) {
      console.warn('Failed to migrate metabots heartbeat_enabled:', error);
    }

    this.save();
  }

  /**
   * Migration: (1) Make metabot_wallets the parent: remove metabot_id, add metabots.wallet_id.
   * (2) Add avatar_blob BLOB and copy from avatar TEXT so avatar aligns with on-chain binary.
   */
  /**
   * Migration: Add supervisor_globalmetaid to group_chat_tasks (unified user identity by globalmetaid).
   * Copies supervisor_metaid into supervisor_globalmetaid for existing rows.
   */
  private migrateGroupChatTasksSupervisorGlobalmetaid(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_chat_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('supervisor_globalmetaid')) return;
      this.db.run('ALTER TABLE group_chat_tasks ADD COLUMN supervisor_globalmetaid TEXT');
      this.db.run(
        'UPDATE group_chat_tasks SET supervisor_globalmetaid = supervisor_metaid WHERE supervisor_metaid IS NOT NULL'
      );
      this.save();
    } catch (e) {
      console.warn('migrateGroupChatTasksSupervisorGlobalmetaid:', e);
    }
  }

  private migrateMetabotWalletRelationAndAvatar(_basePath: string): void {
    try {
      const walletCols = this.db.exec("PRAGMA table_info(metabot_wallets);");
      const walletColumnNames = (walletCols[0]?.values.map((row) => row[1]) || []) as string[];
      const hasOldWalletSchema = walletColumnNames.includes('metabot_id');

      if (hasOldWalletSchema) {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS metabot_wallets_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mnemonic TEXT UNIQUE NOT NULL,
            path TEXT NOT NULL DEFAULT "m/44'/10001'/0'/0/0",
            created_at INTEGER NOT NULL
          );
        `);
        this.db.run(`
          INSERT INTO metabot_wallets_new (mnemonic, path, created_at)
          SELECT mnemonic, path, created_at FROM metabot_wallets;
        `);

        const metabotCols = this.db.exec("PRAGMA table_info(metabots);");
        const metabotColumnNames = (metabotCols[0]?.values.map((row) => row[1]) || []) as string[];
        if (!metabotColumnNames.includes('wallet_id')) {
          this.db.run('ALTER TABLE metabots ADD COLUMN wallet_id INTEGER;');
          this.db.run(`
            UPDATE metabots SET wallet_id = (
              SELECT n.id FROM metabot_wallets_new n
              INNER JOIN metabot_wallets o ON o.mnemonic = n.mnemonic AND o.path = n.path AND o.created_at = n.created_at
              WHERE o.metabot_id = metabots.id
              LIMIT 1
            );
          `);
        }

        this.db.run('DROP TRIGGER IF EXISTS prevent_metabot_wallets_update;');
        this.db.run('DROP TRIGGER IF EXISTS prevent_metabot_wallets_delete;');
        this.db.run('DROP TABLE metabot_wallets;');
        this.db.run('ALTER TABLE metabot_wallets_new RENAME TO metabot_wallets;');
        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS prevent_metabot_wallets_update
          BEFORE UPDATE ON metabot_wallets
          BEGIN
            SELECT RAISE(ABORT, 'Security Error: metabot_wallets table is append-only. Updates are strictly prohibited.');
          END;
        `);
        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS prevent_metabot_wallets_delete
          BEFORE DELETE ON metabot_wallets
          BEGIN
            SELECT RAISE(ABORT, 'Security Error: metabot_wallets table is append-only. Deletions are strictly prohibited.');
          END;
        `);
        this.save();
      }

      const metabotCols2 = this.db.exec("PRAGMA table_info(metabots);");
      const rows2 = metabotCols2[0]?.values || [];
      const metabotColumns2 = rows2.map((row) => row[1]) as string[];
      const avatarRow = rows2.find((r) => r[1] === 'avatar');
      const avatarType = (avatarRow?.[2] as string)?.toLowerCase() || '';
      const isLegacyAvatarText = avatarType === 'text';
      if (metabotColumns2.includes('avatar') && isLegacyAvatarText && !metabotColumns2.includes('avatar_blob')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN avatar_blob BLOB;');
        this.db.run('UPDATE metabots SET avatar_blob = CAST(avatar AS BLOB) WHERE avatar IS NOT NULL;');
        this.save();
      }
    } catch (e) {
      console.warn('migrateMetabotWalletRelationAndAvatar:', e);
    }
  }

  /**
   * Migration: Recreate metabots with metabot_info_pinid optional (nullable, no UNIQUE)
   * so multiple MetaBots can be created without on-chain info pin.
   */
  private migrateMetabotInfoPinidOptional(): void {
    try {
      const migrated = this.get<boolean>('metabot_info_pinid_optional_migrated');
      if (migrated) return;

      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('metabot_info_pinid')) return;

      const hasAvatarBlob = columns.includes('avatar_blob');
      this.db.run('PRAGMA foreign_keys = OFF');
      this.db.run(`CREATE TABLE IF NOT EXISTS metabots_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL,
        mvc_address TEXT UNIQUE NOT NULL,
        btc_address TEXT UNIQUE NOT NULL,
        doge_address TEXT UNIQUE NOT NULL,
        public_key TEXT UNIQUE NOT NULL,
        chat_public_key TEXT UNIQUE NOT NULL,
        chat_public_key_pin_id TEXT,
        name TEXT UNIQUE NOT NULL,
        avatar BLOB,
        enabled INTEGER NOT NULL DEFAULT 1,
        metaid TEXT UNIQUE NOT NULL,
        globalmetaid TEXT UNIQUE,
        metabot_info_pinid TEXT,
        metabot_type TEXT CHECK(metabot_type IN ('twin', 'worker')) NOT NULL,
        created_by TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        goal TEXT,
        background TEXT,
        boss_id INTEGER,
        llm_id TEXT,
        tools TEXT DEFAULT '[]',
        skills TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL${hasAvatarBlob ? ', avatar_blob BLOB' : ''},
        FOREIGN KEY (wallet_id) REFERENCES metabot_wallets(id) ON DELETE RESTRICT,
        FOREIGN KEY (boss_id) REFERENCES metabots_new(id)
      )`);

      const colList = columns.join(', ');
      this.db.run(`INSERT INTO metabots_new (${colList}) SELECT ${colList} FROM metabots`);
      this.db.run('DROP TABLE metabots');
      this.db.run('ALTER TABLE metabots_new RENAME TO metabots');
      this.set('metabot_info_pinid_optional_migrated', true);
      this.db.run('PRAGMA foreign_keys = ON');
    } catch (e) {
      console.warn('migrateMetabotInfoPinidOptional:', e);
      this.db.run('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * Migration: Recreate metabots with chat_public_key_pin_id optional (nullable, no UNIQUE)
   * for users who already ran migrateMetabotInfoPinidOptional before that column was relaxed.
   */
  private migrateChatPublicKeyPinIdOptional(): void {
    try {
      const migrated = this.get<boolean>('chat_public_key_pin_id_optional_migrated');
      if (migrated) return;

      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('chat_public_key_pin_id')) return;

      const hasAvatarBlob = columns.includes('avatar_blob');
      this.db.run('PRAGMA foreign_keys = OFF');
      this.db.run(`CREATE TABLE IF NOT EXISTS metabots_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL,
        mvc_address TEXT UNIQUE NOT NULL,
        btc_address TEXT UNIQUE NOT NULL,
        doge_address TEXT UNIQUE NOT NULL,
        public_key TEXT UNIQUE NOT NULL,
        chat_public_key TEXT UNIQUE NOT NULL,
        chat_public_key_pin_id TEXT,
        name TEXT UNIQUE NOT NULL,
        avatar BLOB,
        enabled INTEGER NOT NULL DEFAULT 1,
        metaid TEXT UNIQUE NOT NULL,
        globalmetaid TEXT UNIQUE,
        metabot_info_pinid TEXT,
        metabot_type TEXT CHECK(metabot_type IN ('twin', 'worker')) NOT NULL,
        created_by TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        goal TEXT,
        background TEXT,
        boss_id INTEGER,
        llm_id TEXT,
        tools TEXT DEFAULT '[]',
        skills TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL${hasAvatarBlob ? ', avatar_blob BLOB' : ''},
        FOREIGN KEY (wallet_id) REFERENCES metabot_wallets(id) ON DELETE RESTRICT,
        FOREIGN KEY (boss_id) REFERENCES metabots_new(id)
      )`);

      const colList = columns.join(', ');
      this.db.run(`INSERT INTO metabots_new (${colList}) SELECT ${colList} FROM metabots`);
      this.db.run('DROP TABLE metabots');
      this.db.run('ALTER TABLE metabots_new RENAME TO metabots');
      this.set('chat_public_key_pin_id_optional_migrated', true);
      this.db.run('PRAGMA foreign_keys = ON');
    } catch (e) {
      console.warn('migrateChatPublicKeyPinIdOptional:', e);
      this.db.run('PRAGMA foreign_keys = ON');
    }
  }

  save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  onDidChange<T = unknown>(key: string, callback: (newValue: T | undefined, oldValue: T | undefined) => void) {
    const handler = (payload: ChangePayload<T>) => {
      if (payload.key !== key) return;
      callback(payload.newValue, payload.oldValue);
    };
    this.emitter.on('change', handler);
    return () => this.emitter.off('change', handler);
  }

  get<T = unknown>(key: string): T | undefined {
    const result = this.db.exec('SELECT value FROM kv WHERE key = ?', [key]);
    if (!result[0]?.values[0]) return undefined;
    const value = result[0].values[0][0] as string;
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.warn(`Failed to parse store value for ${key}`, error);
      return undefined;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    const oldValue = this.get<T>(key);
    const now = Date.now();
    this.db.run(`
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [key, JSON.stringify(value), now]);
    this.save();
    this.emitter.emit('change', { key, newValue: value, oldValue } as ChangePayload<T>);
  }

  delete(key: string): void {
    const oldValue = this.get(key);
    this.db.run('DELETE FROM kv WHERE key = ?', [key]);
    this.save();
    this.emitter.emit('change', { key, newValue: undefined, oldValue } as ChangePayload);
  }

  // Expose database for cowork operations
  getDatabase(): Database {
    return this.db;
  }

  // Expose save method for external use (e.g., CoworkStore)
  getSaveFunction(): () => void {
    return () => this.save();
  }

  private tryReadLegacyMemoryText(): string {
    // Prefer app-bound paths so behavior is consistent when started from different directories or packaged.
    const candidates = [
      path.join(app.getAppPath(), 'MEMORY.md'),
      path.join(app.getPath('userData'), 'MEMORY.md'),
      path.join(app.getAppPath(), 'memory.md'),
      path.join(app.getPath('userData'), 'memory.md'),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return fs.readFileSync(candidate, 'utf8');
        }
      } catch {
        // Skip unreadable candidates.
      }
    }
    return '';
  }

  private parseLegacyMemoryEntries(raw: string): string[] {
    const normalized = raw.replace(/```[\s\S]*?```/g, ' ');
    const lines = normalized.split(/\r?\n/);
    const entries: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const match = line.trim().match(/^-+\s*(?:\[[^\]]+\]\s*)?(.+)$/);
      if (!match?.[1]) continue;
      const text = match[1].replace(/\s+/g, ' ').trim();
      if (!text || text.length < 6) continue;
      if (/^\(empty\)$/i.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(text.length > 360 ? `${text.slice(0, 359)}…` : text);
    }

    return entries.slice(0, 200);
  }

  private memoryFingerprint(text: string): string {
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return crypto.createHash('sha1').update(normalized).digest('hex');
  }

  private migrateLegacyMemoryFileToUserMemories(): void {
    if (this.get<string>(USER_MEMORIES_MIGRATION_KEY) === '1') {
      return;
    }

    const content = this.tryReadLegacyMemoryText();
    if (!content.trim()) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const entries = this.parseLegacyMemoryEntries(content);
    if (entries.length === 0) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const twinResult = this.db.exec("SELECT id FROM metabots WHERE metabot_type = 'twin' ORDER BY id ASC LIMIT 1");
    const defaultMetabotId = twinResult[0]?.values?.[0]?.[0] as number | undefined;
    if (defaultMetabotId == null) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const now = Date.now();
    this.db.run('BEGIN TRANSACTION;');
    try {
      for (const text of entries) {
        const fingerprint = this.memoryFingerprint(text);
        const existing = this.db.exec(
          `
            SELECT id
            FROM user_memories
            WHERE metabot_id = ?
              AND scope_kind = 'owner'
              AND scope_key = ?
              AND fingerprint = ?
              AND status != 'deleted'
            LIMIT 1
          `,
          [defaultMetabotId, OWNER_SCOPE_KEY, fingerprint]
        );
        if (existing[0]?.values?.[0]?.[0]) {
          continue;
        }

        const memoryId = crypto.randomUUID();
        this.db.run(`
          INSERT INTO user_memories (
            id, metabot_id, text, fingerprint, confidence, is_explicit, status,
            scope_kind, scope_key, usage_class, visibility, created_at, updated_at, last_used_at
          )
          VALUES (?, ?, ?, ?, ?, 1, 'created', 'owner', ?, 'profile_fact', 'local_only', ?, ?, NULL)
        `, [memoryId, defaultMetabotId, text, fingerprint, 0.9, OWNER_SCOPE_KEY, now, now]);

        this.db.run(`
          INSERT INTO user_memory_sources (id, memory_id, session_id, message_id, role, is_active, created_at)
          VALUES (?, ?, NULL, NULL, 'system', 1, ?)
        `, [crypto.randomUUID(), memoryId, now]);
      }

      this.db.run('COMMIT;');
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
    } catch (error) {
      this.db.run('ROLLBACK;');
      console.warn('Failed to migrate legacy MEMORY.md entries:', error);
      return;
    }
  }

  getP2PConfig(): Record<string, unknown> | undefined {
    const raw = this.get<string>('p2p_config');
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  }

  setP2PConfig(config: Record<string, unknown>): void {
    this.set('p2p_config', JSON.stringify(config));
  }

  private migrateFromElectronStore(userDataPath: string) {
    const result = this.db.exec('SELECT COUNT(*) as count FROM kv');
    const count = result[0]?.values[0]?.[0] as number;
    if (count > 0) return;

    const legacyPath = path.join(userDataPath, 'config.json');
    if (!fs.existsSync(legacyPath)) return;

    try {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (!data || typeof data !== 'object') return;

      const entries = Object.entries(data);
      if (!entries.length) return;

      const now = Date.now();
      this.db.run('BEGIN TRANSACTION;');
      try {
        entries.forEach(([key, value]) => {
          this.db.run(`
            INSERT INTO kv (key, value, updated_at)
            VALUES (?, ?, ?)
          `, [key, JSON.stringify(value), now]);
        });
        this.db.run('COMMIT;');
        this.save();
        console.info(`Migrated ${entries.length} entries from electron-store.`);
      } catch (error) {
        this.db.run('ROLLBACK;');
        throw error;
      }
    } catch (error) {
      console.warn('Failed to migrate electron-store data:', error);
    }
  }
}
