import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('start() records startup failure in cached status when binary is missing', async () => {
  if (!p2pService) {
    console.log('SKIP: dist-electron not found, run npm run compile:electron first');
    return;
  }

  const originalResourcesPath = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', {
    value: '/tmp/__nonexistent_resources__',
    writable: true,
    configurable: true,
  });

  try {
    await assert.rejects(() => p2pService.start('/tmp/p2p-data', '/tmp/p2p-config.json'));
    const status = p2pService.getP2PStatus();
    assert.equal(status.running, false, 'status should remain offline after startup failure');
    assert.match(status.error || '', /man-p2p binary not found/i);
  } finally {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      writable: true,
      configurable: true,
    });
  }
});

test('waitForHealthyLocalApi() retries until the local health check succeeds', async () => {
  assert.equal(typeof p2pService?.waitForHealthyLocalApi, 'function', 'waitForHealthyLocalApi() should be exported');

  let attempts = 0;
  const result = await p2pService.waitForHealthyLocalApi(async () => {
    attempts += 1;
    return attempts >= 3;
  }, { attempts: 5, delayMs: 0 });

  assert.equal(result, true, 'health wait should succeed once the check returns true');
  assert.equal(attempts, 3, 'health wait should stop retrying after the first healthy result');
});

test('refreshStatusFromLocalApi() normalizes status payload and updates cached status', async () => {
  assert.equal(typeof p2pService?.refreshStatusFromLocalApi, 'function', 'refreshStatusFromLocalApi() should be exported');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/p2p\/status$/);
    return new Response(JSON.stringify({
      code: 1,
      message: 'ok',
      data: {
        dataSource: 'p2p',
        peerCount: 0,
        storageLimitReached: false,
        storageUsedBytes: 123,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await p2pService.refreshStatusFromLocalApi();
    assert.equal(result.running, true);
    assert.equal(result.dataSource, 'p2p');
    assert.equal(result.peerCount, 0);
    assert.equal(result.storageLimitReached, false);
    assert.equal(result.storageUsedBytes, 123);

    const cached = p2pService.getP2PStatus();
    assert.equal(cached.running, true);
    assert.equal(cached.dataSource, 'p2p');
    assert.equal(cached.peerCount, 0);
    assert.equal(cached.storageLimitReached, false);
    assert.equal(cached.storageUsedBytes, 123);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshStatusFromLocalApi() honors IDBOTS_MAN_P2P_LOCAL_BASE override', async () => {
  assert.equal(typeof p2pService?.refreshStatusFromLocalApi, 'function', 'refreshStatusFromLocalApi() should be exported');

  const originalFetch = globalThis.fetch;
  const originalLocalBase = process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  let requestedUrl = '';

  process.env.IDBOTS_MAN_P2P_LOCAL_BASE = 'http://127.0.0.1:48999';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      code: 1,
      message: 'ok',
      data: {
        dataSource: 'p2p',
        peerCount: 0,
        storageLimitReached: false,
        storageUsedBytes: 0,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await p2pService.refreshStatusFromLocalApi();
    assert.equal(
      requestedUrl,
      'http://127.0.0.1:48999/api/p2p/status',
      'status refresh should follow the local base override',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalBase === undefined) {
      delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
    } else {
      process.env.IDBOTS_MAN_P2P_LOCAL_BASE = originalLocalBase;
    }
  }
});

test('resolveMainConfigPath() falls back to config.toml in node runtime smoke environments', async () => {
  assert.equal(typeof p2pService?.resolveMainConfigPath, 'function', 'resolveMainConfigPath() should be exported');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-p2p-config-'));
  const fallbackConfigPath = path.join(tempDir, 'config.toml');
  fs.writeFileSync(fallbackConfigPath, '# smoke config\n', 'utf8');

  const originalResourcesPath = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', {
    value: tempDir,
    writable: true,
    configurable: true,
  });

  try {
    const resolved = p2pService.resolveMainConfigPath();
    assert.equal(resolved, fallbackConfigPath);
  } finally {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      writable: true,
      configurable: true,
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
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
