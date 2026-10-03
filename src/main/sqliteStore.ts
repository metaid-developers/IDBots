import { app } from 'electron';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import initSqlJs, { SqlJsStatic } from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { DB_FILENAME } from './appConstants';
import { truncateUtf16Units } from './libs/llmSafeText';
import { OWNER_SCOPE_KEY } from './memory/memoryScope';
import { findNearestExistingFile } from './libs/runtimePaths';
import { writeFileAtomicSync } from './libs/atomicFile';
import { createNativeSqliteDatabase } from './nativeSqliteDatabase';
import type { SqliteDatabase } from './sqliteTypes';
import { disableDeadFetchMcpServers } from './mcpStore';
import { ensureMetaIDExperienceSchema } from './metaidExperienceStore';
import { ensureMetaIDImpressionSchema } from './metaidImpressionStore';
import { ensureMetaIDMemoryGrantSchema } from './metaidMemoryGrantStore';
import { ensureMetaIDKnowledgeSchema } from './metaidKnowledgeStore';
import { ensureKnowledgeBaseSchema } from './knowledgeBaseStore';
import { ensureMetawebStudyJobSchema } from './metawebStudyJobStore';
import { ensureMetawebSurfSchema } from './metawebSurfStore';
import { ensureChainContentHistorySchema } from './chainContentHistoryStore';
import { ensureBotWalletTransferSchema } from './services/botWalletTransferStore';

type ChangePayload<T = unknown> = {
  key: string;
  newValue: T | undefined;
  oldValue: T | undefined;
};

const USER_MEMORIES_MIGRATION_KEY = 'userMemories.migration.v1.completed';
const METABOT_TWIN_BACKFILL_MIGRATION_KEY = 'metabot_twin_backfill_migrated';
const METABOT_WELCOME_TYPE_MIGRATION_KEY = 'metabot_welcome_type_migrated';

/**
 * Columns written explicitly by the metabots rebuild migrations
 * (migrateMetabotInfoPinidOptional / migrateChatPublicKeyPinIdOptional /
 * migrateMetabotWelcomeType). Anything the live table carries on top of this
 * base — columns added by later ALTER migrations, or by builds this version
 * no longer knows about (e.g. heartbeat_enabled) — is appended dynamically
 * from PRAGMA table_info; see buildMetabotsRebuildExtrasDdl.
 */
const METABOTS_REBUILD_BASE_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'wallet_id',
  'mvc_address',
  'btc_address',
  'doge_address',
  'public_key',
  'chat_public_key',
  'chat_public_key_pin_id',
  'name',
  'avatar',
  'enabled',
  'metaid',
  'globalmetaid',
  'metabot_info_pinid',
  'metabot_type',
  'created_by',
  'role',
  'soul',
  'goal',
  'bio',
  'background',
  'boss_id',
  'llm_id',
  'tools',
  'skills',
  'allow_chat_skills',
  'created_at',
  'updated_at',
]);

/**
 * Extra column DDL fragments for a metabots rebuild migration, derived from
 * the source table's PRAGMA table_info rows. The rebuilds re-create metabots
 * from an explicit base column list; a column the live table carries on top
 * of that base (added by a later ALTER migration, or left over from a build
 * this version no longer ships, e.g. heartbeat_enabled) previously made
 * INSERT ... SELECT fail with "table metabots_new has no column named ..." —
 * and since each migration's kv flag is only written on success, the failure
 * repeated on every launch. Deriving extras dynamically closes that failure
 * class. Pure + unit-tested.
 */
export function buildMetabotsRebuildExtrasDdl(infoRows: unknown[][]): string {
  let ddl = '';
  for (const row of infoRows) {
    const name = String(row?.[1] ?? '');
    if (!name || METABOTS_REBUILD_BASE_COLUMNS.has(name)) continue;
    const type = String(row[2] ?? '').trim() || 'TEXT';
    const notNull = Number(row[3]) === 1;
    const defaultValue = row[4];
    ddl += `, "${name}" ${type}`;
    if (notNull) ddl += ' NOT NULL';
    if (defaultValue !== null && defaultValue !== undefined) ddl += ` DEFAULT ${defaultValue}`;
  }
  return ddl;
}

const SQL_JS_WASM_RELATIVE_PATH = path.join('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

// Get the path to sql.js WASM file
export function resolveSqlJsWasmPath(input?: {
  isPackaged?: boolean;
  appPath?: string;
  resourcesPath?: string;
}): string {
  const packaged = input?.isPackaged ?? app.isPackaged;
  if (packaged) {
    // In production, the wasm file is in the unpacked resources
    return path.join(
      input?.resourcesPath ?? process.resourcesPath,
      'app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm'
    );
  }

  const appPath = input?.appPath ?? app.getAppPath();
  const resolvedFromAncestors = findNearestExistingFile(appPath, SQL_JS_WASM_RELATIVE_PATH);
  if (resolvedFromAncestors) {
    return resolvedFromAncestors;
  }

  return path.join(path.resolve(appPath), SQL_JS_WASM_RELATIVE_PATH);
}

function getWasmPath(): string {
  return resolveSqlJsWasmPath();
}

type SqliteBackendKind = 'native' | 'sqljs';

function listTableColumns(db: SqliteDatabase, tableName: string): string[] {
  const result = db.exec(`PRAGMA table_info(${tableName});`);
  if (!result[0]?.values) return [];
  return result[0].values.map((row) => String(row[1] || ''));
}

const SERVICE_ORDER_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS service_orders (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
    local_metabot_id INTEGER NOT NULL,
    counterparty_global_metaid TEXT NOT NULL,
    service_pin_id TEXT,
    order_pin_id TEXT,
    service_name TEXT NOT NULL,
    payment_txid TEXT NOT NULL,
    payment_chain TEXT NOT NULL CHECK (payment_chain IN ('mvc', 'btc', 'doge')),
    payment_amount TEXT NOT NULL,
    payment_currency TEXT NOT NULL,
    settlement_kind TEXT NOT NULL DEFAULT 'native' CHECK (settlement_kind IN ('native', 'mrc20')),
    mrc20_ticker TEXT,
    mrc20_id TEXT,
    payment_commit_txid TEXT,
    order_message_pin_id TEXT,
    order_message_txid TEXT,
    cowork_session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('awaiting_first_response', 'in_progress', 'rating_pending', 'completed', 'failed', 'refund_pending', 'refunded')),
    first_response_deadline_at INTEGER NOT NULL,
    delivery_deadline_at INTEGER NOT NULL,
    first_response_at INTEGER,
    delivery_message_pin_id TEXT,
    delivered_at INTEGER,
    rating_requested_at INTEGER,
    rating_deadline_at INTEGER,
    order_end_message_pin_id TEXT,
    order_ended_at INTEGER,
    order_end_reason TEXT,
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
`;

function migrateLegacyServiceOrdersTable(db: SqliteDatabase): void {
  const columns = listTableColumns(db, 'service_orders');
  if (columns.length === 0) return;
  if (
    columns.includes('settlement_kind')
    && columns.includes('mrc20_ticker')
    && columns.includes('mrc20_id')
    && columns.includes('payment_commit_txid')
    && columns.includes('order_message_txid')
    && columns.includes('rating_requested_at')
    && columns.includes('rating_deadline_at')
    && columns.includes('order_end_message_pin_id')
    && columns.includes('order_ended_at')
    && columns.includes('order_end_reason')
  ) {
    if (!columns.includes('order_pin_id')) {
      db.run('ALTER TABLE service_orders ADD COLUMN order_pin_id TEXT;');
    }
    return;
  }

  const legacy = (column: string, fallback: string) => (
    columns.includes(column) ? column : fallback
  );
  const orderMessageTxidExpr = columns.includes('order_message_txid')
    ? 'order_message_txid'
    : `CASE
        WHEN length(trim(COALESCE(order_message_pin_id, ''))) >= 66
          THEN lower(substr(trim(order_message_pin_id), 1, 64))
        ELSE NULL
      END`;

  db.run('BEGIN TRANSACTION;');
  try {
    db.run('ALTER TABLE service_orders RENAME TO service_orders_legacy_mrc20_migration;');
    db.run(SERVICE_ORDER_TABLE_SQL);
    db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, order_pin_id,
        service_name, payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        mrc20_ticker, mrc20_id, payment_commit_txid, order_message_pin_id, order_message_txid, cowork_session_id,
        status, first_response_deadline_at, delivery_deadline_at, first_response_at,
        delivery_message_pin_id, delivered_at, rating_requested_at, rating_deadline_at,
        order_end_message_pin_id, order_ended_at, order_end_reason, failed_at, failure_reason, refund_request_pin_id,
        refund_finalize_pin_id, refund_txid, refund_requested_at, refund_completed_at,
        refund_apply_retry_count, next_retry_at, created_at, updated_at
      )
      SELECT
        id,
        role,
        local_metabot_id,
        counterparty_global_metaid,
        service_pin_id,
        ${legacy('order_pin_id', 'NULL')},
        service_name,
        payment_txid,
        CASE
          WHEN lower(trim(payment_chain)) IN ('mvc', 'btc', 'doge') THEN lower(trim(payment_chain))
          WHEN upper(trim(payment_currency)) = 'BTC' THEN 'btc'
          WHEN upper(trim(payment_currency)) = 'DOGE' THEN 'doge'
          ELSE 'mvc'
        END,
        payment_amount,
        CASE
          WHEN lower(trim(payment_chain)) = 'btc' OR upper(trim(payment_currency)) = 'BTC' THEN 'BTC'
          WHEN lower(trim(payment_chain)) = 'doge' OR upper(trim(payment_currency)) = 'DOGE' THEN 'DOGE'
          ELSE 'SPACE'
        END,
        ${legacy('settlement_kind', "'native'")},
        ${legacy('mrc20_ticker', 'NULL')},
        ${legacy('mrc20_id', 'NULL')},
        ${legacy('payment_commit_txid', 'NULL')},
        order_message_pin_id,
        ${orderMessageTxidExpr},
        cowork_session_id,
        CASE
          WHEN status IN ('awaiting_first_response', 'in_progress', 'rating_pending', 'completed', 'failed', 'refund_pending', 'refunded') THEN status
          ELSE 'awaiting_first_response'
        END,
        first_response_deadline_at,
        delivery_deadline_at,
        first_response_at,
        delivery_message_pin_id,
        delivered_at,
        ${legacy('rating_requested_at', 'NULL')},
        ${legacy('rating_deadline_at', 'NULL')},
        ${legacy('order_end_message_pin_id', 'NULL')},
        ${legacy('order_ended_at', 'NULL')},
        ${legacy('order_end_reason', 'NULL')},
        failed_at,
        failure_reason,
        refund_request_pin_id,
        refund_finalize_pin_id,
        refund_txid,
        refund_requested_at,
        refund_completed_at,
        refund_apply_retry_count,
        next_retry_at,
        created_at,
        updated_at
      FROM service_orders_legacy_mrc20_migration;
    `);
    db.run('DROP TABLE service_orders_legacy_mrc20_migration;');
    db.run('COMMIT;');
  } catch (error) {
    db.run('ROLLBACK;');
    throw error;
  }
}

/**
 * v1.5: the Twin-delegated cards created BEFORE the origin column existed —
 * backfilled to 'twin_delegate' BY ID by migrateOrchestrationTaskOriginColumn.
 * The frozen historical record of the dev install's legacy window: 2026-09-18
 * 晚两卡 + 2026-09-19 晨三卡（v1.4 二进制运行时经 delegateLocalWorker 创建、origin 落
 * 默认 'owner'）+ the 2026-09-19 midday backfill-extension card. 名单随 v1.5 上线即冻结，
 * 新卡不再进入此名单。 v1.5 起 delegateLocalWorker 建卡即打标
 * (origin='twin_delegate').
 *
 * Release-audit follow-up 2026-09-19: these exact ids only ever covered THIS
 * machine's database. The migration now ALSO flips any unlinked card (no
 * group_tasks / scheduled_tasks link) via a structural predicate — by
 * construction such cards can only be Twin-delegated (see the migration's
 * comment for the call-site enumeration) — so other upgrading installs get
 * the same v1.5 guarantee. The list stays as the auditable record of the
 * original legacy window and as a redundant fast path.
 */
