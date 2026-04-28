const MRC20_SUFFIX = '-MRC20';
const MRC20_TICKER_PATTERN = /^[A-Z0-9]+$/;

function toSafeString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function deriveNativePaymentChain(protocolCurrency) {
  if (protocolCurrency === 'BTC') return 'btc';
  if (protocolCurrency === 'DOGE') return 'doge';
  return 'mvc';
}

function normalizeNativeCurrencyUnit(value) {
  const normalized = toSafeString(value).trim().toUpperCase();
  if (!normalized || normalized === 'MVC' || normalized === 'MICROVISIONCHAIN') return 'SPACE';
  if (normalized === 'BITCOIN') return 'BTC';
  if (normalized === 'DOGECOIN') return 'DOGE';
  return normalized;
}

function parseTickerFromProtocolCurrency(currency) {
  const normalized = toSafeString(currency).trim().toUpperCase();
  const match = /^([A-Z0-9]+)-MRC20$/.exec(normalized);
  return match?.[1] || '';
}

function normalizeMrc20Ticker(value) {
  const normalized = toSafeString(value).trim().toUpperCase();
  if (!normalized) {
    throw new Error('MRC20 ticker and mrc20Id are required');
  }
  if (!MRC20_TICKER_PATTERN.test(normalized)) {
    throw new Error('MRC20 ticker is invalid');
  }
  return normalized;
}

export function normalizeGigSquareSettlementDraft(input) {
  const primary = toSafeString(input?.currency).trim().toUpperCase();
  if (primary !== 'MRC20') {
    const protocolCurrency = normalizeNativeCurrencyUnit(primary);
    return {
      selectorCurrency: protocolCurrency,
      protocolCurrency,
      displayCurrency: protocolCurrency,
      settlementKind: 'native',
      paymentChain: deriveNativePaymentChain(protocolCurrency),
      mrc20Ticker: null,
      mrc20Id: null,
    };
  }

  const ticker = normalizeMrc20Ticker(input?.mrc20Ticker);
  const mrc20Id = toSafeString(input?.mrc20Id).trim();
  if (!mrc20Id) {
    throw new Error('MRC20 ticker and mrc20Id are required');
  }

  const protocolCurrency = `${ticker}${MRC20_SUFFIX}`;
  return {
    selectorCurrency: 'MRC20',
    protocolCurrency,
    displayCurrency: protocolCurrency,
    settlementKind: 'mrc20',
    paymentChain: 'btc',
    mrc20Ticker: ticker,
    mrc20Id,
  };
}

export function parseGigSquareSettlementAsset(input) {
  const protocolCurrencyRaw = toSafeString(
    input?.currency
    ?? input?.protocolCurrency
    ?? input?.paymentCurrency
  ).trim();
  const protocolCurrency = protocolCurrencyRaw.toUpperCase();
  const structuredKind = toSafeString(input?.settlementKind).trim().toLowerCase();
  const tickerFromCurrency = parseTickerFromProtocolCurrency(protocolCurrency);
  const hasMrc20Currency = Boolean(tickerFromCurrency);
  const isMrc20 = hasMrc20Currency || (!protocolCurrency && structuredKind === 'mrc20');

  if (!isMrc20) {
    const normalizedProtocolCurrency = normalizeNativeCurrencyUnit(protocolCurrency);
    return {
      selectorCurrency: normalizedProtocolCurrency,
      protocolCurrency: normalizedProtocolCurrency,
      displayCurrency: normalizedProtocolCurrency,
      settlementKind: 'native',
      paymentChain: deriveNativePaymentChain(normalizedProtocolCurrency),
      mrc20Ticker: null,
      mrc20Id: null,
    };
  }

  const providedTicker = toSafeString(input?.mrc20Ticker).trim();
  const mrc20Ticker = tickerFromCurrency
    || (providedTicker ? normalizeMrc20Ticker(providedTicker) : '');
  if (!mrc20Ticker) {
    throw new Error('MRC20 ticker and mrc20Id are required');
  }
  const normalizedProtocolCurrency = mrc20Ticker
    ? `${mrc20Ticker}${MRC20_SUFFIX}`
    : protocolCurrency;
  const mrc20Id = toSafeString(input?.mrc20Id).trim() || null;
  return {
    selectorCurrency: 'MRC20',
    protocolCurrency: normalizedProtocolCurrency,
    displayCurrency: normalizedProtocolCurrency,
    settlementKind: 'mrc20',
    paymentChain: 'btc',
    mrc20Ticker: mrc20Ticker || null,
    mrc20Id,
  };
}
