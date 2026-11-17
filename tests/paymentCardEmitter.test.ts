/**
 * paymentCardEmitter (G1) — the pure emitter behind the payment_card_emit
 * tool: owner's encrypted receiving info in, a renderer-valid `pay-card`
 * fence out (or a typed refusal).
 *
 * Pins:
 *   1. happy path — the fence round-trips through the RENDERER's own parser
 *      (parsePayCardFence), so an emitted card can always render;
 *   2. the payee block is derived from the stored info only: display name
 *      masked, receiving code kept, and the saved QR image / Alipay PID /
 *      ciphertext NEVER in the result;
 *   3. amount/memo cross-checks refuse a card instead of emitting a drifting
 *      face amount (AMOUNT_MISMATCH / MEMO_MISMATCH / INVALID_AMOUNT);
 *   4. error paths return typed codes: NO_RECEIVING_INFO, DECRYPT_FAILED,
 *      NO_QR_CHANNEL — never a card;
 *   5. the read adapter never leaks the cipher or the key material.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emitPaymentCard,
  readPaymentReceivingInfo,
  PAYMENT_CARD_MAX_AMOUNT_CENTS,
} from '../src/main/services/paymentCardEmitter';
import { encryptPaymentInfo, derivePaymentInfoKey, type PaymentReceivingInfo } from '../src/main/services/paymentInfoCrypto';
import { parsePayCardFence, formatCentsToYuan } from '../src/renderer/components/chat/paymentCardSyntax';

// Well-known valid 12-word test mnemonic (never holds funds) — same fixture
// convention as paymentInfoCrypto.test.mjs.
const TEST_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const TEST_GID = 'idqtestglobalmetaid00000000000000000000001';
// Synthetic receiving code in the real shape; never a real account's code.
const TEST_QR = 'https://qr.alipay.com/testcode4unittests0abc';
// Synthetic but shape-valid PID (2088 + 12 digits); never a real PID.
const TEST_PID = '2088000000000001';
// A fake "saved image": the real one is a ~300KB base64 blob that must never
// travel into a card or a reply.
const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FULL_INFO: PaymentReceivingInfo = {
  payeeDisplayName: '张三',
  alipayPid: TEST_PID,
  qrContent: TEST_QR,
  qrImageDataUrl: TEST_IMAGE,
};

function encryptForTest(info: PaymentReceivingInfo): { cipher: Buffer; updatedAt: number } {
  const key = derivePaymentInfoKey(TEST_MNEMONIC, TEST_GID);
  return { cipher: encryptPaymentInfo(key, info), updatedAt: 1_794_465_546_265 };
}

/** The masked name a card would carry for a given stored display name. */
function emitMasked(payeeDisplayName: string): string | undefined {
  const result = emitPaymentCard({ ...FULL_INFO, payeeDisplayName }, { orderId: 'mask-probe', amountCents: 1 });
  return result.status === 'ok' ? result.card.payee.displayName : undefined;
}

const identityDeps = {
  getIdentity: () => ({ mnemonic: TEST_MNEMONIC, globalmetaid: TEST_GID }),
};

describe('payment_card_emit happy path', () => {
  it('emits a fence the renderer parser accepts, with the exact amount/order', () => {
    const result = emitPaymentCard(FULL_INFO, { orderId: 'pcard-drill-20261117-01', amountCents: 1 });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;

    assert.match(result.fence, /^```pay-card\n/);
    assert.match(result.fence, /\n```$/);

    const body = result.fence.split('\n').slice(1, -1).join('\n');
    const parsed = parsePayCardFence(body);
    assert.ok(parsed, 'emitted card must pass the renderer gate');
    assert.equal(parsed.orderId, 'pcard-drill-20261117-01');
    assert.equal(parsed.amountCents, 1);
    assert.equal(parsed.currency, 'CNY');
    assert.equal(parsed.payee.qrContent, TEST_QR);
    assert.equal(formatCentsToYuan(parsed.amountCents), '0.01');
  });

  it('masks the payee display name and never carries the image, the PID or a cipher', () => {
    const result = emitPaymentCard(FULL_INFO, { orderId: 'pcard-drill-20261117-01', amountCents: 1 });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;

    // maskDisplayName's documented rule: 首字 + * + 末字 (a single star
    // whatever the length; 2-char names keep the last char hidden).
    assert.equal(result.card.payee.displayName, '张*');
    assert.equal(emitMasked('张三丰'), '张*丰');
    assert.equal(emitMasked('阿明工作室'), '阿*室');
    assert.equal(result.card.payee.alipayPid, undefined);
    assert.equal(result.card.payee.qrContent, TEST_QR);

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('data:image'), false, 'the saved QR image must never enter a card');
    assert.equal(serialized.includes(TEST_PID), false, 'the Alipay PID must never enter a card');
    assert.equal(serialized.includes('cipherBase64'), false);
    assert.equal(serialized.includes('qrImageDataUrl'), false);
  });

  it('keeps a card payee unnamed when the stored info has no display name', () => {
    const result = emitPaymentCard({ qrContent: TEST_QR }, { orderId: 'order-2', amountCents: 25 });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.card.payee.displayName, undefined);
    assert.equal(result.card.amountCents, 25);
  });
});

