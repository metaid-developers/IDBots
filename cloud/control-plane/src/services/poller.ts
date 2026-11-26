import type { AppContext } from '../context.js';
import { sendAlert } from '../alerts.js';
import { sweepExpiredTrialHibernation } from './hibernation.js';
import { probeTenant } from './probe.js';
import {
  isProvisioningInFlight,
  isRecoverableProvisionFailure,
  triggerRetryFailedProvisioning,
} from './provisioning.js';
import { recoverTenant } from './recovery.js';
import {
  DEFAULT_TIMEOUTS,
  nextStatus,
  type TenantStatus,
  type Timeouts,
} from './statusMachine.js';

/**
 * Tenant status poller (REQ-B-10): probes each live tenant's /healthz and
 * /readyz through the status machine and persists transitions. Fast tick
 * while booting/onboarding, slow tick otherwise; per-tenant scheduling so a
 * slow tenant never delays a stuck one. Sweeps are serialized and every
 * tenant is isolated in its own try/catch.
 *
 * `provisioning` rows are not probed for readiness — that status belongs to
 * provisionTenant — but the sweep does recover STALE provisioning rows
 * (updated_at older than staleProvisioningMs, default 5 min) whose
 * provisioning died with the process; a live run is never double-executed
 * because provisioning's in-flight guard covers both entry points. The same
 * recovery runs unconditionally at startup (reconcileAtStartup).
 */

export interface PollerOptions {
  tickFastMs?: number;
  tickSlowMs?: number;
  timeouts?: Partial<Timeouts>;
  probeTimeoutMs?: number;
  /** Runtime safety net for provisioning rows stuck by a dead process. */
  staleProvisioningMs?: number;
  /** Runtime safety net for failed provisioning rows (e.g. Docker timeout after container create). */
  failedProvisionRetryMs?: number;
  /** Periodic interval for >7-day post-trial hibernation checks. */
  hibernationCheckIntervalMs?: number;
  now?: () => number;
}

interface TenantRow {
  id: string;
  user_id: string;
  container_name: string;
  volume_name: string;
  image: string;
  status: string;
  created_at: number;
  phase: string | null;
  app_version: string | null;
  contract_version: string | null;
  last_error: string | null;
  gateway_secret_enc: string;
}

export class TenantPoller {
  private readonly tickFastMs: number;
  private readonly tickSlowMs: number;
  private readonly timeouts: Timeouts;
  private readonly probeTimeoutMs: number;
  private readonly staleProvisioningMs: number;
  private readonly failedProvisionRetryMs: number;
  private readonly hibernationCheckIntervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly nextPollAt = new Map<string, number>();
  private nextHibernationCheckAt = 0;

