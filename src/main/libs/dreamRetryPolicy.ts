/**
 * Retry policy for dream runs (H-80).
 *
 * Dream scheduling used to treat every failure as transient: the failed-run
 * branch only looked at startedAt + exponential backoff, so a deterministic
 * provider rejection — e.g. glm-5.3-flash's `400 … 1210: 该模型始终思考，不
 * 支持关闭思考` passed through the Anthropic-compatible route — was retried
 * forever at the 6h-capped backoff with no terminal state and nothing the
 * owner could see. classifyDreamError sorts errors into terminal (never
 * retry) vs retryable (bounded backoff), and DREAM_RETRY_MAX_ATTEMPTS
 * degrades dates whose retry budget is exhausted instead of retrying forever.
 */

export type DreamErrorKind = 'terminal' | 'retryable';

/** Total scheduled attempts (original + retries) before a retryable failure
 * stops auto-retrying: the run is marked terminal-failed and only a manual
 * dream run can revive the date. */
export const DREAM_RETRY_MAX_ATTEMPTS = 5;

/** 4xx statuses that are transient by nature and stay in the retry class. */
const RETRYABLE_4XX_STATUSES = new Set([408, 429]);

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error == null) return '';
  return String(error);
};

// cognitiveChatCompletion throws `LLM request failed: <status> <body>` on
// every provider route (Anthropic, OpenAI-compatible, DeepSeek Responses), so
// the passthrough status is anchored to that prefix — body numbers like the
// zhipu error id `1210:` must not read as statuses. llmFallback's combined
// error keeps the primary message first, so the first match is the primary
// route's status.
const LLM_STATUS_PATTERN = /llm request failed:\s*(\d{3})/;

// Deterministic provider rejections without a passthrough status (quota,
// auth, parameter shape) — mirrors privateChatSkillTurnPolicy's list.
const TERMINAL_ERROR_PATTERNS = [
  'invalid_request_error',
  'invalid_api_key',
  'authentication_error',
  'model_not_found',
  'unauthorized',
  'free_quota_exhausted',
  'insufficient_quota',
  '"code":"quota"',
  "'code':'quota'",
  // 2026-10-08 stale-binding rung ④: the dream ladder's all-rungs-dead
  // wrapper means "no usable model is configured" (override→primary→fallback
  // all dead). A raw 429 embedded in the preserved original text must not
  // reclassify this as retryable — retrying a configuration hole is the
  // avalanche shape.
  '未配置任何可用的模型',
];

const boundaryCode = (status: number): RegExp => new RegExp(`(?:^|[^0-9])${status}(?:[^0-9]|$)`);

export const classifyDreamError = (error: unknown): DreamErrorKind => {
  const text = toErrorText(error).toLowerCase();
  if (TERMINAL_ERROR_PATTERNS.some((pattern) => text.includes(pattern))) {
    return 'terminal';
  }
  if (boundaryCode(401).test(text) || boundaryCode(403).test(text)) {
    return 'terminal';
  }
  const statusMatch = LLM_STATUS_PATTERN.exec(text);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status >= 400 && status < 500 && !RETRYABLE_4XX_STATUSES.has(status)) {
      return 'terminal';
    }
  }
  return 'retryable';
};

/**
 * In-run transient retry (2026-09-29): which LLM failures are worth an
 * IMMEDIATE re-drive of the primary→fallback pair inside one dream run,
 * instead of failing the run and waiting for the 30-minute scheduled backoff.
 *
 * Motivation: the 2026-09-28 nightly dream survived 53 fragments on the
 * primary brain, then one sub-second TLS flap (net::ERR_SSL_PROTOCOL_ERROR
 * through the local system proxy) failed the 54th call on BOTH brains and
 * killed the 45-minute run — the run-level retry never fired because the
 * serial queue was busy and the app shut down first. Sub-minute transport
 * flaps must be absorbed at the call layer; the run-level backoff remains for
 * genuine outages.
 *
 * The gate is deliberately narrower than classifyDreamError's 'retryable':
 * only transport/gateway signatures that plausibly clear within seconds.
 * Excluded on purpose:
 *  - 500s (often request-specific rejections misreported by relays — the proxy
 *    makes the same call for its own retries);
 *  - every other 4xx (deterministic; classifyDreamError already terminals
 *    them);
 *  - parse failures (generateAndParse owns that retry).
 */
const TRANSIENT_TRANSPORT_ERROR_PATTERNS: RegExp[] = [
  // Gateway/proxy statuses: 408 read timeout, 429 concurrency flap, 502/503/504
  // bad-gateway family. Anchored to the cognitiveChatCompletion prefix so a
  // body error id can never masquerade as a status (same rule as above).
  /llm request failed:\s*(?:408|429|502|503|504)\b/,
  // Chromium net codes surfaced through the cowork proxy's 502 body, or bare.
  /net::err_[a-z0-9_]+/,
  // undici/Electron fetch transport failures (connection refused, reset, DNS).
  /fetch failed/,
  /\b(?:etimedout|econnreset|econnrefused|econnaborted|epipe|eai_again|enetunreach|ehostunreach)\b/,
  /socket hang up/,
  // Per-attempt timeout aborts (dream calls carry no external cancel signal,
  // so an abort can only be the attempt window expiring on a stalled network).
  /operation was aborted/,
  // A 200 with an empty body from a flapping gateway; throwOnEmptyContent
  // turns it into this error after both brains returned nothing.
  /llm returned empty content/,
];

/**
 * Whether a failed dream LLM call is worth an immediate in-run re-drive.
 * Terminal-classified errors (4xx rejections, quota, auth) never qualify.
 */
export const isTransientDreamLlmError = (error: unknown): boolean => {
  if (classifyDreamError(error) !== 'retryable') return false;
  const text = toErrorText(error).toLowerCase();
  return TRANSIENT_TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
};

/**
 * Delays before each in-run transient re-drive. Each re-drive gets the full
 * primary→fallback pair with fresh per-attempt timeouts, so two extra rounds
 * mean a fragment call survives up to 6 brain attempts over ~40s before the
 * run is allowed to fail. Sized for sub-minute proxy node flaps; genuine
 * outages still escalate to the run-level backoff unchanged.
 */
export const DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000];
