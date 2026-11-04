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
 * byte-level application to a tenant traffic account goes through the
 * upstream traffic admin channel (`POST
 * /v1/admin/traffic/accounts/{accountId}/grants` on the tenant image); the
 * operator records that reference (upstream account / order id) inside
 * `reason` or `referenceKey`. Nothing here guesses an upstream credential.
 *
 * Idempotency: `referenceKey` (client-supplied) is UNIQUE. Re-submitting the
 * same key returns the EXISTING grant (`duplicate: true`) instead of writing
 * a second row — an operator retrying after an uncertain timeout can never
 * double-credit.
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
}

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
  };
}

/**
 * Validate + insert one credit grant inside a transaction, write the paired
 * audit_log row, and return the grant. Throws the HttpError shapes the HTTP
 * route maps 1:1 (the CLI re-labels them as CliError at its boundary).
 */
export function grantCredit(
  app: Pick<AppContext, 'db'>,
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
          `INSERT INTO credit_ledger (user_id, bytes_total, source, reason, actor, reference_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, bytes, input.source, reason, actor, referenceKey, now);
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
        }),
      );
    return Number(info.lastInsertRowid);
  });
  const creditId = insert();

  if (referenceKey) {
    // The duplicate branch above already has the full row; re-read once for
    // the fresh-insert path so the response mirrors the stored state.
    const row = app.db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(creditId) as CreditRow;
    return rowToCreditResult(row, false);
  }
  return {
    creditId,
    userId,
    bytes,
    source: input.source,
    reason,
    actor,
    referenceKey,
    createdAt: now,
    duplicate: false,
  };
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
        `SELECT id, user_id, bytes_total, source, reason, actor, reference_key, created_at
         FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(filter.userId, limit) as CreditRow[];
  }
  return app.db
    .prepare(
      `SELECT id, user_id, bytes_total, source, reason, actor, reference_key, created_at
       FROM credit_ledger ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as CreditRow[];
}
