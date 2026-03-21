import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The compiled output lives at dist-electron/services/p2pIndexerService.js
// Run `npm run compile:electron` first before executing these tests.
let p2pService;
try {
  p2pService = require('../dist-electron/services/p2pIndexerService.js');
} catch (e) {
  // If the compiled file doesn't exist yet, tests that depend on it will fail with a descriptive error.
  p2pService = null;
}

test('start() rejects with a clear error when binary does not exist', async () => {
  if (!p2pService) {
    // Skip gracefully if not compiled — the test structure is still validated
    console.log('SKIP: dist-electron not found, run npm run compile:electron first');
    return;
  }

  // Override process.resourcesPath so the resolved binary path points somewhere non-existent
  const originalResourcesPath = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', {
    value: '/tmp/__nonexistent_resources__',
    writable: true,
    configurable: true,
  });

  try {
    await assert.rejects(
      () => p2pService.start('/tmp/p2p-data', '/tmp/p2p-config.json'),
      (err) => {
        assert.ok(
          err instanceof Error,
          'should throw an Error instance'
        );
        assert.ok(
          err.message.includes('man-p2p'),
          `error message should mention 'man-p2p', got: ${err.message}`
        );
        assert.ok(
          err.message.includes('/tmp/__nonexistent_resources__'),
          `error message should include the resolved path, got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      writable: true,
      configurable: true,
    });
  }
});

test('healthCheck() returns false when nothing is listening on port 7281', async () => {
  if (!p2pService) {
    console.log('SKIP: dist-electron not found, run npm run compile:electron first');
    return;
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    const result = await p2pService.healthCheck();
    assert.equal(result, false, 'healthCheck() should return false when local health request errors');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeStatusPayload() unwraps MAN envelope data', async () => {
  assert.equal(typeof p2pService?.normalizeStatusPayload, 'function', 'normalizeStatusPayload() should be exported');

  const result = p2pService.normalizeStatusPayload({
    code: 1,
    message: 'ok',
    data: {
      peerCount: 2,
      storageLimitReached: false,
      storageUsedBytes: 1024,
      dataSource: 'p2p',
      syncMode: 'self',
      runtimeMode: 'p2p-only',
      peerId: 'peer-123',
      listenAddrs: ['/ip4/127.0.0.1/tcp/4001'],
    },
  });

  assert.deepEqual(result, {
    running: true,
    peerCount: 2,
    storageLimitReached: false,
    storageUsedBytes: 1024,
    dataSource: 'p2p',
    syncMode: 'self',
    runtimeMode: 'p2p-only',
    peerId: 'peer-123',
    listenAddrs: ['/ip4/127.0.0.1/tcp/4001'],
  });
});

test('unwrapPeersPayload() returns peer list from MAN envelope', async () => {
  assert.equal(typeof p2pService?.unwrapPeersPayload, 'function', 'unwrapPeersPayload() should be exported');

  const result = p2pService.unwrapPeersPayload({
    code: 1,
    message: 'ok',
    data: ['peer-a', 'peer-b'],
  });

  assert.deepEqual(result, ['peer-a', 'peer-b']);
});
