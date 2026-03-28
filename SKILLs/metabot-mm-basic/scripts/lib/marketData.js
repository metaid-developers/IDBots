'use strict';

const { computeCrossRate } = require('./pricing');

const MARKET_DATA_URL = 'https://www.metalet.space/wallet-api/v3/coin/price?net=mainnet';

let cachedQuotes = null;
let cachedAtMs = 0;

function validateQuote(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label} quote`);
  }
  return parsed;
}

async function fetchSpotQuotes({ fetchImpl }) {
  const fetcher = fetchImpl || fetch;
  const response = await fetcher(MARKET_DATA_URL);
  if (!response || !response.ok) {
    throw new Error('Market data request failed');
  }
  const json = await response.json();
  const payload = json && typeof json === 'object' && 'data' in json ? json.data : json;
  const btc = validateQuote(payload?.btc, 'btc');
  const doge = validateQuote(payload?.doge, 'doge');
  const space = validateQuote(payload?.space, 'space');
  return { btc, doge, space };
}

async function readSpotQuotes({ fetchImpl, now, cacheTtlMs } = {}) {
  const nowFn = now || Date.now;
  const ttl = Number(cacheTtlMs || 0);
  if (ttl > 0 && cachedQuotes && nowFn() - cachedAtMs <= ttl) {
    return cachedQuotes;
  }
  const quotes = await fetchSpotQuotes({ fetchImpl });
  cachedQuotes = quotes;
  cachedAtMs = nowFn();
  return quotes;
}

function isFallbackAllowed(mode, config) {
  if (mode === 'execute') {
    return config?.market_data?.execute_fallback_enabled === true;
  }
  return config?.market_data?.quote_fallback_enabled === true;
}

async function resolveFairValue({
  mode,
  config,
  pair,
  fetchImpl,
  now,
  cacheTtlMs,
} = {}) {
  try {
    const quotes = await readSpotQuotes({ fetchImpl, now, cacheTtlMs });
    if (pair) {
      return { fairValue: computeCrossRate(quotes, pair), source: 'market', quotes };
    }
    return { fairValue: null, source: 'market', quotes };
  } catch (error) {
    if (!isFallbackAllowed(mode, config)) {
      throw new Error('fallback fair value not allowed');
    }
    const fallback = pair && config?.pairs?.[pair]?.fair_value_fallback;
    if (fallback !== undefined && fallback !== null) {
      return { fairValue: String(fallback), source: 'fallback' };
    }
    return { fairValue: null, source: 'fallback' };
  }
}

module.exports = {
  readSpotQuotes,
  resolveFairValue,
};
