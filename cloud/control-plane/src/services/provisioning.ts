import type { AppContext } from '../context.js';
import { DockerError, type CreateContainerOptions } from '../docker/client.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { newGatewaySecret } from '../ids.js';
import { sendAlert } from '../alerts.js';

/**
 * Tenant provisioning (REQ-B-9): create the data volume and the container
 * through the Docker API with the full C1 setting set, then start it and
 * move the tenant to `booting`. The gateway secret is generated here and
 * stored encrypted BEFORE any Docker call; only the env passed to the
 * container ever sees the plaintext. Never throws — failures land in
 * tenants.last_error plus an operator alert.
 *
 * `buildContainerSpec` is shared with the upgrade/rotate flows, which
 * recreate containers on the same volume with the same secret. Those pass
 * `includeRedeemCode: false` — the Metaso redeem code is single-use and was
 * already consumed on first boot, so re-passing
 * IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE would fail the tenant's redeem step.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const GATEWAY_PORT = 8790;

interface TenantRow {
  id: string;
  user_id: string;
  status: string;
  container_name: string;
  volume_name: string;
  gateway_secret_enc: string | null;
}

interface UserRow {
  id: string;
  display_name: string;
  locale: string;
  invite_code: string | null;
}

export interface ContainerSpecInput {
  tenantId: string;
  user: Pick<UserRow, 'id' | 'display_name' | 'locale'>;
  image: string;
  gatewaySecret: string;
  /** First boot only: attach the user's assigned Metaso redeem code. */
  includeRedeemCode: boolean;
}

/** The full C1 container definition shared by provisioning and recreate flows. */
export function buildContainerSpec(
  app: Pick<AppContext, 'config' | 'db'>,
  input: ContainerSpecInput,
): CreateContainerOptions {
  const env: Record<string, string> = {
    IDBOTS_SERVER_MODE: '1',
    IDBOTS_TENANT_ID: input.tenantId,
    IDBOTS_GATEWAY_SECRET: input.gatewaySecret,
    IDBOTS_CONTROL_PLANE_URL: app.config.publicOrigin,
    IDBOTS_GATEWAY_PORT: String(GATEWAY_PORT),
    IDBOTS_GATEWAY_TIER: 'P1',
    IDBOTS_USER_DATA_PATH: '/data/userdata',
    IDBOTS_APP_DATA_PATH: '/data/appdata',
    IDBOTS_WORKSPACE_PATH: '/data/workspace',
    IDBOTS_BOOTSTRAP_DISPLAY_NAME: input.user.display_name || 'IDBots User',
    IDBOTS_BOOTSTRAP_LOCALE: input.user.locale || 'zh',
    TZ: 'Asia/Shanghai',
  };

  if (input.includeRedeemCode) {
    const redeem = app.db
      .prepare('SELECT code_enc FROM redeem_codes WHERE assigned_user_id = ?')
      .get(input.user.id) as { code_enc: string } | undefined;
    if (redeem) {
      env.IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE = decryptSecret(
        app.config.masterKey,
        redeem.code_enc,
      );
    }
  }

  for (const [key, value] of Object.entries(app.config.tenantEnv)) {
    env[key] = value;
  }

  const memoryBytes = app.config.tenantMemoryMb * MIB;
  return {
    name: `idb-${input.tenantId}`,
    image: input.image,
    env,
    labels: {
      'org.idbots.tenant-id': input.tenantId,
      'org.idbots.user-id': input.user.id,
    },
    exposedPorts: [`${GATEWAY_PORT}/tcp`],
    hostConfig: {
      Memory: memoryBytes,
      MemorySwap: memoryBytes,
      NanoCpus: app.config.tenantCpus * 1e9,
      PidsLimit: 2048,
      ShmSize: GIB,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
      Binds: [`idb-${input.tenantId}-data:/data`],
      NetworkMode: app.config.tenantNetwork,
      Init: true,
    },
  };
}

