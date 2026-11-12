/**
 * JEV relay client for official IDBots-JEV (legacy storage id idbots-jev-free).
 *
 * assist-base-service proxies the TypeSafe JEV upstream and holds the real
 * upstream key server-side; the client authorizes with the same identity-bound
 * relay key (mrk_...) that serves chat, allowing the service to deduct ME
 * credits and emit the corresponding usage ledger entries. Direct TypeSafe
 * providers never use this module's request path. Backend contract
 * (assist-base-service《JEV 小脑模型中转接口.md》):
 * - cerebellum baseUrl = https://www.metaso.network/assist-open-api/v2/assist/llm/jev
 *   (POST {baseUrl}/v1/systemone and GET {baseUrl}/v1/models are verbatim
 *   TypeSafe-shaped relays of the client payload/catalog)
 * - 401 invalid_api_key -> re-bootstrap once and retry (bounded here to one
 *   re-bootstrap so a revoked key can never loop)
 * - usage is visible through the ME balance/history APIs and Credits & Traffic
 *
 * Credential resolution mirrors visionRelayService's proven chain: in-memory
 * cache -> jevRelay kv -> the provisioned metaid-free provider -> a fresh
 * identity-signed bootstrap (persisted for later runs). The service is
 * Electron-free (store/bootstrap injected) so plain node:test coverage works.
 */

import {
  CEREBELLUM_FREE_PROVIDER,
  resolveCerebellumConfig,
  type ResolvedCerebellumConfig,
} from '../libs/cerebellumConfig';
import type { SqliteStore } from '../sqliteStore';

/** kv keys for the cached JEV relay credentials (visionRelay-style). */
export const JEV_RELAY_API_KEY_KV = 'jevRelay.apiKey';
export const JEV_RELAY_BASE_URL_KV = 'jevRelay.baseUrl';

export interface JevRelayCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface JevRelayServiceDeps {
  getStore: () => SqliteStore | null;
  /** Identity-signed relay bootstrap (default: llmRelayService.bootstrapLlmRelay). */
  bootstrapImpl?: () => Promise<{ apiKey: string; baseUrl: string }>;
}

let depsRef: JevRelayServiceDeps | null = null;
let cachedCredentials: JevRelayCredentials | null = null;
/**
 * Shared in-flight bootstrap. A revoked relay key surfaces as 401 on EVERY
 * decision call site of one turn (memory rank, skill shortlist, block gate,
 * …) at once; without sharing, each site fired its OWN identity-signed
 * bootstrap (2026-10-15 first-sentence latency report: five parallel
 * bootstraps, each 15s+). One flight, everyone awaits it.
 */
let bootstrapInFlight: Promise<JevRelayCredentials> | null = null;

export function initJevRelayService(deps: JevRelayServiceDeps): void {
  depsRef = deps;
}

export function resetJevRelayServiceForTests(): void {
  depsRef = null;
  cachedCredentials = null;
  bootstrapInFlight = null;
  resetJevRelayCallStatsForTests();
}

function getDeps(): JevRelayServiceDeps {
  if (!depsRef) {
    throw new Error('JEV relay service not initialized');
  }
  return depsRef;
}

function readPersistedCredentials(): JevRelayCredentials | null {
  try {
    const store = depsRef?.getStore?.() ?? null;
    const apiKey = typeof store?.get(JEV_RELAY_API_KEY_KV) === 'string'
      ? (store.get(JEV_RELAY_API_KEY_KV) as string).trim()
      : '';
    const baseUrl = typeof store?.get(JEV_RELAY_BASE_URL_KV) === 'string'
      ? (store.get(JEV_RELAY_BASE_URL_KV) as string).trim()
      : '';
    if (apiKey && baseUrl) return { apiKey, baseUrl };
  } catch {
    // unreadable kv falls through to the next source
  }
  return null;
}

function readMetaIdFreeProviderCredentials(): JevRelayCredentials | null {
  try {
    const store = depsRef?.getStore?.() ?? null;
    const appConfig = store?.get('app_config') as
      | { providers?: Record<string, { apiKey?: unknown; baseUrl?: unknown } | undefined> }
      | null;
    const provider = appConfig?.providers?.['idbots'] ?? appConfig?.providers?.['metaid-free'];
    const apiKey = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : '';
    const baseUrl = typeof provider?.baseUrl === 'string' ? provider.baseUrl.trim() : '';
    if (apiKey && baseUrl) return { apiKey, baseUrl };
  } catch {
    // unreadable config falls through to bootstrap
  }
  return null;
}

