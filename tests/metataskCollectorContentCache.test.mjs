import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  // Egress-guard memo/probe state is process-wide; reset between tests.
  __resetProtocolPinFetchStateForTests,
} = require('../dist-electron/main/services/protocolPinFetch.js');
const {
  collectMetaTaskEvents,
  __resetMetataskContentCacheForTests,
} = require('../dist-electron/main/services/metatask/collector.js');

beforeEach(() => {
  __resetProtocolPinFetchStateForTests();
  __resetMetataskContentCacheForTests();
});

const PATH = '/protocols/metatask/submission';
const LONG_PIN_ID = 'pinlong000i0';
const FULL_BODY = JSON.stringify({
  taskid: 'task0001i0',
  node: 'find000',
  result: { type: 'negative', from: 1, to: 1_000_000_000_000_000_000, log: 'out/odd_run.log' },
  note: 'x'.repeat(400),
});
// What the indexer serves inline: contentSummary cut mid-JSON (parse fails →
// body {} → the row qualifies for content recovery, ticket 2026-11-10).
const TRUNCATED_SUMMARY = FULL_BODY.slice(0, 100);

const row = {
  id: LONG_PIN_ID,
  path: PATH,
  globalMetaId: 'idq1author',
  genesisHeight: 190_000,
  txIndex: 0,
  timestamp: 1_790_000_000_000,
  contentSummary: TRUNCATED_SUMMARY,
  contentBody: '',
  contentLength: FULL_BODY.length,
  content: `https://manapi.metaid.io/content/${LONG_PIN_ID}`,
};

const healthyRow = {
  id: 'pinshort001i0',
  path: PATH,
  globalMetaId: 'idq1author',
  genesisHeight: 190_000,
  txIndex: 1,
  timestamp: 1_790_000_000_001,
  // Small complete pin: contentBody carries the full payload, no content URL.
  contentBody: Buffer.from(JSON.stringify({ n: 1 })).toString('base64'),
};

/**
 * Pool walker + /content/ server. Counts /content/ downloads and captures the
 * User-Agent each content fetch sent; `failContent` simulates the network
 * being down for content downloads only.
 */
const makeIndexer = ({ contentCalls, userAgents, failContent = false }) => (url, init) => {
  const parsed = new URL(url);
  if (parsed.pathname === '/pin/path/list') {
    const poolPath = parsed.searchParams.get('path');
    const list = poolPath === PATH ? [row, healthyRow] : null;
    return Promise.resolve(new Response(JSON.stringify({
      data: { list, nextCursor: '' },
    }), { status: 200 }));
  }
  if (parsed.pathname === `/content/${LONG_PIN_ID}`) {
    contentCalls.count += 1;
    userAgents.push(init?.headers?.['User-Agent'] ?? null);
    if (failContent) return Promise.reject(new Error('network disabled'));
    return Promise.resolve(new Response(FULL_BODY, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }));
  }
  return Promise.resolve(new Response(`unexpected ${url}`, { status: 404 }));
};

test('a long pin body is downloaded once and served from cache on the next sweep', async () => {
  const contentCalls = { count: 0 };
  const userAgents = [];
  const first = await collectMetaTaskEvents({ fetchImpl: makeIndexer({ contentCalls, userAgents }) });
  assert.equal(contentCalls.count, 1, 'exactly one content download on the first sweep');
  const bodyFirst = first.events.find((e) => e.pinId === LONG_PIN_ID)?.body;
  assert.deepEqual(bodyFirst, JSON.parse(FULL_BODY), 'first sweep recovered the full body');
  assert.deepEqual(first.events.find((e) => e.pinId === 'pinshort001i0')?.body, { n: 1 }, 'healthy inline pin needs no download');

  // Second sweep: content network is DISCONNECTED — the recovered body must
  // come from the process-lifetime cache, not from a re-download.
  const second = await collectMetaTaskEvents({
    fetchImpl: makeIndexer({ contentCalls, userAgents, failContent: true }),
  });
  assert.equal(contentCalls.count, 1, 'no content download on the cached sweep');
  const bodySecond = second.events.find((e) => e.pinId === LONG_PIN_ID)?.body;
  assert.deepEqual(bodySecond, JSON.parse(FULL_BODY), 'cached sweep still carries the full body');
  assert.notEqual(bodyFirst, bodySecond, 'each sweep parses its own body object (no shared references)');
});

test('recovery fetches carry the IDBots tenant User-Agent', async () => {
  const contentCalls = { count: 0 };
  const userAgents = [];
  await collectMetaTaskEvents({ fetchImpl: makeIndexer({ contentCalls, userAgents }) });
  assert.ok(contentCalls.count >= 1, 'content was fetched');
  for (const ua of userAgents) {
    assert.match(ua, /^IDBots\//, 'content recovery identifies itself as IDBots/<ver>/<tenant>');
  }
});

test('resetting the cache makes the next sweep re-download', async () => {
  const contentCalls = { count: 0 };
  const userAgents = [];
  await collectMetaTaskEvents({ fetchImpl: makeIndexer({ contentCalls, userAgents }) });
  assert.equal(contentCalls.count, 1);
  __resetMetataskContentCacheForTests();
  await collectMetaTaskEvents({ fetchImpl: makeIndexer({ contentCalls, userAgents }) });
  assert.equal(contentCalls.count, 2, 'post-reset sweep fetches the body again');
});
