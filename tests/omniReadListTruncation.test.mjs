// Acceptance test for the omni_read over-budget LIST payload contract.
//
// The defect this pins down (H-71 family, reproduced live 2026-09-24): a list
// page that exceeds the result budget used to be cut with a plain string slice,
// so the caller received a TORN JSON document — the tail (including the
// server's nextCursor) was unrecoverable and only the leading rows survived.
// Live measurement for `pins_by_path /protocols/agentpedia/rev size=100`:
// MANAPI answered 430,281 bytes / 100 rows / nextCursor present; the tool handed
// back 20,068 chars holding 5 whole rows, unparseable as JSON.
//
// Contract asserted here:
//   1. an under-budget payload is returned byte-identical to the pretty-printed
//      JSON (no behaviour change for the common case);
//   2. an over-budget LIST payload comes back as VALID JSON, whole rows only,
//      with the server's own accounting preserved (`total`, `nextCursor`) and an
//      explicit machine-checkable `truncated` / `returned` pair, inside the cap;
//   3. the previous shape is kept as a negative control so the new assertions
//      are demonstrably discriminative (they FAIL on the pre-fix form);
//   4. a non-list oversized payload keeps the historical narrowing note.
//
// Run:
//   npm run compile:electron && node --test tests/omniReadListTruncation.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildOmniReaderAgentTools } = require('../dist-electron/main/libs/omniReaderAgentTools.js');

/** Result budget mirrored from the tool under test; asserted as a hard cap. */
const MAX_RESULT_CHARS = 20000;
const NARROWING_NOTE = '(truncated, narrow the query with cursor/size)';