function persistCredentials(credentials: JevRelayCredentials): void {
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (store && typeof (store as { set?: unknown }).set === 'function') {
      (store as Pick<SqliteStore, 'set'>).set(JEV_RELAY_API_KEY_KV, credentials.apiKey);
      (store as Pick<SqliteStore, 'set'>).set(JEV_RELAY_BASE_URL_KV, credentials.baseUrl);
    }
  } catch {
    // persistence loss is non-fatal: the in-memory cache still serves this run
  }
}

/**
 * Drop the JEV relay credentials everywhere this service caches them: the
 * in-memory copy AND the jevRelay kv rows. Used on a 401 (revoked key) and by
 * the identity-change closeout — after a user_identity import/create the
 * cached key still belongs to the previous identity, and clearing only one
 * tier would let the other resurrect it.
 */
export function invalidateJevRelayCredentials(): void {
  cachedCredentials = null;
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (store && typeof (store as { delete?: unknown }).delete === 'function') {
      (store as { delete: (key: string) => unknown }).delete(JEV_RELAY_API_KEY_KV);
      (store as { delete: (key: string) => unknown }).delete(JEV_RELAY_BASE_URL_KV);
    }
  } catch {
    // best-effort
  }
}

/**
 * Resolve the relay key (+ chat baseUrl) for JEV calls. Order: in-memory
 * cache, persisted jevRelay kv, the provisioned metaid-free provider, then a
 * fresh identity-signed bootstrap (persisted for later runs).
 */
export async function resolveJevRelayCredentials(): Promise<JevRelayCredentials> {
  if (cachedCredentials) return cachedCredentials;
  const persisted = readPersistedCredentials();
  if (persisted) {
    cachedCredentials = persisted;
    return persisted;
  }
  const fromProvider = readMetaIdFreeProviderCredentials();
  if (fromProvider) {
    cachedCredentials = fromProvider;
    persistCredentials(fromProvider);
    return fromProvider;
  }
  // One shared flight for concurrent resolvers (see bootstrapInFlight);
  // losers await the winner's result. A failed flight unshares in the
  // finally below so the next caller retries instead of latching the
  // rejection; a resolver that lost to an invalidated cache still returns
  // the freshest credentials any flight produced.
  if (!bootstrapInFlight) {
    bootstrapInFlight = (async () => {
      const bootstrap = getDeps().bootstrapImpl
        ? getDeps().bootstrapImpl!()
        : import('./llmRelayService').then((m) => m.bootstrapLlmRelay());
      const info = await bootstrap;
      const credentials = { apiKey: info.apiKey.trim(), baseUrl: info.baseUrl.trim() };
      if (!credentials.apiKey || !credentials.baseUrl) {
        throw new Error('JEV relay bootstrap returned no apiKey/baseUrl');
      }
      cachedCredentials = credentials;
      persistCredentials(credentials);
      return credentials;
    })().finally(() => {
      bootstrapInFlight = null;
    });
  }
  try {
    return await bootstrapInFlight;
  } catch (error) {
    if (cachedCredentials) return cachedCredentials;
    throw error;
  }
}

/**
 * Runtime cerebellum config for the main-process decision call sites. Wraps
 * the pure resolver: direct TypeSafe configs pass through untouched without
 * entering the ME-billed IDBots relay; IDBots-JEV gets its identity-bound
 * relay key injected from the credential chain (baseUrl and model are already
 * pinned by the resolver). Never throws — an official provider with no
 * obtainable key maps to null so the cerebellum silently stays off, exactly
 * like enabled=false.
 *
 * While the quota/credit breaker is open (a recent http_429_quota, see
 * noteJevRelayQuotaExhaustion) IDBots-JEV maps to null WITHOUT a key
 * resolution: the relay fails the spend in <50ms before touching the
 * upstream, but skipping the call entirely keeps per-turn logs clean and
 * avoids burning the 1.5s budget on a known-dead path. The breaker expires
 * on its own so a balance refill (or a server-side fix) self-heals.
 */
export async function resolveCerebellumRuntimeConfig(appConfig: unknown): Promise<ResolvedCerebellumConfig | null> {
  const config = resolveCerebellumConfig(appConfig);
  if (!config || config.provider !== CEREBELLUM_FREE_PROVIDER) {
    return config;
  }
  if (isJevRelayQuotaExhausted()) {
    return null;
  }
  try {
    const { apiKey } = await resolveJevRelayCredentials();
    if (!apiKey) {
      return null;
    }
    return { ...config, apiKey };
  } catch {
    // bootstrap failure (offline, relay down): feature off for this call
    return null;
  }
}

