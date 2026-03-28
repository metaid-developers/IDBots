import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { parseTradeIntent } = require('../SKILLs/metabot-trade-mvcswap/scripts/lib/intent.js');

test('parseTradeIntent extracts SPACE -> token buy intent with executeNow confirmation', () => {
  const intent = parseTradeIntent('帮我买 10 SPACE 的 MC，确定交易');

  assert.equal(intent.kind, 'trade');
  assert.equal(intent.direction, 'space_to_token');
  assert.equal(intent.amount, '10');
  assert.equal(intent.amountUnit, 'SPACE');
  assert.equal(intent.tokenSymbol, 'MC');
  assert.equal(intent.executeNow, true);
  assert.equal(intent.slippagePercent, 1);
});

test('parseTradeIntent extracts token -> SPACE sell intent and custom slippage', () => {
  const intent = parseTradeIntent('卖出 500 MC 换 SPACE，滑点 0.5%');

  assert.equal(intent.kind, 'trade');
  assert.equal(intent.direction, 'token_to_space');
  assert.equal(intent.amount, '500');
  assert.equal(intent.amountUnit, 'MC');
  assert.equal(intent.tokenSymbol, 'MC');
  assert.equal(intent.executeNow, false);
  assert.equal(intent.slippagePercent, 0.5);
});

test('parseTradeIntent rejects exact-out phrasing in phase 1', () => {
  const intent = parseTradeIntent('我要买到 2000 MC');

  assert.equal(intent.kind, 'unsupported');
  assert.match(intent.reason, /exact-in/i);
});