function makeHarness(fetchJsonResult) {
  const control = {
    fetchJson: async () => fetchJsonResult,
    fetchText: async () => 'raw body',
  };
  const tools = buildOmniReaderAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    control,
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

const row = (i) => ({
  id: `${String(i).padStart(8, '0')}${'a'.repeat(56)}i0`,
  metaid: 'b'.repeat(64),
  globalMetaId: 'idq1fixture000000000000000000000000000000000',
  path: '/protocols/agentpedia/rev',
  contentType: 'application/json',
  contentLength: 4200,
  contentSummary: JSON.stringify({ v: 1, slug: `fixture-${i}`, content: '内容'.repeat(120) }),
  timestamp: 1790000000 + i,
  seenTime: 1790000000 + i,
});

const NEXT_CURSOR = 'cursor-token-0123456789abcdef0123456789abcdef';
const listPayload = (count) => ({
  code: 1,
  message: 'ok',
  data: {
    list: Array.from({ length: count }, (_, i) => row(i)),
    nextCursor: NEXT_CURSOR,
    total: count,
  },
});

/** The PRE-FIX shaping of an over-budget payload, kept as the negative control. */
const legacyShaping = (data) => {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n${NARROWING_NOTE}`;
};

test('under-budget payloads are still exactly the pretty-printed JSON (no behaviour change)', async () => {
  const payload = listPayload(2);
  const omniRead = makeHarness(payload).omni_read;
  const result = await omniRead.handler({
    action: 'pins_by_path',
    path: '/protocols/agentpedia/rev',
    size: 2,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, JSON.stringify(payload, null, 2));
});

test('over-budget list payload: valid JSON, whole rows only, server accounting and nextCursor preserved', async () => {
  const payload = listPayload(100);
  assert.ok(
    JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS,
    'fixture must actually exceed the budget',
  );

  const omniRead = makeHarness(payload).omni_read;
  const result = await omniRead.handler({
    action: 'pins_by_path',
    path: '/protocols/agentpedia/rev',
    size: 100,
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;

  assert.ok(text.length <= MAX_RESULT_CHARS, `payload must stay inside the cap (got ${text.length})`);
  assert.doesNotMatch(text, /\(truncated, narrow the query with cursor\/size\)/);

  // 1. It must parse. A torn document is the defect; lose-everything-after-the-cut
  //    is exactly what happens today when the cut lands mid-token.
  const parsed = JSON.parse(text);

  // 2. Only whole, unmodified rows survive, and they are the LEADING rows.
  assert.equal(parsed.code, 1);
  assert.equal(parsed.message, 'ok');
  assert.ok(Array.isArray(parsed.data.list));
  const kept = parsed.data.list;
  assert.ok(kept.length >= 1, 'at least one whole row must survive');
  assert.ok(kept.length < 100, 'the fixture must not fit entirely');
  for (const [i, keptRow] of kept.entries()) {
    assert.deepEqual(keptRow, row(i), `kept row ${i} must be a whole, unmodified source row`);
  }

  // 3. The server's own accounting survives, so the caller can page.
  assert.equal(parsed.data.total, 100);
  assert.equal(parsed.data.nextCursor, NEXT_CURSOR);

  // 4. The partial page is machine-checkable, not implied.
  assert.equal(parsed.data.truncated, true);
  assert.equal(parsed.data.returned, kept.length);
  assert.equal(typeof parsed.data.hint, 'string');
  assert.match(parsed.data.hint, /\/100 rows returned/);
});

test('the pre-fix shaping fails the same assertions (negative control: the new checks have discriminative power)', () => {
  const payload = listPayload(100);
  const legacy = legacyShaping(payload);
  assert.match(legacy, /\(truncated, narrow the query with cursor\/size\)/);
  assert.throws(() => JSON.parse(legacy), /JSON|character|Unexpected/);
  // …and even a lenient reader only ever recovers the leading rows, with no way
  // to know how many are missing and no nextCursor to continue from.
  assert.ok(!legacy.includes(NEXT_CURSOR), 'the torn tail swallows the server nextCursor');
});

test('non-list oversized payloads keep the historical narrowing note', async () => {
  const big = { code: 0, data: { blob: 'x'.repeat(30000) } };
  const omniRead = makeHarness(big).omni_read;
  const result = await omniRead.handler({ action: 'indexer_stats' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /\(truncated, narrow the query with cursor\/size\)/);
  assert.ok(result.content[0].text.length < 30000);
});

test('an unfamiliar envelope shape is still trimmed to whole rows (no fixed-key blind spot)', async () => {
  const payload = {
    ok: true,
    data: {
      workers: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `worker-${i}`, bio: '简介'.repeat(200) })),
      nextCursor: NEXT_CURSOR,
    },
  };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const text = (await omniRead.handler({ action: 'indexer_status' })).content[0].text;
  const parsed = JSON.parse(text);
  assert.equal(parsed.data.truncated, true);
  assert.equal(parsed.data.workers.length, parsed.data.returned);
  assert.equal(parsed.data.nextCursor, NEXT_CURSOR);
  assert.deepEqual(parsed.data.workers[0], payload.data.workers[0]);
  assert.ok(parsed.data.workers.length < payload.data.workers.length);
});

test('a known row key wins over a larger unfamiliar array (deterministic choice)', async () => {
  const payload = {
    data: {
      items: Array.from({ length: 3 }, (_, i) => ({ id: `row-${i}`, pad: 'p'.repeat(9000) })),
      noise: Array.from({ length: 40 }, (_, i) => ({ i })),
    },
  };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const parsed = JSON.parse((await omniRead.handler({ action: 'indexer_status' })).content[0].text);
  assert.match(parsed.data.hint, /^items:/);
  assert.equal(parsed.data.noise.length, 40, 'the non-row array must be left untouched');
});

test('a single oversized row still returns valid JSON (raw head), never the row-internal array as the page', async () => {
  const payload = {
    data: {
      list: [{ id: 'only-row', modify_history: Array.from({ length: 400 }, (_, i) => ({ v: i, pad: 'h'.repeat(60) })) }],
    },
  };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const text = (await omniRead.handler({ action: 'pins_by_path', path: '/x' })).content[0].text;
  assert.ok(text.length <= MAX_RESULT_CHARS);
  const parsed = JSON.parse(text);
  assert.equal(parsed.data.truncated, true);
  assert.equal(parsed.data.returned, 0);
  assert.deepEqual(parsed.data.list, [], 'no whole row fits, so the page must be empty — not the row-internal array');
  assert.equal(typeof parsed.data.head, 'string');
  assert.ok(parsed.data.head.startsWith('[{'), 'the head carries the raw row array so the caller still sees its shape');
});

// --- Adversarial envelopes found by an independent reviewer of the first cut ---

test('an incidental root-level array must not hijack the page (adversarial: root-array hijack)', async () => {
  const payload = {
    trace: Array.from({ length: 300 }, (_, i) => ({ step: i, detail: 't'.repeat(300) })),
    data: { list: Array.from({ length: 100 }, (_, i) => ({ ...row(i) })), nextCursor: NEXT_CURSOR, total: 100 },
  };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const text = (await omniRead.handler({ action: 'pins_by_path', path: '/protocols/agentpedia/rev', size: 100 })).content[0].text;
  const parsed = JSON.parse(text);
  assert.equal(parsed.data.truncated, true, 'the page under data.list must be the one trimmed');
  assert.equal(parsed.data.total, 100);
  assert.equal(parsed.data.nextCursor, NEXT_CURSOR);
  assert.ok(parsed.data.list.length < 100);
  assert.deepEqual(parsed.data.list[0], row(0));
  assert.ok(!('truncated' in parsed) || parsed.truncated === true, 'accounting must sit beside the page, not replace it');
});

test('a larger array in a sibling container must not hijack the page (adversarial: larger sibling array)', async () => {
  const payload = {
    data: { list: Array.from({ length: 20 }, (_, i) => ({ ...row(i) })), nextCursor: NEXT_CURSOR, total: 20 },
    diagnostics: { samples: Array.from({ length: 900 }, (_, i) => ({ i, pad: 'd'.repeat(60) })) },
  };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const parsed = JSON.parse((await omniRead.handler({ action: 'pins_by_path', path: '/x', size: 20 })).content[0].text);
  assert.match(parsed.data.hint, /^list:/, 'the known page key wins over a larger unrelated array');
  assert.equal(parsed.data.total, 20);
  assert.equal(parsed.data.nextCursor, NEXT_CURSOR);
  assert.ok(parsed.data.list.length < 20);
});

test('an oversized SIBLING is clamped and labelled instead of pushing the page onto the torn path (adversarial: giant scalar sibling)', async () => {
  const payload = {
    code: 1,
    data: {
      list: Array.from({ length: 50 }, (_, i) => ({ ...row(i) })),
      nextCursor: NEXT_CURSOR,
      total: 50,
      blob: 'x'.repeat(30000),
    },
  };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const text = (await omniRead.handler({ action: 'pins_by_path', path: '/x', size: 50 })).content[0].text;
  assert.ok(text.length <= MAX_RESULT_CHARS);
  const parsed = JSON.parse(text);
  assert.equal(parsed.data.truncated, true);
  assert.equal(parsed.data.returned, parsed.data.list.length);
  assert.ok(parsed.data.list.length >= 1, 'the page must survive an oversized sibling');
  assert.deepEqual(parsed.data.list[0], row(0));
  assert.equal(parsed.data.nextCursor, NEXT_CURSOR);
  assert.equal(parsed.data.total, 50);
  assert.match(parsed.data.blob, /sibling trimmed: 30000 chars/, 'the clamped sibling must say it was trimmed');
});

test('two paged containers with a known key: the larger page wins, not the first one (adversarial: ambiguous double page)', async () => {
  const payload = {
    code: 1,
    data: { list: Array.from({ length: 5 }, (_, i) => ({ ...row(i) })), nextCursor: 'short', total: 5 },
    sidecar: { list: Array.from({ length: 100 }, (_, i) => ({ ...row(i) })), nextCursor: NEXT_CURSOR, total: 100 },
  };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const text = (await omniRead.handler({ action: 'pins_by_path', path: '/x', size: 100 })).content[0].text;
  const parsed = JSON.parse(text);
  assert.equal(parsed.sidecar.truncated, true, 'the larger real page is the one trimmed');
  assert.equal(parsed.sidecar.nextCursor, NEXT_CURSOR);
  assert.equal(parsed.sidecar.total, 100);
  assert.ok(parsed.sidecar.list.length >= 1);
  assert.deepEqual(parsed.data, payload.data, 'the smaller container stays untouched');
});

test('a property merely NAMED like a page must not mark its container (adversarial: marker-name collision)', async () => {
  const payload = {
    code: 1,
    list: Array.from({ length: 4 }, (_, i) => ({ ...row(i) })),
    page: { list: Array.from({ length: 100 }, (_, i) => ({ ...row(i) })), nextCursor: NEXT_CURSOR, total: 100 },
  };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const parsed = JSON.parse((await omniRead.handler({ action: 'pins_by_path', path: '/x', size: 100 })).content[0].text);
  assert.equal(parsed.page.truncated, true, 'the larger real page wins on size, not on the collision-prone marker name');
  assert.equal(parsed.page.nextCursor, NEXT_CURSOR);
  assert.deepEqual(parsed.list, payload.list);
});

// --- Documented boundaries: payloads that carry no usable page keep the note ---
test('a bare top-level array payload has no page container and keeps the note (documented boundary)', async () => {
  const payload = Array.from({ length: 200 }, (_, i) => ({ i, pad: 'p'.repeat(200) }));
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const text = (await omniRead.handler({ action: 'indexer_status' })).content[0].text;
  assert.match(text, /\(truncated, narrow the query with cursor\/size\)/);
  assert.ok(text.length <= MAX_RESULT_CHARS + 64, 'the note path stays within the documented 20000 + note budget');
});

test('a page whose rows are not objects keeps the note (documented boundary)', async () => {
  const payload = { data: { list: Array.from({ length: 200 }, (_, i) => `row-${i}-${'s'.repeat(200)}`) } };
  assert.ok(JSON.stringify(payload, null, 2).length > MAX_RESULT_CHARS);
  const omniRead = makeHarness(payload).omni_read;
  const text = (await omniRead.handler({ action: 'pins_by_path', path: '/x' })).content[0].text;
  assert.match(text, /\(truncated, narrow the query with cursor\/size\)/);
});
