import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMeApprovalUrl,
  extractMeQrCode,
  meDiscountFromPct,
  mePaymentPhase,
  mePeriodPricing,
  normalizeMePaymentCheckout,
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
  });
  assert.equal(normalizeMePaymentCheckout(null, 49), null);
  assert.equal(normalizeMePaymentCheckout({ status: 'created' }, 49), null);
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
