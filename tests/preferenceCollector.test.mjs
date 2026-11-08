import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { H1, pid } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { collectPreferenceEvents } = require('../dist-electron/main/services/preference/collector.js');
const {
  // Egress-guard memo/probe state is process-wide; reset between tests.
  __resetProtocolPinFetchStateForTests,
} = require('../dist-electron/main/services/protocolPinFetch.js');

beforeEach(() => {
  __resetProtocolPinFetchStateForTests();
});

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const row = (id, segment, body, over = {}) => ({
  id,
  path: `/protocols/preference/${segment}`,
  globalMetaId: H1,
  genesisHeight: 200_500,
  txIndex: 0,
  timestamp: 1_792_000_100,
  contentBody: b64(body),
  ...over,
});
const FULL_REVEAL = { round: pid(1), commit: pid(2), salt: 'b'.repeat(64), ballot: { pairs: [] } };

const fakeIndexer = (pools, failing = new Set()) => (url) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/pin/path/list')) {
    const poolPath = parsed.searchParams.get('path');
    if (failing.has(poolPath)) return Promise.resolve(new Response('boom', { status: 500 }));
    const list = pools[poolPath] ?? [];
    const first = !parsed.searchParams.get('cursor');
    return Promise.resolve(new Response(JSON.stringify({ data: { list: first ? list : [], nextCursor: '', total: list.length } })));
  }
  if (parsed.pathname === `/content/${pid(3)}`) return Promise.resolve(new Response(JSON.stringify(FULL_REVEAL)));
  return Promise.resolve(new Response('not found', { status: 404 }));
};

const POOLS = {
  '/protocols/preference/round': [
    row(pid(1), 'round', { title: 'r' }),
    row(pid(9), 'round', { title: 'modified' }, { path: `@${pid(1)}` }),
  ],
  '/protocols/preference/commit': [row(pid(2), 'commit', { round: pid(1), hash: 'a'.repeat(64) })],
  '/protocols/preference/reveal': [
    row(pid(3), 'reveal', {}, {
      contentBody: '',
      contentSummary: '{"round":"',
      content: `https://manapi.metaid.io/content/${pid(3)}`,
      contentLength: '5000',
    }),
  ],
  '/protocols/preference/lesson': [],
};

test('collects the four pools, normalizes rows, and recovers truncated bodies', async () => {
  const result = await collectPreferenceEvents({ fetchImpl: fakeIndexer(POOLS), timeoutMs: 1000 });
  assert.deepEqual(result.perPath.map((entry) => [entry.segment, entry.count]), [
    ['round', 1],
    ['commit', 1],
    ['reveal', 1],
    ['lesson', 0],
  ]);
  assert.deepEqual(result.events.map((event) => event.path), ['round', 'commit', 'reveal']);
  const reveal = result.events.find((event) => event.path === 'reveal');
  assert.deepEqual(reveal.body, FULL_REVEAL);
  assert.equal(reveal.author, H1);
  assert.equal(reveal.height, 200_500);
  assert.equal(reveal.timestampMs, 1_792_000_100_000);
});

test('a failing pool is reported and does not sink the other pools', async () => {
  const failing = new Set(['/protocols/preference/lesson']);
  const result = await collectPreferenceEvents({ fetchImpl: fakeIndexer(POOLS, failing), timeoutMs: 1000 });
  assert.equal(result.events.length, 3);
  const lesson = result.perPath.find((entry) => entry.segment === 'lesson');
  assert.equal(typeof lesson.error, 'string');
});
