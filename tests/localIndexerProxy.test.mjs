/**
 * Tests for localIndexerProxy.ts
 *
 * These tests exercise the proxy logic by mocking globalThis.fetch.
 * Run `npm run compile:electron` first so dist-electron/ is up to date.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Gracefully skip all tests if the compiled module is not yet available.
let fetchFromLocalOrFallback;
let fetchContentWithFallback;
try {
  ({
    fetchFromLocalOrFallback,
    fetchContentWithFallback,
  } = require('../dist-electron/services/localIndexerProxy.js'));
} catch {
  console.warn('[localIndexerProxy tests] dist-electron not built — skipping');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Install a temporary fetch mock; restored by the returned teardown fn. */
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function makeResponse(status, headers = {}, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// fetchFromLocalOrFallback
// ---------------------------------------------------------------------------

test('fetchFromLocalOrFallback: local 200 returns local response without calling fallback', async () => {
  if (!fetchFromLocalOrFallback) {
    return; // module not built yet
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    if (url.includes('localhost:7281')) {
      return makeResponse(200);
    }
    return makeResponse(200);
  });

  try {
    const res = await fetchFromLocalOrFallback('/api/pin/abc', 'https://example.com/fallback');
    assert.equal(res.status, 200, 'should return a 200 response');
    assert.equal(calls.length, 1, 'fallback should not be called when local succeeds');
    assert.ok(calls[0].includes('localhost:7281'), 'first call should be to local node');
  } finally {
    restore();
  }
});

test('fetchFromLocalOrFallback: local non-2xx triggers fallback', async () => {
  if (!fetchFromLocalOrFallback) {
    return;
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    if (url.includes('localhost:7281')) {
      return makeResponse(404);
    }
    return makeResponse(200);
  });

  try {
    const res = await fetchFromLocalOrFallback('/api/pin/abc', 'https://example.com/fallback');
    assert.equal(res.status, 200, 'fallback response should be returned');
    assert.equal(calls.length, 2, 'both local and fallback should be called');
    assert.ok(calls[1].includes('example.com'), 'second call should be to fallback URL');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// fetchContentWithFallback
// ---------------------------------------------------------------------------

test('fetchContentWithFallback: local 200 with content-length > 0 returns local response', async () => {
  if (!fetchContentWithFallback) {
    return;
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    if (url.includes('localhost:7281')) {
      return makeResponse(200, { 'content-length': '512' });
    }
    return makeResponse(200, { 'content-length': '512' });
  });

  try {
    const res = await fetchContentWithFallback('pin123', 'https://example.com/content/pin123');
    assert.equal(res.status, 200, 'should return a 200 response');
    assert.equal(calls.length, 1, 'fallback should not be called when local has content');
    assert.ok(calls[0].includes('localhost:7281'), 'first call should be to local node');
  } finally {
    restore();
  }
});

test('fetchContentWithFallback: local 200 with missing content-length falls back', async () => {
  if (!fetchContentWithFallback) {
    return;
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    if (url.includes('localhost:7281')) {
      // No content-length header → treated as empty
      return makeResponse(200, {});
    }
    return makeResponse(200, { 'content-length': '256' });
  });

  try {
    const res = await fetchContentWithFallback('pin456', 'https://example.com/content/pin456');
    assert.equal(res.status, 200, 'fallback response should be returned');
    assert.equal(calls.length, 2, 'both local and fallback should be called');
    assert.ok(calls[1].includes('example.com'), 'second call should be to fallback URL');
  } finally {
    restore();
  }
});

test('fetchContentWithFallback: local 200 with content-length 0 falls back', async () => {
  if (!fetchContentWithFallback) {
    return;
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    if (url.includes('localhost:7281')) {
      return makeResponse(200, { 'content-length': '0' });
    }
    return makeResponse(200, { 'content-length': '128' });
  });

  try {
    const res = await fetchContentWithFallback('pin789', 'https://example.com/content/pin789');
    assert.equal(res.status, 200, 'fallback response should be returned');
    assert.equal(calls.length, 2, 'should fall back on content-length: 0');
  } finally {
    restore();
  }
});
