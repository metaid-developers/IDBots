import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment-driven configuration (REQ-B configuration table). `loadConfig`
 * is pure and testable: it takes a process-env-like object and returns a typed
 * config, throwing a ConfigError with a clear message on any violation.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type SmsMode = 'aliyun' | 'fake';

/** Upstream selection for the ASR voice gateway (voice channel doc). */
export type AsrUpstreamKind = 'stub' | 'doubao' | 'funasr';

export interface AsrConfig {
  upstream: AsrUpstreamKind;
  /** Per-user per-day free allowance, minutes (CP_ASR_DAILY_LIMIT_MINUTES). */
  dailyLimitMinutes: number;
  /** Hard cap on one streaming connection, seconds (CP_ASR_MAX_SESSION_SECONDS). */
  maxSessionSeconds: number;
  doubao: {
    endpoint: string;
    resourceId: string;
    /** API-key auth (current Volcengine mode). Secret: env only, never logged. */
    apiKey: string | null;
    /** Legacy app-id + access-token pair. Secret: env only, never logged. */
    appId: string | null;
    accessToken: string | null;
  };
  /** Reserved: FunASR self-deployed endpoint (CP_ASR_FUNASR_ENDPOINT). */
  funasrEndpoint: string | null;
  /** Stub fault-injection knobs for joint debugging (seconds/milliseconds). */
  stub: {
    delayMs: number;
    disconnectAfterMs: number;
    slowFinalMs: number;
  };
}


export interface ControlPlaneConfig {
  publicOrigin: string;
  publicOriginUrl: URL;
  listen: string;
  metricsListen: string;
  dbPath: string;
  masterKey: Buffer;
  dockerUrl: string;
  tenantImage: string;
  tenantNetwork: string;
  tenantMemoryMb: number;
  tenantCpus: number;
  /** Extra env passed to every tenant, from CP_TENANT_ENV_* (prefix stripped). */
  tenantEnv: Record<string, string>;
  smsMode: SmsMode;
  sms: {
    accessKeyId: string | null;
    accessKeySecret: string | null;
    signName: string | null;
    templateLogin: string | null;
    templateReverify: string | null;
  };
  fakeSmsNumbers: string[];
  alertWebhook: string | null;
  /**
   * Directory with the mobile login bundle (index.html + assets) served at
   * / and /login (REQ-B-19). Defaults to the WS-E build output
   * (`dist-mobile-login/` at the repo root) when present, else the
   * built-in placeholder under `static-login/`.
   */
  loginBundleDir: string;
  /**
   * Directory with static legal HTML documents (`terms.html`, `privacy.html`,
   * `custody.html`, `support.html`) served at `/terms`, `/privacy`, `/custody`,
   * `/support`, and `/disclosure` when reached directly at the control plane.
   */
  legalDir: string;
  /**
   * Optional upstream ABS invite service configuration (`CP_INVITE_SERVICE_URL`
   * + `CP_INVITE_API_TOKEN`). When `baseUrl` is unset, sign-up falls back to
   * the local SQLite `invites` table so existing standalone tests stay intact.
   */
  inviteService: {
    baseUrl: string | null;
    token: string | null;
    hibernateAfterMs: number;
    wakeGraceMs: number;
  };
  /** ASR voice gateway (new capability; see docs/cloud-mobile/voice/asr-channel.md). */
  asr: AsrConfig;
  /**
   * Bearer token for the admin credit surface (CP_ADMIN_API_TOKEN, new
   * capability; no C2/C3 contract change). When unset/empty the
   * `/api/v1/admin/credit*` routes answer 404 — the surface is disabled and
   * the credit CLI (`credit grant`) remains the operator path. Mirror of the
   * tenant image's admin-console gate (admin.enabled/token): a configured
   * token is required, missing/wrong tokens get 401, and no user session can
   * reach the route.
   */
  adminApiToken: string | null;
  push: {
    provider: 'disabled' | 'fake' | 'fcm';
    fcm: { projectId: string; clientEmail: string; privateKey: string } | null;
  };
}

