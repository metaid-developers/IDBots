import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { parseTradeCliArgs } = require('../SKILLs/metabot-trade-mvcswap/scripts/lib/cli.js');

test('parseTradeCliArgs parses a SPACE -> token quote request with explicit slippage', () => {
  const request = parseTradeCliArgs([
    '--action', 'quote',
    '--direction', 'space_to_token',
    '--amount-in', '10',
    '--token-symbol', 'mc',
    '--slippage-percent', '0.5',
  ]);

  assert.deepEqual(request, {
    action: 'quote',
    direction: 'space_to_token',
    amountIn: '10',
    tokenSymbol: 'MC',
    slippagePercent: 0.5,
    metabotIdCli: null,
  });
});

test('parseTradeCliArgs uses the default slippage percent when omitted', () => {
  const request = parseTradeCliArgs([
    '--action', 'preview',
    '--direction', 'token_to_space',
    '--amount-in', '500',
    '--token-symbol', 'DOGE',
  ]);

  assert.equal(request.action, 'preview');
  assert.equal(request.direction, 'token_to_space');
  assert.equal(request.amountIn, '500');
  assert.equal(request.tokenSymbol, 'DOGE');
  assert.equal(request.slippagePercent, 1);
  assert.equal(request.metabotIdCli, null);
});

test('parseTradeCliArgs accepts optional --metabot-id', () => {
  const request = parseTradeCliArgs([
    '--action', 'execute',
    '--direction', 'space_to_token',
    '--amount-in', '1',
    '--token-symbol', 'METAID',
    '--metabot-id', '42',
  ]);

  assert.equal(request.metabotIdCli, 42);
});

test('parseTradeCliArgs rejects missing required flags', () => {
  assert.throws(
    () => parseTradeCliArgs(['--action', 'quote', '--direction', 'space_to_token']),
    /amount-in/i,
  );
});