export function markFailed(
  app: Pick<AppContext, 'db'>,
  tenantId: string,
  message: string,
): void {
  app.db
    .prepare("UPDATE tenants SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
    .run(message.slice(0, 512), Date.now(), tenantId);
}

/**
 * Tenants currently being provisioned (live sign-up or recovery-driven).
 * Guards against double-execution when the poller's stale-row net and a
 * live `provisionTenant` overlap.
 */
const provisioningInFlight = new Set<string>();

export function isProvisioningInFlight(tenantId: string): boolean {
  return provisioningInFlight.has(tenantId);
}

async function findContainerIdByName(
  app: Pick<AppContext, 'docker'>,
  name: string,
): Promise<string | null> {
  const list = await app.docker.listContainers({ namePrefix: name, all: true });
  const item = list.find((entry) => entry.Names[0] === `/${name}`);
  return item ? item.Id : null;
}

function setBooting(app: Pick<AppContext, 'db'>, tenantId: string): void {
  app.db
    .prepare(
      "UPDATE tenants SET status = 'booting', phase = NULL, last_error = NULL, updated_at = ? WHERE id = ?",
    )
    .run(Date.now(), tenantId);
}

/**
 * Provision (or resume provisioning of) a tenant. Idempotent: reuses the
 * gateway secret already stored in `gateway_secret_enc` when present (only
 * mints one when the column is NULL), tolerates an existing volume, and on
 * a container-name conflict adopts the existing container (starting it when
 * stopped) instead of failing. Never throws — failures land in
 * tenants.last_error plus an operator alert.
 */
export async function provisionTenant(
  app: Pick<AppContext, 'config' | 'db' | 'docker'>,
  tenantId: string,
): Promise<void> {
  if (provisioningInFlight.has(tenantId)) {
    return;
  }
  provisioningInFlight.add(tenantId);
  try {
    await provisionTenantInner(app, tenantId);
  } finally {
    provisioningInFlight.delete(tenantId);
  }
}

async function provisionTenantInner(
  app: Pick<AppContext, 'config' | 'db' | 'docker'>,
  tenantId: string,
): Promise<void> {
  const log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, component: 'provisioning', tenant: tenantId, msg, ...extra }));

  const tenant = app.db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as
    | TenantRow
    | undefined;
  if (!tenant) {
    log('error', 'tenant row missing');
    return;
  }
  if (tenant.status !== 'provisioning') {
    log('warn', `skip: status is ${tenant.status}, expected provisioning`);
    return;
  }
  const user = app.db.prepare('SELECT * FROM users WHERE id = ?').get(tenant.user_id) as
    | UserRow
    | undefined;
  if (!user) {
    markFailed(app, tenantId, 'user row missing');
    await sendAlert(app.config, `tenant ${tenantId}: user row missing, provisioning aborted`);
    return;
  }

  // Secret BEFORE any Docker call. Reuse the stored secret on re-runs so a
  // retried provision never orphans the container's credentials; mint only
  // when the column is NULL (or undecryptable — a config bug we can recover
  // from by re-keying).
  let gatewaySecret: string | null = null;
  if (tenant.gateway_secret_enc) {
    try {
      gatewaySecret = decryptSecret(app.config.masterKey, tenant.gateway_secret_enc);
    } catch (err) {
      log('warn', 'stored gateway secret undecryptable, minting a new one', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!gatewaySecret) {
    gatewaySecret = newGatewaySecret();
    app.db
      .prepare('UPDATE tenants SET gateway_secret_enc = ?, updated_at = ? WHERE id = ?')
      .run(encryptSecret(app.config.masterKey, gatewaySecret), Date.now(), tenantId);
  }

  try {
    await app.docker.createVolume(tenant.volume_name, {
      'org.idbots.tenant-id': tenantId,
      'org.idbots.user-id': user.id,
    });
  } catch (err) {
    if (!(err instanceof DockerError && err.status === 409)) {
      const message = `volume create failed: ${err instanceof Error ? err.message : String(err)}`;
      markFailed(app, tenantId, message);
      log('error', message);
      await sendAlert(app.config, `tenant ${tenantId}: ${message}`);
      return;
    }
    log('info', 'volume already exists, reusing');
  }

  // The redeem code is attached only when THIS sign-up required one
  // (review S2-3): resolve with_redeem through the invite the user signed up
  // with. The empty-pool warn+alert fires only when a code was required but
  // the pool had none — plain invites must not flood the webhook.
  const invite = user.invite_code
    ? (app.db.prepare('SELECT with_redeem FROM invites WHERE code = ?').get(user.invite_code) as
        | { with_redeem: number }
        | undefined)
    : undefined;
  const redeemRequired = invite?.with_redeem === 1;

  let spec: CreateContainerOptions;
  try {
    spec = buildContainerSpec(app, {
      tenantId,
      user,
      image: app.config.tenantImage,
      gatewaySecret,
      includeRedeemCode: redeemRequired,
    });
  } catch (err) {
    // S3-3: a spec-build failure (e.g. corrupt redeem ciphertext) must mark
    // the tenant failed, never crash the process as an unhandled rejection.
    const message = `container spec build failed: ${err instanceof Error ? err.message : String(err)}`;
    markFailed(app, tenantId, message);
    log('error', message);
    await sendAlert(app.config, `tenant ${tenantId}: ${message}`);
    return;
  }
  if (redeemRequired && !spec.env?.IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE) {
    log('warn', 'redeem pool empty for this tenant; provisioning without a code');
    await sendAlert(
      app.config,
      `tenant ${tenantId}: redeem code pool empty, tenant provisioning without a code`,
    );
  }

  try {
    const created = await app.docker.createContainer(spec);
    await app.docker.startContainer(created.Id);
  } catch (err) {
    if (err instanceof DockerError && err.status === 409) {
      // Name conflict: a previous run already created the container — adopt it.
      const existingId = await findContainerIdByName(app, tenant.container_name);
      if (existingId) {
        try {
          const inspect = await app.docker.inspectContainer(existingId);
          if (!inspect.State.Running) {
            await app.docker.startContainer(existingId);
          }
          setBooting(app, tenantId);
          log('info', 'adopted existing container, tenant is booting');
          return;
        } catch (startErr) {
          const message = `existing container adopt/start failed: ${startErr instanceof Error ? startErr.message : String(startErr)}`;
          markFailed(app, tenantId, message);
          log('error', message);
          await sendAlert(app.config, `tenant ${tenantId}: ${message}`);
          return;
        }
      }
    }
    const message = `container create/start failed: ${err instanceof Error ? err.message : String(err)}`;
    markFailed(app, tenantId, message);
    log('error', message);
    await sendAlert(app.config, `tenant ${tenantId}: ${message}`);
    return;
  }

  setBooting(app, tenantId);
  log('info', 'container started, tenant is booting');
}
