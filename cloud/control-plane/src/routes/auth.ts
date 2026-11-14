import type { AppContext } from '../context.js';
import {
  HttpError,
  optionalStringField,
  requireStringField,
  writeJson,
  type RequestCtx,
  type Route,
  type SessionUser,
} from '../http.js';
import { maskPhone, sha256Hex } from '../crypto.js';
import { checkPhoneLock, checkSmsSend, incrementCodeAttempts } from '../rateLimit.js';
import { generateSmsCode, hashSmsCode } from '../sms.js';
import { signup } from '../services/signup.js';
import { markFailed, provisionTenant } from '../services/provisioning.js';
import { sendAlert } from '../alerts.js';
import { newSessionToken } from '../ids.js';
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  serializeSessionCookie,
  sessionTokenFromCookieHeader,
} from '../cookies.js';

/**
 * C3 auth endpoints (REQ-B-6, REQ-B-7): sms/send, sms/verify, me, logout.
 * Error codes and shapes follow contract C3 exactly; the session cookie is
 * the C3 idb_session (30-day sliding expiry, sha256 in the database).
 *
 * Decisions flagged in the delivery note:
 * - locale: C3's verify body has no locale field, so sign-up defaults to zh.
 * - fake SMS mode: listed CP_FAKE_SMS_NUMBERS receive the fixed code 246810;
 *   unlisted numbers get a random code whose (failed) delivery is only
 *   logged — verification of those numbers is impossible by design.
 */

const PHONE_RE = /^\+861\d{10}$/;
const MAX_DISPLAY_NAME = 24;
const SMS_CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_PURPOSE = 'login';

interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
}

interface UserRow {
  id: string;
  phone_e164: string;
  display_name: string;
  locale: string;
  status: string;
  created_at: number;
}

interface TenantRow {
  id: string;
  status: string;
  phase: string | null;
  app_version: string | null;
  contract_version: string | null;
  last_error: string | null;
}

/**
 * Resolves the idb_session cookie to the session user (sliding the expiry),
 * returning the raw session token too — the WS proxy derives the stable
 * C2 client id from it. Null when absent/expired/invalid.
 */
