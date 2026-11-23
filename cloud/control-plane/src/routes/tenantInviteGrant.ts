import type { AppContext } from '../context.js';
import { writeJson, type RequestCtx, type Route } from '../http.js';
import { requireTenant } from './tenantCredit.js';
import {
  getPendingInviteGrantForUser,
  recordInviteGrantClaimResult,
} from '../services/inviteGrantService.js';

/**
 * Tenant-facing invite grant ticket pull/acknowledge endpoints:
 *   GET  /api/v1/tenant/invite-grant/pending
 *   POST /api/v1/tenant/invite-grant/claimed
 *
 * Protected by `requireTenant` (`Authorization: Bearer <IDBOTS_GATEWAY_SECRET>` +
 * `X-Tenant-Id`) and blocked on the public edge by Caddy (`@tenantCredit path /api/v1/tenant/*`).
 */

async function tenantInviteGrantPending(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  const auth = requireTenant(app, reqCtx);
  const pending = getPendingInviteGrantForUser(app, auth.userId);
  writeJson(reqCtx.res, 200, {
    tenantId: auth.tenantId,
    userId: auth.userId,
    ...pending,
  });
}

async function tenantInviteGrantClaimed(
  app: AppContext,
  reqCtx: RequestCtx,
  body: unknown,
): Promise<void> {
  const auth = requireTenant(app, reqCtx);
  const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const ok = payload.ok === true;
  const periodEnd =
    typeof payload.periodEnd === 'number' && Number.isFinite(payload.periodEnd)
      ? Math.trunc(payload.periodEnd)
      : null;
  const planId = typeof payload.planId === 'string' ? payload.planId : null;
  const error = typeof payload.error === 'string' ? payload.error : null;

  const result = recordInviteGrantClaimResult(app, {
    userId: auth.userId,
    ok,
    periodEnd,
    planId,
    error,
  });
  reqCtx.log(ok ? 'info' : 'warn', 'tenant invite grant claim reported', {
    tenantId: auth.tenantId,
    claimed: result.claimed,
    claimAttempts: result.claimAttempts,
  });
  writeJson(reqCtx.res, 200, result);
}

export const tenantInviteGrantRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/v1/tenant/invite-grant/pending',
    auth: false,
    skipOriginCheck: true,
    handler: tenantInviteGrantPending,
  },
  {
    method: 'POST',
    path: '/api/v1/tenant/invite-grant/claimed',
    auth: false,
    skipOriginCheck: true,
    handler: tenantInviteGrantClaimed,
  },
];