const TWIN_DELEGATED_CARD_IDS: readonly string[] = [
  '14cabbdc-27f0-4a76-9a2c-f7f76c5673a6', // 2026-09-18 night
  'f1128a6c-3559-44ae-b022-8d50d87519b9', // 2026-09-18 night
  '6f1038f7-7195-4049-aacd-ceab785282ff', // 2026-09-19 morning — v1.5 mainline
  'f1a201c3-0e40-4891-a8b7-2a2c583f534d', // 2026-09-19 morning — ack-entry patch
  '59d0709e-f3ff-4a03-bccd-09b7117c8f10', // 2026-09-19 morning — v1.5 acceptance
  'a06f8480-ad1a-4ea4-8d3e-bc4f6a490ed2', // 2026-09-19 midday — the backfill-extension card itself, created on the v1.4 binary after the list was first frozen
];

export class SqliteStore {
  private db: SqliteDatabase;
  private dbPath: string;
  private backendKind: SqliteBackendKind;
  private emitter = new EventEmitter();
  private isClosed = false;
  private static sqlPromise: Promise<SqlJsStatic> | null = null;

  private constructor(db: SqliteDatabase, dbPath: string, backendKind: SqliteBackendKind) {
    this.db = db;
    this.dbPath = dbPath;
    this.backendKind = backendKind;
  }

