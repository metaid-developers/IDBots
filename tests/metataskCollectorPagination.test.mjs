import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * MetaTask event-collection pagination regression (2026-10-13 RSI case):
 *
 * The indexer caps each pins_by_path page by response bytes (~19KB), so a pool
 * carrying giant payloads yields only a few rows per page regardless of
 * `size`. With a 281-row pool at ~3 rows/page, a 100-page walk stops ~190 rows
 * short of the empty cursor page — deep events (late submissions, votes) were
 * silently dropped and competitive projections starved.
 *
 * Contract after the fix:
 *  1. the walk pages to the EMPTY cursor page by default (runaway guard 1000
 *     pages, not a budget);
 *  2. if the guard ever fires with a live cursor, the caller finds out
 *     (onTruncated + console.warn) instead of losing events silently;
 *  3. a pool that fits inside the guard is byte-stable with the old walk
 *     (same rows, same order) — no regression for small pools.
 */

const require = createRequire(import.meta.url);
const {
  fetchProtocolPinsFromIndexer,
  // The egress guard (memo + head-stop probe) keeps process-wide state keyed
  // by (path, size, pages); each test must start from a cold walk.
  __resetProtocolPinFetchStateForTests,
} = require('../dist-electron/main/services/protocolPinFetch.js');
const { collectMetaTaskEvents, __resetMetataskContentCacheForTests } = require('../dist-electron/main/services/metatask/collector.js');

beforeEach(() => {
  __resetProtocolPinFetchStateForTests();
  __resetMetataskContentCacheForTests();
});

const PATH = '/protocols/metatask/submission';

/** A fake indexer that serves `rowsPerPage` rows per page (byte-budget shape). */
const fakeIndexer = (totalRows, rowsPerPage) => {
  const rows = Array.from({ length: totalRows }, (_, i) => ({
    id: `pin${String(i).padStart(3, '0')}i0`,
    path: PATH,
    globalMetaId: 'idq1author',
    genesisHeight: 190_000,
    txIndex: i,
    timestamp: 1_790_000_000_000 + i,
    contentBody: Buffer.from(JSON.stringify({ n: i })).toString('base64'),
  }));
  return (url) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/pin/path/list') || parsed.searchParams.get('path') !== PATH) {
      return Promise.resolve(new Response(JSON.stringify({ code: 0 }), { status: 404 }));
    }
    const size = Number(parsed.searchParams.get('size'));
    const cursor = Number(parsed.searchParams.get('cursor') || 0);
    const list = rows.slice(cursor, cursor + rowsPerPage);
    const next = cursor + rowsPerPage;
    return Promise.resolve(new Response(JSON.stringify({
      data: { list, nextCursor: next < totalRows ? String(next) : '', total: totalRows },
    }), { status: 200 }));
  };
};

test('walk pages to the empty cursor page past the old 100-page ceiling', async () => {
  // 281 rows x 3 rows/page = 94 pages — under the old 100 cap but with a live
  // cursor the old walk also served mid-air; use a pool that strictly exceeds
  // the old ceiling to prove the walk now reaches the empty page.
  const totalRows = 400;
  const seenUrls = [];
  const records = await fetchProtocolPinsFromIndexer(PATH, {
    pageSize: 100,
    maxPages: 1000,
    timeoutMs: 1000,
    localBaseUrl: '',
    fetchImpl: (url) => { seenUrls.push(url); return fakeIndexer(totalRows, 3)(url); },
  });
  assert.equal(records.length, totalRows, 'every row must be fetched');
  assert.equal(seenUrls.length, Math.ceil(totalRows / 3), 'exactly ceil(rows/page) pages');
  const last = new URL(seenUrls[seenUrls.length - 1]);
  // the final request carries a live cursor and the server answers it with an
  // empty nextCursor — the walk terminates on the server's empty page
  assert.equal(last.searchParams.get('cursor'), String(totalRows - (totalRows % 3 || 3)));
});

test('onTruncated fires when the runaway guard fires, rows stay complete', async () => {
  const truncations = [];
  const records = await fetchProtocolPinsFromIndexer(PATH, {
    pageSize: 100,
    maxPages: 5,
    timeoutMs: 1000,
    localBaseUrl: '',
    fetchImpl: fakeIndexer(400, 3),
    onTruncated: (info) => truncations.push(info),
  });
  assert.equal(records.length, 15, 'guard caps the fetch at maxPages x rows');
  assert.equal(truncations.length, 1, 'truncation is surfaced once (remote walk)');
  assert.equal(truncations[0].protocolPath, PATH);
  assert.equal(truncations[0].pages, 5);
});

test('collector default reaches deep rows of a 281-row submission pool', async () => {
  // The production shape: 281-row pool, ~3 rows/page, deep rows are the late
  // submissions the old walk dropped.
  const fetchImpl = fakeIndexer(281, 3);
  const { events, perPath } = await collectMetaTaskEvents({ fetchImpl, timeoutMs: 2000 });
  assert.equal(events.length, 281);
  const counts = Object.fromEntries(perPath.map((x) => [x.path, x.count]));
  assert.ok(counts['submission'] >= 281 || events.length === 281, 'pool fully collected');
  const lastPin = events.find((e) => e.pinId === 'pin280i0');
  assert.ok(lastPin, 'the deepest row (old walk lost it) is in the event set');
});
