/**
 * LLM fetch resilience regression — 2026-09-25 00:09-03:27 outage (G2 red
 * seat, 12+ consecutive llm_unavailable, three hours with zero diagnosable
 * cause).
 *
 * Root-cause findings locked by this suite:
 *  - Every failure in that window was a fetch-layer death ("fetch failed")
 *    BEFORE any HTTP response arrived — the real transport error sat in
 *    err.cause and was never logged. Now every wire-style POST logs the full
 *    cause chain (fetchLlmPost / logFetchFailureCause).
 *  - A mid-flight connection reset (keep-alive race onto a peer-dropped
 *    socket) failed the attempt with no retry. fetchLlmPost now retries
 *    exactly once on retryable cause codes (undici evicts the poisoned
 *    socket, so the retry runs on a fresh connection) and never retries
 *    ECONNREFUSED / abort / timeout.
 *  - The OpenAI-compat proxy's post-listen server errors left a dead
 *    listening socket while proxyPort kept advertising it; the error handler
 *    now resets state and restarts (source-contract assertion).
 *
 * Red baseline: on an unpatched tree dist-electron/main/services/llmFetch.js
 * does not exist — the stale-dist guard turns that into an explicit red with
 * a rebuild hint instead of a confusing module-not-found.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

const DIST_LLM_FETCH_JS = path.join(projectRoot, 'dist-electron', 'main', 'services', 'llmFetch.js');
(function assertFreshLlmFetchDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_LLM_FETCH_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_LLM_FETCH_JS} 不存在：本套件锁定 2026-09-25 G2 连败的 fetch 韧性修复（llmFetch.ts）。先编译 electron 主进程（npm run compile:electron）再跑本套件。`);
  }
  for (const marker of ['fetchLlmPost', 'connectionFailureCauseCode', 'logFetchFailureCause']) {
    assert.ok(src.includes(marker), `[stale-dist-guard] ${DIST_LLM_FETCH_JS} 缺少修复特征 ${marker}：dist 是旧产物，先 npm run compile:electron`);
  }
})();

/* ---------------- source-contract assertions ---------------- */

const SRC_CHAT = fs.readFileSync(path.join(projectRoot, 'src/main/services/cognitiveChatCompletion.ts'), 'utf8');
const SRC_LLMFETCH = fs.readFileSync(path.join(projectRoot, 'src/main/services/llmFetch.ts'), 'utf8');
const SRC_PROXY = fs.readFileSync(path.join(projectRoot, 'src/main/libs/coworkOpenAICompatProxy.ts'), 'utf8');

