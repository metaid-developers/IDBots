import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMeApprovalUrl,
  extractMeQrCode,
  mePaymentPhase,
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