describe('payment_card_emit amount/memo cross-checks refuse a card', () => {
  const info = FULL_INFO;

  it('refuses when the declared yuan amount disagrees with the cents', () => {
    const result = emitPaymentCard(info, { orderId: 'order-3', amountCents: 1, amountYuan: '0.02' });
    assert.equal(result.status, 'refused');
    if (result.status !== 'refused') return;
    assert.equal(result.code, 'AMOUNT_MISMATCH');
  });

  it('accepts a matching declared yuan amount, exact to the cent', () => {
    const oneFen = emitPaymentCard(info, { orderId: 'order-3', amountCents: 1, amountYuan: '0.01' });
    assert.equal(oneFen.status, 'ok');
    const tenFen = emitPaymentCard(info, { orderId: 'order-3', amountCents: 10, amountYuan: '0.1' });
    assert.equal(tenFen.status, 'ok');
    const hundred = emitPaymentCard(info, { orderId: 'order-3', amountCents: 12_345, amountYuan: '123.45' });
    assert.equal(hundred.status, 'ok');
  });

  it('refuses a malformed declared yuan amount instead of guessing', () => {
    for (const amountYuan of ['0.001', '1.234', 'abc', '-1', '1,00', '']) {
      const result = emitPaymentCard(info, { orderId: 'order-4', amountCents: 100, amountYuan });
      assert.equal(result.status, 'refused', `amount_yuan "${amountYuan}" must be refused`);
      if (result.status !== 'refused') continue;
      assert.equal(result.code, 'INVALID_AMOUNT');
    }
  });

  it('refuses a memo that differs from the order id', () => {
    const result = emitPaymentCard(info, { orderId: 'order-5', amountCents: 100, memo: 'some other note' });
    assert.equal(result.status, 'refused');
    if (result.status !== 'refused') return;
    assert.equal(result.code, 'MEMO_MISMATCH');
  });

  it('accepts a memo equal to the order id (the card forces memo = order id)', () => {
    const result = emitPaymentCard(info, { orderId: 'order-5', amountCents: 100, memo: 'order-5' });
    assert.equal(result.status, 'ok');
  });

  it('refuses non-positive, fractional and over-ceiling amounts', () => {
    for (const amountCents of [0, -1, 1.5, Number.NaN, PAYMENT_CARD_MAX_AMOUNT_CENTS + 1]) {
      const result = emitPaymentCard(info, { orderId: 'order-6', amountCents });
      assert.equal(result.status, 'refused', `amount_cents ${String(amountCents)} must be refused`);
      if (result.status !== 'refused') continue;
      assert.equal(result.code, 'INVALID_AMOUNT');
    }
  });

  it('refuses an order id that the renderer parser would reject', () => {
    for (const orderId of ['', '-leading-dash', 'has space', 'a/b', 'x'.repeat(65)]) {
      const result = emitPaymentCard(info, { orderId, amountCents: 100 });
      assert.equal(result.status, 'refused', `order id "${orderId}" must be refused`);
      if (result.status !== 'refused') continue;
      assert.equal(result.code, 'INVALID_ORDER_ID');
    }
  });
});

describe('payment_card_emit channel refusals', () => {
  it('refuses a PID-only receiving info: this card pays by receiving code', () => {
    const result = emitPaymentCard({ payeeDisplayName: '李四', alipayPid: TEST_PID }, { orderId: 'order-7', amountCents: 100 });
    assert.equal(result.status, 'refused');
    if (result.status !== 'refused') return;
    assert.equal(result.code, 'NO_QR_CHANNEL');
  });

  it('refuses a non-Alipay QR payload that slipped past validation', () => {
    const result = emitPaymentCard({ qrContent: 'https://weixin.qq.com/pay/abc' }, { orderId: 'order-8', amountCents: 100 });
    assert.equal(result.status, 'refused');
    if (result.status !== 'refused') return;
    assert.equal(result.code, 'NO_QR_CHANNEL');
  });

  it('refuses empty receiving info', () => {
    const result = emitPaymentCard({}, { orderId: 'order-9', amountCents: 100 });
    assert.equal(result.status, 'refused');
    if (result.status !== 'refused') return;
    assert.equal(result.code, 'NO_QR_CHANNEL');
  });
});

