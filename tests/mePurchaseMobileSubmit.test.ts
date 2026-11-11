// S9-A subscription order — mobile client slice.
//
// The endpoint is not deployed yet (2026-11-05 07:xx /v1/me/subscription*
// still answers 404), so these tests pin the CLIENT contract:
//
//   1. the 订阅 branch builds a submitSubscriptionOrder request
//      ({planId, period, channel:'mobile', ...}) — never a packageId;
//   2. the 充值 branch still builds submitTopupOrder ({packageId, ...}) —
//      never a planId (before this slice the screen sent a planId to
//      submitTopupOrder, which is why a free tier could never subscribe);
//   3. success order ids come from the matching response envelope only
//      (subscriptionOrder.orderId vs submission.order.orderId);
//   4. a 404 featureUnavailable surfaces on the FIRST answer — one IPC call,
//      no retry into a duplicate order;
//   5. the screen itself routes through the helper (source-level guard).
//
// Run: node --test tests/mePurchaseMobileSubmit.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildMePurchaseOrderRequest,
  submitMePurchaseOrder,
  type MePurchaseSubmitApi,
} from '../src/mobile/app/me/purchaseSubmit.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_SOURCE = readFileSync(
  path.join(here, '..', 'src/mobile/app/screens/MePurchaseScreen.tsx'),
  'utf8',
);

interface RecordedCall {
  method: 'submitSubscriptionOrder' | 'submitTopupOrder';
  input: Record<string, unknown>;
}

function fakeApi(answers: {
  subscription?: Record<string, unknown>;
  topup?: Record<string, unknown>;
}): MePurchaseSubmitApi & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    submitSubscriptionOrder: async (input) => {
      calls.push({ method: 'submitSubscriptionOrder', input: input as unknown as Record<string, unknown> });
      return (answers.subscription ?? { success: true, subscriptionOrder: { orderId: 'sub-1' } }) as never;
    },
    submitTopupOrder: async (input) => {
      calls.push({ method: 'submitTopupOrder', input: input as unknown as Record<string, unknown> });
      return (answers.topup ?? { success: true, submission: { order: { orderId: 'top-1' } } }) as never;
    },
  };
}

test('subscribe builds a subscription request carrying planId + period + channel=mobile', () => {
  const request = buildMePurchaseOrderRequest({
    section: 'subscribe',
    planId: 'plan-pro',
    packageId: 'pkg-99',
    period: 'quarter',
    voucherUrl: 'https://gateway/voucher.png',
    voucherRemark: '订阅 Pro / 季度',
    now: 1793835740777,
  });
  assert.ok(request);
  assert.equal(request.kind, 'subscribe');
  assert.deepEqual(request.input, {
    planId: 'plan-pro',
    period: 'quarter',
    channel: 'mobile',
    gateway: 'alipay',
    voucherUrl: 'https://gateway/voucher.png',
    voucherRemark: '订阅 Pro / 季度',
    // R2.2-stable key: UTC day-stamp, subject + period — abandoned
    // checkouts resume instead of stacking payable duplicates.
    idempotencyKey: 'mobile-subscribe-plan-pro-quarter-alipay-2026-11-04',
  });
  // The充值 subject must never leak into the subscription request.
  assert.equal('packageId' in request.input, false);
  assert.equal('periodDays' in request.input, false);
});

