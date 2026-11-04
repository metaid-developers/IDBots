import { randomUUID } from 'node:crypto';
import { queryRows } from './chainBackupData';
import type { SqliteDatabase } from '../sqliteTypes';

export type ChainBackupRunStatus = 'active' | 'complete' | 'superseded';
export type ChainBackupSegmentUploadStatus = 'pending' | 'uploading' | 'published';

export interface ChainBackupRunRow {
  run_id: string;
  bot_globalmetaid: string;
  plan_hash: string;
  status: ChainBackupRunStatus;
  created_at: number;
  updated_at: number;
  total_segments: number;
  published_segments: number;
  manifest_target_pinid: string | null;
  manifest_pinid: string | null;
  manifest_hash: string | null;
  manifest_attempts: number;
  last_error: string | null;
}

export interface ChainBackupSegmentUploadRow {
  bot_globalmetaid: string;
  segment_key: string;
  run_id: string;
  segment_hash: string;
  pin_id: string | null;
  status: ChainBackupSegmentUploadStatus;
  /** 'inline' (legacy JSON pin) or 'metafile' (/file binary pin). */
  storage: string;
  object_ids_json: string;
  kinds_json: string;
  plaintext_created_at: number;
  bytes: number;
  attempt_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function ensureChainBackupRunSchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chain_backup_runs (
      run_id TEXT PRIMARY KEY,
      bot_globalmetaid TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'complete', 'superseded')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      total_segments INTEGER NOT NULL DEFAULT 0,
      published_segments INTEGER NOT NULL DEFAULT 0,
      manifest_target_pinid TEXT,
      manifest_pinid TEXT,
      manifest_hash TEXT,
      manifest_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chain_backup_runs_bot_status
      ON chain_backup_runs(bot_globalmetaid, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS chain_backup_segment_uploads (
      bot_globalmetaid TEXT NOT NULL,
      segment_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      segment_hash TEXT NOT NULL,
      pin_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'uploading', 'published')),
      storage TEXT NOT NULL DEFAULT 'inline',
      object_ids_json TEXT NOT NULL,
      kinds_json TEXT NOT NULL,
      plaintext_created_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (bot_globalmetaid, segment_key)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_backup_segment_uploads_run
      ON chain_backup_segment_uploads(run_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_chain_backup_segment_uploads_pin
      ON chain_backup_segment_uploads(pin_id);
  `);
  // Idempotent upgrade for journals written before the metafile switch:
  // pre-existing rows keep the default 'inline' and stay restorable.
  const columns = queryRows(db, 'PRAGMA table_info(chain_backup_segment_uploads)');
  if (columns.length > 0 && !columns.some((column) => column.name === 'storage')) {
    db.run(`ALTER TABLE chain_backup_segment_uploads ADD COLUMN storage TEXT NOT NULL DEFAULT 'inline'`);
  }
}

export function getActiveChainBackupRun(
  db: SqliteDatabase,
  botGlobalMetaId: string,
  planHash: string,
): ChainBackupRunRow | null {
  const rows = queryRows(
    db,
    `SELECT * FROM chain_backup_runs
     WHERE bot_globalmetaid = ? AND plan_hash = ? AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [botGlobalMetaId, planHash],
  );
  return (rows[0] as unknown as ChainBackupRunRow) ?? null;
}

export function listChainBackupRuns(db: SqliteDatabase, botGlobalMetaId: string): ChainBackupRunRow[] {
  return queryRows(
    db,
    'SELECT * FROM chain_backup_runs WHERE bot_globalmetaid = ? ORDER BY updated_at DESC',
    [botGlobalMetaId],
  ) as unknown as ChainBackupRunRow[];
}

