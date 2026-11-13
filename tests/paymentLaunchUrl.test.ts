/**
 * Payment launch URL gate (S3 fiat defect: desktop never opened Alipay).
 *
 * The defect: Electron's navigation guards only forwarded http/https/mailto/
 * tel to the OS, so `location.href = alipays://…` from PaymentCard was a
 * silent no-op and the card degraded to the QR fallback after 2s.
 *
 * The fix opens a deliberately narrow hole: exactly the variant-C launch
 * shape the card builds. These tests pin both directions — the real card URL
 * passes, every neighbouring custom scheme / alipays shape stays blocked —
 * plus the main-process wiring, because a pure function nobody calls fixes
 * nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isAllowedPaymentLaunchUrl } from '../src/main/paymentLaunchUrl';
import { buildAlipayVariantCUrl } from '../src/renderer/components/chat/paymentCardSyntax';

const QR_CONTENT = 'https://qr.alipay.com/abc123xyz';
const CARD_URL = buildAlipayVariantCUrl(QR_CONTENT)!;

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('isAllowedPaymentLaunchUrl — the one scheme the receiving card needs', () => {
  it('allows the exact variant-C URL the PaymentCard itself builds', () => {
    assert.ok(CARD_URL.startsWith('alipays://platformapi/startapp?'));
    assert.equal(isAllowedPaymentLaunchUrl(CARD_URL), true);
  });

  it('allows it regardless of clientVersion (the card may bump the version)', () => {
    const url = `alipays://platformapi/startapp?saId=10000007&clientVersion=9.9.9&qrcode=${encodeURIComponent(QR_CONTENT)}`;
    assert.equal(isAllowedPaymentLaunchUrl(url), true);
  });

  it('blocks every other custom scheme', () => {
    for (const url of [
      'testapp://open/thing',
      'weixin://dl/business?whatever=1',
      'bitcoin:bc1qexample',
      'mailto:someone@example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      assert.equal(isAllowedPaymentLaunchUrl(url), false, url);
    }
  });

  it('blocks http(s) too — those stay governed by isAllowedExternalUrl', () => {
    assert.equal(isAllowedPaymentLaunchUrl('https://qr.alipay.com/abc123xyz'), false);
    assert.equal(isAllowedPaymentLaunchUrl('http://example.com/'), false);
  });

  it('blocks alipays URLs that reach past the scan entry', () => {
    const q = encodeURIComponent(QR_CONTENT);
    for (const url of [
      // other host / path
      `alipays://evil.example/startapp?saId=10000007&qrcode=${q}`,
      `alipays://platformapi/other?saId=10000007&qrcode=${q}`,
      `alipays://platformapi:8443/startapp?saId=10000007&qrcode=${q}`,
      `alipays://user:pass@platformapi/startapp?saId=10000007&qrcode=${q}`,
      // URL-normalized to host platformapi + path /startapp, but NOT the raw
      // variant-C prefix — this is the case the exact-prefix check exists for.
      `alipays://platformapi/x/../startapp?saId=10000007&qrcode=${q}`,
      // another mini program
      `alipays://platformapi/startapp?saId=20000067&qrcode=${q}`,
      // missing / duplicated / smuggled parameters
      `alipays://platformapi/startapp?qrcode=${q}`,
      `alipays://platformapi/startapp?saId=10000007&qrcode=${q}&qrcode=${q}`,
      `alipays://platformapi/startapp?saId=10000007&qrcode=${q}&appId=20000067`,
      `alipays://platformapi/startapp?saId=10000007&qrcode=${q}#fragment`,
      // a qrcode that is not an Alipay receiving code
      `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent('https://evil.example/abc123')}`,
      `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent('http://qr.alipay.com/abc123xyz')}`,
      `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent('https://qr.alipay.com/ab')}`,
      `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent('https://qr.alipay.com/abc 123')}`,
      // percent-encoded newline inside the decoded qrcode
      `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent('https://qr.alipay.com/abc%0Adef')}`,
    ]) {
      assert.equal(isAllowedPaymentLaunchUrl(url), false, url);
    }
  });

  it('blocks whitespace / control-character smuggling in the raw string', () => {
    for (const url of [
      ` ${CARD_URL}`,
      `${CARD_URL}\n`,
      `alipays:\n//platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(QR_CONTENT)}`,
      `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(QR_CONTENT)}\t`,
    ]) {
      assert.equal(isAllowedPaymentLaunchUrl(url), false, JSON.stringify(url));
    }
  });

  it('rejects uppercase scheme and non-string input', () => {
    assert.equal(
      isAllowedPaymentLaunchUrl(`ALIPAYS://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(QR_CONTENT)}`),
      false,
    );
    assert.equal(isAllowedPaymentLaunchUrl(''), false);
    assert.equal(isAllowedPaymentLaunchUrl(undefined as unknown as string), false);
  });
});

describe('main-process wiring — the gate is actually on the navigation paths', () => {
  const mainSource = read('src/main/main.ts');

  it('imports the gate and keeps the generic allowlist unchanged', () => {
    assert.match(mainSource, /import \{ isAllowedPaymentLaunchUrl \} from '\.\/paymentLaunchUrl';/);
    // Regression guard: alipays must NOT be folded into the generic set — that
    // would let every alipays: URL (and every future scheme added there) through.
    const allowlistLine = mainSource.match(/const EXTERNAL_URL_PROTOCOL_ALLOWLIST = new Set\(\[[^\]]*\]\);/);
    assert.ok(allowlistLine, 'generic external allowlist not found');
    assert.doesNotMatch(allowlistLine[0], /alipays/);
  });

  it('checks the payment gate in setWindowOpenHandler', () => {
    const start = mainSource.indexOf('win.webContents.setWindowOpenHandler');
    assert.ok(start >= 0);
    const block = mainSource.slice(start, start + 700);
    assert.match(block, /isAllowedPaymentLaunchUrl\(url\)/);
    assert.match(block, /isAllowedExternalUrl\(url\)/, 'http(s)/mailto/tel path must survive');
    assert.match(block, /shell\.openExternal\(url\)/);
  });

  it('checks the payment gate in will-navigate', () => {
    const start = mainSource.indexOf("win.webContents.on('will-navigate'");
    assert.ok(start >= 0);
    const block = mainSource.slice(start, start + 1400);
    assert.match(block, /isAllowedPaymentLaunchUrl\(url\)/);
    assert.match(block, /isAllowedExternalUrl\(url\)/, 'http(s)/mailto/tel path must survive');
    assert.match(block, /shell\.openExternal\(url\)/);
    assert.match(block, /event\.preventDefault\(\)/, 'the in-app navigation must still be cancelled');
  });
});
