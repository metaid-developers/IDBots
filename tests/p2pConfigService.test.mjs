import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  DEFAULT_P2P_CONFIG,
  buildRuntimeConfig,
} = require('../dist-electron/services/p2pConfigService.js');

test('buildRuntimeConfig keeps own-address merge behavior when metabot list is omitted', () => {
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_P2P_CONFIG,
      p2p_own_addresses: [' mvc-owner '],
    },
    ['btc-owner', 'mvc-owner'],
  );

  assert.deepEqual(runtime.p2p_own_addresses, ['mvc-owner', 'btc-owner']);
});

test('buildRuntimeConfig derives canonical p2p_presence_global_metaids from heartbeat-enabled metabots only', () => {
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_P2P_CONFIG,
      p2p_presence_global_metaids: ['idq1legacy'],
    },
    [],
    [
      { heartbeat_enabled: true, globalmetaid: ' IDQ1Alpha ' },
      { heartbeat_enabled: 1, globalmetaid: 'idq1beta' },
      { heartbeat_enabled: '1', globalMetaId: ' idq1beta ' },
      { heartbeat_enabled: false, globalmetaid: 'idq1offline' },
      { heartbeat_enabled: 0, globalmetaid: 'idq1zero' },
      { heartbeat_enabled: true, globalmetaid: 'metaid:idq1prefixed' },
      { heartbeat_enabled: true, globalmetaid: 'not-a-global-metaid' },
      { heartbeat_enabled: true, globalmetaid: '' },
    ],
  );

  assert.deepEqual(runtime.p2p_presence_global_metaids, ['idq1alpha', 'idq1beta']);
});
