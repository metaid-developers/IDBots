// H-80 addendum (b225a203 follow-up): tests for libs/dreamRetryPolicy.ts and
// the scheduler-side terminal/cap semantics in libs/dreamPrompt.ts.
//
// Provenance: the original tests/dreamRetryPolicy.test.mjs from the H-80 fix
// was lost in a worktree cleanup (untracked file swallowed by the repo-wide
// tests/* ignore) before it could be committed. This file is a faithful
// rewrite from the H-80 report spec: real-sample 400·1210 classification,
// non-regression for 429/408/5xx/network/parse, primary-route-first composite
// errors, service-level 400 terminal-on-first-attempt, and retry-cap
// degradation.
//
// Imports target the dist-electron build (compiled by test:dream-retry's
// compile:electron step), matching tests/dreamPrompt.test.mjs convention.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyDreamError,
  DREAM_RETRY_MAX_ATTEMPTS,
  computeDreamBackoffDelayMs,
  DREAM_ATTEMPT_TIMEOUT_TIERS_MS,
  DREAM_BACKOFF_RATE_LIMIT_FLOOR_MS,
  DREAM_MIN_CALL_WINDOW_MS,
  DREAM_RUN_BUDGET_MS,
  DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS,
  isRateLimitError,
  isTimeoutError,
  isTransientDreamLlmError,
  remainingRunBudgetMs,
  resolveDreamAttemptTimeoutMs,
} = await import(
  '../dist-electron/main/libs/dreamRetryPolicy.js'
);
const { computeDueDreamDates, computeDreamRetryDelayMs } = await import(
  '../dist-electron/main/libs/dreamPrompt.js'
);

// ---- 2026-10-08 dream-consolidation-timeout fix: adaptive timeout tiers ----

test('resolveDreamAttemptTimeoutMs: 10/20/38-minute tiers by attempt count', () => {
  const [t1, t2, t3] = DREAM_ATTEMPT_TIMEOUT_TIERS_MS;
  assert.equal(t1, 600_000);
  assert.equal(t2, 1_200_000);
  assert.equal(t3, 2_280_000);
  assert.equal(resolveDreamAttemptTimeoutMs(1), t1);
  assert.equal(resolveDreamAttemptTimeoutMs(2), t2);
  assert.equal(resolveDreamAttemptTimeoutMs(3), t3);
  assert.equal(resolveDreamAttemptTimeoutMs(5), t3, 'attempts past the ladder clamp at the top tier');
  assert.equal(resolveDreamAttemptTimeoutMs(0), t1, 'garbage attempt counts normalize to the first tier');
  assert.equal(resolveDreamAttemptTimeoutMs(NaN), t1);
});

test('remainingRunBudgetMs: run wall burns down from DREAM_RUN_BUDGET_MS', () => {
  assert.equal(DREAM_RUN_BUDGET_MS, 30 * 60_000);
  assert.equal(DREAM_MIN_CALL_WINDOW_MS, 600_000);
  const start = 1_000_000;
  assert.equal(remainingRunBudgetMs(start, start), DREAM_RUN_BUDGET_MS);
  assert.equal(remainingRunBudgetMs(start, start + 10 * 60_000), 20 * 60_000);
  assert.equal(remainingRunBudgetMs(start, start + DREAM_RUN_BUDGET_MS + 5_000), -5_000);
});

test('isTimeoutError: the shared abort text and TimeoutError name land in the timeout class', () => {
  assert.equal(isTimeoutError('The operation was aborted due to timeout'), true);
  assert.equal(isTimeoutError(new Error('dream run budget exhausted before synthesis window (remaining 0s, attempt 1)')), true);
  const timeoutDom = new Error('The operation was aborted due to timeout');
  timeoutDom.name = 'TimeoutError';
  assert.equal(isTimeoutError(timeoutDom), true);
  assert.equal(isTimeoutError('LLM request failed: 500 upstream exploded'), false);
  assert.equal(isTimeoutError('LLM request failed: 400 1210: 该模型始终思考'), false);
});

