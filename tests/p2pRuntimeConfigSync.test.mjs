import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadRuntimeConfigSync() {
  return require('../dist-electron/services/p2pRuntimeConfigSync.js');
}

function makeStore(config) {
  const state = {
    config,
    kv: {},
  };

  return {
    getP2PConfig() {
      return state.config;
    },
    get(key) {
      return state.kv[key];
    },
    set(key, value) {
      state.kv[key] = value;
    },
    setP2PConfig(nextConfig) {
      state.config = nextConfig;
    },
  };
}

async function withMockedFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('syncP2PRuntimeConfig writes derived runtime config and returns reloadOk=true on successful reload', async () => {
  const { syncP2PRuntimeConfig } = loadRuntimeConfigSync();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-runtime-config-sync-'));
  const configPath = path.join(root, 'man-p2p-config.json');

  await withMockedFetch(async () => ({ ok: true, status: 200 }), async () => {
    const result = await syncP2PRuntimeConfig({
      store: makeStore({
        p2p_sync_mode: 'self',
        p2p_bootstrap_nodes: [],
        p2p_enable_relay: true,
        p2p_storage_limit_gb: 10,
        p2p_enable_chain_source: false,
        p2p_own_addresses: [],
      }),
      metabots: [
        { enabled: true, globalmetaid: ' IDQ1Alpha ', mvc_address: 'mvc-1' },
        { enabled: false, globalmetaid: 'idq1offline', mvc_address: 'mvc-2' },
      ],
      configPath,
    });

    assert.equal(result.reloadOk, true);
    assert.deepEqual(result.runtimeConfig.p2p_presence_global_metaids, ['idq1alpha']);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(onDisk.p2p_presence_global_metaids, ['idq1alpha']);
  });
});

test('syncP2PRuntimeConfig returns reloadOk=false and does not throw when reload fails after write', async () => {
  const { syncP2PRuntimeConfig } = loadRuntimeConfigSync();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-runtime-config-sync-'));
  const configPath = path.join(root, 'man-p2p-config.json');

  await withMockedFetch(async () => ({ ok: false, status: 500 }), async () => {
    const result = await syncP2PRuntimeConfig({
      store: makeStore({
        p2p_sync_mode: 'self',
        p2p_bootstrap_nodes: [],
        p2p_enable_relay: true,
        p2p_storage_limit_gb: 10,
        p2p_enable_chain_source: false,
        p2p_own_addresses: [],
      }),
      metabots: [{ enabled: true, globalmetaid: 'idq1beta', mvc_address: 'mvc-1' }],
      configPath,
    });

    assert.equal(result.reloadOk, false);
    assert.equal(fs.existsSync(configPath), true);
    assert.deepEqual(result.runtimeConfig.p2p_presence_global_metaids, ['idq1beta']);
  });
});
