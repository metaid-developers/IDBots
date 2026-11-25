import type Database from 'better-sqlite3';
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

export class SqliteRolloutStore implements RolloutStore {
  constructor(private readonly db: Database.Database) {}

  async createJob(input: NewRolloutJob): Promise<RolloutJobView> {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO rollout_jobs (
        id, release_id, mode, status, current_wave, waves_json, global_concurrency,
        per_host_concurrency, failure_threshold_percent, failure_threshold_count,
        consecutive_failure_limit, operator, created_at, updated_at
      ) VALUES (?, ?, ?, 'paused', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id,
          input.releaseId,
          input.mode,
          JSON.stringify(input.waves),
          input.globalConcurrency,
          input.perHostConcurrency,
          input.failureThresholdPercent,
          input.failureThresholdCount,
          input.consecutiveFailureLimit,
          input.operator,
          now,
          now,
        );
      const insertItem = this.db.prepare(`INSERT INTO rollout_items (
        job_id, tenant_id, host_id, wave_index, status
      ) VALUES (?, ?, ?, ?, 'pending')`);
      const insertHost = this.db.prepare(`INSERT INTO rollout_hosts (
        job_id, host_id, wave_index, status, updated_at
      ) VALUES (?, ?, ?, 'pending', ?)`);
      const hosts = new Set<string>();
      for (const item of input.items) {
        insertItem.run(input.id, item.tenantId, item.hostId, item.waveIndex);
        const hostKey = `${item.hostId}:${item.waveIndex}`;
        if (!hosts.has(hostKey)) {
          hosts.add(hostKey);
          insertHost.run(input.id, item.hostId, item.waveIndex, now);
        }
      }
    })();
    return (await this.getJob(input.id))!;
  }

  async getJob(id: string): Promise<RolloutJobView | null> {
    const row = this.db.prepare('SELECT * FROM rollout_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const waves = JSON.parse(String(row.waves_json)) as RolloutWave[];
    const items = (this.db.prepare('SELECT * FROM rollout_items WHERE job_id = ? ORDER BY wave_index, tenant_id')
      .all(id) as Array<Record<string, unknown>>).map(itemFromRow);
    return { job: jobFromRow(row), waves, items };
  }

  async listJobs(limit = 50): Promise<RolloutJobView[]> {
    const rows = this.db.prepare('SELECT id FROM rollout_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: string }>;
    return Promise.all(rows.map((row) => this.getJob(row.id) as Promise<RolloutJobView>));
  }

  async setJobStatus(id: string, status: RolloutJobStatus, reason: string | null = null): Promise<void> {
    const now = Date.now();
    this.db.prepare(`UPDATE rollout_jobs SET status = ?, stop_reason = ?, updated_at = ?,
      wave_started_at = CASE WHEN ? = 'running' AND wave_started_at IS NULL THEN ? ELSE wave_started_at END,
      completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
      WHERE id = ?`)
      .run(status, reason, now, status, now, status, now, id);
  }

  async advanceWave(id: string, wave: number, now: number): Promise<void> {
    this.db.prepare('UPDATE rollout_jobs SET current_wave = ?, wave_started_at = ?, updated_at = ? WHERE id = ?')
      .run(wave, now, now, id);
  }

  async claimItems(jobId: string, workerId: string, limit: number, leaseMs: number, now: number): Promise<RolloutItem[]> {
    return this.db.transaction(() => {
      const jobRow = this.db.prepare('SELECT status, current_wave, global_concurrency, per_host_concurrency FROM rollout_jobs WHERE id = ?')
        .get(jobId) as { status: string; current_wave: number; global_concurrency: number; per_host_concurrency: number } | undefined;
      if (!jobRow || jobRow.status !== 'running' || limit < 1) return [];
      let active = (this.db.prepare("SELECT COUNT(*) AS n FROM rollout_items WHERE job_id = ? AND status = 'leased'")
        .get(jobId) as { n: number }).n;
      let available = Math.min(limit, jobRow.global_concurrency - active);
      if (available <= 0) return [];
      const candidates = this.db.prepare(`SELECT * FROM rollout_items
        WHERE job_id = ? AND wave_index = ?
          AND (status = 'pending' OR (status = 'leased' AND lease_expires_at <= ?))
        ORDER BY tenant_id`).all(jobId, jobRow.current_wave, now) as Array<Record<string, unknown>>;
      const claimed: RolloutItem[] = [];
      const perHost = new Map<string, number>();
      for (const row of candidates) {
        if (available <= 0) break;
        const hostId = String(row.host_id);
        const hostActive = perHost.get(hostId) ?? (this.db.prepare(
          "SELECT COUNT(*) AS n FROM rollout_items WHERE job_id = ? AND host_id = ? AND status = 'leased'",
        ).get(jobId, hostId) as { n: number }).n;
        if (hostActive >= jobRow.per_host_concurrency) continue;
        const result = this.db.prepare(`UPDATE rollout_items SET
          status = 'leased', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1,
          started_at = COALESCE(started_at, ?), finished_at = NULL, outcome = NULL, error = NULL
          WHERE job_id = ? AND tenant_id = ?
            AND (status = 'pending' OR (status = 'leased' AND lease_expires_at <= ?))`)
          .run(workerId, now + leaseMs, now, jobId, row.tenant_id, now);
        if (result.changes !== 1) continue;
        claimed.push(itemFromRow(this.db.prepare('SELECT * FROM rollout_items WHERE job_id = ? AND tenant_id = ?')
          .get(jobId, row.tenant_id) as Record<string, unknown>));
        perHost.set(hostId, hostActive + 1);
        active += 1;
        available -= 1;
      }
      return claimed;
    })();
  }

  async completeItem(
    jobId: string,
    tenantId: string,
    workerId: string,
    status: RolloutItemStatus,
    outcome: string,
    error: string | null,
    now: number,
  ): Promise<void> {
    if (status === 'pending' || status === 'leased') throw new Error('completion requires a terminal item status');
    this.db.prepare(`UPDATE rollout_items SET status = ?, outcome = ?, error = ?, finished_at = ?,
      lease_owner = NULL, lease_expires_at = NULL
      WHERE job_id = ? AND tenant_id = ? AND lease_owner = ?`)
      .run(status, outcome, error, now, jobId, tenantId, workerId);
  }

  async heartbeat(jobId: string, tenantId: string, workerId: string, leaseMs: number, now: number): Promise<void> {
    this.db.prepare('UPDATE rollout_items SET lease_expires_at = ? WHERE job_id = ? AND tenant_id = ? AND lease_owner = ? AND status = \'leased\'')
      .run(now + leaseMs, jobId, tenantId, workerId);
  }

  async listPreflightHosts(jobId: string, wave: number): Promise<Array<{ hostId: string; status: string; error: string | null }>> {
    return this.db.prepare('SELECT host_id AS hostId, status, error FROM rollout_hosts WHERE job_id = ? AND wave_index = ? ORDER BY host_id')
      .all(jobId, wave) as Array<{ hostId: string; status: string; error: string | null }>;
  }

  async markPreflightHost(
    jobId: string,
    hostId: string,
    wave: number,
    status: 'ready' | 'failed',
    error: string | null,
    now: number,
  ): Promise<void> {
    this.db.prepare('UPDATE rollout_hosts SET status = ?, error = ?, updated_at = ? WHERE job_id = ? AND host_id = ? AND wave_index = ?')
      .run(status, error, now, jobId, hostId, wave);
  }

  async retryFailed(jobId: string): Promise<number> {
    return this.db.prepare(`UPDATE rollout_items SET status = 'pending', lease_owner = NULL,
      lease_expires_at = NULL, finished_at = NULL, outcome = NULL, error = NULL
      WHERE job_id = ? AND status IN ('failed', 'rolled-back')`).run(jobId).changes;
  }

  async hasRunningItem(tenantId: string): Promise<boolean> {
    return Boolean(this.db.prepare(`SELECT 1 FROM rollout_items ri JOIN rollout_jobs rj ON rj.id = ri.job_id
      WHERE ri.tenant_id = ? AND ri.status IN ('pending', 'leased') AND rj.status = 'running' LIMIT 1`).get(tenantId));
  }

  async requeueInFlight(now: number): Promise<number> {
    return this.db.prepare(`UPDATE rollout_items SET status = 'pending', lease_owner = NULL,
      lease_expires_at = NULL WHERE status = 'leased' AND lease_expires_at <= ?`).run(now).changes;
  }
}
