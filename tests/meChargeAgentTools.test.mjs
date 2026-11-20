import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMeChargeAgentTools } = require('../dist-electron/main/libs/meChargeAgentTools.js');

const OWN = '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx';
const PAYEE = '1LtJF6QZhpPzsfXS3qnYLXyKX5qjgqscFp';
const ITEM_PIN = `${'a'.repeat(64)}i0`;

/** Fake sdk tool() factory: captures the handler by tool name. */
function buildHarness(controlOverrides = {}) {
  const handlers = new Map();
  const tool = (name, description, schema, handler) => {
    handlers.set(name, handler);
    return { name, description, schema };
  };
  const calls = [];
  const defaultFreezeView = (input) => ({
    orderId: input.orderId,
    amountMilli: input.amountMilli,
    payee: input.payee,
    refType: input.refType || 'freeze_order',
    refId: input.refId || '',
    status: 1,
    applied: true,
    expiresAt: Date.now() + 86_400_000,
    splits: { grantMilli: input.amountMilli, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
  });
  const record = (name) => async (input) => {
    calls.push({ name, input });
    if (controlOverrides[name]) return controlOverrides[name](input);
    return name === 'freeze' ? defaultFreezeView(input) : {};
  };
  const control = {
    getMetabotMvcAddress: () => OWN,
    balance: record('balance'),
    freeze: record('freeze'),
    capture: record('capture'),
    release: record('release'),
    pay: record('pay'),
    listFreezes: record('listFreezes'),
    ...(controlOverrides.fetchItemInfo ? { fetchItemInfo: controlOverrides.fetchItemInfo } : {}),
    ...(controlOverrides.listFreezes ? { listFreezes: controlOverrides.listFreezes } : {}),
    ...(controlOverrides.balance ? { balance: controlOverrides.balance } : {}),
  };
  const tools = buildMeChargeAgentTools({
    tool,
    control,
    sessionId: 's-1',
    resolveMetabotId: () => 15,
    // These cases pin the PRE-GATE behaviour (the shape the tool had before
    // the owner-confirmation switch): the switch is off, so no card is raised
    // and every existing assertion must keep holding. The gate itself is
    // covered by tests/meChargeConfirmationGate.test.mjs.
    confirmation: { isRequired: () => false, confirm: async () => true },
  });
  assert.equal(tools.length, 1);
  return { handlers, calls, invoke: handlers.get('me_charge') };
}

function textOf(result) {
  return result.content.map((part) => part.text).join('\n');
}

test('mrc721_purchase without an item pin is refused before any ME is held', async () => {
  const { invoke, calls } = buildHarness();
  const result = await invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE, ref_type: 'mrc721_purchase' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /needs the item pinId/);
  assert.equal(calls.filter((call) => call.name === 'freeze').length, 0);
});

test('mrc721_purchase refuses when the item has already moved away from the payee', async () => {
  const { invoke, calls } = buildHarness({
    fetchItemInfo: async () => ({ pinId: ITEM_PIN, collectionName: 'aming-demo', ownerAddress: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za', itemNumber: '2' }),
  });
  const result = await invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE, ref_type: 'mrc721_purchase', item_pin_id: ITEM_PIN });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /is held by 1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za, not by payee/);
  assert.match(textOf(result), /Nothing was frozen/);
  assert.equal(calls.filter((call) => call.name === 'freeze').length, 0);
});

test('mrc721_purchase with a verified holder freezes and keeps the business ref readable', async () => {
  const { invoke, calls } = buildHarness({
    fetchItemInfo: async () => ({ pinId: ITEM_PIN, collectionName: 'aming-demo', ownerAddress: PAYEE, itemNumber: '2' }),
    freeze: async () => ({
      orderId: 'o-1', amountMilli: 120000, payee: PAYEE, refType: 'mrc721_purchase', refId: 'aming-demo#2',
      status: 1, applied: true, expiresAt: Date.now() + 86_400_000,
      splits: { grantMilli: 120000, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
    }),
  });
  const result = await invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE, ref_type: 'mrc721_purchase', item_pin_id: ITEM_PIN });
  assert.equal(result.isError, undefined);
  const freezeCall = calls.find((call) => call.name === 'freeze');
  assert.deepEqual(freezeCall.input, {
    metabotId: 15,
    orderId: 'o-1',
    amountMilli: 120000,
    payee: PAYEE,
    refType: 'mrc721_purchase',
    refId: 'aming-demo#2',
  });
  assert.match(textOf(result), /Froze 120 ME for payee/);
  assert.match(textOf(result), /Item .* verified on the index against the payee/);
});

