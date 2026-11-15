import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadProxy() {
  return require('../dist-electron/main/services/localIndexerProxy.js');
}

async function withFetchStub(fn, run) {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) {
      delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
    } else {
      process.env.IDBOTS_MAN_P2P_LOCAL_BASE = originalBase;
    }
  }
}

test('remote fallback fetches carry a default timeout signal', async () => {
  const { fetchFromLocalOrFallback, fetchContentWithFallback } = loadProxy();
  const calls = [];

  await withFetchStub(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{"code":1}', { status: 200 });
  }, async () => {
    await fetchFromLocalOrFallback('/api/pin/abc', 'https://remote.example/api/pin/abc');
    await fetchContentWithFallback('pin-1', 'https://remote.example/content/pin-1');
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(
      call.init?.signal instanceof AbortSignal,
      `remote fetch to ${call.url} must carry an AbortSignal`,
    );
  }
});

test('local indexer fallback preserves the remote query parameters', async () => {
  const { fetchFromLocalOrFallback } = loadProxy();
  const calls = [];
  await withFetchStub(async (url) => {
    calls.push(String(url));
    return new Response('{"code":1,"data":{"list":[]}}', { status: 200 });
  }, async () => {
    process.env.IDBOTS_MAN_P2P_LOCAL_BASE = 'http://indexer.local';
    await fetchFromLocalOrFallback(
      '/api/mrc721/address/item',
      'https://so.metaid.io/api/mrc721/address/item?address=holder&size=100',
    );
  });

  assert.deepEqual(calls, [
    'http://indexer.local/api/mrc721/address/item?address=holder&size=100',
  ]);
});

test('caller-provided signals win over the default remote timeout', async () => {
  const { fetchFromLocalOrFallback, fetchContentWithFallback } = loadProxy();
  const callerSignal = AbortSignal.timeout(250);
  const seenSignals = [];

  await withFetchStub(async (_url, init) => {
    seenSignals.push(init?.signal);
    return new Response('{"code":1}', { status: 200 });
  }, async () => {
    await fetchFromLocalOrFallback('/api/pin/abc', 'https://remote.example/api/pin/abc', {
      signal: callerSignal,
    });
    await fetchContentWithFallback('pin-1', 'https://remote.example/content/pin-1', {
      signal: callerSignal,
    });
  });

  assert.equal(seenSignals.length, 2);
  for (const signal of seenSignals) {
    assert.equal(signal, callerSignal);
  }
});
