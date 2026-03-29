import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveConfigPath,
  validateConfig,
  loadConfig,
} = require('../SKILLs/metabot-mm-basic/scripts/lib/config.js');

function createEnv() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-mm-basic-'));
  return { tmpRoot, env: { IDBOTS_USER_DATA_PATH: tmpRoot } };
}

function writeConfig(tmpRoot, value) {
  const configDir = path.join(tmpRoot, 'metabot-mm-basic');
  fs.mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test('resolveConfigPath defaults to userData/metabot-mm-basic/config.json', () => {
  const result = resolveConfigPath({
    env: { IDBOTS_USER_DATA_PATH: '/tmp/idbots-user' },
  });
  assert.equal(result, '/tmp/idbots-user/metabot-mm-basic/config.json');
});

test('config rejects non-boolean fallback flags', () => {
  assert.throws(() => validateConfig({
    market_data: {
      provider: 'cex',
      quote_fallback_enabled: 'true',
      execute_fallback_enabled: 1,
    },
    pairs: {
      'BTC/SPACE': {
        target_inventory: { BTC: '1', SPACE: '1' },
        trade_limits: { min_in_BTC: '0.1', max_in_BTC: '1', min_in_SPACE: '1', max_in_SPACE: '10' },
        max_usable_inventory: { BTC: '1', SPACE: '1' },
      },
    },
  }), /quote_fallback_enabled|execute_fallback_enabled/i);
});

test('config rejects invalid pair inventory and trade-limit asset keys', () => {
  assert.throws(() => validateConfig({
    market_data: {
      provider: 'cex',
      quote_fallback_enabled: true,
      execute_fallback_enabled: false,
    },
    pairs: {
      'BTC/SPACE': {
        target_inventory: { BTC: '1' },
        trade_limits: { min_in_BTC: '0', max_in_BTC: '-1', min_in_DOGE: '1', max_in_DOGE: '10' },
        max_usable_inventory: { BTC: '0', SPACE: '1' },
      },
    },
  }), /target_inventory|trade_limits|max_usable_inventory/i);
});

test('config rejects inverted trade-limit ranges', () => {
  assert.throws(() => validateConfig({
    market_data: {
      provider: 'cex',
      quote_fallback_enabled: true,
      execute_fallback_enabled: false,
    },
    pairs: {
      'BTC/SPACE': {
        target_inventory: { BTC: '1', SPACE: '1' },
        trade_limits: { min_in_BTC: '2', max_in_BTC: '1', min_in_SPACE: '1', max_in_SPACE: '10' },
        max_usable_inventory: { BTC: '1', SPACE: '1' },
      },
    },
  }), /trade_limits/i);
});

test('loadConfig validates parsed config before returning', () => {
  const { tmpRoot, env } = createEnv();
  writeConfig(tmpRoot, { pairs: { 'BTC/SPACE': { spread_bps: 200 } }, market_data: { provider: 'cex' } });
  assert.throws(() => loadConfig({ env }), /Invalid config/i);
});

test('loadConfig rereads the JSON file on each quote/execute call instead of caching stale operator edits', () => {
  const { tmpRoot, env } = createEnv();
  writeConfig(tmpRoot, {
    market_data: { provider: 'cex', quote_fallback_enabled: true, execute_fallback_enabled: false },
    pairs: {
      'BTC/SPACE': {
        spread_bps: 200,
        target_inventory: { BTC: '1', SPACE: '1' },
        trade_limits: { min_in_BTC: '0.1', max_in_BTC: '1', min_in_SPACE: '1', max_in_SPACE: '10' },
        max_usable_inventory: { BTC: '1', SPACE: '1' },
      },
    },
  });
  const first = loadConfig({ env });
  writeConfig(tmpRoot, {
    market_data: { provider: 'cex', quote_fallback_enabled: true, execute_fallback_enabled: false },
    pairs: {
      'BTC/SPACE': {
        spread_bps: 300,
        target_inventory: { BTC: '1', SPACE: '1' },
        trade_limits: { min_in_BTC: '0.1', max_in_BTC: '1', min_in_SPACE: '1', max_in_SPACE: '10' },
        max_usable_inventory: { BTC: '1', SPACE: '1' },
      },
    },
  });
  const second = loadConfig({ env });
  assert.equal(first.pairs['BTC/SPACE'].spread_bps, 200);
  assert.equal(second.pairs['BTC/SPACE'].spread_bps, 300);
});

test('config example file stays in sync with the runtime schema', () => {
  const examplePath = path.resolve(process.cwd(), 'SKILLs', 'metabot-mm-basic', 'config.example.json');
  const raw = fs.readFileSync(examplePath, 'utf8');
  const parsed = JSON.parse(raw);
  const validated = validateConfig(parsed);

  assert.equal(validated.market_data.provider, 'cex');
  assert.ok(validated.pairs['BTC/SPACE']);
  assert.ok(validated.pairs['DOGE/SPACE']);
});
