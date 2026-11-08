/**
 * Regression tests for the protocolPinFetch default per-page timeout
 * (issue: "protocolPinFetch 2,000ms hard timeout vs real-world network
 * diversity").
 *
 * Background (dual-machine measurement, 2026-10-22): on proxied/TUN paths a
 * cold page fetch against the indexer took 2.06-2.18s while warm pages took
 * ~0.4s on the same endpoint. The old 2,000ms default therefore aborted
 * every cold page — one page-level abort discards the whole walk (rows:0,
 * reason:'fetch-error') — i.e. a 100% false-failure rate for any user whose
 * RTT crosses the threshold.
 *
 * These tests pin the fix on three fronts:
 *   1. the exported DEFAULT_TIMEOUT_MS is the raised 10s value (>= 3s floor
 *      from the incident analysis);
 *   2. FUNCTIONALLY, a first page that resolves at ~2.2s — above the old 2s
 *      default, comfortably below the new one — must survive with default
 *      options (no explicit timeoutMs), exactly the cold-page shape that used
 *      to be aborted;
 *   3. the abort mechanism itself is intact: an explicit tight timeoutMs
 *      against a hung page still degrades into the fetch-error truncation
 *      path instead of hanging forever.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  fetchProtocolPinsFromIndexer,
  DEFAULT_TIMEOUT_MS,
  // Egress-guard memo is process-wide and keyed by (path, size, pages) — the
  // timeout tests must each drive a cold wire.
  __resetProtocolPinFetchStateForTests,
} = require('../dist-electron/main/services/protocolPinFetch.js');

beforeEach(() => {
  __resetProtocolPinFetchStateForTests();
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const row = (id) => ({
  id,
  path: '/protocols/test-timeout',
  globalMetaId: 'idq1author',
  timestamp: 1_790_000_000_000,
  contentBody: Buffer.from(JSON.stringify({ pinId: id })).toString('base64'),
});

test('DEFAULT_TIMEOUT_MS is raised to 10s (>= 3s floor from the incident analysis)', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000, 'default must be the raised 10s value');
  assert.ok(
    DEFAULT_TIMEOUT_MS >= 3_000,
    `default must stay >= 3s so real-world cold pages keep headroom (got ${DEFAULT_TIMEOUT_MS}ms)`
  );
});

test('default options survive a ~2.2s cold first page (the old 2s default aborted exactly this shape)', async () => {
  const startedAt = Date.now();
  let calls = 0;
  // Honors init.signal like a real fetch: if the abort fires BEFORE the page
  // resolves, the promise must reject (page-level abort -> whole-walk
  // fetch-error). A signal-ignoring mock would make this case pass even
  // against the old 2s default — the first draft did exactly that and the
  // independent review caught it (2026-10-24), so the case had no teeth.
  const fetchImpl = (_url, init) => new Promise((resolve, reject) => {
    calls += 1;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(jsonResponse({ code: 1, data: { list: [row('cold-page-pin')] } }));
    }, 2_200);
    init?.signal?.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('TimeoutError'));
    });
  });

  const pins = await fetchProtocolPinsFromIndexer('/protocols/test-timeout', {
    // No timeoutMs passed: the walk must run on the raised DEFAULT_TIMEOUT_MS.
    localBaseUrl: '',
    remoteBaseUrl: 'https://example.test',
    fetchImpl,
  });

  const elapsed = Date.now() - startedAt;
  assert.equal(calls, 1, 'exactly one page request');
  assert.equal(pins.length, 1, 'the cold page must not be discarded');
  assert.equal(pins[0].pinId, 'cold-page-pin');
  assert.ok(elapsed >= 2_200, `walk waited out the cold page (elapsed ${elapsed}ms)`);
});

test('explicit tight timeoutMs still aborts a hung page into fetch-error truncation', async () => {
  const reports = [];
  // Simulates a fetch that hangs until the abort signal fires — a real
  // fetch(input, { signal }) rejects on abort; the mock must honor the same
  // contract or the test would hang forever (the first draft did exactly
  // that by ignoring init.signal).
  const hungUntilAbort = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')));
  });

  const pins = await fetchProtocolPinsFromIndexer('/protocols/test-timeout', {
    localBaseUrl: '',
    remoteBaseUrl: 'https://example.test',
    fetchImpl: hungUntilAbort,
    timeoutMs: 60,
    onTruncated: (info) => reports.push(info),
  });

  assert.equal(pins.length, 0, 'no rows from a hung first page');
  assert.equal(reports.length, 1, 'truncation reported exactly once');
  assert.equal(reports[0].reason, 'fetch-error', 'page-level abort still surfaces as fetch-error');
});
