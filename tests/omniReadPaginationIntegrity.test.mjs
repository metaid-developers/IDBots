// Regression tests for the omni_read chain-read pagination-integrity layer.
//
// Defect this pins down (work-time-learning logs, 2026-11): a cursor-paged
// chain read can answer a continuation page with ZERO rows while the envelope's
// own accounting still says rows exist beyond that cursor. The tool used to
// hand that page back as a normal answer, so a reader concluded "the rest does
// not exist" — a silent empty page is worse than an error, because nothing in
// the answer says the read was incomplete.
//
// Measured counter-constraint (live manapi, 2026-11-04): a NORMAL walk also
// ends with an empty page. `/protocols/agentpedia/challenge` (total 16,
// size 5) answers 5/5/5/1 rows and then a 0-row page with the cursor cleared;
// a 2-row list behaves the same. A total alone therefore cannot decide — it
// would flag every completed walk. The tests below pin BOTH sides:
//
//   1. a continuation page with no rows whose envelope reports rows this walk
//      never received comes back with an explicit machine-readable `pagination`
//      block — `complete: false`, the cursor that was tried, rows seen vs. the
//      envelope's total, and a note that forbids reading it as the end of the
//      list;
//   2. the layer does NOT fire on a genuinely exhausted list — a full walk that
//      ends in the normal empty page, an explicit `offset + returned >= total`,
//      `total <= size`, or `total: 0` — nor on an error response (including
//      HTTP 200 carrying a non-success `code`), on page 1 (no cursor), on a
//      non-empty page, or on an envelope it cannot judge;
//   3. it is wired per action for pins_by_path / pins_by_metaid /
//      pins_by_address only — the metafile-indexer `files_by_*` family uses a
//      different envelope (`files` / `next_cursor` / `has_more`) and must be
//      left alone;
//   4. the request sent upstream is unchanged: the caller's cursor and size are
//      still passed through (this is a read-side honesty layer, not a silent
//      strategy switch).
//
// Run:
//   pnpm --config.verify-deps-before-run=false run compile:electron \
//     && node --test tests/omniReadPaginationIntegrity.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildOmniReaderAgentTools, withPaginationIntegrity } = require('../dist-electron/main/libs/omniReaderAgentTools.js');

const CURSOR = 'cursor-token-0123456789abcdef0123456789abcdef';

/** Each fetchJson call consumes the next scripted response (or throws it). */
function makeHarness(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = { fetchJson: [], fetchText: [] };
  const control = {
    fetchJson: async (url) => {
      calls.fetchJson.push(url);
      if (queue.length === 0) throw new Error('unexpected extra fetchJson call');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchText: async (url) => {
      calls.fetchText.push(url);
      return 'raw body';
    },
  };
  const tools = buildOmniReaderAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    control,
  });
  return { calls, omni: Object.fromEntries(tools.map((tool) => [tool.name, tool])).omni_read };
}

const parse = (result) => JSON.parse(result.content[0].text);
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `row-${i}` }));

