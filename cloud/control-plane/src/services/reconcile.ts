import type { AppContext } from '../context.js';
import { sendAlert } from '../alerts.js';
import { recoverTenant } from './recovery.js';

/**
 * Startup reconcile (REQ-B-11): match the tenants table against the
 * containers that actually exist before the poller resumes, and recover
 * rows orphaned by the previous process dying mid-work (review S2-1/S2-2):
 *
 * - `provisioning`: container exists → back to `booting`; missing →
 *   re-provisioned (idempotent, same secret).
 * - `upgrading`: orphaned by definition → roll back onto the pre-upgrade
 *   image (`tenants.image`) with the same secret, then `booting`.
 * - booting/onboarding/ready/degraded whose container vanished → `failed`
 *   (ready/degraded also alert).
 * - Containers the table does not know are reported and NEVER deleted;
 *   stopped/suspended/failed rows are not touched.
 *
 * When the Docker API is unreachable the reconcile is skipped entirely
 * (transient outage — statuses must not flap on a dead engine).
 */

interface TenantRow {
  id: string;
  user_id: string;
  container_name: string;
  volume_name: string;
  image: string;
  status: string;
  gateway_secret_enc: string;
}

export async function reconcileAtStartup(
  app: Pick<AppContext, 'config' | 'db' | 'docker' | 'rollouts'>,
): Promise<string[]> {
  const log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, component: 'reconcile', msg, ...extra }));

  let containers;
  try {
    containers = await app.docker.listContainers({ namePrefix: 'idb-', all: true });
  } catch (err) {
    log('warn', 'docker unreachable, reconcile skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const byName = new Map(containers.map((c) => [c.Names[0].replace(/^\//, ''), c]));
  const tenants = app.db
    .prepare(
      'SELECT id, user_id, container_name, volume_name, image, status, gateway_secret_enc FROM tenants',
    )
    .all() as TenantRow[];
  const tenantNames = new Set(tenants.map((t) => t.container_name));
  const reported: string[] = [];

  for (const tenant of tenants) {
    if (tenant.status === 'stopped' || tenant.status === 'suspended' || tenant.status === 'failed') {
      continue;
    }
    if (tenant.status === 'provisioning' || tenant.status === 'upgrading') {
      if (tenant.status === 'upgrading') {
        if (app.rollouts && await app.rollouts.store.hasRunningItem(tenant.id)) continue;
      }
      try {
        const outcome = await recoverTenant(app, tenant);
        log('info', 'recovered orphaned tenant row', { tenant: tenant.id, outcome });
      } catch (err) {
        log('error', 'tenant recovery failed', {
          tenant: tenant.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if (byName.has(tenant.container_name)) {
      continue;
    }
    const wasServing = tenant.status === 'ready' || tenant.status === 'degraded';
    app.db
      .prepare(
        "UPDATE tenants SET status = 'failed', last_error = 'container missing on startup', updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), tenant.id);
    const message = `tenant ${tenant.id}: container missing on startup`;
    log('warn', 'tenant container missing on startup', { tenant: tenant.id, status: tenant.status });
    reported.push(message);
    if (wasServing) {
      await sendAlert(app.config, message);
    }
  }

  for (const [name, container] of byName) {
    if (tenantNames.has(name)) {
      continue;
    }
    const message = `unknown container ${name} reported (id ${container.Id.slice(0, 12)}); left running, not deleted`;
    log('warn', 'unknown container reported, not deleted', { name });
    await sendAlert(app.config, message);
    reported.push(message);
  }

  return reported;
}
