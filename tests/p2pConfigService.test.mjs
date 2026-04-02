import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  DEFAULT_P2P_CONFIG,
  buildRuntimeConfig,
  getConfig,
  OFFICIAL_P2P_BOOTSTRAP_NODES,
  P2P_BOOTSTRAP_DEFAULTS_MIGRATION_KEY,
} = require('../dist-electron/services/p2pConfigService.js');

function makeStore({
  p2pConfig,
  kv = {},
} = {}) {
  const state = {
    p2pConfig,
    kv: { ...kv },
    setCalls: [],
    setP2PConfigCalls: [],
  };

  return {
    state,
    getP2PConfig() {
      return state.p2pConfig;
    },
    get(key) {
      return state.kv[key];
    },
    set(key, value) {
      state.kv[key] = value;
      state.setCalls.push({ key, value });
    },
    setP2PConfig(config) {
      state.p2pConfig = config;
      state.setP2PConfigCalls.push(config);
    },
  };
}

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

test('buildRuntimeConfig ignores falsey string heartbeat_enabled values', () => {
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_P2P_CONFIG,
    },
    [],
    [
      { heartbeat_enabled: '0', globalmetaid: 'idq1zero' },
      { heartbeat_enabled: 'false', globalmetaid: 'idq1false' },
      { heartbeat_enabled: '1', globalmetaid: 'idq1one' },
      { heartbeat_enabled: true, globalmetaid: 'idq1true' },
    ],
  );

  assert.deepEqual(runtime.p2p_presence_global_metaids, ['idq1one', 'idq1true']);
});

test('getConfig returns official bootstrap nodes by default for new profiles', () => {
  const store = makeStore();

  const config = getConfig(store);

  assert.deepEqual(config.p2p_bootstrap_nodes, OFFICIAL_P2P_BOOTSTRAP_NODES);
});

test('getConfig migrates historical empty bootstrap defaults once when marker is missing', () => {
  const store = makeStore({
    p2pConfig: {
      ...DEFAULT_P2P_CONFIG,
      p2p_bootstrap_nodes: [],
    },
  });

  const config = getConfig(store);

  assert.deepEqual(config.p2p_bootstrap_nodes, OFFICIAL_P2P_BOOTSTRAP_NODES);
  assert.equal(store.state.setP2PConfigCalls.length, 1);
  assert.deepEqual(store.state.setP2PConfigCalls[0].p2p_bootstrap_nodes, OFFICIAL_P2P_BOOTSTRAP_NODES);
  assert.deepEqual(store.state.setCalls, [
    { key: P2P_BOOTSTRAP_DEFAULTS_MIGRATION_KEY, value: true },
  ]);
});

test('getConfig respects explicit empty bootstrap nodes after migration marker exists', () => {
  const store = makeStore({
    p2pConfig: {
      ...DEFAULT_P2P_CONFIG,
      p2p_bootstrap_nodes: [],
    },
    kv: {
      [P2P_BOOTSTRAP_DEFAULTS_MIGRATION_KEY]: true,
    },
  });

  const config = getConfig(store);

  assert.deepEqual(config.p2p_bootstrap_nodes, []);
  assert.equal(store.state.setP2PConfigCalls.length, 0);
  assert.equal(store.state.setCalls.length, 0);
});

test('getConfig preserves custom bootstrap node lists unchanged', () => {
  const customNodes = [
    '/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWCustomNode',
  ];
  const store = makeStore({
    p2pConfig: {
      ...DEFAULT_P2P_CONFIG,
      p2p_bootstrap_nodes: customNodes,
    },
  });

  const config = getConfig(store);

  assert.deepEqual(config.p2p_bootstrap_nodes, customNodes);
  assert.equal(store.state.setP2PConfigCalls.length, 0);
  assert.equal(store.state.setCalls.length, 0);
});

test('getConfig does not force unrelated optional list fields to empty arrays', () => {
  const store = makeStore();

  const config = getConfig(store);

  assert.equal(config.p2p_selective_addresses, undefined);
  assert.equal(config.p2p_selective_paths, undefined);
  assert.equal(config.p2p_block_addresses, undefined);
  assert.equal(config.p2p_block_paths, undefined);
});
