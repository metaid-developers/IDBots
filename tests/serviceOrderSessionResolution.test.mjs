import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSessionOrderTxid,
  selectProtocolPinContent,
} from '../src/main/services/serviceOrderSessionResolution.js';

test('selectProtocolPinContent falls back to contentSummary when content is an empty string', () => {
  const payload = selectProtocolPinContent({
    content: '',
    contentSummary: '{"paymentTxid":"a'.padEnd(80, 'a'),
  });

  assert.equal(typeof payload, 'string');
  assert.match(payload, /paymentTxid/);
});

test('extractSessionOrderTxid recovers the payment txid from a stored order message', () => {
  const txid = extractSessionOrderTxid([
    { content: 'hello' },
    { content: `[ORDER] need weather data\n支付金额 0.0001 SPACE\ntxid: ${'a'.repeat(64)}` },
  ]);

  assert.equal(txid, 'a'.repeat(64));
});
