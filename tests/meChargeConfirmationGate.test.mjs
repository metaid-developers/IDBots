import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMeChargeAgentTools } = require('../dist-electron/main/libs/meChargeAgentTools.js');
const {
  ME_CHARGE_REQUIRE_CONFIRMATION_SETTING_KEY,
  isMeChargeConfirmationRequired,
} = require('../dist-electron/main/services/meChargeService.js');

const OWN = '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx';
const PAYEE = '1LtJF6QZhpPzsfXS3qnYLXyKX5qjgqscFp';
const OTHER = '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za';

const FROZEN_HOLD = {
  orderId: 'o-1',
  amountMilli: 120000,
  payee: PAYEE,
  refType: 'mrc721_purchase',
  refId: 'aming-demo#2',
  status: 1,
  applied: true,
  expiresAt: Date.now() + 3_600_000,
  splits: { grantMilli: 120000, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
};

/**
 * Harness for the owner-confirmation gate.
 *
 * `confirmation` is passed through verbatim: omit it entirely to exercise the
 * fail-closed default (no confirmation channel wired in — the unattended /
 * background shape). `sequence` records the exact order of the confirmation
 * callback and the money-moving control calls, so "confirmed BEFORE charged"
 * is assertable.
 */
function buildHarness({
  required = true,
  approve = true,
  confirmation,
  controlOverrides = {},
} = {}) {
  const handlers = new Map();
  const tool = (name, description, schema, handler) => {
    handlers.set(name, handler);
    return { name, description, schema };
  };
  const sequence = [];
  const confirmations = [];
  const calls = [];
  const record = (name) => async (input) => {
    sequence.push(name);
    calls.push({ name, input });
    if (controlOverrides[name]) return controlOverrides[name](input);
    switch (name) {
      case 'freeze':
        return {
          orderId: input.orderId,
          amountMilli: input.amountMilli,
          payee: input.payee,
          refType: input.refType || 'freeze_order',
          refId: input.refId || '',
          status: 1,
          applied: true,
          expiresAt: Date.now() + 86_400_000,
          splits: { grantMilli: input.amountMilli, bonusMilli: 0, topupMilli: 0, earnedMilli: 0 },
        };
      case 'capture':
      case 'pay':
        return {
          entryId: 'entry-1',
          payer: OWN,
          payee: input.payee || PAYEE,
          amountMilli: 120000,
          payeeEarnedAfter: 120000,
          applied: true,
        };
      case 'release':
        return { ...FROZEN_HOLD, status: 3, applied: true };
      case 'listFreezes':
        return [];
      case 'balance':
        return {
          identityAddress: OWN,
          frozenMilli: 0,
          totalAvailableMilli: 5000000,
          spendableMilli: 5000000,
          weeklyRemainingMilli: 5000000,
          earnedMilli: 0,
          topupMilli: 0,
          bonusMilli: 0,
        };
      default:
        return {};
    }
  };
  const confirmImpl = confirmation?.confirm
    ?? (async (info) => {
      confirmations.push(info);
      sequence.push('confirm');
      return approve;
    });
  const confirmationDeps = confirmation === 'none'
    ? undefined
    : {
      isRequired: confirmation?.isRequired ?? (() => required),
      confirm: confirmImpl,
    };
  const tools = buildMeChargeAgentTools({
    tool,
    control: {
      getMetabotMvcAddress: () => OWN,
      requireConfirmation: confirmation?.requireConfirmation ?? (() => required),
      balance: record('balance'),
      freeze: record('freeze'),
      capture: record('capture'),
      release: record('release'),
      pay: record('pay'),
      listFreezes: record('listFreezes'),
      ...controlOverrides.control,
    },
    sessionId: 's-gate',
    resolveMetabotId: () => 15,
    ...(confirmationDeps ? { confirmation: confirmationDeps } : {}),
  });
  assert.equal(tools.length, 1);
  return {
    invoke: handlers.get('me_charge'),
    calls,
    confirmations,
    sequence,
    moneyCalls: (name) => calls.filter((call) => call.name === name).length,
  };
}

function textOf(result) {
  return result.content.map((part) => part.text).join('\n');
}

// 1) No confirmation → refusal AND no ledger movement (no freeze, no hold).
test('an unconfirmed freeze is refused and no ME is frozen', async () => {
  const harness = buildHarness({ required: true, approve: false });
  const result = await harness.invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE });

  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /freeze NOT executed — owner confirmation was not granted/);
  assert.match(text, /Pending confirmation item: me_charge\/freeze\/o-1/);
  assert.match(text, /No ME was frozen/);
  assert.match(text, /60s card, unanswered = refused/);
  assert.equal(harness.moneyCalls('freeze'), 0);
  assert.equal(harness.confirmations.length, 1);
  assert.equal(harness.confirmations[0].action, 'freeze');
  assert.equal(harness.confirmations[0].amountMilli, 120000);
  assert.equal(harness.confirmations[0].payee, PAYEE);
  assert.equal(harness.confirmations[0].orderId, 'o-1');
});

