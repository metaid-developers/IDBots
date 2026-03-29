'use strict';

const { parseArgs } = require('node:util');

const NUMBER_PATTERN = /^\d+(\.\d+)?$/;
const ACTIONS = new Set(['quote', 'preview', 'execute']);
const DIRECTIONS = new Set(['space_to_token', 'token_to_space']);
const USAGE = 'Usage: node index.js --action <quote|preview|execute> --direction <space_to_token|token_to_space> --amount-in "<decimal>" --token-symbol "<symbol>" [--slippage-percent "<decimal>"]';

function normalizeTokenSymbol(token) {
  return String(token || '').trim().toUpperCase();
}

function fail(message) {
  const error = new Error(message);
  error.isUsageError = true;
  throw error;
}

function parseTradeCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: Array.isArray(argv) ? argv : [],
    options: {
      action: { type: 'string' },
      direction: { type: 'string' },
      'amount-in': { type: 'string' },
      'token-symbol': { type: 'string' },
      'slippage-percent': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    return { help: true };
  }

  for (const positional of positionals) {
    if (String(positional || '').trim()) {
      fail(`Unexpected positional argument: ${positional}`);
    }
  }

  const action = String(values.action || '').trim().toLowerCase();
  const direction = String(values.direction || '').trim().toLowerCase();
  const amountIn = String(values['amount-in'] || '').trim();
  const tokenSymbol = normalizeTokenSymbol(values['token-symbol']);
  const rawSlippage = values['slippage-percent'] == null
    ? '1'
    : String(values['slippage-percent']).trim();

  if (!ACTIONS.has(action)) {
    fail('--action is required and must be one of: quote, preview, execute');
  }
  if (!DIRECTIONS.has(direction)) {
    fail('--direction is required and must be one of: space_to_token, token_to_space');
  }
  if (!amountIn || !NUMBER_PATTERN.test(amountIn) || Number(amountIn) <= 0) {
    fail('--amount-in is required and must be a positive decimal');
  }
  if (!tokenSymbol || tokenSymbol === 'SPACE') {
    fail('--token-symbol is required and must be the non-SPACE token symbol');
  }
  if (!rawSlippage || !NUMBER_PATTERN.test(rawSlippage) || Number(rawSlippage) < 0) {
    fail('--slippage-percent must be a non-negative decimal');
  }

  return {
    action,
    direction,
    amountIn,
    tokenSymbol,
    slippagePercent: Number(rawSlippage),
  };
}

module.exports = {
  USAGE,
  parseTradeCliArgs,
};
