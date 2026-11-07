import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMeApprovalUrl,
  extractMeQrCode,
  meDiscountParts,
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

test('period pricing renders original price only for real discounts', () => {
  const monthly = 100;
  // Month: no original, no discount.
  assert.deepEqual(mePeriodPricing({ monthly, period: 'month' }), { price: 100, original: null });
  // Quarter with server discount pct (90 = pay 90%): ¥270 against ¥300.
  assert.deepEqual(
    mePeriodPricing({ monthly, period: 'quarter', quarterlyDiscountPct: 90 }),
    { price: 270, original: 300 },
  );
  // Quarter without a discount pct: full price, no original tag.
  assert.deepEqual(mePeriodPricing({ monthly, period: 'quarter' }), { price: 300, original: null });
  // Year with an explicit annual price: ¥960 against ¥1200.
  assert.deepEqual(
    mePeriodPricing({ monthly, period: 'year', annualPriceCny: 960 }),
    { price: 960, original: 1200 },
  );
  // A "discount" that is not cheaper must not show an original price.
  assert.deepEqual(
    mePeriodPricing({ monthly, period: 'year', annualPriceCny: 1200 }),
    { price: 1200, original: null },
  );
});

test('discount parts produce zh 折数 and en percent-off renderings', () => {
  assert.deepEqual(meDiscountParts(270, 300), { zhe: '9', pctOff: 10 });
  assert.deepEqual(meDiscountParts(85, 100), { zhe: '8.5', pctOff: 15 });
  // No discount → null (badge hidden).
  assert.equal(meDiscountParts(300, 300), null);
  assert.equal(meDiscountParts(310, 300), null);
  assert.equal(meDiscountParts(0, 300), null);
});
