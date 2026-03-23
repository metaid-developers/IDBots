import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let p2pService;
try {
  p2pService = require('../dist-electron/services/p2pIndexerService.js');
} catch {
  p2pService = null;
}

let fetchFromLocalOrFallback;
try {
  ({ fetchFromLocalOrFallback } = require('../dist-electron/services/localIndexerProxy.js'));
} catch {
  fetchFromLocalOrFallback = null;
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bundledBinaryDir = path.join(projectRoot, 'resources', 'man-p2p');
const bundledBinaryPath = path.join(bundledBinaryDir, 'man-p2p-darwin-arm64');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((error) => {
        if (error) return reject(error);
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function listen(server) {
  return await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      resolve(port);
    });
    server.on('error', reject);
  });
}

test('embedded man-p2p smoke: isolated runtime proves local hit, fallback miss, and cached status truth', async () => {
  if (!p2pService || !fetchFromLocalOrFallback) {
    console.log('SKIP: dist-electron not found, run npm run compile:electron first');
    return;
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.log(`SKIP: smoke test only runs on darwin arm64, got ${process.platform} ${process.arch}`);
    return;
  }
  if (!fs.existsSync(bundledBinaryPath)) {
    console.log(`SKIP: bundled man-p2p binary not found at ${bundledBinaryPath}`);
    return;
  }

  const isolatedPort = await reservePort();
  const originalResourcesPath = process.resourcesPath;
  const originalLocalBase = process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-p2p-smoke-'));
  const runtimeResourcesDir = path.join(tmpdir, 'runtime-resources');
  fs.mkdirSync(runtimeResourcesDir, { recursive: true });
  fs.copyFileSync(bundledBinaryPath, path.join(runtimeResourcesDir, 'man-p2p-darwin-arm64'));
  fs.chmodSync(path.join(runtimeResourcesDir, 'man-p2p-darwin-arm64'), 0o755);

  const baseConfig = fs.readFileSync(path.join(bundledBinaryDir, 'config.toml'), 'utf8');
  fs.writeFileSync(
    path.join(runtimeResourcesDir, 'config.toml'),
    baseConfig.replace(/port = "0\.0\.0\.0:7281"/, `port = "127.0.0.1:${isolatedPort}"`),
    'utf8',
  );

  const runtimeConfigPath = path.join(tmpdir, 'p2p-config.json');
  fs.writeFileSync(runtimeConfigPath, JSON.stringify({
    p2p_sync_mode: 'self',
    p2p_bootstrap_nodes: [],
    p2p_enable_relay: true,
    p2p_storage_limit_gb: 1,
    p2p_enable_chain_source: false,
    p2p_own_addresses: [],
  }, null, 2));

  const fallbackHits = [];
  const fallbackServer = http.createServer((req, res) => {
    fallbackHits.push(req.url || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 1,
      message: 'fallback',
      data: {
        id: 'fallback-pin',
      },
    }));
  });
  const fallbackPort = await listen(fallbackServer);

  Object.defineProperty(process, 'resourcesPath', {
    value: runtimeResourcesDir,
    writable: true,
    configurable: true,
  });
  process.env.IDBOTS_MAN_P2P_LOCAL_BASE = `http://127.0.0.1:${isolatedPort}`;

  try {
    await p2pService.start(path.join(tmpdir, 'data'), runtimeConfigPath);
    const cached = p2pService.getP2PStatus();
    assert.equal(cached.running, true);
    assert.equal(cached.dataSource, 'p2p');
    assert.equal(cached.syncMode, 'self');
    assert.equal(cached.runtimeMode, 'p2p-only');
    assert.equal(typeof cached.peerCount, 'number');
    assert.equal(cached.peerCount, 0);
    assert.equal(cached.storageLimitReached, false);
    assert.equal(typeof cached.storageUsedBytes, 'number');

    const localHit = await fetchFromLocalOrFallback(
      '/api/p2p/status',
      `http://127.0.0.1:${fallbackPort}/api/p2p/status`,
    );
    const localHitJson = await localHit.json();
    assert.equal(localHitJson?.code, 1);
    assert.equal(localHitJson?.data?.runtimeMode, 'p2p-only');
    assert.equal(localHitJson?.data?.syncMode, 'self');
    assert.equal(fallbackHits.length, 0, 'fallback must not be used when isolated local status is healthy');

    const localMiss = await fetchFromLocalOrFallback(
      '/api/pin/does-not-exist',
      `http://127.0.0.1:${fallbackPort}/api/pin/does-not-exist`,
    );
    const localMissJson = await localMiss.json();
    assert.equal(localMissJson?.code, 1);
    assert.equal(localMissJson?.data?.id, 'fallback-pin');
    assert.deepEqual(
      fallbackHits,
      ['/api/pin/does-not-exist'],
      'fallback should only serve the local miss path',
    );
  } finally {
    try {
      await p2pService.stop();
    } catch {
      // Best effort cleanup for smoke tests.
    }
    await new Promise((resolve, reject) => {
      fallbackServer.close((error) => {
        if (error) return reject(error);
        resolve();
      });
    });
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      writable: true,
      configurable: true,
    });
    if (originalLocalBase === undefined) {
      delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
    } else {
      process.env.IDBOTS_MAN_P2P_LOCAL_BASE = originalLocalBase;
    }
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}, 45_000);
