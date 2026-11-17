import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');
const {
  describeMeChargeError,
  meCapture,
  meFreeze,
  mePay,
  meRelease,
  listMeFreezes,
  getMeChargeBalance,
  normalizeOrderId,
  assertMvcPayee,
  ME_FREEZE_STATUS,
} = require('../dist-electron/main/services/meChargeService.js');
const { initMePointsService } = require('../dist-electron/main/services/mePointsService.js');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const network = mvc.Networks.livenet;
const child = mvc.Mnemonic.fromString(MNEMONIC).toHDPrivateKey('', network).deriveChild(WALLET_PATH);
const PAYER = child.publicKey.toAddress(network).toString();
const PAYEE = '1LtJF6QZhpPzsfXS3qnYLXyKX5qjgqscFp';

const SIGNER = { mnemonic: MNEMONIC, path: WALLET_PATH };

/**
 * Route-aware fetch stub: each probe gets `{status, body}`; every request is
 * recorded so the tests can assert (a) how many calls happened, (b) that the
 * signature verifies against the identity header, and (c) which path/body was
 * actually sent.
 */
function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    // The service builds <base>/v1/me/... where base carries /assist-open-api.
    const pathname = parsed.pathname.replace(/^\/assist-open-api/, '');
    const key = `${init.method || 'GET'} ${pathname}`;
    calls.push({
      key,
      pathname,
      search: parsed.search,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    const payload = typeof route === 'function' ? route(calls[calls.length - 1]) : route;
    return {
      ok: payload.status === undefined || payload.status < 400,
      status: payload.status ?? 200,
      json: async () => payload.body,
    };
  };
  initMePointsService({ fetchImpl });
  return { calls, fetchImpl };
}

function ok(data) {
  return { body: { code: 0, message: 'success', data } };
}

function fail(errorCode, extra = {}) {
  return { body: { code: 1, message: 'error', data: { errorCode, ...extra } } };
}

function verifySigned(call, action) {
  assert.equal(call.headers['X-Identity-Address'], PAYER, 'identity header must be the derived payer address');
  const timestamp = Number(call.headers['X-Timestamp']);
  assert.ok(Number.isFinite(timestamp) && timestamp > 0, 'X-Timestamp must be ms epoch');
  const message = `me:${action}:${timestamp / 1000}`;
  assert.equal(
    mvc.Message(message).verify(PAYER, call.headers['X-Signature']),
    true,
    `signature must verify for action ${action}`,
  );
}

// ---------------------------------------------------------------------------
// Guardrails (refuse BEFORE spending a request)
// ---------------------------------------------------------------------------

test('freeze refuses a missing payee without calling the server', async () => {
  const { calls } = stubFetch({});
  await assert.rejects(
    () => meFreeze({ signer: SIGNER, orderId: 'o-1', amountMilli: 1000, payee: '' }),
    /payee is required/,
  );
  assert.equal(calls.length, 0);
});

test('freeze refuses a non-MVC payee string (the server accepts it, measured 2026-11-17)', async () => {
  const { calls } = stubFetch({});
  await assert.rejects(
    () => meFreeze({ signer: SIGNER, orderId: 'o-1', amountMilli: 1000, payee: 'not-an-address' }),
    /not an MVC address/,
  );
  assert.equal(calls.length, 0);
});

test('freeze refuses paying yourself', async () => {
  const { calls } = stubFetch({});
  await assert.rejects(
    () => meFreeze({ signer: SIGNER, orderId: 'o-1', amountMilli: 1000, payee: PAYER }),
    /payee equals the paying identity/,
  );
  assert.equal(calls.length, 0);
});

test('freeze refuses non-positive / sub-milliME amounts', async () => {
  const { calls } = stubFetch({});
  for (const amountMilli of [0, -5, 1.5, Number.NaN]) {
    await assert.rejects(
      () => meFreeze({ signer: SIGNER, orderId: 'o-1', amountMilli, payee: PAYEE }),
      /positive integer of milliME/,
    );
  }
  assert.equal(calls.length, 0);
});

test('order id charset is mirrored from the server regex (dash is escaped, not a range)', () => {
  for (const good of ['s4-demo-buy-02-20261117', 'a.b:c_d-e', 'X1']) {
    assert.equal(normalizeOrderId(good), good);
  }
  for (const bad of ['', 'has space', 'sla/sh', 'x'.repeat(81)]) {
    assert.throws(() => normalizeOrderId(bad));
  }
});

