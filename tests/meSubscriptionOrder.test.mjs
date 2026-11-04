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
  MePointsApiError,
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

test('submit signs me:subscription_order:<ts>, posts planId/period/channel and no price', async () => {
  const fetchImpl = createFetchStub(() => ({
    orderId: 'me_sub_1',
    planId: 'me_standard',
    period: 'month',
    channel: 'desktop',
    status: 'submitted',
    amountCny: 49,
    createdAt: 1762300000,
  }));
  initService(fetchImpl);

  const order = await submitMeSubscriptionOrder({
    planId: 'me_standard',
    period: 'month',
    channel: 'desktop',
    voucherRemark: '订阅 me_standard / 月',
    idempotencyKey: 'ui-subscribe-me_standard-1',
  });

  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  const url = new URL(call.url);
  // The default base URL owns a path prefix (/assist-open-api); the endpoint
  // path itself is the constant pinned above.
  assert.ok(
    url.pathname.endsWith('/v1/me/subscription/order'),
    `must hit /v1/me/subscription/order, got ${url.pathname}`,
  );
  assert.equal(url.pathname.includes('/topup/'), false, 'the subscription order must not go through topup');
  assert.equal(call.init.method, 'POST');

  assert.equal(call.init.headers['X-Identity-Address'], IDENTITY_ADDRESS);
  const seconds = secondsOf(call);
  const expectedMessage = `me:subscription_order:${seconds}`;
  assert.match(expectedMessage, /^me:subscription_order:\d+$/);
  assert.ok(
    verifyMessage(IDENTITY_ADDRESS, expectedMessage, call.init.headers['X-Signature']),
    'X-Signature must verify against me:subscription_order:<tsSeconds>',
  );

  const body = bodyOf(call);
  assert.equal(body.planId, 'me_standard');
  assert.equal(body.period, 'month');
  assert.equal(body.channel, 'desktop');
  assert.equal(body.voucherRemark, '订阅 me_standard / 月');
  assert.equal(body.idempotencyKey, 'ui-subscribe-me_standard-1');
  assert.equal('amountCny' in body, false, 'the server prices the order; the client must not send an amount');
  assert.equal('priceCny' in body, false);

  assert.deepEqual(order, {
    orderId: 'me_sub_1',
    planId: 'me_standard',
    period: 'month',
    channel: 'desktop',
    status: 'submitted',
    amountCny: 49,
    createdAt: 1762300000,
    rejectReason: undefined,
    raw: {
      orderId: 'me_sub_1',
      planId: 'me_standard',
      period: 'month',
      channel: 'desktop',
      status: 'submitted',
      amountCny: 49,
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

// ---------------------------------------------------------------------------
// MePurchaseFlow wiring (renderer has no DOM test harness in this repo, so the
// branch shape is asserted against the source — the submit() body is sliced
// out so unrelated code cannot satisfy the matches).
// ---------------------------------------------------------------------------

const flowSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/components/me/MePurchaseFlow.tsx'),
  'utf8',
);

function submitBody() {
  const start = flowSource.indexOf('const submit = useCallback(');
  assert.ok(start >= 0, 'MePurchaseFlow must keep a submit() callback');
  const end = flowSource.indexOf('}, [section, selectedPlan, selectedTopup, period,', start);
  assert.ok(end > start, 'submit() dependency list shape changed — update this slice');
  return flowSource.slice(start, end);
}

test('MePurchaseFlow: the 订阅 branch posts to the subscription endpoint with channel desktop', () => {
  const body = submitBody();
  const subscribeCall = body.indexOf('submitSubscriptionOrder({');
  assert.ok(subscribeCall >= 0, '订阅 must call mePoints.submitSubscriptionOrder');
  const subscribeBlock = body.slice(subscribeCall, body.indexOf('})', subscribeCall));
  assert.match(subscribeBlock, /planId/);
  assert.match(subscribeBlock, /period/);
  assert.match(subscribeBlock, /channel: 'desktop'/);
});

test('MePurchaseFlow: the 充值 branch still calls topup_submit and never receives a planId', () => {
  const body = submitBody();
  const topupCall = body.indexOf('submitTopupOrder({');
  assert.ok(topupCall >= 0, '充值 must keep calling mePoints.submitTopupOrder');
  const topupBlock = body.slice(topupCall);
  assert.match(topupBlock, /packageId/);
  assert.doesNotMatch(topupBlock, /planId/, 'a planId must never be submitted as a topup package');
  assert.match(
    body,
    /section === 'subscribe' \? selectedPlan\?\.planId : undefined/,
    'planId must be resolved only for the subscribe branch',
  );
  assert.doesNotMatch(body, /periodDays/, 'the subscription endpoint derives periodDays from period');
});
