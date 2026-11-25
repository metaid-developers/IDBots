import { Pool, type PoolClient } from 'pg';
import type {
  NewRolloutJob,
  RolloutItem,
  RolloutItemStatus,
  RolloutJob,
  RolloutJobStatus,
  RolloutJobView,
  RolloutStore,
  RolloutWave,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rollout_jobs (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'upgrade' CHECK (mode IN ('upgrade', 'rollback')),
  status TEXT NOT NULL CHECK (status IN ('paused', 'running', 'completed', 'cancelled')),
  current_wave INTEGER NOT NULL DEFAULT 0,
  waves_json JSONB NOT NULL,
  global_concurrency INTEGER NOT NULL,
  per_host_concurrency INTEGER NOT NULL,
  failure_threshold_percent DOUBLE PRECISION NOT NULL DEFAULT 2,
  failure_threshold_count INTEGER NOT NULL DEFAULT 3,
  consecutive_failure_limit INTEGER NOT NULL DEFAULT 2,
  stop_reason TEXT,
  operator TEXT NOT NULL,
  wave_started_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE TABLE IF NOT EXISTS rollout_items (
  job_id TEXT NOT NULL REFERENCES rollout_jobs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  wave_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'succeeded', 'failed', 'rolled-back', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  started_at BIGINT,
  finished_at BIGINT,
  outcome TEXT,
  error TEXT,
  PRIMARY KEY(job_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_rollout_items_claim ON rollout_items(job_id, wave_index, status, host_id, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_rollout_items_tenant ON rollout_items(tenant_id, status);
CREATE TABLE IF NOT EXISTS rollout_hosts (
  job_id TEXT NOT NULL REFERENCES rollout_jobs(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  wave_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  error TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(job_id, host_id, wave_index)
);
`;

function jobFromRow(row: Record<string, unknown>): RolloutJob {
  return {
    id: String(row.id),
    releaseId: String(row.release_id),
    mode: String(row.mode) as 'upgrade' | 'rollback',
    status: String(row.status) as RolloutJobStatus,
    currentWave: Number(row.current_wave),
    globalConcurrency: Number(row.global_concurrency),
    perHostConcurrency: Number(row.per_host_concurrency),
    failureThresholdPercent: Number(row.failure_threshold_percent),
    failureThresholdCount: Number(row.failure_threshold_count),
    consecutiveFailureLimit: Number(row.consecutive_failure_limit),
    stopReason: row.stop_reason === null ? null : String(row.stop_reason),
    operator: String(row.operator),
    waveStartedAt: row.wave_started_at === null ? null : Number(row.wave_started_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function itemFromRow(row: Record<string, unknown>): RolloutItem {
  return {
    jobId: String(row.job_id),
    tenantId: String(row.tenant_id),
    hostId: String(row.host_id),
    waveIndex: Number(row.wave_index),
    status: String(row.status) as RolloutItemStatus,
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    outcome: row.outcome === null ? null : String(row.outcome),
    error: row.error === null ? null : String(row.error),
  };
}

export class PostgresRolloutStore implements RolloutStore {
  constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string): Promise<PostgresRolloutStore> {
    const pool = new Pool({ connectionString, max: 10 });
    const store = new PostgresRolloutStore(pool);
    await store.init();
    return store;
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createJob(input: NewRolloutJob): Promise<RolloutJobView> {
    await this.transaction(async (client) => {
      const now = Date.now();
      await client.query(`INSERT INTO rollout_jobs (
        id, release_id, mode, status, current_wave, waves_json, global_concurrency,
        per_host_concurrency, failure_threshold_percent, failure_threshold_count,
        consecutive_failure_limit, operator, created_at, updated_at
      ) VALUES ($1,$2,$3,'paused',0,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
        input.id, input.releaseId, input.mode, JSON.stringify(input.waves), input.globalConcurrency,
        input.perHostConcurrency, input.failureThresholdPercent, input.failureThresholdCount,
        input.consecutiveFailureLimit, input.operator, now, now,
      ]);
      for (const item of input.items) {
        await client.query("INSERT INTO rollout_items (job_id,tenant_id,host_id,wave_index,status) VALUES ($1,$2,$3,$4,'pending')",
          [input.id, item.tenantId, item.hostId, item.waveIndex]);
        await client.query(`INSERT INTO rollout_hosts (job_id,host_id,wave_index,status,updated_at)
          VALUES ($1,$2,$3,'pending',$4) ON CONFLICT DO NOTHING`, [input.id, item.hostId, item.waveIndex, now]);
      }
    });
    return (await this.getJob(input.id))!;
  }

  private async getJobWith(client: PoolClient, id: string): Promise<RolloutJobView | null> {
    const result = await client.query('SELECT * FROM rollout_jobs WHERE id = $1', [id]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    const waves = (typeof row.waves_json === 'string' ? JSON.parse(row.waves_json) : row.waves_json) as RolloutWave[];
    const items = await client.query('SELECT * FROM rollout_items WHERE job_id = $1 ORDER BY wave_index, tenant_id', [id]);
    return { job: jobFromRow(row), waves, items: items.rows.map(itemFromRow) };
  }

  async getJob(id: string): Promise<RolloutJobView | null> {
    const client = await this.pool.connect();
    try {
      return await this.getJobWith(client, id);
    } finally {
      client.release();
    }
  }

  async listJobs(limit = 50): Promise<RolloutJobView[]> {
    const result = await this.pool.query('SELECT id FROM rollout_jobs ORDER BY created_at DESC LIMIT $1', [limit]);
    const views: RolloutJobView[] = [];
    for (const row of result.rows) views.push((await this.getJob(row.id))!);
    return views;
  }

  async setJobStatus(id: string, status: RolloutJobStatus, reason: string | null = null): Promise<void> {
    const now = Date.now();
    await this.pool.query(`UPDATE rollout_jobs SET status=$1, stop_reason=$2, updated_at=$3,
      wave_started_at=CASE WHEN $4='running' AND wave_started_at IS NULL THEN $3 ELSE wave_started_at END,
      completed_at=CASE WHEN $5='completed' THEN $3 ELSE completed_at END WHERE id=$6`,
      [status, reason, now, status, status, id]);
  }

  async advanceWave(id: string, wave: number, now: number): Promise<void> {
    await this.pool.query('UPDATE rollout_jobs SET current_wave=$1,wave_started_at=$2,updated_at=$2 WHERE id=$3', [wave, now, id]);
  }

  async claimItems(jobId: string, workerId: string, limit: number, leaseMs: number, now: number): Promise<RolloutItem[]> {
    return this.transaction(async (client) => {
      const jobResult = await client.query('SELECT status,current_wave,global_concurrency,per_host_concurrency FROM rollout_jobs WHERE id=$1 FOR UPDATE', [jobId]);
      const job = jobResult.rows[0];
      if (!job || job.status !== 'running' || limit < 1) return [];
      const activeResult = await client.query("SELECT COUNT(*)::int AS n FROM rollout_items WHERE job_id=$1 AND status='leased'", [jobId]);
      let available = Math.min(limit, job.global_concurrency - Number(activeResult.rows[0].n));
      if (available <= 0) return [];
      const candidates = await client.query(`SELECT * FROM rollout_items WHERE job_id=$1 AND wave_index=$2
        AND (status='pending' OR (status='leased' AND lease_expires_at<=$3)) ORDER BY tenant_id FOR UPDATE`,
        [jobId, job.current_wave, now]);
      const claimed: RolloutItem[] = [];
      const perHost = new Map<string, number>();
      for (const row of candidates.rows) {
        if (available <= 0) break;
        const hostId = String(row.host_id);
        let hostActive = perHost.get(hostId);
        if (hostActive === undefined) {
          const result = await client.query("SELECT COUNT(*)::int AS n FROM rollout_items WHERE job_id=$1 AND host_id=$2 AND status='leased'", [jobId, hostId]);
          hostActive = Number(result.rows[0].n);
        }
        if (hostActive >= job.per_host_concurrency) continue;
        const updated = await client.query(`UPDATE rollout_items SET status='leased',lease_owner=$1,lease_expires_at=$2,
          attempts=attempts+1,started_at=COALESCE(started_at,$3),finished_at=NULL,outcome=NULL,error=NULL
          WHERE job_id=$4 AND tenant_id=$5 AND (status='pending' OR (status='leased' AND lease_expires_at<=$3))`,
          [workerId, now + leaseMs, now, jobId, row.tenant_id]);
        if (updated.rowCount !== 1) continue;
        const current = await client.query('SELECT * FROM rollout_items WHERE job_id=$1 AND tenant_id=$2', [jobId, row.tenant_id]);
        claimed.push(itemFromRow(current.rows[0]));
        perHost.set(hostId, hostActive + 1);
        available -= 1;
      }
      return claimed;
    });
  }

  async completeItem(jobId: string, tenantId: string, workerId: string, status: RolloutItemStatus, outcome: string, error: string | null, now: number): Promise<void> {
    if (status === 'pending' || status === 'leased') throw new Error('completion requires a terminal item status');
    await this.pool.query(`UPDATE rollout_items SET status=$1,outcome=$2,error=$3,finished_at=$4,
      lease_owner=NULL,lease_expires_at=NULL WHERE job_id=$5 AND tenant_id=$6 AND lease_owner=$7`,
      [status, outcome, error, now, jobId, tenantId, workerId]);
  }

  async heartbeat(jobId: string, tenantId: string, workerId: string, leaseMs: number, now: number): Promise<void> {
    await this.pool.query("UPDATE rollout_items SET lease_expires_at=$1 WHERE job_id=$2 AND tenant_id=$3 AND lease_owner=$4 AND status='leased'",
      [now + leaseMs, jobId, tenantId, workerId]);
  }

  async listPreflightHosts(jobId: string, wave: number): Promise<Array<{ hostId: string; status: string; error: string | null }>> {
    const result = await this.pool.query('SELECT host_id AS "hostId",status,error FROM rollout_hosts WHERE job_id=$1 AND wave_index=$2 ORDER BY host_id', [jobId, wave]);
    return result.rows;
  }

  async markPreflightHost(jobId: string, hostId: string, wave: number, status: 'ready' | 'failed', error: string | null, now: number): Promise<void> {
    await this.pool.query('UPDATE rollout_hosts SET status=$1,error=$2,updated_at=$3 WHERE job_id=$4 AND host_id=$5 AND wave_index=$6',
      [status, error, now, jobId, hostId, wave]);
  }

  async retryFailed(jobId: string): Promise<number> {
    const result = await this.pool.query(`UPDATE rollout_items SET status='pending',lease_owner=NULL,lease_expires_at=NULL,
      finished_at=NULL,outcome=NULL,error=NULL WHERE job_id=$1 AND status IN ('failed','rolled-back')`, [jobId]);
    return result.rowCount ?? 0;
  }

  async hasRunningItem(tenantId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM rollout_items ri JOIN rollout_jobs rj ON rj.id = ri.job_id
      WHERE ri.tenant_id=$1 AND ri.status IN ('pending','leased') AND rj.status='running' LIMIT 1`, [tenantId]);
    return (result.rowCount ?? 0) > 0;
  }

  async requeueInFlight(now: number): Promise<number> {
    const result = await this.pool.query("UPDATE rollout_items SET status='pending',lease_owner=NULL,lease_expires_at=NULL WHERE status='leased' AND lease_expires_at <= $1", [now]);
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
