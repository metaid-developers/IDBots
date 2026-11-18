import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildMetawebLearningAgentTools,
  formatMetawebPinDetail,
  METAWEB_BATCH_READ_CALIBER,
  METAWEB_BATCH_RECEIPT_MAX_LIST,
  METAWEB_BATCH_RESULT_CHAR_BUDGET,
} = require('../dist-electron/main/libs/metawebLearningAgentTools.js');

function makePin(pinId, overrides = {}) {
  return {
    pinId,
    currentPinId: pinId,
    protocol: 'simplenote',
    path: '/protocols/simplenote',
    chainName: 'mvc',
    operation: 'create',
    creator: { globalMetaId: 'idq-test', metaid: 'meta-test', name: 'Tester', address: 'addr-test' },
    createdAt: 1789000000,
    contentType: 'text/markdown',
    payload: null,
    text: 'x'.repeat(4000),
    truncated: false,
    totalLength: 4000,
    meta: { title: `Title ${pinId}`, summary: '', tags: [] },
    attachments: [],
    source: 'local',
    version: { latest: pinId, count: 1 },
    ...overrides,
  };
}

/**
 * `omitIds` drops ids from the upstream response map entirely — the "no entry
 * returned" branch, which a defaulted `{error}` entry cannot exercise.
 */
function makeHarness(batchEntries, omitIds = []) {
  const metawebLearning = {
    search: async () => { throw new Error('not used'); },
    readPin: async () => { throw new Error('not used'); },
    readPinsBatch: async (pinIds) => {
      const out = {};
      for (const id of pinIds) {
        if (omitIds.includes(id)) continue;
        out[id] = batchEntries[id] ?? { pinId: id, error: 'pin missing from batch response' };
      }
      return out;
    },
    pinVersions: async () => { throw new Error('not used'); },
  };
  const tools = buildMetawebLearningAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    metawebLearning,
    resolveMetabotId: () => 1,
  });
  const batch = tools.find((entry) => entry.name === 'read_metaweb_pins_batch');
  return { batch };
}

const resultText = (result) => result.content.map((block) => block.text).join('\n');

const pinIdFor = (index, letter) => `${String(index).padStart(2, '0')}${letter.repeat(62)}i0`;

