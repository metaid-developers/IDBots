import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  fetchProtocolPinsFromIndexer,
  // Egress-guard memo/probe state is process-wide; reset between tests.
  __resetProtocolPinFetchStateForTests,
} = require('../dist-electron/main/services/protocolPinFetch.js');
const { collectMetaTaskEvents } = require('../dist-electron/main/services/metatask/collector.js');

beforeEach(() => {
  __resetProtocolPinFetchStateForTests();
});

const PATH = '/protocols/metatask/submission';

const rows = (n) => Array.from({ length: n }, (_, i) => ({
  id: `pin${String(i).padStart(3, '0')}i0`,
  path: PATH,
  globalMetaId: 'idq1author',
  genesisHeight: 190_000,
  txIndex: i,
  timestamp: 1_790_000_000_000 + i,
  contentBody: Buffer.from(JSON.stringify({ n: i })).toString('base64'),
}));

/** Serves one page fine, then 500s on the SECOND page once per failure token. */
const flakyIndexer = (totalRows, failTokens) => {
  let page = 0;
  return (url) => {
    const parsed = new URL(url);
    const cursor = Number(parsed.searchParams.get('cursor') || 0);
    const token = `${cursor}`;
    if (failTokens.delete(token)) {
      return Promise.resolve(new Response('boom', { status: 500 }));
    }
    const list = rows(totalRows).slice(cursor, cursor + 3);
    const next = cursor + 3;
    return Promise.resolve(new Response(JSON.stringify({
      data: { list, nextCursor: next < totalRows ? String(next) : '' },
    }), { status: 200 }));
  };
};

test('mid-walk fetch failure is reported, not silent', async () => {
  const reports = [];
  const records = await fetchProtocolPinsFromIndexer(PATH, {
    pageSize: 100,
    maxPages: 1000,
    timeoutMs: 1000,
    localBaseUrl: '',
    fetchImpl: flakyIndexer(30, new Set(['3'])),
    onTruncated: (info) => reports.push(info),
  });
  assert.equal(records.length, 3, 'partial prefix only');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, 'fetch-error');
});

test('collector retries a failed pool walk and recovers the full pool', async () => {
  // the fetcher fails the FIRST page request once; the second sweep attempt succeeds
  const failTokens = new Set(['0']);
  const { events, perPath } = await collectMetaTaskEvents({ timeoutMs: 1000, maxPages: 1000, fetchImpl: flakyIndexer(10, failTokens) });
  const sub = perPath.find((x) => x.path === 'submission');
  assert.equal(sub.count, 10, 'pool fully collected after the in-collector retry');
  assert.equal(sub.error, undefined, 'recovered walks carry no error');
  assert.ok(events.some((e) => e.pinId === 'pin009i0'), 'deep row survives');
});