test('isRateLimitError: 429 passthrough and rate-limit prose, nothing else', () => {
  assert.equal(isRateLimitError('LLM request failed: 429 rate limited, retry after 60s'), true);
  assert.equal(isRateLimitError('provider sent: Rate limit exceeded for today'), true);
  assert.equal(isRateLimitError('LLM request failed: 500 gateway timeout (429 retries hinted in body 1429ms)'), false,
    'bare numbers must not read as statuses');
});

test('computeDreamBackoffDelayMs: 2/5/15-minute ladder with ≥10-min escalation', () => {
  const min = (n) => n * 60_000;
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 1 }), min(2));
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 2 }), min(5));
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 3 }), min(15));
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 7 }), min(15), 'ladder caps at the top tier');
  assert.equal(DREAM_BACKOFF_RATE_LIMIT_FLOOR_MS, min(10));
  // 429 / rate-limit: every tier stretches to ≥10 minutes.
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 1, rateLimited: true }), min(10));
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 2, rateLimited: true }), min(10));
  // Consecutive timeouts (≥2) escalate too; one timeout does not.
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 2, consecutiveTimeouts: 2 }), min(10));
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 3, consecutiveTimeouts: 4 }), min(15));
  assert.equal(computeDreamBackoffDelayMs({ attemptCount: 1, consecutiveTimeouts: 1 }), min(2));
});

test('scheduler: a failed timeout row waits ≥10 minutes before its next window', () => {
  const now = new Date(2026, 9, 8, 3, 0);
  const min = (n) => n * 60 * 1000;
  const failedAt = (error, startedAt) =>
    new Map([['2026-10-07', { status: 'failed', attemptCount: 2, startedAt, dreamVersion: 1, error }]]);
  const due = (states) =>
    computeDueDreamDates({ now, metabotId: 1, runStates: states }).dueDates.includes('2026-10-07');
  // Two consecutive timeouts → backoff = 10 min; 8-min-old failure still waits.
  assert.equal(due(failedAt('The operation was aborted due to timeout', now.getTime() - min(8))), false);
  assert.equal(due(failedAt('The operation was aborted due to timeout', now.getTime() - min(11))), true);
  // A 429 row is floored at ≥10 minutes regardless of its ladder tier.
  assert.equal(due(failedAt('LLM request failed: 429 rate limited', now.getTime() - min(5))), false);
  // A plain 500 keeps the short 5-min tier: due again after 6 minutes.
  assert.equal(due(failedAt('LLM request failed: 500 upstream hiccup', now.getTime() - min(6))), true);
});

// cognitiveChatCompletion throws `LLM request failed: <status> <body>`; the
// passthrough status is anchored to that prefix. Body numbers like zhipu's
// error id `1210:` must never read as statuses, and llmFallback's combined
// error keeps the primary message first — the first match is the primary
// route's status.

test('real sample: glm 400 passthrough with JSON envelope (1210 always-thinking) is terminal', () => {
  const error =
    'LLM request failed: 400 {"error":{"code":"1210","message":"该模型始终思考，不支持关闭思考"}}';
  assert.equal(classifyDreamError(error), 'terminal');
});

test('real sample: glm 400 passthrough with plain-text envelope (1210: …) is terminal', () => {
  const error = 'LLM request failed: 400 1210: 该模型始终思考，不支持关闭思考';
  assert.equal(classifyDreamError(error), 'terminal');
});

test('body error id 1210 must not masquerade as the passthrough status', () => {
  // Primary route answered 500; the 1210 id sits in the body and must not be
  // scanned as a status — the run stays in the retryable class.
  const error = 'LLM request failed: 500 {"error":{"code":"1210","message":"server hiccup"}}';
  assert.equal(classifyDreamError(error), 'retryable');
});

