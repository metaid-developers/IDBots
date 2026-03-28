'use strict';

const DIRECT_EXECUTION_PATTERN = /确认交易|确定交易|确定执行|无需询问/i;
const SLIPPAGE_PATTERN = /滑点\s*([0-9]+(?:\.[0-9]+)?)\s*%/i;
const TOKEN_SYMBOL_PATTERN = /[A-Za-z][A-Za-z0-9]*/g;
const EXACT_OUT_PATTERN = /买到|得到\s*[0-9]+(?:\.[0-9]+)?\s*[A-Za-z][A-Za-z0-9]*/i;

function normalizeTokenSymbol(token) {
  return String(token || '').trim().toUpperCase();
}

function parseAmount(text) {
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z][A-Za-z0-9]*)/);
  if (!match) return { amount: '', amountUnit: '' };
  return {
    amount: match[1],
    amountUnit: normalizeTokenSymbol(match[2]),
  };
}

function parseTokenSymbol(text, amountUnit, direction) {
  const cleaned = String(text || '')
    .replace(/，|。|,|\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.match(TOKEN_SYMBOL_PATTERN) || [];
  const normalized = tokens.map(normalizeTokenSymbol);
  if (direction === 'space_to_token') {
    return normalized.find((token) => token !== 'SPACE') || '';
  }
  if (amountUnit && amountUnit !== 'SPACE') return amountUnit;
  return normalized.find((token) => token !== 'SPACE') || '';
}

function parseTradeIntent(input) {
  const text = String(input || '').trim();
  if (!text) {
    return { kind: 'unsupported', reason: 'Trade request is empty.' };
  }
  if (EXACT_OUT_PATTERN.test(text) && !/能换多少|大概能换多少|报价|预览/i.test(text)) {
    return { kind: 'unsupported', reason: 'Phase 1 only supports exact-in trades.' };
  }

  const { amount, amountUnit } = parseAmount(text);
  const direction = /卖出/.test(text) ? 'token_to_space' : 'space_to_token';
  const tokenSymbol = parseTokenSymbol(text, amountUnit, direction);
  const slippageMatch = text.match(SLIPPAGE_PATTERN);
  const slippagePercent = slippageMatch ? Number(slippageMatch[1]) : 1;
  const executeNow = DIRECT_EXECUTION_PATTERN.test(text);
  const isQuoteOnly = /能换多少|报价|大概/i.test(text);

  if (!amount || !amountUnit || !tokenSymbol) {
    return { kind: 'unsupported', reason: 'Could not parse a Phase 1 exact-in SPACE trade from this request.' };
  }

  return {
    kind: 'trade',
    quoteOnly: isQuoteOnly,
    direction,
    amount,
    amountUnit,
    tokenSymbol,
    slippagePercent,
    executeNow,
  };
}

module.exports = {
  parseTradeIntent,
};
