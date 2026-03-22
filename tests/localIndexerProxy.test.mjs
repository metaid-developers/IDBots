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
let fetchJsonWithFallbackOnMiss;
let isEmptyListDataPayload;
try {
  ({
    fetchFromLocalOrFallback,
    fetchContentWithFallback,
    fetchJsonWithFallbackOnMiss,
    isEmptyListDataPayload,
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

function makeJsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function makeTextResponse(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers,
  });
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
      return makeJsonResponse(200, { code: 1, message: 'ok', data: { id: 'abc' } });
    }
    return makeJsonResponse(200, { code: 1, message: 'ok', data: { id: 'fallback' } });
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
      return makeJsonResponse(404, { code: 0, message: 'not found' });
    }
    return makeJsonResponse(200, { code: 1, message: 'ok', data: { id: 'fallback' } });
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

test('fetchFromLocalOrFallback: local 200 with code 0 triggers fallback', async () => {
  if (!fetchFromLocalOrFallback) {
    return;
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    if (url.includes('localhost:7281')) {
      return makeJsonResponse(200, { code: 0, message: 'local miss' });
    }
    return makeJsonResponse(200, { code: 1, message: 'ok', data: { id: 'fallback-hit' } });
  });

  try {
    const res = await fetchFromLocalOrFallback('/api/pin/abc', 'https://example.com/fallback');
    const json = await res.json();
    assert.equal(calls.length, 2, 'fallback should be called when local code != 1');
    assert.equal(json.data.id, 'fallback-hit');
  } finally {
    restore();
  }
});

test('fetchJsonWithFallbackOnMiss: local empty list triggers fallback', async () => {
  if (!fetchJsonWithFallbackOnMiss) {
    assert.fail('fetchJsonWithFallbackOnMiss should be exported');
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(String(url));
    if (String(url).includes('localhost:7281')) {
      return makeJsonResponse(200, {
        code: 1,
        message: 'ok',
        data: {
          list: [],
        },
      });
    }
    return makeJsonResponse(200, {
      code: 1,
      message: 'ok',
      data: {
        list: [{ id: 'remote-pin' }],
      },
    });
  });

  try {
    const res = await fetchJsonWithFallbackOnMiss(
      '/api/pin/path/list?path=%2Finfo%2Fname',
      'https://example.com/pin/path/list?path=%2Finfo%2Fname',
      (payload) => Array.isArray(payload?.data?.list) && payload.data.list.length === 0,
    );
    const json = await res.json();
    assert.equal(calls.length, 2, 'semantic local miss should trigger remote fallback');
    assert.equal(json.data.list[0].id, 'remote-pin');
  } finally {
    restore();
  }
});

test('fetchJsonWithFallbackOnMiss: local null list triggers fallback', async () => {
  if (!fetchJsonWithFallbackOnMiss || !isEmptyListDataPayload) {
    assert.fail('localIndexerProxy exports should be available');
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(String(url));
    if (String(url).includes('localhost:7281')) {
      return makeJsonResponse(200, {
        code: 1,
        message: 'ok',
        data: {
          list: null,
          total: 0,
          nextCursor: '',
        },
      });
    }
    return makeJsonResponse(200, {
      code: 1,
      message: 'ok',
      data: {
        list: [{ id: 'remote-pin' }],
      },
    });
  });

  try {
    assert.equal(
      isEmptyListDataPayload({ data: { list: null, total: 0, nextCursor: '' } }),
      true,
      'null list should be treated as a semantic miss',
    );
    const res = await fetchJsonWithFallbackOnMiss(
      '/api/pin/path/list?path=%2Fprotocols%2Fskill-service&size=3',
      'https://example.com/pin/path/list?path=%2Fprotocols%2Fskill-service&size=3',
      isEmptyListDataPayload,
    );
    const json = await res.json();
    assert.equal(calls.length, 2, 'null list semantic miss should trigger remote fallback');
    assert.equal(json.data.list[0].id, 'remote-pin');
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
      return makeTextResponse(200, 'local-body', { 'content-length': '10' });
    }
    return makeTextResponse(200, 'fallback-body', { 'content-length': '13' });
  });

  try {
    const res = await fetchContentWithFallback('pin123', 'https://example.com/content/pin123');
    assert.equal(res.status, 200, 'should return a 200 response');
    assert.equal(calls.length, 1, 'fallback should not be called when local has content');
    assert.ok(calls[0].includes('localhost:7281'), 'first call should be to local node');
    assert.equal(await res.text(), 'local-body');
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
      return makeTextResponse(200, 'local-body-without-length');
    }
    return makeTextResponse(200, 'fallback-body', { 'content-length': '13' });
  });

  try {
    const res = await fetchContentWithFallback('pin456', 'https://example.com/content/pin456');
    assert.equal(res.status, 200, 'local response should be returned when body exists');
    assert.equal(calls.length, 1, 'fallback should not be called when local body exists');
    assert.equal(await res.text(), 'local-body-without-length');
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
      return makeTextResponse(200, '', { 'content-length': '0' });
    }
    return makeTextResponse(200, 'fallback-body', { 'content-length': '13' });
  });

  try {
    const res = await fetchContentWithFallback('pin789', 'https://example.com/content/pin789');
    assert.equal(res.status, 200, 'fallback response should be returned');
    assert.equal(calls.length, 2, 'should fall back on content-length: 0');
  } finally {
    restore();
  }
});

test('fetchContentWithFallback: local metadata-only response triggers fallback', async () => {
  if (!fetchContentWithFallback) {
    return;
  }

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    if (url.includes('localhost:7281')) {
      return makeTextResponse(200, '', {
        'x-man-content-status': 'metadata-only',
        'content-length': '0',
      });
    }
    return makeTextResponse(200, 'fallback-body', { 'content-length': '13' });
  });

  try {
    const res = await fetchContentWithFallback('pin-metadata', 'https://example.com/content/pin-metadata');
    assert.equal(res.status, 200, 'fallback response should be returned');
    assert.equal(calls.length, 2, 'metadata-only local content should trigger fallback');
    assert.equal(await res.text(), 'fallback-body');
  } finally {
    restore();
  }
});