export function saveChainBackupRun(db: SqliteDatabase, run: ChainBackupRunRow): void {
  db.run(
    `INSERT INTO chain_backup_runs (
      run_id, bot_globalmetaid, plan_hash, status, created_at, updated_at,
      total_segments, published_segments, manifest_target_pinid, manifest_pinid,
      manifest_hash, manifest_attempts, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      plan_hash = excluded.plan_hash,
      status = excluded.status,
      updated_at = excluded.updated_at,
      total_segments = excluded.total_segments,
      published_segments = excluded.published_segments,
      manifest_target_pinid = excluded.manifest_target_pinid,
      manifest_pinid = excluded.manifest_pinid,
      manifest_hash = excluded.manifest_hash,
      manifest_attempts = excluded.manifest_attempts,
      last_error = excluded.last_error`,
    [
      run.run_id,
      run.bot_globalmetaid,
      run.plan_hash,
      run.status,
      run.created_at,
      Date.now(),
      run.total_segments,
      run.published_segments,
      run.manifest_target_pinid,
      run.manifest_pinid,
      run.manifest_hash,
      run.manifest_attempts,
      run.last_error,
    ],
  );
}

export function createChainBackupRun(
  db: SqliteDatabase,
  input: { botGlobalMetaId: string; planHash: string; totalSegments: number; createdAt?: number },
): ChainBackupRunRow {
  const now = input.createdAt ?? Date.now();
  db.run(
    `UPDATE chain_backup_runs SET status = 'superseded', updated_at = ?
     WHERE bot_globalmetaid = ? AND status = 'active'`,
    [now, input.botGlobalMetaId],
  );
  const run: ChainBackupRunRow = {
    run_id: randomUUID(),
    bot_globalmetaid: input.botGlobalMetaId,
    plan_hash: input.planHash,
    status: 'active',
    created_at: now,
    updated_at: now,
    total_segments: input.totalSegments,
    published_segments: 0,
    manifest_target_pinid: null,
    manifest_pinid: null,
    manifest_hash: null,
    manifest_attempts: 0,
    last_error: null,
  };
  saveChainBackupRun(db, run);
  return run;
}

export function getChainBackupSegmentUpload(
  db: SqliteDatabase,
  botGlobalMetaId: string,
  segmentKey: string,
): ChainBackupSegmentUploadRow | null {
  const rows = queryRows(
    db,
    'SELECT * FROM chain_backup_segment_uploads WHERE bot_globalmetaid = ? AND segment_key = ? LIMIT 1',
    [botGlobalMetaId, segmentKey],
  );
  return (rows[0] as unknown as ChainBackupSegmentUploadRow) ?? null;
}

export function listChainBackupSegmentUploads(
  db: SqliteDatabase,
  botGlobalMetaId: string,
): ChainBackupSegmentUploadRow[] {
  return queryRows(
    db,
    'SELECT * FROM chain_backup_segment_uploads WHERE bot_globalmetaid = ? ORDER BY created_at ASC, segment_key ASC',
    [botGlobalMetaId],
  ) as unknown as ChainBackupSegmentUploadRow[];
}

export function saveChainBackupSegmentUpload(db: SqliteDatabase, row: ChainBackupSegmentUploadRow): void {
  db.run(
    `INSERT INTO chain_backup_segment_uploads (
      bot_globalmetaid, segment_key, run_id, segment_hash, pin_id, status, storage,
      object_ids_json, kinds_json, plaintext_created_at, bytes, attempt_count,
      last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_globalmetaid, segment_key) DO UPDATE SET
      run_id = excluded.run_id,
      segment_hash = excluded.segment_hash,
      pin_id = excluded.pin_id,
      status = excluded.status,
      storage = excluded.storage,
      object_ids_json = excluded.object_ids_json,
      kinds_json = excluded.kinds_json,
      plaintext_created_at = excluded.plaintext_created_at,
      bytes = excluded.bytes,
      attempt_count = excluded.attempt_count,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at`,
    [
      row.bot_globalmetaid,
      row.segment_key,
      row.run_id,
      row.segment_hash,
      row.pin_id,
      row.status,
      row.storage,
      row.object_ids_json,
      row.kinds_json,
      row.plaintext_created_at,
      row.bytes,
      row.attempt_count,
      row.last_error,
      row.created_at,
      Date.now(),
    ],
  );
}
