/**
 * Tenant-side invite trial grant pull + claim (CR-WSE-005).
 *
 * When a user registers on mobile with a valid invite code, Control Plane
 * consumes the code via ABS partner API and receives a single-use `grantTicket`
 * (stored encrypted in `invite_grants` and also injected as
 * `IDBOTS_BOOTSTRAP_INVITE_GRANT_TICKET` on initial container creation).
 *
 * Because the user's MetaID identity (`mvc_address` + mnemonic) is generated
 * inside the tenant container during first-boot bootstrap — and Control Plane
 * never holds user mnemonics — the tenant container itself claims the trial
 * subscription via the identity-signed endpoint:
 *
 *   1. GET  {controlPlane}/api/v1/tenant/invite-grant/pending
 *   2. POST /v1/me/invite/claim-grant      (ABS, BSMA identity-signed)
 *   3. POST {controlPlane}/api/v1/tenant/invite-grant/claimed
 *
 * Both sides are idempotent:
 * - ABS `ClaimInviteGrantTicket` returns `applied: false` with the active
 *   subscription if the same identity re-submits an already-activated ticket.
 * - Control Plane `recordInviteGrantClaimResult` clears `grant_ticket_enc` and
 *   records `trial_ends_at` so future `/pending` calls return `{ pending: false }`.
 */

import { readCreditPullConfig, CONTROL_PLANE_URL_ENV } from './creditPullService';
import {
  claimMeInviteGrantTicket,
  MePointsApiError,
  type MeInviteClaimGrantResult,
} from './mePointsService';

export const BOOTSTRAP_INVITE_GRANT_TICKET_ENV = 'IDBOTS_BOOTSTRAP_INVITE_GRANT_TICKET';
export const INVITE_GRANT_INITIAL_DELAY_MS = 15_000;
export const INVITE_GRANT_INTERVAL_MS = 5 * 60_000;
export const INVITE_GRANT_RETRY_BASE_MS = 30_000;
export const INVITE_GRANT_RETRY_MAX_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface PendingInviteGrantResponse {
  pending?: boolean;
  code?: string;
  redemptionId?: string | null;
  grantTicket?: string;
  planId?: string;
  planName?: string | null;
  planNameEn?: string | null;
  periodDays?: number;
}

export interface InviteGrantPullResult {
  status: 'claimed' | 'none' | 'skipped' | 'retry';
  reason?: string;
  planId?: string;
  periodEnd?: number | null;
}

export interface ClaimInviteGrantFn {
  (grantTicket: string): Promise<MeInviteClaimGrantResult>;
}

export interface InviteGrantPullDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  claimGrant?: ClaimInviteGrantFn;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: 'invite-grant-pull',
    msg,
    ...(extra ?? {}),
  };
  if (level === 'error') console.error(JSON.stringify(line));
  else if (level === 'warn') console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

function describeError(error: unknown): string {
  if (error instanceof MePointsApiError) {
    const code = error.errorCode ? `${error.errorCode}: ` : '';
    return `${error.stage}: ${code}${error.message}`.slice(0, 512);
  }
  if (error instanceof Error) return error.message.slice(0, 512);
  return String(error).slice(0, 512);
}

function isIdentityNotReadyError(error: unknown): boolean {
  return (
    error instanceof MePointsApiError &&
    /local user identity is missing or incomplete/i.test(error.message)
  );
}