test('unconfirmed capture and pay are refused before the settlement call', async () => {
  const harness = buildHarness({
    required: true,
    approve: false,
    controlOverrides: { listFreezes: async () => [FROZEN_HOLD] },
  });

  const capture = await harness.invoke({ action: 'capture', order_id: 'o-1' });
  assert.equal(capture.isError, true);
  assert.match(textOf(capture), /capture NOT executed — owner confirmation was not granted/);
  assert.match(textOf(capture), /Pending confirmation item: me_charge\/capture\/o-1/);
  assert.match(textOf(capture), /still frozen/);
  assert.equal(harness.moneyCalls('capture'), 0);

  const pay = await harness.invoke({ action: 'pay', order_id: 'svc-1', amount_me: 30, payee: PAYEE });
  assert.equal(pay.isError, true);
  assert.match(textOf(pay), /pay NOT executed — owner confirmation was not granted/);
  assert.match(textOf(pay), /Pending confirmation item: me_charge\/pay\/svc-1/);
  assert.match(textOf(pay), /nothing moved/);
  assert.equal(harness.moneyCalls('pay'), 0);
});

// 2) Approval → the charge goes through, with the exact amount/payee on the card.
test('an approved confirmation lets the freeze through and the card carried the exact charge', async () => {
  const harness = buildHarness({ required: true, approve: true });
  const result = await harness.invoke({
    action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE,
    ref_type: 'service', ref_id: 'art-7',
  });

  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /Froze 120 ME for payee/);
  assert.equal(harness.moneyCalls('freeze'), 1);
  assert.deepEqual(harness.confirmations[0], {
    action: 'freeze',
    metabotId: 15,
    orderId: 'o-1',
    amountMilli: 120000,
    payee: PAYEE,
    refType: 'service',
    refId: 'art-7',
  });
  assert.deepEqual(harness.sequence, ['confirm', 'freeze', 'listFreezes']);
});

test('an approved capture carries the hold facts on the card and settles unchanged', async () => {
  const harness = buildHarness({
    required: true,
    approve: true,
    controlOverrides: { listFreezes: async () => [FROZEN_HOLD] },
  });
  const result = await harness.invoke({
    action: 'capture', order_id: 'o-1', expected_amount_me: 120, expected_payee: PAYEE,
  });

  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /entryId entry-1/);
  assert.deepEqual(harness.confirmations[0], {
    action: 'capture',
    metabotId: 15,
    orderId: 'o-1',
    amountMilli: 120000,
    payee: PAYEE,
    refType: 'mrc721_purchase',
    refId: 'aming-demo#2',
    holdStatus: 1,
  });
  assert.deepEqual(harness.calls.find((call) => call.name === 'capture').input, {
    metabotId: 15,
    orderId: 'o-1',
  });
  assert.deepEqual(harness.sequence, ['listFreezes', 'confirm', 'capture']);
});

