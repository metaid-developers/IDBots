import type { AppContext } from '../context.js';
import { DockerError } from '../docker/client.js';
import { sendAlert } from '../alerts.js';
import { queryPartnerTenantTrialStatus } from './invitePartnerClient.js';
import { markFailed, provisionTenant } from './provisioning.js';
import { auditSystem } from './recovery.js';
import { findContainerId } from './upgrade.js';

/**
 * Post-trial container hibernation & auto-wake (Owner Decision 3):
 *
 * 1. When an invited user's trial expired more than `hibernateAfterMs` (default
 *    7 days) ago without an active paid subscription in ABS, stop the Docker
 *    container (`status = 'stopped'`, `phase = 'hibernated_trial_expired'`) while
 *    keeping the `/data` volume intact.
 * 2. When that user later logs in or opens the app (`GET /api/v1/me` or
 *    `POST /api/v1/auth/sms/verify`), automatically start the container back up
 *    (`status = 'booting'`) and grant a `wakeGraceMs` (default 24h) window so
 *    they can inspect chat history and purchase a subscription without being
 *    re-hibernated mid-session.
 * 3. Manually admin-stopped tenants (`hibernated_at IS NULL`) are never
 *    auto-woken by user traffic.
 */

export const HIBERNATED_PHASE = 'hibernated_trial_expired';
const PAID_RECHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000;

interface HibernationCandidateRow {
  tenant_id: string;
  user_id: string;
  container_name: string;
  status: string;
  trial_ends_at: number;
  hibernated_at: number | null;
  woken_at: number | null;
  last_checked_at: number | null;
}

interface WakeTenantRow {
  id: string;
  user_id: string;
  container_name: string;
  status: string;
  phase: string | null;
}

const wakeInFlight = new Set<string>();

export function isHibernatedTrialTenant(
  db: AppContext['db'],
  userId: string,
  tenant: { status: string } | null | undefined,
): boolean {
  if (!tenant || tenant.status !== 'stopped') {
    return false;
  }
  const grant = db
    .prepare('SELECT hibernated_at FROM invite_grants WHERE user_id = ?')
    .get(userId) as { hibernated_at: number | null } | undefined;
  return Boolean(grant && grant.hibernated_at !== null);
}

/**
 * Synchronously flips a hibernated tenant row to `booting` and schedules the
 * Docker container start in the background. Returns true when a wake was
 * initiated (or was already transitioned).
 */