function extractPeriodEndMs(claimed: MeInviteClaimGrantResult): number | null {
  const raw = claimed.subscription?.raw;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw.periodEnd ?? raw.period_end;
  const n = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Number(candidate) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.trunc(n) : Math.trunc(n * 1000);
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

/**
 * Execute one invite grant check/claim tick. Never throws.
 */
export async function runInviteGrantPullOnce(
  deps: InviteGrantPullDeps = {},
): Promise<InviteGrantPullResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const claimGrant: ClaimInviteGrantFn = deps.claimGrant ?? claimMeInviteGrantTicket;
  const log = deps.log ?? defaultLog;

  const config = readCreditPullConfig(env);
  const envTicket = String(env[BOOTSTRAP_INVITE_GRANT_TICKET_ENV] ?? '').trim();

  if (!config && !envTicket) {
    return {
      status: 'skipped',
      reason: `${CONTROL_PLANE_URL_ENV} / IDBOTS_TENANT_ID / IDBOTS_GATEWAY_SECRET not configured`,
    };
  }

  const headers = config
    ? {
        accept: 'application/json',
        authorization: `Bearer ${config.gatewaySecret}`,
        'x-tenant-id': config.tenantId,
      }
    : null;

  let grantTicket = '';
  if (config && headers) {
    try {
      const pendingRes = await requestJson(
        fetchImpl,
        `${config.controlPlaneUrl}/api/v1/tenant/invite-grant/pending`,
        { method: 'GET', headers },
      );
      if (pendingRes.status === 200) {
        const body = (pendingRes.body ?? {}) as PendingInviteGrantResponse;
        if (body.pending === false) {
          return { status: 'none' };
        }
        if (body.pending === true && typeof body.grantTicket === 'string' && body.grantTicket.trim()) {
          grantTicket = body.grantTicket.trim();
        }
      } else if (pendingRes.status === 404) {
        // Older control plane without invite-grant routes; fall back to env ticket if present.
        if (!envTicket) return { status: 'none' };
        grantTicket = envTicket;
      } else {
        log('warn', 'invite grant pending query rejected by control plane', { status: pendingRes.status });
        if (!envTicket) {
          return { status: 'retry', reason: `control plane answered ${pendingRes.status}` };
        }
        grantTicket = envTicket;
      }
    } catch (error) {
      const msg = describeError(error);
      log('warn', 'invite grant pending query failed', { error: msg });
      if (!envTicket) {
        return { status: 'retry', reason: `control plane unreachable: ${msg}` };
      }
      grantTicket = envTicket;
    }
  } else {
    grantTicket = envTicket;
  }

  if (!grantTicket) {
    return { status: 'none' };
  }

  try {
    const claimed = await claimGrant(grantTicket);
    const periodEnd = extractPeriodEndMs(claimed);
    const planId = claimed.planId || undefined;

    if (config && headers) {
      const ack = await requestJson(
        fetchImpl,
        `${config.controlPlaneUrl}/api/v1/tenant/invite-grant/claimed`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            ok: true,
            planId: planId ?? null,
            periodEnd,
          }),
        },
      );
      if (ack.status !== 200 && ack.status !== 404) {
        log('warn', 'control plane rejected invite grant ack (will retry ack)', { status: ack.status });
        return {
          status: 'retry',
          reason: `control plane ack answered ${ack.status}`,
          planId,
          periodEnd,
        };
      }
    }

    log('info', 'invite trial grant claimed', {
      applied: claimed.applied,
      planId: claimed.planId,
      periodDays: claimed.periodDays,
      periodEnd,
    });
    return {
      status: 'claimed',
      planId,
      periodEnd,
    };
  } catch (error) {
    if (isIdentityNotReadyError(error)) {
      return { status: 'retry', reason: 'identity_not_ready' };
    }
    const message = describeError(error);
    log('warn', 'invite trial grant claim failed (will retry)', { error: message });
    if (config && headers) {
      try {
        await requestJson(
          fetchImpl,
          `${config.controlPlaneUrl}/api/v1/tenant/invite-grant/claimed`,
          {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ ok: false, error: message }),
          },
        );
      } catch {
        // Best-effort diagnostic report.
      }
    }
    return { status: 'retry', reason: message };
  }
}

export interface InviteGrantPullLoopOptions extends InviteGrantPullDeps {
  initialDelayMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export interface InviteGrantPullLoop {
  stop(): void;
  runNow(): Promise<InviteGrantPullResult>;
}

export function startInviteGrantPullLoop(
  options: InviteGrantPullLoopOptions = {},
): InviteGrantPullLoop {
  const log = options.log ?? defaultLog;
  const initialDelayMs = options.initialDelayMs ?? INVITE_GRANT_INITIAL_DELAY_MS;
  const intervalMs = options.intervalMs ?? INVITE_GRANT_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let stopped = false;
  let running = false;
  let completed = false;
  let attempts = 0;
  let nextAttemptAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  const clearTimers = (): void => {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    timer = null;
    interval = null;
  };

  const tick = async (manual = false): Promise<InviteGrantPullResult> => {
    if (stopped) return { status: 'skipped', reason: 'stopped' };
    if (completed) return { status: 'none', reason: 'already_settled' };
    if (running) return { status: 'skipped', reason: 'busy' };
    if (!manual && nextAttemptAt > now()) {
      return { status: 'skipped', reason: 'backoff' };
    }
    running = true;
    try {
      const result = await runInviteGrantPullOnce({
        ...(options.env ? { env: options.env } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.claimGrant ? { claimGrant: options.claimGrant } : {}),
        log,
      });
      if (result.status === 'claimed' || result.status === 'none') {
        completed = true;
        clearTimers();
      } else if (result.status === 'retry' && result.reason !== 'identity_not_ready') {
        attempts += 1;
        const delay = Math.min(INVITE_GRANT_RETRY_BASE_MS * 2 ** (attempts - 1), INVITE_GRANT_RETRY_MAX_MS);
        nextAttemptAt = now() + delay;
      }
      return result;
    } finally {
      running = false;
    }
  };

  timer = setTimeout(() => {
    void tick(false).catch((error) => log('error', 'invite grant pull tick crashed', { error: String(error) }));
    if (!stopped && !completed) {
      interval = setInterval(() => {
        void tick(false).catch((error) => log('error', 'invite grant pull tick crashed', { error: String(error) }));
      }, intervalMs);
      interval.unref?.();
    }
  }, initialDelayMs);
  timer.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearTimers();
    },
    runNow: () => tick(true),
  };
}