  constructor(
    private readonly app: Pick<AppContext, 'config' | 'db' | 'docker'> & Partial<Pick<AppContext, 'metrics'>>,
    opts: PollerOptions = {},
  ) {
    this.tickFastMs = opts.tickFastMs ?? 3000;
    this.tickSlowMs = opts.tickSlowMs ?? 30_000;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
    this.staleProvisioningMs = opts.staleProvisioningMs ?? 300_000;
    this.failedProvisionRetryMs = opts.failedProvisionRetryMs ?? 30_000;
    this.hibernationCheckIntervalMs = opts.hibernationCheckIntervalMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tickOnce().catch((err) => {
        console.error(JSON.stringify({ level: 'error', component: 'poller', msg: 'sweep failed', error: String(err) }));
      });
    }, this.tickFastMs);
  }

  /** Stops the timer and returns once the in-flight sweep (if any) settles. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.chain;
  }

  /** Enqueue one sweep; awaits its completion (test-friendly). */
  tickOnce(): Promise<void> {
    const run = this.chain.then(() => this.sweep());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sweep(): Promise<void> {
    await this.recoverStaleProvisioningRows();
    this.recoverFailedProvisioningRows();
    const sweepNow = this.now();
    if (sweepNow >= this.nextHibernationCheckAt) {
      this.nextHibernationCheckAt = sweepNow + this.hibernationCheckIntervalMs;
      try {
        await sweepExpiredTrialHibernation(this.app, sweepNow);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            component: 'poller',
            msg: 'expired trial hibernation sweep failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
    const rows = this.app.db
      .prepare(
        "SELECT * FROM tenants WHERE status IN ('booting', 'onboarding', 'ready', 'degraded')",
      )
      .all() as TenantRow[];
    const activeIds = new Set(rows.map((row) => row.id));
    for (const id of [...this.nextPollAt.keys()]) {
      if (!activeIds.has(id)) {
        this.nextPollAt.delete(id);
      }
    }
    for (const row of rows) {
      const now = this.now();
      if (now < (this.nextPollAt.get(row.id) ?? 0)) {
        continue;
      }
      const fast = row.status === 'booting' || row.status === 'onboarding';
      this.nextPollAt.set(row.id, now + (fast ? this.tickFastMs : this.tickSlowMs));
      try {
        await this.probeAndApply(row, now);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            component: 'poller',
            tenant: row.id,
            msg: 'probe failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  /**
   * Runtime safety net: provisioning rows whose `updated_at` predates the
   * stale threshold were orphaned by a dead process (restart/crash between
   * sign-up and container start). Rows owned by a live provisionTenant run
   * are skipped via the in-flight guard.
   */
  private async recoverStaleProvisioningRows(): Promise<void> {
    const now = this.now();
    const stale = this.app.db
      .prepare(
        `SELECT * FROM tenants
         WHERE status = 'provisioning' AND updated_at < ?
         ORDER BY updated_at`,
      )
      .all(now - this.staleProvisioningMs) as TenantRow[];
    for (const row of stale) {
      if (isProvisioningInFlight(row.id)) {
        continue;
      }
      try {
        const outcome = await recoverTenant(this.app, row);
        console.log(
          JSON.stringify({
            level: 'info',
            component: 'poller',
            tenant: row.id,
            msg: 'recovered stale provisioning row',
            outcome,
          }),
        );
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            component: 'poller',
            tenant: row.id,
            msg: 'stale provisioning recovery failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  /**
   * Runtime safety net: if initial container create/start timed out in the
   * client while Docker completed creating the container seconds later, retry
   * provisioning once automatically so the tenant can adopt & start it even
   * if the user closed the browser.
   */
  private recoverFailedProvisioningRows(): void {
    const now = this.now();
    const failedRows = this.app.db
      .prepare(
        `SELECT id, status, last_error, updated_at FROM tenants
         WHERE status = 'failed' AND updated_at < ?
         ORDER BY updated_at`,
      )
      .all(now - this.failedProvisionRetryMs) as Array<{
      id: string;
      status: string;
      last_error: string | null;
      updated_at: number;
    }>;
    for (const row of failedRows) {
      if (!isRecoverableProvisionFailure(row)) {
        continue;
      }
      triggerRetryFailedProvisioning(this.app, row.id, {
        source: 'poller',
        cooldownMs: this.failedProvisionRetryMs,
        now,
      });
    }
  }

  private async probeAndApply(row: TenantRow, now: number): Promise<void> {
    const { probe, startedAtMs } = await probeTenant(this.app, row, this.probeTimeoutMs);
    const firstBoot = row.app_version === null;
    const transition = nextStatus(
      row.status as TenantStatus,
      probe,
      { now, startedAtMs, firstBoot },
      this.timeouts,
    );

    const changed =
      transition.to !== row.status ||
      transition.phase !== row.phase ||
      transition.lastError !== row.last_error ||
      transition.appVersion !== row.app_version ||
      transition.contractVersion !== row.contract_version;
    if (changed) {
      // REQ-B-20: observe the provisioning duration exactly once — when the
      // container that just became ready was started with the tenant's
      // creation (first boot, not a restart or an upgrade recreate, both of
      // which have a much later StartedAt than tenants.created_at).
      const firstBootContainer =
        startedAtMs !== null && Math.abs(startedAtMs - row.created_at) < 60_000;
      const becameServing =
        (transition.to === 'ready' || transition.to === 'degraded') &&
        firstBootContainer &&
        row.status !== 'ready' &&
        row.status !== 'degraded';
      if (becameServing) {
        this.app.metrics?.provisioningDuration((now - row.created_at) / 1000);
      }
      this.app.db
        .prepare(
          `UPDATE tenants
           SET status = ?, phase = ?, last_error = ?, app_version = ?, contract_version = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          transition.to,
          transition.phase,
          transition.lastError,
          transition.appVersion,
          transition.contractVersion,
          now,
          row.id,
        );
      console.log(
        JSON.stringify({
          level: 'info',
          component: 'poller',
          tenant: row.id,
          msg: 'status transition',
          from: row.status,
          to: transition.to,
          phase: transition.phase,
        }),
      );
    }
    if (transition.alert) {
      await sendAlert(this.app.config, `tenant ${row.id}: ${transition.alert}`);
    }
  }
}
