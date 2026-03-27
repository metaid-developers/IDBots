import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let metaidRpcEndpoint;
try {
  metaidRpcEndpoint = require('../dist-electron/services/metaidRpcEndpoint.js');
} catch {
  metaidRpcEndpoint = null;
}

test('resolveMetaidRpcPort() honors IDBOTS_METAID_RPC_PORT override', () => {
  assert.equal(
    typeof metaidRpcEndpoint?.resolveMetaidRpcPort,
    'function',
    'resolveMetaidRpcPort() should be exported',
  );

  const port = metaidRpcEndpoint.resolveMetaidRpcPort({
    IDBOTS_METAID_RPC_PORT: '41234',
  });

  assert.equal(port, 41234);
});

test('getMetaidRpcBase() falls back to default when override is invalid', () => {
  assert.equal(
    typeof metaidRpcEndpoint?.getMetaidRpcBase,
    'function',
    'getMetaidRpcBase() should be exported',
  );

  const base = metaidRpcEndpoint.getMetaidRpcBase({
    IDBOTS_METAID_RPC_PORT: '99999',
  });

  assert.equal(base, 'http://127.0.0.1:31200');
});