export function resolveSession(
  app: AppContext,
  cookieHeader: string | undefined,
): { user: SessionUser; token: string } | null {
  const token = sessionTokenFromCookieHeader(cookieHeader);
  if (!token) {
    return null;
  }
  const tokenHash = sha256Hex(token);
  const now = Date.now();
  const session = app.db
    .prepare('SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as SessionRow | undefined;
  if (!session || session.expires_at <= now) {
    if (session) {
      app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    }
    return null;
  }
  const user = app.db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as
    | SessionUser
    | undefined;
  if (!user || user.status !== 'active') {
    return null;
  }
  app.db
    .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
    .run(now, now + SESSION_TTL_MS, tokenHash);
  return { user, token };
}

/** Loads the session user from the idb_session cookie; slides the expiry. */
export function requireUser(app: AppContext, reqCtx: RequestCtx): void {
  const resolved = resolveSession(app, reqCtx.cookieHeader);
  if (!resolved) {
    throw new HttpError(401, 'UNAUTHORIZED', 'no session cookie');
  }
  reqCtx.user = resolved.user;
  reqCtx.tokenHash = sha256Hex(resolved.token);
}

export function publicUser(user: Pick<UserRow, 'id' | 'phone_e164' | 'created_at' | 'locale'>): {
  id: string;
  phoneMasked: string;
  createdAt: number;
  locale: string;
} {
  return {
    id: user.id,
    phoneMasked: maskPhone(user.phone_e164),
    createdAt: user.created_at,
    locale: user.locale,
  };
}

export function tenantShape(tenant: TenantRow | null | undefined): {
  status: string;
  phase: string | null;
  appVersion: string | null;
  contractVersion: string | null;
  error: string | null;
} {
  if (!tenant) {
    return { status: 'provisioning', phase: null, appVersion: null, contractVersion: null, error: null };
  }
  const booting = tenant.status === 'booting' || tenant.status === 'onboarding';
  return {
    status: tenant.status,
    phase: booting ? tenant.phase : null,
    appVersion: tenant.app_version,
    contractVersion: tenant.contract_version,
    error: tenant.status === 'failed' ? tenant.last_error : null,
  };
}

function getTenantByUserId(app: AppContext, userId: string): TenantRow | undefined {
  return app.db.prepare('SELECT * FROM tenants WHERE user_id = ?').get(userId) as TenantRow | undefined;
}

/**
 * Shared SMS-code issuance (REQ-B-6/B-16): rate-limit gate, 6-digit code
 * (fixed 246810 for fake-listed numbers), hashed row with a 5-minute TTL.
 * Returns whether delivery succeeded (undeliverable is only logged).
 */
export async function issueSmsCode(
  app: AppContext,
  reqCtx: RequestCtx,
  phone: string,
  purpose: 'login' | 'reverify',
): Promise<boolean> {
  const now = Date.now();
  const check = checkSmsSend(app.db, { phone, ip: reqCtx.ip, now });
  if (!check.allowed) {
    reqCtx.log('info', 'sms send refused by rate limit', {
      phone: maskPhone(phone),
      reason: check.reason ?? undefined,
    });
    throw new HttpError(429, 'RATE_LIMITED', `sms send refused: ${check.reason ?? 'rate limited'}`);
  }
  const fakeListed = app.config.smsMode === 'fake' && app.config.fakeSmsNumbers.includes(phone);
  const code = fakeListed ? '246810' : generateSmsCode();
  app.db
    .prepare(
      `INSERT INTO sms_codes (phone_e164, purpose, code_hash, attempts, expires_at, consumed_at, ip, created_at)
       VALUES (?, ?, ?, 0, ?, NULL, ?, ?)`,
    )
    .run(phone, purpose, hashSmsCode(phone, purpose, code), now + SMS_CODE_TTL_MS, reqCtx.ip, now);
  let delivered = true;
  try {
    await app.sms.send(phone, purpose, code);
  } catch (err) {
    delivered = false;
    // Undeliverable (fake mode with an unlisted number, provider outage):
    // the code row exists but no SMS arrives, exactly like production.
    reqCtx.log('warn', 'sms delivery failed', {
      phone: maskPhone(phone),
      error: err instanceof Error ? err.message : String(err),
    });
  }
  app.metrics.smsSend(purpose, delivered);
  return delivered;
}

/** Validates a submitted SMS code (REQ-B-6/B-16 shared rules). */
function verifySmsCode(
  app: AppContext,
  phone: string,
  purpose: 'login' | 'reverify',
  code: string,
  consume: boolean,
): void {
  const now = Date.now();
  const lock = checkPhoneLock(app.db, phone, now);
  if (lock.locked) {
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'too many failed verification attempts for this phone');
  }
  const codeRow = app.db
    .prepare(
      `SELECT * FROM sms_codes
       WHERE phone_e164 = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(phone, purpose) as { id: number; code_hash: string; attempts: number; expires_at: number } | undefined;
  if (!codeRow) {
    throw new HttpError(400, 'CODE_INVALID', 'no active code for this phone');
  }
  if (codeRow.attempts >= 5) {
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'this code has no attempts left');
  }
  if (codeRow.expires_at <= now) {
    throw new HttpError(400, 'CODE_EXPIRED', 'the code has expired');
  }
  if (hashSmsCode(phone, purpose, code) !== codeRow.code_hash) {
    incrementCodeAttempts(app.db, codeRow.id);
    throw new HttpError(400, 'CODE_INVALID', 'wrong code');
  }
  if (consume) app.db.prepare('UPDATE sms_codes SET consumed_at = ? WHERE id = ?').run(now, codeRow.id);
}

export function validateSmsCode(
  app: AppContext,
  phone: string,
  purpose: 'login' | 'reverify',
  code: string,
): void {
  verifySmsCode(app, phone, purpose, code, false);
}

export function consumeSmsCode(
  app: AppContext,
  phone: string,
  purpose: 'login' | 'reverify',
  code: string,
): void {
  verifySmsCode(app, phone, purpose, code, true);
}

async function smsSend(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const phone = requireStringField(body, 'phone');
  const purpose = requireStringField(body, 'purpose');
  if (purpose !== LOGIN_PURPOSE) {
    throw new HttpError(400, 'INVALID_PURPOSE', `purpose must be "${LOGIN_PURPOSE}"`);
  }
  if (!PHONE_RE.test(phone)) {
    throw new HttpError(400, 'INVALID_PHONE', `expected a mainland China number like +861xxxxxxxxxx`);
  }
  await issueSmsCode(app, reqCtx, phone, LOGIN_PURPOSE);
  writeJson(reqCtx.res, 200, { resendAfterSec: 60 });
}

async function smsVerify(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const phone = requireStringField(body, 'phone');
  const code = requireStringField(body, 'code');
  const inviteCode = optionalStringField(body, 'inviteCode');
  const displayName = optionalStringField(body, 'displayName');
  if (!PHONE_RE.test(phone)) {
    throw new HttpError(400, 'INVALID_PHONE', `expected a mainland China number like +861xxxxxxxxxx`);
  }
  if (displayName !== null) {
    const trimmed = displayName.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME) {
      throw new HttpError(
        400,
        'INVALID_DISPLAY_NAME',
        `displayName must be 1-${MAX_DISPLAY_NAME} characters`,
      );
    }
  }
  const now = Date.now();

  validateSmsCode(app, phone, LOGIN_PURPOSE, code);

  const existing = app.db.prepare('SELECT * FROM users WHERE phone_e164 = ?').get(phone) as
    | UserRow
    | undefined;
  let user: UserRow;
  let tenant: TenantRow | null | undefined;
  let isNewUser = false;
  if (existing) {
    if (existing.status !== 'active') {
      throw new HttpError(403, 'USER_DISABLED', 'this account is disabled');
    }
    user = existing;
    tenant = getTenantByUserId(app, existing.id);
  } else {
    const host = app.db.prepare('SELECT id FROM hosts ORDER BY rowid LIMIT 1').get() as
      | { id: string }
      | undefined;
    const result = signup(app.db, {
      phone,
      displayName,
      locale: 'zh',
      inviteCode,
      now,
      tenantDefaults: {
        hostId: host?.id ?? 'host-unknown',
        tenantImage: app.config.tenantImage,
      },
      masterKey: app.config.masterKey,
    });
    if (!result.ok) {
      throw new HttpError(403, result.code, result.message);
    }
    user = result.user;
    tenant = result.tenant;
    isNewUser = result.isNewUser;
    if (isNewUser && tenant) {
      // Provisioning is asynchronous: the client polls GET /api/v1/me.
      // provisionTenant marks failures itself; the .catch is the last line
      // of defense so an unexpected throw can never become an unhandled
      // rejection (Node 24 would crash the process).
      const newTenantId = tenant.id;
      void provisionTenant(app, newTenantId).catch((err: unknown) => {
        const message = `provisioning failed: ${err instanceof Error ? err.message : String(err)}`;
        reqCtx.log('error', 'provisioning failed unexpectedly', { tenantId: newTenantId, error: message });
        markFailed(app, newTenantId, message);
        void sendAlert(app.config, `tenant ${newTenantId}: ${message}`);
      });
    }
  }

  consumeSmsCode(app, phone, LOGIN_PURPOSE, code);

  const token = newSessionToken();
  app.db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sha256Hex(token),
      user.id,
      now,
      now,
      now + SESSION_TTL_MS,
      reqCtx.userAgent.slice(0, 256),
      reqCtx.ip,
    );
  reqCtx.res.setHeader('Set-Cookie', serializeSessionCookie(token, now));
  reqCtx.log('info', 'login', { userId: user.id, phone: maskPhone(phone), isNewUser });
  writeJson(reqCtx.res, 200, { user: publicUser(user), tenant: tenantShape(tenant) });
}

async function me(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  const tenant = getTenantByUserId(app, reqCtx.user!.id);
  writeJson(reqCtx.res, 200, { user: publicUser(reqCtx.user!), tenant: tenantShape(tenant) });
}

async function logout(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  if (reqCtx.tokenHash) {
    app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(reqCtx.tokenHash);
  }
  reqCtx.res.setHeader('Set-Cookie', clearSessionCookie(Date.now()));
  reqCtx.res.writeHead(204);
  reqCtx.res.end();
}

export const authRoutes: Route[] = [
  { method: 'POST', path: '/api/v1/auth/sms/send', handler: smsSend },
  { method: 'POST', path: '/api/v1/auth/sms/verify', handler: smsVerify },
  { method: 'GET', path: '/api/v1/me', auth: true, handler: me },
  { method: 'POST', path: '/api/v1/auth/logout', auth: true, handler: logout },
];
