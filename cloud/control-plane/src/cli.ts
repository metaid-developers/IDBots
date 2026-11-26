#!/usr/bin/env node
/**
 * Admin CLI (REQ-B-18): `node dist/cli.js ...`, run inside the control-plane
 * container. Every MUTATING command requires --as <operator> and writes an
 * audit_log row with actor admin:<name>. Read-only commands need no --as.
 *
 * Redeem codes are printed NOWHERE except `invite create` (the new invite
 * code); `redeem stats` prints counts only.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb } from './db/index.js';
import { ConfigError, parsePushConfig } from './config.js';
import type { ControlPlaneConfig } from './config.js';
import { DockerClient } from './docker/client.js';
import { FakeSmsProvider } from './sms.js';
import { newInviteCode, newGatewaySecret } from './ids.js';
import { encryptSecret, sha256Hex, maskPhone } from './crypto.js';
import { upgradeTenants, findContainerId, recreateContainer } from './services/upgrade.js';
import { selectFleetUpgradeTenantIds } from './services/upgradeSelection.js';
import { listReleases, registerRelease, setReleaseStatus } from './services/releases.js';
import { RolloutManager } from './rollout/manager.js';
import { SqliteRolloutStore } from './rollout/sqliteStore.js';
import { createAdminUser, disableAdminUser, listAdminUsers, type AdminRole } from './admin/auth.js';
import { MetricsRegistry } from './metrics.js';
import { PushDeliveryService } from './services/pushDelivery.js';
import type { AppContext } from './context.js';
import { attachCreditApplyCode, grantCredit, listCredits } from './services/creditService.js';
import { HttpError } from './http.js';

// --- CLI-scoped config (no listen/SMS/origin requirements) ------------------

function loadCliContext(env: NodeJS.ProcessEnv): AppContext {
  const req = (name: string): string => {
    const value = env[name];
    if (!value) {
      throw new ConfigError(`${name} is required`);
    }
    return value;
  };
  const dbPath = req('CP_DB_PATH');
  const masterKeyRaw = req('CP_MASTER_KEY');
  const masterKey = Buffer.from(masterKeyRaw, 'base64');
  if (masterKey.length !== 32) {
    throw new ConfigError(`CP_MASTER_KEY must decode to 32 bytes, got ${masterKey.length}`);
  }
  const environment = env.CP_ENVIRONMENT ?? 'production';
  if (environment !== 'staging' && environment !== 'production') {
    throw new ConfigError('CP_ENVIRONMENT must be "staging" or "production"');
  }
  const tenantEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('CP_TENANT_ENV_') && value !== undefined) {
      tenantEnv[name.slice('CP_TENANT_ENV_'.length)] = value;
    }
  }
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(`${name} must be a positive integer`);
    }
    return value;
  };
  // ControlPlaneConfig fields the services touch: config/masterKey,
  // tenantImage/Network/MemoryMb/Cpus, tenantEnv, alertWebhook. The rest are
  // inert defaults (the CLI never serves HTTP or sends SMS).
  const config = {
    publicOrigin: 'http://localhost',
    publicOriginUrl: new URL('http://localhost'),
    listen: '0.0.0.0:0',
    metricsListen: '0.0.0.0:0',
    dbPath,
    environment,
    hostId: env.CP_HOST_ID?.trim() || null,
    hostCapacity: num('CP_HOST_CAPACITY', environment === 'staging' ? 27 : 58),
    agent: null,
    masterKey,
    dockerUrl: env.CP_DOCKER_URL ?? 'http+unix:///var/run/docker.sock',
    tenantImage: env.CP_TENANT_IMAGE ?? '',
    tenantNetwork: env.CP_TENANT_NETWORK ?? 'idbots-tenants',
    tenantMemoryMb: num('CP_TENANT_MEMORY_MB', 2304),
    tenantCpus: num('CP_TENANT_CPUS', 2),
    tenantEnv,
    smsMode: 'fake',
    sms: {
      accessKeyId: null,
      accessKeySecret: null,
      signName: null,
      templateLogin: null,
      templateReverify: null,
    },
    fakeSmsNumbers: [],
    alertWebhook: env.CP_ALERT_WEBHOOK ?? null,
    // The CLI never serves HTTP; these are inert defaults.
    loginBundleDir: '',
    legalDir: '',
    inviteService: {
      baseUrl: null,
      token: null,
      hibernateAfterMs: 7 * 24 * 60 * 60 * 1000,
      wakeGraceMs: 24 * 60 * 60 * 1000,
    },
    dailySignupCap: null,
    // Push provider comes from the environment so `push.send-test` can use
    // the real FCM credentials when the operator sources deploy.env.
    push: parsePushConfig(env),
    // The CLI never serves the voice gateway either; inert stub defaults.
    asr: {
      upstream: 'stub',
      dailyLimitMinutes: 60,
      maxSessionSeconds: 600,
      doubao: { endpoint: '', resourceId: '', apiKey: null, appId: null, accessToken: null },
      funasrEndpoint: null,
      stub: { delayMs: 0, disconnectAfterMs: 0, slowFinalMs: 0 },
    },
    // The CLI grants credits through services/creditService directly (actor
    // admin:<name>); the HTTP token is irrelevant here — inert default.
    adminApiToken: null,
  } as ControlPlaneConfig;
  const docker = new DockerClient(config.dockerUrl);
  const db = openDb(dbPath);
  return {
    config,
    db,
    docker,
    sms: new FakeSmsProvider([]),
    poller: null,
    metrics: new MetricsRegistry(),
    push: new PushDeliveryService(db, config),
  };
}

// --- helpers ----------------------------------------------------------------

class CliError extends Error {}

function audit(
  ctx: AppContext,
  operator: string,
  action: string,
  target: string,
  detail: Record<string, unknown> = {},
): void {
  ctx.db
    .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), `admin:${operator}`, action, target, JSON.stringify(detail));
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags.set(arg.slice(2), argv[i + 1]);
        i += 1;
      } else {
        flags.set(arg.slice(2), true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function flagString(flags: Map<string, string | boolean>, name: string): string | null {
  const value = flags.get(name);
  if (typeof value !== 'string') {
    return null;
  }
  return value;
}

function requireFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flagString(flags, name);
  if (value === null) {
    throw new CliError(`missing required flag --${name}`);
  }
  return value;
}

function requireOperator(as: string | null): string {
  if (!as) {
    throw new CliError('this command mutates state: pass --as <operator>');
  }
  return as;
}

function parseDurationSec(text: string | null): number | undefined {
  if (!text) {
    return undefined;
  }
  const match = /^(\d+)([hms])$/.exec(text);
  if (!match) {
    throw new CliError(`--since must look like 1h / 30m / 45s, got "${text}"`);
  }
  const value = Number(match[1]);
  return match[2] === 'h' ? value * 3600 : match[2] === 'm' ? value * 60 : value;
}

interface TenantRow {
  id: string;
  user_id: string;
  status: string;
  container_name: string;
  volume_name: string;
  image: string;
  previous_image: string | null;
  image_digest: string | null;
  kind: 'customer' | 'internal' | 'synthetic' | 'demo';
  cohort: 'canary' | 'early' | 'stable';
  phase: string | null;
  app_version: string | null;
  contract_version: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function getTenant(ctx: AppContext, id: string): TenantRow {
  const row = ctx.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as TenantRow | undefined;
  if (!row) {
    throw new CliError(`tenant ${id} not found`);
  }
  return row;
}

async function stopTenantContainer(ctx: AppContext, tenant: TenantRow): Promise<void> {
  const id = await findContainerId(ctx, tenant.container_name);
  if (id) {
    await ctx.docker.stopContainer(id, 30);
  }
}

async function startTenantContainer(ctx: AppContext, tenant: TenantRow): Promise<void> {
  const id = await findContainerId(ctx, tenant.container_name);
  if (!id) {
    throw new CliError(`container ${tenant.container_name} not found`);
  }
  await ctx.docker.startContainer(id);
}

// --- commands ---------------------------------------------------------------

function cmdHostRegister(ctx: AppContext, flags: Map<string, string | boolean>, id: string, as: string): void {
  if (!/^h_[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new CliError('host id must look like h_<name>');
  const environment = requireFlag(flags, 'environment');
  if (environment !== 'staging' && environment !== 'production') throw new CliError('--environment must be staging or production');
  const capacity = Number(requireFlag(flags, 'capacity'));
  if (!Number.isInteger(capacity) || capacity < 1) throw new CliError('--capacity must be a positive integer');
  const fingerprint = flagString(flags, 'fingerprint')?.replaceAll(':', '').toUpperCase() ?? null;
  const token = fingerprint ? null : newGatewaySecret();
  ctx.db.prepare(`INSERT INTO hosts (id, docker_url, capacity, status, environment, agent_token_hash, agent_fingerprint)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET docker_url = excluded.docker_url, capacity = excluded.capacity,
      status = 'active', environment = excluded.environment,
      agent_token_hash = excluded.agent_token_hash, agent_fingerprint = excluded.agent_fingerprint`)
    .run(id, `agent://${id}`, capacity, environment, token ? sha256Hex(token) : null, fingerprint);
  audit(ctx, as, 'host.register', id, { environment, capacity, credential: fingerprint ? 'mtls' : 'token' });
  console.log(`${id}: registered environment=${environment} capacity=${capacity}${token ? `\nagent token (shown once): ${token}` : ''}`);
}

function cmdAdminCreate(ctx: AppContext, flags: Map<string, string | boolean>, username: string, as: string): void {
  const role = requireFlag(flags, 'role') as AdminRole;
  const result = createAdminUser(ctx.db, ctx.config.masterKey, { username, role }, as);
  console.log(`id: ${result.id}\nusername: ${result.username}\nrole: ${result.role}\ntoken (shown once): ${result.token}\nmfa secret (shown once): ${result.mfaSecret}\notpauth: ${result.otpauthUrl}`);
}

function cmdAdminDisable(ctx: AppContext, id: string, as: string): void {
  disableAdminUser(ctx.db, id, as);
  console.log(`admin ${id} disabled`);
}

function rolloutManager(ctx: AppContext): RolloutManager {
  ctx.rollouts ??= new RolloutManager(ctx, new SqliteRolloutStore(ctx.db));
  return ctx.rollouts;
}

async function cmdRolloutCreate(ctx: AppContext, flags: Map<string, string | boolean>, rest: string[], as: string): Promise<void> {
  const releaseId = rest[0];
  if (!releaseId) throw new CliError('usage: rollout create RELEASE_ID [TENANT_ID ...] [--kind KIND] [--cohort COHORT] [--environment ENV]');
  const kind = flagString(flags, 'kind') as 'customer' | 'internal' | 'synthetic' | 'demo' | null;
  const cohort = flagString(flags, 'cohort') as 'canary' | 'early' | 'stable' | null;
  const environment = flagString(flags, 'environment') as 'staging' | 'production' | null;
  const mode = flagString(flags, 'mode') ?? 'upgrade';
  if (mode !== 'upgrade' && mode !== 'rollback') throw new CliError('--mode must be upgrade or rollback');
  const view = await rolloutManager(ctx).create({
    releaseId,
    operator: as,
    mode,
    tenantIds: rest.length > 1 ? rest.slice(1) : undefined,
    ...(kind ? { kind } : {}),
    ...(cohort ? { cohort } : {}),
    ...(environment ? { environment } : {}),
    globalConcurrency: Number(flagString(flags, 'global-concurrency') ?? '20'),
    perHostConcurrency: Number(flagString(flags, 'per-host-concurrency') ?? '1'),
    ...(flagString(flags, 'soak-ms') ? { soakMs: Number(flagString(flags, 'soak-ms')) } : {}),
  });
  console.log(`${view.job.id}: paused release=${view.job.releaseId} tenants=${view.items.length} waves=${view.waves.length}`);
}

function printRollout(view: NonNullable<Awaited<ReturnType<SqliteRolloutStore['getJob']>>>): void {
  const counts: Record<string, number> = {};
  for (const item of view.items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  console.log(JSON.stringify({
    id: view.job.id,
    releaseId: view.job.releaseId,
    mode: view.job.mode,
    status: view.job.status,
    currentWave: view.job.currentWave,
    waves: view.waves,
    items: counts,
    stopReason: view.job.stopReason,
    operator: view.job.operator,
    createdAt: view.job.createdAt,
    updatedAt: view.job.updatedAt,
  }));
}

function cmdReleaseRegister(ctx: AppContext, flags: Map<string, string | boolean>, as: string): void {
  const file = requireFlag(flags, 'file');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const result = registerRelease(ctx.db, manifest, as);
  console.log(`${result.release.id}: ${result.duplicate ? 'already registered' : 'registered'} status=${result.release.status} image=${result.release.tenant.image} digest=${result.release.tenant.digest}`);
}

function cmdReleaseList(ctx: AppContext): void {
  for (const release of listReleases(ctx.db)) {
    console.log(`${release.id}  ${release.status}  app=${release.appVersion}  schema=${release.databaseSchemaVersion}  image=${release.tenant.image}  digest=${release.tenant.digest}`);
  }
}

function cmdReleasePromote(ctx: AppContext, flags: Map<string, string | boolean>, id: string, as: string): void {
  const status = requireFlag(flags, 'status') as 'candidate' | 'canary' | 'stable' | 'retired';
  const release = setReleaseStatus(ctx.db, id, status, as);
  console.log(`${release.id}: status=${release.status}`);
}

function cmdInviteCreate(ctx: AppContext, flags: Map<string, string | boolean>, as: string): void {
  const usesRaw = flagString(flags, 'uses') ?? '1';
  const uses = Number(usesRaw);
  if (!Number.isInteger(uses) || uses < 1) {
    throw new CliError(`--uses must be a positive integer, got "${usesRaw}"`);
  }
  const withRedeem = flags.get('with-redeem') === true ? 1 : 0;
  const expiresText = flagString(flags, 'expires');
  let expiresAt: number | null = null;
  if (expiresText) {
    const parsed = Date.parse(expiresText);
    if (Number.isNaN(parsed)) {
      throw new CliError(`--expires must be a parseable date, got "${expiresText}"`);
    }
    expiresAt = parsed;
  }
  const note = flagString(flags, 'note');
  const code = newInviteCode();
  ctx.db
    .prepare(
      `INSERT INTO invites (code, max_uses, used_count, with_redeem, note, expires_at, disabled, created_at)
       VALUES (?, ?, 0, ?, ?, ?, 0, ?)`,
    )
    .run(code, uses, withRedeem, note, expiresAt, Date.now());
  audit(ctx, as, 'invite.create', code, { uses, withRedeem, expiresAt, note });
  // The ONLY place a code is printed.
  console.log(`code: ${code}`);
}

function cmdInviteList(ctx: AppContext): void {
  const rows = ctx.db
    .prepare(
      'SELECT code, max_uses, used_count, with_redeem, disabled, expires_at, note, created_at FROM invites ORDER BY created_at',
    )
    .all() as Array<{
    code: string;
    max_uses: number;
    used_count: number;
    with_redeem: number;
    disabled: number;
    expires_at: number | null;
    note: string | null;
    created_at: number;
  }>;
  for (const row of rows) {
    console.log(
      `${row.code}  uses ${row.used_count}/${row.max_uses}  withRedeem=${row.with_redeem}  ` +
        `disabled=${row.disabled}  expires=${row.expires_at ?? '-'}  note=${row.note ?? '-'}`,
    );
  }
}

function cmdInviteDisable(ctx: AppContext, code: string, as: string): void {
  const info = ctx.db.prepare('UPDATE invites SET disabled = 1 WHERE code = ?').run(code);
  if (info.changes === 0) {
    throw new CliError(`invite ${code} not found`);
  }
  audit(ctx, as, 'invite.disable', code);
  console.log(`invite ${code} disabled`);
}

function cmdRedeemImport(ctx: AppContext, flags: Map<string, string | boolean>, as: string): void {
  const file = requireFlag(flags, 'file');
  const note = flagString(flags, 'note');
  const content = fs.readFileSync(file, 'utf8');
  let imported = 0;
  let skipped = 0;
  const insert = ctx.db.prepare(
    `INSERT INTO redeem_codes (code_enc, code_hash, batch_note, imported_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const codeHash = sha256Hex(line);
    const exists = ctx.db.prepare('SELECT 1 FROM redeem_codes WHERE code_hash = ?').get(codeHash);
    if (exists) {
      skipped += 1;
      continue;
    }
    insert.run(encryptSecret(ctx.config.masterKey, line), codeHash, note, Date.now());
    imported += 1;
  }
  audit(ctx, as, 'redeem.import', file, { imported, skipped, note });
  console.log(`imported=${imported} skipped=${skipped}`);
}

function cmdRedeemStats(ctx: AppContext): void {
  const one = ctx.db
    .prepare(
      `SELECT COUNT(*) AS imported,
              COUNT(assigned_user_id) AS assigned,
              COUNT(*) - COUNT(assigned_user_id) AS remaining
       FROM redeem_codes`,
    )
    .get() as { imported: number; assigned: number; remaining: number };
  console.log(`imported=${one.imported} assigned=${one.assigned} remaining=${one.remaining}`);
}

function cmdCreditGrant(ctx: AppContext, flags: Map<string, string | boolean>, as: string): void {
  const userId = requireFlag(flags, 'user');
  const bytesText = requireFlag(flags, 'bytes');
  const bytes = Number(bytesText);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new CliError(`--bytes must be a positive integer (bytes), got "${bytesText}"`);
  }
  const reason = requireFlag(flags, 'reason');
  let result;
  try {
    result = grantCredit(ctx, {
      userId,
      bytes,
      reason,
      source: 'manual',
      actor: `admin:${as}`,
      referenceKey: flagString(flags, 'reference'),
      applyCode: flagString(flags, 'code'),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      throw new CliError(`${err.code}: ${err.message}`);
    }
    throw err;
  }
  if (result.duplicate) {
    console.log(
      `credit #${result.creditId} already exists for reference ${result.referenceKey} — no second grant`,
    );
  } else {
    console.log(
      `credit #${result.creditId}: ${result.bytes} bytes → user ${result.userId} ` +
        `(reference ${result.referenceKey ?? '-'}, apply=${result.applyState}, code=${result.hasApplyCode ? 'yes' : 'no'})`,
    );
  }
}

function cmdCreditAttachCode(ctx: AppContext, flags: Map<string, string | boolean>, as: string): void {
  const idText = requireFlag(flags, 'id');
  const creditId = Number(idText);
  if (!Number.isInteger(creditId) || creditId <= 0) {
    throw new CliError(`--id must be a positive integer, got "${idText}"`);
  }
  const code = requireFlag(flags, 'code');
  let result;
  try {
    result = attachCreditApplyCode(ctx, { creditId, code, actor: `admin:${as}` });
  } catch (err) {
    if (err instanceof HttpError) {
      throw new CliError(`${err.code}: ${err.message}`);
    }
    throw err;
  }
  console.log(
    `credit #${result.creditId}: application code attached ` +
      `(${result.bytes} bytes → user ${result.userId}, apply=${result.applyState})`,
  );
}

function cmdCreditList(ctx: AppContext, flags: Map<string, string | boolean>): void {
  const user = flagString(flags, 'user');
  const rows = listCredits(ctx, { userId: user ?? undefined });
  if (rows.length === 0) {
    console.log('no credit grants recorded');
    return;
  }
  for (const row of rows) {
    console.log(
      `#${row.id}  user=${row.user_id}  bytes=${row.bytes_total}  source=${row.source}  ` +
        `by=${row.actor}  at=${row.created_at}  ref=${row.reference_key ?? '-'}  reason=${row.reason}`,
    );
  }
}

function cmdUserList(ctx: AppContext, flags: Map<string, string | boolean>): void {
  const filter = flagString(flags, 'phone');
  const rows = ctx.db
    .prepare('SELECT id, phone_e164, display_name, locale, status, created_at FROM users ORDER BY created_at')
    .all() as Array<{ id: string; phone_e164: string; display_name: string; locale: string; status: string; created_at: number }>;
  for (const row of rows) {
    if (filter && !row.phone_e164.includes(filter)) {
      continue;
    }
    console.log(
      `${row.id}  ${maskPhone(row.phone_e164)}  ${row.display_name}  ${row.locale}  ${row.status}  created=${row.created_at}`,
    );
  }
}

async function cmdUserSetStatus(
  ctx: AppContext,
  id: string,
  status: 'active' | 'disabled',
  as: string,
): Promise<void> {
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | { id: string; phone_e164: string }
    | undefined;
  if (!user) {
    throw new CliError(`user ${id} not found`);
  }
  ctx.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  const tenant = ctx.db.prepare('SELECT * FROM tenants WHERE user_id = ?').get(id) as
    | TenantRow
    | undefined;
  if (tenant) {
    if (status === 'disabled') {
      // Suspending stops the container and freezes the tenant.
      await stopTenantContainer(ctx, tenant);
      ctx.db
        .prepare("UPDATE tenants SET status = 'suspended', updated_at = ? WHERE id = ?")
        .run(Date.now(), tenant.id);
    } else {
      ctx.db
        .prepare("UPDATE tenants SET status = 'booting', updated_at = ? WHERE id = ?")
        .run(Date.now(), tenant.id);
      await startTenantContainer(ctx, tenant);
    }
  }
  audit(ctx, as, status === 'disabled' ? 'user.disable' : 'user.enable', id, { tenant: tenant?.id });
  console.log(`user ${id} ${status}`);
}

function cmdTenantList(ctx: AppContext, flags: Map<string, string | boolean>): void {
  const status = flagString(flags, 'status');
  const kind = flagString(flags, 'kind');
  const cohort = flagString(flags, 'cohort');
  const environment = flagString(flags, 'environment');
  const rows = ctx.db
    .prepare(`SELECT tenants.id, tenants.user_id, tenants.status, tenants.image, tenants.app_version,
                     tenants.container_name, tenants.kind, tenants.cohort, tenants.image_digest,
                     hosts.environment
              FROM tenants LEFT JOIN hosts ON hosts.id = tenants.host_id
              ORDER BY tenants.created_at`)
    .all() as Array<{
      id: string;
      user_id: string;
      status: string;
      image: string;
      app_version: string | null;
      container_name: string;
      kind: string;
      cohort: string;
      image_digest: string | null;
      environment: string | null;
    }>;
  for (const row of rows) {
    if (status && row.status !== status) continue;
    if (kind && row.kind !== kind) continue;
    if (cohort && row.cohort !== cohort) continue;
    if (environment && row.environment !== environment) continue;
    console.log(
      `${row.id}  ${row.status}  image=${row.image}  appVersion=${row.app_version ?? '-'}  ` +
        `user=${row.user_id}  container=${row.container_name}  kind=${row.kind}  cohort=${row.cohort}  ` +
        `environment=${row.environment ?? '-'}  digest=${row.image_digest?.slice(0, 19) ?? '-'}`,
    );
  }
}

function cmdTenantShow(ctx: AppContext, id: string): void {
  const row = getTenant(ctx, id);
  console.log(
    [
      `id:            ${row.id}`,
      `user_id:       ${row.user_id}`,
      `status:        ${row.status}`,
      `phase:         ${row.phase ?? '-'}`,
      `image:         ${row.image}`,
      `previous_image: ${row.previous_image ?? '-'}`,
      `image_digest:  ${row.image_digest ?? '-'}`,
      `kind:          ${row.kind}`,
      `cohort:        ${row.cohort}`,
      `app_version:   ${row.app_version ?? '-'}`,
      `contract_version: ${row.contract_version ?? '-'}`,
      `last_error:    ${row.last_error ?? '-'}`,
      `container:     ${row.container_name}`,
      `volume:        ${row.volume_name}`,
      `created_at:    ${row.created_at}`,
      `updated_at:    ${row.updated_at}`,
    ].join('\n'),
  );
}

async function cmdTenantLifecycle(
  ctx: AppContext,
  action: 'restart' | 'stop' | 'start',
  id: string,
  as: string,
): Promise<void> {
  const tenant = getTenant(ctx, id);
  if (action === 'restart') {
    await stopTenantContainer(ctx, tenant);
    await startTenantContainer(ctx, tenant);
    ctx.db.prepare("UPDATE tenants SET status = 'booting', updated_at = ? WHERE id = ?").run(Date.now(), id);
  } else if (action === 'stop') {
    await stopTenantContainer(ctx, tenant);
    const now = Date.now();
    ctx.db.prepare("UPDATE tenants SET status = 'stopped', phase = NULL, updated_at = ? WHERE id = ?").run(now, id);
    ctx.db.prepare('UPDATE invite_grants SET hibernated_at = NULL, updated_at = ? WHERE tenant_id = ?').run(now, id);
  } else {
    await startTenantContainer(ctx, tenant);
    ctx.db.prepare("UPDATE tenants SET status = 'booting', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }
  audit(ctx, as, `tenant.${action}`, id);
  console.log(`tenant ${id}: ${action} done`);
}

function cmdTenantClassify(ctx: AppContext, flags: Map<string, string | boolean>, id: string, as: string): void {
  const tenant = getTenant(ctx, id);
  const kind = flagString(flags, 'kind') ?? tenant.kind;
  const cohort = flagString(flags, 'cohort') ?? tenant.cohort;
  if (!['customer', 'internal', 'synthetic', 'demo'].includes(kind)) {
    throw new CliError('--kind must be customer, internal, synthetic, or demo');
  }
  if (!['canary', 'early', 'stable'].includes(cohort)) {
    throw new CliError('--cohort must be canary, early, or stable');
  }
  if (!flagString(flags, 'kind') && !flagString(flags, 'cohort')) {
    throw new CliError('pass --kind and/or --cohort');
  }
  ctx.db.prepare('UPDATE tenants SET kind = ?, cohort = ?, updated_at = ? WHERE id = ?')
    .run(kind, cohort, Date.now(), id);
  audit(ctx, as, 'tenant.classify', id, { from: { kind: tenant.kind, cohort: tenant.cohort }, to: { kind, cohort } });
  console.log(`tenant ${id}: kind=${kind} cohort=${cohort}`);
}

async function cmdTenantUpgrade(
  ctx: AppContext,
  flags: Map<string, string | boolean>,
  ids: string[],
  as: string,
): Promise<void> {
  const image = requireFlag(flags, 'image');
  let tenantIds = ids;
  if (flags.get('all') === true) {
    const kind = flagString(flags, 'kind');
    const cohort = flagString(flags, 'cohort');
    const environment = flagString(flags, 'environment');
    if (kind && !['customer', 'internal', 'synthetic', 'demo'].includes(kind)) {
      throw new CliError('--kind must be customer, internal, synthetic, or demo');
    }
    if (cohort && !['canary', 'early', 'stable'].includes(cohort)) {
      throw new CliError('--cohort must be canary, early, or stable');
    }
    if (environment && !['staging', 'production'].includes(environment)) {
      throw new CliError('--environment must be staging or production');
    }
    tenantIds = selectFleetUpgradeTenantIds(ctx.db, {
      targetImage: image,
      targetDigest: flagString(flags, 'digest'),
      ...(kind ? { kind: kind as 'customer' | 'internal' | 'synthetic' | 'demo' } : {}),
      ...(cohort ? { cohort: cohort as 'canary' | 'early' | 'stable' } : {}),
      ...(environment ? { environment: environment as 'staging' | 'production' } : {}),
    });
  }
  if (tenantIds.length === 0) {
    if (flags.get('all') === true) {
      console.log('no tenants require upgrade');
      return;
    }
    throw new CliError('no tenants selected (pass ids or --all)');
  }
  const batch = Number(flagString(flags, 'batch') ?? '1');
  if (!Number.isInteger(batch) || batch < 1) {
    throw new CliError(`--batch must be a positive integer, got "${batch}"`);
  }
  const results = await upgradeTenants(ctx, tenantIds, image, { batch, operator: as });
  for (const result of results) {
    console.log(`${result.tenantId}: ${result.outcome} (${result.detail})`);
  }
}

async function cmdTenantRotateSecret(ctx: AppContext, id: string, as: string): Promise<void> {
  const tenant = getTenant(ctx, id);
  const secret = newGatewaySecret();
  ctx.db
    .prepare('UPDATE tenants SET gateway_secret_enc = ?, updated_at = ? WHERE id = ?')
    .run(encryptSecret(ctx.config.masterKey, secret), Date.now(), id);
  await recreateContainer(ctx, tenant, tenant.image, secret);
  ctx.db.prepare("UPDATE tenants SET status = 'booting', updated_at = ? WHERE id = ?").run(Date.now(), id);
  audit(ctx, as, 'tenant.rotate-secret', id);
  console.log(`tenant ${id}: secret rotated, container recreated`);
}

async function cmdTenantLogs(ctx: AppContext, flags: Map<string, string | boolean>, id: string): Promise<void> {
  const tenant = getTenant(ctx, id);
  const containerId = await findContainerId(ctx, tenant.container_name);
  if (!containerId) {
    throw new CliError(`container ${tenant.container_name} not found`);
  }
  const since = parseDurationSec(flagString(flags, 'since'));
  const sinceSec = since === undefined ? undefined : Math.floor(Date.now() / 1000) - since;
  process.stdout.write(await ctx.docker.containerLogs(containerId, sinceSec));
}

async function cmdTenantExport(ctx: AppContext, flags: Map<string, string | boolean>, id: string, as: string): Promise<void> {
  const tenant = getTenant(ctx, id);
  const to = requireFlag(flags, 'to');
  const containerId = await findContainerId(ctx, tenant.container_name);
  if (!containerId) {
    throw new CliError(`container ${tenant.container_name} not found`);
  }
  await ctx.docker.stopContainer(containerId, 30);
  let archive: Buffer;
  try {
    archive = await ctx.docker.containerArchive(containerId, '/data');
  } finally {
    await ctx.docker.startContainer(containerId);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, archive);
  ctx.db.prepare("UPDATE tenants SET status = 'booting', updated_at = ? WHERE id = ?").run(Date.now(), id);

  const openRequest = ctx.db
    .prepare("SELECT id FROM deletion_requests WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .get(tenant.user_id) as { id: number } | undefined;
  if (openRequest) {
    ctx.db
      .prepare("UPDATE deletion_requests SET status = 'exported' WHERE id = ?")
      .run(openRequest.id);
  }
  audit(ctx, as, 'tenant.export', id, { to, bytes: archive.length, deletionRequest: openRequest?.id ?? null });
  console.log(`tenant ${id}: exported ${archive.length} bytes to ${to}`);
}

/**
 * push.send-test — deliver one real test notification to every enabled device
 * of a user through the configured provider (FCM in acceptance). Read-only
 * audit-wise (no config mutation), but it sends a real provider message, so
 * it requires --as like other operational commands.
 */
