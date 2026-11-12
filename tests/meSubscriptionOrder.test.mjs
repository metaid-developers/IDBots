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
const i18nSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/services/i18n.ts'),
  'utf8',
);

function createOrderBody() {
  const start = flowSource.indexOf('const handleCreateOrder = useCallback(');
  assert.ok(start >= 0, 'MePurchaseFlow must keep a handleCreateOrder callback');
  const end = flowSource.indexOf('}, [section, selectedPlan, selectedTopup, phase, period, amountDue, gateway, isFreeSelected, isUpgradePlan, upgradeConfirmOpen]);', start);
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
  // The service sorts newest-first on createdAt — the stub's wire order is
  // ascending, so mso_2 (later) must come back first.
  assert.deepEqual(orders.map((order) => order.orderId), ['mso_2', 'mso_1']);
  assert.equal(orders[1].amountCny, 132.3);
  assert.equal(orders[0].status, 'created');
});

test('getMeSubscriptionOrders returns newest-first and tolerates time aliases', async () => {
  // The 支付记录 merged list sorts by createdAt — the service enforces the
  // same desc contract and accepts the alternate timestamp keys ABS releases
  // have shipped, so no release can scramble or sink timed rows.
  const fetchImpl = createFetchStub(() => ({
    orders: [
      { orderId: 'old', planId: 'me_standard', period: 'month', status: 'credited', createdAt: 1762500000 }, // seconds
      { orderId: 'new', planId: 'me_pro', period: 'year', status: 'credited', createdAt: '2026-11-09T04:05:40Z' },
      { orderId: 'mid', planId: 'me_standard', period: 'quarter', status: 'credited', createTime: 1762550000000 },
    ],
  }));
  initService(fetchImpl);

  const orders = await getMeSubscriptionOrders();
  assert.deepEqual(orders.map((order) => order.orderId), ['new', 'mid', 'old']);
  assert.equal(orders[0].createdAt, Date.parse('2026-11-09T04:05:40Z'));
  assert.equal(orders[1].createdAt, 1762550000000);
  assert.equal(orders[2].createdAt, 1762500000);
});

test('a 404 list endpoint surfaces as featureUnavailable (usage page degrades silently)', async () => {
  const fetchImpl = createFetchStub(() => ({ __httpStatus: 404, __body: null }));
  initService(fetchImpl);

  await assert.rejects(
    () => getMeSubscriptionOrders(),
    (error) => error instanceof MePointsApiError && error.featureUnavailable === true,
  );
});

