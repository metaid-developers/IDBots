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
import {
  consumePartnerInvite,
  fetchInvitePublicPreview,
  mapInviteReasonToHttpError,
  normalizeInviteCodeInput,
  precheckPartnerInvite,
} from '../services/invitePartnerClient.js';
import {
  isHibernatedTrialTenant,
  triggerWakeHibernatedTenant,
} from '../services/hibernation.js';
import { markFailed, provisionTenant } from '../services/provisioning.js';
import { sendAlert } from '../alerts.js';
import { newSessionToken, newTenantId, newUserId } from '../ids.js';
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  serializeSessionCookie,
  sessionTokenFromCookieHeader,
} from '../cookies.js';

/**
 * C3 auth endpoints (REQ-B-6, REQ-B-7): sms/send, sms/verify, me, logout, plus
 * additive invite preview (`GET /api/v1/auth/invite/preview`).
 * Error codes and shapes follow contract C3; the session cookie is the C3
 * idb_session (30-day sliding expiry, sha256 in the database).
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

interface LocalInvitePreviewRow {
  code: string;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  disabled: number;
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
 * In `fake` mode, unlisted numbers only log a warning (anti-enumeration /
 * test fixture design). In real provider modes (`aliyun`), delivery failures
 * roll back the unverified SMS row so the 60 s cooldown does not trap the user
 * and surface `502 SMS_SEND_FAILED`.
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
  const inserted = app.db
    .prepare(
      `INSERT INTO sms_codes (phone_e164, purpose, code_hash, attempts, expires_at, consumed_at, ip, created_at)
       VALUES (?, ?, ?, 0, ?, NULL, ?, ?)`,
    )
    .run(phone, purpose, hashSmsCode(phone, purpose, code), now + SMS_CODE_TTL_MS, reqCtx.ip, now);
  const smsRowId = Number(inserted.lastInsertRowid);
  let delivered = true;
  try {
    await app.sms.send(phone, purpose, code);
  } catch (err) {
    delivered = false;
    reqCtx.log('warn', 'sms delivery failed', {
      phone: maskPhone(phone),
      error: err instanceof Error ? err.message : String(err),
    });
    if (app.sms.mode !== 'fake') {
      app.db.prepare('DELETE FROM sms_codes WHERE id = ?').run(smsRowId);
      app.metrics.smsSend(purpose, false);
      throw new HttpError(
        502,
        'SMS_SEND_FAILED',
        'failed to send SMS verification code; please retry shortly',
      );
    }
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

function previewLocalInvite(app: AppContext, rawCode: string) {
  const normalized = normalizeInviteCodeInput(rawCode);
  const now = Date.now();
  const row = (app.db.prepare('SELECT * FROM invites WHERE code = ?').get(normalized) ??
    app.db.prepare('SELECT * FROM invites WHERE code = ?').get(rawCode.trim())) as
    | LocalInvitePreviewRow
    | undefined;
  if (!row || row.disabled === 1) {
    return {
      valid: false,
      reasonCode: 'INVITE_INVALID_CODE',
      code: normalized,
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
      dailyCapFull: false,
    };
  }
  if (row.expires_at !== null && row.expires_at <= now) {
    return {
      valid: false,
      reasonCode: 'INVITE_CODE_EXPIRED',
      code: row.code,
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
      dailyCapFull: false,
    };
  }
  if (row.used_count >= row.max_uses) {
    return {
      valid: false,
      reasonCode: 'INVITE_CODE_EXHAUSTED',
      code: row.code,
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
      dailyCapFull: false,
    };
  }
  return {
    valid: true,
    code: row.code,
    planId: 'me_pro',
    planName: 'ID.Student',
    planNameEn: 'ID.Student',
    periodDays: 14,
    dailyCapFull: false,
  };
}

async function invitePreview(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  const url = new URL(reqCtx.req?.url ?? '/', 'http://localhost');
  const rawCode = (url.searchParams.get('code') ?? '').trim();
  if (!rawCode || rawCode.length > 32) {
    throw new HttpError(400, 'INVALID_INVITE_CODE', 'code query parameter is required');
  }
  if (app.config.inviteService.baseUrl) {
    const preview = await fetchInvitePublicPreview(app.config, rawCode);
    writeJson(reqCtx.res, 200, preview);
    return;
  }
  writeJson(reqCtx.res, 200, previewLocalInvite(app, rawCode));
}

async function smsSend(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  const phone = requireStringField(body, 'phone');
  const purpose = requireStringField(body, 'purpose');
  const inviteCode = optionalStringField(body, 'inviteCode');
  if (purpose !== LOGIN_PURPOSE) {
    throw new HttpError(400, 'INVALID_PURPOSE', `purpose must be "${LOGIN_PURPOSE}"`);
  }
  if (!PHONE_RE.test(phone)) {
    throw new HttpError(400, 'INVALID_PHONE', `expected a mainland China number like +861xxxxxxxxxx`);
  }

  const existing = app.db.prepare('SELECT id, status FROM users WHERE phone_e164 = ?').get(phone) as
    | { id: string; status: string }
    | undefined;
  if (existing?.status === 'disabled') {
    throw new HttpError(403, 'USER_DISABLED', 'this account is disabled');
  }

  // Pre-validate invite + daily cap BEFORE sending SMS for unknown phones when
  // the upstream ABS invite service is enabled (or when the caller explicitly
  // supplied an inviteCode in standalone mode).
  if (!existing) {
    if (app.config.inviteService.baseUrl) {
      if (!inviteCode?.trim()) {
        throw new HttpError(403, 'INVITE_REQUIRED', 'an invite code is required to sign up');
      }
      const precheck = await precheckPartnerInvite(app.config, inviteCode);
      if (!precheck.allowed) {
        throw mapInviteReasonToHttpError(precheck.reasonCode);
      }
    } else if (inviteCode !== null) {
      if (!inviteCode.trim()) {
        throw new HttpError(403, 'INVITE_REQUIRED', 'an invite code is required to sign up');
      }
      const localPreview = previewLocalInvite(app, inviteCode);
      if (!localPreview.valid) {
        throw mapInviteReasonToHttpError(localPreview.reasonCode);
      }
    }
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
    if (isHibernatedTrialTenant(app.db, existing.id, tenant)) {
      triggerWakeHibernatedTenant(app, existing.id, now);
      tenant = getTenantByUserId(app, existing.id);
    }
  } else {
    const host = app.db.prepare('SELECT id FROM hosts ORDER BY rowid LIMIT 1').get() as
      | { id: string }
      | undefined;

    if (app.config.inviteService.baseUrl) {
      if (!inviteCode?.trim()) {
        throw new HttpError(403, 'INVITE_REQUIRED', 'an invite code is required to sign up');
      }
      const preUserId = newUserId();
      const preTenantId = newTenantId();
      const consumed = await consumePartnerInvite(app.config, {
        code: inviteCode,
        cpUserId: preUserId,
        cpTenantId: preTenantId,
        phoneMasked: maskPhone(phone),
      });
      if (!consumed.allowed) {
        throw mapInviteReasonToHttpError(consumed.reasonCode);
      }
      const result = signup(app.db, {
        phone,
        displayName,
        locale: 'zh',
        inviteCode: consumed.code,
        now,
        tenantDefaults: {
          hostId: host?.id ?? 'host-unknown',
          tenantImage: app.config.tenantImage,
        },
        masterKey: app.config.masterKey,
        externalInviteGrant: {
          userId: preUserId,
          tenantId: preTenantId,
          code: consumed.code,
          redemptionId: consumed.redemptionId ?? null,
          grantTicket: consumed.grantTicket ?? null,
          planId: consumed.planId || 'me_pro',
          planName: consumed.planName ?? null,
          planNameEn: consumed.planNameEn ?? null,
          periodDays: consumed.periodDays || 14,
        },
      });
      if (!result.ok) {
        throw new HttpError(403, result.code, result.message);
      }
      user = result.user;
      tenant = result.tenant;
      isNewUser = result.isNewUser;
    } else {
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
    }

    if (isNewUser && tenant) {
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
  let tenant = getTenantByUserId(app, reqCtx.user!.id);
  if (isHibernatedTrialTenant(app.db, reqCtx.user!.id, tenant)) {
    triggerWakeHibernatedTenant(app, reqCtx.user!.id);
    tenant = getTenantByUserId(app, reqCtx.user!.id);
  }
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
  { method: 'GET', path: '/api/v1/auth/invite/preview', handler: invitePreview },
  { method: 'POST', path: '/api/v1/auth/sms/send', handler: smsSend },
  { method: 'POST', path: '/api/v1/auth/sms/verify', handler: smsVerify },
  { method: 'GET', path: '/api/v1/me', auth: true, handler: me },
  { method: 'POST', path: '/api/v1/auth/logout', auth: true, handler: logout },
];
