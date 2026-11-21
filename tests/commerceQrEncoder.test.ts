// qrEncoder — bit-for-bit verification against reference QR matrices.
//
// tests/fixtures/qr-reference-matrices.json was produced by an independent
// reference implementation (python-qrcode, byte mode forced via QRData
// MODE_8BIT_BYTE, explicit mask_pattern, fit=True, border=0). Each case pins
// (text → version, size, 21..57 row bit-strings) for versions 1/3/7/8/10,
// EC levels L/M, all 8 masks on the v1 anchor plus the URL/CJK payloads —
// covering single- and multi-block interleave, 8/16-bit count indicators and
// UTF-8 content. Any encoder change must keep every matrix identical; a
// scannable-looking but subtly wrong QR is exactly the failure mode this
// fixture set exists to catch.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeQrMatrix } from '../src/renderer/components/commerce/qrEncoder.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'qr-reference-matrices.json'), 'utf8'),
);

test('qrEncoder reproduces every reference matrix bit-for-bit', () => {
  const cases = Object.entries(fixtures);
  assert.ok(cases.length >= 20, `expected >=20 fixtures, got ${cases.length}`);
  for (const [key, fx] of cases) {
    const [level, maskStr] = key.split('|');
    const qr = encodeQrMatrix(fx.text, { ecLevel: level, mask: Number(maskStr) });
    assert.equal(qr.version, fx.version, `${key} version`);
    assert.equal(qr.size, fx.size, `${key} size`);
    const mine = qr.modules.map((row) => row.map((cell) => (cell ? '1' : '0')).join(''));
    assert.equal(mine.length, fx.rows.length, `${key} row count`);
    for (let i = 0; i < mine.length; i += 1) {
      assert.equal(mine[i], fx.rows[i], `${key} row ${i}`);
    }
  }
});

test('qrEncoder auto mask selection stays within 0-7 and auto version fits', () => {
  const inviteUrl =
    'https://idbots.ai/invite?inviter=idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47&shop=1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0';
  const qr = encodeQrMatrix(inviteUrl, { ecLevel: 'M' });
  assert.ok(qr.mask >= 0 && qr.mask <= 7);
  assert.equal(qr.modules.length, qr.size);
  assert.ok(qr.modules.every((row) => row.length === qr.size));
  // The invite URL (≈134 bytes) must fit at or below version 10 at level M.
  assert.ok(qr.version <= 10, `invite url version ${qr.version} > 10`);
});

test('qrEncoder rejects overlong payloads and invalid forced masks', () => {
  assert.throws(() => encodeQrMatrix('x'.repeat(3000), { ecLevel: 'L' }), /too long/i);
  assert.throws(() => encodeQrMatrix('ok', { mask: 8 }), /mask/i);
  assert.throws(() => encodeQrMatrix('ok', { mask: -1 }), /mask/i);
});