test('an unverifiable item is refused unless confirm_unverified is set', async () => {
  const harness = buildHarness({ fetchItemInfo: async () => null });
  const refused = await harness.invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE, ref_type: 'mrc721_purchase', item_pin_id: ITEM_PIN });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /could not verify item/);
  assert.equal(harness.calls.filter((call) => call.name === 'freeze').length, 0);

  const accepted = await harness.invoke({
    action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE, ref_type: 'mrc721_purchase',
    item_pin_id: ITEM_PIN, confirm_unverified: true,
  });
  assert.equal(accepted.isError, undefined, textOf(accepted));
  assert.equal(harness.calls.filter((call) => call.name === 'freeze').length, 1);
});

test('capture refuses on an amount mismatch BEFORE the settlement call', async () => {
  const { invoke, calls } = buildHarness({
    listFreezes: async () => ([{
      orderId: 'o-1', amountMilli: 120000, payee: PAYEE, refType: 'mrc721_purchase', refId: 'aming-demo#2',
      status: 1, applied: true, expiresAt: Date.now() + 1000, splits: { grantMilli: 120000, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
    }]),
  });
  const result = await invoke({ action: 'capture', order_id: 'o-1', expected_amount_me: 100 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /the hold is 120 ME but expected_amount_me is 100 ME/);
  assert.equal(calls.filter((call) => call.name === 'capture').length, 0);
});

test('capture refuses when the hold pays a different address than expected', async () => {
  const { invoke, calls } = buildHarness({
    listFreezes: async () => ([{
      orderId: 'o-1', amountMilli: 120000, payee: PAYEE, refType: 'mrc721_purchase', refId: 'x',
      status: 1, applied: true, expiresAt: 1, splits: { grantMilli: 120000, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
    }]),
  });
  const result = await invoke({ action: 'capture', order_id: 'o-1', expected_payee: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /pays 1LtJF6QZhpPzsfXS3qnYLXyKX5qjgqscFp, not the expected/);
  assert.equal(calls.filter((call) => call.name === 'capture').length, 0);
});

test('capture refuses a blind confirmation when the hold read fails and no expectations were supplied', async () => {
  // Server read failure (listFreezes throws) + no expected_amount_me /
  // expected_payee: the owner would have been shown "amount unknown /
  // payee (unknown)" and asked to approve. Now refused before any gate or
  // settlement.
  const { invoke, calls } = buildHarness({
    listFreezes: async () => { throw new Error('server read failed'); },
  });
  const result = await invoke({ action: 'capture', order_id: 'o-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /UNKNOWN amount/);
  assert.match(textOf(result), /Nothing was charged/);
  assert.equal(calls.filter((call) => call.name === 'capture').length, 0);

  // Amount known but payee unknown is still a blind capture: refused too.
  const half = await invoke({ action: 'capture', order_id: 'o-1', expected_amount_me: 120 });
  assert.equal(half.isError, true);
  assert.match(textOf(half), /UNKNOWN amount/);
  assert.equal(calls.filter((call) => call.name === 'capture').length, 0);
});

test('capture proceeds when the hold read fails but the caller supplies amount and payee', async () => {
  const { invoke, calls } = buildHarness({
    listFreezes: async () => { throw new Error('server read failed'); },
  });
  const result = await invoke({
    action: 'capture', order_id: 'o-1', expected_amount_me: 120, expected_payee: PAYEE,
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.filter((call) => call.name === 'capture').length, 1);
});

test('capture refuses a hold that is no longer frozen (released/expired/captured)', async () => {
  for (const [status, label] of [[3, 'released'], [4, 'expired'], [2, 'captured']]) {
    const { invoke, calls } = buildHarness({
      listFreezes: async () => ([{
        orderId: 'o-1', amountMilli: 120000, payee: PAYEE, refType: 'freeze_order', refId: '',
        status, applied: true, expiresAt: 1, splits: { grantMilli: 0, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
      }]),
    });
    const result = await invoke({ action: 'capture', order_id: 'o-1' });
    assert.equal(result.isError, true, `status ${status}`);
    assert.match(textOf(result), new RegExp(`is ${label}`));
    assert.equal(calls.filter((call) => call.name === 'capture').length, 0);
  }
});

test('capture with a known hold settles and prints the ledger entryId', async () => {
  const { invoke } = buildHarness({
    listFreezes: async () => ([{
      orderId: 'o-1', amountMilli: 120000, payee: PAYEE, refType: 'mrc721_purchase', refId: 'aming-demo#2',
      status: 1, applied: true, expiresAt: Date.now() + 60_000, splits: { grantMilli: 120000, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
    }]),
    capture: async () => ({ entryId: 'entry-1', payer: OWN, payee: PAYEE, amountMilli: 120000, payeeEarnedAfter: 120000, applied: true }),
  });
  const result = await invoke({ action: 'capture', order_id: 'o-1', expected_amount_me: 120, expected_payee: PAYEE });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /entryId entry-1/);
  assert.match(textOf(result), /payee earned pool after credit: 120 ME/);
});

test('status surfaces dangling holds separately from closed ones', async () => {
  const { invoke } = buildHarness({
    balance: async () => ({
      identityAddress: OWN, frozenMilli: 120000, totalAvailableMilli: 1880000, spendableMilli: 1880000,
      weeklyRemainingMilli: 1880000, earnedMilli: 0, topupMilli: 0, bonusMilli: 0,
    }),
    listFreezes: async () => ([
      { orderId: 'open-1', amountMilli: 120000, payee: PAYEE, refType: 'mrc721_purchase', refId: 'a#1', status: 1, applied: true, expiresAt: Date.now() + 3_600_000, splits: { grantMilli: 120000, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 } },
      { orderId: 'done-1', amountMilli: 1000, payee: PAYEE, refType: 'freeze_order', refId: '', status: 3, applied: false, expiresAt: 1, splits: { grantMilli: 0, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 } },
    ]),
  });
  const result = await invoke({ action: 'status' });
  const text = textOf(result);
  assert.match(text, /spendable now: 1880 ME/);
  assert.match(text, /Open freezes \(1\) — each one is a dangling hold/);
  assert.match(text, /orderId open-1: frozen/);
  assert.match(text, /Recent closed freezes \(1\)/);
  assert.match(text, /orderId done-1: released \(idempotent replay/);
});

test('freeze refuses amounts above the ME service daily cap and self-payment', async () => {
  const { invoke, calls } = buildHarness();
  const tooBig = await invoke({ action: 'freeze', order_id: 'o-1', amount_me: 10001, payee: PAYEE });
  assert.equal(tooBig.isError, true);
  assert.match(textOf(tooBig), /caps autonomous bot payments at 10,000 ME/);

  const self = await invoke({ action: 'freeze', order_id: 'o-1', amount_me: 1, payee: OWN });
  assert.equal(self.isError, true);
  assert.match(textOf(self), /payee equals this bot's own address/);

  const noPayee = await invoke({ action: 'freeze', order_id: 'o-1', amount_me: 1 });
  assert.equal(noPayee.isError, true);
  assert.match(textOf(noPayee), /payee.*is required/);

  const noOrder = await invoke({ action: 'freeze', amount_me: 1, payee: PAYEE });
  assert.equal(noOrder.isError, true);
  assert.match(textOf(noOrder), /order_id is required/);

  assert.equal(calls.filter((call) => call.name === 'freeze').length, 0);
});

test('release reports idempotent replays instead of pretending to release again', async () => {
  const { invoke } = buildHarness({
    release: async () => ({
      orderId: 'o-1', amountMilli: 120000, payee: PAYEE, refType: 'freeze_order', refId: '',
      status: 3, applied: false, expiresAt: 1, splits: { grantMilli: 0, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
    }),
  });
  const result = await invoke({ action: 'release', order_id: 'o-1' });
  assert.match(textOf(result), /already released — release is idempotent, nothing changed/);
});

test('service-side failures become readable receipts (INSUFFICIENT_ME)', async () => {
  const { MePointsApiError } = require('../dist-electron/main/services/mePointsService.js');
  const { invoke } = buildHarness({
    freeze: async () => {
      throw new MePointsApiError({ stage: 'freeze', message: 'error', errorCode: 'INSUFFICIENT_ME', neededMilli: 120000, haveMilli: 20000 });
    },
  });
  const result = await invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /me_charge freeze failed: INSUFFICIENT_ME: need 120000 milliME \(120 ME\)/);
});

test('a session without a resolvable MetaBot gets a clear refusal', async () => {
  let handler = null;
  const tool = (name, description, schema, fn) => { handler = fn; return { name }; };
  const tools = buildMeChargeAgentTools({
    tool,
    control: { getMetabotMvcAddress: () => OWN },
    sessionId: 's-missing',
    resolveMetabotId: () => undefined,
  });
  assert.equal(tools.length, 1);
  const result = await handler({ action: 'status' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /could not determine which MetaBot owns this session/);
});

test('pay sends the atomic leg with order_id as the idempotency key', async () => {
  const { invoke, calls } = buildHarness({
    pay: async () => ({ entryId: 'entry-pay', payer: OWN, payee: PAYEE, amountMilli: 30000, payeeEarnedAfter: 30000, applied: true }),
  });
  const result = await invoke({
    action: 'pay', order_id: 'svc-1', amount_me: 30, payee: PAYEE,
    ref_type: 'paid_chat', ref_id: 'msg-9', note: 'paid consultation',
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.find((call) => call.name === 'pay').input, {
    metabotId: 15,
    payee: PAYEE,
    amountMilli: 30000,
    idempotencyKey: 'svc-1',
    refType: 'paid_chat',
    refId: 'msg-9',
    reason: 'paid consultation',
  });
  assert.match(textOf(result), /entryId entry-pay/);
});
