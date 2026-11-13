import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMeOrderIdempotencyKey,
  bumpMeOrderGeneration,
  extractMeApprovalUrl,
  extractMeExpiresAt,
  extractMeProration,
  extractMeQrCode,
  formatMeMoney,
  meCheckoutErrorKey,
  meDiscountFromPct,
  meGatewayCharge,
  meOrderGenerationSlotKey,
  mePaypalUsdFromCny,
  mePaymentPhase,
  mePeriodPricing,
  normalizeMePaymentCheckout,
  readMeOrderGeneration,
  shouldRetryTerminalMeOrder,
} from '../src/renderer/components/me/mePayment.ts';

test('checkout parsing matches the traffic recharge gatewayParams contract', () => {
  const approvalUrl = 'https://www.paypal.com/checkoutnow?token=ME-1';
  assert.equal(extractMeApprovalUrl({ approval_url: approvalUrl }), approvalUrl);
  assert.equal(extractMeApprovalUrl({ paymentUrl: 'not-a-url' }), '');
  assert.equal(extractMeQrCode({ qr_code: 'https://qr.alipay.com/me-1' }), 'https://qr.alipay.com/me-1');
  assert.equal(extractMeQrCode({ qrCodeContent: 'alipay-sdk-content' }), 'alipay-sdk-content');
});

test('checkout normalization uses server price and gateway data before local fallbacks', () => {
  const checkout = normalizeMePaymentCheckout({
    orderId: 'me-order-1',
    status: 'created',
    payAmount: 49,
    payCurrency: 'CNY',
    gatewayParams: { qrCode: 'https://qr.alipay.com/me-order-1' },
  }, 999);
  assert.deepEqual(checkout, {
    orderId: 'me-order-1',
    status: 'created',
    approvalUrl: '',
    qrCode: 'https://qr.alipay.com/me-order-1',
    payAmount: 49,
    payCurrency: 'CNY',
    expiresAt: undefined,
  });
  assert.equal(normalizeMePaymentCheckout(null, 49), null);
  assert.equal(normalizeMePaymentCheckout({ status: 'created' }, 49), null);
});

test('checkout carries the payment-code expiry when the server sends one (and nothing when it does not)', () => {
  // Current servers send no expiry field at all.
  assert.equal(extractMeExpiresAt({ gatewayParams: { qrCode: 'https://qr.alipay.com/x' } }), undefined);
  // Order-body and gatewayParams keys, in seconds or milliseconds.
  assert.equal(extractMeExpiresAt({ expiresAt: 1794000000 }), 1794000000000);
  assert.equal(extractMeExpiresAt({ expire_at: 1794000000000 }), 1794000000000);
  assert.equal(extractMeExpiresAt({ gatewayParams: { qrExpireAt: 1794000000 } }), 1794000000000);
  assert.equal(extractMeExpiresAt({ gatewayParams: { timeExpire: 0 }, expiresAt: 1794000000 }), 1794000000000);
  // Garbage values are ignored, not coerced.
  assert.equal(extractMeExpiresAt({ expiresAt: 'not-a-number' }), undefined);
  assert.equal(extractMeExpiresAt({ expiresAt: -5 }), undefined);
  // Surfaced on the normalized checkout.
  const checkout = normalizeMePaymentCheckout({
    orderId: 'me-order-3',
    status: 'created',
    gatewayParams: { qrCode: 'https://qr.alipay.com/me-order-3', expiresAt: 1794000000 },
  }, 49);
  assert.equal(checkout?.expiresAt, 1794000000000);
});

test('checkout normalization accepts legacy amount fields without overriding server values', () => {
  const checkout = normalizeMePaymentCheckout({
    orderId: 'me-order-2',
    amountCny: 149,
    gatewayParams: { approvalUrl: 'https://www.paypal.com/checkoutnow?token=ME-2' },
  }, 49);
  assert.equal(checkout?.payAmount, 149);
  assert.equal(checkout?.payCurrency, 'CNY');
  assert.equal(checkout?.approvalUrl.includes('paypal.com'), true);
});

