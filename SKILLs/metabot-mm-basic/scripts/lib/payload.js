'use strict';

const ASSET_DECIMALS = {
  BTC: 8,
  SPACE: 8,
  DOGE: 8,
};

const SUPPORTED_PAIRS = new Set(['BTC/SPACE', 'DOGE/SPACE']);

function parsePair(pair) {
  if (typeof pair !== 'string') {
    throw new Error('pair is required.');
  }

  const [baseRaw, quoteRaw] = pair.split('/');
  const base = String(baseRaw || '').trim().toUpperCase();
  const quote = String(quoteRaw || '').trim().toUpperCase();

  if (!base || !quote) {
    throw new Error('pair must be in BASE/QUOTE format.');
  }

  const normalizedPair = `${base}/${quote}`;
  if (!SUPPORTED_PAIRS.has(normalizedPair)) {
    throw new Error('unsupported pair.');
  }

  return { base, quote };
}

function deriveAssets(pair, direction) {
  if (typeof direction !== 'string') {
    throw new Error('direction is required.');
  }

  const { base, quote } = parsePair(pair);
  const normalizedDirection = direction.trim().toLowerCase();
  const forward = `${base.toLowerCase()}_to_${quote.toLowerCase()}`;
  const reverse = `${quote.toLowerCase()}_to_${base.toLowerCase()}`;

  if (normalizedDirection === forward) {
    return { assetIn: base, assetOut: quote };
  }

  if (normalizedDirection === reverse) {
    return { assetIn: quote, assetOut: base };
  }

  throw new Error('direction does not match pair.');
}

function countFractionalDigits(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return 0;
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error('amount_in must be a numeric string.');
  }

  const [, fractional = ''] = text.split('.');
  return fractional.length;
}

function ensurePrecision(amountIn, assetIn) {
  if (amountIn === undefined || amountIn === null) {
    return;
  }

  const maxDecimals = ASSET_DECIMALS[assetIn];
  if (maxDecimals === undefined) {
    throw new Error('unsupported asset.');
  }
  const fractionalDigits = countFractionalDigits(amountIn);
  if (fractionalDigits > maxDecimals) {
    throw new Error('amount_in exceeds supported precision.');
  }
}

function ensureExecuteFields(order) {
  const required = ['pay_txid', 'payer_globalmetaid', 'payout_address', 'refund_address'];
  const missing = required.filter((key) => !order[key]);
  if (missing.length > 0) {
    throw new Error(`execute order missing ${missing.join(', ')}`);
  }
}

function normalizeQuoteContext(quoteContext) {
  if (!quoteContext || typeof quoteContext !== 'object') {
    return quoteContext;
  }

  if (quoteContext.has_prior_quote) {
    if (!quoteContext.quoted_output || !quoteContext.quoted_at) {
      throw new Error('quote_context requires quoted_output and quoted_at when has_prior_quote is true.');
    }
  }

  return quoteContext;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required.');
  }

  if (!payload.mode || (payload.mode !== 'quote' && payload.mode !== 'execute')) {
    throw new Error('mode must be quote or execute.');
  }

  if (
    payload.mode === 'quote'
    && payload.query?.kind === 'supported_pairs'
    && (!payload.service || (!payload.service.pair && !payload.service.direction))
  ) {
    return {
      ...payload,
      query: { kind: 'supported_pairs' },
    };
  }

  if (!payload.service || !payload.service.pair || !payload.service.direction) {
    throw new Error('service.pair and service.direction are required.');
  }

  const { assetIn, assetOut } = deriveAssets(payload.service.pair, payload.service.direction);
  const order = { ...(payload.order || {}) };

  if (!order.amount_in) {
    throw new Error('amount_in is required.');
  }

  if (order.asset_in && String(order.asset_in).toUpperCase() !== assetIn) {
    throw new Error('asset_in does not match pair + direction.');
  }

  order.asset_in = assetIn;
  order.asset_out = assetOut;

  ensurePrecision(order.amount_in, assetIn);

  if (payload.mode === 'execute') {
    ensureExecuteFields(order);
  }

  const normalized = {
    ...payload,
    service: { ...payload.service },
    order,
  };

  if (payload.quote_context) {
    normalized.quote_context = normalizeQuoteContext(payload.quote_context);
  }

  return normalized;
}

module.exports = {
  normalizePayload,
};