  static async create(userDataPath?: string): Promise<SqliteStore> {
    const basePath = userDataPath ?? app.getPath('userData');
    const dbPath = path.join(basePath, DB_FILENAME);
    fs.mkdirSync(basePath, { recursive: true });

    if (process.env.IDBOTS_SQLITE_BACKEND !== 'sqljs') {
      const nativeDb = createNativeSqliteDatabase(dbPath);
      if (nativeDb) {
        const store = new SqliteStore(nativeDb, dbPath, 'native');
        store.initializeTables(basePath);
        return store;
      }
    }

    // Initialize SQL.js with WASM file path (cached promise for reuse)
    if (!SqliteStore.sqlPromise) {
      const wasmPath = getWasmPath();
      SqliteStore.sqlPromise = initSqlJs({
        locateFile: () => wasmPath,
      });
    }
    const SQL = await SqliteStore.sqlPromise;

    // Load existing database or create new one
    let db: SqlJsDatabase;
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer) as SqlJsDatabase;
    } else {
      db = new SQL.Database() as SqlJsDatabase;
    }

    const store = new SqliteStore(db as unknown as SqliteDatabase, dbPath, 'sqljs');
    store.initializeTables(basePath);
    return store;
  }

  static resetSqlJsRuntimeForRecovery(): void {
    SqliteStore.sqlPromise = null;
  }

  getBackendKind(): SqliteBackendKind {
    return this.backendKind;
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
        hidden_from_session_list INTEGER NOT NULL DEFAULT 0,
        browser_uri TEXT,
        browser_title TEXT,
        project_id TEXT,
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
        is_streaming INTEGER GENERATED ALWAYS AS (
          CASE
            WHEN metadata IS NOT NULL AND instr(metadata, '"isStreaming":true') > 0 THEN 1
            ELSE 0
          END
        ) VIRTUAL,
        steer_pending INTEGER GENERATED ALWAYS AS (
          CASE
            WHEN metadata IS NOT NULL
              AND instr(metadata, '"interactionKind":"steer"') > 0
              AND (
                instr(metadata, '"steerStatus":"queued"') > 0
                OR instr(metadata, '"steerStatus":"delivered"') > 0
              )
            THEN 1
            ELSE 0
          END
        ) VIRTUAL,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_id ON cowork_messages(session_id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_created_at
      ON cowork_messages(session_id, created_at DESC);
    `);

    // Per-message human feedback (thumbs up/down) on cowork messages — one row
    // per rated message, read by the dream consolidation as the human's
    // per-message alignment signal. CREATE TABLE IF NOT EXISTS is the
    // idempotent first-run migration; existing rows are never touched.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS message_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        rating TEXT NOT NULL CHECK(rating IN ('up','down')),
        comment TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES cowork_messages(id) ON DELETE CASCADE
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_message_feedback_session ON message_feedback(session_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Migration (2026-08-17): the built-in Fetch MCP server's package was
    // unpublished from npm — auto-disable enabled rows still referencing it
    // (its npx 404 retry loop dragged DSH runtime boots out to minutes).
    try {
      const disabled = disableDeadFetchMcpServers(this.db);
      if (disabled > 0) {
        console.warn(`[SqliteStore] auto-disabled ${disabled} MCP server row(s) using the dead @modelcontextprotocol/server-fetch package`);
        this.save();
      }
    } catch (error) {
      console.warn('mcp dead-package migration failed:', error);
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        icon TEXT,
        guidelines TEXT,
        source_dir TEXT,
        resources_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
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
        origin TEXT NOT NULL DEFAULT 'conversation',
        importance REAL NOT NULL DEFAULT 0.5,
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

    // L3b procedural-memory drafts (SDD §4.1): capability candidates distilled
    // by the dream pipeline. CREATE TABLE IF NOT EXISTS is the idempotent
    // first-run migration; existing rows are never touched and no skill table
    // is modified (R4.3 — the skill registry stays untouched). `status`
    // defaults to 'draft'; drafts are promoted to 'validated' (or demoted to
    // 'rejected') by the dream-time capability validation pass.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS capability_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        capability_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_capability_drafts_metabot_created
      ON capability_drafts(metabot_id, created_at DESC);
    `);
    // Validation metadata for the dream-time replay gate (Dream-RSI P0).
    // PRAGMA-guarded and additive; pre-existing rows keep NULLs (= unvalidated).
    try {
      const draftCols = (this.db.exec('PRAGMA table_info(capability_drafts)')[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!draftCols.includes('validation_score')) {
        this.db.run('ALTER TABLE capability_drafts ADD COLUMN validation_score REAL');
      }
      if (!draftCols.includes('validation_notes')) {
        this.db.run('ALTER TABLE capability_drafts ADD COLUMN validation_notes TEXT');
      }
      if (!draftCols.includes('validated_at')) {
        this.db.run('ALTER TABLE capability_drafts ADD COLUMN validated_at INTEGER');
      }
    } catch (error) {
      console.warn('migrate capability_drafts validation columns:', error);
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_memory_policies (
        metabot_id INTEGER PRIMARY KEY,
        memory_enabled INTEGER NOT NULL DEFAULT 1,
        memory_implicit_update_enabled INTEGER NOT NULL DEFAULT 1,
        memory_llm_judge_enabled INTEGER NOT NULL DEFAULT 1,
        memory_guard_level TEXT NOT NULL DEFAULT 'strict',
        memory_user_memories_max_items INTEGER NOT NULL DEFAULT 12,
        dream_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (metabot_id) REFERENCES metabots(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_daily_summaries (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        summary_date TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        sections_json TEXT NOT NULL DEFAULT '{}',
        stats_json TEXT NOT NULL DEFAULT '{}',
        llm_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, summary_date)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_dream_runs (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        llm_id TEXT,
        error TEXT,
        telemetry_json TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, dream_date)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_weekly_summaries (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        week_start TEXT NOT NULL,
        week_end TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        patterns_json TEXT NOT NULL DEFAULT '[]',
        llm_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, week_start)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_dream_fragments (
        id TEXT PRIMARY KEY,
        metabot_id INTEGER NOT NULL,
        dream_date TEXT NOT NULL,
        fragment_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        source_char_count INTEGER NOT NULL DEFAULT 0,
        estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        summary_json TEXT,
        llm_id TEXT,
        dream_version INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(metabot_id, dream_date, fragment_key)
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metabot_dream_fragments_date
      ON metabot_dream_fragments(metabot_id, dream_date)
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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS a2a_conversation_threads (
        id TEXT PRIMARY KEY,
        participant_pair_key TEXT NOT NULL,
        local_metabot_id INTEGER NOT NULL,
        local_global_metaid TEXT NOT NULL,
        peer_global_metaid TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_a2a_threads_participant_pair
      ON a2a_conversation_threads(participant_pair_key, updated_at DESC);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS a2a_conversation_episodes (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        episode_index INTEGER NOT NULL,
        previous_session_id TEXT,
        next_session_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        close_reason TEXT,
        UNIQUE(thread_id, episode_index),
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (thread_id) REFERENCES a2a_conversation_threads(id) ON DELETE CASCADE
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_a2a_episodes_thread_index
      ON a2a_conversation_episodes(thread_id, episode_index DESC);
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
        cowork_session_id TEXT,
        target_session_id TEXT,
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
        skip_reason TEXT,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id
        ON scheduled_task_runs(task_id, started_at DESC);
    `);

    // Twin orchestration state is additive and idempotent so active plans,
    // worker attempts, and recovery evidence survive application upgrades.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orchestration_tasks (
        id TEXT PRIMARY KEY,
        owner_intent TEXT NOT NULL,
        enriched_goal TEXT,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        source_session_id TEXT,
        twin_metabot_id INTEGER NOT NULL,
        owner_global_meta_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','running','review','completed','failed','cancelled')),
        plan_version INTEGER NOT NULL DEFAULT 1,
        origin TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_tasks_owner_status
        ON orchestration_tasks(owner_global_meta_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS orchestration_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        dependency_step_ids_json TEXT NOT NULL DEFAULT '[]',
        assignee_metabot_id INTEGER,
        permission_scope_json TEXT NOT NULL DEFAULT '{}',
        deadline_at TEXT,
        status TEXT NOT NULL DEFAULT 'blocked' CHECK(status IN ('blocked','ready','queued','running','waiting_input','completed','failed','cancelled')),
        accepted_result_json TEXT,
        active_attempt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, ordinal),
        FOREIGN KEY(task_id) REFERENCES orchestration_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_steps_assignee_status
        ON orchestration_steps(assignee_metabot_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS orchestration_attempts (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        worker_metabot_id INTEGER NOT NULL,
        worker_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','timed_out','cancelled')),
        prompt TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY(step_id) REFERENCES orchestration_steps(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_attempts_step_status
        ON orchestration_attempts(step_id, status, queued_at DESC);
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
    // private_chat_messages only ever grows (every chain pin carries its full
    // raw_data payload) and had no secondary index at all, so the hot lookups
    // below were full table scans that got slower as the history grew:
    //   - the 5s private-chat daemon poll reads the unprocessed queue
    //     (`WHERE is_processed = 0 ORDER BY id ASC`, plus the same predicate
    //     with `ORDER BY id DESC LIMIT 50` for the pending list);
    //   - resolving the peer chat pubkey / reply pin for an order or A2A
    //     message scans for the newest row between the local Bot and the peer,
    //     matching `(from_global_metaid = ? OR from_metaid = ?) AND
    //     (to_global_metaid = ? OR to_metaid = ?)`.
    // Both (global, legacy) column pairs get their own index, and SQLite
    // resolves the OR through a multi-index union (see EXPLAIN QUERY PLAN)
    // instead of scanning the table.
    //
    // The sender side is indexed deliberately: the receiver side (`to_*`) always
    // matches every message addressed to a busy local Bot (thousands of rows,
    // sorted in a temp b-tree), and measured ~20% SLOWER than the unindexed
    // reverse rowid scan it replaced, while the sender side seeks straight to
    // the peer's own rows (~19x faster on a production-shaped lookup set).
    // The pair index carries the receiver column too so that the
    // owner<->Bot-both-directions lookup (`(from_global = ? AND to_global = ?)
    // OR (...)`) seeks on both columns; the single-column index is separate
    // because a pair index cannot serve `ORDER BY id DESC` after an equality on
    // its first column alone, which the daemon's "latest message from this
    // sender" lookup does (0.006ms indexed vs 0.25ms pair-only vs 2.8ms scan).
    // CREATE INDEX IF NOT EXISTS is the idempotent first-run migration; existing
    // rows are indexed in place.
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_private_chat_msg_unprocessed
        ON private_chat_messages(is_processed, id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_private_chat_msg_sender_global
        ON private_chat_messages(from_global_metaid, to_global_metaid, id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_private_chat_msg_sender_legacy
        ON private_chat_messages(from_metaid, to_metaid, id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_private_chat_msg_sender_latest
        ON private_chat_messages(from_global_metaid, id);
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

    // Group Task (任务导向群聊): task entity + members + deliverables (M1)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orchestration_task_id TEXT,
        group_id TEXT UNIQUE,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance_criteria TEXT,
        status TEXT NOT NULL DEFAULT 'planning'
          CHECK(status IN ('planning','executing','review','done','cancelled')),
        chair_metabot_id INTEGER NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'user',
        last_processed_msg_id INTEGER NOT NULL DEFAULT 0,
        create_pin_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        closed_at TEXT,
        rating INTEGER,
        rating_comment TEXT,
        rated_at TEXT,
        display_name TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        source_session_id TEXT,
        comm_total_bytes INTEGER,
        comm_message_count INTEGER,
        dispatch_paused_at INTEGER,
        mode TEXT NOT NULL DEFAULT 'task' CHECK(mode IN ('task','chat'))
      );
    `);
    this.migrateGroupTaskOrchestrationLink();
    this.migrateGroupTasksLastDrivenAt();
    this.migrateGroupTasksRatingColumns();
    this.migrateGroupTasksCommStats();
    // G-04: supervisor pause gate — epoch ms while dispatch is paused, NULL = running.
    this.migrateGroupTasksDispatchPausedAt();
    // R1 (OpenTeam chat scenario): group mode 'task' | 'chat'. Legacy rows and
    // untouched callers default to 'task' — byte-identical behavior.
    this.migrateGroupTasksModeColumn();
    // Long-task board (task #83): the board reuses orchestration_tasks as the
    // single authoritative ledger. Two ADD COLUMN migrations only — the board
    // must never introduce a fourth table.
    this.migrateScheduledTaskOrchestrationLink();
    this.migrateOrchestrationTaskClosureColumns();
    // Long-task board v1.2 (task #86): the conclusion is an INSTRUCTION, so the
    // row must also carry its processing mark and the receipt. Five more ADD
    // COLUMNs on the same ledger — still no fourth table (freeze doc §2.1).
    this.migrateOrchestrationTaskClosureProcessingColumns();
    // Long-task board v1.5 (谁发起，谁验收): the origin column + the exact-by-id
    // backfill of the pre-v1.5 Twin-delegated cards (frozen legacy-window list).
    // Runs before the closure
    // backfill so closerRole is derivable from the very first board read.
    this.migrateOrchestrationTaskOriginColumn();

    // G-04: supervisor intervention ledger (nudge / flag / pause / resume) —
    // structured signals recorded from the Twin supervisor channel, visible
    // in-group via host notices, auditable, and snapshotted into the review
    // record. CREATE TABLE IF NOT EXISTS is the idempotent first-run migration.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_supervisor_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('nudge','flag','pause','resume')),
        note TEXT NOT NULL,
        target TEXT,
        created_by TEXT NOT NULL DEFAULT 'supervisor',
        notice_pin_id TEXT,
        processed_at INTEGER,
        chair_response_pin_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_supervisor_signals_task
        ON group_task_supervisor_signals(task_id, id);
    `);

    // Single-commander architecture (task #64 follow-up): the host is the
    // environment, never a speaker. Environment observations (no-ACK watches,
    // deadline bells, long-turn facts, join events, parser verdicts, stuck
    // evidence) are recorded here and delivered to the CHAIR ONLY, locally,
    // in its next turn's system context — the chair decides what to say in
    // the group, in its own voice. CREATE TABLE IF NOT EXISTS is the
    // idempotent first-run migration for upgraded users.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_host_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        target TEXT,
        body TEXT NOT NULL,
        dedupe_key TEXT,
        consumed_at INTEGER,
        chair_response_pin_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_host_notes_pending
        ON group_task_host_notes(task_id, consumed_at, id);
    `);
    this.migrateGroupTasksLocalState();
    this.migrateGroupTasksSourceSessionId();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_staffing_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_session_id TEXT NOT NULL,
        twin_metabot_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance_criteria TEXT,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','confirmed','skip_authorized','consumed','cancelled')),
        skip_authorized INTEGER NOT NULL DEFAULT 0,
        owner_decision TEXT,
        created_task_id INTEGER,
        created_at INTEGER NOT NULL,
        confirmed_at INTEGER
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_staffing_proposals_session
        ON group_task_staffing_proposals(source_session_id, created_at DESC);
    `);
    // P0-5: state-transition audit log (who/from/to/reason + timestamp).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        actor TEXT,
        reason TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_transitions_task
        ON group_task_transitions(task_id, id);
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        metabot_id INTEGER,
        globalmetaid TEXT,
        role TEXT NOT NULL DEFAULT 'worker' CHECK(role IN ('chair','worker')),
        joined_pin_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(task_id, metabot_id)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_deliverables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        msg_pin_id TEXT,
        author_globalmetaid TEXT,
        kind TEXT,
        uri TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','accepted','rejected')),
        confirmation TEXT NOT NULL DEFAULT 'unconfirmed'
          CHECK(confirmation IN ('unconfirmed','confirmed')),
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    // Migration: add display_name / removed_at to group_task_members (OpenTeam remote members).
    this.migrateGroupTaskMembersOpenTeamColumns();
    this.migrateGroupTaskMembersStatusColumns();
    this.migrateGroupTaskDeliverablesVerification();
    this.migrateGroupTaskDeliverablesConfirmation();
    // P3 (v1.1): widen the legacy status CHECK to include 'delivered'.
    this.migrateGroupTaskDeliverablesDeliveredStatus();
    // P2: same-bytes deliverable dedupe key (sha256 of the deliverable bytes).
    this.migrateGroupTaskDeliverablesContentHash();
    // P0-8: public integrity declarations (honest corrections/reports).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_integrity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        msg_pin_id TEXT,
        author_globalmetaid TEXT,
        event_type TEXT NOT NULL DEFAULT 'correction'
          CHECK(event_type IN ('correction','honest_report')),
        detail TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_integrity_events_task
        ON group_task_integrity_events(task_id, id);
    `);

    // Group Task status transition history (who moved the task from/to which
    // status and when) — the source for the detail-view status timeline.
    // CREATE TABLE IF NOT EXISTS is the idempotent first-run migration; the
    // table simply does not exist for older user databases until this schema
    // block runs again, and existing rows are never touched.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        actor_kind TEXT NOT NULL DEFAULT 'system' CHECK(actor_kind IN ('chair','owner','system')),
        actor_globalmetaid TEXT,
        actor_name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_status_events_task
        ON group_task_status_events(task_id, id);
    `);

    // Group Task human-in-the-loop checkpoints: a mid-task pause point opened
    // by the chair (`[CHECKPOINT: <topic>]`) so the owner can review a draft or
    // decision before work continues; resolved by `[CHECKPOINT_RESOLVED: ...]`.
    // Multiple checkpoints per task are allowed over its lifetime, but at most
    // one is 'open' at any moment (enforced by GroupTaskStore.openCheckpoint).
    // CREATE TABLE IF NOT EXISTS is the idempotent first-run migration; the
    // task status state machine itself is untouched by this feature.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        topic TEXT,
        opened_msg_pin_id TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','cancelled')),
        resolution TEXT,
        resolved_msg_pin_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_checkpoints_task
        ON group_task_checkpoints(task_id, id);
    `);

    // Group Task acceptance summary: the host-generated, deterministic "把菜端
    // 上桌" artifact produced when a task enters review (T1) and finalized when
    // it closes (T2). goal/acceptanceCriteria/guidance are denormalized for
    // direct rendering; deliverables and members are JSON snapshots so the
    // summary is an immutable point-in-time record independent of later
    // deliverable/member edits. version increments per review-entry regeneration
    // (rework → review produces a fresh v2). CREATE TABLE IF NOT EXISTS is the
    // idempotent first-run migration; existing rows are never touched.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_acceptance_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        goal TEXT NOT NULL,
        acceptance_criteria TEXT,
        deliverables_json TEXT NOT NULL,
        members_json TEXT NOT NULL,
        guidance TEXT NOT NULL,
        plan_changes_json TEXT,
        criteria_verdicts_json TEXT,
        observations_json TEXT,
        supervisor_signals_json TEXT,
        conclusion TEXT,
        outcome TEXT,
        rating INTEGER,
        rating_comment TEXT,
        generated_by TEXT NOT NULL DEFAULT 'host',
        generated_at TEXT DEFAULT (datetime('now')),
        published_group_pin_id TEXT,
        notified_session TEXT,
        superseded_at TEXT
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_acceptance_summaries_task
        ON group_task_acceptance_summaries(task_id, version);
    `);
    // Improvement #4 (v1.3): older user databases lack the plan-changes snapshot
    // column — add it idempotently (NULL = no plan change disclosed).
    this.migrateGroupTaskAcceptanceSummariesPlanChanges();
    // G-05: criteria-verdict / observation columns for create-time-aligned
    // acceptance — idempotent PRAGMA-guarded, NULL = not captured.
    this.migrateGroupTaskAcceptanceSummariesCriteriaVerdicts();
    // Speedup R-06: time-breakdown snapshot column — idempotent, NULL = not
    // computed (summaries recorded before R-06 stay null).
    this.migrateGroupTaskAcceptanceSummariesTimeBreakdown();
    // Task #83 audit (F2a): superseded-at column — a review→executing rework
    // voids the already-notified summary; NULL = still authoritative.
    this.migrateGroupTaskAcceptanceSummariesSupersededAt();

    // Improvement #4 (v1.3): plan-change resolutions the chair posts in-group
    // with a [PLAN_CHANGE: ...] tag (original plan -> blocker -> fallback).
    // First-hand on-chain facts (deduped by message pin) snapshotted into the
    // acceptance summary at review entry, so the owner-facing surfaces render
    // "why the artifact looks the way it does" without transcript digging.
    // CREATE TABLE IF NOT EXISTS is the idempotent first-run migration;
    // existing rows are never touched.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_plan_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        msg_pin_id TEXT,
        author_globalmetaid TEXT,
        summary TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_task_plan_changes_task
        ON group_task_plan_changes(task_id, id);
    `);

    // R9 (OpenTeam chat scenario): discussion artifacts — objections, boundary
    // statements, agreed conclusions recorded from [POSITION: …] lines in
    // TASK-mode groups (chat groups record none). One row per line, deduped by
    // (task, message pin, line), each citing its source pin. CREATE TABLE IF
    // NOT EXISTS is the idempotent first-run migration; existing rows untouched.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_task_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        msg_pin_id TEXT,
        author_globalmetaid TEXT,
        statement TEXT NOT NULL,
        line_no INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_group_task_positions_dedupe
        ON group_task_positions(task_id, msg_pin_id, line_no);
    `);

    // OpenTeam: invitee-side group memberships + inviter-side invite tracking (M1).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS openteam_memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        metabot_id INTEGER NOT NULL,
        globalmetaid TEXT,
        inviter_globalmetaid TEXT,
        task_title TEXT,
        invite_pin_id TEXT,
        joined_pin_id TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','left')),
        created_at TEXT DEFAULT (datetime('now')),
        last_processed_msg_id INTEGER NOT NULL DEFAULT 0,
        activated_at TEXT,
        UNIQUE(group_id, metabot_id)
      );
    `);
    // Migration: add last_processed_msg_id to openteam_memberships (guest daemon cursor).
    this.migrateOpenTeamMembershipsCursorColumn();
    // Migration: add activated_at to openteam_memberships (guest self-check grace anchor).
    this.migrateOpenTeamMembershipsActivatedColumn();
    // Migration: add left_at/left_cause/left_reason to openteam_memberships (guest "removed" notice).
    this.migrateOpenTeamMembershipsLeftColumns();
    // Migration: add task_status/task_status_updated_at to openteam_memberships (host task status sync).
    this.migrateOpenTeamMembershipsTaskStatusColumns();
    // Migration: add group_mode to openteam_memberships (R1 — the mode declared
    // by the chair at group creation and carried on the invite envelope; the
    // guest daemon switches gating/prompt/cadence on it. NULL = legacy 'task').
    this.migrateOpenTeamMembershipsGroupModeColumn();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS openteam_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        invitee_globalmetaid TEXT NOT NULL,
        invitee_name TEXT,
        invite_pin_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','accepted','declined','expired')),
        decline_reason TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        responded_at TEXT,
        invitee_metaid TEXT,
        required_skills TEXT
      );
    `);
    // Migration: add invitee_metaid to openteam_invites (legacy identity form for watchers).
    this.migrateOpenTeamInvitesMetaIdColumn();
    // Migration: add joined_pin_id to openteam_invites (P1-2: the ACCEPT
    // envelope's join pin is persisted here and copied into the member row).
    this.migrateOpenTeamInvitesJoinedPinColumn();
    // Migration: add required_skills to openteam_invites (#13: the join-welcome
    // handshake states WHY the remote member was invited — required skills
    // carried on the invite row, JSON array text).
    this.migrateOpenTeamInvitesRequiredSkillsColumn();
    // P0-1: guest-side invite history — every [OPENTEAM_INVITE] this machine's
    // bots received, regardless of outcome, so the invite is visible in the
    // A2A session system / collab UI even before (or without) a join.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS openteam_guest_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        inviter_globalmetaid TEXT NOT NULL,
        inviter_name TEXT,
        task_title TEXT,
        goal_summary TEXT,
        required_skills TEXT,
        invite_pin_id TEXT,
        target_globalmetaid TEXT,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'invited'
          CHECK(status IN ('invited','accepted','declined','skipped','expired')),
        decline_reason TEXT,
        joined_pin_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        responded_at TEXT
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_openteam_guest_invites_group
        ON openteam_guest_invites(group_id, id);
    `);

    // R10 (OpenTeam chat scenario, H-50 ③): dialogue cognition records —
    // persistent statements from group conversations (positions, boundaries,
    // agreements, corrections) with source-pin citations. Interface + storage
    // milestone: the table and store exist and are tested; conversation-pipeline
    // extraction is second-phase. Group-scoped (OpenTeam guest hosts have no
    // local task row), idempotent per source pin.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dialogue_cognitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        task_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'note'
          CHECK(kind IN ('position','boundary','agreement','correction','note')),
        statement TEXT NOT NULL,
        author_global_metaid TEXT,
        participants_json TEXT,
        source_pin_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_dialogue_cognitions_group
        ON dialogue_cognitions(group_id, id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_chat_messages_group_id
        ON group_chat_messages(group_id, id);
    `);
    this.migrateGroupChatMessagesMsgIndex();
    this.migrateGroupChatMessagesSenderSuspect();

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
        provider_skills_json TEXT,
        payment_timing TEXT,
        protocol_settlement_kind TEXT,
        metadata TEXT,
        execution_reminder TEXT,
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
    migrateLegacyServiceOrdersTable(this.db);
    this.db.run(SERVICE_ORDER_TABLE_SQL);
    if (!listTableColumns(this.db, 'service_orders').includes('order_pin_id')) {
      this.db.run('ALTER TABLE service_orders ADD COLUMN order_pin_id TEXT;');
    }
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_service_orders_status_updated_at
      ON service_orders(status, updated_at DESC);
    `);
    this.db.run(`
      UPDATE service_orders
      SET settlement_kind = lower(trim(settlement_kind))
      WHERE settlement_kind IS NOT NULL;
    `);
    this.db.run(`
      UPDATE service_orders
      SET settlement_kind = 'native'
      WHERE settlement_kind NOT IN ('native', 'mrc20')
         OR settlement_kind IS NULL
         OR trim(settlement_kind) = '';
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_chain = lower(trim(payment_chain))
      WHERE payment_chain IS NOT NULL;
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_chain = 'btc'
      WHERE settlement_kind = 'mrc20';
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_chain = 'mvc'
      WHERE settlement_kind <> 'mrc20'
        AND payment_chain NOT IN ('mvc', 'btc', 'doge');
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_currency = upper(trim(payment_currency))
      WHERE payment_currency IS NOT NULL;
    `);
    this.db.run(`
      UPDATE service_orders
      SET mrc20_ticker = upper(trim(
        COALESCE(
          NULLIF(mrc20_ticker, ''),
          CASE
            WHEN upper(trim(payment_currency)) LIKE '%-MRC20'
              THEN substr(upper(trim(payment_currency)), 1, length(upper(trim(payment_currency))) - 6)
            ELSE ''
          END
        )
      ))
      WHERE settlement_kind = 'mrc20';
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_currency = CASE
        WHEN settlement_kind = 'mrc20' AND trim(COALESCE(mrc20_ticker, '')) <> ''
          THEN upper(trim(mrc20_ticker)) || '-MRC20'
        WHEN payment_chain = 'btc' THEN 'BTC'
        WHEN payment_chain = 'doge' THEN 'DOGE'
        ELSE 'SPACE'
      END;
    `);
    this.db.run(`
      UPDATE service_orders
      SET mrc20_ticker = NULL,
          mrc20_id = NULL,
          payment_commit_txid = NULL
      WHERE settlement_kind <> 'mrc20';
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_currency = CASE
        WHEN payment_chain = 'btc' THEN 'BTC'
        WHEN payment_chain = 'doge' THEN 'DOGE'
        ELSE 'SPACE'
      END
      WHERE settlement_kind <> 'mrc20'
        AND (payment_currency NOT IN ('SPACE', 'BTC', 'DOGE')
          OR (payment_chain = 'mvc' AND payment_currency = 'MVC'));
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
        WHERE payment_txid IS NOT NULL
          AND trim(payment_txid) <> ''
      )
      DELETE FROM service_orders
      WHERE rowid IN (
        SELECT rowid FROM ranked WHERE rank_in_group > 1
      );
    `);
    this.db.run(`
      WITH ranked AS (
        SELECT
          rowid,
          ROW_NUMBER() OVER (
            PARTITION BY local_metabot_id, role, order_pin_id
            ORDER BY updated_at DESC, created_at DESC, id DESC
          ) AS rank_in_group
        FROM service_orders
        WHERE order_pin_id IS NOT NULL
          AND trim(order_pin_id) <> ''
      )
      UPDATE service_orders
      SET order_pin_id = NULL
      WHERE rowid IN (
        SELECT rowid FROM ranked WHERE rank_in_group > 1
      );
    `);
    this.db.run('DROP INDEX IF EXISTS idx_service_orders_dedupe_payment;');
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_dedupe_payment
      ON service_orders(local_metabot_id, role, payment_txid)
      WHERE payment_txid IS NOT NULL AND trim(payment_txid) <> '';
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_dedupe_order_pin
      ON service_orders(local_metabot_id, role, order_pin_id)
      WHERE order_pin_id IS NOT NULL AND trim(order_pin_id) <> '';
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_service_orders_order_pin_id
      ON service_orders(order_pin_id)
      WHERE order_pin_id IS NOT NULL AND trim(order_pin_id) <> '';
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_service_orders_order_message_txid
      ON service_orders(local_metabot_id, role, order_message_txid);
    `);
    this.db.run('DROP TRIGGER IF EXISTS trg_service_orders_status_insert;');
    this.db.run('DROP TRIGGER IF EXISTS trg_service_orders_status_update;');
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
      WHEN NEW.status NOT IN ('awaiting_first_response', 'in_progress', 'rating_pending', 'completed', 'failed', 'refund_pending', 'refunded')
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
      WHEN NOT (
        (NEW.settlement_kind = 'native' AND NEW.payment_currency IN ('SPACE', 'BTC', 'DOGE'))
        OR (
          NEW.settlement_kind = 'mrc20'
          AND NEW.payment_chain = 'btc'
          AND NEW.mrc20_ticker IS NOT NULL
          AND trim(NEW.mrc20_ticker) <> ''
          AND NEW.mrc20_id IS NOT NULL
          AND trim(NEW.mrc20_id) <> ''
          AND NEW.payment_currency = upper(trim(NEW.mrc20_ticker)) || '-MRC20'
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_currency');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_currency_update
      BEFORE UPDATE OF payment_currency ON service_orders
      WHEN NOT (
        (NEW.settlement_kind = 'native' AND NEW.payment_currency IN ('SPACE', 'BTC', 'DOGE'))
        OR (
          NEW.settlement_kind = 'mrc20'
          AND NEW.payment_chain = 'btc'
          AND NEW.mrc20_ticker IS NOT NULL
          AND trim(NEW.mrc20_ticker) <> ''
          AND NEW.mrc20_id IS NOT NULL
          AND trim(NEW.mrc20_id) <> ''
          AND NEW.payment_currency = upper(trim(NEW.mrc20_ticker)) || '-MRC20'
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_currency');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_status_update
      BEFORE UPDATE OF status ON service_orders
      WHEN NEW.status NOT IN ('awaiting_first_response', 'in_progress', 'rating_pending', 'completed', 'failed', 'refund_pending', 'refunded')
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
        metabot_type TEXT CHECK(metabot_type IN ('twin', 'worker', 'welcome')) NOT NULL,
        created_by TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        goal TEXT,
        bio TEXT,
        -- Deprecated compatibility column; v3 Bot Info uses bio and /info/bio.
        background TEXT,
        boss_id INTEGER,
        llm_id TEXT,
        fallback_llm_id TEXT,
        tools TEXT DEFAULT '[]',
        skills TEXT DEFAULT '[]',
        allow_chat_skills TEXT DEFAULT '[]',
        a2a_max_incoming_turns INTEGER,
        a2a_bye_cooldown_ms INTEGER,
        a2a_auto_reply_enabled INTEGER,
        homepage TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (wallet_id) REFERENCES metabot_wallets(id) ON DELETE RESTRICT,
        FOREIGN KEY (boss_id) REFERENCES metabots(id)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metaapp_owner_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metabot_id INTEGER NOT NULL,
        pin_id TEXT NOT NULL,
        first_pin_id TEXT,
        operation TEXT NOT NULL,
        mvc_address TEXT NOT NULL,
        payload TEXT,
        txids TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(pin_id)
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metaapp_owner_cache_bot ON metaapp_owner_cache(metabot_id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_metaapp_owner_cache_mvc ON metaapp_owner_cache(mvc_address);
    `);

    // Human user identity: single-row table (CHECK id = 1). Holds the local
    // human user's mnemonic-derived MetaID identity used for owner binding.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mnemonic TEXT NOT NULL,
        path TEXT DEFAULT "m/44'/10001'/0'/0/0",
        mvc_address TEXT NOT NULL,
        btc_address TEXT NOT NULL,
        doge_address TEXT NOT NULL,
        public_key TEXT NOT NULL,
        chat_public_key TEXT NOT NULL,
        chat_public_key_pin_id TEXT,
        metaid TEXT NOT NULL,
        globalmetaid TEXT,
        name TEXT NOT NULL,
        avatar TEXT,
        subsidy_state TEXT,
        subsidy_error TEXT,
        name_pin_id TEXT,
        avatar_pin_id TEXT,
        sync_state TEXT,
        sync_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Agent-Game-v2: persistent App/Game Runtime (docs/14 §5). Sessions, task
    // grants, the idempotent write ledger, and the audit trail. These tables
    // are user-data and must survive auto-update; column additions are guarded.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_game_sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'paused',
        app_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seat TEXT NOT NULL,
        rules_hash TEXT NOT NULL,
        adapter_hash TEXT NOT NULL,
        manifest_uri TEXT NOT NULL,
        protocol_paths TEXT,
        budget_llm_calls INTEGER NOT NULL DEFAULT 0,
        budget_llm_calls_used INTEGER NOT NULL DEFAULT 0,
        budget_writes INTEGER NOT NULL DEFAULT 0,
        budget_writes_used INTEGER NOT NULL DEFAULT 0,
        last_index INTEGER,
        last_action_seq INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0,
        consent TEXT,
        lease_id TEXT,
        lease_expires_at INTEGER,
        serialized_state TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_game_sessions_group
        ON agent_game_sessions(group_id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_game_sessions_status
        ON agent_game_sessions(status);
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_game_grants (
        resource_uri TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        rules_hash TEXT NOT NULL,
        adapter_hash TEXT NOT NULL,
        seat TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        ttl_ms INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        budget_llm_calls INTEGER NOT NULL DEFAULT 0,
        budget_writes INTEGER NOT NULL DEFAULT 0,
        protocol_paths TEXT,
        revoked_at INTEGER,
        reason TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (resource_uri, actor_id, app_id, group_id, game_id, rules_hash, adapter_hash, seat)
      );
    `);
    this.migrateAgentGameGrantsProtocolPaths();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_game_write_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        action_seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pin_id TEXT,
        tx_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (group_id, action_seq, event_id)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_game_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        session_id TEXT,
        actor_id TEXT,
        fields TEXT,
        ts INTEGER NOT NULL
      );
    `);
    this.migrateAgentGameWriteLogEventIdUnique();

    // Migration: existing DBs with old schema (metabot_wallets.metabot_id, metabots without wallet_id, avatar TEXT)
    this.migrateMetabotWalletRelationAndAvatar(basePath);

    // Migration: make metabot_info_pinid optional (nullable, no UNIQUE) for new MetaBots without on-chain info pin
    this.migrateMetabotInfoPinidOptional();
    // Migration: make chat_public_key_pin_id optional (same pattern - placeholder before on-chain push)
    this.migrateChatPublicKeyPinIdOptional();
    // Migration: add allow_chat_skills for private-chat allowlist storage
    this.migrateMetabotAllowChatSkills();
    // Migration: add v3 public bio column and backfill from deprecated background.
    this.migrateMetabotBioColumn();
    // Migration: add fallback_llm_id for the optional fallback (secondary) LLM provider.
    this.migrateMetabotFallbackLlmId();
    // Migration: add per-bot A2A private-chat limits (max turns / bye cooldown).
    this.migrateMetabotA2AChatLimits();
    // Migration: clear legacy local boss_id values that point at missing/self rows.
    this.migrateOrphanMetabotBossIds();
    // Migration: rebuild metabots so the CHECK admits the 'welcome' system bot
    // type (existing databases baked the twin/worker-only CHECK constraint).
    this.migrateMetabotWelcomeType();
    // One-shot migration: normalize metabot_type, collapse duplicate twins, and
    // promote the earliest bot when no twin exists (unique-Twin backfill).
    this.migrateMetabotTwinBackfill();
    // Migration: add model-level LLM brain columns (provider disambiguation +
    // reasoning effort for both brains). Runs after every table-rebuilding
    // migration so the ALTERs always land on the final metabots table.
    this.migrateMetabotLlmBrainColumns();
    // Migration: persist user-identity bootstrap state (subsidy + per-pin sync status)
    // so chain setup can be resumed/retried idempotently after failures.
    this.migrateUserIdentitySetupColumns();

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

      if (!columns.includes('hidden_from_session_list')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN hidden_from_session_list INTEGER NOT NULL DEFAULT 0;');
        this.save();
      }

      if (!columns.includes('auto_origin')) {
        // Origin marker for auto-created sessions: the renderer folds rows with
        // a non-NULL value into the collapsed "Autonomous Tasks" (自主任务)
        // sidebar section instead of the regular conversation list. NULL =
        // human-initiated.
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN auto_origin TEXT;');

        // One-shot backfill for sessions created before the column existed. The
        // ALTER above is the run marker, so this whole block executes exactly
        // once per database; re-running it would be a no-op anyway (every
        // statement is predicated on auto_origin still being NULL).
        const hasSessionType = columns.includes('session_type');
        // session_type is added by CoworkStore on a later startup, so an old
        // database may not have it yet — fall back to the title prefix alone.
        const longtermPredicate = hasSessionType
          ? "(session_type = 'longterm' OR title LIKE '[长期] %')"
          : "title LIKE '[长期] %'";
        this.db.run(`UPDATE cowork_sessions SET auto_origin = 'longterm' WHERE ${longtermPredicate}`);
        this.db.run(`
          UPDATE cowork_sessions
          SET auto_origin = 'orchestration'
          WHERE auto_origin IS NULL
            AND (title LIKE '[编排任务] %' OR title LIKE '[Orchestration Task] %')
        `);

        // Scheduled-run sessions carry the '[定时] ' title prefix, but a session
        // renamed by the user is still a scheduled run — the run ledger is the
        // authoritative link when it exists.
        let scheduledRunPredicate = "title LIKE '[定时] %'";
        try {
          const runTableResult = this.db.exec(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_task_runs'"
          );
          if (runTableResult[0]?.values?.length) {
            scheduledRunPredicate += ' OR id IN (SELECT session_id FROM scheduled_task_runs WHERE session_id IS NOT NULL)';
          }
        } catch {
          // sqlite_master unreadable — the title predicate alone is enough.
        }
        this.db.run(`
          UPDATE cowork_sessions
          SET auto_origin = 'schedule'
          WHERE auto_origin IS NULL
            AND (${scheduledRunPredicate})
        `);

        this.save();
      }

      if (!columns.includes('fold_override')) {
        // Manual placement of a session in the sidebar's "Autonomous Tasks"
        // (自主任务) fold: 'in' | 'out', NULL = follow the auto_origin policy.
        // Additive and unbackfilled on purpose — the policy already covers every
        // existing row, and an override is only ever set by a deliberate user
        // move.
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN fold_override TEXT;');
        this.save();
      }

      if (!columns.includes('metabot_id')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN metabot_id INTEGER;');
        this.save();
      }

      if (!columns.includes('project_id')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN project_id TEXT;');
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

    // Migration: Add newer scheduled task columns for upgraded user databases.
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

        if (!stColumns.includes('cowork_session_id')) {
          this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN cowork_session_id TEXT');
          this.save();
        }

        if (!stColumns.includes('target_session_id')) {
          this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN target_session_id TEXT');
          this.save();
        }
      }
    } catch {
      // Migration not needed or table doesn't exist yet.
    }

    // Migration: the run ledger's skip reason column (issue #60). Existing runs
    // keep NULL (they were real runs); only new skipped rows carry a reason.
    try {
      const runColsResult = this.db.exec('PRAGMA table_info(scheduled_task_runs);');
      if (runColsResult[0]) {
        const runColumns = runColsResult[0].values.map((row) => row[1]) || [];
        if (!runColumns.includes('skip_reason')) {
          this.db.run('ALTER TABLE scheduled_task_runs ADD COLUMN skip_reason TEXT');
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

    // Migration: Add homepage column to metabots (MetaBot homepage source pointer)
    try {
      const hpColsResult = this.db.exec('PRAGMA table_info(metabots)');
      const hpColumns = (hpColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!hpColumns.includes('homepage')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN homepage TEXT');
        this.save();
      }
    } catch (error) {
      console.warn('Failed to migrate metabots homepage:', error);
    }

    // Migration: Add owner_binding_pinid column to metabots (pin id of the
    // signed /info/owner binding; null = no signed owner binding)
    try {
      const obColsResult = this.db.exec('PRAGMA table_info(metabots)');
      const obColumns = (obColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!obColumns.includes('owner_binding_pinid')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN owner_binding_pinid TEXT');
        this.save();
      }
    } catch (error) {
      console.warn('Failed to migrate metabots owner_binding_pinid:', error);
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
      if (!rssColumns.includes('execution_reminder')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN execution_reminder TEXT');
        this.save();
      }
      if (!rssColumns.includes('provider_skills_json')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN provider_skills_json TEXT');
        this.save();
      }
      if (!rssColumns.includes('payment_timing')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN payment_timing TEXT');
        this.save();
      }
      if (!rssColumns.includes('protocol_settlement_kind')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN protocol_settlement_kind TEXT');
        this.save();
      }
      if (!rssColumns.includes('metadata')) {
        this.db.run('ALTER TABLE remote_skill_service ADD COLUMN metadata TEXT');
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

    // MetaID-anchored objective experience ledger. The owning store calls the
    // same idempotent schema function when it is constructed independently.
    ensureMetaIDExperienceSchema(this.db);
    // Observer-owned impression observations and their rebuildable read model.
    ensureMetaIDImpressionSchema(this.db);
    // Explicit shared-memory grants and the append-only access audit trail.
    ensureMetaIDMemoryGrantSchema(this.db);
    // Knowledge-point anchored memory ("经验/知识点"): forward-looking, updatable,
    // KV-shaped know-how/pitfalls keyed by topic. Same idempotent pattern.
    ensureMetaIDKnowledgeSchema(this.db);
    // Knowledge base registry ("知识库"): per-bot raw-document corpora metadata.
    // The corpus files and derived search index live on the filesystem; this is
    // only the registry. Same idempotent pattern.
    ensureKnowledgeBaseSchema(this.db);
    // MetaWeb study jobs ("自主学习任务"): the M4 owner-assigned study-topic
    // queue drained by nightly bounded background sessions. Same pattern.
    ensureMetawebStudyJobSchema(this.db);
    // MetaWeb surf ("AI 冲浪"): surf-run history + per-protocol watermarks +
    // seen-pin ledger. Same idempotent pattern.
    ensureMetawebSurfSchema(this.db);
    // Chain content history ("链上内容经历"): what each bot published to the
    // chain (buzz/simplenote/metafile/…) and what it fully read from the
    // chain. Same idempotent pattern.
    ensureChainContentHistorySchema(this.db);
    // Bot wallet transfer ledger (R2 audit): every wallet_transfer attempt
    // (broadcast/refused/failed) with txid/from/to/amount/fee/session.
    // Same idempotent pattern.
    ensureBotWalletTransferSchema(this.db);

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

  /**
   * Migration: Add msg_index to group_chat_messages. Both the socket push and the
   * history API GroupChatItem carry an `index` field; it is the M1 backfill cursor.
   * Best-effort backfills existing rows from the `index` field in raw_data JSON.
   */
  private migrateGroupChatMessagesMsgIndex(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_chat_messages)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('msg_index')) return;
      this.db.run('ALTER TABLE group_chat_messages ADD COLUMN msg_index INTEGER');
      try {
        const rowsResult = this.db.exec(
          'SELECT id, raw_data FROM group_chat_messages WHERE raw_data IS NOT NULL'
        );
        const rows = rowsResult[0]?.values || [];
        for (const row of rows) {
          const id = row[0] as number;
          const rawData = row[1] as string;
          try {
            const parsed = JSON.parse(rawData) as { index?: unknown };
            if (typeof parsed.index === 'number' && Number.isFinite(parsed.index)) {
              this.db.run('UPDATE group_chat_messages SET msg_index = ? WHERE id = ?', [
                Math.trunc(parsed.index),
                id,
              ]);
            }
          } catch {
            // Skip rows with unparseable raw_data.
          }
        }
      } catch (backfillError) {
        console.warn('migrateGroupChatMessagesMsgIndex backfill:', backfillError);
      }
      this.save();
    } catch (e) {
      console.warn('migrateGroupChatMessagesMsgIndex:', e);
    }
  }

  /**
   * Migration (round-4 attribution): add sender_suspect to group_chat_messages.
   * The chain-signature GlobalMetaID is the ONLY identity source for group-task
   * attribution; a message whose resolved GlobalMetaID is neither a task member
   * nor the owner is flagged (default 0 = trusted) so the daemon and the UI can
   * surface [SUSPECT] instead of misattributing by sender_name.
   */
  private migrateGroupChatMessagesSenderSuspect(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_chat_messages)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('sender_suspect')) return;
      this.db.run('ALTER TABLE group_chat_messages ADD COLUMN sender_suspect INTEGER NOT NULL DEFAULT 0');
      this.save();
    } catch (e) {
      console.warn('migrateGroupChatMessagesSenderSuspect:', e);
    }
  }

  /**
   * Migration: add protocol_paths to agent_game_grants (forward-compatible
   * column for auto-write authorization). No-op once present.
   */
  private migrateAgentGameGrantsProtocolPaths(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(agent_game_grants)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('protocol_paths')) return;
      this.db.run('ALTER TABLE agent_game_grants ADD COLUMN protocol_paths TEXT');
      this.save();
    } catch (e) {
      console.warn('migrateAgentGameGrantsProtocolPaths:', e);
    }
  }

  /**
   * Migration: ensure agent_game_write_log carries the idempotency unique index
   * on (group_id, action_seq, event_id). For DBs created before the column was
   * UNIQUE, recreate the index; no-op otherwise. Best-effort, non-destructive.
   */
  private migrateAgentGameWriteLogEventIdUnique(): void {
    try {
      const exists = this.db.exec(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_game_write_log'`,
      );
      if (!exists[0]?.values?.length) return;
      // Detect whether the UNIQUE constraint is already declared on the table.
      const sqlRow = this.db.exec(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_game_write_log'`,
      );
      const ddl = String(sqlRow[0]?.values?.[0]?.[0] ?? '');
      if (/event_id[^,]*UNIQUE/i.test(ddl) || /UNIQUE[^)]*event_id/i.test(ddl)) return;
      // Backfill any duplicates (keep lowest id) before adding the constraint.
      this.db.run(
        `DELETE FROM agent_game_write_log WHERE id NOT IN (
           SELECT MIN(id) FROM agent_game_write_log GROUP BY group_id, action_seq, event_id
         )`,
      );
      this.db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_game_write_log_dedup
           ON agent_game_write_log(group_id, action_seq, event_id)`,
      );
      this.save();
    } catch (e) {
      console.warn('migrateAgentGameWriteLogEventIdUnique:', e);
    }
  }

  /**
   * Migration: OpenTeam remote members — display_name is the inviter-side name
   * snapshot for members without a local metabots row (metabot_id IS NULL);
   * removed_at marks kicked members (M3) without deleting history, and
   * remove_pin_id records the on-chain removeuser pin for audit.
   */
  private migrateGroupTaskMembersOpenTeamColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_members)');
      let columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      if (!columns.includes('display_name')) {
        this.db.run('ALTER TABLE group_task_members ADD COLUMN display_name TEXT');
        columns = [...columns, 'display_name'];
        changed = true;
      }
      if (!columns.includes('removed_at')) {
        this.db.run('ALTER TABLE group_task_members ADD COLUMN removed_at TEXT');
        columns = [...columns, 'removed_at'];
        changed = true;
      }
      if (!columns.includes('remove_pin_id')) {
        this.db.run('ALTER TABLE group_task_members ADD COLUMN remove_pin_id TEXT');
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskMembersOpenTeamColumns:', error);
    }
  }

  /**
   * Migration (P0-2): member state-machine status columns. status defaults to
   * 'assigned' at the SQL level; rowToGroupTaskMember upgrades chair rows to
   * 'working' for legacy rows without a status. Idempotent PRAGMA-guarded.
   */
  private migrateGroupTaskMembersStatusColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_members)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      if (!columns.includes('status')) {
        this.db.run(
          "ALTER TABLE group_task_members ADD COLUMN status TEXT NOT NULL DEFAULT 'assigned'",
        );
        changed = true;
      }
      if (!columns.includes('status_changed_at')) {
        this.db.run('ALTER TABLE group_task_members ADD COLUMN status_changed_at TEXT');
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskMembersStatusColumns:', error);
    }
  }

  /**
   * Migration (P0-4): deliverable verification report column (JSON text).
   * Idempotent PRAGMA-guarded; existing rows stay NULL (unverified).
   */
  private migrateGroupTaskDeliverablesVerification(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_deliverables)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('verification')) {
        this.db.run('ALTER TABLE group_task_deliverables ADD COLUMN verification TEXT');
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskDeliverablesVerification:', error);
    }
  }

  /**
   * Migration (P2): deliverable content-hash column (sha256 hex of the
   * deliverable bytes), the dedupe key for same-bytes re-registrations.
   * Idempotent PRAGMA-guarded; existing rows stay NULL (unhashed) until the
   * daemon's verification pass backfills them.
   */
  private migrateGroupTaskDeliverablesContentHash(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_deliverables)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('content_hash')) {
        this.db.run('ALTER TABLE group_task_deliverables ADD COLUMN content_hash TEXT');
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskDeliverablesContentHash:', error);
    }
  }

  /**
   * Migration (Issue #8): deliverable on-chain confirmation state column.
   * Idempotent PRAGMA-guarded; existing rows default to 'unconfirmed' and get
   * flipped by the daemon's next verification pass (record-time or monitor).
   */
  private migrateGroupTaskDeliverablesConfirmation(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_deliverables)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('confirmation')) {
        this.db.run(
          `ALTER TABLE group_task_deliverables ADD COLUMN confirmation TEXT
           NOT NULL DEFAULT 'unconfirmed'`,
        );
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskDeliverablesConfirmation:', error);
    }
  }

  /**
   * Migration (Improvement #4, v1.3 + Improvement #1, single-card acceptance):
   * additive acceptance-summary columns — the plan-changes JSON snapshot and
   * the chair's stored conclusion. Idempotent PRAGMA-guarded; existing rows
   * keep NULL (no plan change disclosed / verdict not captured).
   */
  private migrateGroupTaskAcceptanceSummariesPlanChanges(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_acceptance_summaries)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('plan_changes_json')) {
        this.db.run(
          'ALTER TABLE group_task_acceptance_summaries ADD COLUMN plan_changes_json TEXT;',
        );
        this.save();
      }
      if (!columns.includes('conclusion')) {
        this.db.run(
          'ALTER TABLE group_task_acceptance_summaries ADD COLUMN conclusion TEXT;',
        );
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskAcceptanceSummariesPlanChanges:', error);
    }
  }

  /**
   * Migration (G-05): per-criterion verdicts + non-blocking observations on
   * acceptance summaries. Idempotent PRAGMA-guarded; existing rows stay NULL
   * (verdicts not captured — the card falls back to the raw criteria preview).
   */
  private migrateGroupTaskAcceptanceSummariesCriteriaVerdicts(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_acceptance_summaries)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('criteria_verdicts_json')) {
        this.db.run(
          'ALTER TABLE group_task_acceptance_summaries ADD COLUMN criteria_verdicts_json TEXT;',
        );
        this.save();
      }
      if (!columns.includes('observations_json')) {
        this.db.run(
          'ALTER TABLE group_task_acceptance_summaries ADD COLUMN observations_json TEXT;',
        );
        this.save();
      }
      if (!columns.includes('supervisor_signals_json')) {
        this.db.run(
          'ALTER TABLE group_task_acceptance_summaries ADD COLUMN supervisor_signals_json TEXT;',
        );
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskAcceptanceSummariesCriteriaVerdicts:', error);
    }
  }

  /** Speedup R-06: add the time-breakdown snapshot column (idempotent). */
  private migrateGroupTaskAcceptanceSummariesTimeBreakdown(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_acceptance_summaries)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('time_breakdown_json')) {
        this.db.run(
          'ALTER TABLE group_task_acceptance_summaries ADD COLUMN time_breakdown_json TEXT;',
        );
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskAcceptanceSummariesTimeBreakdown:', error);
    }
  }

  private migrateGroupTaskAcceptanceSummariesSupersededAt(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_task_acceptance_summaries)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('superseded_at')) {
        this.db.run(
          'ALTER TABLE group_task_acceptance_summaries ADD COLUMN superseded_at TEXT;',
        );
        this.save();
      }
    } catch (error) {
      console.warn('migrateGroupTaskAcceptanceSummariesSupersededAt:', error);
    }
  }

  /**
   * Migration (P3, v1.1): widen the deliverable status CHECK to include
   * 'delivered' — a deliverable whose pin verified on-chain must not keep
   * reading 'pending' (task #22: uri populated + verified, enum stuck at
   * 'pending'). SQLite cannot ALTER a CHECK constraint, so the table is
   * rebuilt once inside a transaction: every row is copied verbatim
   * (data-preserving), then the legacy table is dropped. Fresh installs
   * already create the widened table via the base DDL, and the migration
   * no-ops when the stored schema already carries 'delivered'.
   */
  private migrateGroupTaskDeliverablesDeliveredStatus(): void {
    try {
      const schemaResult = this.db.exec(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'group_task_deliverables' LIMIT 1",
      );
      const schemaSql = String(schemaResult[0]?.values?.[0]?.[0] ?? '');
      if (!schemaSql) return; // table absent (created later by the base DDL)
      if (schemaSql.includes("'delivered'")) return; // already widened
      this.db.run('BEGIN TRANSACTION;');
      try {
        this.db.run(
          'ALTER TABLE group_task_deliverables RENAME TO group_task_deliverables_legacy_status_migration;',
        );
        this.db.run(`
          CREATE TABLE group_task_deliverables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            msg_pin_id TEXT,
            author_globalmetaid TEXT,
            kind TEXT,
            uri TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','accepted','rejected')),
            confirmation TEXT NOT NULL DEFAULT 'unconfirmed'
              CHECK(confirmation IN ('unconfirmed','confirmed')),
            verification TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);
        this.db.run(`
          INSERT INTO group_task_deliverables
            (id, task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, verification, created_at)
          SELECT
            id, task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, verification, created_at
          FROM group_task_deliverables_legacy_status_migration
        `);
        this.db.run('DROP TABLE group_task_deliverables_legacy_status_migration;');
        this.db.run('COMMIT;');
        this.save();
      } catch (innerError) {
        this.db.run('ROLLBACK;');
        throw innerError;
      }
    } catch (error) {
      console.warn('migrateGroupTaskDeliverablesDeliveredStatus:', error);
    }
  }

  /**
   * Migration: legacy metaId identity form on openteam_invites (OpenTeam
   * join-confirmation watchers). PRAGMA-guarded and idempotent; existing rows
   * keep NULL (their watchers fall back to the GlobalMetaID form only).
   */
  private migrateOpenTeamInvitesMetaIdColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(openteam_invites)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('invitee_metaid')) {
        this.db.run('ALTER TABLE openteam_invites ADD COLUMN invitee_metaid TEXT');
        this.save();
      }
    } catch (error) {
      console.warn('migrateOpenTeamInvitesMetaIdColumn:', error);
    }
  }

  /**
   * Migration: join pin of the ACCEPT envelope on openteam_invites (P1-2).
   * The guest echoes its join pin in [OPENTEAM_ACCEPT]; persisting it here lets
   * the inviter's watcher copy it into the remote member row when the join is
   * confirmed, so "already joined" becomes readable from the member row.
   * PRAGMA-guarded and idempotent; existing accepted rows keep NULL (their
   * member rows keep NULL too until the next join).
   */
  private migrateOpenTeamInvitesJoinedPinColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(openteam_invites)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('joined_pin_id')) {
        this.db.run('ALTER TABLE openteam_invites ADD COLUMN joined_pin_id TEXT');
        this.save();
      }
    } catch (error) {
      console.warn('migrateOpenTeamInvitesJoinedPinColumn:', error);
    }
  }

  /**
   * Migration: required-skills on openteam_invites (#13 join-welcome handshake).
   * The inviter stores the invite's required_skills (JSON array text) so the
   * daemon's welcome broadcast can state WHY the remote member was invited.
   * PRAGMA-guarded and idempotent; existing rows keep NULL (welcome falls back
   * to a generic "invited to collaborate on this task").
   */
  private migrateOpenTeamInvitesRequiredSkillsColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(openteam_invites)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('required_skills')) {
        this.db.run('ALTER TABLE openteam_invites ADD COLUMN required_skills TEXT');
        this.save();
      }
    } catch (error) {
      console.warn('migrateOpenTeamInvitesRequiredSkillsColumn:', error);
    }
  }

  /**
   * Migration: guest-daemon message cursor on openteam_memberships (OpenTeam
   * M1). PRAGMA-guarded and idempotent, same pattern as the other column
   * migrations; existing rows start at 0 (process from the group history the
   * daemon already sees, then the accept flow catches the cursor up).
   */
  private migrateOpenTeamMembershipsCursorColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(openteam_memberships)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('last_processed_msg_id')) {
        this.db.run(
          'ALTER TABLE openteam_memberships ADD COLUMN last_processed_msg_id INTEGER NOT NULL DEFAULT 0',
        );
        this.save();
      }
    } catch (error) {
      console.warn('migrateOpenTeamMembershipsCursorColumn:', error);
    }
  }

  /**
   * Migration: activation timestamp on openteam_memberships (guest self-check
   * grace anchor). created_at cannot serve here because upsertActiveMembership
   * reviving an old row does not refresh it. PRAGMA-guarded and idempotent;
   * existing rows are backfilled from created_at (they were activated when the
   * row was created), so an upgrade does not grant a fresh grace window.
   */
  private migrateOpenTeamMembershipsActivatedColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(openteam_memberships)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('activated_at')) {
        this.db.run('ALTER TABLE openteam_memberships ADD COLUMN activated_at TEXT');
        this.db.run('UPDATE openteam_memberships SET activated_at = created_at WHERE activated_at IS NULL');
        this.save();
      }
    } catch (error) {
      console.warn('migrateOpenTeamMembershipsActivatedColumn:', error);
    }
  }

  /**
   * Migration: left_at / left_cause / left_reason on openteam_memberships (the
   * guest-side "you were removed" notice, R4). PRAGMA-guarded and idempotent;
   * rows that already left before this migration keep NULL cause/reason and
   * simply render as a plain "Left" in the collab view.
   */
  private migrateOpenTeamMembershipsLeftColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(openteam_memberships)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      if (!columns.includes('left_at')) {
        this.db.run('ALTER TABLE openteam_memberships ADD COLUMN left_at TEXT');
        changed = true;
      }
      if (!columns.includes('left_cause')) {
        this.db.run('ALTER TABLE openteam_memberships ADD COLUMN left_cause TEXT');
        changed = true;
      }
      if (!columns.includes('left_reason')) {
        this.db.run('ALTER TABLE openteam_memberships ADD COLUMN left_reason TEXT');
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (error) {
      console.warn('migrateOpenTeamMembershipsLeftColumns:', error);
    }
  }

  /**
   * Migration: task_status / task_status_updated_at on openteam_memberships
   * (guest-side host-task status sync). The guest learns the host task's status
   * from the chair's `[STATUS:...]` group messages and persists the latest here
   * so the collab view can show 待验收/已完成/已取消 instead of an eternal
   * "active". PRAGMA-guarded and idempotent; existing rows stay NULL (unknown)
   * until the guest daemon's one-time transcript backfill re-derives them.
   */
  private migrateOpenTeamMembershipsTaskStatusColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(openteam_memberships)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      if (!columns.includes('task_status')) {
        this.db.run('ALTER TABLE openteam_memberships ADD COLUMN task_status TEXT');
        changed = true;
      }
      if (!columns.includes('task_status_updated_at')) {
        this.db.run('ALTER TABLE openteam_memberships ADD COLUMN task_status_updated_at TEXT');
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (error) {
      console.warn('migrateOpenTeamMembershipsTaskStatusColumns:', error);
    }
  }

  /**
   * R1 (OpenTeam chat scenario): add group_mode to openteam_memberships —
   * 'task' | 'chat' as declared by the inviter and carried on the invite
   * envelope. NULL (legacy rows / older inviters) reads as 'task'.
   */
  private migrateOpenTeamMembershipsGroupModeColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(openteam_memberships)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('group_mode')) return;
      this.db.run("ALTER TABLE openteam_memberships ADD COLUMN group_mode TEXT");
      this.save();
    } catch (error) {
      console.warn('migrateOpenTeamMembershipsGroupModeColumn:', error);
    }
  }

  /**
   * Migration: bind each observable Group Task to at most one canonical Twin
   * orchestration task. Existing tasks remain valid and are reconciled lazily.
   */
  private migrateGroupTaskOrchestrationLink(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('orchestration_task_id')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN orchestration_task_id TEXT');
      }
      this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_group_tasks_orchestration_task
          ON group_tasks(orchestration_task_id)
      `);
      this.save();
    } catch (error) {
      console.warn('migrateGroupTaskOrchestrationLink:', error);
    }
  }

  /**
   * Migration (long-task board, task #83): give `scheduled_tasks` the same
   * at-most-one-card binding `group_tasks` already has, so a scheduled task can
   * hang on the shared ledger card. ADD COLUMN only — no fourth table.
   * Existing rows get NULL, which the board reads as "not on a card yet".
   */
  private migrateScheduledTaskOrchestrationLink(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(scheduled_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('orchestration_task_id')) {
        this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN orchestration_task_id TEXT');
      }
      this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_orchestration_task
          ON scheduled_tasks(orchestration_task_id)
      `);
      this.save();
    } catch (error) {
      console.warn('migrateScheduledTaskOrchestrationLink:', error);
    }
  }

  /**
   * Migration (long-task board, task #83): the closing conclusion is an
   * authoritative property of the card, so it lives on the single ledger row.
   * All four columns are NULLABLE with no CHECK — a NULL conclusion means
   * "not closed yet", and altering a CHECK would force a table rebuild of the
   * shared Twin orchestration ledger.
   */
  /**
   * Migration (long-task board v1.2, task #86 §2.1): the conclusion is executed,
   * so the row also carries its processing mark and the receipt. Five NULLABLE
   * ADD COLUMNs on the same ledger, no CHECK, no table rebuild — the derived
   * "still pending" verdict is recomputed at read time, never stored as a flag.
   *
   * `closure_processed_hash` binds the mark to the EXACT conclusion text, which
   * is what makes a later conclusion on an already-acked card re-enter the queue
   * (freeze doc §3.1 T1) without any "claim" intermediate state.
   */
  private migrateOrchestrationTaskClosureProcessingColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(orchestration_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      const additions: Array<[string, string]> = [
        ['closure_processed_at', 'TEXT'],
        ['closure_processed_by', 'TEXT'],
        ['closure_processed_hash', 'TEXT'],
        ['closure_receipt', 'TEXT'],
        ['closure_receipt_pin_id', 'TEXT'],
      ];
      for (const [name, type] of additions) {
        if (!columns.includes(name)) {
          this.db.run(`ALTER TABLE orchestration_tasks ADD COLUMN ${name} ${type}`);
        }
      }
      this.save();
    } catch (error) {
      console.warn('migrateOrchestrationTaskClosureProcessingColumns:', error);
    }
  }

  /**
   * Migration (long-task board v1.5, owner ruling 「谁发起，谁验收」): the
   * ledger row records WHO initiated the card — `origin` ∈ {'owner',
   * 'twin_delegate'}, NOT NULL DEFAULT 'owner', no CHECK (same no-rebuild
   * discipline as the closure columns above). The default keeps every legacy
   * row in the owner-closable population; pre-v1.5 Twin-delegated cards are
   * backfilled to 'twin_delegate' by the frozen legacy-window id list AND by
   * the structural predicate below (release audit 2026-09-19: the id list
   * only ever covered the dev install, so the same cards on any OTHER
   * upgrading database kept origin='owner' and the v1.5 guarantee — "an
   * internal Twin card never reaches the owner's closure queue" — silently
   * did not apply there).
   */
  private migrateOrchestrationTaskOriginColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(orchestration_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('origin')) {
        this.db.run("ALTER TABLE orchestration_tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner'");
      }
      // Precise backfill of the pre-v1.5 Twin-delegated cards that leaked
      // into the owner's pending-closure queue (frozen legacy-window list).
      // Idempotent:
      // on a re-run the WHERE clause matches only 'owner' rows, so an already
      // backfilled (or differently-origin'd) row is never touched twice.
      for (const id of TWIN_DELEGATED_CARD_IDS) {
        this.db.run(
          "UPDATE orchestration_tasks SET origin = 'twin_delegate' WHERE id = ? AND origin = 'owner'",
          [id],
        );
      }
      // Release-audit follow-up 2026-09-19 — the STRUCTURAL predicate: a card
      // with NO group_tasks link and NO scheduled_tasks link is, by
      // construction, a Twin-delegated internal card. Every owner-reachable
      // creation path links the card at creation time: the group bridge calls
      // linkOrchestrationTask in the same synchronous block, and the board's
      // scheduled attach writes the scheduled_tasks link immediately after
      // createTask (both verified back to v0.9.4 — the only unlinked creator
      // that has ever existed is delegateLocalWorker). This flips the
      // pre-v1.5 delegation cards on OTHER upgrading installs, which the
      // frozen id list (dev-machine ids only) could never reach; cards with
      // any link keep the read-time closerRole derivation as their authority.
      // Idempotent: only 'owner' rows match, and flipping removes the match.
      this.db.run(`
        UPDATE orchestration_tasks
           SET origin = 'twin_delegate'
         WHERE origin = 'owner'
           AND NOT EXISTS (SELECT 1 FROM group_tasks g WHERE g.orchestration_task_id = orchestration_tasks.id)
           AND NOT EXISTS (SELECT 1 FROM scheduled_tasks s WHERE s.orchestration_task_id = orchestration_tasks.id)
      `);
      this.save();
    } catch (error) {
      console.warn('migrateOrchestrationTaskOriginColumn:', error);
    }
  }

  private migrateOrchestrationTaskClosureColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(orchestration_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      const additions: Array<[string, string]> = [
        ['closure_conclusion', 'TEXT'],
        ['closure_by', 'TEXT'],
        ['closure_at', 'TEXT'],
        ['closure_pin_id', 'TEXT'],
      ];
      for (const [name, type] of additions) {
        if (!columns.includes(name)) {
          this.db.run(`ALTER TABLE orchestration_tasks ADD COLUMN ${name} ${type}`);
        }
      }
      this.save();
    } catch (error) {
      console.warn('migrateOrchestrationTaskClosureColumns:', error);
    }
  }

  /**
   * Migration (round-4): add last_driven_at (epoch seconds) to group_tasks —
   * heartbeat of the daemon's last drive, used for the stall signal. No-op
   * once present; existing tasks get null (stall falls back to updated_at).
   */
  private migrateGroupTasksLastDrivenAt(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('last_driven_at')) return;
      this.db.run('ALTER TABLE group_tasks ADD COLUMN last_driven_at INTEGER');
      this.save();
    } catch (e) {
      console.warn('migrateGroupTasksLastDrivenAt:', e);
    }
  }

  /**
   * Migration (G-04): supervisor pause gate on group_tasks — epoch ms while
   * dispatch is paused by a supervisor `pause` signal, NULL = running. While
   * set, the daemon holds the planning turn and chair dispatch replies and
   * resume requires explicit owner confirmation.
   */
  private migrateGroupTasksDispatchPausedAt(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('dispatch_paused_at')) return;
      this.db.run('ALTER TABLE group_tasks ADD COLUMN dispatch_paused_at INTEGER');
      this.save();
    } catch (e) {
      console.warn('migrateGroupTasksDispatchPausedAt:', e);
    }
  }

  /**
   * R1 (OpenTeam chat scenario): add `mode` to group_tasks — 'task' (classic
   * dispatch-deliver-accept pipeline) or 'chat' (free-form conversation, task
   * monitoring exempted). Idempotent PRAGMA-guarded; legacy rows fall back to
   * the column default 'task' so pre-existing groups keep their behavior.
   */
  private migrateGroupTasksModeColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('mode')) return;
      this.db.run(
        "ALTER TABLE group_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'task' CHECK(mode IN ('task','chat'))",
      );
      this.save();
    } catch (e) {
      console.warn('migrateGroupTasksModeColumn:', e);
    }
  }

  /**
   * Migration: owner acceptance rating on group_tasks — rating (1-5 integer,
   * validated in code), rating_comment (optional free text), rated_at. No-op
   * once present; existing tasks keep NULL (unrated history stays unrated).
   */
  /** P3 culture metric: communication-entropy columns stamped at task close. */
  private migrateGroupTasksCommStats(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      if (!columns.includes('comm_total_bytes')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN comm_total_bytes INTEGER');
        changed = true;
      }
      if (!columns.includes('comm_message_count')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN comm_message_count INTEGER');
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (error) {
      console.warn('[SqliteStore] group_tasks comm-stats migration failed:', error);
    }
  }

  private migrateGroupTasksRatingColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_tasks)');
      let columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      if (!columns.includes('rating')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN rating INTEGER');
        columns = [...columns, 'rating'];
        changed = true;
      }
      if (!columns.includes('rating_comment')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN rating_comment TEXT');
        columns = [...columns, 'rating_comment'];
        changed = true;
      }
      if (!columns.includes('rated_at')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN rated_at TEXT');
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (e) {
      console.warn('migrateGroupTasksRatingColumns:', e);
    }
  }

  /**
   * Migration: local-only group task UI state — display_name (user-chosen
   * local display name overriding the on-chain title), pinned (0/1) and
   * archived_at (epoch ms; NULL = active). Archive hides the task from the
   * list without deleting it; existing tasks keep NULL (active, unpinned,
   * chain title) until the user changes them.
   */
  private migrateGroupTasksLocalState(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_tasks)');
      let columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      if (!columns.includes('display_name')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN display_name TEXT');
        columns = [...columns, 'display_name'];
        changed = true;
      }
      if (!columns.includes('pinned')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
        columns = [...columns, 'pinned'];
        changed = true;
      }
      if (!columns.includes('archived_at')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN archived_at INTEGER');
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (e) {
      console.warn('migrateGroupTasksLocalState:', e);
    }
  }

  /**
   * R2: source_session_id column on group_tasks — the originating CoWork
   * session that created the group task, so the host can relay the acceptance
   * result back to it on close ("哪里发起哪里结束"). Idempotent PRAGMA-guarded;
   * existing rows stay NULL (relay degrades to owner-private-only for them,
   * never retroactively backfilled).
   */
  private migrateGroupTasksSourceSessionId(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(group_tasks)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('source_session_id')) {
        this.db.run('ALTER TABLE group_tasks ADD COLUMN source_session_id TEXT');
        this.save();
      }
    } catch (e) {
      console.warn('migrateGroupTasksSourceSessionId:', e);
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
      const infoRows = (colsResult[0]?.values ?? []) as unknown[][];
      const columns = infoRows.map((row) => row[1]) as string[];
      if (!columns.includes('metabot_info_pinid')) return;

      // A leftover metabots_new can only be debris from an earlier failed run of
      // this migration (success renames it away); drop it before recreating.
      this.db.run('DROP TABLE IF EXISTS metabots_new');
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
        metabot_type TEXT CHECK(metabot_type IN ('twin', 'worker', 'welcome')) NOT NULL,
        created_by TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        goal TEXT,
        bio TEXT,
        background TEXT,
        boss_id INTEGER,
        llm_id TEXT,
        tools TEXT DEFAULT '[]',
        skills TEXT DEFAULT '[]',
        allow_chat_skills TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL${buildMetabotsRebuildExtrasDdl(infoRows)},
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
      const infoRows = (colsResult[0]?.values ?? []) as unknown[][];
      const columns = infoRows.map((row) => row[1]) as string[];
      if (!columns.includes('chat_public_key_pin_id')) return;

      // A leftover metabots_new can only be debris from an earlier failed run of
      // this migration (success renames it away); drop it before recreating.
      this.db.run('DROP TABLE IF EXISTS metabots_new');
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
        metabot_type TEXT CHECK(metabot_type IN ('twin', 'worker', 'welcome')) NOT NULL,
        created_by TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        goal TEXT,
        bio TEXT,
        background TEXT,
        boss_id INTEGER,
        llm_id TEXT,
        tools TEXT DEFAULT '[]',
        skills TEXT DEFAULT '[]',
        allow_chat_skills TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL${buildMetabotsRebuildExtrasDdl(infoRows)},
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

  /**
   * Migration: Recreate metabots with the 'welcome' system bot type admitted
   * by the CHECK constraint. Existing databases baked the old
   * CHECK(metabot_type IN ('twin','worker')), and SQLite cannot alter a CHECK,
   * so the table is rebuilt in place (same pattern as
   * migrateChatPublicKeyPinIdOptional). Guarded by a kv flag; the rebuilt
   * table carries every column the source table currently has.
   */
  private migrateMetabotWelcomeType(): void {
    try {
      const migrated = this.get<boolean>(METABOT_WELCOME_TYPE_MIGRATION_KEY);
      if (migrated) return;

      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      const infoRows = (colsResult[0]?.values ?? []) as unknown[][];
      const columns = infoRows.map((row) => row[1]) as string[];
      if (!columns.includes('metabot_type')) {
        this.set(METABOT_WELCOME_TYPE_MIGRATION_KEY, true);
        return;
      }

      // A leftover metabots_new can only be debris from an earlier failed run
      // of this migration; drop it before recreating.
      this.db.run('DROP TABLE IF EXISTS metabots_new');
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
        metabot_type TEXT CHECK(metabot_type IN ('twin', 'worker', 'welcome')) NOT NULL,
        created_by TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        goal TEXT,
        bio TEXT,
        background TEXT,
        boss_id INTEGER,
        llm_id TEXT,
        tools TEXT DEFAULT '[]',
        skills TEXT DEFAULT '[]',
        allow_chat_skills TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL${buildMetabotsRebuildExtrasDdl(infoRows)},
        FOREIGN KEY (wallet_id) REFERENCES metabot_wallets(id) ON DELETE RESTRICT,
        FOREIGN KEY (boss_id) REFERENCES metabots_new(id)
      )`);

      const colList = columns.join(', ');
      this.db.run(`INSERT INTO metabots_new (${colList}) SELECT ${colList} FROM metabots`);
      this.db.run('DROP TABLE metabots');
      this.db.run('ALTER TABLE metabots_new RENAME TO metabots');
      this.set(METABOT_WELCOME_TYPE_MIGRATION_KEY, true);
      this.db.run('PRAGMA foreign_keys = ON');
    } catch (e) {
      console.warn('migrateMetabotWelcomeType:', e);
      this.db.run('PRAGMA foreign_keys = ON');
    }
  }

  private migrateMetabotAllowChatSkills(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('allow_chat_skills')) return;
      this.db.run("ALTER TABLE metabots ADD COLUMN allow_chat_skills TEXT DEFAULT '[]'");
      this.db.run("UPDATE metabots SET allow_chat_skills = '[]' WHERE allow_chat_skills IS NULL OR allow_chat_skills = ''");
      this.save();
    } catch (error) {
      console.warn('migrateMetabotAllowChatSkills:', error);
    }
  }

  private migrateMetabotBioColumn(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      let columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      if (!columns.includes('bio')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN bio TEXT');
        columns = [...columns, 'bio'];
        changed = true;
      }
      if (!columns.includes('background')) return;
      this.db.run(`
        UPDATE metabots
        SET bio = background
        WHERE (bio IS NULL OR trim(bio) = '')
          AND background IS NOT NULL
          AND trim(background) <> ''
      `);
      if ((this.db.getRowsModified?.() ?? 0) > 0) {
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (error) {
      console.warn('migrateMetabotBioColumn:', error);
    }
  }

  private migrateMetabotFallbackLlmId(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (columns.includes('fallback_llm_id')) return;
      this.db.run('ALTER TABLE metabots ADD COLUMN fallback_llm_id TEXT');
      this.save();
    } catch (error) {
      console.warn('migrateMetabotFallbackLlmId:', error);
    }
  }

  /**
   * Migration: model-level LLM brains. llm_id/fallback_llm_id move from
   * storing a provider key to storing a model id (legacy provider-key values
   * keep resolving at call time and are NOT rewritten); the new columns pin
   * the provider the model was picked from (id-collision disambiguation) and
   * the per-brain reasoning effort (off/low/high/max, NULL = model default).
   *
   * The columns are deliberately absent from the fresh-database CREATE TABLE
   * DDL and always land via this ALTER: the earlier one-shot rebuild
   * migrations (info-pinid / chat-pubkey / welcome-type) re-create the table
   * from an explicit column list and would drop columns they do not know
   * about. Running last keeps one source of truth for both fresh and legacy
   * databases.
   */
  private migrateMetabotLlmBrainColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      let columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      const addColumn = (name: string) => {
        if (columns.includes(name)) return;
        this.db.run(`ALTER TABLE metabots ADD COLUMN ${name} TEXT`);
        columns = [...columns, name];
        changed = true;
      };
      addColumn('llm_provider');
      addColumn('llm_effort');
      addColumn('fallback_llm_provider');
      addColumn('fallback_llm_effort');
      if (changed) {
        this.save();
      }
    } catch (error) {
      console.warn('migrateMetabotLlmBrainColumns:', error);
    }
  }

  private migrateMetabotA2AChatLimits(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      let columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      let changed = false;
      // Nullable columns: NULL means "use the app default" (30 turns / 5 min).
      if (!columns.includes('a2a_max_incoming_turns')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN a2a_max_incoming_turns INTEGER');
        columns = [...columns, 'a2a_max_incoming_turns'];
        changed = true;
      }
      if (!columns.includes('a2a_bye_cooldown_ms')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN a2a_bye_cooldown_ms INTEGER');
        columns = [...columns, 'a2a_bye_cooldown_ms'];
        changed = true;
      }
      if (!columns.includes('a2a_auto_reply_enabled')) {
        this.db.run('ALTER TABLE metabots ADD COLUMN a2a_auto_reply_enabled INTEGER');
        changed = true;
      }
      if (changed) {
        this.save();
      }
    } catch (error) {
      console.warn('migrateMetabotA2AChatLimits:', error);
    }
  }

  private migrateOrphanMetabotBossIds(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('boss_id')) return;
      this.db.run(`
        UPDATE metabots
        SET boss_id = NULL
        WHERE boss_id IS NOT NULL
          AND (
            boss_id <= 0
            OR boss_id = id
            OR NOT EXISTS (
              SELECT 1 FROM metabots AS parent
              WHERE parent.id = metabots.boss_id
            )
          )
      `);
      if ((this.db.getRowsModified?.() ?? 0) > 0) {
        this.save();
      }
    } catch (error) {
      console.warn('migrateOrphanMetabotBossIds:', error);
    }
  }

  /**
   * One-shot backfill for the machine-wide unique-Twin rule:
   * a) normalize missing/unknown metabot_type values to 'worker';
   * b) when several twins exist, keep the earliest-created one (lowest id on ties);
   * c) when no twin exists, promote the earliest-created non-welcome bot
   *    (lowest id on ties). The Welcome Bot is never auto-promoted.
   * Guarded by a kv flag so a user's later manual twin transfer is never
   * overwritten by a re-run.
   */
  private migrateMetabotTwinBackfill(): void {
    if (this.get<boolean>(METABOT_TWIN_BACKFILL_MIGRATION_KEY) === true) return;
    try {
      const colsResult = this.db.exec('PRAGMA table_info(metabots)');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      if (!columns.includes('metabot_type')) {
        this.set(METABOT_TWIN_BACKFILL_MIGRATION_KEY, true);
        return;
      }
      this.db.run(
        "UPDATE metabots SET metabot_type = 'worker' WHERE metabot_type IS NULL OR metabot_type NOT IN ('twin', 'worker', 'welcome')"
      );
      this.db.run(`
        UPDATE metabots SET metabot_type = 'worker'
        WHERE metabot_type = 'twin'
          AND id NOT IN (
            SELECT id FROM metabots WHERE metabot_type = 'twin' ORDER BY created_at ASC, id ASC LIMIT 1
          )
      `);
      this.db.run(`
        UPDATE metabots SET metabot_type = 'twin'
        WHERE id = (
          SELECT id FROM metabots
          WHERE metabot_type != 'welcome'
          ORDER BY created_at ASC, id ASC LIMIT 1
        )
          AND NOT EXISTS (SELECT 1 FROM metabots WHERE metabot_type = 'twin')
      `);
      // set() persists via its own save().
      this.set(METABOT_TWIN_BACKFILL_MIGRATION_KEY, true);
    } catch (error) {
      console.warn('migrateMetabotTwinBackfill:', error);
    }
  }

  /** Idempotently add user-identity bootstrap-state columns to user_identity. */
  private migrateUserIdentitySetupColumns(): void {
    try {
      const colsResult = this.db.exec('PRAGMA table_info(user_identity);');
      const columns = (colsResult[0]?.values?.map((row) => row[1]) || []) as string[];
      const additions: Array<[string, string]> = [
        ['subsidy_state', 'TEXT'],
        ['subsidy_error', 'TEXT'],
        ['name_pin_id', 'TEXT'],
        ['avatar_pin_id', 'TEXT'],
        ['sync_state', 'TEXT'],
        ['sync_error', 'TEXT'],
      ];
      let changed = false;
      for (const [col, decl] of additions) {
        if (!columns.includes(col)) {
          this.db.run(`ALTER TABLE user_identity ADD COLUMN ${col} ${decl};`);
          changed = true;
        }
      }
      if (changed) this.save();
    } catch (error) {
      console.warn('migrateUserIdentitySetupColumns:', error);
    }
  }

  save() {
    this.assertOpen();
    if (this.backendKind === 'native') {
      return;
    }
    const data = this.db.export();
    if (!data) {
      throw new Error('SQLite backend does not support export');
    }
    const buffer = Buffer.from(data);
    writeFileAtomicSync(this.dbPath, buffer);
  }

  /** Run lightweight SQLite maintenance without rewriting the whole database file. */
  optimize(): void {
    this.assertOpen();
    this.db.run('PRAGMA optimize;');
    this.save();
  }

  /** Run VACUUM only from explicit maintenance flows; this rewrites the in-memory database. */
  vacuum(): void {
    try {
      this.assertOpen();
      this.db.run('PRAGMA optimize;');
      this.db.run('VACUUM;');
      this.save();
    } catch (error) {
      console.warn('[SqliteStore] VACUUM failed:', error);
    }
  }

  healthCheck(): boolean {
    try {
      this.assertOpen();
      const result = this.db.exec('PRAGMA quick_check(1);');
      return String(result[0]?.values?.[0]?.[0] ?? '').toLowerCase() === 'ok';
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.db.close();
    this.isClosed = true;
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
    this.assertOpen();
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
    this.assertOpen();
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
    this.assertOpen();
    const oldValue = this.get(key);
    this.db.run('DELETE FROM kv WHERE key = ?', [key]);
    this.save();
    this.emitter.emit('change', { key, newValue: undefined, oldValue } as ChangePayload);
  }

  // Expose database for cowork operations
  getDatabase(): SqliteDatabase {
    this.assertOpen();
    return this.db;
  }

  // Expose save method for external use (e.g., CoworkStore)
  getSaveFunction(): () => void {
    return () => this.save();
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new Error('Database closed');
    }
  }

  private tryReadLegacyMemoryText(): string {
    // Prefer app-bound paths so behavior is consistent when started from different directories or packaged.
    const candidates: string[] = [];
    try {
      if (app?.getAppPath) {
        candidates.push(
          path.join(app.getAppPath(), 'MEMORY.md'),
          path.join(app.getAppPath(), 'memory.md'),
        );
      }
      if (app?.getPath) {
        const userDataPath = app.getPath('userData');
        candidates.push(
          path.join(userDataPath, 'MEMORY.md'),
          path.join(userDataPath, 'memory.md'),
        );
      }
    } catch {
      // Tests can instantiate SqliteStore outside Electron; skip app-bound legacy paths.
    }

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
      entries.push(text.length > 360 ? `${truncateUtf16Units(text, 359)}…` : text);
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
