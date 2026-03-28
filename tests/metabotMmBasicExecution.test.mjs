import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePayload } = require('../SKILLs/metabot-mm-basic/scripts/lib/payload.js');

test('pair + direction are authoritative and reject conflicting asset_in', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '0.1', asset_in: 'DOGE' },
  }), /asset_in/i);
});

test('execute payload requires pay_txid, payer_globalmetaid, payout_address, and refund_address', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '0.1' },
  }), /pay_txid|payer_globalmetaid|payout_address|refund_address/i);
});

test('quote-confirm payload validates quote_context when has_prior_quote is true', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: {
      amount_in: '0.1',
      pay_txid: 'a'.repeat(64),
      payer_globalmetaid: 'gmid',
      payout_address: 'dest',
      refund_address: 'refund',
    },
    quote_context: { has_prior_quote: true, slippage_bps: 100 },
  }), /quoted_output|quoted_at/i);
});

test('quote payload may omit pair and direction only for supported-pair discovery', () => {
  const result = normalizePayload({
    mode: 'quote',
    query: { kind: 'supported_pairs' },
  });
  assert.equal(result.query.kind, 'supported_pairs');
});
