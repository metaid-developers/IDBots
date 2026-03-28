import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Decimal = require('decimal.js');
const {
  computeCrossRate,
  buildBidAsk,
  computeSkewBps,
  isWithinSlippage,
  resolveUsableInventory,
  classifyOutputAmount,
  roundExecutableOutput,
} = require('../SKILLs/metabot-mm-basic/scripts/lib/pricing.js');
const {
  readSpotQuotes,
  resolveFairValue,
} = require('../SKILLs/metabot-mm-basic/scripts/lib/marketData.js');

function failingFetch() {
  return Promise.reject(new Error('network unavailable'));
}

function mockFetchOnce(responseJson) {
  const fn = async () => {
    fn.callCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => responseJson,
    };
  };
  fn.callCount = 0;
  return fn;
}

function mockFetchDelayed(responseJson, delayMs = 10) {
  const fn = async () => {
    fn.callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ok: true,
      status: 200,
      json: async () => responseJson,
    };
  };
  fn.callCount = 0;
  return fn;
}

test('buildFairValue computes BTC/SPACE from btc and space USDT quotes', async () => {
  const quotes = { btc: 66960.15, space: 0.0502, doge: 0.0925 };
  assert.equal(computeCrossRate(quotes, 'BTC/SPACE'), '1333867.53');
});

test('buildFairValue preserves DOGE/SPACE precision', async () => {
  const quotes = { btc: 66960.15, space: 0.0502, doge: 0.0925 };
  assert.equal(computeCrossRate(quotes, 'DOGE/SPACE'), '1.842629');
});

test('quoteFromMid uses spread_bps as total spread', () => {
  const quote = buildBidAsk({ mid: 100, spreadBps: 200 });
  assert.equal(quote.ask, '101');
  assert.equal(quote.bid, '99');
});

test('inventory skew raises mid when SPACE is abundant and BTC is scarce', () => {
  const result = computeSkewBps({
    targetBase: '1',
    currentBase: '0.2',
    targetQuote: '100000',
    currentQuote: '140000',
    sensitivityBps: 500,
    maxSkewBps: 300,
  });
  assert.equal(result, 300);
});

test('slippage rejects execute when latest output is worse than quoted output beyond slippage_bps', () => {
  assert.equal(isWithinSlippage({
    quotedOutput: '1000',
    latestOutput: '989',
    slippageBps: 100,
  }), false);
});

test('fallback fair value is allowed for quote but blocked for execute when execute fallback is disabled', async () => {
  const cfg = {
    market_data: { quote_fallback_enabled: true, execute_fallback_enabled: false },
    pairs: { 'BTC/SPACE': { fair_value_fallback: 123 } },
  };
  await assert.doesNotReject(() => resolveFairValue({
    mode: 'quote',
    pair: 'BTC/SPACE',
    config: cfg,
    fetchImpl: failingFetch,
  }));
  await assert.rejects(() => resolveFairValue({
    mode: 'execute',
    pair: 'BTC/SPACE',
    config: cfg,
    fetchImpl: failingFetch,
  }), /fallback/i);
});

test('market data client reuses a short-lived cached quote within cache_ttl_ms', async () => {
  const fetchImpl = mockFetchOnce({ btc: 1, doge: 2, space: 3 });
  await readSpotQuotes({ now: () => 1000, cacheTtlMs: 5000, fetchImpl });
  await readSpotQuotes({ now: () => 1500, cacheTtlMs: 5000, fetchImpl });
  assert.equal(fetchImpl.callCount, 1);
});

test('market data client deduplicates concurrent fetches on a cache miss', async () => {
  const fetchImpl = mockFetchDelayed({ btc: 1, doge: 2, space: 3 }, 20);
  const [first, second] = await Promise.all([
    readSpotQuotes({ now: () => 1000, cacheTtlMs: 0, fetchImpl }),
    readSpotQuotes({ now: () => 1000, cacheTtlMs: 0, fetchImpl }),
  ]);
  assert.equal(fetchImpl.callCount, 1);
  assert.deepEqual(first, second);
});

test('usable inventory clips live balance by max_usable_inventory before skew and settlement checks', () => {
  const usable = resolveUsableInventory({ liveBalance: '1000', maxUsable: '600' });
  assert.equal(usable, '600');
});

test('rounded output below minimum transferable amount returns refund_required instead of execute', () => {
  const result = classifyOutputAmount({
    assetOut: 'BTC',
    roundedOutputBaseUnits: '545',
  });
  assert.equal(result, 'refund_required');
});

test('roundExecutableOutput floors output to supported asset precision before transfer and dust checks', () => {
  const result = roundExecutableOutput({
    assetOut: 'BTC',
    rawOutput: '0.123456789',
  });
  assert.equal(result, '0.12345678');
});

test('fallback rejects unsupported pair even when fallback is enabled', async () => {
  const cfg = {
    market_data: { quote_fallback_enabled: true, execute_fallback_enabled: true },
    pairs: { 'BTC/SPACE': { fair_value_fallback: 123 } },
  };
  await assert.rejects(() => resolveFairValue({
    mode: 'quote',
    pair: 'ABC/SPACE',
    config: cfg,
    fetchImpl: failingFetch,
  }), /unsupported pair/i);
});

test('fallback requires configured fair value when market data is unavailable', async () => {
  const cfg = { market_data: { quote_fallback_enabled: true, execute_fallback_enabled: true }, pairs: {} };
  await assert.rejects(() => resolveFairValue({
    mode: 'quote',
    pair: 'BTC/SPACE',
    config: cfg,
    fetchImpl: failingFetch,
  }), /fair value/i);
});

test('fallback rejects invalid fair_value_fallback values', async () => {
  const cfg = {
    market_data: { quote_fallback_enabled: true, execute_fallback_enabled: true },
    pairs: { 'BTC/SPACE': { fair_value_fallback: '-1' } },
  };
  await assert.rejects(() => resolveFairValue({
    mode: 'quote',
    pair: 'BTC/SPACE',
    config: cfg,
    fetchImpl: failingFetch,
  }), /fair value/i);
});

test('rounded output below minimum transferable amount triggers refund after round-down', () => {
  const rounded = roundExecutableOutput({
    assetOut: 'BTC',
    rawOutput: '0.000005459',
  });
  const roundedUnits = BigInt(new Decimal(rounded).mul(1e8).toFixed(0));
  const result = classifyOutputAmount({
    assetOut: 'BTC',
    roundedOutputBaseUnits: roundedUnits.toString(),
  });
  assert.equal(rounded, '0.00000545');
  assert.equal(result, 'refund_required');
});
