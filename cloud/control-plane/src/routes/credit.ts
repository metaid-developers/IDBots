import type { AppContext } from '../context.js';
import { HttpError, writeJson, type RequestCtx, type Route } from '../http.js';
import {
  attachCreditApplyCode,
  grantCredit,
  listCredits,
  rowToCreditResult,
} from '../services/creditService.js';

/**
 * Admin credit surface (payment credit channel, NEW capability — no C2/C3
 * contract change). Operator-only: bearer token from CP_ADMIN_API_TOKEN.
 *
 * - Token unset → every route answers 404 (surface disabled), exactly like
 *   the tenant image's admin console gate; the credit CLI stays available.
 * - Token set → missing/wrong bearer gets 401 before anything is read.
 * - No user session can reach these routes: `auth` stays false and the
 *   handler never looks at reqCtx.user — authorization is the token alone.
 *
 * POST /api/v1/admin/credit   body { userId, bytes, reason, referenceKey? }
 *   → 201 { creditId, userId, bytes, source, reason, actor, referenceKey,
 *           createdAt, duplicate } (duplicate=true with 200 on re-submission
 *   of the same referenceKey — the row already exists, nothing re-granted).
 *
 * GET /api/v1/admin/credit?userId=...&limit=... → { credits: [...] }
 *
 * POST /api/v1/admin/credit/:creditId/code  body { code, operator? }
 *   → attach the single-use upstream redeem code a pending manual grant is
 *     worth. Code values are never echoed or logged.
 *
 * Every grant lands in credit_ledger AND audit_log; the CLI writes the same
 * ledger rows through services/creditService.grantCredit. The tenant-facing
 * pull/apply surface lives in routes/tenantCredit.ts.
 */

function requireAdminToken(app: AppContext, reqCtx: RequestCtx): void {
  const token = app.config.adminApiToken;
  if (!token) {
    // Disabled surface: indistinguishable from a route that does not exist.
    throw new HttpError(404, 'NOT_FOUND', `no route for ${reqCtx.method} ${reqCtx.path}`);
  }
  const authorization = String((reqCtx.req?.headers.authorization as string | undefined) ?? '');
  const supplied = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!supplied || supplied !== token) {
    throw new HttpError(401, 'ADMIN_UNAUTHORIZED', 'admin bearer token missing or invalid');
  }
}

function parsePositiveIntParam(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, 'INVALID_QUERY', `query parameter "${name}" must be a positive integer`);
  }
  return Math.min(parsed, 200);
}

async function adminCreditGrant(app: AppContext, reqCtx: RequestCtx, body: unknown): Promise<void> {
  requireAdminToken(app, reqCtx);
  const payload = (body ?? {}) as Record<string, unknown>;
  const rawBytes = payload.bytes;
  const bytes =
    typeof rawBytes === 'number' ? rawBytes : Number(String(rawBytes ?? '').trim() || NaN);
  // The token holder is the trusted party; the operator label is recorded
  // verbatim in the audit trail with the same admin:<name> convention the
  // CLI uses (audit_log actor format, WS-B contract).
  const operator = String(payload.operator ?? '').trim() || 'http';
  const result = grantCredit(app, {
    userId: String(payload.userId ?? ''),
    bytes,
    reason: String(payload.reason ?? ''),
    source: payload.source === 'bundle-order' ? 'bundle-order' : 'manual',
    actor: `admin:${operator}`,
    referenceKey:
      payload.referenceKey === undefined || payload.referenceKey === null
        ? null
        : String(payload.referenceKey),
    applyCode:
      payload.applyCode === undefined || payload.applyCode === null
        ? null
        : String(payload.applyCode),
  });
  reqCtx.log('info', 'credit grant', {
    userId: result.userId,
    bytes: result.bytes,
    duplicate: result.duplicate,
    applyState: result.applyState,
  });
  writeJson(reqCtx.res, result.duplicate ? 200 : 201, result);
}

/**
 * Attach the upstream redeem code a pending manual grant redeems. This is the
 * one operator step plan B needs: the tenant applies the bytes itself, so the
 * control plane only needs to know WHICH single-use code that grant is worth.
 * The code value is never echoed back and never logged.
 */
async function adminAttachApplyCode(
  app: AppContext,
  reqCtx: RequestCtx,
  body: unknown,
  params: Record<string, string>,
): Promise<void> {
  requireAdminToken(app, reqCtx);
  const creditId = Number(params.creditId);
  if (!Number.isInteger(creditId) || creditId <= 0) {
    throw new HttpError(400, 'INVALID_CREDIT_ID', 'creditId must be a positive integer');
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  const operator = String(payload.operator ?? '').trim() || 'http';
  const result = attachCreditApplyCode(app, {
    creditId,
    code: String(payload.code ?? ''),
    actor: `admin:${operator}`,
  });
  reqCtx.log('info', 'credit apply code attached', {
    creditId: result.creditId,
    userId: result.userId,
    hasApplyCode: result.hasApplyCode,
  });
  writeJson(reqCtx.res, 200, result);
}

async function adminCreditList(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  requireAdminToken(app, reqCtx);
  const url = new URL(reqCtx.req?.url ?? '/', 'http://localhost');
  const rows = listCredits(app, {
    userId: url.searchParams.get('userId') ?? undefined,
    limit: parsePositiveIntParam(url.searchParams.get('limit') ?? undefined, 'limit', 50),
  });
  writeJson(reqCtx.res, 200, { credits: rows.map((row) => rowToCreditResult(row, false)) });
}

export const creditRoutes: Route[] = [
  { method: 'POST', path: '/api/v1/admin/credit', auth: false, handler: adminCreditGrant },
  { method: 'GET', path: '/api/v1/admin/credit', auth: false, handler: adminCreditList },
  {
    method: 'POST',
    path: '/api/v1/admin/credit/:creditId/code',
    auth: false,
    handler: adminAttachApplyCode,
  },
];