/**
 * fetch wrapper for IDBots-JEV cerebellum calls: on a 401 (revoked relay
 * key) it re-bootstraps ONCE and retries the same request with the fresh key.
 * Any failure (including a second 401) returns the last response unchanged —
 * the decision call sites keep their fail-to-null semantics, so no retry
 * storm is possible: at most 2 requests and 1 bootstrap per call.
 *
 * The caller's AbortSignal bounds the WHOLE wrapper, bootstrap included. The
 * decision call sites run 1.5s budgets; the identity-signed bootstrap has
 * been observed taking 15s+ and used to blow straight through that budget
 * (2026-10-15 first-sentence latency report: first chat turns stalled 15-25s
 * on volatile-block JEV calls whose deadline had already fired). On abort the
 * stale 401 returns immediately and the shared bootstrap keeps running in the
 * background — the next turn finds the fresh key cached.
 */
export function createJevRelayFetchWithKeyRetry<R extends { ok: boolean; status: number }>(
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<R>,
): (url: string, init: Record<string, unknown>) => Promise<R> {
  return async (url, init) => {
    const first = await fetchImpl(url, init);
    if (first.status !== 401) {
      return first;
    }
    const signal = (init as { signal?: AbortSignal | null }).signal ?? null;
    if (signal?.aborted) {
      return first;
    }
    try {
      invalidateJevRelayCredentials();
      const { apiKey } = await raceAbortSignal(resolveJevRelayCredentials(), signal);
      const headers = {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${apiKey}`,
      };
      return await fetchImpl(url, { ...init, headers });
    } catch {
      return first;
    }
  };
}

/** Resolve with `promise`, or reject with an AbortError the moment `signal`
 *  fires. The underlying promise is left running (callers use this to stop
 *  WAITING, not to cancel the work — shared bootstraps must complete so later
 *  callers find the cached result). Listener-safe on both paths. */
function raceAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | null,
  abortMessage = 'The JEV relay re-bootstrap was aborted',
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException(abortMessage, 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (fn: () => void) => {
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

/**
 * fetch wrapper that enforces the caller's AbortSignal IN OUR CODE instead of
 * trusting the underlying fetch to honor it. Empirically (2026-10-16
 * follow-up on session 70fa10aa): Electron's session.fetch rejects on abort
 * on a healthy network within ~1s, but when the connection stalls behind a
 * proxy/upstream (the IDBots relay hung five cerebellum calls for 17s) the
 * abort never surfaced — every 1s/1.5s call budget blew past its deadline and
 * the turn's first sentence waited out the upstream recovery. This wrapper
 * rejects the CALLER at the abort edge regardless; the abandoned socket is
 * left to settle on its own (the decision call sites are fail-to-null, so a
 * late response is simply dropped).
 *
 * The resolved response's json() read rides the same race (2026-10-16 second
 * round): a headers-fast/body-stalled response used to slip past the bounded
 * window, since only the headers await was covered. If the response object
 * rejects the shadow property (frozen/exotic), the body read stays unbounded
 * — no regression, just the old behavior.
 */
export function createSignalBoundedFetch<R>(
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<R>,
): (url: string, init: Record<string, unknown>) => Promise<R> {
  return (url, init) => {
    const signal = (init as { signal?: AbortSignal | null }).signal ?? null;
    if (!signal) return fetchImpl(url, init);
    if (signal.aborted) {
      return Promise.reject(new DOMException('The cerebellum call was aborted before dispatch', 'AbortError'));
    }
    return raceAbortSignal(
      fetchImpl(url, init),
      signal,
      'The cerebellum call was aborted while awaiting the upstream response',
    ).then((response) => {
      try {
        const jsonRead = (response as { json?: unknown } | null | undefined)?.json;
        if (typeof jsonRead === 'function') {
          const boundRead = jsonRead.bind(response) as () => Promise<unknown>;
          (response as { json: () => Promise<unknown> }).json = () =>
            raceAbortSignal(
              boundRead(),
              signal,
              'The cerebellum call was aborted while reading the response body',
            );
        }
      } catch {
        // Non-extensible response: body reads stay on the caller's own handling.
      }
      return response;
    }) as Promise<R>;
  };
}

// ---------------------------------------------------------------------------
// Result-code recording (2026-10-16 availability work)
//
// Every IDBots relay /v1/systemone call is classified into one result code,
// logged per call, and folded into a per-day aggregate that rides cowork.log
// (counts per code + latency P50/P90). This is the observation surface the
// post-fix triage depends on: ok rate, whether timeouts correlate with
// 401/500, and whether P90 stays high against the new server baseline
// (P50 217ms / P99 412ms / max 452ms).
// ---------------------------------------------------------------------------

/** One code per relay call; the union of HTTP outcome and thrown outcome. */
export type JevRelayCallResultCode =
  | 'ok'
  | 'timeout'
  | 'http_401'
  | 'http_429_quota'
  | 'http_429_rate'
  | 'http_4xx'
  | 'http_5xx'
  | 'network';

/**
 * Legacy error envelope code retained for compatibility with older relay
 * deployments. The CHAT pool's plain `free_quota_exhausted` is deliberately
 * NOT matched here, so a chat-pool 429 (wrong route) is http_429_rate.
 */
export const JEV_FREE_QUOTA_EXHAUSTED_CODE = 'jev_free_quota_exhausted';

/** Log sink shape shared by coworkLog (levels kept identical). */
export type JevRelayLogSink = (
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  tag: string,
  message: string,
  extra?: Record<string, unknown>,
) => void;

/**
 * Extract `error.code` from an OpenAI-style error envelope. Tolerates missing
 * or non-string codes; returns null for anything unparsable (the caller then
 * keeps the generic rate-limit classification).
 */
export function parseJevRelayErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !code.trim()) {
    return null;
  }
  return code.trim();
}

/** Cap for the logged 4xx `detail` excerpt (Pydantic arrays can be long). */
export const JEV_RELAY_ERROR_DETAIL_MAX_CHARS = 500;

/**
 * Extract the `detail` field of a 4xx error body for the result-code log.
 * The relay passes the upstream Pydantic validation errors through verbatim
 * on a 400 `upstream_bad_request`, and FastAPI shapes them as a detail ARRAY
 * — so the value is logged as-is when it is a string and JSON-serialized
 * otherwise, capped so one malformed bundle cannot flood cowork.log.
 */
export function extractJevRelayErrorDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const detail = (payload as { detail?: unknown }).detail;
  if (detail === undefined || detail === null) {
    return null;
  }
  const rendered = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (!rendered || !rendered.trim()) {
    return null;
  }
  return rendered.slice(0, JEV_RELAY_ERROR_DETAIL_MAX_CHARS);
}

/**
 * Classify an HTTP outcome. 429 splits by the envelope code (quota vs rate);
 * non-2xx/non-4xx/non-5xx statuses (a redirect or 1xx leaking out of the
 * net stack) fall to `network` — they are transport anomalies, not relay
 * verdicts.
 */
export function classifyJevRelayHttpStatus(status: number, errorCode?: string | null): JevRelayCallResultCode {
  if (status >= 200 && status < 300) {
    return 'ok';
  }
  if (status === 401) {
    return 'http_401';
  }
  if (status === 429) {
    return errorCode === JEV_FREE_QUOTA_EXHAUSTED_CODE ? 'http_429_quota' : 'http_429_rate';
  }
  if (status >= 400 && status < 500) {
    return 'http_4xx';
  }
  if (status >= 500 && status < 600) {
    return 'http_5xx';
  }
  return 'network';
}

/** Classify a thrown outcome: abort/timeout vs everything else. */
export function classifyJevRelayThrownError(error: unknown): JevRelayCallResultCode {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return 'timeout';
  }
  return 'network';
}

/**
 * How long a http_429_quota verdict keeps the IDBots relay cerebellum off.
 * The quota cycle resets weekly, but probing every few minutes is free (the
 * relay rejects in <50ms) and self-heals both a reset AND a misclassified 429
 * without an app restart.
 */
export const JEV_RELAY_QUOTA_BREAKER_MS = 5 * 60 * 1000;

let quotaExhaustedUntil = 0;

/** Opens the breaker; exposed for the recorder and future IPC surfacing. */
export function noteJevRelayQuotaExhaustion(nowMs: number = Date.now()): void {
  quotaExhaustedUntil = nowMs + JEV_RELAY_QUOTA_BREAKER_MS;
}

/** True while the breaker is open — the IDBots relay should be skipped. */
export function isJevRelayQuotaExhausted(nowMs: number = Date.now()): boolean {
  return nowMs < quotaExhaustedUntil;
}

/** Testing hook: close the breaker and clear the accumulators. */
export function resetJevRelayCallStatsForTests(): void {
  quotaExhaustedUntil = 0;
  activeDayStats = null;
  statsSink = null;
}

interface JevRelayDayAccumulator {
  counts: Partial<Record<JevRelayCallResultCode, number>>;
  latencies: number[];
}

let activeDayStats: { dayKey: string; acc: JevRelayDayAccumulator } | null = null;
let statsSink: JevRelayLogSink | null = null;

/**
 * Bind the sink that per-call lines and the daily aggregate ride on (in the
 * app: coworkLog, so everything lands in cowork.log). Call once at startup;
 * recorders created without their own sink fall back to this one.
 */
export function setJevRelayCallStatsSink(sink: JevRelayLogSink): void {
  statsSink = sink;
}

function localDayKey(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function percentileNearestRank(latencies: number[], share: number): number | null {
  if (latencies.length === 0) {
    return null;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((share * sorted.length) / 100)));
  return Math.round(sorted[rank - 1]);
}

function emitJevRelayDailyLine(day: { dayKey: string; acc: JevRelayDayAccumulator }, sink: JevRelayLogSink): void {
  const calls = day.acc.latencies.length;
  if (calls === 0) {
    return;
  }
  const counts: Record<string, number> = {};
  for (const [code, count] of Object.entries(day.acc.counts)) {
    if (count) {
      counts[code] = count;
    }
  }
  sink('INFO', 'jevRelay:daily', 'JEV relay daily result-code report', {
    date: day.dayKey,
    calls,
    okRate: Number(((day.acc.counts.ok ?? 0) / calls).toFixed(4)),
    counts,
    p50Ms: percentileNearestRank(day.acc.latencies, 50),
    p90Ms: percentileNearestRank(day.acc.latencies, 90),
  });
}

/**
 * Fold one classified outcome into the active day. The first call of a NEW
 * local day emits the previous day's aggregate line first, so exactly one
 * report per day lands in the log. Breaker maintenance rides along: quota
 * 429s open it, ok calls close it.
 */
function recordJevRelayCallResult(
  code: JevRelayCallResultCode,
  latencyMs: number,
  sink: JevRelayLogSink,
  nowMs: number,
): void {
  const dayKey = localDayKey(nowMs);
  if (!activeDayStats || activeDayStats.dayKey !== dayKey) {
    if (activeDayStats) {
      emitJevRelayDailyLine(activeDayStats, sink);
    }
    activeDayStats = { dayKey, acc: { counts: {}, latencies: [] } };
  }
  activeDayStats.acc.counts[code] = (activeDayStats.acc.counts[code] ?? 0) + 1;
  activeDayStats.acc.latencies.push(Math.max(0, Math.round(latencyMs)));
  if (code === 'http_429_quota') {
    noteJevRelayQuotaExhaustion(nowMs);
  } else if (code === 'ok') {
    quotaExhaustedUntil = 0;
  }
}

/**
 * Emit the active day's aggregate now (app quit) and clear it, so the last
 * partial day of a session is not lost waiting for a rollover that never
 * comes. Safe to call with nothing accumulated.
 */
export function flushJevRelayCallStats(sink: JevRelayLogSink | null = statsSink): void {
  if (!sink || !activeDayStats) {
    return;
  }
  emitJevRelayDailyLine(activeDayStats, sink);
  activeDayStats = null;
}

/**
 * Result-code recorder for IDBots relay calls. Wraps the key-retry wrapper
 * (order: raw fetch -> key retry -> recorder) so ONE recorder entry covers
 * the whole logical call, bootstrap retry included: a first-401-then-200
 * sequence records `ok`, and the recorded latency includes the re-bootstrap.
 *
 * 4xx responses' BODY matters downstream of classification. A 429 reads the
 * JSON once to split quota vs rate; every OTHER 4xx (the relay's 400
 * `upstream_bad_request` passes the upstream Pydantic validation errors
 * through verbatim — the 2026-10-19 empty-criteria 422 regression was only
 * diagnosable from that body) reads it once to log the envelope code and the
 * `detail` excerpt on the per-call line. Both hand callers a reconstructed
 * response whose json() replays the SAME parsed body — no call site can
 * consume the stream twice; 2xx/5xx responses pass through untouched.
 * Thrown errors are classified, recorded, and re-thrown so the decision call
 * sites keep their catch-to-null paths (an AbortError classifies as
 * `timeout`).
 */
export function createJevRelayCallRecorder<R extends { ok: boolean; status: number; json: () => Promise<unknown> }>(
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<R>,
  options?: { sink?: JevRelayLogSink; now?: () => number },
): (url: string, init: Record<string, unknown>) => Promise<R> {
  const sink: JevRelayLogSink = options?.sink ?? statsSink ?? (() => {});
  const now: () => number = options?.now ?? Date.now;
  return async (url, init) => {
    const startedAt = now();
    let response: R;
    try {
      response = await fetchImpl(url, init);
      if (response.status === 429) {
        let parsed: unknown = null;
        let parsedOk = false;
        try {
          parsed = await response.json();
          parsedOk = true;
        } catch {
          // Non-JSON 429 body: rate-limit classification stands.
        }
        const errorCode = parsedOk ? parseJevRelayErrorCode(parsed) : null;
        const result = classifyJevRelayHttpStatus(response.status, errorCode);
        const latencyMs = now() - startedAt;
        recordJevRelayCallResult(result, latencyMs, sink, now());
        sink('INFO', 'jevRelay:call', 'JEV relay call finished', {
          endpoint: url.endsWith('/v1/systemone') ? '/v1/systemone' : url.endsWith('/v1/models') ? '/v1/models' : url,
          result,
          status: response.status,
          errorCode,
          latencyMs,
        });
        if (parsedOk) {
          const body = parsed;
          return { ok: response.ok, status: response.status, json: async () => body } as unknown as R;
        }
        return response;
      }
      if (response.status >= 400 && response.status < 500) {
        // A non-429 4xx verdict: read the JSON body ONCE, log the envelope
        // code + the `detail` excerpt (the relay forwards the upstream
        // Pydantic validation info on a 400 upstream_bad_request), and hand
        // callers the same reconstructed replay-the-body response the 429
        // path established. A non-JSON body keeps the generic classification.
        let parsed: unknown = null;
        let parsedOk = false;
        try {
          parsed = await response.json();
          parsedOk = true;
        } catch {
          // Non-JSON 4xx body: the generic classification stands.
        }
        const errorCode = parsedOk ? parseJevRelayErrorCode(parsed) : null;
        const detail = parsedOk ? extractJevRelayErrorDetail(parsed) : null;
        const result = classifyJevRelayHttpStatus(response.status, errorCode);
        const latencyMs = now() - startedAt;
        recordJevRelayCallResult(result, latencyMs, sink, now());
        sink('INFO', 'jevRelay:call', 'JEV relay call finished', {
          endpoint: url.endsWith('/v1/systemone') ? '/v1/systemone' : url.endsWith('/v1/models') ? '/v1/models' : url,
          result,
          status: response.status,
          errorCode,
          detail,
          latencyMs,
        });
        if (parsedOk) {
          const body = parsed;
          return { ok: response.ok, status: response.status, json: async () => body } as unknown as R;
        }
        return response;
      }
      const result = classifyJevRelayHttpStatus(response.status);
      const latencyMs = now() - startedAt;
      recordJevRelayCallResult(result, latencyMs, sink, now());
      sink('INFO', 'jevRelay:call', 'JEV relay call finished', {
        endpoint: url.endsWith('/v1/systemone') ? '/v1/systemone' : url.endsWith('/v1/models') ? '/v1/models' : url,
        result,
        status: response.status,
        latencyMs,
      });
      return response;
    } catch (error) {
      const result = classifyJevRelayThrownError(error);
      const latencyMs = now() - startedAt;
      recordJevRelayCallResult(result, latencyMs, sink, now());
      sink('INFO', 'jevRelay:call', 'JEV relay call finished', {
        endpoint: url.endsWith('/v1/systemone') ? '/v1/systemone' : url.endsWith('/v1/models') ? '/v1/models' : url,
        result,
        status: null,
        latencyMs,
      });
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// IPC surface (renderer: cerebellum IDBots-JEV connection test / key fill)
// ---------------------------------------------------------------------------

type RegisterIpcHandlerFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

export function registerJevRelayIpcHandlers(deps: { registerIpcHandler: RegisterIpcHandlerFn }): void {
  const { registerIpcHandler } = deps;
  registerIpcHandler('jevRelay:resolveCredentials', async () => {
    try {
      return { success: true, credentials: await resolveJevRelayCredentials() };
    } catch (error) {
      return { success: false, error: error instanceof Error && error.message ? error.message : String(error) };
    }
  });
}