test('formatMetawebPinDetail: bodyCharCap trims with a labeled pointer, omitBody drops the body', () => {
  const pin = makePin('a'.repeat(64) + 'i0', { text: 'A'.repeat(500) });
  const trimmed = formatMetawebPinDetail(pin, { bodyCharCap: 100 });
  assert.match(trimmed, /showing first 100 of 500 chars — trimmed to fit this batch's result budget/);
  assert.match(trimmed, /read_metaweb_pin/);
  assert.ok(!trimmed.includes('A'.repeat(200)), 'trimmed body must not keep the full 500 chars');

  const omitted = formatMetawebPinDetail(pin, { omitBody: true });
  assert.match(omitted, /content omitted to fit this batch's result budget \(500 chars\)/);
  assert.ok(!omitted.includes('<metaweb_pin_content>'), 'omitted body must not render a content block');

  // Default call shape is unchanged for single reads.
  const full = formatMetawebPinDetail(pin);
  assert.ok(full.includes('A'.repeat(500)));
  assert.doesNotMatch(full, /budget/);
});

test('oversized batches render every meta block under the shaping window, bodies honestly omitted', async () => {
  const entries = {};
  for (let index = 0; index < 20; index += 1) {
    const pinId = pinIdFor(index, 'p');
    entries[pinId] = makePin(pinId, { text: `Body ${index} — ` + 'y'.repeat(8000) });
  }
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: Object.keys(entries) });
  const text = resultText(result);
  assert.equal(result.isError, undefined);
  // The whole rendered result must sit under the runtime's 20k-char shaping
  // window (head+tail cut) — that is the entire point of the budget.
  assert.ok(text.length <= 20_000, `rendered ${text.length} chars — over the shaping window`);
  // Every requested pin keeps its complete meta block, first to last.
  for (const pinId of Object.keys(entries)) {
    assert.ok(text.includes(`Pin ${pinId}:`), `missing meta block for ${pinId}`);
    assert.ok(text.includes(`Title ${pinId}`), `missing title for ${pinId}`);
  }
  // No body silently half-rendered: 8k bodies cannot fit, so each is either
  // a labeled omission pointer or a labeled trim — never a bare block.
  const bodyBlocks = text.match(/<metaweb_pin_content>/g)?.length ?? 0;
  if (bodyBlocks > 0) {
    assert.match(text, /trimmed to fit this batch's result budget; full body via read_metaweb_pin/);
  } else {
    assert.match(text, /content omitted to fit this batch's result budget/);
  }
  assert.match(text, /20\/20 pin\(s\) readable in this batch; 20 body\(ies\) trimmed or omitted/);
});

test('mid-size batches trim bodies with per-pin labels and keep water-filled short bodies whole', async () => {
  const entries = {};
  const tinyId = pinIdFor(0, 't');
  entries[tinyId] = makePin(tinyId, { text: 'TINYWHOLEBODY-' + 'z'.repeat(150) });
  for (let index = 1; index <= 11; index += 1) {
    const pinId = pinIdFor(index, 'm');
    entries[pinId] = makePin(pinId, { text: `Body ${index} — ` + 'w'.repeat(1500) });
  }
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: Object.keys(entries) });
  const text = resultText(result);
  assert.equal(result.isError, undefined);
  assert.ok(text.length <= 20_000, `rendered ${text.length} chars — over the shaping window`);
  for (const pinId of Object.keys(entries)) {
    assert.ok(text.includes(`Pin ${pinId}:`), `missing meta block for ${pinId}`);
  }
  // Water-filling: the 166-char body renders whole even while the 1,515-char
  // bodies share what is left.
  assert.ok(text.includes('TINYWHOLEBODY-'), 'the short body must render whole');
  assert.match(text, /trimmed to fit this batch's result budget; full body via read_metaweb_pin/);
  assert.match(text, /11 body\(ies\) trimmed or omitted/);
});

test('small batches keep bodies whole (no trim label, full text rendered)', async () => {
  const entries = {};
  for (let index = 0; index < 10; index += 1) {
    const pinId = pinIdFor(index, 'q');
    entries[pinId] = makePin(pinId, { text: `Whole body ${index} — ` + 'z'.repeat(700) });
  }
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: Object.keys(entries) });
  const text = resultText(result);
  assert.equal(result.isError, undefined);
  assert.ok(text.length <= 20_000, `rendered ${text.length} chars — over the shaping window`);
  assert.doesNotMatch(text, /trimmed or omitted/);
  assert.ok(text.includes('z'.repeat(700)), 'full bodies must render for a small batch');
});

test('error and no-text entries never lose their lines', async () => {
  const goodId = pinIdFor(0, 'g');
  const errId = pinIdFor(1, 'e');
  const nullId = pinIdFor(2, 'n');
  const entries = {
    [goodId]: makePin(goodId, { text: 'g'.repeat(4000) }),
    [errId]: { pinId: errId, error: 'indexer gap' },
    [nullId]: makePin(nullId, { text: null, truncated: null, totalLength: null }),
  };
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: [goodId, errId, nullId] });
  const text = resultText(result);
  // Per-pin failures now name their cause on the human line too (2026-11-18):
  // "indexer gap" is not a located miss, so it must NOT be labelled not_found.
  assert.match(text, /- unreadable \(cause: extraction_failed\) error: indexer gap/);
  assert.ok(text.includes('has no readable text content'));
  assert.match(text, /- unreadable \(cause: content_contract\): /);
  assert.ok(text.includes(`Pin ${goodId}:`));
  assert.match(text, /1\/3 pin\(s\) readable/);
});

