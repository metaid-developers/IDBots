import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Egress guard for the manapi pool walks (ops ticket 2026-11-08): staging's
 * ~20 tenant instances re-walked their pools in full on every sweep —
 * ~940k/day requests, no cache, no increment, a bare `node` UA. The guard:
 *
 *  1. MEMO — a complete full walk is memoized per (path, pageSize, maxPages)
 *     for a TTL; repeat callers inside the window cost zero requests;
 *  2. HEAD-STOP — the listing is timestamp-desc (verified against manapi:
 *     the cursor embeds the last row's timestamp), so after a complete walk
 *     a probe of the head pages stops at the first all-known page; an
 *     inconclusive probe falls back to the full walk (never worse);
 *  3. a periodic full re-walk heals any theoretically deep insert;
 *  4. requests carry an attributable UA instead of bare `node`.
 */

const require = createRequire(import.meta.url);
const {
  fetchProtocolPinsFromIndexer,
  setIndexerUserAgent,
  indexerUserAgentHeader,
  __resetProtocolPinFetchStateForTests,
} = require('../dist-electron/main/services/protocolPinFetch.js');

const PATH = '/protocols/metatask/verify';
let clockMs = 1_790_000_000_000;
const now = () => clockMs;
const advance = (ms) => { clockMs += ms; };

/** Fake indexer: `rows` newest-first, pages sized by the URL's size param. */
const fakeIndexer = (rows, rowsPerPage, options = {}) => {
  const requestedUrls = [];
  const fetcher = (url, init) => {
    requestedUrls.push({ url: String(url), init });
    const parsed = new URL(String(url));
    if (parsed.searchParams.get('path') !== PATH) {
      return Promise.resolve(new Response(JSON.stringify({ code: 0 }), { status: 404 }));
    }
    const effective = Number(parsed.searchParams.get('size')) || rowsPerPage;
    const cursor = Number(parsed.searchParams.get('cursor') || 0);
    if (options.failPages?.delete(cursor)) {
      return Promise.resolve(new Response('boom', { status: 500 }));
    }
    const list = rows.slice(cursor, cursor + effective);
    const next = cursor + effective;
    return Promise.resolve(new Response(JSON.stringify({
      code: 1,
      data: { list, nextCursor: next < rows.length ? String(next) : '' },
    }), { status: 200 }));
  };
  fetcher.requestedUrls = requestedUrls;
  return fetcher;
};

const row = (id, timestamp) => ({
  id,
  timestamp,
  contentSummary: JSON.stringify({ n: id }),
});

/** Pool of `totalRows` rows, newest first, 1s apart. */
const pool = (totalRows) => Array.from({ length: totalRows }, (_, i) =>
  row(`pin${String(totalRows - 1 - i).padStart(3, '0')}i0`, 1_790_000_000_000 - i * 1_000)
);

const walk = (fetchImpl, over = {}) => fetchProtocolPinsFromIndexer(PATH, {
  pageSize: 3,
  maxPages: 100,
  timeoutMs: 1000,
  localBaseUrl: '',
  remoteBaseUrl: 'https://indexer.test',
  fetchImpl,
  now,
  ...over,
});

const pagesFetched = (fetcher) => fetcher.requestedUrls.length;

beforeEach(() => {
  __resetProtocolPinFetchStateForTests();
  clockMs = 1_790_000_000_000;
  setIndexerUserAgent('');
});

test('memo: a complete full walk is served from memory inside the TTL', async () => {
  const fetcher = fakeIndexer(pool(6), 3);
  const first = await walk(fetcher);
  assert.equal(first.length, 6);
  const callsAfterFirst = pagesFetched(fetcher);

  advance(1_000);
  const second = await walk(fetcher);
  assert.equal(second.length, 6, 'memo serves the full walk again');
  assert.equal(pagesFetched(fetcher), callsAfterFirst, 'zero extra requests inside the TTL');
  assert.deepEqual(second.map((r) => r.pinId), first.map((r) => r.pinId));
});

test('memo: expiry turns walks into one-page probes until the next full walk', async () => {
  const fetcher = fakeIndexer(pool(6), 3);
  await walk(fetcher);
  const callsAfterFirst = pagesFetched(fetcher);

  advance(5 * 60_000 + 1);
  await walk(fetcher);
  assert.equal(pagesFetched(fetcher), callsAfterFirst + 1, 'memo expired: one all-known head page');

  advance(1_000);
  await walk(fetcher);
  assert.equal(pagesFetched(fetcher), callsAfterFirst + 2, 'head-stop probes are not memoized — one page per walk');
});

test('bypassCache skips the memo but the probe still only walks the head', async () => {
  const rows = pool(9);
  const fetcher = fakeIndexer(rows, 3);
  await walk(fetcher);
  const callsAfterFirst = pagesFetched(fetcher);

  advance(1_000);
  const fresh = await walk(fetcher, { bypassCache: true });
  assert.equal(pagesFetched(fetcher), callsAfterFirst + 1, 'one head page, not the full pool');
  assert.ok(fresh.length > 0);
});

test('probe: a quiet pool costs exactly one head page', async () => {
  const fetcher = fakeIndexer(pool(9), 3);
  await walk(fetcher);
  const callsAfterFirst = pagesFetched(fetcher);

  // Past the memo TTL (5 min) but inside the full re-walk window (6 h).
  advance(5 * 60_000 + 1_000);
  const fresh = await walk(fetcher);
  assert.equal(pagesFetched(fetcher), callsAfterFirst + 1, 'single all-known head page');
  assert.equal(fresh.length, 3, 'the probe returns the head page (rows the caller already has)');
  const probeRequest = fetcher.requestedUrls[callsAfterFirst];
  assert.equal(new URL(probeRequest.url).searchParams.get('cursor'), null, 'the probe is a head request');
});

test('probe: a new head row is picked up without a full walk', async () => {
  const rows = pool(9);
  const fetcher = fakeIndexer(rows, 3);
  await walk(fetcher);
  const callsAfterFirst = pagesFetched(fetcher);

  rows.unshift(row('pin-new-i0', 1_790_000_099_000));
  advance(5 * 60_000 + 1_000);
  const fresh = await walk(fetcher);
  assert.equal(pagesFetched(fetcher), callsAfterFirst + 2, 'probe walks until the all-known page');
  assert.ok(fresh.some((r) => r.pinId === 'pin-new-i0'), 'the new pin is collected');
  assert.equal(fresh.length, 6, 'head pages only (2 pages of 3)');
});

test('probe: inconclusive probe (unknown rows past the budget) escalates to a full walk', async () => {
  const rows = pool(9);
  const fetcher = fakeIndexer(rows, 3);
  await walk(fetcher, { probeMaxPages: 1 });
  const callsAfterFirst = pagesFetched(fetcher);

  rows.unshift(row('pin-a-i0', 1_790_000_099_000), row('pin-b-i0', 1_790_000_098_000), row('pin-c-i0', 1_790_000_097_000), row('pin-d-i0', 1_790_000_096_000));
  advance(5 * 60_000 + 1_000);
  const fresh = await walk(fetcher, { probeMaxPages: 1 });
  // 1 probe page (unknown rows) + full walk of the 13-row pool (5 pages)
  assert.equal(pagesFetched(fetcher), callsAfterFirst + 1 + 5, 'escalation refetches the whole pool');
  assert.equal(fresh.length, 13);
});

test('failed walks are not memoized', async () => {
  // cursor '3' is the SECOND page of a 9-row pool at 3 rows/page.
  const failPages = new Set([3]);
  const fetcher = fakeIndexer(pool(9), 3, { failPages });
  const partial = await walk(fetcher);
  assert.equal(partial.length, 3, 'rows before the failing page only');
  const callsAfterFirst = pagesFetched(fetcher);

  advance(5 * 60_000 + 1_000);
  const fresh = await walk(fetcher);
  assert.ok(pagesFetched(fetcher) > callsAfterFirst, 'a failed walk never serves the memo');
  assert.equal(fresh.length, 9, 'the retry completes the full walk');
});

test('periodic full re-walk heals deep state', async () => {
  const fetcher = fakeIndexer(pool(9), 3);
  await walk(fetcher);
  const callsAfterFirst = pagesFetched(fetcher);

  advance(5 * 60_000 + 1_000);
  await walk(fetcher);
  assert.equal(pagesFetched(fetcher), callsAfterFirst + 1, 'probe inside the re-walk window');

  advance(6 * 3_600_000);
  await walk(fetcher);
  assert.equal(pagesFetched(fetcher), callsAfterFirst + 1 + 3, 'full walk (3 pages) after fullRewalkMs');
});

test('requests carry an attributable UA', async () => {
  const fetcher = fakeIndexer(pool(3), 3);
  await walk(fetcher);
  assert.match(fetcher.requestedUrls[0].init.headers['User-Agent'], /^IDBots\//);

  setIndexerUserAgent('IDBots/1.2.3/t_tenant');
  assert.equal(indexerUserAgentHeader(), 'IDBots/1.2.3/t_tenant');
  const fetcher2 = fakeIndexer(pool(3), 3);
  advance(5 * 60_000 + 1_000); // past the memo — the walk must actually fetch
  await walk(fetcher2);
  assert.equal(fetcher2.requestedUrls[0].init.headers['User-Agent'], 'IDBots/1.2.3/t_tenant');
});

test('probe head-stop does not fire onTruncated', async () => {
  const fetcher = fakeIndexer(pool(9), 3);
  await walk(fetcher);
  const truncations = [];
  advance(1_000);
  await walk(fetcher, { onTruncated: (info) => truncations.push(info) });
  assert.deepEqual(truncations, [], 'an intentional head-stop is not truncation');
});

test('distinct pageSize/maxPages keep distinct memo + probe state', async () => {
  const fetcher = fakeIndexer(pool(9), 3);
  await walk(fetcher, { pageSize: 3 });
  const callsA = pagesFetched(fetcher);
  advance(1_000);
  await walk(fetcher, { pageSize: 9 });
  const callsB = pagesFetched(fetcher);
  assert.equal(callsB - callsA, 1, 'the other params start with their own full walk');
  advance(5 * 60_000 + 1);
  await walk(fetcher, { pageSize: 3 });
  assert.equal(pagesFetched(fetcher), callsB + 1, 'params A expired into its own one-page probe');
});