test('assertMvcPayee rejects malformed addresses and accepts a real one', () => {
  assert.equal(assertMvcPayee(PAYEE, PAYER), PAYEE);
  assert.throws(() => assertMvcPayee('1LtJF6QZhpPzsfXS3qnYLXyKX5qjgqscF0', PAYER), /not an MVC address/); // contains 0
  assert.throws(() => assertMvcPayee(PAYER, PAYER), /payee equals/);
});

// ---------------------------------------------------------------------------
// freeze / capture / release / pay happy paths + idempotency
// ---------------------------------------------------------------------------

test('freeze signs with the payer key and normalizes the freeze row', async () => {
  const { calls } = stubFetch({
    'POST /v1/me/freeze': ok({
      orderId: 'order-abc',
      amountMilli: 120000,
      grantMilli: 120000,
      bonusMilli: 0,
      topupMilli: 0,
      earnedMilli: 0,
      expiresAt: Date.now() + 86400_000,
      status: ME_FREEZE_STATUS.frozen,
      applied: true,
    }),
  });
  const view = await meFreeze({
    signer: SIGNER,
    orderId: 'order-abc',
    amountMilli: 120000,
    payee: PAYEE,
    refType: 'mrc721_purchase',
    refId: 'album#1',
  });
  assert.equal(calls.length, 1);
  verifySigned(calls[0], 'freeze');
  assert.deepEqual(calls[0].body, {
    orderId: 'order-abc',
    amountMilli: 120000,
    payee: PAYEE,
    refType: 'mrc721_purchase',
    refId: 'album#1',
  });
  assert.equal(view.status, ME_FREEZE_STATUS.frozen);
  assert.equal(view.applied, true);
  assert.equal(view.splits.grantMilli, 120000);
});

test('freeze replay reports applied=false instead of a second hold', async () => {
  stubFetch({
    'POST /v1/me/freeze': ok({
      orderId: 'order-abc',
      amountMilli: 120000,
      expiresAt: 1,
      status: ME_FREEZE_STATUS.frozen,
      applied: false,
    }),
  });
  const view = await meFreeze({ signer: SIGNER, orderId: 'order-abc', amountMilli: 120000, payee: PAYEE });
  assert.equal(view.applied, false);
});

test('insufficient balance surfaces needed/have from the house envelope and freezes nothing else', async () => {
  stubFetch({
    'POST /v1/me/freeze': fail('INSUFFICIENT_ME', { neededMilli: 120000, haveMilli: 20000 }),
  });
  await assert.rejects(
    () => meFreeze({ signer: SIGNER, orderId: 'order-broke', amountMilli: 120000, payee: PAYEE }),
    (error) => {
      assert.equal(error.errorCode, 'INSUFFICIENT_ME');
      assert.equal(error.neededMilli, 120000);
      assert.equal(error.haveMilli, 20000);
      const readable = describeMeChargeError(error);
      assert.match(readable, /need 120000 milliME \(120 ME\), available 20000 milliME \(20 ME\)/);
      assert.match(readable, /Nothing was frozen/);
      return true;
    },
  );
});

test('insufficient balance reports the auto-deduct gate when the server names it', async () => {
  stubFetch({
    'POST /v1/me/freeze': fail('INSUFFICIENT_ME', { neededMilli: 5000, haveMilli: 0, autoDeductDisabled: true }),
  });
  await assert.rejects(
    () => meFreeze({ signer: SIGNER, orderId: 'order-gated', amountMilli: 5000, payee: PAYEE }),
    (error) => {
      assert.equal(error.autoDeductDisabled, true);
      assert.match(describeMeChargeError(error), /autoDeductFromPersistent=OFF/);
      return true;
    },
  );
});

test('capture signs action capture and reports entryId + payee earned balance', async () => {
  const { calls } = stubFetch({
    'POST /v1/me/capture': ok({
      entryId: 'entry-1',
      payer: PAYER,
      payee: PAYEE,
      amountMilli: 120000,
      payeeEarnedAfter: 120000,
      applied: true,
    }),
  });
  const view = await meCapture({ signer: SIGNER, orderId: 'order-abc' });
  verifySigned(calls[0], 'capture');
  assert.deepEqual(calls[0].body, { orderId: 'order-abc' });
  assert.equal(view.entryId, 'entry-1');
  assert.equal(view.payeeEarnedAfter, 120000);
});

test('capture replay (server returns the original entry, applied=false) is not a second charge', async () => {
  stubFetch({
    'POST /v1/me/capture': ok({ entryId: 'entry-1', amountMilli: 120000, applied: false }),
  });
  const view = await meCapture({ signer: SIGNER, orderId: 'order-abc' });
  assert.equal(view.entryId, 'entry-1');
  assert.equal(view.applied, false);
});

