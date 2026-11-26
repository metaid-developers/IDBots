import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import { encryptSecret, decryptSecret, sha256Hex } from '../crypto.js';
import { HttpError, type RequestCtx } from '../http.js';

export type AdminRole = 'viewer' | 'support' | 'operator' | 'admin';
export type AdminPermission = 'read' | 'audit.read' | 'tenant.write' | 'rollout.write' | 'approvals.write' | 'admins.write';

export interface AdminPrincipal {
  id: string;
  username: string;
  role: AdminRole;
}

const SESSION_TTL_MS = 30 * 60_000;
const MFA_STEP_MS = 30_000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const failedLogins = new Map<string, { count: number; resetAt: number }>();

function base32Encode(value: Buffer): string {
  let bits = '';
  for (const byte of value) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let index = 0; index < bits.length; index += 5) {
    output += BASE32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return output;
}

function base32Decode(value: string): Buffer {
  let bits = '';
  for (const char of value.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / MFA_STEP_MS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

function validMfa(secret: string, supplied: string, now: number): boolean {
  if (!/^\d{6}$/.test(supplied)) return false;
  return [now - MFA_STEP_MS, now, now + MFA_STEP_MS].some((time) => {
    const expected = Buffer.from(totp(secret, time));
    const actual = Buffer.from(supplied);
    return timingSafeEqual(expected, actual);
  });
}

function audit(db: Database.Database, operator: string, action: string, target: string, detail: Record<string, unknown>): void {
  db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), `admin:${operator}`, action, target, JSON.stringify(detail));
}

export function createAdminUser(
  db: Database.Database,
  masterKey: Buffer,
  input: { username: string; role: AdminRole },
  operator: string,
): { id: string; username: string; role: AdminRole; token: string; mfaSecret: string; otpauthUrl: string } {
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(input.username)) throw new Error('username must be 3-64 letters, digits, dot, underscore, or dash');
  if (!['viewer', 'support', 'operator', 'admin'].includes(input.role)) throw new Error('invalid admin role');
  const id = `ad_${randomUUID().replaceAll('-', '')}`;
  const token = `adm_${randomBytes(32).toString('base64url')}`;
  const mfaSecret = base32Encode(randomBytes(20));
  const now = Date.now();
  db.transaction(() => {
    db.prepare(`INSERT INTO admin_users (id, username, role, token_hash, mfa_secret_enc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.username, input.role, sha256Hex(token), encryptSecret(masterKey, mfaSecret), now, now);
    audit(db, operator, 'admin.create', id, { username: input.username, role: input.role });
  })();
  return {
    id,
    username: input.username,
    role: input.role,
    token,
    mfaSecret,
    otpauthUrl: `otpauth://totp/IDBots:${encodeURIComponent(input.username)}?secret=${mfaSecret}&issuer=IDBots&algorithm=SHA1&digits=6&period=30`,
  };
}

export function listAdminUsers(db: Database.Database): Array<Omit<AdminPrincipal, 'id'> & { id: string; status: string; createdAt: number }> {
  return (db.prepare('SELECT id, username, role, status, created_at FROM admin_users ORDER BY username').all() as Array<{
    id: string;
    username: string;
    role: AdminRole;
    status: string;
    created_at: number;
  }>).map((row) => ({ id: row.id, username: row.username, role: row.role, status: row.status, createdAt: row.created_at }));
}

export function disableAdminUser(db: Database.Database, id: string, operator: string): void {
  const result = db.prepare("UPDATE admin_users SET status = 'disabled', updated_at = ? WHERE id = ?").run(Date.now(), id);
  if (result.changes !== 1) throw new Error(`admin ${id} not found`);
  db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
  audit(db, operator, 'admin.disable', id, {});
}

export function loginAdmin(
  app: AppContext,
  input: { username: string; token: string; mfaCode: string; ip: string },
): { token: string; expiresAt: number; principal: AdminPrincipal } {
  const key = `${input.ip}:${input.username}`;
  const now = Date.now();
  const attempts = failedLogins.get(key);
  if (attempts && attempts.resetAt > now && attempts.count >= 5) {
    throw new HttpError(429, 'ADMIN_RATE_LIMITED', 'too many failed administrator login attempts');
  }
  const user = app.db.prepare("SELECT * FROM admin_users WHERE username = ? AND status = 'active'").get(input.username) as {
    id: string;
    username: string;
    role: AdminRole;
    token_hash: string;
    mfa_secret_enc: string;
  } | undefined;
  let secret: string | null = null;
  try {
    secret = user ? decryptSecret(app.config.masterKey, user.mfa_secret_enc) : null;
  } catch {
    secret = null;
  }
  if (!user || !secret || sha256Hex(input.token) !== user.token_hash || !validMfa(secret, input.mfaCode, now)) {
    const current = failedLogins.get(key);
    failedLogins.set(key, {
      count: current && current.resetAt > now ? current.count + 1 : 1,
      resetAt: current && current.resetAt > now ? current.resetAt : now + 5 * 60_000,
    });
    throw new HttpError(401, 'ADMIN_UNAUTHORIZED', 'administrator credentials or MFA code are invalid');
  }
  failedLogins.delete(key);
  const token = `ads_${randomBytes(32).toString('base64url')}`;
  const expiresAt = now + SESSION_TTL_MS;
  app.db.prepare('INSERT INTO admin_sessions (token_hash, user_id, role, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256Hex(token), user.id, user.role, now, now, expiresAt);
  app.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
  return { token, expiresAt, principal: { id: user.id, username: user.username, role: user.role } };
}

function tokenFromRequest(reqCtx: RequestCtx): string {
  const authorization = String(reqCtx.req?.headers.authorization ?? '');
  const bearer = authorization.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  const cookies = (reqCtx.cookieHeader ?? '').split(';').map((entry) => entry.trim());
  const session = cookies.find((entry) => entry.startsWith('idb_admin_session='));
  return session ? decodeURIComponent(session.slice('idb_admin_session='.length)) : '';
}

export function requireAdmin(app: AppContext, reqCtx: RequestCtx, permission: AdminPermission): AdminPrincipal {
  const token = tokenFromRequest(reqCtx);
  if (!token) throw new HttpError(401, 'ADMIN_UNAUTHORIZED', 'administrator session is required');
  const row = app.db.prepare(`SELECT admin_users.id, admin_users.username, admin_sessions.role
    FROM admin_sessions JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ? AND admin_sessions.expires_at > ? AND admin_users.status = 'active'`)
    .get(sha256Hex(token), Date.now()) as { id: string; username: string; role: AdminRole } | undefined;
  if (!row) throw new HttpError(401, 'ADMIN_UNAUTHORIZED', 'administrator session is invalid or expired');
  const allowed: Record<AdminPermission, AdminRole[]> = {
    read: ['viewer', 'support', 'operator', 'admin'],
    'audit.read': ['support', 'operator', 'admin'],
    'tenant.write': ['support', 'operator', 'admin'],
    'rollout.write': ['operator', 'admin'],
    'approvals.write': ['operator', 'admin'],
    'admins.write': ['admin'],
  };
  if (!allowed[permission].includes(row.role)) {
    throw new HttpError(403, 'ADMIN_FORBIDDEN', `role ${row.role} lacks ${permission}`);
  }
  app.db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), sha256Hex(token));
  return row;
}
