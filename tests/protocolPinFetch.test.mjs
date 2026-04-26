import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let fetchProtocolPinsFromIndexer;

test.before(async () => {
  ({ fetchProtocolPinsFromIndexer } = require('../dist-electron/services/protocolPinFetch.js'));
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('fetchProtocolPinsFromIndexer merges remote pins when local path list is non-empty but stale', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.startsWith('http://127.0.0.1:19099')) {
      return jsonResponse({
        code: 1,
        data: {
          list: [{
            id: 'local-old-pin',
            timestamp: 100,
            contentSummary: '{"paymentTxid":"local-old"}',
          }],
        },
      });
    }

    return jsonResponse({
      code: 1,
      data: {
        list: [
          {
            id: 'remote-new-pin',
            timestamp: 200,
            contentSummary: '{"paymentTxid":"remote-new"}',
          },
          {
            id: 'local-old-pin',
            timestamp: 100,
            contentSummary: '{"paymentTxid":"local-old-remote-copy"}',
          },
        ],
      },
    });
  };

  const pins = await fetchProtocolPinsFromIndexer('/protocols/service-refund-request', {
    localBaseUrl: 'http://127.0.0.1:19099',
    remoteBaseUrl: 'https://example.test',
    pageSize: 200,
    maxPages: 1,
    fetchImpl,
    selectContent: (item) => item.contentSummary,
  });

  assert.deepEqual(
    pins.map((pin) => [pin.pinId, pin.content, pin.timestampMs]),
    [
      ['remote-new-pin', '{"paymentTxid":"remote-new"}', 200_000],
      ['local-old-pin', '{"paymentTxid":"local-old"}', 100_000],
    ],
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^http:\/\/127\.0\.0\.1:19099\/api\/pin\/path\/list/);
  assert.match(calls[1], /^https:\/\/example\.test\/pin\/path\/list/);
});
