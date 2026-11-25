import type { AppContext } from '../context.js';
import { decryptSecret } from '../crypto.js';
import { sendAlert } from '../alerts.js';
import { buildContainerSpec } from './provisioning.js';
import { waitForTenantReady } from './probe.js';
import { semverGte, semverLt } from '../semver.js';
import { dockerImageDigest, type DockerImageInspect } from '../docker/client.js';

/**
 * Tenant upgrade (REQ-B-12): stop, remove, recreate on the SAME volume with
 * the SAME gateway secret from the new image, then wait for ready/degraded.
 * A new image that never becomes ready is rolled back to `previous_image`
 * when the new image's `org.idbots.rollback-safe-to` label allows it;
 * otherwise the tenant is marked failed and an alert fires. Downgrades
 * below the current image's `rollback-safe-to` are refused up front.
 *
 * Recreated containers OMIT IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE: the Metaso
 * code is single-use and was consumed on first boot, and re-passing it
 * would fail the tenant's redeem step. Every step writes an audit_log row
 * (actor admin:<operator>).
 */

const STOP_TIMEOUT_SEC = 30;
const DEFAULT_READY_TIMEOUT_MS = 300_000;

export interface UpgradeOptions {
  batch?: number;
  operator: string;
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export type UpgradeOutcome = 'upgraded' | 'rolled-back' | 'failed' | 'refused' | 'skipped';

export interface UpgradeResult {
  tenantId: string;
  outcome: UpgradeOutcome;
  detail: string;
}

interface TenantRow {
  id: string;
  user_id: string;
  container_name: string;
  volume_name: string;
  image: string;
  previous_image: string | null;
  image_digest: string | null;
  status: string;
  app_version: string | null;
  contract_version: string | null;
  gateway_secret_enc: string;
}

interface UserRow {
  id: string;
  display_name: string;
  locale: string;
}

function audit(
  app: Pick<AppContext, 'db'>,
  operator: string,
  action: string,
  target: string,
  detail: Record<string, unknown>,
): void {
  app.db
    .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), `admin:${operator}`, action, target, JSON.stringify(detail));
}

export async function findContainerId(
  app: Pick<AppContext, 'docker'>,
  containerName: string,
): Promise<string | null> {
  const list = await app.docker.listContainers({ namePrefix: containerName, all: true });
  const item = list.find((entry) => entry.Names[0] === `/${containerName}`);
  return item ? item.Id : null;
}

/** Remove the tenant's container (if any) and recreate+start it from `image`. */
export async function recreateContainer(
  app: Pick<AppContext, 'config' | 'db' | 'docker'>,
  tenant: Pick<TenantRow, 'id' | 'container_name' | 'volume_name' | 'user_id'>,
  image: string,
  gatewaySecret: string,
): Promise<void> {
  const existing = await findContainerId(app, tenant.container_name);
  if (existing) {
    await app.docker.stopContainer(existing, STOP_TIMEOUT_SEC);
    await app.docker.removeContainer(existing);
  }
  const user = app.db.prepare('SELECT * FROM users WHERE id = ?').get(tenant.user_id) as
    | UserRow
    | undefined;
  if (!user) {
    throw new Error(`user ${tenant.user_id} not found`);
  }
  const spec = buildContainerSpec(app, {
    tenantId: tenant.id,
    user,
    image,
    gatewaySecret,
    includeRedeemCode: false,
  });
  const created = await app.docker.createContainer(spec);
  await app.docker.startContainer(created.Id);
}

