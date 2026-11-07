// S9-A subscription order — desktop client slice.
//
// The endpoint is not deployed yet (2026-11-05 06:2x all /v1/me/subscription*
// paths answered 404), so these tests pin the CLIENT contract instead of a
// live round-trip:
//
//   1. submitMeSubscriptionOrder signs `me:subscription_order:<tsSeconds>`
//      and POSTs to /v1/me/subscription/order with planId + period + channel,
//      never a client-side price;
//   2. a 404 (endpoint absent) surfaces as MePointsApiError(featureUnavailable)
//      after ONE attempt — it must not be retried into a duplicate order;
//   3. MePurchaseFlow's 订阅 branch calls the new method and the 充值 branch
//      still calls topup_submit (the old code sent a planId to topup_submit,
//      which is why a free user could never open a subscription).
//
// Run: pnpm run compile:electron && node --test tests/meSubscriptionOrder.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  ME_SUBSCRIPTION_ORDER_ACTION,
  ME_SUBSCRIPTION_ORDER_PATH,
  ME_SUBSCRIPTION_ORDERS_PATH,
  MePointsApiError,
  getMeSubscriptionOrder,
  getMeSubscriptionOrders,
  initMePointsService,
  submitMeSubscriptionOrder,
} = require('../dist-electron/main/services/mePointsService.js');

const IDENTITY_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";

function deriveAddress(mnemonic) {
  const network = mvc.Networks.livenet;
  const child = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
  return child.publicKey.toAddress(network).toString();
}

const IDENTITY_ADDRESS = deriveAddress(IDENTITY_MNEMONIC);

function verifyMessage(address, message, signature) {
  try {
    return mvc.Message(message).verify(address, signature);
  } catch {
    return false;
  }
}

function makeIdentityStore() {
  return {
    get: () => ({
      id: 1,
      mnemonic: IDENTITY_MNEMONIC,
      path: WALLET_PATH,
      mvc_address: IDENTITY_ADDRESS,
      name: 'Owner',
    }),
  };
}