test('contract: all three wire styles post through fetchLlmPost with their kind tag', () => {
  assert.equal((SRC_CHAT.match(/fetchLlmPost\(\s*'anthropic'/g) ?? []).length, 1, 'anthropic wire must call fetchLlmPost exactly once');
  assert.equal((SRC_CHAT.match(/fetchLlmPost\(\s*'openai-compat'/g) ?? []).length, 1, 'openai-compat wire must call fetchLlmPost exactly once');
  assert.equal((SRC_CHAT.match(/fetchLlmPost\(\s*'deepseek-responses'/g) ?? []).length, 1, 'deepseek-responses wire must call fetchLlmPost exactly once');
  assert.ok(!SRC_CHAT.includes('await fetch(url, { method:'), 'bare fetch calls must be replaced by fetchLlmPost in cognitiveChatCompletion');
});

test('contract: retryable cause codes exclude ECONNREFUSED (dead endpoint fails fast into fallback brain)', () => {
  const setBody = SRC_LLMFETCH.split('CONNECTION_RETRYABLE_CAUSE_CODES = new Set([')[1]?.split(']);')[0] ?? '';
  assert.ok(setBody.includes("'ECONNRESET'"), 'ECONNRESET must be retryable (keep-alive race)');
  assert.ok(setBody.includes("'UND_ERR_SOCKET'"), 'UND_ERR_SOCKET must be retryable');
  assert.ok(!setBody.includes('ECONNREFUSED'), 'ECONNREFUSED must NOT be retried');
});

test('contract: cause-chain logging exists and is wired on both first attempt and retry', () => {
  assert.ok(SRC_LLMFETCH.includes('causes='), 'log line must carry the cause chain');
  const uses = SRC_LLMFETCH.split('logFetchFailureCause(').length - 1;
  assert.ok(uses >= 3, `log helper must be defined plus invoked for first attempt and retry (found ${uses})`);
});

test('contract: proxy error handler resets post-listen state and restarts', () => {
  assert.ok(SRC_PROXY.includes('server error after listen'), 'post-listen error must be distinguished from bind failure');
  assert.ok(SRC_PROXY.includes('proxyServer = null'), 'post-listen error must clear proxyServer so resolves fail explicitly');
  assert.ok(SRC_PROXY.includes('proxyPort = null'), 'post-listen error must clear proxyPort (dead baseURL)');
});

/* ---------------- behavior tests (compiled llmFetch, zero electron deps) ---------------- */

const { fetchLlmPost, connectionFailureCauseCode } = require(DIST_LLM_FETCH_JS);

/** TypeError mimicking undici's "fetch failed" with a transport cause. */
function fetchFailed(causeCode) {
  const err = new TypeError('fetch failed');
  if (causeCode) err.cause = Object.assign(new Error(`cause ${causeCode}`), { code: causeCode });
  return err;
}

function okResponse(body) {
  return { ok: true, status: 200, text: async () => body };
}

/** Swap globalThis.fetch for a scripted mock; returns {calls, restore}. */
function mockFetch(script) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error('mock script exhausted');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('behavior: connectionFailureCauseCode classifies undici failures', () => {
  assert.equal(connectionFailureCauseCode(fetchFailed('ECONNRESET')), 'ECONNRESET');
  assert.equal(connectionFailureCauseCode(fetchFailed('UND_ERR_SOCKET')), 'UND_ERR_SOCKET');
  assert.equal(connectionFailureCauseCode(fetchFailed('ECONNREFUSED')), null, 'dead endpoint is not retryable');
  assert.equal(connectionFailureCauseCode(fetchFailed(null)), null, 'no cause = not classified');
  const abort = new Error('The operation was aborted due to timeout');
  abort.name = 'TimeoutError';
  assert.equal(connectionFailureCauseCode(abort), null, 'abort/timeout never retried');
  assert.equal(connectionFailureCauseCode(new Error('plain')), null, 'non-TypeError never retried');
});

test('behavior: ECONNRESET on first POST is retried once on a fresh call and succeeds', async () => {
  const { calls, restore } = mockFetch([fetchFailed('ECONNRESET'), okResponse('{"ok":true}')]);
  try {
    const res = await fetchLlmPost('anthropic', 'http://127.0.0.1:9/v1/messages', {}, '{}', undefined);
    assert.equal(await res.text(), '{"ok":true}');
    assert.equal(calls.length, 2, 'exactly one retry (total 2 calls)');
    assert.equal(calls[0].url, calls[1].url, 'retry hits the same URL');
    assert.deepEqual(calls[1].init.body, calls[0].init.body, 'retry carries the same body');
  } finally {
    restore();
  }
});

test('behavior: double ECONNRESET throws after the single retry (no infinite loop)', async () => {
  const { calls, restore } = mockFetch([fetchFailed('ECONNRESET'), fetchFailed('ECONNRESET')]);
  try {
    await assert.rejects(
      () => fetchLlmPost('openai-compat', 'http://127.0.0.1:9/v1/chat/completions', {}, '{}', undefined),
      /fetch failed/
    );
    assert.equal(calls.length, 2, 'first attempt + one retry, no more');
  } finally {
    restore();
  }
});

test('behavior: ECONNREFUSED fails fast without retry', async () => {
  const { calls, restore } = mockFetch([fetchFailed('ECONNREFUSED')]);
  try {
    await assert.rejects(() => fetchLlmPost('anthropic', 'http://127.0.0.1:9/v1/messages', {}, '{}', undefined));
    assert.equal(calls.length, 1, 'no retry for a dead endpoint');
  } finally {
    restore();
  }
});

test('behavior: abort/timeout never retried', async () => {
  const abortErr = new Error('This operation was aborted');
  abortErr.name = 'AbortError';
  const { calls, restore } = mockFetch([abortErr]);
  try {
    await assert.rejects(() => fetchLlmPost('anthropic', 'http://127.0.0.1:9/v1/messages', {}, '{}', undefined));
    assert.equal(calls.length, 1, 'abort must surface immediately');
  } finally {
    restore();
  }
});

test('behavior: aborted caller signal suppresses the retry', async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, restore } = mockFetch([fetchFailed('ECONNRESET')]);
  try {
    await assert.rejects(
      () => fetchLlmPost('anthropic', 'http://127.0.0.1:9/v1/messages', {}, '{}', controller.signal)
    );
    assert.equal(calls.length, 1, 'cancelled caller must not get a second POST');
  } finally {
    restore();
  }
});