async function cmdPushSendTest(
  ctx: AppContext,
  flags: Map<string, string | boolean>,
  as: string,
): Promise<void> {
  if (ctx.config.push.provider === 'disabled') {
    throw new CliError(
      'push provider is disabled on this CLI context; set CP_PUSH_PROVIDER=fcm and CP_FCM_SERVICE_ACCOUNT_JSON in the environment first',
    );
  }
  const phone = flags.get('phone');
  const userId = flags.get('user');
  if (typeof phone !== 'string' && typeof userId !== 'string') {
    throw new CliError('usage: push.send-test --phone +8613800138000 | --user <id> [--title T] [--body B] [--as NAME]');
  }
  const user = typeof phone === 'string'
    ? ctx.db.prepare('SELECT id, phone_e164 FROM users WHERE phone_e164 = ?').get(phone) as { id: string; phone_e164: string } | undefined
    : ctx.db.prepare('SELECT id, phone_e164 FROM users WHERE id = ?').get(userId as string) as { id: string; phone_e164: string } | undefined;
  if (!user) throw new CliError('user not found');
  const tenant = ctx.db
    .prepare("SELECT id FROM tenants WHERE user_id = ? AND status IN ('ready', 'degraded') ORDER BY rowid DESC LIMIT 1")
    .get(user.id) as { id: string } | undefined;
  if (!tenant) throw new CliError('user has no ready tenant; notification routing keys off the tenant');
  const devices = ctx.db
    .prepare('SELECT device_id, platform, enabled FROM user_devices WHERE user_id = ?')
    .all(user.id) as Array<{ device_id: string; platform: string; enabled: number }>;
  const enabledDevices = devices.filter((d) => d.enabled === 1);
  console.log(`user=${user.id} phone=${maskPhone(user.phone_e164)} tenant=${tenant.id}`);
  console.log(`devices: ${devices.length} registered, ${enabledDevices.length} enabled (${enabledDevices.map((d) => d.platform).join(', ') || 'none'})`);
  if (enabledDevices.length === 0) {
    throw new CliError('no enabled device registered; sign in on the device and let the shell register for push first');
  }
  const eventId = `push-test-${Date.now()}`;
  const result = await ctx.push.ingest(tenant.id, {
    eventId,
    type: 'system.test',
    category: 'system',
    title: typeof flags.get('title') === 'string' ? flags.get('title') as string : 'IDBots 推送验收测试',
    body: typeof flags.get('body') === 'string' ? flags.get('body') as string : `这是一条真实推送验收消息（${eventId}）。收到即表示 FCM 链路畅通。`,
    priority: 'high',
  });
  const deliveries = ctx.db
    .prepare('SELECT device_id, state, provider_message_id, last_error FROM push_deliveries WHERE event_id = ?')
    .all(eventId) as Array<{ device_id: string; state: string; provider_message_id: string | null; last_error: string | null }>;
  for (const row of deliveries) {
    console.log(`  device=${row.device_id} state=${row.state} msg=${row.provider_message_id ?? '-'} err=${row.last_error ?? '-'}`);
  }
  console.log(`accepted event=${result.eventId} devices=${result.devices} duplicate=${result.duplicate}`);
  if (result.devices === 0) {
    throw new CliError('ingest matched 0 devices (check notification preferences: category "system" must be enabled)');
  }
  audit(ctx, as, 'push.send-test', user.id, { eventId, devices: result.devices });
}

