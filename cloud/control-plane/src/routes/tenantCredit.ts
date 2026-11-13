import type { AppContext } from '../context.js';
import { decryptSecret, timingSafeEqualStr } from '../crypto.js';
import { HttpError, writeJson, type RequestCtx, type Route } from '../http.js';
import {
  listPendingCreditForTenant,
  markCreditApplied,
  recordCreditApplyFailure,
  type CreditApplyEvidence,
} from '../services/creditService.js';

/**
 * Tenant-facing credit application (plan B, owner decision 2026-11-05).
 *
 * Why this route exists: the control plane must never hold a credential that
 * can mint traffic credit on any account. The tenant — which already owns the
 * user identity — is the only party that can turn a ledger row into bytes on
 * the user's upstream traffic account (identity-signed redeem-code). So the
 * tenant PULLS instead of the control plane pushing:
 *
 *   GET  /api/v1/tenant/credit/pending
 *     → { tenantId, userId, credits: [{creditId, bytes, code, ...}],
 *         blocked: [{creditId, bytes, reason: 'NO_APPLICATION_CODE'}] }
 *     Only rows of THIS tenant's user, only apply_state = 'pending'.
 *
 *   POST /api/v1/tenant/credit/:creditId/apply-result
 *     body { ok: true, evidence: { codeId, trafficBytes, balanceAfter } }
 *       → the row flips pending → applied exactly once (conditional UPDATE).
 *     body { ok: false, error: '...' }
 *       → attempt counter + last error recorded; the row STAYS pending so the
 *         next tick retries.
 *
 * Authentication is the tenant's own long-lived gateway credential — the same
 * secret the tenant already holds as IDBOTS_GATEWAY_SECRET and the control
 * plane already stores encrypted for proxy/health use. It is presented as
 * `Authorization: Bearer <secret>` with `X-Tenant-Id: <t_...>`; the user is
 * resolved from the tenants row, NEVER from the request body, so a tenant can
 * only ever read or mark its own user's credits.
 *
 * These routes are `auth: false` (no idb_session cookie) and skip the Origin
 * gate: they are server-to-server, carry an explicit bearer secret, and a
 * browser CSRF request cannot supply that secret. Nothing here is reachable
 * with a user session alone.
 */

interface TenantAuth {
  tenantId: string;
  userId: string;
}

function requireTenant(app: AppContext, reqCtx: RequestCtx): TenantAuth {
  const supplied = String(reqCtx.req?.headers.authorization ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  const tenantId = String(reqCtx.req?.headers['x-tenant-id'] ?? '').trim();
  // One uniform refusal for unknown tenant / bad secret / undecryptable row:
  // an unauthenticated caller learns nothing about tenant ids.
  const denied = (): HttpError =>
    new HttpError(401, 'TENANT_UNAUTHORIZED', 'tenant credentials missing or invalid');
  if (!supplied || !tenantId) throw denied();

  const row = app.db
    .prepare('SELECT id, user_id, gateway_secret_enc FROM tenants WHERE id = ?')
    .get(tenantId) as { id: string; user_id: string; gateway_secret_enc: string } | undefined;
  if (!row) throw denied();

  let expected: string;
  try {
    expected = decryptSecret(app.config.masterKey, row.gateway_secret_enc);
  } catch {
    throw denied();
  }
  if (!timingSafeEqualStr(supplied, expected)) throw denied();
  return { tenantId: row.id, userId: row.user_id };
}

async function tenantCreditPending(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  const auth = requireTenant(app, reqCtx);
  const pending = listPendingCreditForTenant(app, auth.userId);
  reqCtx.log('info', 'tenant credit pull', {
    tenantId: auth.tenantId,
    applicable: pending.applicable.length,
    blocked: pending.blocked.length,
  });
  writeJson(reqCtx.res, 200, {
    tenantId: auth.tenantId,
    userId: auth.userId,
    credits: pending.applicable,
    blocked: pending.blocked,
    serverTime: Date.now(),
  });
}

function parseCreditId(params: Record<string, string>): number {
  const creditId = Number(params.creditId);
  if (!Number.isInteger(creditId) || creditId <= 0) {
    throw new HttpError(400, 'INVALID_CREDIT_ID', 'creditId must be a positive integer');
  }
  return creditId;
}

function parseEvidence(value: unknown): CreditApplyEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const evidence: CreditApplyEvidence = {};
  for (const key of ['codeId', 'trafficBytes', 'balanceAfter'] as const) {
    const raw = source[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) evidence[key] = Math.trunc(raw);
  }
  return evidence;
}

async function tenantCreditApplyResult(
  app: AppContext,
  reqCtx: RequestCtx,
  body: unknown,
  params: Record<string, string>,
): Promise<void> {
  const auth = requireTenant(app, reqCtx);
  const creditId = parseCreditId(params);
  const payload = (body ?? {}) as Record<string, unknown>;
  const ok = payload.ok === true;

  if (!ok) {
    const error = String(payload.error ?? 'application failed').trim() || 'application failed';
    const result = recordCreditApplyFailure(app, {
      creditId,
      userId: auth.userId,
      error,
    });
    reqCtx.log('warn', 'tenant credit apply failed', {
      tenantId: auth.tenantId,
      creditId,
      applyAttempts: result.applyAttempts,
    });
    writeJson(reqCtx.res, 200, { ...result, applied: false });
    return;
  }

  const evidence = parseEvidence(payload.evidence);
  const appliedBytes =
    typeof evidence.trafficBytes === 'number' && evidence.trafficBytes > 0
      ? evidence.trafficBytes
      : (app.db
          .prepare('SELECT bytes_total FROM credit_ledger WHERE id = ? AND user_id = ?')
          .get(creditId, auth.userId) as { bytes_total: number } | undefined)?.bytes_total ?? 0;

  const result = markCreditApplied(app, {
    creditId,
    userId: auth.userId,
    appliedBy: auth.tenantId,
    evidence,
    appliedBytes,
  });
  reqCtx.log('info', 'tenant credit applied', {
    tenantId: auth.tenantId,
    creditId,
    applied: result.applied,
    duplicate: result.duplicate,
    appliedBytes: result.appliedBytes,
  });
  writeJson(reqCtx.res, 200, result);
}

export const tenantCreditRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/v1/tenant/credit/pending',
    auth: false,
    skipOriginCheck: true,
    handler: tenantCreditPending,
  },
  {
    method: 'POST',
    path: '/api/v1/tenant/credit/:creditId/apply-result',
    auth: false,
    skipOriginCheck: true,
    handler: tenantCreditApplyResult,
  },
];