test('degenerate batch (skeletons alone over budget) fails loudly with a split size', async () => {
  const entries = {};
  for (let index = 0; index < 45; index += 1) {
    const pinId = pinIdFor(index, 's');
    entries[pinId] = makePin(pinId, { text: 'w'.repeat(300) });
  }
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: Object.keys(entries) });
  const text = resultText(result);
  assert.equal(result.isError, true);
  assert.match(text, /cannot render within the result budget/);
  assert.match(text, /Split it into batches of at most ~\d+ pinIds/);
});

test('budget constant sits safely under the 20k shaping cap', () => {
  assert.ok(METAWEB_BATCH_RESULT_CHAR_BUDGET < 20_000);
  assert.ok(METAWEB_BATCH_RESULT_CHAR_BUDGET >= 15_000, 'budget should stay generous for real batches');
});

const RECEIPT_PREFIX = '- RECEIPT read_metaweb_pins_batch: ';

/** Parse the machine-readable receipt line (issue #57) out of a batch result. */
function receiptOf(text) {
  const line = text.split('\n').find((entry) => entry.startsWith(RECEIPT_PREFIX));
  assert.ok(line, 'machine-readable receipt line missing');
  return JSON.parse(line.slice(RECEIPT_PREFIX.length));
}

/** The rendered section for one pin, up to the next section boundary. */
function sectionOf(text, pinId) {
  const start = text.indexOf(`Pin ${pinId}:`);
  assert.ok(start >= 0, `no rendered section for ${pinId}`);
  const next = text.indexOf('\n\nPin ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

test('batch receipt carries a machine-readable summary that a hand audit reproduces', async () => {
  const entries = {};
  for (let index = 0; index < 12; index += 1) {
    const pinId = pinIdFor(index, 'm');
    entries[pinId] = makePin(pinId, { text: `Body ${index} — ` + 'w'.repeat(1500) });
  }
  const { batch } = makeHarness(entries);
  const text = resultText(await batch.handler({ pinIds: Object.keys(entries) }));
  const receipt = receiptOf(text);

  assert.equal(receipt.requested, 12);
  assert.equal(receipt.readable_upstream, 12);
  assert.equal(receipt.caliber, METAWEB_BATCH_READ_CALIBER);
  // bytes_written is the real delivered byte count, not a decoration.
  assert.equal(receipt.bytes_written, Buffer.byteLength(text, 'utf8'));
  // The machine-readable line is part of the delivered bytes, so the render
  // budget must still hold with it included.
  assert.ok(text.length <= METAWEB_BATCH_RESULT_CHAR_BUDGET, `rendered ${text.length} chars`);

  // Every count is reproducible by parsing the receipt text itself.
  assert.equal(receipt.readable_upstream, (text.match(/^Pin .+:$/gm) ?? []).length);
  assert.equal(receipt.returned, (text.match(/<metaweb_pin_content>/g) ?? []).length);
  assert.equal(receipt.omitted, (text.match(/content omitted to fit this batch's result budget/g) ?? []).length);

  // Per-cut detail agrees with the per-pin human trim label.
  assert.ok(receipt.truncation_points.length > 0);
  assert.equal(receipt.truncation_point_count, receipt.truncation_points.length);
  for (const point of receipt.truncation_points.slice(0, 3)) {
    const label = sectionOf(text, point.pin_id).match(/showing first (\d+) of (\d+) chars/);
    assert.ok(label, `no trim label for ${point.pin_id}`);
    assert.equal(Number(label[1]), point.kept_chars);
    assert.equal(Number(label[2]), point.total_chars);
    assert.equal(point.reason, 'trimmed');
    assert.equal(point.unit, 'utf16-char');
    assert.ok(point.cut_at_bytes > 0 && point.cut_at_bytes < point.total_bytes);
  }
});

test('receipt fields are identical across two calls with the same pin list', async () => {
  const entries = {};
  for (let index = 0; index < 8; index += 1) {
    const pinId = pinIdFor(index, 'd');
    entries[pinId] = makePin(pinId, { text: `D ${index} ` + 'v'.repeat(3000) });
  }
  const { batch } = makeHarness(entries);
  const ids = Object.keys(entries);
  const first = resultText(await batch.handler({ pinIds: ids }));
  const second = resultText(await batch.handler({ pinIds: ids }));
  assert.equal(first, second, 'receipt text must be byte-identical across calls');
  assert.deepEqual(receiptOf(first), receiptOf(second));
});

test('receipt separates upstream-readable from actually-delivered and lists omissions', async () => {
  const entries = {};
  for (let index = 0; index < 20; index += 1) {
    const pinId = pinIdFor(index, 'o');
    entries[pinId] = makePin(pinId, { text: `Body ${index} — ` + 'y'.repeat(8000) });
  }
  const { batch } = makeHarness(entries);
  const text = resultText(await batch.handler({ pinIds: Object.keys(entries) }));
  const receipt = receiptOf(text);

  // Upstream reported every pin readable; the bodies were NOT delivered. The
  // ticket's core lesson is that these two numbers must not be conflated.
  assert.equal(receipt.readable_upstream, 20);
  assert.equal(receipt.returned, (text.match(/<metaweb_pin_content>/g) ?? []).length);
  assert.equal(receipt.omitted, 20);
  assert.equal(receipt.omitted, (text.match(/content omitted to fit this batch's result budget/g) ?? []).length);
  assert.equal(receipt.truncated, true);
  // Counts stay exact even when the id/point lists are capped for size.
  assert.ok(receipt.omitted_ids.length <= METAWEB_BATCH_RECEIPT_MAX_LIST);
  assert.equal(receipt.truncation_point_count, 20);
  assert.ok(receipt.truncation_points.length <= METAWEB_BATCH_RECEIPT_MAX_LIST);
  for (const point of receipt.truncation_points) {
    assert.equal(point.reason, 'omitted');
    assert.equal(point.kept_chars, 0);
    assert.equal(point.cut_at_bytes, 0);
  }
  assert.equal(receipt.bytes_written, Buffer.byteLength(text, 'utf8'));
  assert.ok(text.length <= METAWEB_BATCH_RESULT_CHAR_BUDGET, `rendered ${text.length} chars`);
});

test('receipt records unreadable ids and an upstream server cap', async () => {
  const goodId = pinIdFor(0, 'g');
  const capId = pinIdFor(1, 'c');
  const errId = pinIdFor(2, 'e');
  const nullId = pinIdFor(3, 'n');
  const entries = {
    [goodId]: makePin(goodId, { text: 'g'.repeat(4000) }),
    [capId]: makePin(capId, { text: 'C'.repeat(8000), truncated: true, totalLength: 12345 }),
    [errId]: { pinId: errId, error: 'indexer gap' },
    [nullId]: makePin(nullId, { text: null, truncated: null, totalLength: null }),
  };
  const { batch } = makeHarness(entries);
  const text = resultText(await batch.handler({ pinIds: [goodId, capId, errId, nullId] }));
  const receipt = receiptOf(text);

  assert.equal(receipt.requested, 4);
  assert.equal(receipt.readable_upstream, 2);
  assert.equal(receipt.returned, 2);
  assert.equal(receipt.unreadable, 2);
  assert.deepEqual(receipt.unreadable_ids, [errId, nullId]);
  const cap = receipt.truncation_points.find((point) => point.pin_id === capId);
  assert.equal(cap.reason, 'server_cap');
  assert.equal(cap.kept_chars, 8000); // runes delivered
  assert.equal(cap.total_chars, 12345); // full-body rune count the server reported
  assert.equal(cap.total_bytes, null); // full-body bytes are unknown after a server cap
  assert.equal(cap.unit, 'rune');
  assert.equal(receipt.bytes_written, Buffer.byteLength(text, 'utf8'));
});

test('a batch with no readable body still carries the machine-readable receipt', async () => {
  const errId = pinIdFor(0, 'z');
  const entries = { [errId]: { pinId: errId, error: 'gone' } };
  const { batch } = makeHarness(entries);
  const text = resultText(await batch.handler({ pinIds: [errId] }));
  const receipt = receiptOf(text);
  assert.equal(receipt.requested, 1);
  assert.equal(receipt.readable_upstream, 0);
  assert.equal(receipt.returned, 0);
  assert.equal(receipt.truncated, false);
  assert.equal(receipt.unreadable, 1);
  assert.deepEqual(receipt.unreadable_ids, [errId]);
  assert.equal(receipt.bytes_written, Buffer.byteLength(text, 'utf8'));
});

// ---------------------------------------------------------------------------
// Per-pin failure attribution (2026-11-18): four causes, never merged.
// ---------------------------------------------------------------------------

test('unreadable pins carry four distinct causes and the receipt splits them per pin', async () => {
  const hexId = (letter) => `${letter.repeat(64)}i0`;
  const goodId = hexId('a');
  const typoId = `pin://${'b'.repeat(64)}`;   // not a pin id at all
  const missingId = hexId('c');                // valid shape, absent from the upstream map
  const notFoundId = hexId('d');               // valid shape, upstream cannot locate the pin
  const nullId = hexId('e');                   // resolved pin, no text content
  const extractionId = hexId('f');             // resolved attempt, upstream parser error
  const entries = {
    [goodId]: makePin(goodId, { text: 'whole body' }),
    // A typo'd id that upstream also answered with an error: the id's shape
    // decides the cause, so the caller is told to fix the id.
    [typoId]: { pinId: typoId, error: 'pin not found' },
    [notFoundId]: { pinId: notFoundId, error: 'pin not found upstream' },
    [nullId]: makePin(nullId, { text: null, truncated: null, totalLength: null }),
    [extractionId]: { pinId: extractionId, error: 'payload parse failed (gzip)' },
  };
  const { batch } = makeHarness(entries, [missingId]);
  const text = resultText(await batch.handler({ pinIds: [goodId, typoId, missingId, notFoundId, nullId, extractionId] }));
  const receipt = receiptOf(text);

  assert.equal(receipt.requested, 6);
  assert.equal(receipt.readable_upstream, 1);
  assert.equal(receipt.unreadable, 5);
  // `not_found` has two sub-branches (no entry at all, and an upstream
  // not-found error) — both must land in the same cause, so the count is 2.
  assert.deepEqual(receipt.unreadable_causes, {
    malformed_id: 1,
    not_found: 2,
    content_contract: 1,
    extraction_failed: 1,
  });
  // Sum invariant: the per-cause split is exact, not a sample of the list.
  const summed = Object.values(receipt.unreadable_causes).reduce((a, b) => a + b, 0);
  assert.equal(summed, receipt.unreadable);
  // Per-pin attribution, in requested order, one cause each.
  assert.deepEqual(
    receipt.unreadable_pins.map((pin) => [pin.pin_id, pin.cause]),
    [
      [typoId, 'malformed_id'],
      [missingId, 'not_found'],
      [notFoundId, 'not_found'],
      [nullId, 'content_contract'],
      [extractionId, 'extraction_failed'],
    ],
  );
  // Human lines carry the same causes (a reader without the receipt can still act).
  assert.match(text, /- unreadable \(cause: malformed_id\) error: pin not found — not a pin id: /);
  assert.match(text, /- unreadable \(cause: not_found\): no entry returned/);
  assert.match(text, /- unreadable \(cause: not_found\) error: pin not found upstream/);
  assert.match(text, /- unreadable \(cause: content_contract\): /);
  assert.match(text, /- unreadable \(cause: extraction_failed\) error: payload parse failed \(gzip\)/);
  // The typo is never *caused* by a missing pin: its upstream error text is
  // echoed verbatim for the audit trail, but the cause is the id's shape.
  const typoStart = text.indexOf(`## ${typoId}`);
  assert.ok(typoStart >= 0, 'no rendered failure block for the typo id');
  const typoEnd = text.indexOf('\n\n## ', typoStart + 1);
  const typoLine = text.slice(typoStart, typoEnd === -1 ? undefined : typoEnd);
  assert.match(typoLine, /cause: malformed_id/);
  assert.doesNotMatch(typoLine, /cause: not_found/);
  assert.equal(receipt.bytes_written, Buffer.byteLength(text, 'utf8'));
});