// 3) Switch off → pre-gate behaviour exactly: no card, same control calls.
test('with the switch off the charge skips confirmation and keeps the old flow', async () => {
  let confirmCalls = 0;
  const harness = buildHarness({
    required: false,
    confirmation: {
      isRequired: () => false,
      confirm: async () => {
        confirmCalls += 1;
        throw new Error('the confirmation callback must not run when the switch is off');
      },
    },
  });

  const freeze = await harness.invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE });
  assert.equal(freeze.isError, undefined, textOf(freeze));
  assert.equal(harness.moneyCalls('freeze'), 1);

  const pay = await harness.invoke({ action: 'pay', order_id: 'svc-1', amount_me: 30, payee: PAYEE });
  assert.equal(pay.isError, undefined, textOf(pay));
  assert.equal(harness.moneyCalls('pay'), 1);

  assert.equal(confirmCalls, 0);
});

// 4) A throw inside the confirmation channel is a refusal, never a charge.
test('a confirmation-channel error is a refusal, not a charge', async () => {
  const harness = buildHarness({
    required: true,
    confirmation: {
      isRequired: () => true,
      confirm: async () => {
        throw new Error('approval bridge offline');
      },
    },
  });
  const result = await harness.invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /approval bridge offline/);
  assert.match(textOf(result), /No ME was frozen/);
  assert.equal(harness.moneyCalls('freeze'), 0);
});

// 5) No confirmation wiring at all (unattended/background shape) → fail-closed.
test('a session with no confirmation channel is fail-closed', async () => {
  const harness = buildHarness({ confirmation: 'none' });
  const result = await harness.invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /no owner-confirmation channel wired in/);
  assert.equal(harness.moneyCalls('freeze'), 0);
});

test('a throwing switch reads as ON (a settings fault never un-gates spending)', async () => {
  const harness = buildHarness({
    confirmation: {
      isRequired: () => {
        throw new Error('settings store unavailable');
      },
      confirm: async () => false,
    },
  });
  const result = await harness.invoke({ action: 'freeze', order_id: 'o-1', amount_me: 120, payee: PAYEE });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /owner confirmation was not granted/);
  assert.equal(harness.moneyCalls('freeze'), 0);
});

// 6) The gate does not over-reach: reading and releasing stay available.
test('status and release are not gated (a refund must not wait for the owner)', async () => {
  const harness = buildHarness({
    required: true,
    approve: false,
    controlOverrides: { listFreezes: async () => [FROZEN_HOLD] },
  });

  const status = await harness.invoke({ action: 'status' });
  assert.equal(status.isError, undefined, textOf(status));
  assert.match(textOf(status), /Open freezes \(1\)/);

  const release = await harness.invoke({ action: 'release', order_id: 'o-1' });
  assert.equal(release.isError, undefined, textOf(release));
  assert.equal(harness.moneyCalls('release'), 1);
  assert.equal(harness.confirmations.length, 0);
});

// 7) The setting itself: default ON, explicit false only when stored false.
test('the confirmation setting defaults ON and only an explicit false turns it off', () => {
  assert.equal(ME_CHARGE_REQUIRE_CONFIRMATION_SETTING_KEY, 'me_charge_require_confirmation');
  assert.equal(isMeChargeConfirmationRequired(undefined), true);
  assert.equal(isMeChargeConfirmationRequired(null), true);
  assert.equal(isMeChargeConfirmationRequired({ get: () => undefined }), true);
  assert.equal(isMeChargeConfirmationRequired({ get: () => true }), true);
  assert.equal(isMeChargeConfirmationRequired({ get: () => '1' }), true);
  assert.equal(isMeChargeConfirmationRequired({ get: () => false }), false);
  assert.equal(isMeChargeConfirmationRequired({ get: () => { throw new Error('boom'); } }), true);
});

// 8) Sanity: an unrelated payee address still reaches the card unchanged.
test('the card names the actual payee, not a default', async () => {
  const harness = buildHarness({ required: true, approve: true });
  await harness.invoke({ action: 'pay', order_id: 'svc-2', amount_me: 5, payee: OTHER });
  assert.equal(harness.confirmations[0].payee, OTHER);
  assert.equal(harness.confirmations[0].amountMilli, 5000);
});