async function upgradeOneInner(
  app: AppContext,
  tenantId: string,
  newImage: string,
  opts: Required<UpgradeOptions>,
): Promise<UpgradeResult> {
  const startedAtMs = Date.now();
  const observe = (result: 'upgraded' | 'rolled-back'): void => {
    app.metrics.upgradeDuration((Date.now() - startedAtMs) / 1000, result);
  };
  const fail = async (detail: string, alertText?: string): Promise<UpgradeResult> => {
    app.db
      .prepare("UPDATE tenants SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
      .run(detail.slice(0, 512), Date.now(), tenantId);
    if (alertText) {
      await sendAlert(app.config, `tenant ${tenantId}: ${alertText}`);
    }
    return { tenantId, outcome: 'failed', detail };
  };

  const row = app.db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as TenantRow | undefined;
  if (!row) {
    return { tenantId, outcome: 'failed', detail: 'tenant not found' };
  }
  const oldImage = row.image;
  const skip = (detail: string): UpgradeResult => {
    audit(app, opts.operator, 'tenant.upgrade.skipped', tenantId, { to: newImage, detail });
    return { tenantId, outcome: 'skipped', detail };
  };
  if (oldImage === newImage) {
    return skip('already using target image');
  }

  let targetInspect: DockerImageInspect;
  let targetLabels: Record<string, string>;
  try {
    targetInspect = await app.docker.imageInspect(newImage);
    targetLabels = targetInspect.Config.Labels ?? {};
  } catch (err) {
    const detail = `target image not found: ${err instanceof Error ? err.message : String(err)}`;
    audit(app, opts.operator, 'tenant.upgrade.failed', tenantId, { to: newImage, detail });
    return fail(detail, detail);
  }
  const targetDigest = dockerImageDigest(targetInspect);
  if (targetDigest && row.image_digest === targetDigest) {
    return skip('already using target image digest');
  }
  let currentLabels: Record<string, string> = {};
  try {
    currentLabels = (await app.docker.imageInspect(oldImage)).Config.Labels ?? {};
  } catch {
    // Unknown current image: no rollback-safety data, proceed without refusal.
  }

  // Upfront downgrade refusal: target version below the current image's
  // rollback-safe-to floor.
  const targetVersion = targetLabels['org.idbots.version'] ?? null;
  const currentFloor = currentLabels['org.idbots.rollback-safe-to'] ?? null;
  if (targetVersion && currentFloor && semverLt(targetVersion, currentFloor)) {
    const detail = `downgrade refused: ${targetVersion} is below rollback-safe-to ${currentFloor} of ${oldImage}`;
    audit(app, opts.operator, 'tenant.upgrade.refused', tenantId, {
      from: oldImage,
      to: newImage,
      detail,
    });
    console.log(JSON.stringify({ level: 'warn', component: 'upgrade', tenant: tenantId, msg: detail }));
    return { tenantId, outcome: 'refused', detail };
  }

  audit(app, opts.operator, 'tenant.upgrade.start', tenantId, { from: oldImage, to: newImage });
  app.db
    .prepare("UPDATE tenants SET status = 'upgrading', updated_at = ? WHERE id = ?")
    .run(Date.now(), tenantId);

  let secret: string;
  try {
    secret = decryptSecret(app.config.masterKey, row.gateway_secret_enc);
    await recreateContainer(app, row, newImage, secret);
  } catch (err) {
    const detail = `recreate with ${newImage} failed: ${err instanceof Error ? err.message : String(err)}`;
    audit(app, opts.operator, 'tenant.upgrade.failed', tenantId, { from: oldImage, to: newImage, detail });
    return fail(detail, detail);
  }

  const wait = await waitForTenantReady(app, row, {
    timeoutMs: opts.readyTimeoutMs,
    intervalMs: opts.readyPollMs,
  });

  if (wait.outcome === 'ready' || wait.outcome === 'degraded') {
    app.db
      .prepare(
        `UPDATE tenants
         SET status = ?, phase = NULL, last_error = NULL, image = ?, previous_image = ?,
             image_digest = ?, app_version = ?, contract_version = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        wait.outcome,
        newImage,
        oldImage,
        targetDigest,
        wait.lastOk?.appVersion ?? null,
        wait.lastOk?.contractVersion ?? null,
        Date.now(),
        tenantId,
      );
    audit(app, opts.operator, 'tenant.upgrade.done', tenantId, {
      from: oldImage,
      to: newImage,
      status: wait.outcome,
    });
    observe('upgraded');
    return { tenantId, outcome: 'upgraded', detail: wait.outcome };
  }

  // Not ready within the budget: decide rollback vs failed.
  const previousVersion = row.app_version;
  const rollbackFloor = targetLabels['org.idbots.rollback-safe-to'] ?? '';
  const rollbackEligible =
    previousVersion !== null && rollbackFloor !== '' && semverGte(previousVersion, rollbackFloor);
  const notReadyDetail =
    wait.outcome === 'exited'
      ? `new image ${newImage} exited before becoming ready`
      : `new image ${newImage} did not become ready within ${opts.readyTimeoutMs} ms`;

  if (!rollbackEligible) {
    const detail = `${notReadyDetail}; rollback not allowed (previous version ${previousVersion ?? 'unknown'}, rollback-safe-to "${rollbackFloor}")`;
    audit(app, opts.operator, 'tenant.upgrade.failed', tenantId, { from: oldImage, to: newImage, detail });
    return fail(detail, detail);
  }

  const rollbackImage = row.previous_image ?? oldImage;
  audit(app, opts.operator, 'tenant.upgrade.rollback.start', tenantId, {
    from: newImage,
    to: rollbackImage,
    reason: notReadyDetail,
  });
  try {
    await recreateContainer(app, row, rollbackImage, secret!);
  } catch (err) {
    const detail = `rollback recreate failed: ${err instanceof Error ? err.message : String(err)}`;
    audit(app, opts.operator, 'tenant.upgrade.failed', tenantId, { to: rollbackImage, detail });
    return fail(detail, detail);
  }
  const rollbackWait = await waitForTenantReady(app, row, {
    timeoutMs: opts.readyTimeoutMs,
    intervalMs: opts.readyPollMs,
  });
  if (rollbackWait.outcome === 'ready' || rollbackWait.outcome === 'degraded') {
    let rollbackDigest: string | null = null;
    try {
      rollbackDigest = dockerImageDigest(await app.docker.imageInspect(rollbackImage));
    } catch {
      // The successful container remains authoritative when metadata is unavailable.
    }
    app.db
      .prepare(
        `UPDATE tenants
         SET status = ?, phase = NULL, last_error = NULL, image = ?, image_digest = ?,
             app_version = ?, contract_version = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        rollbackWait.outcome,
        rollbackImage,
        rollbackDigest,
        rollbackWait.lastOk?.appVersion ?? null,
        rollbackWait.lastOk?.contractVersion ?? null,
        Date.now(),
        tenantId,
      );
    const detail = `rolled back to ${rollbackImage} (${rollbackWait.outcome})`;
    console.log(JSON.stringify({ level: 'info', component: 'upgrade', tenant: tenantId, msg: detail }));
    audit(app, opts.operator, 'tenant.upgrade.rollback.done', tenantId, {
      from: newImage,
      to: rollbackImage,
      status: rollbackWait.outcome,
    });
    observe('rolled-back');
    return { tenantId, outcome: 'rolled-back', detail };
  }
  const detail = `rollback to ${rollbackImage} also did not become ready (${rollbackWait.outcome})`;
  audit(app, opts.operator, 'tenant.upgrade.failed', tenantId, { to: rollbackImage, detail });
  return fail(detail, detail);
}

const tenantUpgradeLocks = new Map<string, Promise<UpgradeResult>>();

async function upgradeOne(
  app: AppContext,
  tenantId: string,
  newImage: string,
  opts: Required<UpgradeOptions>,
): Promise<UpgradeResult> {
  const previous = tenantUpgradeLocks.get(tenantId) ?? Promise.resolve({ tenantId, outcome: 'skipped', detail: 'no previous upgrade' } as UpgradeResult);
  const run = previous.catch(() => undefined).then(() => upgradeOneInner(app, tenantId, newImage, opts));
  tenantUpgradeLocks.set(tenantId, run);
  try {
    return await run;
  } finally {
    if (tenantUpgradeLocks.get(tenantId) === run) tenantUpgradeLocks.delete(tenantId);
  }
}

/** Upgrade the given tenants to `newImage`, at most `batch` at a time. */
export async function upgradeTenants(
  app: AppContext,
  tenantIds: string[],
  newImage: string,
  options: UpgradeOptions,
): Promise<UpgradeResult[]> {
  const opts: Required<UpgradeOptions> = {
    batch: Math.max(1, options.batch ?? 1),
    operator: options.operator,
    readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    readyPollMs: options.readyPollMs ?? 1000,
  };
  const results = new Map<string, UpgradeResult>();
  const queue = [...tenantIds];
  const worker = async (): Promise<void> => {
    for (;;) {
      const id = queue.shift();
      if (!id) {
        return;
      }
      try {
        results.set(id, await upgradeOne(app, id, newImage, opts));
      } catch (err) {
        results.set(id, {
          tenantId: id,
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.batch, tenantIds.length) }, () => worker()));
  return tenantIds.map((id) => results.get(id)!);
}
