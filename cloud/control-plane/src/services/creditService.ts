import { decryptSecret, encryptSecret } from '../crypto.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';

/**
 * Operator credit ledger (payment credit channel, NEW capability — no C2/C3
 * contract change): grants "n bytes of traffic credit to user X" as a
 * verifiable record with the five audit fields — who (actor), when
 * (created_at), whom (user_id), amount (bytes_total, integer bytes), basis
 * (reason). Both operator surfaces share this core:
 *
 * - the admin CLI (`credit grant`, REQ-B-18 discipline: mutating, `--as`
 *   required, audit_log row with actor `admin:<name>`), and
 * - the bearer-token HTTP route (`POST /api/v1/admin/credit`, disabled
 *   entirely when CP_ADMIN_API_TOKEN is unset).
 *
 * Scope boundary: this ledger is the control-plane record of truth. The
 * byte-level application to the user's upstream traffic account is done BY
 * THE TENANT (plan B, owner decision 2026-11-05): the tenant pulls its own
 * pending rows over the tenant-authenticated route and redeems the single-use
 * upstream code attached to each row, signing as the user identity it already
 * owns. The control plane therefore never holds a credential that can mint
 * credit on any account — it stores only the one code a grant is worth
 * (`apply_code_enc`, AES-256-GCM under CP_MASTER_KEY) and the evidence the
 * tenant reports back. Rows whose bytes were already credited upstream
 * (`source = 'bundle-order'`: the payment webhook credits traffic first) are
 * `not-required` and never enter the pending set.
 *
 * Idempotency: `referenceKey` (client-supplied) is UNIQUE. Re-submitting the
 * same key returns the EXISTING grant (`duplicate: true`) instead of writing
 * a second row — an operator retrying after an uncertain timeout can never
 * double-credit. Application idempotency is separate and two-sided: upstream
 * redemption of the same code by the same account is idempotent (the tenant
 * can retry after an uncertain timeout), and `markCreditApplied` flips a row
 * from pending to applied only once (conditional UPDATE).
 */

export type CreditSource = 'manual' | 'bundle-order';

export interface CreditGrantInput {
  userId: string;
  /** Positive integer bytes. Floats are rejected outright. */
  bytes: number;
  /** The "依据": why this credit exists (order id, incident, gesture...). */
  reason: string;
  source: CreditSource;
  /** `admin:<name>` for operator actions; never a user session. */
  actor: string;
  /** Optional idempotency key (e.g. the upstream orderId). */
  referenceKey?: string | null;
  /**
   * Optional single-use upstream redeem code worth exactly `bytes`. When
   * absent the grant is still recorded, but it cannot be applied by the
   * tenant until an operator attaches a code (credit.attach-code).
   */
  applyCode?: string | null;
}

export type CreditApplyState = 'pending' | 'applied' | 'not-required';

export interface CreditGrantResult {
  creditId: number;
  userId: string;
  bytes: number;
  source: CreditSource;
  reason: string;
  actor: string;
  referenceKey: string | null;
  createdAt: number;
  /** true when an existing grant with the same referenceKey was returned. */
  duplicate: boolean;
  applyState: CreditApplyState;
  appliedAt: number | null;
  appliedBytes: number | null;
  applyAttempts: number;
  lastApplyError: string | null;
  /** true when an application code is stored (never the code itself). */
  hasApplyCode: boolean;
}

export interface CreditRow {
  id: number;
  user_id: string;
  bytes_total: number;
  source: string;
  reason: string;
  actor: string;
  reference_key: string | null;
  created_at: number;
  apply_state: CreditApplyState;
  apply_code_enc: string | null;
  applied_at: number | null;
  applied_by: string | null;
  applied_bytes: number | null;
  applied_evidence: string | null;
  apply_attempts: number;
  last_apply_error: string | null;
  last_apply_at: number | null;
}

export function rowToCreditResult(row: CreditRow, duplicate: boolean): CreditGrantResult {
  return {
    creditId: row.id,
    userId: row.user_id,
    bytes: row.bytes_total,
    source: row.source as CreditSource,
    reason: row.reason,
    actor: row.actor,
    referenceKey: row.reference_key,
    createdAt: row.created_at,
    duplicate,
    applyState: row.apply_state,
    appliedAt: row.applied_at,
    appliedBytes: row.applied_bytes,
    applyAttempts: row.apply_attempts,
    lastApplyError: row.last_apply_error,
    hasApplyCode: row.apply_code_enc !== null,
  };
}

