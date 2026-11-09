import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import {
  PIN_ID_EXAMPLE,
  assertChainWritePinRefs,
  isValidPinId,
  isValidPinRef,
  scanBareFieldViolations,
  scanPinUriViolations,
  validateChainWritePinRefs,
} from '../src/main/libs/chainPinRefGuard';

// The bug report's two reference shapes (2026-11-08 write-preflight report):
// a well-formed pinid (66 chars) and a 64-hex value missing the `i0` suffix.
const VALID_PIN = '1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0';
const NO_I0 = 'd45cacbe489944ffa89acf39faa10dedfc3027ccd56c59a53c8a479b5b16684f';
// A foreign-minted pin reference: same hex, output index 1 (indexer-served
// MRC-721 items can carry iN; mrc721Service.isMrc721PinId accepts them).
const FOREIGN_PIN_I1 = VALID_PIN.slice(0, 64) + 'i1';

test('isValidPinId accepts exactly 64 lowercase hex + i0', () => {
  assert.equal(isValidPinId(VALID_PIN), true);
  assert.equal(isValidPinId(PIN_ID_EXAMPLE), true);
});

test('isValidPinRef accepts iN output indexes and rejects the report bug shapes', () => {
  assert.equal(isValidPinRef(VALID_PIN), true, 'self-minted i0');
  assert.equal(isValidPinRef(FOREIGN_PIN_I1), true, 'foreign i1 must be a valid reference');
  assert.equal(isValidPinRef(`${VALID_PIN.slice(0, 64)}i12`), true, '2-digit output index');
  assert.equal(isValidPinRef(NO_I0), false, '64 hex without the i suffix must be invalid');
  assert.equal(isValidPinRef(VALID_PIN.slice(0, 60)), false, 'truncated pinid');
  assert.equal(isValidPinRef(VALID_PIN.toUpperCase()), false, 'uppercase hex');
  assert.equal(isValidPinRef(`${VALID_PIN.slice(0, 64)}i1234`), false, 'implausible 4-digit output index');
  assert.equal(isValidPinRef(''), false);
});

test('isValidPinId rejects the report bug shapes', () => {
  assert.equal(isValidPinId(NO_I0), false, '64 hex without i0 must be invalid');
  assert.equal(isValidPinId(VALID_PIN.slice(0, 60)), false, 'truncated pinid');
  assert.equal(isValidPinId(VALID_PIN.toUpperCase()), false, 'uppercase hex');
  assert.equal(isValidPinId(`${VALID_PIN.slice(0, 65)}i1`), false, 'only i0 is a self-minted pinid');
  assert.equal(isValidPinId(''), false);
});

test('scanPinUriViolations: foreign iN references pass', () => {
  const text = `buy pin://${FOREIGN_PIN_I1} and list metafile://${FOREIGN_PIN_I1} for metaapp://${FOREIGN_PIN_I1}/trade.`;
  assert.deepEqual(scanPinUriViolations(text), []);
});

test('scanPinUriViolations: prose scheme mentions are NEVER blocked', () => {
  // 2026-11-10 release review: 11 false positives on SKILLs/metabot-metaapp/
  // SKILL.md prose — bare backticked scheme names and CJK punctuation were
  // judged "truncated pinids". Prose carries no reference and must not block.
  assert.deepEqual(scanPinUriViolations('解释和接入 `metaid://`、`pin://`、`metafile://`、`metaapp://`、`map://`'), []);
  assert.deepEqual(scanPinUriViolations('scans pin://, metafile:// and metaapp:// URIs in the payload'), []);
  assert.deepEqual(scanPinUriViolations('use the pin:// scheme or see pin:// docs'), []);
  assert.deepEqual(scanPinUriViolations("the manifest's `metaapp://` links are resolved by the host"), []);
  assert.deepEqual(scanPinUriViolations('syntax is pin://<pinId> with a pin://{pinId} variant'), []);
});