test('digit-boundary trap: 400/401/403 embedded in larger numbers are not statuses', () => {
  // No `LLM request failed:` anchor at all; bare 400/…4401x in prose must
  // not trigger the 4xx/401/403 rules.
  const error = 'cache kept 400 rows; token budget 34001 exceeded after 1400ms; hint 4401x';
  assert.equal(classifyDreamError(error), 'retryable');
});

test('non-regression: 429 stays retryable', () => {
  assert.equal(classifyDreamError('LLM request failed: 429 rate limited, retry after 60s'), 'retryable');
});

test('non-regression: 408 stays retryable', () => {
  assert.equal(classifyDreamError('LLM request failed: 408 upstream read timeout'), 'retryable');
});

test('non-regression: 5xx family stays retryable', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(
      classifyDreamError(`LLM request failed: ${status} upstream temporarily unavailable`),
      'retryable',
      `HTTP ${status} must remain retryable`,
    );
  }
});

test('non-regression: network errors stay retryable', () => {
  assert.equal(classifyDreamError(new Error('fetch failed')), 'retryable');
  assert.equal(classifyDreamError('request to https://open.bigmodel.cn failed: ECONNRESET'), 'retryable');
});

test('non-regression: parse errors and unknown errors stay retryable', () => {
  assert.equal(classifyDreamError('Unexpected token < in JSON at position 0'), 'retryable');
  assert.equal(classifyDreamError(undefined), 'retryable');
});

test('composite error: primary route 400 wins over fallback 5xx', () => {
  // llmFallback combines route messages with the primary first.
  const combined = [
    'LLM request failed: 400 {"error":{"code":"1210"}}',
    'LLM request failed: 503 fallback route unavailable',
  ].join('\n');
  assert.equal(classifyDreamError(combined), 'terminal');
});

test('composite error: primary route 5xx wins over fallback 400', () => {
  // Mirrored case: the later fallback 400 must not flip a primary-5xx run
  // into the terminal class.
  const combined = [
    'LLM request failed: 503 primary route unavailable',
    'LLM request failed: 400 {"error":{"code":"1210"}}',
  ].join('\n');
  assert.equal(classifyDreamError(combined), 'retryable');
});

test('service-level 400 is terminal on the first attempt; retry budget exists only for the retryable class', () => {
  assert.equal(classifyDreamError('LLM request failed: 400 invalid model parameter'), 'terminal');
  assert.equal(DREAM_RETRY_MAX_ATTEMPTS, 5);
});

test('scheduler: terminal-failed dates never queue again (one attempt and out)', () => {
  const runStates = new Map([
    ['2026-08-06', { status: 'terminal-failed', attemptCount: 1, startedAt: Date.now(), dreamVersion: 1 }],
  ]);
  const { dueDates } = computeDueDreamDates({ now: new Date(2026, 7, 8, 12, 0), metabotId: 1, runStates });
  assert.equal(dueDates.includes('2026-08-06'), false, 'terminal-failed must be invisible to the scheduler');
});

test('cap degradation: legacy failed rows stop at DREAM_RETRY_MAX_ATTEMPTS, below-cap rows keep bounded backoff', () => {
  const now = new Date(2026, 7, 8, 12, 0);
  const minutes = (n) => n * 60 * 1000;
  // 2026-10-08 backoff-ladder fix: attempt 4 → 15 min (top tier of the
  // 2/5/15 ladder), was 30min * 2^3 = 4h under the old 30-min base.
  assert.equal(computeDreamRetryDelayMs(4), minutes(15));

  const failedAt = (attemptCount, startedAt) =>
    new Map([['2026-08-06', { status: 'failed', attemptCount, startedAt, dreamVersion: 1 }]]);
  const due = (states) =>
    computeDueDreamDates({ now, metabotId: 1, runStates: states }).dueDates.includes('2026-08-06');

  // Below cap, backoff elapsed → still queues (bounded retry intact).
  assert.equal(due(failedAt(4, now.getTime() - minutes(20))), true);
  // Below cap, backoff not elapsed → waits for retryAt.
  assert.equal(due(failedAt(4, now.getTime() - minutes(5))), false);
  // At cap → degraded instead of retrying forever.
  assert.equal(due(failedAt(DREAM_RETRY_MAX_ATTEMPTS, now.getTime() - minutes(48))), false);
  // Above cap (pre-H-80 row that burned extra attempts) → degraded too.
  assert.equal(due(failedAt(DREAM_RETRY_MAX_ATTEMPTS + 3, now.getTime() - minutes(96))), false);
});