test('payment status only completes on credit and closes on terminal failure', () => {
  for (const status of ['confirmed', 'credited', 'active', 'completed', 3]) {
    assert.equal(mePaymentPhase(status), 'credited');
  }
  for (const status of ['closed', 'rejected', 'expired', 'cancelled', 'failed', 4]) {
    assert.equal(mePaymentPhase(status), 'closed');
  }
  for (const status of ['created', 'submitted', 'paid', 'pending', '']) {
    assert.equal(mePaymentPhase(status), 'pending');
  }
});

test('period pricing follows the uniform monthly-rate model (quarter 90% / year 80%)', () => {
  // ID.Pupil (¥49/mo): tag shows the discounted monthly rate; the one-payment
  // total is monthly × months × pct and equals what the server charges.
  assert.deepEqual(mePeriodPricing({ monthly: 49, period: 'month' }), {
    months: 1, discountPct: 100, monthlyRate: 49, total: 49, originalMonthly: null,
  });
  assert.deepEqual(mePeriodPricing({ monthly: 49, period: 'quarter' }), {
    months: 3, discountPct: 90, monthlyRate: 44.1, total: 132.3, originalMonthly: 49,
  });
  assert.deepEqual(mePeriodPricing({ monthly: 49, period: 'year' }), {
    months: 12, discountPct: 80, monthlyRate: 39.2, total: 470.4, originalMonthly: 49,
  });
  // Per-plan fields (quarterlyDiscountPct / annualPriceCny) no longer drive
  // pricing — every tier uses the same 90/80 rule.
  assert.deepEqual(mePeriodPricing({ monthly: 149, period: 'year' }), {
    months: 12, discountPct: 80, monthlyRate: 119.2, total: 1430.4, originalMonthly: 149,
  });
  assert.deepEqual(mePeriodPricing({ monthly: 449, period: 'quarter' }), {
    months: 3, discountPct: 90, monthlyRate: 404.1, total: 1212.3, originalMonthly: 449,
  });
});

test('discount parts derive from the applied percent for zh/en badges', () => {
  assert.deepEqual(meDiscountFromPct(90), { zhe: '9', pctOff: 10 });
  assert.deepEqual(meDiscountFromPct(80), { zhe: '8', pctOff: 20 });
  assert.deepEqual(meDiscountFromPct(85), { zhe: '8.5', pctOff: 15 });
  // No discount → null (badge hidden).
  assert.equal(meDiscountFromPct(100), null);
  assert.equal(meDiscountFromPct(0), null);
});

test('proration fields stay absent until the server reports them (never invented)', () => {
  // No breakdown and no fields → absent (not 0): the UI must not show a
  // credit line the server did not grant.
  assert.deepEqual(extractMeProration({ orderId: 'me-order-1' }), {});
  assert.deepEqual(extractMeProration({ orderId: 'me-order-1', breakdown: {} }), {});
  assert.deepEqual(extractMeProration(null), {});
  // Order body and breakdown object, with the field aliases the amendment
  // may ship under.
  assert.deepEqual(
    extractMeProration({ orderId: 'me-order-2', listAmountCny: 132.3, creditCny: 24.5 }),
    { listAmountCny: 132.3, creditAppliedCny: 24.5 },
  );
  assert.deepEqual(
    extractMeProration({ orderId: 'me-order-3', breakdown: { list_amount_cny: 4310.4, prorationCreditCny: 300 } }),
    { listAmountCny: 4310.4, creditAppliedCny: 300 },
  );
  // Garbage values are ignored, not coerced to 0.
  assert.deepEqual(extractMeProration({ orderId: 'x', creditCny: 'abc' }), {});
  // Surfaced on the normalized checkout.
  const checkout = normalizeMePaymentCheckout({
    orderId: 'me-order-4',
    status: 'created',
    payAmount: 402.3,
    breakdown: { listAmountCny: 402.3, creditCny: 36.15 },
  }, 402.3);
  assert.equal(checkout?.creditAppliedCny, 36.15);
  assert.equal(checkout?.listAmountCny, 402.3);
  // And absent when the server sends nothing (deepEqual has no extra keys).
  const plain = normalizeMePaymentCheckout({ orderId: 'me-order-5', payAmount: 49 }, 49);
  assert.equal(plain?.creditAppliedCny, undefined);
  assert.equal(plain?.listAmountCny, undefined);
});