test('idempotency keys are stable within a UTC day and differ across subjects/periods/days', () => {
  const sameDayLater = buildMePurchaseOrderRequest({
    section: 'subscribe', planId: 'plan-pro', period: 'quarter', now: 1793835740777 + 600_000,
  });
  assert.equal(
    sameDayLater && sameDayLater.kind === 'subscribe' ? sameDayLater.input.idempotencyKey : '',
    'mobile-subscribe-plan-pro-quarter-alipay-2026-11-04',
    'same subject+period on the same UTC day must reuse the SAME key (server dedup)',
  );
  const twoDaysLater = buildMePurchaseOrderRequest({
    section: 'subscribe', planId: 'plan-pro', period: 'quarter', now: 1793835740777 + 2 * 86_400_000,
  });
  assert.equal(
    twoDaysLater && twoDaysLater.kind === 'subscribe' ? twoDaysLater.input.idempotencyKey : '',
    'mobile-subscribe-plan-pro-quarter-alipay-2026-11-06',
  );
  const otherPeriod = buildMePurchaseOrderRequest({
    section: 'subscribe', planId: 'plan-pro', period: 'year', now: 1793835740777,
  });
  assert.notEqual(
    otherPeriod && otherPeriod.kind === 'subscribe' ? otherPeriod.input.idempotencyKey : '',
    'mobile-subscribe-plan-pro-quarter-alipay-2026-11-04',
    'a different period is a different product, never the same order',
  );
});

test('topup keeps the package channel and never forwards a planId', () => {
  const request = buildMePurchaseOrderRequest({
    section: 'topup',
    planId: 'plan-pro',
    packageId: 'pkg-99',
    period: 'month',
    voucherRemark: '充值 99',
    now: 42,
  });
  assert.ok(request);
  assert.equal(request.kind, 'topup');
  assert.equal(request.input.packageId, 'pkg-99');
  assert.equal(request.input.periodDays, undefined);
  assert.equal(request.input.gateway, 'alipay');
  assert.equal(request.input.voucherRemark, '充值 99');
  assert.equal(request.input.idempotencyKey, 'mobile-topup-pkg-99-alipay-1970-01-01');
  assert.equal('planId' in request.input, false);
  assert.equal('channel' in request.input, false);
});

test('no selected subject yields no request (both sections)', () => {
  assert.equal(buildMePurchaseOrderRequest({
    section: 'subscribe', planId: '', packageId: 'pkg-99', period: 'month',
  }), null);
  assert.equal(buildMePurchaseOrderRequest({
    section: 'topup', planId: 'plan-pro', packageId: '', period: 'month',
  }), null);
});

test('subscribe success reads subscriptionOrder.orderId, not the topup envelope', async () => {
  const api = fakeApi({
    subscription: { success: true, subscriptionOrder: { orderId: 'sub-77' }, submission: { order: { orderId: 'wrong' } } },
  });
  const request = buildMePurchaseOrderRequest({ section: 'subscribe', planId: 'plan-pro', period: 'year', now: 1 });
  assert.ok(request);
  const result = await submitMePurchaseOrder(api, request);
  assert.deepEqual(result, { ok: true, orderId: 'sub-77' });
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, 'submitSubscriptionOrder');
  assert.equal(api.calls[0].input.channel, 'mobile');
});

test('topup success still reads submission.order.orderId from submitTopupOrder', async () => {
  const api = fakeApi({
    topup: { success: true, submission: { order: { orderId: 'top-88' } }, subscriptionOrder: { orderId: 'wrong' } },
  });
  const request = buildMePurchaseOrderRequest({ section: 'topup', packageId: 'pkg-9', period: 'month', now: 1 });
  assert.ok(request);
  const result = await submitMePurchaseOrder(api, request);
  assert.deepEqual(result, { ok: true, orderId: 'top-88' });
  assert.deepEqual(api.calls.map((call) => call.method), ['submitTopupOrder']);
});

test('subscribe success carries the server-priced payAmount through (2026-11-10 P1)', async () => {
  const api = fakeApi({
    subscription: { success: true, subscriptionOrder: { orderId: 'sub-9', payAmount: 267.3 } },
  });
  const request = buildMePurchaseOrderRequest({ section: 'subscribe', planId: 'plan-pro', period: 'quarter', now: 1 });
  assert.ok(request);
  const result = await submitMePurchaseOrder(api, request);
  assert.deepEqual(result, { ok: true, orderId: 'sub-9', payAmount: 267.3 });
});

