import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

test('buildFairValue computes BTC/SPACE from btc and space USDT quotes', async () => {
  const quotes = { btc: 66960.15, space: 0.0502, doge: 0.0925 };
  assert.equal(computeCrossRate(quotes, 'BTC/SPACE'), '1333867.53');
});

test('quoteFromMid uses spread_bps as total spread', () => {
  const quote = buildBidAsk({ mid: 100, spreadBps: 200 });
  assert.equal(quote.ask, '101');
  assert.equal(quote.bid, '99');
});

test('inventory skew raises mid when SPACE is abundant and BTC is scarce', () => {
  const result = computeSkewBps({
    targetBase: '1',
    currentBase: '0.8',
    targetQuote: '100000',
    currentQuote: '120000',
    sensitivityBps: 500,
    maxSkewBps: 300,
  });
  assert.equal(result, 200);
});

test('slippage rejects execute when latest output is worse than quoted output beyond slippage_bps', () => {
  assert.equal(isWithinSlippage({
    quotedOutput: '1000',
    latestOutput: '989',
    slippageBps: 100,
  }), false);
});

test('fallback fair value is allowed for quote but blocked for execute when execute fallback is disabled', async () => {
  const cfg = { market_data: { quote_fallback_enabled: true, execute_fallback_enabled: false } };
  await assert.doesNotReject(() => resolveFairValue({ mode: 'quote', config: cfg, fetchImpl: failingFetch }));
  await assert.rejects(() => resolveFairValue({ mode: 'execute', config: cfg, fetchImpl: failingFetch }), /fallback/i);
});

test('market data client reuses a short-lived cached quote within cache_ttl_ms', async () => {
  const fetchImpl = mockFetchOnce({ btc: 1, doge: 2, space: 3 });
  await readSpotQuotes({ now: () => 1000, cacheTtlMs: 5000, fetchImpl });
  await readSpotQuotes({ now: () => 1500, cacheTtlMs: 5000, fetchImpl });
  assert.equal(fetchImpl.callCount, 1);
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