/** Unified {code,message,data} envelope, or a bare HTTP failure. */
function createFetchStub(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const result = await responder({ url: String(url), init, index: calls.length - 1 });
    if (result && typeof result === 'object' && typeof result.__httpStatus === 'number') {
      return { ok: false, status: result.__httpStatus, json: async () => result.__body };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, message: 'ok', data: result }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function initService(fetchImpl) {
  initMePointsService({ getUserIdentityStore: () => makeIdentityStore(), fetchImpl });
}

function bodyOf(call) {
  return JSON.parse(call.init.body);
}

function secondsOf(call) {
  const ms = Number(call.init.headers['X-Timestamp']);
  assert.ok(Number.isFinite(ms) && ms > 0, 'X-Timestamp must carry the millisecond clock');
  return ms / 1000;
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

test('endpoint path and signed action are single constants with the pinned values', () => {
  assert.equal(ME_SUBSCRIPTION_ORDER_PATH, '/v1/me/subscription/order');
  assert.equal(ME_SUBSCRIPTION_ORDER_ACTION, 'subscription_order');
});

test('submit signs me:subscription_order:<ts>, posts planId/period/channel/gateway and no price', async () => {
  const gatewayParams = { qrCode: 'https://qr.alipay.com/me-sub-1' };
  const fetchImpl = createFetchStub(() => ({
    orderId: 'me_sub_1',
    planId: 'me_standard',
    period: 'month',
    channel: 'desktop',
    status: 'created',
    amountCny: 49,
    payAmount: 49,
    payCurrency: 'CNY',
    gatewayParams,
    createdAt: 1762300000,
  }));
  initService(fetchImpl);

  const order = await submitMeSubscriptionOrder({
    planId: 'me_standard',
    period: 'month',
    channel: 'desktop',
    gateway: 'alipay',
    idempotencyKey: 'ui-subscribe-me_standard-1',
  });

  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  const url = new URL(call.url);
  assert.ok(url.pathname.endsWith('/v1/me/subscription/order'));
  assert.equal(url.pathname.includes('/topup/'), false);
  assert.equal(call.init.method, 'POST');

  assert.equal(call.init.headers['X-Identity-Address'], IDENTITY_ADDRESS);
  const seconds = secondsOf(call);
  const expectedMessage = `me:subscription_order:${seconds}`;
  assert.ok(verifyMessage(IDENTITY_ADDRESS, expectedMessage, call.init.headers['X-Signature']));

  const body = bodyOf(call);
  assert.equal(body.planId, 'me_standard');
  assert.equal(body.period, 'month');
  assert.equal(body.channel, 'desktop');
  assert.equal(body.gateway, 'alipay');
  assert.equal(body.idempotencyKey, 'ui-subscribe-me_standard-1');
  assert.equal('amountCny' in body, false, 'the server prices the order; the client must not send an amount');
  assert.equal('priceCny' in body, false);

  assert.deepEqual(order, {
    orderId: 'me_sub_1',
    planId: 'me_standard',
    period: 'month',
    channel: 'desktop',
    status: 'created',
    amountCny: 49,
    payAmount: 49,
    payCurrency: 'CNY',
    gatewayParams,
    createdAt: 1762300000,
    rejectReason: undefined,
    raw: {
      orderId: 'me_sub_1',
      planId: 'me_standard',
      period: 'month',
      channel: 'desktop',
      status: 'created',
      amountCny: 49,
      payAmount: 49,
      payCurrency: 'CNY',
      gatewayParams,
      createdAt: 1762300000,
    },
  });
});

test('a 404 (endpoint not deployed) fails once as featureUnavailable — never retried into a duplicate', async () => {
  const fetchImpl = createFetchStub(() => ({
    __httpStatus: 404,
    __body: { code: 40400, message: 'not found' },
  }));
  initService(fetchImpl);

  await assert.rejects(
    () => submitMeSubscriptionOrder({
      planId: 'me_standard',
      period: 'month',
      channel: 'desktop',
      voucherRemark: 'x',
      idempotencyKey: 'ui-subscribe-me_standard-2',
    }),
    (error) => {
      assert.ok(error instanceof MePointsApiError);
      assert.equal(error.stage, 'subscription_order');
      assert.equal(error.status, 404);
      assert.equal(error.featureUnavailable, true);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 1, 'a missing endpoint must not be retried');
});

test('a transient failure is retried once with the SAME idempotency key', async () => {
  const fetchImpl = createFetchStub(({ index }) => {
    if (index === 0) throw new Error('socket hang up');
    return { orderId: 'me_sub_3', planId: 'me_pro', period: 'year', channel: 'desktop', status: 'submitted' };
  });
  initService(fetchImpl);

  const order = await submitMeSubscriptionOrder({
    planId: 'me_pro',
    period: 'year',
    channel: 'desktop',
    voucherRemark: '订阅 me_pro / 年',
    idempotencyKey: 'ui-subscribe-me_pro-3',
  });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(bodyOf(fetchImpl.calls[0]).idempotencyKey, 'ui-subscribe-me_pro-3');
  assert.equal(bodyOf(fetchImpl.calls[1]).idempotencyKey, 'ui-subscribe-me_pro-3');
  assert.equal(order.orderId, 'me_sub_3');
});

test('subscription status polling reuses the signed action and reads the order id path', async () => {
  const fetchImpl = createFetchStub(() => ({
    orderId: 'me_sub_status',
    planId: 'me_pro',
    period: 'month',
    channel: 'desktop',
    status: 'credited',
    gatewayParams: { qrCode: 'https://qr.alipay.com/me-sub-status' },
  }));
  initService(fetchImpl);

  const order = await getMeSubscriptionOrder('me_sub_status');
  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.equal(call.init.method, 'GET');
  assert.ok(new URL(call.url).pathname.endsWith('/v1/me/subscription/order/me_sub_status'));
  const seconds = secondsOf(call);
  assert.ok(verifyMessage(
    IDENTITY_ADDRESS,
    `me:subscription_order:${seconds}`,
    call.init.headers['X-Signature'],
  ));
  assert.equal(order.status, 'credited');
});

// ---------------------------------------------------------------------------
// MePurchaseFlow wiring: automated gateway checkout only, never vouchers.
// ---------------------------------------------------------------------------

const flowSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/components/me/MePurchaseFlow.tsx'),
  'utf8',
);

function createOrderBody() {
  const start = flowSource.indexOf('const handleCreateOrder = useCallback(');
  assert.ok(start >= 0, 'MePurchaseFlow must keep a handleCreateOrder callback');
  const end = flowSource.indexOf('}, [section, selectedPlan, selectedTopup, phase, period, amountDue, gateway]);', start);
  assert.ok(end > start, 'handleCreateOrder dependency list shape changed — update this slice');
  return flowSource.slice(start, end);
}

test('MePurchaseFlow: subscribe creates a desktop order with the selected gateway and opens the returned checkout', () => {
  const body = createOrderBody();
  const subscribeCall = body.indexOf('submitSubscriptionOrder({');
  assert.ok(subscribeCall >= 0);
  const subscribeBlock = body.slice(subscribeCall, body.indexOf('})', subscribeCall));
  assert.match(subscribeBlock, /planId: subjectId/);
  assert.match(subscribeBlock, /period/);
  assert.match(subscribeBlock, /channel: 'desktop'/);
  assert.match(subscribeBlock, /gateway,/);
  assert.match(body, /window\.electron\.shell\.openExternal\(nextCheckout\.approvalUrl\)/);
  // Gateway is user-selectable in the panel, defaulting to Alipay.
  assert.match(flowSource, /useState<'alipay' \| 'paypal'>\('alipay'\)/);
  assert.match(flowSource, /mePurchaseGatewayAlipay/);
  assert.match(flowSource, /mePurchaseGatewayPaypal/);
});

test('MePurchaseFlow: topup uses its package endpoint and the desktop flow has no voucher path', () => {
  const body = createOrderBody();
  const topupCall = body.indexOf('submitTopupOrder({');
  assert.ok(topupCall >= 0);
  const topupBlock = body.slice(topupCall, body.indexOf('})', topupCall));
  assert.match(topupBlock, /packageId: subjectId/);
  assert.match(topupBlock, /gateway: 'alipay'/);
  assert.doesNotMatch(topupBlock, /planId/);
  assert.doesNotMatch(flowSource, /pickVoucher|voucherUrl|voucherRemark|DocumentArrowUpIcon|buildAlipayVariantCUrl/);
});

// ---------------------------------------------------------------------------
// Amendment v0.3 — subscription order list (用量&积分 payment records)
// ---------------------------------------------------------------------------

test('list endpoint constant pins /v1/me/subscription/orders on the checkout action', () => {
  assert.equal(ME_SUBSCRIPTION_ORDERS_PATH, '/v1/me/subscription/orders');
  assert.notEqual(ME_SUBSCRIPTION_ORDERS_PATH, ME_SUBSCRIPTION_ORDER_PATH);
});

test('getMeSubscriptionOrders signs the checkout action and parses the orders array', async () => {
  const fetchImpl = createFetchStub(() => ({
    orders: [
      { orderId: 'mso_1', planId: 'me_standard', period: 'quarter', status: 'credited', amountCny: 132.3, createdAt: 1762500000000 },
      { orderId: 'mso_2', planId: 'me_pro', period: 'year', status: 'created', amountCny: 1430.4, createdAt: 1762600000000 },
    ],
  }));
  initService(fetchImpl);

  const orders = await getMeSubscriptionOrders();

  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  const url = new URL(call.url);
  assert.ok(url.pathname.endsWith('/v1/me/subscription/orders'));
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers['X-Identity-Address'], IDENTITY_ADDRESS);
  assert.ok(verifyMessage(IDENTITY_ADDRESS, `me:subscription_order:${secondsOf(call)}`, call.init.headers['X-Signature']));
  assert.deepEqual(orders.map((order) => order.orderId), ['mso_1', 'mso_2']);
  assert.equal(orders[0].amountCny, 132.3);
  assert.equal(orders[1].status, 'created');
});

test('a 404 list endpoint surfaces as featureUnavailable (usage page degrades silently)', async () => {
  const fetchImpl = createFetchStub(() => ({ __httpStatus: 404, __body: null }));
  initService(fetchImpl);

  await assert.rejects(
    () => getMeSubscriptionOrders(),
    (error) => error instanceof MePointsApiError && error.featureUnavailable === true,
  );
});

test('MePurchaseFlow: current plan is highlighted but unselectable; paid users never see the free tier', () => {
  // Current-plan resolution mirrors the plan card (subscription active → its
  // tier; otherwise free).
  assert.match(flowSource, /const isCurrentPlan = useCallback\(\(plan: MePlanInfo\) => \{/);
  assert.match(flowSource, /if \(!subscribed\) return plan\.tier === 'free';/);
  // Free tier is filtered out entirely for paying users (no downgrade path).
  assert.match(flowSource, /return subscribed \? cards\.filter\(\(plan\) => plan\.tier !== 'free'\) : cards;/);
  // The current row renders disabled with the 当前套餐 badge instead of the
  // popular badge, and keeps the selected styling.
  assert.match(flowSource, /disabled=\{phase === 'creating' \|\| currentPlan\}/);
  assert.match(flowSource, /i18nService\.t\('meCurrentPlanBadge'\)/);
  // The default/effective selection must skip the current plan.
  assert.match(flowSource, /paidPlans\.find\(\(plan\) => !isCurrentPlan\(plan\)\)\?\.planId/);
  // Success page: celebratory centered layout.
  assert.match(flowSource, /mePurchaseSuccessTitle/);
});
