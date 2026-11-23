import type Database from 'better-sqlite3';
import { newTenantId, newUserId, newGatewaySecret } from '../ids.js';
import { encryptSecret } from '../crypto.js';

/**
 * DB-level sign-up core (REQ-B-7 / REQ-B-9 bookkeeping). One better-sqlite3
 * transaction per call: existing users return without touching invites or
 * redeem codes; new users must present a valid invite, consume exactly one
 * invite use, and get a `provisioning` tenant row; `with_redeem` invites
 * additionally claim the oldest unassigned redeem code atomically (an empty
 * pool proceeds without a code and flags it for the caller to warn/alert).
 *
 * When `externalInviteGrant` is supplied (ABS partner invite mode), the
 * upstream service has already validated and reserved the invite seat, so
 * sign-up persists the `users`, `tenants`, and `invite_grants` rows in one
 * local transaction without touching the legacy local `invites` table.
 */

export type SignupErrorCode =
  | 'INVITE_REQUIRED'
  | 'INVITE_INVALID'
  | 'INVITE_EXHAUSTED'
  | 'USER_DISABLED';

export interface UserRow {
  id: string;
  phone_e164: string;
  display_name: string;
  locale: string;
  status: 'active' | 'disabled';
  invite_code: string | null;
  created_at: number;
  last_login_at: number | null;
}

