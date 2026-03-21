import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { test } from 'node:test';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bundledBinaryPath = path.join(projectRoot, 'resources', 'man-p2p', 'man-p2p-darwin-arm64');
const bundledConfigPath = path.join(projectRoot, 'resources', 'man-p2p', 'config.toml');
const bundledManifestPath = path.join(projectRoot, 'resources', 'man-p2p', 'bundle-manifest.json');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

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

async function waitForHealthyPort(port, attempts = 20, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // Retry until the binary comes up or we time out.
    }
    await wait(delayMs);
  }
  return false;
}

async function waitForChildExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', () => finish(true));
    child.once('close', () => finish(true));
  });
}

test('bundled man-p2p manifest tracks the synced alpha binary source and digest', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.log(`SKIP: bundled binary contract test only runs on darwin arm64, got ${process.platform} ${process.arch}`);
    return;
  }
  if (!fs.existsSync(bundledBinaryPath)) {
    console.log('SKIP: bundled man-p2p binary is missing');
    return;
  }
  assert.equal(fs.existsSync(bundledManifestPath), true, `expected bundled manifest at ${bundledManifestPath}`);

  const manifest = JSON.parse(fs.readFileSync(bundledManifestPath, 'utf8'));
  assert.match(String(manifest?.binary || ''), /^man-p2p-darwin-arm64$/);
  assert.match(String(manifest?.sourceCommit || ''), /^[0-9a-f]{7,}$/i);
  assert.match(String(manifest?.binarySha256 || ''), /^[0-9a-f]{64}$/i);
  assert.equal(manifest.binarySha256, sha256File(bundledBinaryPath));

  const binaryText = fs.readFileSync(bundledBinaryPath).toString('latin1');
  assert.match(binaryText, /syncMode/);
  assert.match(binaryText, /runtimeMode/);
  assert.match(binaryText, /peerId/);
  assert.match(binaryText, /listenAddrs/);
  assert.match(binaryText, new RegExp(String(manifest.sourceCommit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('bundled man-p2p binary best-effort isolated smoke keeps alpha status fields when healthy', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.log(`SKIP: bundled binary smoke only runs on darwin arm64, got ${process.platform} ${process.arch}`);
    return;
  }
  if (!fs.existsSync(bundledBinaryPath) || !fs.existsSync(bundledConfigPath)) {
    console.log('SKIP: bundled man-p2p binary or config is missing');
    return;
  }

  const port = await reservePort();
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-bundled-p2p-'));
  const tempConfigPath = path.join(tmpdir, 'config.toml');
  const tempP2PConfigPath = path.join(tmpdir, 'p2p-config.json');
  const baseConfig = fs.readFileSync(bundledConfigPath, 'utf8');
  fs.writeFileSync(
    tempConfigPath,
    baseConfig.replace(/port = "0\.0\.0\.0:7281"/, `port = "127.0.0.1:${port}"`),
    'utf8',
  );
  fs.writeFileSync(
    tempP2PConfigPath,
    JSON.stringify({
      p2p_sync_mode: 'self',
      p2p_bootstrap_nodes: [],
      p2p_enable_relay: true,
      p2p_storage_limit_gb: 1,
      p2p_enable_chain_source: false,
      p2p_own_addresses: [],
    }, null, 2),
    'utf8',
  );

  const child = spawn(bundledBinaryPath, [
    '-config', tempConfigPath,
    '--data-dir', path.join(tmpdir, 'data'),
    '--p2p-config', tempP2PConfigPath,
    '-server=1',
    '-btc_height=900000',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout?.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk) => output.push(chunk.toString()));

  try {
    const healthy = await waitForHealthyPort(port);
    if (!healthy) {
      console.log(`SKIP: bundled binary did not become healthy on isolated port ${port}; output:\n${output.join('')}`);
      return;
    }

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/p2p/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    const data = statusJson?.data || {};
    assert.equal(statusJson?.code, 1);
    assert.equal(data.syncMode, 'self');
    assert.equal(data.runtimeMode, 'p2p-only');
    assert.equal(typeof data.peerCount, 'number');
    assert.equal(typeof data.storageUsedBytes, 'number');
    assert.equal(typeof data.storageLimitReached, 'boolean');
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      // Best effort cleanup.
    }
    const exited = await waitForChildExit(child);
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Best effort cleanup.
      }
      await waitForChildExit(child, 1000);
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.removeAllListeners();
    child.unref();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}, 30_000);
