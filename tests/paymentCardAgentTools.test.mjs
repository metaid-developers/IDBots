// payment_card_emit — the G1 agent tool surface. Run `pnpm run compile:electron`
// first (same pattern as escrowAgentTools.test.mjs).
//
// Pins:
//   1. the tool mounts and returns a renderer-parseable ```pay-card fence with
//      the caller's exact order id / amount and a payee derived from the
//      control's decrypted info (no payee parameter exists at all),
//   2. every refusal path (no receiving info / decrypt failure / amount and
//      memo mismatch / invalid amount) returns isError with a typed code and
//      NO card fence — a refusal must never leave a payable card behind,
//   3. the owner's saved QR image / Alipay PID / ciphertext never appear in the
//      tool reply,
//   4. zero funds flow is structural: neither new module imports a wallet,
//      chain-write budget or pin writer,
//   5. the per-emit owner gate: every emit asks first — a refusal, timeout or
//      gate error leaves NO payable card behind, and the runner wires the gate
//      fail-closed (ownerOnly + timeout deny).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

/** Load the compiled runner with a minimal electron stub (same shape as
 * orderMemoryReadOnly.test.mjs). */
function loadRunnerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadRunnerModule();
const { buildPaymentCardAgentTools } = require('../dist-electron/main/libs/paymentCardAgentTools.js');
const { parsePayCardFence } = require('../dist-electron/renderer/components/chat/paymentCardSyntax.js');

// Synthetic receiving code in the real shape (never a real account's code).
const TEST_QR = 'https://qr.alipay.com/testcode4unittests0abc';
const TEST_PID = '2088000000000001';
const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const INFO = {
  payeeDisplayName: '张三',
  alipayPid: TEST_PID,
  qrContent: TEST_QR,
  qrImageDataUrl: TEST_IMAGE,
};

/** Build the tool set over a fixed control reply and return its handlers.
 * `confirm` defaults to an always-approving owner gate; the gate tests below
 * override it. */
function buildTools(control, confirm = async () => true) {
  const handlers = {};
  const tool = (name, _description, _schema, handler) => {
    handlers[name] = handler;
    return { name };
  };
  buildPaymentCardAgentTools({ tool, control, confirm });
  return handlers;
}

const okControl = { readReceivingInfo: () => ({ status: 'ok', info: INFO, updatedAt: 1_794_465_546_265 }) };

function textOf(result) {
  return result.content.map((part) => part.text).join('\n');
}

function fenceBodyOf(text) {
  const match = text.match(/```pay-card\n([\s\S]*?)\n```/);
  return match ? match[1] : null;
}

test('payment_card_emit mounts one tool and emits a parseable fence with the caller\'s amount/order', async () => {
  const handlers = buildTools(okControl);
  assert.deepEqual(Object.keys(handlers), ['payment_card_emit']);

  const result = await handlers.payment_card_emit({ order_id: 'pcard-drill-20261117-01', amount_cents: 1 });
  assert.notEqual(result.isError, true);
  const text = textOf(result);

  const body = fenceBodyOf(text);
  assert.ok(body, 'reply must carry a ```pay-card fence');

  const parsed = parsePayCardFence(body);
  assert.ok(parsed, 'the emitted fence must pass the renderer parser');
  assert.equal(parsed.orderId, 'pcard-drill-20261117-01');
  assert.equal(parsed.amountCents, 1);
  assert.equal(parsed.currency, 'CNY');
  assert.equal(parsed.payee.qrContent, TEST_QR);
  assert.equal(parsed.payee.displayName, '张*');

  assert.match(text, /Payment card ready — ¥0\.01 \(1 cents\), order\/memo pcard-drill-20261117-01/);
  assert.match(text, /point-to-point/);
});

test('payment_card_emit crosses declared amount_yuan/memo against the card face', async () => {
  const handlers = buildTools(okControl);

  const matched = await handlers.payment_card_emit({ order_id: 'order-a', amount_cents: 1, amount_yuan: '0.01', memo: 'order-a' });
  assert.notEqual(matched.isError, true);
  assert.ok(fenceBodyOf(textOf(matched)));

  for (const args of [
    { order_id: 'order-a', amount_cents: 1, amount_yuan: '0.02' },
    { order_id: 'order-a', amount_cents: 1, memo: 'another memo' },
    { order_id: 'order-a', amount_cents: 0 },
    { order_id: '', amount_cents: 1 },
  ]) {
    const refused = await handlers.payment_card_emit(args);
    assert.equal(refused.isError, true, `args ${JSON.stringify(args)} must be refused`);
    assert.equal(fenceBodyOf(textOf(refused)), null, 'a refusal must never carry a card fence');
  }
});

test('payment_card_emit surfaces the typed refusal codes and emits no card', async () => {
  const cases = [
    [{ status: 'refused', code: 'NO_RECEIVING_INFO', message: 'owner never saved it' }, 'NO_RECEIVING_INFO'],
    [{ status: 'refused', code: 'DECRYPT_FAILED', message: 'blob unreadable' }, 'DECRYPT_FAILED'],
    [{ status: 'refused', code: 'NO_QR_CHANNEL', message: 'PID only' }, 'NO_QR_CHANNEL'],
  ];
  for (const [reply, code] of cases) {
    const handlers = buildTools({ readReceivingInfo: () => reply });
    const result = await handlers.payment_card_emit({ order_id: 'order-b', amount_cents: 100 });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, new RegExp(`payment_card_emit refused: ${code}`));
    assert.match(text, /Nothing was emitted\./);
    assert.equal(fenceBodyOf(text), null);
  }
});

