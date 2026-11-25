import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import { selectFleetUpgradeTenantIds } from '../services/upgradeSelection.js';
import { upgradeTenants } from '../services/upgrade.js';
import type { RolloutItem, RolloutJobStatus, RolloutJobView, RolloutStore } from './types.js';
import { assignRolloutWaves, type WaveTenant } from './waves.js';

export interface CreateRolloutOptions {
  releaseId: string;
  operator: string;
  tenantIds?: string[];
  kind?: 'customer' | 'internal' | 'synthetic' | 'demo';
  cohort?: 'canary' | 'early' | 'stable';
  environment?: 'staging' | 'production';
  globalConcurrency?: number;
  perHostConcurrency?: number;
  soakMs?: number;
}

export class RolloutManager {
  private readonly workerId = `worker-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly app: AppContext,
    readonly store: RolloutStore,
    private readonly options: {
      tickMs?: number;
      leaseMs?: number;
      readyTimeoutMs?: number;
      readyPollMs?: number;
    } = {},
  ) {}

  async create(options: CreateRolloutOptions): Promise<RolloutJobView> {
    const release = this.app.db.prepare('SELECT tenant_image, tenant_image_digest FROM releases WHERE id = ?')
      .get(options.releaseId) as { tenant_image: string; tenant_image_digest: string } | undefined;
    if (!release) throw new Error(`release ${options.releaseId} not found`);
    const selectedIds = selectFleetUpgradeTenantIds(this.app.db, {
      targetImage: release.tenant_image,
      targetDigest: release.tenant_image_digest,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.cohort ? { cohort: options.cohort } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
    const requested = options.tenantIds ? new Set(options.tenantIds) : null;
    const ids = selectedIds.filter((id) => !requested || requested.has(id));
    if (ids.length === 0) throw new Error('no eligible tenants require this rollout');
    const placeholders = ids.map(() => '?').join(',');
    const tenants = (this.app.db.prepare(`SELECT id, host_id, kind, cohort, created_at FROM tenants
      WHERE id IN (${placeholders})`).all(...ids) as Array<{
        id: string;
        host_id: string;
        kind: WaveTenant['kind'];
        cohort: WaveTenant['cohort'];
        created_at: number;
      }>).map((row) => ({ id: row.id, hostId: row.host_id, kind: row.kind, cohort: row.cohort, createdAt: row.created_at }));
    const { waves, items } = assignRolloutWaves(tenants, options.soakMs);
    const now = Date.now();
    return this.store.createJob({
      id: `ro_${randomUUID().replaceAll('-', '')}`,
      releaseId: options.releaseId,
      globalConcurrency: options.globalConcurrency ?? 20,
      perHostConcurrency: options.perHostConcurrency ?? 1,
      failureThresholdPercent: 2,
      failureThresholdCount: 3,
      consecutiveFailureLimit: 2,
      operator: options.operator,
      waves,
      items,
    }).then(async (view) => {
      this.app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
        .run(now, `admin:${options.operator}`, 'rollout.create', view.job.id, JSON.stringify({ releaseId: options.releaseId, tenants: items.length, waves: waves.length }));
      return view;
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.store.requeueInFlight();
    this.timer = setInterval(() => this.kick(), this.options.tickMs ?? 250);
    this.timer.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }

  private kick(): void {
    if (!this.started || this.ticking) return;
    this.ticking = this.tick().catch((err) => {
      console.error(JSON.stringify({ level: 'error', component: 'rollout', msg: 'scheduler tick failed', error: String(err) }));
    }).finally(() => {
      this.ticking = null;
    });
  }

  private async setStatus(id: string, status: RolloutJobStatus, reason: string | null, action: string): Promise<void> {
    await this.store.setJobStatus(id, status, reason);
    const view = await this.requireJob(id);
    this.app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), `admin:${view.job.operator}`, action, id, JSON.stringify({ status, reason }));
    this.kick();
  }

  async startJob(id: string): Promise<void> {
    const view = await this.requireJob(id);
    if (view.job.status !== 'paused') throw new Error(`cannot start rollout in ${view.job.status}`);
    await this.setStatus(id, 'running', null, 'rollout.start');
  }

  async pause(id: string, reason = 'paused by operator'): Promise<void> {
    await this.setStatus(id, 'paused', reason, 'rollout.pause');
  }

  async resume(id: string): Promise<void> {
    await this.startJob(id);
  }

  async cancel(id: string): Promise<void> {
    await this.setStatus(id, 'cancelled', 'cancelled by operator', 'rollout.cancel');
  }

  async retryFailed(id: string): Promise<number> {
    const view = await this.requireJob(id);
    if (view.job.status !== 'paused') throw new Error('pause the rollout before retrying failed items');
    const count = await this.store.retryFailed(id);
    this.app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), `admin:${view.job.operator}`, 'rollout.retry', id, JSON.stringify({ count }));
    return count;
  }

  async requireJob(id: string): Promise<RolloutJobView> {
    const view = await this.store.getJob(id);
    if (!view) throw new Error(`rollout ${id} not found`);
    return view;
  }

  private async tick(): Promise<void> {
    const jobs = await this.store.listJobs(100);
    for (const { job } of jobs) {
      if (job.status !== 'running') continue;
      await this.preflight(job.id);
      const view = await this.requireJob(job.id);
      if (view.job.status !== 'running') continue;
      const items = await this.store.claimItems(
        job.id,
        this.workerId,
        view.job.globalConcurrency,
        this.options.leaseMs ?? 30_000,
        Date.now(),
      );
      await Promise.all(items.map((item) => this.execute(item, view.job.releaseId, view.job.operator)));
      await this.evaluate(job.id);
    }
  }

  private async preflight(jobId: string): Promise<void> {
    const view = await this.requireJob(jobId);
    const hosts = await this.store.listPreflightHosts(jobId, view.job.currentWave);
    const release = this.app.db.prepare('SELECT tenant_image FROM releases WHERE id = ?').get(view.job.releaseId) as { tenant_image: string };
    for (const host of hosts) {
      if (host.status === 'ready') continue;
      if (host.status === 'failed') {
        await this.pause(jobId, `image preflight failed on ${host.hostId}: ${host.error ?? 'unknown error'}`);
        continue;
      }
      try {
        await this.app.docker.imageInspect(release.tenant_image);
        await this.store.markPreflightHost(jobId, host.hostId, view.job.currentWave, 'ready', null, Date.now());
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await this.store.markPreflightHost(jobId, host.hostId, view.job.currentWave, 'failed', detail, Date.now());
        await this.pause(jobId, `image preflight failed on ${host.hostId}: ${detail}`);
      }
    }
  }

  private async execute(item: RolloutItem, releaseId: string, operator: string): Promise<void> {
    const release = this.app.db.prepare('SELECT tenant_image FROM releases WHERE id = ?').get(releaseId) as { tenant_image: string };
    const heartbeat = setInterval(() => {
      void this.store.heartbeat(item.jobId, item.tenantId, this.workerId, this.options.leaseMs ?? 30_000, Date.now());
    }, Math.max(1000, Math.floor((this.options.leaseMs ?? 30_000) / 3)));
    heartbeat.unref();
    try {
      const [result] = await upgradeTenants(this.app, [item.tenantId], release.tenant_image, {
        operator: `${operator}:${item.jobId}`,
        readyTimeoutMs: this.options.readyTimeoutMs,
        readyPollMs: this.options.readyPollMs,
      });
      const status = result.outcome === 'upgraded'
        ? 'succeeded'
        : result.outcome === 'rolled-back'
          ? 'rolled-back'
          : result.outcome === 'skipped'
            ? 'skipped'
            : 'failed';
      await this.store.completeItem(item.jobId, item.tenantId, this.workerId, status, result.outcome, result.outcome === 'upgraded' || result.outcome === 'skipped' ? null : result.detail, Date.now());
      this.app.metrics.inc('cp_rollout_items_total', { outcome: status });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.store.completeItem(item.jobId, item.tenantId, this.workerId, 'failed', 'error', detail, Date.now());
      this.app.metrics.inc('cp_rollout_items_total', { outcome: 'failed' });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async evaluate(jobId: string): Promise<void> {
    const view = await this.requireJob(jobId);
    if (view.job.status !== 'running') return;
    const waveItems = view.items.filter((item) => item.waveIndex === view.job.currentWave);
    const failed = waveItems.filter((item) => item.status === 'failed' || item.status === 'rolled-back');
    const ordered = [...waveItems].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    let consecutive = 0;
    for (const item of ordered) {
      if (item.status !== 'failed' && item.status !== 'rolled-back') break;
      consecutive += 1;
    }
    const terminal = waveItems.every((item) => ['succeeded', 'failed', 'rolled-back', 'skipped'].includes(item.status));
    const failureRate = waveItems.length ? failed.length / waveItems.length * 100 : 0;
    const thresholdReached = failed.length >= view.job.failureThresholdCount && failureRate >= view.job.failureThresholdPercent;
    if ((view.job.currentWave === 0 && failed.length > 0) || consecutive >= view.job.consecutiveFailureLimit || thresholdReached) {
      await this.pause(jobId, `rollout safety gate: failed=${failed.length}, consecutive=${consecutive}, rate=${failureRate.toFixed(1)}%`);
      return;
    }
    if (!terminal) return;
    if (failed.length > 0) {
      await this.pause(jobId, 'wave has failed items; retry is required before continuing');
      return;
    }
    const elapsed = Date.now() - (view.job.waveStartedAt ?? Date.now());
    const soakMs = view.waves[view.job.currentWave]?.soakMs ?? 0;
    if (elapsed < soakMs) return;
    if (view.job.currentWave + 1 >= view.waves.length) {
      await this.setStatus(jobId, 'completed', null, 'rollout.completed');
      return;
    }
    await this.store.advanceWave(jobId, view.job.currentWave + 1, Date.now());
    this.app.db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), `admin:${view.job.operator}`, 'rollout.wave', jobId, JSON.stringify({ from: view.job.currentWave, to: view.job.currentWave + 1 }));
  }
}
