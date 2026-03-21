import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let p2pConfigService;
try {
  p2pConfigService = require('../dist-electron/services/p2pConfigService.js');
} catch {
  p2pConfigService = null;
}

test('DEFAULT_P2P_CONFIG exposes alpha-critical defaults', () => {
  if (!p2pConfigService) {
    console.log('SKIP: dist-electron not found, run npm run compile:electron first');
    return;
  }

  assert.deepEqual(p2pConfigService.DEFAULT_P2P_CONFIG, {
    p2p_sync_mode: 'self',
    p2p_bootstrap_nodes: [],
    p2p_enable_relay: true,
    p2p_storage_limit_gb: 10,
    p2p_enable_chain_source: false,
    p2p_own_addresses: [],
  });
});

test('collectOwnAddresses() deduplicates all local MetaBot chain addresses', () => {
  assert.equal(typeof p2pConfigService?.collectOwnAddresses, 'function', 'collectOwnAddresses() should be exported');

  const result = p2pConfigService.collectOwnAddresses([
    { mvc_address: 'mvc1', btc_address: 'btc1', doge_address: 'doge1' },
    { mvc_address: 'mvc1', btc_address: 'btc2', doge_address: '' },
    { mvc_address: ' ', btc_address: undefined, doge_address: 'doge1' },
  ]);

  assert.deepEqual(result, ['mvc1', 'btc1', 'doge1', 'btc2']);
});

test('buildRuntimeConfig() merges derived own addresses into persisted config', () => {
  assert.equal(typeof p2pConfigService?.buildRuntimeConfig, 'function', 'buildRuntimeConfig() should be exported');

  const result = p2pConfigService.buildRuntimeConfig({
    p2p_sync_mode: 'self',
    p2p_bootstrap_nodes: [],
    p2p_enable_relay: true,
    p2p_storage_limit_gb: 10,
    p2p_enable_chain_source: false,
    p2p_own_addresses: ['manual-addr', 'btc1'],
  }, ['btc1', 'mvc1']);

  assert.deepEqual(result, {
    p2p_sync_mode: 'self',
    p2p_bootstrap_nodes: [],
    p2p_enable_relay: true,
    p2p_storage_limit_gb: 10,
    p2p_enable_chain_source: false,
    p2p_own_addresses: ['manual-addr', 'btc1', 'mvc1'],
  });
});