// In-run transient retry (2026-09-29): which failures the dream call layer
// re-drives immediately (primary→fallback pair, bounded rounds) instead of
// failing the run into the 30-minute scheduled backoff.

test('in-run transient retry: the 2026-09-28 real failure signature qualifies', () => {
  // Verbatim shape of the error that killed the 45-minute nightly run at its
  // 54th fragment: proxy-wrapped TLS flap on the primary, timeout on the
  // fallback, combined by llmFallback.
  const real = "LLM request failed: 502 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"net::ERR_SSL_PROTOCOL_ERROR\"}} (fallback 'glm-5.3-flash@custom-provider' also failed: The operation was aborted due to timeout)";
  assert.equal(isTransientDreamLlmError(real), true);
  assert.equal(classifyDreamError(real), 'retryable', 'must stay in the run-level retryable class too');
});

test('in-run transient retry: transport and gateway signatures qualify', () => {
  assert.equal(isTransientDreamLlmError('LLM request failed: 502 Bad Gateway'), true);
  assert.equal(isTransientDreamLlmError('LLM request failed: 503 Service Unavailable'), true);
  assert.equal(isTransientDreamLlmError('LLM request failed: 504 Gateway Timeout'), true);
  assert.equal(isTransientDreamLlmError('LLM request failed: 408 upstream read timeout'), true);
  assert.equal(isTransientDreamLlmError('LLM request failed: 429 concurrency limit, retry soon'), true);
  assert.equal(isTransientDreamLlmError(new Error('fetch failed')), true);
  assert.equal(isTransientDreamLlmError('request to https://open.bigmodel.cn failed: ECONNRESET'), true);
  assert.equal(isTransientDreamLlmError('net::ERR_CONNECTION_CLOSED'), true);
  assert.equal(isTransientDreamLlmError('The operation was aborted due to timeout'), true);
  assert.equal(isTransientDreamLlmError('LLM returned empty content'), true);
  assert.equal(isTransientDreamLlmError('socket hang up'), true);
});

test('in-run transient retry: terminal and non-transport errors never qualify', () => {
  // Deterministic rejections: re-driving the same prompt can never help.
  assert.equal(isTransientDreamLlmError('LLM request failed: 400 {"error":{"code":"1210","message":"该模型始终思考"}}'), false);
  assert.equal(isTransientDreamLlmError('LLM request failed: 401 invalid api key'), false);
  assert.equal(isTransientDreamLlmError('LLM request failed: 403 forbidden'), false);
  assert.equal(isTransientDreamLlmError('LLM request failed: 429 free_quota_exhausted'), false, 'terminal quota class wins over the 429 gateway pattern');
  // 500s are often request-specific rejections misreported by relays — the
  // proxy makes the same call; the run-level backoff owns them.
  assert.equal(isTransientDreamLlmError('LLM request failed: 500 internal error'), false);
  // Parse failures belong to generateAndParse's own retry, not this loop.
  assert.equal(isTransientDreamLlmError('dream output unparseable after retry: no json object found'), false);
  assert.equal(isTransientDreamLlmError(undefined), false);
});

test('in-run transient retry budget: two bounded re-drives', () => {
  assert.deepEqual([...DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS], [10_000, 30_000]);
});