export function triggerWakeHibernatedTenant(
  app: Pick<AppContext, 'config' | 'db' | 'docker'>,
  userId: string,
  now = Date.now(),
): boolean {
  const tenant = app.db
    .prepare('SELECT id, user_id, container_name, status, phase FROM tenants WHERE user_id = ?')
    .get(userId) as WakeTenantRow | undefined;
  if (!tenant || !isHibernatedTrialTenant(app.db, userId, tenant)) {
    return false;
  }

  const flipped = app.db.transaction(() => {
    const res = app.db
      .prepare(
        `UPDATE tenants
         SET status = 'booting', phase = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'stopped'`,
      )
      .run(now, tenant.id);
    if (res.changes > 0) {
      app.db
        .prepare(
          `UPDATE invite_grants
           SET hibernated_at = NULL, woken_at = ?, updated_at = ?
           WHERE user_id = ?`,
        )
        .run(now, now, userId);
      auditSystem(app, 'tenant.wake.trial_hibernated', tenant.id, { userId });
    }
    return res.changes > 0;
  })();

  if (!flipped || wakeInFlight.has(tenant.id)) {
    return flipped;
  }

  wakeInFlight.add(tenant.id);
  void startWokenContainer(app, tenant)
    .catch((err: unknown) => {
      const msg = `auto-wake failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(
        JSON.stringify({ level: 'error', component: 'hibernation', tenant: tenant.id, msg }),
      );
      markFailed(app, tenant.id, msg);
      void sendAlert(app.config, `tenant ${tenant.id}: ${msg}`);
    })
    .finally(() => {
      wakeInFlight.delete(tenant.id);
    });

  return true;
}

async function startWokenContainer(
  app: Pick<AppContext, 'config' | 'db' | 'docker'>,
  tenant: WakeTenantRow,
): Promise<void> {
  const containerId = await findContainerId(app, tenant.container_name);
  if (containerId) {
    await app.docker.startContainer(containerId);
    console.log(
      JSON.stringify({
        level: 'info',
        component: 'hibernation',
        tenant: tenant.id,
        msg: 'woke hibernated container',
      }),
    );
    return;
  }

  // Container vanished while stopped, but data volume remains: re-run idempotent provisioning.
  app.db
    .prepare("UPDATE tenants SET status = 'provisioning', updated_at = ? WHERE id = ?")
    .run(Date.now(), tenant.id);
  await provisionTenant(app, tenant.id);
}

/**
 * Checks serving tenants whose trial ended longer than `hibernateAfterMs` ago
 * against ABS subscription truth, stopping containers that remain unsubscribed.
 */
export async function sweepExpiredTrialHibernation(
  app: Pick<AppContext, 'config' | 'db' | 'docker'>,
  now = Date.now(),
): Promise<number> {
  if (!app.config.inviteService.baseUrl) {
    return 0;
  }
  const { hibernateAfterMs, wakeGraceMs } = app.config.inviteService;
  const expiredBefore = now - hibernateAfterMs;
  const wakeBefore = now - wakeGraceMs;
  const recheckBefore = now - PAID_RECHECK_COOLDOWN_MS;

  const candidates = app.db
    .prepare(
      `SELECT
         t.id AS tenant_id,
         t.user_id,
         t.container_name,
         t.status,
         g.trial_ends_at,
         g.hibernated_at,
         g.woken_at,
         g.last_checked_at
       FROM tenants t
       JOIN invite_grants g ON g.user_id = t.user_id
       WHERE t.status IN ('ready', 'degraded')
         AND g.trial_ends_at IS NOT NULL
         AND g.trial_ends_at <= ?
         AND (g.woken_at IS NULL OR g.woken_at <= ?)
         AND (g.last_checked_at IS NULL OR g.last_checked_at <= ?)
       ORDER BY g.trial_ends_at ASC
       LIMIT 100`,
    )
    .all(expiredBefore, wakeBefore, recheckBefore) as HibernationCandidateRow[];

  if (candidates.length === 0) {
    return 0;
  }

  const statuses = await queryPartnerTenantTrialStatus(
    app.config,
    candidates.map((c) => c.user_id),
  );
  const byUser = new Map(statuses.map((item) => [item.cpUserId, item]));
  let hibernatedCount = 0;

  for (const candidate of candidates) {
    const status = byUser.get(candidate.user_id);
    if (!status) {
      app.db
        .prepare('UPDATE invite_grants SET last_checked_at = ?, updated_at = ? WHERE user_id = ?')
        .run(now, now, candidate.user_id);
      continue;
    }

    if (status.subscriptionActive && status.periodEnd > now) {
      // User upgraded to a paid plan: advance trial_ends_at to their paid periodEnd.
      app.db
        .prepare(
          'UPDATE invite_grants SET trial_ends_at = ?, last_checked_at = ?, updated_at = ? WHERE user_id = ?',
        )
        .run(status.periodEnd, now, now, candidate.user_id);
      continue;
    }

    const effectiveEnd = status.periodEnd > 0 ? status.periodEnd : candidate.trial_ends_at;
    if (status.redemptionStatus !== 2 || effectiveEnd > expiredBefore) {
      app.db
        .prepare(
          'UPDATE invite_grants SET trial_ends_at = ?, last_checked_at = ?, updated_at = ? WHERE user_id = ?',
        )
        .run(effectiveEnd, now, now, candidate.user_id);
      continue;
    }

    try {
      const containerId = await findContainerId(app, candidate.container_name);
      if (containerId) {
        try {
          await app.docker.stopContainer(containerId, 15);
        } catch (stopErr) {
          if (!(stopErr instanceof DockerError && stopErr.status === 404)) {
            throw stopErr;
          }
        }
      }

      app.db.transaction(() => {
        const res = app.db
          .prepare(
            `UPDATE tenants
             SET status = 'stopped', phase = ?, updated_at = ?
             WHERE id = ? AND status IN ('ready', 'degraded')`,
          )
          .run(HIBERNATED_PHASE, now, candidate.tenant_id);
        if (res.changes > 0) {
          app.db
            .prepare(
              `UPDATE invite_grants
               SET trial_ends_at = ?, hibernated_at = ?, last_checked_at = ?, updated_at = ?
               WHERE user_id = ?`,
            )
            .run(effectiveEnd, now, now, now, candidate.user_id);
          auditSystem(app, 'tenant.hibernate.trial_expired', candidate.tenant_id, {
            userId: candidate.user_id,
            periodEnd: effectiveEnd,
          });
          hibernatedCount += 1;
        }
      })();

      console.log(
        JSON.stringify({
          level: 'info',
          component: 'hibernation',
          tenant: candidate.tenant_id,
          msg: 'hibernated expired unsubscribed trial container',
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'hibernation',
          tenant: candidate.tenant_id,
          msg: 'failed to hibernate expired trial container',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return hibernatedCount;
}