test('PayPal charges whole USD: ceil(CNY / 6) of the final amount (owner ruling 2026-11-13)', () => {
  assert.equal(mePaypalUsdFromCny(49), 9);
  assert.equal(mePaypalUsdFromCny(149), 25);
  assert.equal(mePaypalUsdFromCny(449), 75);
  assert.equal(mePaypalUsdFromCny(132.3), 23);
  assert.equal(mePaypalUsdFromCny(470.4), 79);
  assert.equal(mePaypalUsdFromCny(48), 8);
  assert.equal(mePaypalUsdFromCny(0), 0);
  assert.deepEqual(meGatewayCharge('paypal', 132.3), { amount: 23, currency: 'USD' });
  assert.deepEqual(meGatewayCharge('alipay', 132.3), { amount: 132.3, currency: 'CNY' });
  assert.equal(formatMeMoney(9, 'USD'), '$9');
  assert.equal(formatMeMoney(49, 'CNY'), '¥49');
  assert.equal(formatMeMoney(null, 'USD'), '—');
  // the server's USD figure wins; the currency fallback only fills a gap
  const checkout = normalizeMePaymentCheckout({
    orderId: 'mso_1', status: 'created', payAmount: 9, payCurrency: 'USD',
    gatewayParams: { approvalUrl: 'https://www.paypal.com/checkoutnow?token=X' },
  }, 49);
  assert.equal(checkout?.payAmount, 9);
  assert.equal(checkout?.payCurrency, 'USD');
  assert.equal(normalizeMePaymentCheckout({ orderId: 'mso_2' }, 9, 'USD')?.payCurrency, 'USD');
});

test('checkout errors map by errorCode, never the bare "error" envelope message', () => {
  assert.equal(meCheckoutErrorKey('GATEWAY_UNAVAILABLE', 'error'), 'mePurchaseGatewayUnavailable');
  assert.equal(meCheckoutErrorKey('GATEWAY_NOT_CONFIGURED', 'error'), 'mePurchaseGatewayNotConfigured');
  assert.equal(meCheckoutErrorKey('PLAN_DOWNGRADE_NOT_ALLOWED', 'error'), 'mePurchaseDowngradeBlocked');
  assert.equal(meCheckoutErrorKey('LIMIT_EXCEEDED', 'error'), 'mePurchaseRateLimited');
  assert.equal(meCheckoutErrorKey('INTERNAL_ERROR', 'error'), 'mePurchaseServiceError');
  assert.equal(meCheckoutErrorKey('', 'error'), 'mePurchaseServiceError');
  // a real descriptive message without a known code stays visible as-is
  assert.equal(meCheckoutErrorKey('', 'ME service request timed out after 15000ms.'), '');
});

test('same-day idempotency generation bumps unblock repeat topups and expired orders', () => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
  };
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const slot = meOrderGenerationSlotKey({ section: 'topup', subjectId: 'pkg-1', gateway: 'alipay' });
  assert.equal(readMeOrderGeneration(slot, storage, now), 0);
  assert.equal(
    buildMeOrderIdempotencyKey({ scope: 'desktop', section: 'topup', subjectId: 'pkg-1', gateway: 'alipay', generation: 0, now }),
    'desktop-topup-pkg-1-alipay-2026-11-13',
  );
  const gen1 = bumpMeOrderGeneration(slot, storage, now);
  assert.equal(gen1, 1);
  assert.equal(readMeOrderGeneration(slot, storage, now), 1);
  assert.equal(
    buildMeOrderIdempotencyKey({ scope: 'desktop', section: 'topup', subjectId: 'pkg-1', gateway: 'alipay', generation: gen1, now }),
    'desktop-topup-pkg-1-alipay-2026-11-13-r1',
  );
  assert.equal(shouldRetryTerminalMeOrder({ status: 'closed', createdAt: now }, now), true);
  assert.equal(shouldRetryTerminalMeOrder({ status: 'credited', createdAt: now - 60_000 }, now), true);
  assert.equal(shouldRetryTerminalMeOrder({ status: 'credited', createdAt: now }, now), false);
  assert.equal(shouldRetryTerminalMeOrder({ status: 'created', createdAt: now - 60_000 }, now), false);
});
