/**
 * Credit pull + apply (plan B, owner decision 2026-11-05).
 *
 * The control-plane credit ledger records grants ("50 GB to user X, because
 * Y"), but a record is not bytes: the user's traffic account lives upstream,
 * and the ONLY channel that can add bytes with the credential this container
 * legitimately owns (the user's MetaID identity) is the identity-signed
 * redeem-code endpoint. So the tenant pulls:
 *
 *   GET  {controlPlane}/api/v1/tenant/credit/pending
 *        → the rows of THIS tenant's user that are still pending, each with
 *          the single-use upstream code that grant is worth.
 *   POST /v1/traffic/redeem-code            (upstream, identity-signed)
 *   POST {controlPlane}/api/v1/tenant/credit/:id/apply-result
 *        → mark the row applied (once) or record the failure (retry later).
 *
 * The control plane never holds a credential that can mint credit on any
 * account; it stores only the code a grant is worth and the evidence this
 * process reports back.
 *
 * Idempotency, both sides:
 * - Upstream redemption of the same code by the same account is idempotent
 *   (the backend returns the same codeId), so a crash between redeem and
 *   report is safe to retry.
 * - The ledger UPDATE is conditional on `pending`, so a duplicate report can
 *   never re-apply.
 *
 * Failure policy: a failed application NEVER marks the row applied — the row
 * stays pending and the next tick retries with exponential backoff. The
 * in-memory backoff only paces retries; it is not a correctness mechanism.
 */

import {
  redeemTrafficCode,
  TrafficApiError,
  type TrafficRedeemCodeResult,
} from './trafficAccountService';

/** Env var carrying the control-plane base URL (set via CP_TENANT_ENV_*). */
export const CONTROL_PLANE_URL_ENV = 'IDBOTS_CONTROL_PLANE_URL';

/** First retry delay after a failed application. */
export const CREDIT_RETRY_BASE_MS = 60_000;
/** Retry backoff cap. */
export const CREDIT_RETRY_MAX_MS = 30 * 60_000;
/** Default tick interval (startup run + every 5 minutes). */
export const CREDIT_PULL_INTERVAL_MS = 5 * 60_000;
/** Delay before the first tick: lets the bootstrap create the traffic account. */
export const CREDIT_PULL_INITIAL_DELAY_MS = 45_000;
/** Per-request timeout. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface CreditPullConfig {
  controlPlaneUrl: string;
  tenantId: string;
  gatewaySecret: string;
}

/**
 * Resolve the pull configuration from the environment. Any missing piece
 * disables the loop with an explicit reason — never a silent no-op and never
 * a guessed URL.
 */
export function readCreditPullConfig(env: NodeJS.ProcessEnv = process.env): CreditPullConfig | null {
  const controlPlaneUrl = String(env[CONTROL_PLANE_URL_ENV] ?? '').trim().replace(/\/+$/, '');
  const tenantId = String(env.IDBOTS_TENANT_ID ?? '').trim();
  const gatewaySecret = String(env.IDBOTS_GATEWAY_SECRET ?? '').trim();
  if (!controlPlaneUrl || !tenantId || !gatewaySecret) return null;
  return { controlPlaneUrl, tenantId, gatewaySecret };
}

export interface PendingCreditGrant {
  creditId: number;
  bytes: number;
  reason: string;
  referenceKey: string | null;
  createdAt: number;
  code: string;
}

export interface BlockedCreditGrant {
  creditId: number;
  bytes: number;
  referenceKey: string | null;
  reason: string;
}

export interface CreditPullResult {
  /** Why this tick did nothing (config missing, CP unreachable…). */
  skipped?: string;
  applied: number[];
  failed: Array<{ creditId: number; error: string }>;
  blocked: number[];
}

export interface CreditRedeemFn {
  (code: string): Promise<Pick<TrafficRedeemCodeResult, 'codeId' | 'trafficBytes' | 'balanceAfter'>>;
}

