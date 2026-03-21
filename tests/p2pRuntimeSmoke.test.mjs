import assert from 'node:assert/strict';
import fs from 'node:fs';
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

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bundledBinaryDir = path.join(projectRoot, 'resources', 'man-p2p');
const bundledBinaryPath = path.join(bundledBinaryDir, 'man-p2p-darwin-arm64');

test('embedded man-p2p smoke: startup seeds cached runtime status from local API', async () => {
  if (!p2pService) {
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
  try {
    const res = await fetch('http://localhost:7281/health');
    if (res.ok) {
      console.log('SKIP: port 7281 already has a healthy local service; smoke test would be ambiguous');
      return;
    }
  } catch {
    // Expected when no pre-existing local service is running.
  }

  const originalResourcesPath = process.resourcesPath;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-p2p-smoke-'));
  fs.writeFileSync(path.join(tmpdir, 'p2p-config.json'), JSON.stringify({
    p2p_sync_mode: 'self',
    p2p_bootstrap_nodes: [],
    p2p_enable_relay: true,
    p2p_storage_limit_gb: 1,
    p2p_enable_chain_source: false,
    p2p_own_addresses: [],
  }, null, 2));

  Object.defineProperty(process, 'resourcesPath', {
    value: bundledBinaryDir,
    writable: true,
    configurable: true,
  });

  try {
    await p2pService.start(path.join(tmpdir, 'data'), path.join(tmpdir, 'p2p-config.json'));
    const cached = p2pService.getP2PStatus();
    assert.equal(cached.running, true);
    assert.equal(cached.dataSource, 'p2p');
    assert.equal(typeof cached.peerCount, 'number');
    assert.equal(cached.peerCount, 0);
    assert.equal(cached.storageLimitReached, false);
    assert.equal(typeof cached.storageUsedBytes, 'number');
  } finally {
    try {
      await p2pService.stop();
    } catch {
      // Best effort cleanup for smoke tests.
    }
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      writable: true,
      configurable: true,
    });
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}, 30_000);