const PAGED_ACTIONS = [
  ['pins_by_path', { path: '/protocols/simplebuzz', size: 10 }],
  ['pins_by_metaid', { metaid: 'a'.repeat(64), path: '/protocols/simplebuzz', size: 10 }],
  ['pins_by_address', { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', path: '/protocols/simplebuzz', size: 10 }],
];

// ---------------------------------------------------------------------------
// 1. The silent empty continuation page is surfaced, never returned as normal.
// ---------------------------------------------------------------------------

for (const [action, args] of PAGED_ACTIONS) {
  test(`${action}: continuation answered with no rows while total says more is annotated`, async () => {
    const page1 = { code: 1, message: 'ok', data: { list: rows(2), nextCursor: CURSOR, total: 24, size: 10 } };
    const page2 = { code: 1, message: 'ok', data: { list: null, nextCursor: '', total: 24, size: 10 } };
    const { calls, omni } = makeHarness([page1, page2]);

    const first = await omni.handler({ action, ...args });
    assert.equal(parse(first).pagination, undefined, 'page 1 must not be annotated');

    const second = await omni.handler({ action, ...args, cursor: CURSOR });
    assert.equal(second.isError, undefined);
    const payload = parse(second);

    // The server's own answer is preserved verbatim — only annotated.
    assert.equal(payload.code, 1);
    assert.equal(payload.data.list, null);
    assert.equal(payload.data.total, 24);

    assert.ok(payload.pagination, 'a silent empty continuation must carry a pagination block');
    assert.equal(payload.pagination.action, action);
    assert.equal(payload.pagination.requestedCursor, CURSOR);
    assert.equal(payload.pagination.returned, 0);
    assert.equal(payload.pagination.rowsSeen, 2);
    assert.equal(payload.pagination.total, 24);
    assert.equal(payload.pagination.totalField, 'total');
    assert.equal(payload.pagination.unaccounted, 22);
    assert.equal(payload.pagination.complete, false);
    assert.match(payload.pagination.note, /INCOMPLETE/);
    assert.match(payload.pagination.note, /seen 2 of the 24 rows/);
    assert.match(payload.pagination.note, /do not treat this as the end of the list/);

    // The request itself is unchanged: cursor and size still go upstream.
    assert.equal(calls.fetchJson.length, 2);
    assert.ok(calls.fetchJson[1].includes(`cursor=${encodeURIComponent(CURSOR)}`));
    assert.ok(calls.fetchJson[1].includes('size=10'));
  });
}

test('pins_by_address: an empty page with only a continuation token is annotated too', async () => {
  // Live 2026-11-04 shape: this route can answer total: 0 beside real rows, so
  // a zero total proves nothing. The token is positive evidence of more.
  const envelope = { code: 1, message: 'ok', data: { list: [], total: 0, nextCursor: 'next-page-token' } };
  const { omni } = makeHarness(envelope);
  const payload = parse(await omni.handler({
    action: 'pins_by_address',
    address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    path: '/protocols/simplebuzz',
    cursor: CURSOR,
  }));
  assert.ok(payload.pagination);
  assert.equal(payload.pagination.requestedCursor, CURSOR);
  assert.equal(payload.pagination.returned, 0);
  assert.equal(payload.pagination.total, 0);
  assert.equal(payload.pagination.totalField, 'total');
  assert.equal(payload.pagination.nextCursor, 'next-page-token');
  assert.equal(payload.pagination.complete, false);
  assert.match(payload.pagination.note, /continuation token/);
  assert.match(payload.pagination.note, /do not treat this as the end of the list/);
});

test('totalCount is read defensively when `total` is absent', async () => {
  const envelope = { code: 1, message: 'ok', data: { list: null, totalCount: '37' } };
  const { omni } = makeHarness(envelope);
  const payload = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', cursor: CURSOR }));
  assert.ok(payload.pagination);
  assert.equal(payload.pagination.total, 37);
  assert.equal(payload.pagination.totalField, 'totalCount');
  assert.equal(payload.pagination.rowsSeen, 0);
});

// ---------------------------------------------------------------------------
// 2. Pass-through cases — the layer must not cry wolf.
// ---------------------------------------------------------------------------

test('a normal multi-page walk ending in the server\'s empty page is not annotated', async () => {
  // Exact live shape measured 2026-11-04 for /protocols/agentpedia/challenge:
  // five pages of 5/5/5/1 and then an empty page (list:null, cursor cleared),
  // total 16 throughout. Every page must pass through untouched.
  const walk = [
    { code: 1, data: { list: rows(5), total: 16, size: 5, nextCursor: 'c1' } },
    { code: 1, data: { list: rows(5), total: 16, size: 5, nextCursor: 'c2' } },
    { code: 1, data: { list: rows(5), total: 16, size: 5, nextCursor: 'c3' } },
    { code: 1, data: { list: rows(1), total: 16, size: 5, nextCursor: 'c4' } },
    { code: 1, data: { list: null, total: 16, size: 5, nextCursor: '' } },
  ];
  const { omni } = makeHarness(walk);
  let cursor;
  for (let page = 0; page < walk.length; page += 1) {
    const payload = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/agentpedia/challenge', size: 5, cursor }));
    assert.equal(payload.pagination, undefined, `page ${page + 1} must not be annotated`);
    cursor = payload.data.nextCursor || undefined;
  }
});

test('genuinely exhausted continuation (offset + returned == total) is passed through untouched', async () => {
  const envelope = { code: 1, message: 'ok', data: { list: [], nextCursor: '', total: 24, offset: 24 } };
  const { omni } = makeHarness(envelope);
  const result = await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', cursor: CURSOR });
  assert.equal(result.isError, undefined);
  const payload = parse(result);
  assert.equal(payload.pagination, undefined);
  assert.equal(payload.data.offset, 24);
});

test('a list that fits one page (total <= size) is exhausted, not silent', async () => {
  // The live 2-row case: page 1 returned both rows and still handed a cursor;
  // following it yields an empty page. No annotation may be raised.
  const envelope = { code: 1, message: 'ok', data: { list: null, total: 2, size: 2, nextCursor: '' } };
  const { omni } = makeHarness(envelope);
  const payload = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/agentpedia/constitution', size: 2, cursor: CURSOR }));
  assert.equal(payload.pagination, undefined);
});

test('an empty list with total 0 is exhausted, not silent', async () => {
  const envelope = { code: 1, message: 'ok', data: { list: [], nextCursor: '', total: 0 } };
  const { omni } = makeHarness(envelope);
  const payload = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', cursor: CURSOR }));
  assert.equal(payload.pagination, undefined);
});

test('upstream error response (HTTP 200 with non-success code) is passed through untouched', async () => {
  // The live pins_by_metaid failure shape: HTTP 200, { code: 404, message:
  // "Parameter error.", data: [] } — the layer must not dress it up as a
  // pagination problem; the caller already has an error code.
  const envelope = { code: 404, message: 'Parameter error.', data: [] };
  const { omni } = makeHarness(envelope);
  const result = await omni.handler({ action: 'pins_by_metaid', metaid: 'a'.repeat(64), cursor: CURSOR });
  assert.equal(result.isError, undefined);
  const payload = parse(result);
  assert.equal(payload.code, 404);
  assert.equal(payload.pagination, undefined);
});

test('upstream transport error keeps the existing error result and adds no pagination block', async () => {
  const { omni } = makeHarness([new Error('socket hang up')]);
  const result = await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', cursor: CURSOR });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /failed: socket hang up/);
  assert.equal(result.content[0].text.includes('pagination'), false);
});

test('page 1 (no cursor) is never annotated even when empty with a total', async () => {
  const envelope = { code: 1, message: 'ok', data: { list: [], nextCursor: 'first-page-cursor', total: 24 } };
  const { omni } = makeHarness(envelope);
  const payload = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', size: 10 }));
  assert.equal(payload.pagination, undefined);
});

test('a non-empty continuation page is left alone', async () => {
  const envelope = { code: 1, message: 'ok', data: { list: rows(2), nextCursor: 'more', total: 24 } };
  const { omni } = makeHarness(envelope);
  const payload = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', cursor: CURSOR }));
  assert.equal(payload.pagination, undefined);
  assert.equal(payload.data.list.length, 2);
});

test('an unjudgeable envelope (no total, no token) is passed through', async () => {
  const envelope = { code: 1, message: 'ok', data: { list: [] } };
  const { omni } = makeHarness(envelope);
  const payload = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', cursor: CURSOR }));
  assert.equal(payload.pagination, undefined);
});

test('a files_by_* envelope is out of scope and stays untouched', async () => {
  // metafile-indexer uses { files, next_cursor, has_more } — a different
  // envelope; the integrity layer is deliberately not wired to it.
  const envelope = { code: 0, message: 'ok', data: { files: [], next_cursor: 'file-token', has_more: true } };
  const { omni } = makeHarness(envelope);
  const payload = parse(await omni.handler({ action: 'files_by_creator', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', cursor: CURSOR }));
  assert.equal(payload.pagination, undefined);
});

test('a fresh page 1 resets the walk ledger', async () => {
  // First walk sees 20 of 24 rows, then restarts from page 1 with 0 rows: the
  // continuation must be judged against the NEW walk (0 seen), not the old one.
  const walk = [
    { code: 1, data: { list: rows(20), total: 24, size: 20, nextCursor: 'old-tail' } },
    { code: 1, data: { list: [], total: 24, size: 20, nextCursor: '' } },
    { code: 1, data: { list: null, total: 24, size: 20, nextCursor: '' } },
  ];
  const { omni } = makeHarness(walk);
  const page1 = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', size: 20 }));
  assert.equal(page1.pagination, undefined);
  const restart = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', size: 20 }));
  assert.equal(restart.pagination, undefined);
  const continuation = parse(await omni.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', size: 20, cursor: 'old-tail' }));
  assert.ok(continuation.pagination);
  assert.equal(continuation.pagination.rowsSeen, 0);
});

// ---------------------------------------------------------------------------
// 3. The helper itself: pass-through is by reference (no mutation, no copy).
// ---------------------------------------------------------------------------

const helperCall = (payload, cursor) =>
  withPaginationIntegrity('pins_by_path', payload, cursor, 'pins_by_path|/protocols/simplebuzz', new Map());

test('withPaginationIntegrity returns the same object on every pass-through path', () => {
  const cases = [
    ['no cursor', { code: 1, data: { list: null, total: 9 } }, ''],
    ['error code', { code: 404, message: 'Parameter error.' }, CURSOR],
    ['non-empty page', { code: 1, data: { list: [{ id: 'a' }], total: 9 } }, CURSOR],
    ['exhausted via offset', { code: 1, data: { list: [], total: 9, offset: 9 } }, CURSOR],
    ['single page covers all', { code: 1, data: { list: [], total: 9, size: 9 } }, CURSOR],
    ['unjudgeable', { code: 1, data: { list: [] } }, CURSOR],
    ['not an object', ['not', 'an', 'envelope'], CURSOR],
  ];
  for (const [label, payload, cursor] of cases) {
    assert.equal(helperCall(payload, cursor), payload, label);
  }
});

test('withPaginationIntegrity annotates without mutating the input envelope', () => {
  const envelope = { code: 1, data: { list: null, total: 24 } };
  const annotated = helperCall(envelope, CURSOR);
  assert.notEqual(annotated, envelope);
  assert.equal(envelope.pagination, undefined);
  assert.equal(annotated.pagination.complete, false);
  assert.equal(annotated.data, envelope.data); // surface preserved, not rebuilt
});