test('scanPinUriViolations: real on-chain skill documents are not blocked', () => {
  // Regression pin on the exact document that produced the false positives.
  const skillMd = readFileSync(fileURLToPath(new URL('../SKILLs/metabot-metaapp/SKILL.md', import.meta.url)), 'utf8');
  assert.deepEqual(scanPinUriViolations(skillMd), [], 'raw markdown must scan clean');
  assert.equal(
    validateChainWritePinRefs({ operation: 'create', payload: JSON.stringify({ serviceName: 'x', skillDocument: skillMd }) }),
    null,
    'the skill-service publish payload (skillDocument embedded in JSON) must pass the guard',
  );
});

test('scanPinUriViolations: well-formed URIs in all three schemes pass', () => {
  const text = `see [pin://${VALID_PIN}](pin://${VALID_PIN}) and metafile://${VALID_PIN} plus metaapp://${VALID_PIN}.`;
  assert.deepEqual(scanPinUriViolations(text), []);
});

test('scanPinUriViolations: 64-hex missing i0 is flagged (the reported bug)', () => {
  const violations = scanPinUriViolations(`quote pin://${NO_I0} here`);
  assert.equal(violations.length, 1);
  assert.match(violations[0].problem, /missing the output suffix/);
});

test('scanPinUriViolations: bare 64-hex without a scheme is NOT flagged', () => {
  // A bare 64-hex value may legitimately be a txid; only URI references are scanned.
  assert.deepEqual(scanPinUriViolations(`txid ${NO_I0} confirmed`), []);
});

test('scanPinUriViolations: truncation and uppercase references are flagged', () => {
  const truncated = scanPinUriViolations(`pin://${VALID_PIN.slice(0, 24)}…`);
  assert.equal(truncated.length, 1);
  assert.match(truncated[0].problem, /malformed/);

  const uppercase = scanPinUriViolations(`pin://${VALID_PIN.toUpperCase()}`);
  assert.equal(uppercase.length, 1);
  assert.match(uppercase[0].problem, /LOWERCASE/);
});

test('scanPinUriViolations: sentence punctuation and deep-link suffixes tolerated', () => {
  assert.deepEqual(scanPinUriViolations(`It lives at pin://${VALID_PIN}. Also metafile://${VALID_PIN}, ok.`), []);
  assert.deepEqual(scanPinUriViolations(`open metaapp://${VALID_PIN}/route?tab=2 now`), []);
});

test('scanPinUriViolations: doc placeholders are skipped', () => {
  assert.deepEqual(scanPinUriViolations('syntax is pin://<pinId> or pin://{pinId} or pin://${VAR}'), []);
});

test('scanPinUriViolations: metaid:// and preview-metaapp:// are not pin schemes', () => {
  assert.deepEqual(scanPinUriViolations('identity metaid://idq1abcxyz opens locally via preview-metaapp://whatever'), []);
});

test('scanPinUriViolations: JSON-escaped slashes still match', () => {
  // Hand-written JSON sometimes escapes slashes (`pin:\/\/...`); the scan
  // normalizes them before matching (modern JSON.stringify does not escape).
  const bs = String.fromCharCode(92);
  const violations = scanPinUriViolations(`{"ref":"pin:${bs}/${bs}/${NO_I0}"}`);
  assert.equal(violations.length, 1);
});

test('scanBareFieldViolations: pin-named hex field without i0 is flagged', () => {
  const violations = scanBareFieldViolations({ coursePinId: NO_I0 });
  assert.equal(violations.length, 1);
  assert.match(violations[0].location, /coursePinId/);
});

test('scanBareFieldViolations: well-formed pinid fields and URIs pass', () => {
  assert.deepEqual(scanBareFieldViolations({ pinId: VALID_PIN }), []);
  assert.deepEqual(scanBareFieldViolations({ itemPinId: FOREIGN_PIN_I1 }), [], 'indexer-read iN pinids are valid references');
  // Full URI values under pin keys are the URI scan's job, not the bare-field walk.
  assert.deepEqual(scanBareFieldViolations({ rootPinId: `pin://${VALID_PIN}` }), []);
  // Non-hex values under pin keys (timestamps, urls) are not pinids.
  assert.deepEqual(scanBareFieldViolations({ pinnedAt: '2026-11-08', spinCount: 4 }), []);
});

