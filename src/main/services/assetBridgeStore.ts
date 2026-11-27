/** SQLite persistence for built-in Octopus asset bridge jobs. */

import type { SqliteDatabase } from '../sqliteTypes';
import type { AssetBridgeJobView, AssetBridgeState } from '../../renderer/components/chat/assetBridgeCardSyntax';

export interface AssetBridgeJobRecord {
  view: AssetBridgeJobView;
  metabotId: number;
  sessionId: string;
  originTokenId: string;
  quoteJson: Record<string, unknown>;
  orderJson: Record<string, unknown> | null;
  signedJson: Record<string, unknown> | null;
  notifiedAt: number | null;
  noticeSessionId: string | null;
  createdAt: number;
}

export function ensureAssetBridgeSchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS asset_bridge_jobs (
      job_id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      scenario TEXT NOT NULL,
      origin_token_id TEXT NOT NULL,
      view_json TEXT NOT NULL,
      quote_json TEXT NOT NULL,
      order_json TEXT,
      signed_json TEXT,
      state TEXT NOT NULL,
      notified_at INTEGER,
      notice_session_id TEXT,
      on_complete TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_asset_bridge_jobs_state ON asset_bridge_jobs(state, updated_at DESC);');
  db.run('CREATE INDEX IF NOT EXISTS idx_asset_bridge_jobs_metabot ON asset_bridge_jobs(metabot_id, created_at DESC);');
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    if (typeof raw !== 'string' || !raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rows(db: SqliteDatabase, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const result = db.exec(sql, params)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
}

function rowToRecord(row: Record<string, unknown>): AssetBridgeJobRecord {
  const view = parseJson<AssetBridgeJobView>(row.view_json, {} as AssetBridgeJobView);
  return {
    view,
    metabotId: Number(row.metabot_id ?? view.metabotId),
    sessionId: String(row.session_id ?? view.sessionId ?? ''),
    originTokenId: String(row.origin_token_id ?? ''),
    quoteJson: parseJson<Record<string, unknown>>(row.quote_json, {}),
    orderJson: row.order_json ? parseJson<Record<string, unknown>>(row.order_json, {}) : null,
    signedJson: row.signed_json ? parseJson<Record<string, unknown>>(row.signed_json, {}) : null,
    notifiedAt: row.notified_at == null ? null : Number(row.notified_at),
    noticeSessionId: row.notice_session_id == null ? null : String(row.notice_session_id),
    createdAt: Number(row.created_at ?? 0),
  };
}

export class AssetBridgeStore {
  constructor(private readonly db: SqliteDatabase, private readonly saveDb: () => void = () => {}) {
    ensureAssetBridgeSchema(db);
    this.saveDb();
  }

  insert(record: AssetBridgeJobRecord): void {
    const view = record.view;
    this.db.run(
      `INSERT INTO asset_bridge_jobs (
        job_id, metabot_id, session_id, scenario, origin_token_id, view_json, quote_json,
        order_json, signed_json, state, notified_at, notice_session_id, on_complete, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        view.jobId,
        record.metabotId,
        record.sessionId,
        view.scenario,
        record.originTokenId,
        JSON.stringify(view),
        JSON.stringify(record.quoteJson),
        record.orderJson ? JSON.stringify(record.orderJson) : null,
        record.signedJson ? JSON.stringify(record.signedJson) : null,
        view.state,
        record.notifiedAt,
        record.noticeSessionId,
        view.onComplete,
        record.createdAt,
        view.updatedAt,
      ],
    );
    this.saveDb();
  }

  update(jobId: string, patch: {
    view?: AssetBridgeJobView;
    quoteJson?: Record<string, unknown>;
    orderJson?: Record<string, unknown> | null;
    signedJson?: Record<string, unknown> | null;
    notifiedAt?: number | null;
    noticeSessionId?: string | null;
  }): void {
    const current = this.get(jobId);
    if (!current) return;
    const view = patch.view ?? current.view;
    this.db.run(
      `UPDATE asset_bridge_jobs SET
        view_json = ?, quote_json = ?, order_json = ?, signed_json = ?, state = ?,
        notified_at = ?, notice_session_id = ?, on_complete = ?, updated_at = ?
       WHERE job_id = ?`,
      [
        JSON.stringify(view),
        JSON.stringify(patch.quoteJson ?? current.quoteJson),
        (patch.orderJson === undefined ? current.orderJson : patch.orderJson) ? JSON.stringify(patch.orderJson === undefined ? current.orderJson : patch.orderJson) : null,
        (patch.signedJson === undefined ? current.signedJson : patch.signedJson) ? JSON.stringify(patch.signedJson === undefined ? current.signedJson : patch.signedJson) : null,
        view.state,
        patch.notifiedAt === undefined ? current.notifiedAt : patch.notifiedAt,
        patch.noticeSessionId === undefined ? current.noticeSessionId : patch.noticeSessionId,
        view.onComplete,
        view.updatedAt,
        jobId,
      ],
    );
    this.saveDb();
  }

  get(jobId: string): AssetBridgeJobRecord | null {
    const row = rows(this.db, 'SELECT * FROM asset_bridge_jobs WHERE job_id = ? LIMIT 1', [jobId])[0];
    return row ? rowToRecord(row) : null;
  }

  listByState(state: AssetBridgeState): AssetBridgeJobRecord[] {
    return rows(this.db, 'SELECT * FROM asset_bridge_jobs WHERE state = ? ORDER BY updated_at DESC', [state]).map(rowToRecord);
  }

  listByMetabot(metabotId: number, limit = 5): AssetBridgeJobRecord[] {
    return rows(this.db, 'SELECT * FROM asset_bridge_jobs WHERE metabot_id = ? ORDER BY created_at DESC LIMIT ?', [metabotId, Math.floor(limit)]).map(rowToRecord);
  }

  listAll(limit = 100): AssetBridgeJobRecord[] {
    return rows(this.db, 'SELECT * FROM asset_bridge_jobs ORDER BY updated_at DESC LIMIT ?', [Math.floor(limit)]).map(rowToRecord);
  }
}
