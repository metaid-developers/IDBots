'use strict';

const { computeCrossRate } = require('./pricing');

const MARKET_DATA_URL = 'https://www.metalet.space/wallet-api/v3/coin/price?net=mainnet';
const SUPPORTED_PAIRS = new Set(['BTC/SPACE', 'DOGE/SPACE']);

let cachedQuotes = null;
let cachedAtMs = 0;
let inFlightQuotes = null;

function validateQuote(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label} quote`);
  }
  return parsed;
}

function ensureSupportedPair(pair) {
  const normalized = String(pair || '').trim().toUpperCase();
  if (!SUPPORTED_PAIRS.has(normalized)) {
    throw new Error('unsupported pair');
  }
  return normalized;
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
  if (inFlightQuotes) {
    return inFlightQuotes;
  }
  inFlightQuotes = fetchSpotQuotes({ fetchImpl }).then((quotes) => {
    cachedQuotes = quotes;
    cachedAtMs = nowFn();
    return quotes;
  }).finally(() => {
    inFlightQuotes = null;
  });
  return inFlightQuotes;
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
  const normalizedPair = pair ? ensureSupportedPair(pair) : null;
  try {
    const quotes = await readSpotQuotes({ fetchImpl, now, cacheTtlMs });
    if (normalizedPair) {
      return { fairValue: computeCrossRate(quotes, normalizedPair), source: 'market', quotes };
    }
    return { fairValue: null, source: 'market', quotes };
  } catch (error) {
    if (!isFallbackAllowed(mode, config)) {
      throw new Error('fallback fair value not allowed');
    }
    const fallback = normalizedPair && config?.pairs?.[normalizedPair]?.fair_value_fallback;
    if (fallback === undefined || fallback === null) {
      throw new Error('fallback fair value unavailable');
    }
    const parsed = typeof fallback === 'number' ? fallback : Number(fallback);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('fallback fair value invalid');
    }
    return { fairValue: String(fallback), source: 'fallback' };
  }
}

module.exports = {
  readSpotQuotes,
  resolveFairValue,
};
