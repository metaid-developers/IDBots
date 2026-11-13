/**
 * JEV relay service unit tests.
 *
 * Covers the IDBots-JEV credential chain (in-memory cache -> jevRelay kv
 * -> metaid-free provider -> identity bootstrap), the runtime cerebellum
 * config injection (direct TypeSafe / official ME relay key / silent off),
 * the one-shot 401 re-bootstrap retry wrapper, and the result-code layer
 * (classification, the recording fetch wrapper, the quota breaker, and the
 * per-day aggregate lines). All externals (store/bootstrap) are injected; no
 * network, no DB, no Electron.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

const service = require('../dist-electron/main/services/jevRelayService.js');
const {
  initJevRelayService,
  invalidateJevRelayCredentials,
  resetJevRelayServiceForTests,
  resolveJevRelayCredentials,
  resolveCerebellumRuntimeConfig,
  createJevRelayFetchWithKeyRetry,
  createSignalBoundedFetch,
  parseJevRelayErrorCode,
  extractJevRelayErrorDetail,
  classifyJevRelayHttpStatus,
  classifyJevRelayThrownError,
  createJevRelayCallRecorder,
  isJevRelayQuotaExhausted,
  getJevRelayQuotaStatus,
  noteJevRelayQuotaExhaustion,
  flushJevRelayCallStats,
  JEV_RELAY_QUOTA_BREAKER_MS,
  JEV_FREE_QUOTA_EXHAUSTED_CODE,
  JEV_RELAY_ERROR_DETAIL_MAX_CHARS,
  JEV_RELAY_API_KEY_KV,
  JEV_RELAY_BASE_URL_KV,
} = service;

const CHAT_BASE = 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1';
const FREE_CEREBELLUM_CONFIG = {
  cerebellum: {
    enabled: true,
    provider: 'idbots-jev-free',
    apiKey: '',
    baseUrl: '',
    model: '',
  },
};

function makeStore(kv = new Map(), appConfig = null) {
  return {
    get: (key) => {
      if (key === 'app_config') return appConfig;
      return kv.has(key) ? kv.get(key) : null;
    },
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
  };
}

function setupDeps(overrides = {}) {
  const calls = { bootstrap: 0 };
  const deps = {
    getStore: () => overrides.store ?? makeStore(),
    bootstrapImpl: overrides.bootstrapImpl ?? (async () => {
      calls.bootstrap += 1;
      if (overrides.bootstrapError) {
        throw new Error(overrides.bootstrapError);
      }
      return { apiKey: `mrk_boot${calls.bootstrap}`, baseUrl: CHAT_BASE };
    }),
  };
  initJevRelayService(deps);
  return calls;
}

beforeEach(() => {
  resetJevRelayServiceForTests();
});

// ---------------------------------------------------------------------------
// Credential chain
// ---------------------------------------------------------------------------

test('resolveJevRelayCredentials: jevRelay kv wins without bootstrapping', async () => {
  const calls = setupDeps({
    store: makeStore(new Map([
      [JEV_RELAY_API_KEY_KV, 'mrk_kv'],
      [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
    ])),
  });
  const credentials = await resolveJevRelayCredentials();
  assert.deepEqual(credentials, { apiKey: 'mrk_kv', baseUrl: CHAT_BASE });
  assert.equal(calls.bootstrap, 0);
});

test('resolveJevRelayCredentials: metaid-free provider is used and persisted to kv', async () => {
  const kv = new Map();
  const calls = setupDeps({
    store: makeStore(kv, {
      providers: {
        'metaid-free': { apiKey: 'mrk_provider', baseUrl: CHAT_BASE },
      },
    }),
  });
  const credentials = await resolveJevRelayCredentials();
  assert.deepEqual(credentials, { apiKey: 'mrk_provider', baseUrl: CHAT_BASE });
  assert.equal(calls.bootstrap, 0);
  assert.equal(kv.get(JEV_RELAY_API_KEY_KV), 'mrk_provider');
  assert.equal(kv.get(JEV_RELAY_BASE_URL_KV), CHAT_BASE);
});

test('resolveJevRelayCredentials: bootstrap is the last resort and persists', async () => {
  const kv = new Map();
  const calls = setupDeps({ store: makeStore(kv) });
  const credentials = await resolveJevRelayCredentials();
  assert.equal(credentials.apiKey, 'mrk_boot1');
  assert.equal(calls.bootstrap, 1);
  assert.equal(kv.get(JEV_RELAY_API_KEY_KV), 'mrk_boot1');
  // Subsequent resolutions ride the in-memory cache: no extra bootstrap.
  await resolveJevRelayCredentials();
  assert.equal(calls.bootstrap, 1);
});

// ---------------------------------------------------------------------------
// Runtime cerebellum config
// ---------------------------------------------------------------------------

test('resolveCerebellumRuntimeConfig: direct TypeSafe bypasses the ME-billed IDBots relay', async () => {
  const calls = setupDeps({ store: makeStore() });
  const config = await resolveCerebellumRuntimeConfig({
    cerebellum: {
      enabled: true,
      provider: 'typesafe-jev',
      apiKey: 'sk-direct',
      baseUrl: 'https://api.typesafe.ai',
      model: 'jev-preview',
    },
  });
  assert.deepEqual(config, {
    provider: 'typesafe-jev',
    apiKey: 'sk-direct',
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-preview',
  });
  assert.equal(calls.bootstrap, 0, 'direct TypeSafe must not resolve IDBots relay credentials or enter its ME billing path');
});

test('resolveCerebellumRuntimeConfig: IDBots-JEV gets the identity-bound ME relay key injected', async () => {
  const calls = setupDeps({
    store: makeStore(new Map([
      [JEV_RELAY_API_KEY_KV, 'mrk_live'],
      [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
    ])),
  });
  const config = await resolveCerebellumRuntimeConfig(FREE_CEREBELLUM_CONFIG);
  assert.deepEqual(config, {
    provider: 'idbots-jev-free',
    apiKey: 'mrk_live',
    baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/jev',
    model: 'jev-latest',
  });
  assert.equal(calls.bootstrap, 0);
});

test('resolveCerebellumRuntimeConfig: free provider without credentials maps to null (silent off)', async () => {
  setupDeps({ store: makeStore(), bootstrapError: 'offline' });
  assert.equal(await resolveCerebellumRuntimeConfig(FREE_CEREBELLUM_CONFIG), null);
});

test('resolveCerebellumRuntimeConfig: disabled cerebellum maps to null without a bootstrap', async () => {
  const calls = setupDeps({ store: makeStore() });
  assert.equal(await resolveCerebellumRuntimeConfig({ cerebellum: { enabled: false, provider: 'idbots-jev-free' } }), null);
  assert.equal(calls.bootstrap, 0);
});

// ---------------------------------------------------------------------------
// 401 re-bootstrap retry wrapper
// ---------------------------------------------------------------------------

function makeResponse(status) {
  return { ok: status >= 200 && status < 300, status };
}

test('createJevRelayFetchWithKeyRetry: non-401 responses pass through with one request', async () => {
  setupDeps({
    store: makeStore(new Map([
      [JEV_RELAY_API_KEY_KV, 'mrk_live'],
      [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
    ])),
  });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push({ url, init });
    return makeResponse(200);
  });
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_live' },
  });
  assert.equal(response.status, 200);
  assert.equal(fetches.length, 1);
});

test('createJevRelayFetchWithKeyRetry: 401 re-bootstraps once and retries with the fresh key', async () => {
  const kv = new Map([
    [JEV_RELAY_API_KEY_KV, 'mrk_revoked'],
    [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
  ]);
  const calls = setupDeps({ store: makeStore(kv) });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push({ url, init });
    // First call rides the revoked key; the retry (mrk_boot1) succeeds.
    return makeResponse(init.headers.Authorization === 'Bearer mrk_boot1' ? 200 : 401);
  });
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_revoked', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(fetches.length, 2);
  assert.equal(calls.bootstrap, 1);
  assert.equal(fetches[1].init.headers.Authorization, 'Bearer mrk_boot1');
  assert.equal(fetches[1].init.headers['Content-Type'], 'application/json');
  assert.equal(fetches[1].init.body, '{}');
  // The stale kv entry was replaced by the fresh bootstrap key.
  assert.equal(kv.get(JEV_RELAY_API_KEY_KV), 'mrk_boot1');
});

test('createJevRelayFetchWithKeyRetry: a second 401 is returned as-is (no retry storm)', async () => {
  const kv = new Map([
    [JEV_RELAY_API_KEY_KV, 'mrk_revoked'],
    [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
  ]);
  const calls = setupDeps({ store: makeStore(kv) });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push(init);
    return makeResponse(401);
  });
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_revoked' },
  });
  assert.equal(response.status, 401);
  assert.equal(fetches.length, 2);
  assert.equal(calls.bootstrap, 1);
});

test('createJevRelayFetchWithKeyRetry: bootstrap failure during retry returns the original 401', async () => {
  setupDeps({ store: makeStore(), bootstrapError: 'offline' });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push(init);
    return makeResponse(401);
  });
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_dead' },
  });
  assert.equal(response.status, 401);
  assert.equal(fetches.length, 1);
});

// ---------------------------------------------------------------------------
// First-sentence latency (2026-10-15): the caller's AbortSignal must bound
// the whole wrapper, re-bootstrap included. The decision call sites run 1.5s
// budgets; an identity-signed bootstrap took 15s+ and used to blow through
// the deadline because nothing raced the signal on that path.
// ---------------------------------------------------------------------------

test('createJevRelayFetchWithKeyRetry: already-aborted signal skips the re-bootstrap entirely', async () => {
  const calls = setupDeps({ store: makeStore() });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push(init);
    return makeResponse(401);
  });
  const controller = new AbortController();
  controller.abort();
  const response = await wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_revoked' },
    signal: controller.signal,
  });
  assert.equal(response.status, 401);
  assert.equal(fetches.length, 1);
  assert.equal(calls.bootstrap, 0);
});

test('createJevRelayFetchWithKeyRetry: a signal firing mid-bootstrap returns the 401 promptly and the shared bootstrap still lands', async () => {
  let releaseBootstrap;
  const bootstrapGate = new Promise((resolve) => { releaseBootstrap = resolve; });
  const calls = setupDeps({
    store: makeStore(),
    bootstrapImpl: async () => {
      calls.bootstrap += 1;
      await bootstrapGate;
      return { apiKey: 'mrk_boot1', baseUrl: CHAT_BASE };
    },
  });
  const fetches = [];
  const wrapped = createJevRelayFetchWithKeyRetry(async (url, init) => {
    fetches.push(init);
    return makeResponse(401);
  });
  const controller = new AbortController();
  const pending = wrapped('https://relay.example/v1/systemone', {
    method: 'POST',
    headers: { Authorization: 'Bearer mrk_revoked' },
    signal: controller.signal,
  });
  // Abort while the bootstrap is still in flight: the wrapper must settle
  // with the original 401 instead of waiting the bootstrap out.
  setTimeout(() => controller.abort(), 10);
  const settledAt = Date.now();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.ok(Date.now() - settledAt < 5000, 'wrapper settles shortly after the abort, not after the bootstrap');
  assert.equal(fetches.length, 1);
  // The shared bootstrap keeps running and caches the fresh key for the
  // NEXT turn — no second bootstrap, no lost credentials.
  releaseBootstrap();
  const credentials = await resolveJevRelayCredentials();
  assert.equal(credentials.apiKey, 'mrk_boot1');
  assert.equal(calls.bootstrap, 1);
});

test('resolveJevRelayCredentials: concurrent cold resolves share one bootstrap flight', async () => {
  const calls = setupDeps({ store: makeStore() });
  const [a, b, c] = await Promise.all([
    resolveJevRelayCredentials(),
    resolveJevRelayCredentials(),
    resolveJevRelayCredentials(),
  ]);
  assert.equal(a.apiKey, 'mrk_boot1');
  assert.equal(b.apiKey, 'mrk_boot1');
  assert.equal(c.apiKey, 'mrk_boot1');
  assert.equal(calls.bootstrap, 1);
});

test('resolveJevRelayCredentials: a failed bootstrap flight does not latch — the next call retries', async () => {
  let failFirst = true;
  const calls = setupDeps({
    store: makeStore(),
    bootstrapImpl: async () => {
      calls.bootstrap += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error('relay unreachable');
      }
      return { apiKey: 'mrk_boot2', baseUrl: CHAT_BASE };
    },
  });
  await assert.rejects(() => resolveJevRelayCredentials(), /relay unreachable/);
  const credentials = await resolveJevRelayCredentials();
  assert.equal(credentials.apiKey, 'mrk_boot2');
  assert.equal(calls.bootstrap, 2);
});

// ---------------------------------------------------------------------------
// createSignalBoundedFetch (2026-10-16 follow-up): enforce the caller's
// AbortSignal in OUR code. Electron's session.fetch rejected on abort within
// ~1s on a healthy network, but a stalled proxy/upstream (session 70fa10aa,
// five cerebellum calls hung 17s past their deadlines) never surfaced the
// abort. The wrapper must reject the caller at the abort edge regardless.
// ---------------------------------------------------------------------------

test('createSignalBoundedFetch: rejects promptly when the underlying fetch hangs past the abort', async () => {
  setupDeps({ store: makeStore() });
  let resolveFetch;
  const never = new Promise(() => {}); // never settles by itself
  const bounded = createSignalBoundedFetch(async () => {
    resolveFetch = () => {}; // record that the fetch was dispatched
    return never;
  });
  const controller = new AbortController();
  const pending = bounded('https://relay.example/v1/systemone', {
    method: 'POST',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const startedAt = Date.now();
  await assert.rejects(() => pending, (error) => error?.name === 'AbortError');
  assert.ok(Date.now() - startedAt < 2000, 'rejection lands at the abort edge, not when the upstream recovers');
  void resolveFetch;
});

test('createSignalBoundedFetch: an already-aborted signal rejects before dispatching', async () => {
  setupDeps({ store: makeStore() });
  let dispatched = 0;
  const bounded = createSignalBoundedFetch(async () => {
    dispatched += 1;
    return makeResponse(200);
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => bounded('https://relay.example/v1/systemone', { method: 'POST', signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(dispatched, 0);
});

test('createSignalBoundedFetch: a fetch that settles before the abort passes through untouched', async () => {
  setupDeps({ store: makeStore() });
  const bounded = createSignalBoundedFetch(async () => makeResponse(200));
  const controller = new AbortController();
  const response = await bounded('https://relay.example/v1/systemone', {
    method: 'POST',
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  controller.abort();
});

test('createSignalBoundedFetch: no signal means plain passthrough', async () => {
  setupDeps({ store: makeStore() });
  const bounded = createSignalBoundedFetch(async () => makeResponse(200));
  const response = await bounded('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(response.status, 200);
});

// ---------------------------------------------------------------------------
// Result-code classification (2026-10-16 availability work)
// ---------------------------------------------------------------------------

test('parseJevRelayErrorCode: extracts OpenAI and ABS errorCode envelopes, tolerates junk', () => {
  assert.equal(parseJevRelayErrorCode({ error: { code: 'jev_free_quota_exhausted' } }), 'jev_free_quota_exhausted');
  assert.equal(parseJevRelayErrorCode({ code: 1, data: { errorCode: 'ME_INSUFFICIENT' } }), 'ME_INSUFFICIENT');
  assert.equal(parseJevRelayErrorCode({ errorCode: 'me_insufficient' }), 'me_insufficient');
  assert.equal(parseJevRelayErrorCode({ error: { code: '  spaced  ' } }), 'spaced');
  assert.equal(parseJevRelayErrorCode({ error: { message: 'no code' } }), null);
  assert.equal(parseJevRelayErrorCode({ error: null }), null);
  assert.equal(parseJevRelayErrorCode('not an object'), null);
  assert.equal(parseJevRelayErrorCode(null), null);
});

test('classifyJevRelayHttpStatus: full status table including 402 and ME quota 429 split', () => {
  assert.equal(classifyJevRelayHttpStatus(200), 'ok');
  assert.equal(classifyJevRelayHttpStatus(204), 'ok');
  assert.equal(classifyJevRelayHttpStatus(401), 'http_401');
  assert.equal(classifyJevRelayHttpStatus(402), 'http_429_quota');
  assert.equal(classifyJevRelayHttpStatus(402, 'ME_INSUFFICIENT'), 'http_429_quota');
  // The 429 split: JEV/ME credit exhaustion codes map to quota; the chat pool
  // code and unknown envelopes stay rate-limited.
  assert.equal(classifyJevRelayHttpStatus(429, 'jev_free_quota_exhausted'), 'http_429_quota');
  assert.equal(classifyJevRelayHttpStatus(429, 'jev_quota_exhausted'), 'http_429_quota');
  assert.equal(classifyJevRelayHttpStatus(429, 'me_insufficient'), 'http_429_quota');
  assert.equal(classifyJevRelayHttpStatus(429, 'ME_INSUFFICIENT'), 'http_429_quota');
  assert.equal(classifyJevRelayHttpStatus(429, 'insufficient_me'), 'http_429_quota');
  assert.equal(classifyJevRelayHttpStatus(429, 'free_quota_exhausted'), 'http_429_rate');
  assert.equal(classifyJevRelayHttpStatus(429, null), 'http_429_rate');
  assert.equal(classifyJevRelayHttpStatus(404), 'http_4xx');
  assert.equal(classifyJevRelayHttpStatus(451), 'http_4xx');
  assert.equal(classifyJevRelayHttpStatus(500), 'http_5xx');
  assert.equal(classifyJevRelayHttpStatus(503), 'http_5xx');
  // A redirect/1xx leaking out of the net stack is a transport anomaly.
  assert.equal(classifyJevRelayHttpStatus(302), 'network');
});

test('classifyJevRelayThrownError: aborts are timeouts, everything else is network', () => {
  assert.equal(classifyJevRelayThrownError(new DOMException('aborted', 'AbortError')), 'timeout');
  assert.equal(classifyJevRelayThrownError(new DOMException('timed out', 'TimeoutError')), 'timeout');
  assert.equal(classifyJevRelayThrownError(new Error('socket hang up')), 'network');
  assert.equal(classifyJevRelayThrownError(undefined), 'network');
});

test('extractJevRelayErrorDetail: strings ride as-is, FastAPI arrays serialize, junk returns null', () => {
  assert.equal(extractJevRelayErrorDetail({ detail: 'Dictionary should have at least 1 item' }),
    'Dictionary should have at least 1 item');
  const pydantic = [{ loc: ['questions', 'best_service'], msg: 'Dictionary should have at least 1 item' }];
  assert.equal(extractJevRelayErrorDetail({ detail: pydantic }), JSON.stringify(pydantic));
  assert.equal(extractJevRelayErrorDetail({ detail: { nested: true } }), '{"nested":true}');
  assert.equal(extractJevRelayErrorDetail({ detail: '' }), null);
  assert.equal(extractJevRelayErrorDetail({ detail: '   ' }), null);
  assert.equal(extractJevRelayErrorDetail({ error: { code: 'no-detail-here' } }), null);
  assert.equal(extractJevRelayErrorDetail('plain string body'), null);
  assert.equal(extractJevRelayErrorDetail(null), null);
});

test('extractJevRelayErrorDetail: the excerpt is capped so one body cannot flood cowork.log', () => {
  const huge = 'x'.repeat(JEV_RELAY_ERROR_DETAIL_MAX_CHARS + 5000);
  const detail = extractJevRelayErrorDetail({ detail: huge });
  assert.equal(detail.length, JEV_RELAY_ERROR_DETAIL_MAX_CHARS);
});

// ---------------------------------------------------------------------------
// Recording wrapper: per-call lines, 429 body replay, breaker maintenance
// ---------------------------------------------------------------------------

function captureSink() {
  const lines = [];
  const sink = (level, tag, message, extra) => lines.push({ level, tag, message, extra });
  return { lines, sink };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('createJevRelayCallRecorder: ok responses pass through unchanged and log their code', async () => {
  const { lines, sink } = captureSink();
  const inner = async () => jsonResponse(200, { answers: {} });
  const recorded = createJevRelayCallRecorder(inner, { sink });
  const response = await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answers: {} });
  const callLines = lines.filter((line) => line.tag === 'jevRelay:call');
  assert.equal(callLines.length, 1);
  assert.equal(callLines[0].extra.result, 'ok');
  assert.equal(callLines[0].extra.endpoint, '/v1/systemone');
});

test('createJevRelayCallRecorder: a quota 429 classifies via the envelope and opens the breaker', async () => {
  const { lines, sink } = captureSink();
  const inner = async () => jsonResponse(429, { error: { code: 'jev_free_quota_exhausted' } });
  const recorded = createJevRelayCallRecorder(inner, { sink });
  const response = await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(response.status, 429);
  assert.equal(isJevRelayQuotaExhausted(), true);
  const callLine = lines.find((line) => line.tag === 'jevRelay:call');
  assert.equal(callLine.extra.result, 'http_429_quota');
  assert.equal(callLine.extra.errorCode, 'jev_free_quota_exhausted');
  // The reconstructed response still replays the parsed error envelope.
  assert.deepEqual(await response.json(), { error: { code: 'jev_free_quota_exhausted' } });
});

test('createJevRelayCallRecorder: a rate 429 (chat-pool code) does NOT open the breaker', async () => {
  const { sink } = captureSink();
  const inner = async () => jsonResponse(429, { error: { code: 'free_quota_exhausted' } });
  const recorded = createJevRelayCallRecorder(inner, { sink });
  await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(isJevRelayQuotaExhausted(), false);
});

test('createJevRelayCallRecorder: HTTP 402 or 429 ME_INSUFFICIENT opens the quota breaker', async () => {
  const { lines, sink } = captureSink();
  const recorded402 = createJevRelayCallRecorder(
    async () => jsonResponse(402, { code: 1, data: { errorCode: 'ME_INSUFFICIENT' } }),
    { sink },
  );
  const res402 = await recorded402('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(res402.status, 402);
  assert.equal(isJevRelayQuotaExhausted(), true);
  assert.equal(lines.find((line) => line.tag === 'jevRelay:call')?.extra.result, 'http_429_quota');
});

test('createJevRelayCallRecorder: a 400 upstream_bad_request logs the envelope code and the Pydantic detail', async () => {
  // The relay passes the upstream validation errors through verbatim — the
  // empty-criteria 422 regression was only diagnosable from this body.
  const { lines, sink } = captureSink();
  const detail = [{
    loc: ['questions', 'best_service', 'choice', 'criteria'],
    msg: 'Dictionary should have at least 1 item',
    type: 'min_length',
  }];
  const inner = async () => jsonResponse(400, { error: { code: 'upstream_bad_request' }, detail });
  const recorded = createJevRelayCallRecorder(inner, { sink });
  const response = await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(response.status, 400);
  const callLine = lines.find((line) => line.tag === 'jevRelay:call');
  assert.equal(callLine.extra.result, 'http_4xx');
  assert.equal(callLine.extra.errorCode, 'upstream_bad_request');
  assert.equal(callLine.extra.detail, JSON.stringify(detail));
  assert.ok(callLine.extra.detail.includes('Dictionary should have at least 1 item'));
  // The reconstructed response still replays the parsed body (no double read).
  assert.deepEqual(await response.json(), { error: { code: 'upstream_bad_request' }, detail });
  assert.equal(isJevRelayQuotaExhausted(), false, 'plain 4xx never touches the quota breaker');
});

test('createJevRelayCallRecorder: a 422 string detail rides the call line untouched', async () => {
  const { lines, sink } = captureSink();
  const inner = async () => jsonResponse(422, { detail: 'Dictionary should have at least 1 item' });
  const recorded = createJevRelayCallRecorder(inner, { sink });
  const response = await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(response.status, 422);
  const callLine = lines.find((line) => line.tag === 'jevRelay:call');
  assert.equal(callLine.extra.result, 'http_4xx');
  assert.equal(callLine.extra.errorCode, null, 'no envelope code on a bare FastAPI body');
  assert.equal(callLine.extra.detail, 'Dictionary should have at least 1 item');
  assert.deepEqual(await response.json(), { detail: 'Dictionary should have at least 1 item' });
});

test('createJevRelayCallRecorder: a non-JSON 4xx body keeps the generic classification and passes through', async () => {
  const { lines, sink } = captureSink();
  const inner = async () => ({ ok: false, status: 400, json: async () => { throw new SyntaxError('not json'); } });
  const recorded = createJevRelayCallRecorder(inner, { sink });
  const response = await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(response.status, 400);
  const callLine = lines.find((line) => line.tag === 'jevRelay:call');
  assert.equal(callLine.extra.result, 'http_4xx');
  assert.equal(callLine.extra.errorCode, null);
  assert.equal(callLine.extra.detail, null);
});

test('createJevRelayCallRecorder: an ok call closes an open breaker', async () => {
  noteJevRelayQuotaExhaustion();
  assert.equal(isJevRelayQuotaExhausted(), true);
  const { sink } = captureSink();
  const recorded = createJevRelayCallRecorder(async () => jsonResponse(200, {}), { sink });
  await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  assert.equal(isJevRelayQuotaExhausted(), false);
});

test('createJevRelayCallRecorder: thrown aborts are re-thrown and recorded as timeout', async () => {
  const { lines, sink } = captureSink();
  const inner = async () => {
    throw new DOMException('The operation was aborted', 'AbortError');
  };
  const recorded = createJevRelayCallRecorder(inner, { sink });
  await assert.rejects(() => recorded('https://relay.example/v1/systemone', { method: 'POST' }), /aborted/i);
  const callLine = lines.find((line) => line.tag === 'jevRelay:call');
  assert.equal(callLine.extra.result, 'timeout');
  assert.equal(callLine.extra.status, null);
});

test('quota breaker: expires after the backoff window without an app restart', () => {
  noteJevRelayQuotaExhaustion(Date.now() - JEV_RELAY_QUOTA_BREAKER_MS - 1);
  assert.equal(isJevRelayQuotaExhausted(), false);
});

test('resolveCerebellumRuntimeConfig: an open breaker silently disables the free relay', async () => {
  setupDeps({
    store: makeStore(new Map([
      [JEV_RELAY_API_KEY_KV, 'mrk_live'],
      [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
    ])),
  });
  noteJevRelayQuotaExhaustion();
  assert.equal(await resolveCerebellumRuntimeConfig(FREE_CEREBELLUM_CONFIG), null);
});

// ---------------------------------------------------------------------------
// Daily aggregate lines
// ---------------------------------------------------------------------------

test('flushJevRelayCallStats: emits one aggregate line with per-code counts and latency percentiles', async () => {
  const { lines, sink } = captureSink();
  const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  let index = 0;
  const inner = async () => {
    const status = index === 0 ? 500 : index === 1 ? 429 : 200;
    const body = index === 1 ? { error: { code: 'rate_limited' } } : {};
    index += 1;
    return jsonResponse(status, body);
  };
  const recorded = createJevRelayCallRecorder(inner, {
    sink,
    now: () => 1000 + latencies[Math.min(index, latencies.length - 1)],
  });
  // Drive 10 calls; the injected clock also fixes every latency deterministically.
  for (let call = 0; call < 10; call += 1) {
    await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  }
  flushJevRelayCallStats(sink);
  const daily = lines.find((line) => line.tag === 'jevRelay:daily');
  assert.ok(daily, 'the daily aggregate line exists');
  assert.equal(daily.extra.calls, 10);
  assert.equal(daily.extra.counts.ok, 8);
  assert.equal(daily.extra.counts.http_5xx, 1);
  assert.equal(daily.extra.counts.http_429_rate, 1);
  assert.equal(daily.extra.okRate, 0.8);
  assert.ok(daily.extra.p50Ms > 0 && daily.extra.p90Ms >= daily.extra.p50Ms, 'percentiles are ordered and present');
});

test('daily rollover: the first call of a new local day emits the previous day line', async () => {
  const { lines, sink } = captureSink();
  // A fixed base timestamp mid-day, so +24h deterministically crosses midnight.
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  let clock = base.getTime();
  const recorded = createJevRelayCallRecorder(
    async () => jsonResponse(200, {}),
    { sink, now: () => clock },
  );
  await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  clock += 24 * 60 * 60 * 1000;
  await recorded('https://relay.example/v1/systemone', { method: 'POST' });
  const dailyLines = lines.filter((line) => line.tag === 'jevRelay:daily');
  assert.equal(dailyLines.length, 1, 'crossing midnight emits exactly the previous day line');
  assert.equal(dailyLines[0].extra.calls, 1);
  assert.equal(dailyLines[0].extra.counts.ok, 1);
});

// ---------------------------------------------------------------------------
// Identity-change closeout hooks (2026-10 identity-split incident)
// ---------------------------------------------------------------------------

test('invalidateJevRelayCredentials drops the in-memory copy AND the kv rows', async () => {
  const kv = new Map([
    [JEV_RELAY_API_KEY_KV, 'mrk_identityB'],
    [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
  ]);
  const calls = setupDeps({ store: makeStore(kv) });
  assert.deepEqual(await resolveJevRelayCredentials(), { apiKey: 'mrk_identityB', baseUrl: CHAT_BASE });
  invalidateJevRelayCredentials();
  assert.equal(kv.has(JEV_RELAY_API_KEY_KV), false);
  assert.equal(kv.has(JEV_RELAY_BASE_URL_KV), false);
  // Memory is gone too: the next resolution falls through to bootstrap.
  const next = await resolveJevRelayCredentials();
  assert.equal(next.apiKey, 'mrk_boot1');
  assert.equal(calls.bootstrap, 1);
});

test('after an identity change the resolver adopts the re-issued provider key, never the previous identity key', async () => {
  // Incident shape: kv + memory hold identity B's key while the closeout has
  // just rewritten the provider entry with identity A's key.
  const kv = new Map([
    [JEV_RELAY_API_KEY_KV, 'mrk_identityB'],
    [JEV_RELAY_BASE_URL_KV, CHAT_BASE],
  ]);
  const appConfig = { providers: { 'metaid-free': { apiKey: 'mrk_identityB', baseUrl: CHAT_BASE } } };
  const calls = setupDeps({ store: makeStore(kv, appConfig) });
  assert.equal((await resolveJevRelayCredentials()).apiKey, 'mrk_identityB');

  invalidateJevRelayCredentials();
  appConfig.providers['metaid-free'].apiKey = 'mrk_identityA';

  const credentials = await resolveJevRelayCredentials();
  assert.equal(credentials.apiKey, 'mrk_identityA', 'the B key must not survive in any tier');
  assert.equal(kv.get(JEV_RELAY_API_KEY_KV), 'mrk_identityA', 're-persisted from the provider entry');
  assert.equal(calls.bootstrap, 0, 'no bootstrap needed: the provider entry already carries the new key');
  const runtime = await resolveCerebellumRuntimeConfig(FREE_CEREBELLUM_CONFIG);
  assert.equal(runtime.apiKey, 'mrk_identityA');
});

test('getJevRelayQuotaStatus reports breaker exhaustion and emits WARN log once per window', () => {
  const { lines, sink } = captureSink();
  service.setJevRelayCallStatsSink(sink);
  const now = 1_700_000_000_000;
  assert.deepEqual(getJevRelayQuotaStatus(now), { exhausted: false, retryAfterMs: 0 });
  noteJevRelayQuotaExhaustion(now);
  noteJevRelayQuotaExhaustion(now + 1000);
  const status = getJevRelayQuotaStatus(now + 1000);
  assert.equal(status.exhausted, true);
  assert.equal(status.retryAfterMs, JEV_RELAY_QUOTA_BREAKER_MS);
  assert.equal(getJevRelayQuotaStatus(now + 2000).retryAfterMs, JEV_RELAY_QUOTA_BREAKER_MS - 1000);
  const warnLines = lines.filter((line) => line.tag === 'jevRelay:quota' && line.level === 'WARN');
  assert.equal(warnLines.length, 1);
});
