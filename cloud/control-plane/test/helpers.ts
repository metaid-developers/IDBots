import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/index.js';
import { loadConfig, type ControlPlaneConfig } from '../src/config.js';
import { DockerClient } from '../src/docker/client.js';
import { FakeSmsProvider } from '../src/sms.js';
import { createMetricsServer, createPublicServer } from '../src/server.js';
import { MetricsRegistry } from '../src/metrics.js';
import { encryptSecret } from '../src/crypto.js';
import type { AppContext } from '../src/context.js';

/** Fresh migrated SQLite database in a unique temp directory. */
export function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), 'cp-test-'));
  return openDb(path.join(dir, 'test.sqlite'));
}

export const MASTER_KEY = Buffer.alloc(32, 7);

export const TENANT_DEFAULTS = {
  hostId: 'h_testhost',
  tenantImage: 'registry.example.com/idbots/tenant:0.1.0-test',
};

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export interface TestApp {
  app: AppContext;
  config: ControlPlaneConfig;
  baseUrl: string;
  metricsUrl: string;
  close: () => Promise<void>;
}

/** In-process control plane (ephemeral port) over a caller-owned database. */
export async function startTestApp(options: {
  db: Database.Database;
  dockerUrl: string;
  alertWebhook?: string;
  fakeSmsNumbers?: string[];
  tenantImage?: string;
  tenantEnv?: Record<string, string>;
  /** Overrides for the /ws proxy keepalive (tests inject short intervals). */
  wsProxy?: import('../src/server.js').PublicServerOptions['wsProxy'];
  /** Overrides for the ASR voice gateway (upstream/quota injection). */
  asr?: import('../src/server.js').PublicServerOptions['asr'];
  /** CP_LOGIN_BUNDLE_DIR override. */
  loginBundleDir?: string;
}): Promise<TestApp> {
  const port = await freePort();
  const metricsPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    CP_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    CP_LISTEN: `127.0.0.1:${port}`,
    CP_METRICS_LISTEN: `127.0.0.1:${metricsPort}`,
    CP_DB_PATH: '/unused/test.sqlite',
    CP_MASTER_KEY: MASTER_KEY.toString('base64'),
    CP_DOCKER_URL: options.dockerUrl,
    CP_TENANT_IMAGE: options.tenantImage ?? 'fake-tenant:test',
    CP_TENANT_NETWORK: 'idbots-test',
    CP_SMS_MODE: 'fake',
    CP_FAKE_SMS_NUMBERS: (options.fakeSmsNumbers ?? ['+8613900000100']).join(','),
    ...(options.alertWebhook ? { CP_ALERT_WEBHOOK: options.alertWebhook } : {}),
    ...(options.tenantEnv
      ? Object.fromEntries(Object.entries(options.tenantEnv).map(([k, v]) => [`CP_TENANT_ENV_${k}`, v]))
      : {}),
    ...(options.loginBundleDir ? { CP_LOGIN_BUNDLE_DIR: options.loginBundleDir } : {}),
  };
  const config = loadConfig(env);
  const app: AppContext = {
    config,
    db: options.db,
    docker: new DockerClient(options.dockerUrl),
    sms: new FakeSmsProvider(config.fakeSmsNumbers),
    poller: null,
    metrics: new MetricsRegistry(),
  };
  const server = createPublicServer(app, {
    ...(options.wsProxy ? { wsProxy: options.wsProxy } : {}),
    ...(options.asr ? { asr: options.asr } : {}),
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const metricsServer = createMetricsServer(app);
  await new Promise<void>((resolve) => metricsServer.listen(metricsPort, '127.0.0.1', resolve));
  return {
    app,
    config,
    baseUrl: `http://127.0.0.1:${port}`,
    metricsUrl: `http://127.0.0.1:${metricsPort}`,
    close: () =>
      new Promise((resolve) =>
        server.close(() => metricsServer.close(() => resolve())),
      ),
  };
}

export interface ApiResponse {
  status: number;
  json: unknown;
  setCookie: string[];
  requestId: string | null;
}

/** fetch wrapper: JSON in/out, Origin defaults to the app origin. */
export async function api(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    origin?: string | null;
    cookie?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.origin !== null) {
    headers['Origin'] = options.origin ?? new URL(baseUrl).origin;
  }
  if (options.cookie) {
    headers['Cookie'] = options.cookie;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let json: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    status: res.status,
    json,
    setCookie: res.headers.getSetCookie(),
    requestId: res.headers.get('x-request-id'),
  };
}