test('scanBareFieldViolations: txid fields must be plain 64-hex', () => {
  assert.deepEqual(scanBareFieldViolations({ txid: NO_I0 }), []);
  const pinInTxid = scanBareFieldViolations({ paymentTxid: VALID_PIN });
  assert.equal(pinInTxid.length, 1);
  assert.match(pinInTxid[0].problem, /pasted a pinid/);
});

test('scanBareFieldViolations: walks nested objects and arrays', () => {
  const violations = scanBareFieldViolations({ payload: { items: [{ artifactPinId: NO_I0 }] } });
  assert.equal(violations.length, 1);
  assert.match(violations[0].location, /payload\.items/);
});

test('validateChainWritePinRefs: clean payloads return null', () => {
  assert.equal(validateChainWritePinRefs({ operation: 'create', path: '/protocols/bottrain/enroll', payload: JSON.stringify({ coursePinId: VALID_PIN, submittedAt: 1762531200 }) }), null);
  assert.equal(validateChainWritePinRefs({ operation: 'create', payload: 'plain prose without any pin reference' }), null);
  assert.equal(validateChainWritePinRefs({ operation: 'create', payload: Buffer.from('binary') }), null, 'Buffer payloads are skipped');
  assert.equal(validateChainWritePinRefs({ operation: 'create', payload: Buffer.from('x').toString('base64'), encoding: 'base64' }), null, 'base64 payloads are skipped');
  assert.equal(validateChainWritePinRefs({ operation: 'create', payload: 'ciphertext', encryption: '1' }), null, 'encrypted payloads are skipped');
});

test('validateChainWritePinRefs: @pinId modify paths are validated', () => {
  assert.equal(validateChainWritePinRefs({ operation: 'modify', path: `@${VALID_PIN}`, payload: 'ok' }), null);
  assert.equal(validateChainWritePinRefs({ operation: 'modify', path: `@${FOREIGN_PIN_I1}/item_desc`, payload: 'ok' }), null, 'foreign iN modify paths are valid');
  const bad = validateChainWritePinRefs({ operation: 'modify', path: `@${NO_I0}`, payload: 'ok' });
  assert.match(bad ?? '', /\@pinId.*modify path/);
});

test('validateChainWritePinRefs: aggregates URI and bare-field violations with fix guidance', () => {
  const error = validateChainWritePinRefs({
    operation: 'create',
    payload: JSON.stringify({ coursePinId: NO_I0, note: `see pin://${VALID_PIN.slice(0, 30)}…` }),
  });
  assert.match(error ?? '', /BLOCKED before broadcast/);
  assert.match(error ?? '', /json:coursePinId/);
  assert.ok((error ?? '').includes(VALID_PIN.slice(0, 20)), 'message shows the pinid example');
  assert.match(error ?? '', /no fee was spent/);
});

test('assertChainWritePinRefs throws on malformed reference and passes clean payloads', () => {
  assert.throws(() => assertChainWritePinRefs({ operation: 'create', payload: `pin://${NO_I0}` }), /BLOCKED/);
  assert.doesNotThrow(() => assertChainWritePinRefs({ operation: 'create', payload: `pin://${VALID_PIN}` }));
});

test('metaidCore keeps the fail-closed gate at the shared worker spawn (source contract)', () => {
  // The guard must run inside spawnCreatePinWorker — the single chokepoint both
  // createPin and createPinForIdentity go through — BEFORE the worker resolves.
  const source = readFileSync(fileURLToPath(new URL('../src/main/services/metaidCore.ts', import.meta.url)), 'utf8');
  const spawnIdx = source.indexOf('export async function spawnCreatePinWorker');
  const gateIdx = source.indexOf('assertChainWritePinRefs(metaidData)');
  const workerResolveIdx = source.indexOf('getMainWorkerCandidatePaths', spawnIdx);
  assert.ok(spawnIdx > -1, 'spawnCreatePinWorker entry not found');
  assert.ok(gateIdx > spawnIdx, 'gate call missing from metaidCore');
  assert.ok(gateIdx < workerResolveIdx, 'gate must run before the worker path resolution');
});