export interface TenantRow {
  id: string;
  user_id: string;
  host_id: string;
  container_name: string;
  volume_name: string;
  image: string;
  previous_image: string | null;
  gateway_secret_enc: string;
  status: string;
  phase: string | null;
  app_version: string | null;
  contract_version: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface SignupOk {
  ok: true;
  user: UserRow;
  tenant: TenantRow | null;
  isNewUser: boolean;
  /** Whether an invite use was consumed by this call. */
  inviteConsumed: boolean;
  /** Whether a redeem code was assigned (false = empty pool, caller warns/alerts). */
  redeemCodeClaimed: boolean;
}

export interface SignupErr {
  ok: false;
  code: SignupErrorCode;
  message: string;
}

export type SignupResult = SignupOk | SignupErr;

export interface ExternalInviteGrantInput {
  userId: string;
  tenantId: string;
  code: string;
  redemptionId?: string | null;
  grantTicket?: string | null;
  planId: string;
  planName?: string | null;
  planNameEn?: string | null;
  periodDays: number;
}

export interface SignupInput {
  phone: string;
  displayName?: string | null;
  locale?: string | null;
  inviteCode?: string | null;
  now?: number;
  tenantDefaults: {
    hostId: string;
    tenantImage: string;
  };
  masterKey: Buffer;
  externalInviteGrant?: ExternalInviteGrantInput;
}

const DEFAULT_DISPLAY_NAME = 'IDBots User';
const DEFAULT_LOCALE = 'zh';
const TENANT_STATUS_PROVISIONING = 'provisioning';
const DAY_MS = 24 * 60 * 60 * 1000;

function getUserByPhone(db: Database.Database, phone: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE phone_e164 = ?').get(phone) as
    | UserRow
    | undefined;
}

function getTenantByUserId(db: Database.Database, userId: string): TenantRow | undefined {
  return db.prepare('SELECT * FROM tenants WHERE user_id = ?').get(userId) as
    | TenantRow
    | undefined;
}

interface InviteRow {
  code: string;
  max_uses: number;
  used_count: number;
  with_redeem: number;
  note: string | null;
  expires_at: number | null;
  disabled: number;
  created_at: number;
}

function signupInner(db: Database.Database, input: SignupInput): SignupResult {
  const now = input.now ?? Date.now();

  const existing = getUserByPhone(db, input.phone);
  if (existing) {
    if (existing.status === 'disabled') {
      return { ok: false, code: 'USER_DISABLED', message: 'this account is disabled' };
    }
    return {
      ok: true,
      user: existing,
      tenant: getTenantByUserId(db, existing.id) ?? null,
      isNewUser: false,
      inviteConsumed: false,
      redeemCodeClaimed: false,
    };
  }

  const displayName = input.displayName?.trim() ? input.displayName.trim() : DEFAULT_DISPLAY_NAME;
  const locale = input.locale?.trim() ? input.locale.trim() : DEFAULT_LOCALE;

  if (input.externalInviteGrant) {
    const ext = input.externalInviteGrant;
    const userId = ext.userId;
    const tenantId = ext.tenantId;
    const secret = newGatewaySecret();

    db.prepare(
      `INSERT INTO users (id, phone_e164, display_name, locale, status, invite_code, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(userId, input.phone, displayName, locale, ext.code, now);

    db.prepare(
      `INSERT INTO tenants (
         id, user_id, host_id, container_name, volume_name, image,
         gateway_secret_enc, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tenantId,
      userId,
      input.tenantDefaults.hostId,
      `idb-${tenantId}`,
      `idb-${tenantId}-data`,
      input.tenantDefaults.tenantImage,
      encryptSecret(input.masterKey, secret),
      TENANT_STATUS_PROVISIONING,
      now,
      now,
    );

    const periodDays = Math.max(1, Math.trunc(ext.periodDays || 14));
    const trialEndsAt = now + periodDays * DAY_MS;
    const ticketEnc = ext.grantTicket
      ? encryptSecret(input.masterKey, ext.grantTicket)
      : null;

    db.prepare(
      `INSERT INTO invite_grants (
         user_id, tenant_id, code, redemption_id, grant_ticket_enc,
         plan_id, plan_name, plan_name_en, period_days, trial_ends_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      tenantId,
      ext.code,
      ext.redemptionId ?? null,
      ticketEnc,
      ext.planId || 'me_pro',
      ext.planName ?? null,
      ext.planNameEn ?? null,
      periodDays,
      trialEndsAt,
      now,
      now,
    );

    const user = getUserByPhone(db, input.phone) as UserRow;
    const tenant = getTenantByUserId(db, userId) as TenantRow;
    return {
      ok: true,
      user,
      tenant,
      isNewUser: true,
      inviteConsumed: true,
      redeemCodeClaimed: false,
    };
  }

  if (!input.inviteCode) {
    return { ok: false, code: 'INVITE_REQUIRED', message: 'an invite code is required to sign up' };
  }
  const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(input.inviteCode) as
    | InviteRow
    | undefined;
  if (!invite || invite.disabled === 1) {
    return { ok: false, code: 'INVITE_INVALID', message: 'invite code is not valid' };
  }
  if (invite.expires_at !== null && invite.expires_at <= now) {
    return { ok: false, code: 'INVITE_INVALID', message: 'invite code has expired' };
  }
  if (invite.used_count >= invite.max_uses) {
    return { ok: false, code: 'INVITE_EXHAUSTED', message: 'invite code has no uses left' };
  }

  const userId = newUserId();
  const tenantId = newTenantId();

  // Spend the invite use before writing anything else; a guarded failure here
  // leaves the database untouched.
  const spent = db
    .prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses')
    .run(invite.code);
  if (spent.changes === 0) {
    // Unreachable inside this synchronous transaction, but fail closed.
    return { ok: false, code: 'INVITE_EXHAUSTED', message: 'invite code has no uses left' };
  }

  db.prepare(
    `INSERT INTO users (id, phone_e164, display_name, locale, status, invite_code, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(userId, input.phone, displayName, locale, invite.code, now);

  let redeemCodeClaimed = false;
  if (invite.with_redeem === 1) {
    // Atomically claim the oldest unassigned code. The outer guard re-checks
    // assigned_user_id IS NULL so concurrent sign-ups can never split a code.
    db.prepare(
      `UPDATE redeem_codes
       SET assigned_user_id = ?, assigned_at = ?
       WHERE assigned_user_id IS NULL
         AND code_hash = (
           SELECT code_hash FROM redeem_codes
           WHERE assigned_user_id IS NULL
           ORDER BY imported_at LIMIT 1
         )`,
    ).run(userId, now);
    const claim = db
      .prepare('SELECT code_hash FROM redeem_codes WHERE assigned_user_id = ?')
      .get(userId) as { code_hash: string } | undefined;
    redeemCodeClaimed = claim !== undefined;
  }

  const secret = newGatewaySecret();
  db.prepare(
    `INSERT INTO tenants (
       id, user_id, host_id, container_name, volume_name, image,
       gateway_secret_enc, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tenantId,
    userId,
    input.tenantDefaults.hostId,
    `idb-${tenantId}`,
    `idb-${tenantId}-data`,
    input.tenantDefaults.tenantImage,
    encryptSecret(input.masterKey, secret),
    TENANT_STATUS_PROVISIONING,
    now,
    now,
  );

  const user = getUserByPhone(db, input.phone) as UserRow;
  const tenant = getTenantByUserId(db, userId) as TenantRow;
  return { ok: true, user, tenant, isNewUser: true, inviteConsumed: true, redeemCodeClaimed };
}

/** Run the whole sign-up decision in a single transaction. */
export function signup(db: Database.Database, input: SignupInput): SignupResult {
  return db.transaction(() => signupInner(db, input))();
}