describe('readPaymentReceivingInfo', () => {
  it('decrypts the stored row and returns the info plus its audit timestamp', () => {
    const read = readPaymentReceivingInfo({ ...identityDeps, readCipher: () => encryptForTest(FULL_INFO) });
    assert.equal(read.status, 'ok');
    if (read.status !== 'ok') return;
    assert.equal(read.info.qrContent, TEST_QR);
    assert.equal(read.info.payeeDisplayName, '张三');
    assert.equal(read.updatedAt, 1_794_465_546_265);
  });

  it('never returns the cipher itself', () => {
    const stored = encryptForTest(FULL_INFO);
    const read = readPaymentReceivingInfo({ ...identityDeps, readCipher: () => stored });
    assert.equal(read.status, 'ok');
    const serialized = JSON.stringify(read);
    assert.equal(serialized.includes(stored.cipher.toString('base64')), false);
  });

  it('refuses with NO_RECEIVING_INFO when the owner never saved receiving info', () => {
    const read = readPaymentReceivingInfo({ ...identityDeps, readCipher: () => null });
    assert.equal(read.status, 'refused');
    if (read.status !== 'refused') return;
    assert.equal(read.code, 'NO_RECEIVING_INFO');
  });

  it('refuses with DECRYPT_FAILED when the blob does not decrypt (wrong identity)', () => {
    const stored = encryptForTest(FULL_INFO);
    const read = readPaymentReceivingInfo({
      getIdentity: () => ({ mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', globalmetaid: TEST_GID }),
      readCipher: () => stored,
    });
    assert.equal(read.status, 'refused');
    if (read.status !== 'refused') return;
    assert.equal(read.code, 'DECRYPT_FAILED');
  });

  it('refuses with DECRYPT_FAILED when the local identity is unavailable', () => {
    const read = readPaymentReceivingInfo({
      getIdentity: () => null,
      readCipher: () => encryptForTest(FULL_INFO),
    });
    assert.equal(read.status, 'refused');
    if (read.status !== 'refused') return;
    assert.equal(read.code, 'DECRYPT_FAILED');
  });

  it('refuses with DECRYPT_FAILED when the store read throws', () => {
    const read = readPaymentReceivingInfo({
      ...identityDeps,
      readCipher: () => { throw new Error('sqlite busy'); },
    });
    assert.equal(read.status, 'refused');
    if (read.status !== 'refused') return;
    assert.equal(read.code, 'DECRYPT_FAILED');
  });

  it('drops foreign/legacy shapes instead of throwing inside the card builder', () => {
    const key = derivePaymentInfoKey(TEST_MNEMONIC, TEST_GID);
    const cipher = encryptPaymentInfo(key, { qrContent: 42 as unknown as string, payeeDisplayName: null as unknown as string });
    const read = readPaymentReceivingInfo({ ...identityDeps, readCipher: () => ({ cipher, updatedAt: 1 }) });
    assert.equal(read.status, 'ok');
    if (read.status !== 'ok') return;
    assert.equal(read.info.qrContent, undefined);
    assert.equal(read.info.payeeDisplayName, undefined);
  });
});

describe('end-to-end: stored row → read → emit', () => {
  it('produces a payable card from an encrypted row, keeping secrets out of the fence', () => {
    const stored = encryptForTest(FULL_INFO);
    const read = readPaymentReceivingInfo({ ...identityDeps, readCipher: () => stored });
    assert.equal(read.status, 'ok');
    if (read.status !== 'ok') return;

    const emitted = emitPaymentCard(read.info, { orderId: 'pcard-drill-20261117-01', amountCents: 1, amountYuan: '0.01' });
    assert.equal(emitted.status, 'ok');
    if (emitted.status !== 'ok') return;

    const parsed = parsePayCardFence(emitted.fence.split('\n').slice(1, -1).join('\n'));
    assert.ok(parsed);
    assert.equal(parsed.amountCents, 1);
    assert.equal(parsed.payee.qrContent, TEST_QR);

    assert.equal(emitted.fence.includes(TEST_IMAGE), false);
    assert.equal(emitted.fence.includes(TEST_PID), false);
    assert.equal(emitted.fence.includes(stored.cipher.toString('base64')), false);
    assert.ok(emitted.launchUrl?.startsWith('alipays://platformapi/startapp?saId=10000007&clientVersion='));
    assert.equal(emitted.launchUrl?.includes(encodeURIComponent(TEST_QR)), true);
  });
});