export function parsePushConfig(env: NodeJS.ProcessEnv): ControlPlaneConfig['push'] {
  const provider = env.CP_PUSH_PROVIDER ?? 'disabled';
  if (provider !== 'disabled' && provider !== 'fake' && provider !== 'fcm') {
    throw new ConfigError('CP_PUSH_PROVIDER must be "disabled", "fake", or "fcm"');
  }
  if (provider === 'fake') {
    const hostname = new URL(env.CP_PUBLIC_ORIGIN!).hostname;
    if (!FAKE_SMS_ALLOWED_HOSTNAMES.has(hostname) && hostname.split('.')[0] !== 'staging') {
      throw new ConfigError('CP_PUSH_PROVIDER=fake is only allowed on localhost or staging origins');
    }
  }
  if (provider !== 'fcm') return { provider, fcm: null };
  const raw = env.CP_FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new ConfigError('CP_FCM_SERVICE_ACCOUNT_JSON is required when CP_PUSH_PROVIDER=fcm');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ConfigError('CP_FCM_SERVICE_ACCOUNT_JSON must contain a valid service account');
  }
  if (typeof value.project_id !== 'string' || typeof value.client_email !== 'string' || typeof value.private_key !== 'string') {
    throw new ConfigError('CP_FCM_SERVICE_ACCOUNT_JSON must contain project_id, client_email, and private_key');
  }
  return { provider, fcm: { projectId: value.project_id, clientEmail: value.client_email, privateKey: value.private_key } };
}

const FAKE_SMS_ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function defaultLoginBundleDir(): string {
  const repoRootBundle = path.resolve(PACKAGE_ROOT, '..', '..', 'dist-mobile-login');
  if (fs.existsSync(repoRootBundle)) {
    return repoRootBundle;
  }
  return path.join(PACKAGE_ROOT, 'static-login');
}

function defaultLegalDir(): string {
  return path.resolve(PACKAGE_ROOT, '..', '..', 'deploy', 'legal');
}