/** `idb_session=<token>` from a verify response's Set-Cookie header. */
export function sessionCookieFrom(setCookie: string[]): string {
  const cookie = setCookie.find((entry) => entry.startsWith('idb_session='));
  if (!cookie) {
    throw new Error('no idb_session cookie in response');
  }
  return cookie.split(';')[0];
}

/** Insert a user + tenant row directly (bypasses signup) for poller/reconcile tests. */
export function seedUserAndTenant(
  db: Database.Database,
  opts: {
    userId: string;
    phone: string;
    tenantId: string;
    status: string;
    gatewaySecret?: string;
    image?: string;
    appVersion?: string | null;
    inviteCode?: string;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, phone_e164, display_name, locale, status, invite_code, created_at)
     VALUES (?, ?, 'Seed User', 'zh', 'active', ?, ?)`,
  ).run(opts.userId, opts.phone, opts.inviteCode ?? null, now);
  db.prepare(
    `INSERT INTO tenants (
       id, user_id, host_id, container_name, volume_name, image, previous_image,
       gateway_secret_enc, status, phase, app_version, contract_version, last_error,
       created_at, updated_at
     ) VALUES (?, ?, 'h_testhost', ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
  ).run(
    opts.tenantId,
    opts.userId,
    `idb-${opts.tenantId}`,
    `idb-${opts.tenantId}-data`,
    opts.image ?? 'fake-tenant:test',
    encryptSecret(MASTER_KEY, opts.gatewaySecret ?? 'test-secret'),
    opts.status,
    opts.appVersion === undefined ? null : opts.appVersion,
    now,
    now,
  );
}

/** Alert sink: captures webhook POST bodies for assertions. */
export function startAlertSink(): Promise<{ url: string; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { content?: { text?: string } };
        messages.push(body.content?.text ?? '');
      } catch {
        messages.push('<unparsable>');
      }
      res.writeHead(200);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        messages,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

export async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000, intervalMs = 40): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface SmsSeed {
  phone: string;
  ip: string;
  now: number;
  purpose?: 'login' | 'reverify';
  attempts?: number;
  consumedAt?: number | null;
}

let smsCounter = 0;

export function insertSmsSend(db: Database.Database, seed: SmsSeed): number {
  smsCounter += 1;
  const info = db
    .prepare(
      `INSERT INTO sms_codes (phone_e164, purpose, code_hash, attempts, expires_at, consumed_at, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.phone,
      seed.purpose ?? 'login',
      `hash-${seed.phone}-${seed.now}-${smsCounter}`,
      seed.attempts ?? 0,
      seed.now + 300_000,
      seed.consumedAt === undefined ? null : seed.consumedAt,
      seed.ip,
      seed.now,
    );
  return Number(info.lastInsertRowid);
}

export function insertInvite(
  db: Database.Database,
  seed: {
    code: string;
    maxUses?: number;
    usedCount?: number;
    withRedeem?: number;
    disabled?: number;
    expiresAt?: number | null;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO invites (code, max_uses, used_count, with_redeem, note, expires_at, disabled, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    seed.code,
    seed.maxUses ?? 1,
    seed.usedCount ?? 0,
    seed.withRedeem ?? 0,
    seed.expiresAt === undefined ? null : seed.expiresAt,
    seed.disabled ?? 0,
    seed.now,
  );
}

export function insertRedeemCode(
  db: Database.Database,
  seed: { codeHash: string; importedAt: number },
): void {
  db.prepare(
    `INSERT INTO redeem_codes (code_enc, code_hash, batch_note, imported_at)
     VALUES (?, ?, 'test-batch', ?)`,
  ).run(`enc-${seed.codeHash}`, seed.codeHash, seed.importedAt);
}