test('MePurchaseFlow: downgrades locked, current tier orderable for renewal, paid users never see the free tier', () => {
  // Ladder guard (owner policy 2026-11-11): a LOWER paid tier is locked while
  // a subscription is active — a mid-period downgrade would need a refund
  // path the server does not offer.
  assert.match(flowSource, /const isDowngradePlan = useCallback\(/);
  assert.match(flowSource, /subscribed && isMePlanDowngrade\(activeTierKey, plan\.tier\)/);
  assert.match(flowSource, /i18nService\.t\('mePlanDowngradeBadge'\)/);
  // Current-plan resolution mirrors the plan card (subscription active → its
  // tier; otherwise free).
  assert.match(flowSource, /const isCurrentPlan = useCallback\(\(plan: MePlanInfo\) => \{/);
  assert.match(flowSource, /if \(!subscribed\) return plan\.tier === 'free';/);
  // Free tier is filtered out entirely for paying users (no downgrade path).
  assert.match(flowSource, /return subscribed \? cards\.filter\(\(plan\) => plan\.tier !== 'free'\) : cards;/);
  // Blocking keys off isPlanBlocked (free tier un-subscribed + downgrades);
  // the current PAID tier is deliberately NOT blocked — it is the renewal
  // path and stays orderable.
  assert.match(flowSource, /const isPlanBlocked = useCallback\(\(plan: MePlanInfo\) => \{/);
  assert.match(flowSource, /if \(plan\.tier === 'free'\) return !subscribed;/);
  assert.match(flowSource, /return isDowngradePlan\(plan\);/);
  assert.match(flowSource, /disabled=\{phase === 'creating' \|\| blocked\}/);
  assert.match(flowSource, /i18nService\.t\('meCurrentPlanBadge'\)/);
  // The default/effective selection must skip blocked plans (renewal default:
  // the first orderable paid plan — the subscriber's own tier).
  assert.match(flowSource, /paidPlans\.find\(\(plan\) => !isPlanBlocked\(plan\)\)/);
  // Blocked rows use a "cannot select" style — muted, never the accent
  // selection state; the current row keeps the green badge; a top-tier
  // subscriber with nothing orderable gets an explicit note.
  assert.match(flowSource, /cursor-not-allowed/);
  assert.match(flowSource, /bg-green-500\/10 px-2 py-0\.5/);
  assert.match(flowSource, /mePurchaseTopTierNote/);
  // Success page: celebratory centered layout.
  assert.match(flowSource, /mePurchaseSuccessTitle/);
});

test('MePurchaseFlow: idempotency keys are day-stable (UTC), not per-click', () => {
  // R2.2-stable keys: same-day re-orders of the same subject collapse into
  // ONE server order (the dedup response carries the original order +
  // gatewayParams, so an abandoned checkout resumes) instead of stacking
  // payable duplicates. The old per-click `Date.now()` key made every tap
  // create a fresh payable order.
  const body = createOrderBody();
  assert.match(body, /const dayStamp = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/);
  assert.match(body, /desktop-subscribe-\$\{subjectId\}-\$\{period\}-\$\{gateway\}-\$\{dayStamp\}/);
  assert.match(body, /desktop-topup-\$\{subjectId\}-\$\{dayStamp\}/);
  assert.doesNotMatch(body, /Date\.now\(\)`/);
});

test('MePurchaseFlow: upgrades confirm first, notice reflects shipped proration, zero-amount lands on credited', () => {
  // Owner policy 2026-11-11: the first CTA press on a HIGHER tier opens an
  // inline notice; only the second press creates the order. With ABS R6
  // shipped (2026-11-11) the notice no longer claims "not credited yet" —
  // it defers to the payment step's actual amount, and the paying phase
  // renders the server-reported credit line.
  assert.match(flowSource, /const isUpgradePlan = useCallback\(/);
  assert.match(flowSource, /const \[upgradeConfirmOpen, setUpgradeConfirmOpen\] = useState\(false\);/);
  assert.match(
    flowSource,
    /isUpgradePlan\(selectedPlan\)\s*&& !upgradeConfirmOpen/,
    'first press must only open the confirm, not create the order',
  );
  assert.match(flowSource, /data-testid="me-upgrade-confirm"/);
  assert.match(flowSource, /i18nService\.t\('mePurchaseUpgradeNotice'\)/);
  assert.match(flowSource, /i18nService\.t\('mePurchaseUpgradeConfirm'\)/);
  // The interim "not credited yet" copy must be gone — the server credits now.
  assert.doesNotMatch(flowSource, /暂不折抵/);
  assert.doesNotMatch(flowSource, /not credited yet/);
  // A selection/period/gateway change dismisses a stale confirm…
  assert.match(flowSource, /setUpgradeConfirmOpen\(false\);\s*\}, \[effectivePlanId, period, gateway\]\);/);
  // …and so do panel reopen and back-to-picker.
  assert.match(flowSource, /setCheckout\(null\);\s*\n\s*setOrderError\(''\);\s*\n\s*setErrorCode\(''\);\s*\n\s*setUpgradeConfirmOpen\(false\);/);
  // Server-reported proration renders in the paying phase.
  assert.match(flowSource, /data-testid="me-proration-credit"/);
  assert.match(flowSource, /i18nService\.t\('mePurchaseProrationApplied'\)/);
});

test('MePurchaseFlow: zero-amount upgrade (credit ≥ list) lands on credited, never an error', () => {
  // ABS R6 (shipped 2026-11-11): credit ≥ list credits the order in the
  // same transaction and ships gatewayParams:null — the old "no checkout →
  // unavailable" branch dead-looped those, because the day-stable
  // idempotency key replays the same credited (QR-less) order forever.
  const body = createOrderBody();
  assert.match(body, /if \(!nextCheckout\.approvalUrl && !nextCheckout\.qrCode\) \{/);
  assert.match(body, /mePaymentPhase\(nextCheckout\.status\) === 'credited'/);
  assert.match(body, /void requestMeSubscription\(\);/);
  // The credited page tells the zero-pay story instead of "payment successful".
  assert.match(flowSource, /mePurchaseUpgradeZeroPay/);
  assert.match(flowSource, /checkout\.payAmount === 0 && !checkout\.qrCode && !checkout\.approvalUrl/);
  // Copy exists in BOTH locales (meI18nParity guards the namespace; this pins the key).
  assert.match(i18nSource, /mePurchaseUpgradeZeroPay: '/);
  const zhZero = i18nSource.indexOf("mePurchaseUpgradeZeroPay: '");
  assert.ok(i18nSource.indexOf("mePurchaseUpgradeZeroPay: '", zhZero + 1) > 0, 'en zero-pay key missing');
});

test('MePurchaseFlow reset effect runs only on open/section transitions', () => {
  // The panel reset (period/gateway/phase back to defaults) must be scoped to
  // open/section transitions. Data-derived deps re-ran it on every plan
  // catalog refetch (ensureMeSnapshot has no TTL), flashing a picked
  // 季付/年付 back to 月付 and the gateway back to Alipay mid-panel.
  assert.match(flowSource, /selectionContextRef\.current = \{ isPlanBlocked, planCards, paidPlans \};/);
  assert.match(flowSource, /setPeriod\('month'\);[\s\S]*?\}, \[open, section\]\);/);
  assert.equal(flowSource.includes('}, [open, section, isPlanBlocked, planCards, paidPlans]);'), false);
});