test('topup success carries the server-priced payAmount through when present', async () => {
  const api = fakeApi({
    topup: { success: true, submission: { order: { orderId: 'top-9', payAmount: 30 } } },
  });
  const request = buildMePurchaseOrderRequest({ section: 'topup', packageId: 'pkg-9', period: 'month', now: 1 });
  assert.ok(request);
  const result = await submitMePurchaseOrder(api, request);
  assert.deepEqual(result, { ok: true, orderId: 'top-9', payAmount: 30 });
});

test('a response without payAmount omits the field (no fabricated amount)', async () => {
  const api = fakeApi({
    subscription: { success: true, subscriptionOrder: { orderId: 'sub-10' } },
  });
  const request = buildMePurchaseOrderRequest({ section: 'subscribe', planId: 'plan-pro', period: 'month', now: 1 });
  assert.ok(request);
  const result = await submitMePurchaseOrder(api, request);
  assert.deepEqual(result, { ok: true, orderId: 'sub-10' });
  assert.equal(result.payAmount, undefined);
});

test('404 featureUnavailable surfaces after exactly one call — no retry', async () => {
  for (const section of ['subscribe', 'topup'] as const) {
    const api = fakeApi({
      subscription: { success: false, error: 'endpoint not found', errorCode: 'FEATURE_UNAVAILABLE', featureUnavailable: true },
      topup: { success: false, error: 'endpoint not found', errorCode: 'FEATURE_UNAVAILABLE', featureUnavailable: true },
    });
    const request = buildMePurchaseOrderRequest(
      section === 'subscribe'
        ? { section, planId: 'plan-pro', period: 'month', now: 1 }
        : { section, packageId: 'pkg-9', period: 'month', now: 1 },
    );
    assert.ok(request);
    const result = await submitMePurchaseOrder(api, request);
    assert.deepEqual(result, { ok: false, orderId: '', error: 'endpoint not found', errorCode: 'FEATURE_UNAVAILABLE' });
    assert.equal(api.calls.length, 1, `${section}: a 404 must not be replayed`);
  }
});

test('server payment handoff and proration survive the mobile submit projection', async () => {
  const api = fakeApi({
    subscription: {
      success: true,
      subscriptionOrder: {
        orderId: 'sub-checkout',
        status: 'submitted',
        payAmount: 450,
        listAmountCny: 500,
        creditCny: 50,
        gatewayParams: { approvalUrl: 'https://pay.example/checkout', qrCode: 'pay-now' },
      },
    },
  });
  const request = buildMePurchaseOrderRequest({ section: 'subscribe', planId: 'plan-pro', period: 'year', now: 1 });
  assert.ok(request);
  const result = await submitMePurchaseOrder(api, request);
  assert.equal(result.checkout?.approvalUrl, 'https://pay.example/checkout');
  assert.equal(result.checkout?.qrCode, 'pay-now');
  assert.equal(result.checkout?.listAmountCny, 500);
  assert.equal(result.checkout?.creditAppliedCny, 50);
});

test('gateway choice is part of the subscription idempotency key', () => {
  const alipay = buildMePurchaseOrderRequest({ section: 'subscribe', planId: 'plan-pro', period: 'month', gateway: 'alipay', now: 1 });
  const paypal = buildMePurchaseOrderRequest({ section: 'subscribe', planId: 'plan-pro', period: 'month', gateway: 'paypal', now: 1 });
  assert.ok(alipay && paypal);
  assert.notEqual(alipay.input.idempotencyKey, paypal.input.idempotencyKey);
});

test('the screen routes both branches through the helper and persists checkout recovery', () => {
  assert.match(SCREEN_SOURCE, /buildMePurchaseOrderRequest\(\{/);
  assert.match(SCREEN_SOURCE, /submitMePurchaseOrder\(window\.electron\.mePoints, request\)/);
  assert.match(SCREEN_SOURCE, /saveMeCheckoutRecovery\(\{/);
  assert.match(SCREEN_SOURCE, /fetchMePaymentCheckout\(\{/);
  assert.equal(SCREEN_SOURCE.includes('submitTopupOrder('), false);
  assert.equal(SCREEN_SOURCE.includes('packageId,\n        periodDays'), false);
});
