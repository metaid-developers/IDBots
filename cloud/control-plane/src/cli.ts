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
import { ConfigError } from './config.js';
import type { ControlPlaneConfig } from './config.js';
import { DockerClient } from './docker/client.js';
import { FakeSmsProvider } from './sms.js';
import { newInviteCode, newGatewaySecret } from './ids.js';
import { encryptSecret, sha256Hex, maskPhone } from './crypto.js';
import { upgradeTenants, findContainerId, recreateContainer } from './services/upgrade.js';
import { MetricsRegistry } from './metrics.js';
import type { AppContext } from './context.js';

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
    // The CLI never serves HTTP; this is an inert default.
    loginBundleDir: '',
    // The CLI never serves the voice gateway either; inert stub defaults.
    asr: {
      upstream: 'stub',
      dailyLimitMinutes: 60,
      maxSessionSeconds: 600,
      doubao: { endpoint: '', resourceId: '', apiKey: null, appId: null, accessToken: null },
      funasrEndpoint: null,
      stub: { delayMs: 0, disconnectAfterMs: 0, slowFinalMs: 0 },
    },
  } as ControlPlaneConfig;
  const docker = new DockerClient(config.dockerUrl);
  return {
    config,
    db: openDb(dbPath),
    docker,
    sms: new FakeSmsProvider([]),
    poller: null,
    metrics: new MetricsRegistry(),
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
  const rows = ctx.db
    .prepare('SELECT id, user_id, status, image, app_version, container_name FROM tenants ORDER BY created_at')
    .all() as Array<{ id: string; user_id: string; status: string; image: string; app_version: string | null; container_name: string }>;
  for (const row of rows) {
    if (status && row.status !== status) {
      continue;
    }
    console.log(
      `${row.id}  ${row.status}  image=${row.image}  appVersion=${row.app_version ?? '-'}  user=${row.user_id}  container=${row.container_name}`,
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
    ctx.db.prepare("UPDATE tenants SET status = 'stopped', updated_at = ? WHERE id = ?").run(Date.now(), id);
  } else {
    await startTenantContainer(ctx, tenant);
    ctx.db.prepare("UPDATE tenants SET status = 'booting', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }
  audit(ctx, as, `tenant.${action}`, id);
  console.log(`tenant ${id}: ${action} done`);
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
    tenantIds = (
      ctx.db.prepare("SELECT id FROM tenants WHERE status != 'failed'").all() as Array<{ id: string }>
    ).map((row) => row.id);
  }
  if (tenantIds.length === 0) {
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
  'invite.create',
  'invite.disable',
  'redeem.import',
  'user.disable',
  'user.enable',
  'tenant.restart',
  'tenant.stop',
  'tenant.start',
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
    throw new CliError('usage: cli.js <invite|redeem|user|tenant|deletion> <command> [flags] [--as NAME]');
  }

  const ctx = loadCliContext(process.env);
  try {
    switch (action) {
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
