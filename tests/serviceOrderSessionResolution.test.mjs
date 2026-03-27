import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSessionOrderTxid,
  findMatchingOrderSessionId,
  resolveOrderSessionId,
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

test('resolveOrderSessionId prefers an explicit cowork_session_id over txid fallback', () => {
  const resolved = resolveOrderSessionId({
    directSessionId: 'session-direct',
    fallbackSessionId: 'session-fallback',
  });

  assert.equal(resolved, 'session-direct');
});

test('findMatchingOrderSessionId finds the newest matching a2a session by txid, metabot, and peer', () => {
  const txid = 'a'.repeat(64);
  const resolved = findMatchingOrderSessionId([
    {
      id: 'session-mismatch-peer',
      sessionType: 'a2a',
      metabotId: 9,
      peerGlobalMetaId: 'buyer-other',
      updatedAt: 500,
      messages: [{ content: `[ORDER] wrong peer\ntxid: ${txid}` }],
    },
    {
      id: 'session-match',
      sessionType: 'a2a',
      metabotId: 9,
      peerGlobalMetaId: 'buyer-1',
      updatedAt: 400,
      messages: [{ content: `[ORDER] right peer\ntxid: ${txid}` }],
    },
    {
      id: 'session-wrong-metabot',
      sessionType: 'a2a',
      metabotId: 10,
      peerGlobalMetaId: 'buyer-1',
      updatedAt: 900,
      messages: [{ content: `[ORDER] wrong metabot\ntxid: ${txid}` }],
    },
  ], {
    paymentTxid: txid,
    localMetabotId: 9,
    counterpartyGlobalMetaid: 'buyer-1',
  });

  assert.equal(resolved, 'session-match');
});