function cmdDeletionList(ctx: AppContext): void {
  const rows = ctx.db
    .prepare('SELECT id, user_id, reason, status, created_at, closed_at FROM deletion_requests ORDER BY created_at')
    .all() as Array<{ id: number; user_id: string; reason: string | null; status: string; created_at: number; closed_at: number | null }>;
  for (const row of rows) {
    console.log(
      `#${row.id}  user=${row.user_id}  status=${row.status}  created=${row.created_at}  closed=${row.closed_at ?? '-'}  reason=${row.reason ?? '-'}`,
    );
  }
}

async function cmdDeletionComplete(
  ctx: AppContext,
  idText: string,
  flags: Map<string, string | boolean>,
  as: string,
): Promise<void> {
  const requestId = Number(idText.replace(/^#/, ''));
  const request = ctx.db.prepare('SELECT * FROM deletion_requests WHERE id = ?').get(requestId) as
    | { id: number; user_id: string; status: string }
    | undefined;
  if (!request) {
    throw new CliError(`deletion request ${idText} not found`);
  }
  if (request.status !== 'exported') {
    throw new CliError(`deletion request ${requestId} is "${request.status}" — an export must exist first`);
  }
  const confirm = flagString(flags, 'confirm');
  const user = ctx.db.prepare('SELECT phone_e164 FROM users WHERE id = ?').get(request.user_id) as
    | { phone_e164: string }
    | undefined;
  if (!user || confirm !== user.phone_e164) {
    throw new CliError('--confirm does not match the user phone; refusing');
  }
  const tenant = ctx.db.prepare('SELECT * FROM tenants WHERE user_id = ?').get(request.user_id) as
    | TenantRow
    | undefined;
  if (tenant) {
    const containerId = await findContainerId(ctx, tenant.container_name);
    if (containerId) {
      await ctx.docker.removeContainer(containerId, { force: true });
    }
    try {
      await ctx.docker.removeVolume(tenant.volume_name);
    } catch {
      // volume may already be gone; deletion is best-effort here
    }
    ctx.db.prepare('DELETE FROM tenants WHERE id = ?').run(tenant.id);
  }
  // The user row stays: re-login semantics after deletion belong to a later phase.
  ctx.db
    .prepare("UPDATE deletion_requests SET status = 'deleted', closed_at = ? WHERE id = ?")
    .run(Date.now(), request.id);
  audit(ctx, as, 'deletion.complete', String(request.id), { user: request.user_id, tenant: tenant?.id ?? null });
  console.log(`deletion request ${request.id} completed`);
}

// --- dispatch ---------------------------------------------------------------

const MUTATING = new Set([
  'host.register',
  'admin.create',
  'admin.disable',
  'rollout.create',
  'rollout.start',
  'rollout.pause',
  'rollout.resume',
  'rollout.cancel',
  'rollout.retry',
  'release.register',
  'release.promote',
  'invite.create',
  'invite.disable',
  'redeem.import',
  'credit.grant',
  'credit.attach-code',
  'user.disable',
  'user.enable',
  'tenant.restart',
  'tenant.stop',
  'tenant.start',
  'tenant.classify',
  'tenant.upgrade',
  'tenant.rotate-secret',
  'tenant.export',
  'deletion.complete',
]);

async function run(argv: string[]): Promise<void> {
  const asIdx = argv.indexOf('--as');
  const as = asIdx !== -1 ? (argv[asIdx + 1] ?? null) : null;
  const args = asIdx === -1 ? argv : argv.filter((_, i) => i !== asIdx && i !== asIdx + 1);
  const { positionals, flags } = parseArgs(args);
  const [domain, command, ...rest] = positionals;
  const action = domain && command ? `${domain}.${command}` : domain ?? '';

  if (MUTATING.has(action)) {
    requireOperator(as);
  }
  if (!domain) {
    throw new CliError('usage: cli.js <host|admin|rollout|release|invite|redeem|credit|user|tenant|deletion|push> <command> [flags] [--as NAME]');
  }

  const ctx = loadCliContext(process.env);
  try {
    switch (action) {
      case 'host.register':
        cmdHostRegister(ctx, flags, rest[0], as!);
        break;
      case 'host.list':
        console.log(JSON.stringify(ctx.db.prepare('SELECT id, environment, capacity, status, agent_fingerprint, agent_last_seen_at FROM hosts ORDER BY id').all(), null, 2));
        break;
      case 'admin.create':
        cmdAdminCreate(ctx, flags, rest[0], as!);
        break;
      case 'admin.list':
        console.log(JSON.stringify(listAdminUsers(ctx.db), null, 2));
        break;
      case 'admin.disable':
        cmdAdminDisable(ctx, rest[0], as!);
        break;
      case 'rollout.create':
        await cmdRolloutCreate(ctx, flags, rest, as!);
        break;
      case 'rollout.list':
        for (const view of await rolloutManager(ctx).store.listJobs()) printRollout(view);
        break;
      case 'rollout.show':
        printRollout(await rolloutManager(ctx).requireJob(rest[0]));
        break;
      case 'rollout.start':
      case 'rollout.resume':
        await rolloutManager(ctx).resume(rest[0]);
        break;
      case 'rollout.pause':
        await rolloutManager(ctx).pause(rest[0]);
        break;
      case 'rollout.cancel':
        await rolloutManager(ctx).cancel(rest[0]);
        break;
      case 'rollout.retry':
        console.log(`retry items: ${await rolloutManager(ctx).retryFailed(rest[0])}`);
        break;
      case 'release.register':
        cmdReleaseRegister(ctx, flags, as!);
        break;
      case 'release.list':
        cmdReleaseList(ctx);
        break;
      case 'release.promote':
        cmdReleasePromote(ctx, flags, rest[0], as!);
        break;
      case 'invite.create':
        cmdInviteCreate(ctx, flags, as!);
        break;
      case 'invite.list':
        cmdInviteList(ctx);
        break;
      case 'invite.disable':
        cmdInviteDisable(ctx, rest[0], as!);
        break;
      case 'redeem.import':
        cmdRedeemImport(ctx, flags, as!);
        break;
      case 'redeem.stats':
        cmdRedeemStats(ctx);
        break;
      case 'credit.grant':
        cmdCreditGrant(ctx, flags, as!);
        break;
      case 'credit.list':
        cmdCreditList(ctx, flags);
        break;
      case 'credit.attach-code':
        cmdCreditAttachCode(ctx, flags, as!);
        break;
      case 'user.list':
        cmdUserList(ctx, flags);
        break;
      case 'user.disable':
        await cmdUserSetStatus(ctx, rest[0], 'disabled', as!);
        break;
      case 'user.enable':
        await cmdUserSetStatus(ctx, rest[0], 'active', as!);
        break;
      case 'tenant.list':
        cmdTenantList(ctx, flags);
        break;
      case 'tenant.show':
        cmdTenantShow(ctx, rest[0]);
        break;
      case 'tenant.restart':
        await cmdTenantLifecycle(ctx, 'restart', rest[0], as!);
        break;
      case 'tenant.stop':
        await cmdTenantLifecycle(ctx, 'stop', rest[0], as!);
        break;
      case 'tenant.start':
        await cmdTenantLifecycle(ctx, 'start', rest[0], as!);
        break;
      case 'tenant.classify':
        cmdTenantClassify(ctx, flags, rest[0], as!);
        break;
      case 'tenant.upgrade':
        await cmdTenantUpgrade(ctx, flags, rest, as!);
        break;
      case 'tenant.rotate-secret':
        await cmdTenantRotateSecret(ctx, rest[0], as!);
        break;
      case 'tenant.logs':
        await cmdTenantLogs(ctx, flags, rest[0]);
        break;
      case 'tenant.export':
        await cmdTenantExport(ctx, flags, rest[0], as!);
        break;
      case 'deletion.list':
        cmdDeletionList(ctx);
        break;
      case 'push.send-test':
        await cmdPushSendTest(ctx, flags, as!);
        break;
      case 'deletion.complete':
        await cmdDeletionComplete(ctx, rest[0], flags, as!);
        break;
      default:
        throw new CliError(`unknown command: ${action}`);
    }
  } finally {
    ctx.db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
