'use strict';

const { parseArgs } = require('node:util');

const ACTIONS = new Set([
  'overview',
  'orders',
  'trades',
  'wallet',
  'my-orders',
  'my-trades',
  'buy-lowest',
  'mint',
  'list',
  'cancel',
]);

const USAGE = [
  'Usage: node index.js --action <overview|orders|trades|wallet|my-orders|my-trades|buy-lowest|mint|list|cancel> [options]',
  '',
  'Options:',
  '  --action <name>             required action name',
  '  --token-symbol <symbol>     token symbol like METAID or $METAID',
  '  --quantity <decimal>        token quantity for list/buy filters',
  '  --unit-price-btc <decimal>  per-token BTC price for list',
  '  --order-id <id>             order id for cancel',
  '  --network <mainnet|testnet> default: mainnet',
  '  --network-fee-rate <int>    optional BTC network fee rate (sat/vB)',
  '  --limit <int>               number of rows for query actions, default: 10',
  '  --metabot-name <name>       optional MetaBot identity hint when env is absent',
  '  -h, --help                  show this message',
].join('\n');

function fail(message) {
  throw new Error(message);
}

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: Array.isArray(argv) ? argv : [],
    options: {
      action: { type: 'string' },
      'token-symbol': { type: 'string' },
      quantity: { type: 'string' },
      'unit-price-btc': { type: 'string' },
      'order-id': { type: 'string' },
      network: { type: 'string' },
      'network-fee-rate': { type: 'string' },
      limit: { type: 'string' },
      'metabot-name': { type: 'string' },
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

  const action = String(values.action || '').trim();
  if (!ACTIONS.has(action)) {
    fail('--action is required and must be one of: overview, orders, trades, wallet, my-orders, my-trades, buy-lowest, mint, list, cancel');
  }

  const request = {
    action,
    tokenSymbol: values['token-symbol'] ? String(values['token-symbol']).trim() : '',
    quantity: values.quantity ? String(values.quantity).trim() : '',
    unitPriceBtc: values['unit-price-btc'] ? String(values['unit-price-btc']).trim() : '',
    orderId: values['order-id'] ? String(values['order-id']).trim() : '',
    network: values.network ? String(values.network).trim() : 'mainnet',
    networkFeeRate: values['network-fee-rate'] ? Number(values['network-fee-rate']) : undefined,
    limit: values.limit ? Number(values.limit) : 10,
    metabotName: values['metabot-name'] ? String(values['metabot-name']).trim() : '',
  };

  if (['overview', 'orders', 'trades', 'wallet', 'my-orders', 'my-trades', 'buy-lowest', 'mint', 'list'].includes(action) && !request.tokenSymbol) {
    fail('--token-symbol is required for this action');
  }
  if (action === 'list') {
    if (!request.quantity) fail('--quantity is required for list');
    if (!request.unitPriceBtc) fail('--unit-price-btc is required for list');
  }
  if (action === 'cancel' && !request.orderId) {
    fail('--order-id is required for cancel');
  }
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
    fail('--limit must be an integer between 1 and 50');
  }
  if (request.networkFeeRate != null && (!Number.isFinite(request.networkFeeRate) || request.networkFeeRate <= 0)) {
    fail('--network-fee-rate must be a positive number');
  }

  return request;
}

module.exports = {
  USAGE,
  parseCliArgs,
};
