'use strict';

const Decimal = require('decimal.js');

const ASSET_DECIMALS = {
  BTC: 8,
  SPACE: 8,
  DOGE: 8,
};

const MIN_OUTPUT_BASE_UNITS = {
  BTC: 546n,
  SPACE: 600n,
  DOGE: 1_000_000n,
};

const SUPPORTED_PAIRS = new Set(['BTC/SPACE', 'DOGE/SPACE']);

function normalizePair(pair) {
  const normalized = String(pair || '').trim().toUpperCase();
  if (!SUPPORTED_PAIRS.has(normalized)) {
    throw new Error('unsupported pair');
  }
  return normalized;
}

function formatTrimmed(decimal, decimals = 8) {
  return decimal.toFixed(decimals).replace(/\.?0+$/, '');
}

function computeCrossRate(quotes, pair) {
  const normalized = normalizePair(pair);
  const base =
    normalized === 'BTC/SPACE'
      ? new Decimal(quotes?.btc ?? NaN)
      : new Decimal(quotes?.doge ?? NaN);
  const space = new Decimal(quotes?.space ?? NaN);
  if (!base.isFinite() || base.lte(0) || !space.isFinite() || space.lte(0)) {
    throw new Error('invalid quotes');
  }
  return base.div(space).toFixed(2);
}

function buildBidAsk({ mid, spreadBps }) {
  const midValue = new Decimal(mid);
  const spread = new Decimal(spreadBps).div(20000);
  const ask = midValue.mul(new Decimal(1).plus(spread));
  const bid = midValue.mul(new Decimal(1).minus(spread));
  return {
    ask: formatTrimmed(ask),
    bid: formatTrimmed(bid),
  };
}

function computeSkewBps({
  targetBase,
  currentBase,
  targetQuote,
  currentQuote,
  sensitivityBps,
  maxSkewBps,
}) {
  const targetBaseDec = new Decimal(targetBase);
  const currentBaseDec = new Decimal(currentBase);
  const targetQuoteDec = new Decimal(targetQuote);
  const currentQuoteDec = new Decimal(currentQuote);

  const baseDev = currentBaseDec.sub(targetBaseDec).div(targetBaseDec);
  const quoteDev = currentQuoteDec.sub(targetQuoteDec).div(targetQuoteDec);
  const pressure = quoteDev.sub(baseDev);
  const rawSkew = pressure.mul(new Decimal(sensitivityBps));

  const capped = Math.max(-maxSkewBps, Math.min(maxSkewBps, rawSkew.toNumber()));
  return Math.round(capped);
}

function resolveUsableInventory({ liveBalance, maxUsable }) {
  if (maxUsable === undefined || maxUsable === null) {
    return new Decimal(liveBalance ?? 0).toString();
  }
  const live = new Decimal(liveBalance ?? 0);
  const max = new Decimal(maxUsable);
  return Decimal.min(live, max).toString();
}

function isWithinSlippage({ quotedOutput, latestOutput, slippageBps }) {
  if (slippageBps === undefined || slippageBps === null) {
    return true;
  }
  const quoted = new Decimal(quotedOutput);
  const latest = new Decimal(latestOutput);
  const minAcceptable = quoted.mul(new Decimal(1).minus(new Decimal(slippageBps).div(10000)));
  return latest.gte(minAcceptable);
}

function parseBaseUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw new Error('output base units must be an integer string');
  }
  return BigInt(text);
}

function classifyOutputAmount({ assetOut, roundedOutputBaseUnits }) {
  const min = MIN_OUTPUT_BASE_UNITS[String(assetOut || '').toUpperCase()];
  if (min === undefined) {
    throw new Error('unsupported asset');
  }
  const value = parseBaseUnits(roundedOutputBaseUnits);
  return value >= min ? 'execute' : 'refund_required';
}

function roundExecutableOutput({ assetOut, rawOutput }) {
  const asset = String(assetOut || '').toUpperCase();
  const decimals = ASSET_DECIMALS[asset];
  if (decimals === undefined) {
    throw new Error('unsupported asset');
  }
  const scale = new Decimal(10).pow(decimals);
  const rounded = new Decimal(rawOutput).mul(scale).floor().div(scale);
  return rounded.toFixed(decimals);
}

module.exports = {
  computeCrossRate,
  buildBidAsk,
  computeSkewBps,
  isWithinSlippage,
  resolveUsableInventory,
  classifyOutputAmount,
  roundExecutableOutput,
};
