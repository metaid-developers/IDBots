import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAlipayVariantCUrl,
  formatCentsToYuan,
  isPayCardFenceLanguage,
  isValidAlipayQrContent,
  parsePayCardFence,
} from '../src/renderer/components/chat/paymentCardSyntax';

const QR = 'https://qr.alipay.com/testcode4unittests0abc';
const PID = '2088000000000001';

describe('pay-card fence parsing', () => {
  it('parses a full valid payload', () => {
    const body = JSON.stringify({
      orderId: 'S3-20261103-0001',
      amountCents: 100,
      currency: 'CNY',
      payee: { displayName: '*明', qrContent: QR },
      deadline: 1793641471526,
    });
    const parsed = parsePayCardFence(body);
    assert.ok(parsed);
    assert.equal(parsed.orderId, 'S3-20261103-0001');
    assert.equal(parsed.amountCents, 100);
    assert.equal(parsed.currency, 'CNY');
    assert.equal(parsed.payee.qrContent, QR);
    assert.equal(parsed.payee.displayName, '*明');
    assert.equal(parsed.deadline, 1793641471526);
  });

  it('accepts a PID-only card (no receiving-code link yet)', () => {
    const parsed = parsePayCardFence(JSON.stringify({
      orderId: 'S3-2', amountCents: 1, currency: 'CNY', payee: { alipayPid: PID },
    }));
    assert.ok(parsed);
    assert.equal(parsed.payee.alipayPid, PID);
  });

  it('rejects malformed or hostile payloads', () => {
    const base = { orderId: 'S3-3', amountCents: 100, currency: 'CNY', payee: { qrContent: QR } };
    assert.equal(parsePayCardFence('not json'), null);
    assert.equal(parsePayCardFence('[]'), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, orderId: '' })), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, orderId: 'bad id with space' })), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, amountCents: 0 })), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, amountCents: 1.5 })), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, amountCents: '100' })), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, currency: 'USD' })), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, payee: {} })), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, payee: { qrContent: 'https://evil.com/x' } })), null);
    assert.equal(parsePayCardFence(JSON.stringify({ ...base, payee: { qrContent: QR, alipayPid: '123' } })), null);
  });

  it('recognizes only the pay-card fence tags', () => {
    assert.equal(isPayCardFenceLanguage('pay-card'), true);
    assert.equal(isPayCardFenceLanguage('PayCard'), true);
    assert.equal(isPayCardFenceLanguage('paycard'), true);
    assert.equal(isPayCardFenceLanguage('nft-card'), false);
    assert.equal(isPayCardFenceLanguage(''), false);
  });
});

describe('Alipay variant C scheme construction', () => {
  it('builds the real-device-tested variant C URL with an encoded qrcode param', () => {
    const url = buildAlipayVariantCUrl(QR);
    assert.equal(
      url,
      'alipays://platformapi/startapp?saId=10000007&clientVersion=3.7.0.0718&qrcode=https%3A%2F%2Fqr.alipay.com%2Ftestcode4unittests0abc',
    );
    // The raw qr URL must not appear unencoded (parameter-injection guard).
    assert.equal(url?.includes('qrcode=https://'), false);
  });

  it('refuses anything that is not an Alipay receiving-code URL', () => {
    assert.equal(buildAlipayVariantCUrl('https://example.com/x'), null);
    assert.equal(buildAlipayVariantCUrl('javascript:alert(1)'), null);
    assert.equal(buildAlipayVariantCUrl('https://qr.alipay.com/'), null);
    assert.equal(buildAlipayVariantCUrl(''), null);
  });

  it('keeps the qrcode gate aligned with the crypto module rule', () => {
    assert.equal(isValidAlipayQrContent(QR), true);
    assert.equal(isValidAlipayQrContent('https://qr.alipay.com/abc'), false);
  });
});

describe('amount formatting', () => {
  it('renders integer cents as exact two-decimal yuan', () => {
    assert.equal(formatCentsToYuan(1), '0.01');
    assert.equal(formatCentsToYuan(100), '1.00');
    assert.equal(formatCentsToYuan(12345), '123.45');
    assert.equal(formatCentsToYuan(100000), '1000.00');
  });
});