/** Normalize an operator-supplied upstream code; never logs its value. */
export function normalizeApplyCode(value: unknown): string {
  const code = String(value ?? '').trim().toUpperCase();
  if (!code) {
    throw new HttpError(400, 'INVALID_APPLY_CODE', 'field "applyCode" must be a non-empty string');
  }
  if (!/^[A-Z0-9][A-Z0-9-]{7,63}$/.test(code)) {
    throw new HttpError(400, 'INVALID_APPLY_CODE', 'field "applyCode" is not a plausible redeem code');
  }
  return code;
}

/**
 * Validate + insert one credit grant inside a transaction, write the paired
 * audit_log row, and return the grant. Throws the HttpError shapes the HTTP
 * route maps 1:1 (the CLI re-labels them as CliError at its boundary).
 */
export function grantCredit(
  app: Pick<AppContext, 'db' | 'config'>,
  input: CreditGrantInput,
): CreditGrantResult {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (!userId) {
    throw new HttpError(400, 'INVALID_BODY', 'field "userId" must be a non-empty string');
  }
  const bytes = input.bytes;
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new HttpError(400, 'INVALID_BYTES', 'field "bytes" must be a positive integer (byte count, no floats)');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) {
    throw new HttpError(400, 'MISSING_REASON', 'field "reason" is required (the audit basis for this credit)');
  }
  const actor = typeof input.actor === 'string' ? input.actor.trim() : '';
  if (!actor || actor.startsWith('user:')) {
    throw new HttpError(403, 'FORBIDDEN_ACTOR', 'credit grants are operator actions only (actor must be admin:<name>)');
  }

  const user = app.db
    .prepare('SELECT id, status FROM users WHERE id = ?')
    .get(userId) as { id: string; status: string } | undefined;
  if (!user) {
    throw new HttpError(404, 'USER_NOT_FOUND', `user ${userId} does not exist`);
  }
  if (user.status !== 'active') {
    throw new HttpError(409, 'USER_DISABLED', `user ${userId} is disabled; enable before crediting`);
  }

  const referenceKey =
    input.referenceKey === undefined || input.referenceKey === null
      ? null
      : String(input.referenceKey).trim() || null;

  // bundle-order rows are already credited upstream by the payment webhook;
  // applying them again would double-credit, so they are born not-required.
  const applyState: CreditApplyState = input.source === 'bundle-order' ? 'not-required' : 'pending';
  if (applyState === 'not-required' && input.applyCode) {
    // The upstream already credited these bytes (payment webhook). A code here
    // could only ever be redeemed twice or never — refuse it outright.
    throw new HttpError(
      400,
      'APPLY_CODE_NOT_APPLICABLE',
      'bundle-order grants are already credited upstream; they take no application code',
    );
  }
  const applyCodeEnc =
    input.applyCode === undefined || input.applyCode === null || input.applyCode === ''
      ? null
      : encryptSecret(app.config.masterKey, normalizeApplyCode(input.applyCode));

  if (referenceKey) {
    const existing = app.db
      .prepare('SELECT * FROM credit_ledger WHERE reference_key = ?')
      .get(referenceKey) as CreditRow | undefined;
    if (existing) {
      return rowToCreditResult(existing, true);
    }
  }

  const now = Date.now();
  const insert = app.db.transaction(() => {
    let info: { changes: number; lastInsertRowid: number | bigint };
    try {
      info = app.db
        .prepare(
          `INSERT INTO credit_ledger
             (user_id, bytes_total, source, reason, actor, reference_key, created_at,
              apply_state, apply_code_enc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, bytes, input.source, reason, actor, referenceKey, now, applyState, applyCodeEnc);
    } catch (err) {
      // Another writer won the UNIQUE race on reference_key between the
      // read above and this insert: return that row instead of failing.
      if (referenceKey && String((err as { code?: string }).code ?? '').includes('SQLITE_CONSTRAINT')) {
        const existing = app.db
          .prepare('SELECT * FROM credit_ledger WHERE reference_key = ?')
          .get(referenceKey) as CreditRow | undefined;
        if (existing) {
          return existing.id;
        }
      }
      throw err;
    }
    app.db
      .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(
        now,
        actor,
        'credit.grant',
        userId,
        JSON.stringify({
          creditId: Number(info.lastInsertRowid),
          bytes,
          source: input.source,
          reason,
          referenceKey,
          applyState,
          hasApplyCode: applyCodeEnc !== null,
        }),
      );
    return Number(info.lastInsertRowid);
  });
  const creditId = insert();

  // Re-read so the response mirrors the stored state (identical shape for the
  // keyed and keyless paths).
  const row = app.db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(creditId) as CreditRow;
  return rowToCreditResult(row, false);
}

export interface CreditListFilter {
  userId?: string;
  limit?: number;
}

/** Ledger reads for `credit list` and any future review surface. */
export function listCredits(
  app: Pick<AppContext, 'db'>,
  filter: CreditListFilter = {},
): CreditRow[] {
  const limit = filter.limit ?? 50;
  if (filter.userId) {
    return app.db
      .prepare(
        `SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(filter.userId, limit) as CreditRow[];
  }
  return app.db
    .prepare(`SELECT * FROM credit_ledger ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(limit) as CreditRow[];
}

// ---------------------------------------------------------------------------
// Tenant-side application (plan B): pull pending credits, report the result.
// ---------------------------------------------------------------------------

/** One pending grant as the OWNING tenant sees it: its own code, no actor. */
export interface PendingCreditForTenant {
  creditId: number;
  bytes: number;
  reason: string;
  referenceKey: string | null;
  createdAt: number;
  /** Single-use upstream redeem code worth exactly `bytes`. */
  code: string;
}

/** A pending grant the tenant cannot apply yet (operator action required). */
export interface BlockedCreditForTenant {
  creditId: number;
  bytes: number;
  referenceKey: string | null;
  createdAt: number;
  reason: 'NO_APPLICATION_CODE';
}

export interface PendingCreditSet {
  applicable: PendingCreditForTenant[];
  blocked: BlockedCreditForTenant[];
}

/** Upper bound on rows returned by one pull (the tenant pages on later ticks). */
const PENDING_PULL_LIMIT = 50;

/**
 * Pending rows for ONE user, scoped by the caller (the route resolves the
 * user from the authenticated tenant — never from the request body). Only
 * `apply_state = 'pending'` rows are candidates; `not-required` rows were
 * already credited upstream and `applied` rows are done.
 */
export function listPendingCreditForTenant(
  app: Pick<AppContext, 'db' | 'config'>,
  userId: string,
): PendingCreditSet {
  const rows = app.db
    .prepare(
      `SELECT * FROM credit_ledger
       WHERE user_id = ? AND apply_state = 'pending'
       ORDER BY id ASC LIMIT ?`,
    )
    .all(userId, PENDING_PULL_LIMIT) as CreditRow[];

  const applicable: PendingCreditForTenant[] = [];
  const blocked: BlockedCreditForTenant[] = [];
  for (const row of rows) {
    if (!row.apply_code_enc) {
      blocked.push({
        creditId: row.id,
        bytes: row.bytes_total,
        referenceKey: row.reference_key,
        createdAt: row.created_at,
        reason: 'NO_APPLICATION_CODE',
      });
      continue;
    }
    let code: string;
    try {
      code = decryptSecret(app.config.masterKey, row.apply_code_enc);
    } catch {
      // An undecryptable code is an operator/rotation problem, not a tenant
      // one: report it as blocked instead of failing the whole pull.
      blocked.push({
        creditId: row.id,
        bytes: row.bytes_total,
        referenceKey: row.reference_key,
        createdAt: row.created_at,
        reason: 'NO_APPLICATION_CODE',
      });
      continue;
    }
    applicable.push({
      creditId: row.id,
      bytes: row.bytes_total,
      reason: row.reason,
      referenceKey: row.reference_key,
      createdAt: row.created_at,
      code,
    });
  }
  return { applicable, blocked };
}

export interface CreditApplyEvidence {
  codeId?: number;
  trafficBytes?: number;
  balanceAfter?: number;
  [key: string]: unknown;
}

export interface MarkCreditAppliedResult {
  creditId: number;
  applied: boolean;
  /** true when the row was already applied before this call. */
  duplicate: boolean;
  applyState: CreditApplyState;
  appliedAt: number | null;
  appliedBytes: number | null;
}

/**
 * Flip one pending row to applied. The UPDATE is conditional on
 * `apply_state = 'pending'` AND the row belonging to `userId`, so a second
 * report (crash-retry, duplicate tick) can never re-apply or touch another
 * user's row. Returns 404 for a creditId outside the caller's scope rather
 * than leaking its existence.
 */
export function markCreditApplied(
  app: Pick<AppContext, 'db'>,
  input: {
    creditId: number;
    userId: string;
    appliedBy: string;
    evidence: CreditApplyEvidence;
    appliedBytes: number;
  },
): MarkCreditAppliedResult {
  const row = app.db
    .prepare('SELECT * FROM credit_ledger WHERE id = ? AND user_id = ?')
    .get(input.creditId, input.userId) as CreditRow | undefined;
  if (!row) {
    throw new HttpError(404, 'CREDIT_NOT_FOUND', `credit ${input.creditId} does not exist for this tenant`);
  }
  const now = Date.now();
  const info = app.db
    .prepare(
      `UPDATE credit_ledger
       SET apply_state = 'applied', applied_at = ?, applied_by = ?, applied_bytes = ?,
           applied_evidence = ?, last_apply_at = ?, last_apply_error = NULL
       WHERE id = ? AND user_id = ? AND apply_state = 'pending'`,
    )
    .run(
      now,
      input.appliedBy,
      input.appliedBytes,
      JSON.stringify(input.evidence ?? {}),
      now,
      input.creditId,
      input.userId,
    );
  const fresh = app.db
    .prepare('SELECT * FROM credit_ledger WHERE id = ?')
    .get(input.creditId) as CreditRow;
  const applied = info.changes === 1;
  return {
    creditId: input.creditId,
    applied,
    duplicate: !applied && fresh.apply_state === 'applied',
    applyState: fresh.apply_state,
    appliedAt: fresh.applied_at,
    appliedBytes: fresh.applied_bytes,
  };
}

/**
 * Record a failed application attempt so the operator can see WHY a grant is
 * not landing. The row stays `pending` (retryable) — failure never marks a
 * grant applied.
 */
export function recordCreditApplyFailure(
  app: Pick<AppContext, 'db'>,
  input: { creditId: number; userId: string; error: string },
): { creditId: number; applyAttempts: number; applyState: CreditApplyState } {
  const row = app.db
    .prepare('SELECT id, apply_state FROM credit_ledger WHERE id = ? AND user_id = ?')
    .get(input.creditId, input.userId) as { id: number; apply_state: CreditApplyState } | undefined;
  if (!row) {
    throw new HttpError(404, 'CREDIT_NOT_FOUND', `credit ${input.creditId} does not exist for this tenant`);
  }
  const now = Date.now();
  app.db
    .prepare(
      `UPDATE credit_ledger
       SET apply_attempts = apply_attempts + 1, last_apply_error = ?, last_apply_at = ?
       WHERE id = ? AND user_id = ? AND apply_state = 'pending'`,
    )
    .run(String(input.error ?? '').slice(0, 512), now, input.creditId, input.userId);
  const fresh = app.db
    .prepare('SELECT apply_attempts FROM credit_ledger WHERE id = ?')
    .get(input.creditId) as { apply_attempts: number };
  return { creditId: input.creditId, applyAttempts: fresh.apply_attempts, applyState: row.apply_state };
}

/**
 * Attach (or replace) the single-use upstream code a pending grant redeems.
 * The code is encrypted at rest; the audit row records the fact, never the
 * value. Only pending rows accept a code: an applied grant must not be
 * re-armed, and a bundle-order grant was already credited upstream.
 */
export function attachCreditApplyCode(
  app: Pick<AppContext, 'db' | 'config'>,
  input: { creditId: number; code: string; actor: string },
): CreditGrantResult {
  const code = normalizeApplyCode(input.code);
  const row = app.db
    .prepare('SELECT * FROM credit_ledger WHERE id = ?')
    .get(input.creditId) as CreditRow | undefined;
  if (!row) {
    throw new HttpError(404, 'CREDIT_NOT_FOUND', `credit ${input.creditId} does not exist`);
  }
  if (row.apply_state !== 'pending') {
    throw new HttpError(
      409,
      'CREDIT_NOT_PENDING',
      `credit ${input.creditId} is ${row.apply_state}; only pending grants accept an application code`,
    );
  }
  const now = Date.now();
  const encrypted = encryptSecret(app.config.masterKey, code);
  app.db.transaction(() => {
    app.db
      .prepare('UPDATE credit_ledger SET apply_code_enc = ?, last_apply_error = NULL WHERE id = ?')
      .run(encrypted, input.creditId);
    app.db
      .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(
        now,
        input.actor,
        'credit.attach_code',
        row.user_id,
        JSON.stringify({ creditId: input.creditId, bytes: row.bytes_total }),
      );
  })();
  const fresh = app.db
    .prepare('SELECT * FROM credit_ledger WHERE id = ?')
    .get(input.creditId) as CreditRow;
  return rowToCreditResult(fresh, false);
}