function parseInviteServiceConfig(env: NodeJS.ProcessEnv): ControlPlaneConfig['inviteService'] {
  const rawBase = env.CP_INVITE_SERVICE_URL?.trim() ?? '';
  const rawToken = env.CP_INVITE_API_TOKEN?.trim() ?? '';
  const hibernateDays = parsePositiveInt(env, 'CP_INVITE_HIBERNATE_AFTER_DAYS', 7);
  const hibernateAfterMs = parsePositiveInt(
    env,
    'CP_INVITE_HIBERNATE_AFTER_MS',
    hibernateDays * 24 * 60 * 60 * 1000,
  );
  const wakeGraceMs = parsePositiveInt(
    env,
    'CP_INVITE_WAKE_GRACE_MS',
    24 * 60 * 60 * 1000,
  );
  if (!rawBase) {
    return { baseUrl: null, token: null, hibernateAfterMs, wakeGraceMs };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new ConfigError(`CP_INVITE_SERVICE_URL must be a valid URL, got "${rawBase}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`CP_INVITE_SERVICE_URL must use http or https, got "${rawBase}"`);
  }
  if (!rawToken) {
    throw new ConfigError('CP_INVITE_API_TOKEN is required when CP_INVITE_SERVICE_URL is set');
  }
  return {
    baseUrl: rawBase.replace(/\/+$/, ''),
    token: rawToken,
    hibernateAfterMs,
    wakeGraceMs,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function parseListen(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const raw = env[name] ?? defaultValue;
  const match = /^([^:]+):(\d+)$/.exec(raw);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new ConfigError(`${name} must look like "host:port", got "${raw}"`);
  }
  return raw;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function parseMasterKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = required(env, 'CP_MASTER_KEY');
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new ConfigError('CP_MASTER_KEY must be base64-encoded 32 bytes');
  }
  if (key.length !== 32) {
    throw new ConfigError(`CP_MASTER_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

function parseSmsMode(env: NodeJS.ProcessEnv): SmsMode {
  const raw = env.CP_SMS_MODE ?? 'aliyun';
  if (raw !== 'aliyun' && raw !== 'fake') {
    throw new ConfigError(`CP_SMS_MODE must be "aliyun" or "fake", got "${raw}"`);
  }
  return raw;
}

/**
 * CP_SMS_MODE=fake is a staging-only escape hatch: refuse to start when the
 * public origin is not clearly non-production (localhost, 127.0.0.1, [::1],
 * or a hostname whose first DNS label is "staging").
 *
 * The one exception is CP_SMS_FAKE_ORIGIN_EXPLICIT=true: the deployer states
 * they knowingly run fake SMS (fixed code for whitelisted numbers) on this
 * origin — a time-boxed invite-test window until AliyunSmsProvider ships
 * (see docs/cloud-mobile/change-requests/). The origin itself is never
 * spoofed or rewritten; without the flag the guard behaves exactly as before.
 */
export function assertFakeSmsOriginAllowed(
  publicOriginUrl: URL,
  smsMode: SmsMode,
  fakeOriginExplicit = false,
): void {
  if (smsMode !== 'fake') {
    return;
  }
  if (fakeOriginExplicit) {
    return;
  }
  const hostname = publicOriginUrl.hostname;
  const firstLabel = hostname.split('.')[0];
  if (FAKE_SMS_ALLOWED_HOSTNAMES.has(hostname) || firstLabel === 'staging') {
    return;
  }
  throw new ConfigError(
    `CP_SMS_MODE=fake is only allowed on localhost/127.0.0.1/[::1] or *.staging origins ` +
      `(or anywhere with CP_SMS_FAKE_ORIGIN_EXPLICIT=true); ` +
      `got CP_PUBLIC_ORIGIN=${publicOriginUrl.toString()}`,
  );
}

function parseFakeSmsOriginExplicit(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CP_SMS_FAKE_ORIGIN_EXPLICIT;
  if (raw === undefined || raw === '') {
    return false;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  throw new ConfigError(`CP_SMS_FAKE_ORIGIN_EXPLICIT must be "true" or unset, got "${raw}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv): ControlPlaneConfig {
  const publicOrigin = required(env, 'CP_PUBLIC_ORIGIN');
  let publicOriginUrl: URL;
  try {
    publicOriginUrl = new URL(publicOrigin);
  } catch {
    throw new ConfigError(`CP_PUBLIC_ORIGIN must be a valid URL, got "${publicOrigin}"`);
  }

  const smsMode = parseSmsMode(env);
  assertFakeSmsOriginAllowed(publicOriginUrl, smsMode, parseFakeSmsOriginExplicit(env));

  const tenantEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('CP_TENANT_ENV_') && value !== undefined) {
      tenantEnv[name.slice('CP_TENANT_ENV_'.length)] = value;
    }
  }

  const fakeSmsNumbers = (env.CP_FAKE_SMS_NUMBERS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (smsMode === 'fake' && fakeSmsNumbers.length === 0) {
    throw new ConfigError('CP_SMS_MODE=fake but CP_FAKE_SMS_NUMBERS is empty');
  }

  const sms = {
    accessKeyId: env.CP_SMS_ACCESS_KEY_ID?.trim() || null,
    accessKeySecret: env.CP_SMS_ACCESS_KEY_SECRET?.trim() || null,
    signName: env.CP_SMS_SIGN_NAME?.trim() || null,
    templateLogin: env.CP_SMS_TEMPLATE_LOGIN?.trim() || null,
    templateReverify: env.CP_SMS_TEMPLATE_REVERIFY?.trim() || null,
  };
  if (smsMode === 'aliyun') {
    if (!sms.accessKeyId || !sms.accessKeySecret || !sms.signName || !sms.templateLogin) {
      throw new ConfigError(
        'CP_SMS_MODE=aliyun requires CP_SMS_ACCESS_KEY_ID, CP_SMS_ACCESS_KEY_SECRET, ' +
          'CP_SMS_SIGN_NAME, and CP_SMS_TEMPLATE_LOGIN',
      );
    }
  }

  const inviteService = parseInviteServiceConfig(env);
  const asr = parseAsrConfig(env);

  return {
    publicOrigin,
    publicOriginUrl,
    listen: parseListen(env, 'CP_LISTEN', '0.0.0.0:8080'),
    metricsListen: parseListen(env, 'CP_METRICS_LISTEN', '0.0.0.0:9100'),
    dbPath: required(env, 'CP_DB_PATH'),
    masterKey: parseMasterKey(env),
    dockerUrl: required(env, 'CP_DOCKER_URL'),
    tenantImage: required(env, 'CP_TENANT_IMAGE'),
    tenantNetwork: required(env, 'CP_TENANT_NETWORK'),
    tenantMemoryMb: parsePositiveInt(env, 'CP_TENANT_MEMORY_MB', 2304),
    tenantCpus: parsePositiveInt(env, 'CP_TENANT_CPUS', 2),
    tenantEnv,
    smsMode,
    sms,
    fakeSmsNumbers,
    alertWebhook: env.CP_ALERT_WEBHOOK ?? null,
    loginBundleDir: env.CP_LOGIN_BUNDLE_DIR ?? defaultLoginBundleDir(),
    legalDir: env.CP_LEGAL_DIR ?? defaultLegalDir(),
    inviteService,
    asr,
    adminApiToken: env.CP_ADMIN_API_TOKEN ? env.CP_ADMIN_API_TOKEN : null,
    push: parsePushConfig(env),
  };
}

const DEFAULT_DOUBAO_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const DEFAULT_DOUBAO_RESOURCE_ID = 'volc.seedasr.sauc.duration';

function parseNonNegativeInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/**
 * ASR voice-gateway configuration (voice channel doc). Volcano credentials
 * arrive ONLY through the environment and must never be logged or committed;
 * selecting `doubao` without either credential form is a startup error.
 */
function parseAsrConfig(env: NodeJS.ProcessEnv): AsrConfig {
  const rawUpstream = env.CP_ASR_UPSTREAM ?? 'stub';
  if (rawUpstream !== 'stub' && rawUpstream !== 'doubao' && rawUpstream !== 'funasr') {
    throw new ConfigError(`CP_ASR_UPSTREAM must be "stub", "doubao", or "funasr", got "${rawUpstream}"`);
  }
  const upstream = rawUpstream as AsrUpstreamKind;

  const doubao = {
    endpoint: env.CP_ASR_DOUBAO_ENDPOINT ?? DEFAULT_DOUBAO_ENDPOINT,
    resourceId: env.CP_ASR_DOUBAO_RESOURCE_ID ?? DEFAULT_DOUBAO_RESOURCE_ID,
    apiKey: env.CP_ASR_DOUBAO_API_KEY ?? null,
    appId: env.CP_ASR_DOUBAO_APP_ID ?? null,
    accessToken: env.CP_ASR_DOUBAO_ACCESS_TOKEN ?? null,
  };
  const funasrEndpoint = env.CP_ASR_FUNASR_ENDPOINT ?? null;

  if (upstream === 'doubao') {
    const hasApiKey = doubao.apiKey !== null && doubao.apiKey !== '';
    const hasLegacyPair =
      (doubao.appId !== null && doubao.appId !== '') &&
      (doubao.accessToken !== null && doubao.accessToken !== '');
    if (!hasApiKey && !hasLegacyPair) {
      throw new ConfigError(
        'CP_ASR_UPSTREAM=doubao requires CP_ASR_DOUBAO_API_KEY (or the legacy ' +
          'CP_ASR_DOUBAO_APP_ID + CP_ASR_DOUBAO_ACCESS_TOKEN pair); credentials are env-only',
      );
    }
  }
  if (upstream === 'funasr' && (funasrEndpoint === null || funasrEndpoint === '')) {
    throw new ConfigError('CP_ASR_UPSTREAM=funasr requires CP_ASR_FUNASR_ENDPOINT (reserved, not yet implemented)');
  }

  return {
    upstream,
    dailyLimitMinutes: parsePositiveInt(env, 'CP_ASR_DAILY_LIMIT_MINUTES', 60),
    maxSessionSeconds: parsePositiveInt(env, 'CP_ASR_MAX_SESSION_SECONDS', 600),
    doubao,
    funasrEndpoint,
    stub: {
      delayMs: parseNonNegativeInt(env, 'CP_ASR_STUB_DELAY_MS', 0),
      disconnectAfterMs: parseNonNegativeInt(env, 'CP_ASR_STUB_DISCONNECT_AFTER_MS', 0),
      slowFinalMs: parseNonNegativeInt(env, 'CP_ASR_STUB_SLOW_FINAL_MS', 0),
    },
  };
}