export interface CreditPullDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  redeem?: CreditRedeemFn;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** true = this credit is inside its retry backoff window; skip this tick. */
  isGated?: (creditId: number) => boolean;
  /** Called once per credit that is actually attempted (used to pace retries). */
  onAttempt?: (creditId: number, outcome: 'applied' | 'failed') => void;
}

interface RetryState {
  attempts: number;
  nextAttemptAt: number;
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: 'credit-pull',
    msg,
    ...(extra ?? {}),
  };
  if (level === 'error') console.error(JSON.stringify(line));
  else if (level === 'warn') console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

function describeError(error: unknown): string {
  if (error instanceof TrafficApiError) {
    const code = error.errorCode ? `${error.errorCode}: ` : '';
    return `${error.code}: ${code}${error.serviceMessage}`.slice(0, 512);
  }
  if (error instanceof Error) return error.message.slice(0, 512);
  return String(error).slice(0, 512);
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
 * One pull tick. Never throws: every failure is reported in the result and
 * logged, because this runs unattended on a timer.
 */
export async function runCreditPullOnce(deps: CreditPullDeps = {}): Promise<CreditPullResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const redeem: CreditRedeemFn = deps.redeem ?? redeemTrafficCode;
  const log = deps.log ?? defaultLog;
  const isGated = deps.isGated ?? (() => false);
  const onAttempt = deps.onAttempt ?? (() => {});
  const result: CreditPullResult = { applied: [], failed: [], blocked: [] };

  const config = readCreditPullConfig(env);
  if (!config) {
    result.skipped = `credit pull disabled: ${CONTROL_PLANE_URL_ENV} / IDBOTS_TENANT_ID / IDBOTS_GATEWAY_SECRET not all set`;
    return result;
  }

  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${config.gatewaySecret}`,
    'x-tenant-id': config.tenantId,
  };

  let pending: { credits?: PendingCreditGrant[]; blocked?: BlockedCreditGrant[] };
  try {
    const res = await requestJson(
      fetchImpl,
      `${config.controlPlaneUrl}/api/v1/tenant/credit/pending`,
      { method: 'GET', headers },
    );
    if (res.status !== 200) {
      result.skipped = `control plane answered ${res.status}`;
      log('warn', 'credit pull rejected by control plane', { status: res.status });
      return result;
    }
    pending = (res.body ?? {}) as { credits?: PendingCreditGrant[]; blocked?: BlockedCreditGrant[] };
  } catch (error) {
    result.skipped = `control plane unreachable: ${describeError(error)}`;
    log('warn', 'credit pull request failed', { error: describeError(error) });
    return result;
  }

  const credits = Array.isArray(pending.credits) ? pending.credits : [];
  const blocked = Array.isArray(pending.blocked) ? pending.blocked : [];
  result.blocked = blocked.map((row) => row.creditId);
  // Blocked rows are reported to the caller, not logged here: the loop logs
  // the set only when it changes (a code-less grant would otherwise warn every
  // five minutes forever).
  if (credits.length === 0) return result;

  for (const credit of credits) {
    if (!credit?.code || !Number.isInteger(credit.creditId)) continue;
    if (isGated(credit.creditId)) continue;
    try {
      const redeemed = await redeem(credit.code);
      const report = await requestJson(
        fetchImpl,
        `${config.controlPlaneUrl}/api/v1/tenant/credit/${credit.creditId}/apply-result`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            ok: true,
            evidence: {
              codeId: redeemed.codeId,
              trafficBytes: redeemed.trafficBytes,
              balanceAfter: redeemed.balanceAfter,
            },
          }),
        },
      );
      if (report.status !== 200) {
        // The bytes DID land upstream; only the ledger write failed. The row
        // stays pending, and the next tick re-redeems the same code — upstream
        // answers idempotently for the same account, so no double credit.
        throw new Error(`control plane rejected the apply report (${report.status})`);
      }
      result.applied.push(credit.creditId);
      onAttempt(credit.creditId, 'applied');
      log('info', 'credit applied', {
        creditId: credit.creditId,
        bytes: credit.bytes,
        redeemedBytes: redeemed.trafficBytes,
      });
    } catch (error) {
      const message = describeError(error);
      result.failed.push({ creditId: credit.creditId, error: message });
      onAttempt(credit.creditId, 'failed');
      log('warn', 'credit application failed (will retry)', {
        creditId: credit.creditId,
        bytes: credit.bytes,
        error: message,
      });
      try {
        await requestJson(
          fetchImpl,
          `${config.controlPlaneUrl}/api/v1/tenant/credit/${credit.creditId}/apply-result`,
          {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ ok: false, error: message }),
          },
        );
      } catch {
        // Best-effort: the failed tick is already logged locally.
      }
    }
  }
  return result;
}

export interface CreditPullLoopOptions extends CreditPullDeps {
  initialDelayMs?: number;
  intervalMs?: number;
  /** Clock override for retry-backoff tests. */
  now?: () => number;
}

export interface CreditPullLoop {
  stop(): void;
  /** Run one tick immediately (tests / manual trigger). */
  runNow(): Promise<CreditPullResult>;
}

/**
 * Start the unattended loop: one tick after `initialDelayMs`, then every
 * `intervalMs`. Ticks never overlap. Missing configuration is logged once and
 * then ignored (the loop keeps ticking so a later env fix needs no restart —
 * env does not change at runtime in practice, but the guard keeps it honest).
 */
export function startCreditPullLoop(options: CreditPullLoopOptions = {}): CreditPullLoop {
  const log = options.log ?? defaultLog;
  const initialDelayMs = options.initialDelayMs ?? CREDIT_PULL_INITIAL_DELAY_MS;
  const intervalMs = options.intervalMs ?? CREDIT_PULL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const retryState = new Map<number, RetryState>();

  let stopped = false;
  let running = false;
  let blockedSignature = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  if (!readCreditPullConfig(options.env ?? process.env)) {
    log('warn', 'credit pull loop disabled: control-plane URL or tenant credentials missing', {
      required: [CONTROL_PLANE_URL_ENV, 'IDBOTS_TENANT_ID', 'IDBOTS_GATEWAY_SECRET'],
    });
  }

  const tick = async (): Promise<CreditPullResult> => {
    if (stopped) return { applied: [], failed: [], blocked: [], skipped: 'stopped' };
    if (running) return { applied: [], failed: [], blocked: [], skipped: 'busy' };
    running = true;
    try {
      const result = await runCreditPullOnce({
        ...(options.env ? { env: options.env } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.redeem ? { redeem: options.redeem } : {}),
        log,
        isGated: (creditId) => (retryState.get(creditId)?.nextAttemptAt ?? 0) > now(),
        onAttempt: (creditId, outcome) => {
          if (outcome === 'applied') {
            retryState.delete(creditId);
            return;
          }
          const attempts = (retryState.get(creditId)?.attempts ?? 0) + 1;
          const delay = Math.min(CREDIT_RETRY_BASE_MS * 2 ** (attempts - 1), CREDIT_RETRY_MAX_MS);
          retryState.set(creditId, { attempts, nextAttemptAt: now() + delay });
        },
      });
      const signature = result.blocked.slice().sort((a, b) => a - b).join(',');
      if (signature && signature !== blockedSignature) {
        log('warn', 'credit grants awaiting an application code', { creditIds: result.blocked });
      }
      blockedSignature = signature;
      return result;
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      void tick().catch((error) => log('error', 'credit pull tick crashed', { error: String(error) }));
      interval = setInterval(() => {
        void tick().catch((error) => log('error', 'credit pull tick crashed', { error: String(error) }));
      }, intervalMs);
      interval.unref?.();
    }, initialDelayMs);
    timer.unref?.();
  };
  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      timer = null;
      interval = null;
    },
    runNow: () => tick(),
  };
}