test('payment_card_emit refuses a PID-only decrypted info even with a valid amount', async () => {
  const handlers = buildTools({
    readReceivingInfo: () => ({ status: 'ok', info: { alipayPid: TEST_PID }, updatedAt: 1 }),
  });
  const result = await handlers.payment_card_emit({ order_id: 'order-c', amount_cents: 100 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /NO_QR_CHANNEL/);
  assert.equal(fenceBodyOf(textOf(result)), null);
});

test('the per-emit owner gate runs before anything is emitted and receives the exact card face', async () => {
  const confirmations = [];
  const handlers = buildTools(okControl, async (info) => {
    confirmations.push(info);
    return true;
  });

  const result = await handlers.payment_card_emit({ order_id: 'gate-1', amount_cents: 250 });
  assert.notEqual(result.isError, true);
  assert.ok(fenceBodyOf(textOf(result)), 'an approved gate emits the card');

  assert.deepEqual(confirmations, [{
    orderId: 'gate-1',
    amountCents: 250,
    payeeDisplayName: '张三',
  }]);
});

test('an owner refusal / timeout resolves to OWNER_CONFIRMATION_DENIED and emits no card', async () => {
  for (const deny of [false, Promise.resolve(false)]) {
    const handlers = buildTools(okControl, async () => deny);
    const result = await handlers.payment_card_emit({ order_id: 'gate-2', amount_cents: 100 });
    assert.equal(result.isError, true, 'a denied gate must refuse');
    const text = textOf(result);
    assert.match(text, /payment_card_emit refused: OWNER_CONFIRMATION_DENIED/);
    assert.match(text, /Nothing was emitted\./);
    assert.equal(fenceBodyOf(text), null, 'a denied gate must never leave a payable card behind');
  }
});

test('a throwing owner gate fails closed — no card is emitted', async () => {
  const handlers = buildTools(okControl, async () => {
    throw new Error('gate channel exploded');
  });
  const result = await handlers.payment_card_emit({ order_id: 'gate-3', amount_cents: 100 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /OWNER_CONFIRMATION_DENIED/);
  assert.equal(fenceBodyOf(textOf(result)), null);
});

test('the runner wires the payment-card gate fail-closed (ownerOnly + timeout deny)', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const runnerSource = fs.readFileSync(path.join(repoRoot, 'src/main/libs/coworkRunner.ts'), 'utf8');
  const gateStart = runnerSource.indexOf('private async confirmPaymentCardEmit');
  assert.notEqual(gateStart, -1, 'coworkRunner must own a confirmPaymentCardEmit gate');
  const gate = runnerSource.slice(gateStart, gateStart + 4000);
  assert.ok(gate.includes("'payment_card_emit'"), 'the gate must tag the approval request with the tool name');
  assert.ok(gate.includes("'deny'"), 'the gate must time out to deny');
  assert.ok(gate.includes('ownerOnly: true'), 'the gate must be owner-only (relay seats cannot answer)');
  assert.ok(
    /if \(!activeSession\) \{\s*return false;/.test(gate),
    'a background / unattended turn has no owner seat and must be refused',
  );
});

test('the owner\'s saved image / PID / ciphertext never reach the tool reply', async () => {
  const handlers = buildTools(okControl);
  const result = await handlers.payment_card_emit({ order_id: 'order-d', amount_cents: 1 });
  const text = textOf(result);
  assert.equal(text.includes('data:image'), false);
  assert.equal(text.includes(TEST_IMAGE), false);
  assert.equal(text.includes(TEST_PID), false);
  assert.equal(text.includes('qrImageDataUrl'), false);
});

test('zero funds flow is structural: no wallet / chain-write import in the emitter or the tool', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const files = [
    'src/main/services/paymentCardEmitter.ts',
    'src/main/libs/paymentCardAgentTools.ts',
  ];
  const forbidden = /createPin|chainWriteBudget|wallet_|withChainWriteBudget|omni_cast|post_buzz|broadcastBtcTx|mvcSpend|openMetabotBtcWallet/;
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    assert.equal(forbidden.test(source), false, `${file} must not reference any funds/chain-write surface`);
  }
});

test('any provider bot session mounts payment_card_emit once the control is wired', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const session = coworkStore.createSession('供给方 bot 会话', '/tmp/g1', '', 'local', [], 15, 'cowork', null, null, null);
    const passthrough = (name, description, parameters, execute) => ({ name, description, parameters, execute });

    // Unwired runner (the default on this machine until main.ts passes the
    // control) exposes nothing: the tool is opt-in, never a stray surface.
    const bare = new CoworkRunner(coworkStore, {});
    const bareNames = bare.buildSessionInlineTools(session.id, passthrough, undefined).map((t) => t.name);
    assert.equal(bareNames.includes('payment_card_emit'), false);

    // Wired runner mounts it for an ORDINARY bot session — no Twin session, no
    // session-bot resolution, no memory gate.
    const wired = new CoworkRunner(coworkStore, { paymentCards: okControl });
    const names = wired.buildSessionInlineTools(session.id, passthrough, undefined).map((t) => t.name);
    assert.ok(names.includes('payment_card_emit'), 'payment_card_emit must mount in an ordinary bot session');
  } finally {
    cleanup();
  }
});
