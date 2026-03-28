'use strict';

const { gzipSync } = require('node:zlib');

const MvCSWAP_BASE = 'https://api.mvcswap.com';

async function readJsonResponse(response) {
  const json = await response.json();
  if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
    throw new Error(json.msg || json.message || 'mvcswap request failed');
  }
  return json;
}

async function fetchAllPairs({ fetchImpl }) {
  const response = await fetchImpl(`${MvCSWAP_BASE}/swap/allpairs`, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  return readJsonResponse(response);
}

function resolveSpacePair({ pairs, tokenSymbol, direction }) {
  const entries = Object.entries(pairs || {});
  const normalizedToken = String(tokenSymbol || '').toLowerCase();
  for (const [symbol, pair] of entries) {
    const token1 = String(pair?.token1?.symbol || '').toLowerCase();
    const token2 = String(pair?.token2?.symbol || '').toLowerCase();
    if (direction === 'space_to_token' && token1 === 'space' && token2 === normalizedToken) {
      return { symbol, pair, token: pair.token2 };
    }
    if (direction === 'token_to_space' && token1 === 'space' && token2 === normalizedToken) {
      return { symbol, pair, token: pair.token2 };
    }
  }
  throw new Error(`Current mvcswap pair does not support SPACE/${String(tokenSymbol || '').toUpperCase()}.`);
}

async function quoteRoute({ direction, tokenSymbol, amount, inputDecimals, fetchImpl }) {
  const tokenIn = direction === 'space_to_token' ? 'space' : String(tokenSymbol || '').toLowerCase();
  const tokenOut = direction === 'space_to_token' ? String(tokenSymbol || '').toLowerCase() : 'space';
  const amountBase = toBaseUnits(amount, inputDecimals);
  const response = await fetchImpl(
    `${MvCSWAP_BASE}/router/route?tokenIn=${encodeURIComponent(tokenIn)}&tokenOut=${encodeURIComponent(tokenOut)}&amount=${encodeURIComponent(amountBase)}`,
  );
  const json = await readJsonResponse(response);
  return json.data;
}

async function requestSwapArgs({ symbol, address, op, fetchImpl }) {
  const response = await fetchImpl(`${MvCSWAP_BASE}/swap/reqswapargs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol,
      address,
      op,
      source: 'idbots-metabot-trade-mvcswap',
    }),
  });
  const json = await readJsonResponse(response);
  return json.data;
}

async function executeToken1ToToken2({ body, fetchImpl }) {
  const compressed = gzipSync(JSON.stringify(body));
  const response = await fetchImpl(`${MvCSWAP_BASE}/swap/token1totoken2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: compressed }),
  });
  const json = await readJsonResponse(response);
  return json.data;
}

async function executeToken2ToToken1({ body, fetchImpl }) {
  const compressed = gzipSync(JSON.stringify(body));
  const response = await fetchImpl(`${MvCSWAP_BASE}/swap/token2totoken1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: compressed }),
  });
  const json = await readJsonResponse(response);
  return json.data;
}

function toBaseUnits(amount, decimals) {
  const [whole, fraction = ''] = String(amount).split('.');
  const padded = `${fraction}${'0'.repeat(decimals)}`.slice(0, decimals);
  return `${whole}${padded}`.replace(/^0+(?=\d)/, '') || '0';
}

function fromBaseUnits(amount, decimals) {
  const raw = String(amount || '0').replace(/^0+(?=\d)/, '') || '0';
  if (raw.length <= decimals) {
    return `0.${raw.padStart(decimals, '0')}`.replace(/\.?0+$/, '');
  }
  const whole = raw.slice(0, raw.length - decimals);
  const fraction = raw.slice(raw.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

module.exports = {
  fetchAllPairs,
  resolveSpacePair,
  quoteRoute,
  requestSwapArgs,
  executeToken1ToToken2,
  executeToken2ToToken1,
  toBaseUnits,
  fromBaseUnits,
};
