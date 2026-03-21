import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pinAssetService;
try {
  pinAssetService = require('../dist-electron/services/pinAssetService.js');
} catch {
  pinAssetService = null;
}

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

test('extractPinIdFromReference() parses supported MetaID pin image references', () => {
  assert.equal(typeof pinAssetService?.extractPinIdFromReference, 'function', 'extractPinIdFromReference() should be exported');

  assert.equal(pinAssetService.extractPinIdFromReference('metafile://pin-123'), 'pin-123');
  assert.equal(pinAssetService.extractPinIdFromReference('/content/pin-234'), 'pin-234');
  assert.equal(
    pinAssetService.extractPinIdFromReference('https://file.metaid.io/metafile-indexer/thumbnail/pin-345?size=240'),
    'pin-345',
  );
});

test('resolvePinAssetSource() uses local-first content fetch for pin-backed assets', async () => {
  assert.equal(typeof pinAssetService?.resolvePinAssetSource, 'function', 'resolvePinAssetSource() should be exported');

  pinAssetService.clearResolvedPinAssetCache?.();

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(String(url));
    if (String(url).includes('localhost:7281')) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': '4',
        },
      });
    }
    throw new Error('fallback should not be called');
  });

  try {
    const result = await pinAssetService.resolvePinAssetSource('metafile://pin-456');
    assert.match(result, /^data:image\/png;base64,/);
    assert.equal(calls.length, 1, 'local content should satisfy the request');
    assert.ok(calls[0].includes('/content/pin-456'));
  } finally {
    restore();
    pinAssetService.clearResolvedPinAssetCache?.();
  }
});

test('resolvePinAssetSource() falls back when local content is metadata-only', async () => {
  assert.equal(typeof pinAssetService?.resolvePinAssetSource, 'function', 'resolvePinAssetSource() should be exported');

  pinAssetService.clearResolvedPinAssetCache?.();

  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(String(url));
    if (String(url).includes('localhost:7281')) {
      return new Response('', {
        status: 200,
        headers: {
          'x-man-content-status': 'metadata-only',
          'content-length': '0',
        },
      });
    }
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': '3',
      },
    });
  });

  try {
    const result = await pinAssetService.resolvePinAssetSource('https://file.metaid.io/metafile-indexer/content/pin-789');
    assert.match(result, /^data:image\/jpeg;base64,/);
    assert.equal(calls.length, 2, 'metadata-only local responses should trigger remote fallback');
    assert.ok(calls[1].includes('/content/pin-789') || calls[1].includes('file.metaid.io'));
  } finally {
    restore();
    pinAssetService.clearResolvedPinAssetCache?.();
  }
});
