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

test('selectProtocolPinContent prefers JSON-bearing summary over pin content URLs returned by pin lookup', () => {
  const payload = selectProtocolPinContent({
    content: 'https://manapi.metaid.io/content/1a25a54e7d51f3d9c3afbbe512b8548ef5f11acee9522f51fc7f508b435b74a4i0',
    contentBody: 'eyJwYXltZW50VHhpZCI6ImFiYyJ9',
    contentSummary: '{"paymentTxid":"abc"}',
  });

  assert.equal(payload, '{"paymentTxid":"abc"}');
});

test('extractSessionOrderTxid recovers the payment txid from a stored order message', () => {
  const txid = extractSessionOrderTxid([
    { content: 'hello' },
    { content: `[ORDER] need weather data\n支付金额 0.0001 SPACE\ntxid: ${'a'.repeat(64)}` },
  ]);

  assert.equal(txid, 'a'.repeat(64));
});