test('capture after release surfaces STATE_CONFLICT with a no-charge explanation', async () => {
  stubFetch({ 'POST /v1/me/capture': fail('STATE_CONFLICT') });
  await assert.rejects(
    () => meCapture({ signer: SIGNER, orderId: 'order-released' }),
    (error) => {
      assert.equal(error.errorCode, 'STATE_CONFLICT');
      assert.match(describeMeChargeError(error), /no longer frozen/);
      return true;
    },
  );
});

test('capture of an unknown order maps INTERNAL_ERROR to "do not retry" (deployed quirk)', async () => {
  stubFetch({ 'POST /v1/me/capture': fail('INTERNAL_ERROR') });
  await assert.rejects(
    () => meCapture({ signer: SIGNER, orderId: 'order-missing' }),
    (error) => {
      assert.match(describeMeChargeError(error), /Do not retry/);
      return true;
    },
  );
});

test('release is idempotent and reports the terminal status', async () => {
  stubFetch({
    'POST /v1/me/release': ok({
      orderId: 'order-abc',
      amountMilli: 120000,
      status: ME_FREEZE_STATUS.released,
      applied: false,
    }),
  });
  const view = await meRelease({ signer: SIGNER, orderId: 'order-abc' });
  assert.equal(view.status, ME_FREEZE_STATUS.released);
  assert.equal(view.applied, false);
});

test('pay requires an idempotency key and refuses a self-payment', async () => {
  const { calls } = stubFetch({});
  await assert.rejects(
    () => mePay({ signer: SIGNER, payee: PAYEE, amountMilli: 1000, idempotencyKey: '' }),
    /idempotencyKey is required/,
  );
  await assert.rejects(
    () => mePay({ signer: SIGNER, payee: PAYER, amountMilli: 1000, idempotencyKey: 'k1' }),
    /payee equals/,
  );
  assert.equal(calls.length, 0);
});

test('pay sends the atomic charge and signs action pay', async () => {
  const { calls } = stubFetch({
    'POST /v1/me/pay': ok({ entryId: 'entry-pay', payer: PAYER, payee: PAYEE, amountMilli: 30000, payeeEarnedAfter: 30000 }),
  });
  const view = await mePay({
    signer: SIGNER,
    payee: PAYEE,
    amountMilli: 30000,
    idempotencyKey: 'svc-1',
    refType: 'paid_chat',
    refId: 'msg-9',
    reason: 'paid consultation',
  });
  verifySigned(calls[0], 'pay');
  assert.deepEqual(calls[0].body, {
    payee: PAYEE,
    amountMilli: 30000,
    idempotencyKey: 'svc-1',
    refType: 'paid_chat',
    refId: 'msg-9',
    reason: 'paid consultation',
  });
  assert.equal(view.entryId, 'entry-pay');
});

// ---------------------------------------------------------------------------
// Reads: balance + freezes (the "is anything dangling?" surface)
// ---------------------------------------------------------------------------

test('balance read normalizes the double-pool snapshot', async () => {
  const { calls } = stubFetch({
    'GET /v1/me/balance': ok({
      identityAddress: PAYER,
      weeklyGrant: { amountMilli: 2000000, remainingMilli: 1880000 },
      persistent: { topupMilli: 0, earnedMilli: 500, bonusMilli: 0 },
      frozenMilli: 0,
      totalAvailable: 1880500,
      spendableMilli: 1880500,
    }),
  });
  const view = await getMeChargeBalance({ signer: SIGNER });
  verifySigned(calls[0], 'balance');
  assert.equal(view.weeklyRemainingMilli, 1880000);
  assert.equal(view.earnedMilli, 500);
  assert.equal(view.frozenMilli, 0);
  assert.equal(view.spendableMilli, 1880500);
});

test('listMeFreezes accepts both a bare array and a {rows} envelope', async () => {
  const row = {
    orderId: 'order-1',
    amountMilli: 120000,
    payeeAddress: PAYEE,
    refType: 'mrc721_purchase',
    refId: 'album#1',
    status: 1,
    expiresAt: 2,
  };
  stubFetch({ 'GET /v1/me/freezes': ok([row]) });
  const fromArray = await listMeFreezes({ signer: SIGNER });
  assert.equal(fromArray.length, 1);
  assert.equal(fromArray[0].payee, PAYEE);

  stubFetch({ 'GET /v1/me/freezes': ok({ rows: [row] }) });
  const fromRows = await listMeFreezes({ signer: SIGNER });
  assert.equal(fromRows.length, 1);
  assert.equal(fromRows[0].refType, 'mrc721_purchase');
});
