// escrow_* agent tools — first-round runtime slice over the pure
// escrowOrderStateMachine. Run `pnpm run compile:electron` first (mirrors
// metabotAutoReplyDefault.test.mjs).
//
// Pins:
//   1. creator role auto-detection + refusal when the session bot is no party,
//   2. the mrc721 happy path (create → escrow_goods → upload_payment_evidence
//      → confirm_received → release_goods → RELEASED) with a renderer-conformant
//      ```escrow-card fence on EVERY stateful reply (parsed by a local mirror of
//      escrowCardSyntax.parseEscrowCardFence so the fence payload can never drift
//      out of the renderer's validated field set),
//   3. wrong-actor refusal (the machine's own message surfaces),
//   4. missing-proof refusal (invariant 3),
//   5. escrow_tick applies a due T1 timeout through the system actor,
//   6. EscrowOrderStore roundtrip with the house temp-dir disposeStore pattern
//      (close first, then tolerant rm — never fail cleanup on Windows handles).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { EscrowOrderStore } = require('../dist-electron/main/services/escrowOrderStore.js');
const { createEscrowOrder } = require('../dist-electron/main/libs/escrowOrderStateMachine.js');
const { buildEscrowAgentTools } = require('../dist-electron/main/libs/escrowAgentTools.js');

// ---------------------------------------------------------------------------
// Fixture bots (base58-safe addresses: no 0 O I l)
// ---------------------------------------------------------------------------

// Addresses stay ≤40 chars so the renderer's party label validation never
// truncates them out of the card.
const ADDR_AGENT = 'AddrAgentBot11111111111111';
const ADDR_SELLER = 'AddrSellerBot1111111111111';
const ADDR_BUYER = 'AddrBuyerBot11111111111111';
const ADDR_FOURTH = 'AddrFourthBot1111111111111';

const METABOT_IDS = { 1: ADDR_AGENT, 2: ADDR_SELLER, 3: ADDR_BUYER, 4: ADDR_FOURTH };
const METABOT_NAMES = { 1: 'agentBot', 2: 'sellerBot', 3: 'buyerBot', 4: 'outsiderBot' };
const NAME_TO_ID = { agentbot: 1, sellerbot: 2, buyerbot: 3, outsiderbot: 4 };

const control = {
  resolveMetabotIdByName: (name) => NAME_TO_ID[String(name).trim().toLowerCase()] ?? null,
  getMetabotMvcAddress: (metabotId) => METABOT_IDS[metabotId] ?? null,
  getMetabotDisplayName: (metabotId) => METABOT_NAMES[metabotId] ?? null,
};

/** Build the tools for one session bot and return the raw handlers by name. */
function buildToolsForBot(store, sessionBotId) {
  const handlers = {};
  const tool = (name, _description, _schema, handler) => {
    handlers[name] = handler;
    return { name };
  };
  buildEscrowAgentTools({
    tool,
    control,
    orders: store,
    sessionId: `sess-bot-${sessionBotId}`,
    resolveMetabotId: () => sessionBotId,
  });
  return handlers;
}

const textOf = (result) => result.content[0].text;

const hex64 = () => randomBytes(32).toString('hex');

// Item pinId fixture (64-hex txid + i0, same shape the renderer test uses).
const ITEM_PIN_ID = '3f2a1b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708i0';

// ---------------------------------------------------------------------------
// Local mirror of the renderer's parseEscrowCardFence — the fence payload must
// stay within the renderer's validated fields or the card is dropped there.
// ---------------------------------------------------------------------------

const CARD_LABEL_RE = /^[0-9A-Za-z_\-·.\u4e00-\u9fff]{1,40}$/;
const CARD_ORDER_ID_RE = /^[A-Za-z0-9_\-: ]{1,64}$/;
const CARD_STATES = new Set([
  'CREATED', 'ITEM_ESCROWED', 'PAID_EVIDENCE_UPLOADED', 'SELLER_CONFIRMED',
  'RELEASED', 'DISPUTED', 'REFUND_ROLLED_BACK', 'CANCELLED',
]);
const CARD_KINDS = new Set(['mrc721', 'metacontract', 'digital', 'service']);

const cleanInt = (value, max) => {
  const num = typeof value === 'number' ? value : NaN;
  if (!Number.isInteger(num) || num < 0 || num > max) return undefined;
  return num;
};

function extractEscrowCard(text) {
  const match = /```escrow-card\n([\s\S]*?)\n```/.exec(String(text ?? ''));
  if (!match) return null;
  let raw;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const orderId = typeof raw.orderId === 'string' ? raw.orderId.trim().slice(0, 64) : '';
  if (!orderId || !CARD_ORDER_ID_RE.test(orderId)) return null;
  if (!CARD_KINDS.has(raw.kind)) return null;
  const amountCents = cleanInt(raw.amountCents, 9_999_999_999);
  if (amountCents === undefined) return null;
  if (!CARD_STATES.has(raw.state)) return null;
  const stateEnteredAt = cleanInt(raw.stateEnteredAt, 4_102_444_800_000);
  if (stateEnteredAt === undefined) return null;
  const timerHours = cleanInt(raw.timerHours, 24 * 60);
  if (timerHours === undefined) return null;

  const parties = raw.parties ?? {};
  for (const key of ['seller', 'buyer', 'agent']) {
    const label = typeof parties[key] === 'string' ? parties[key].trim().replace(/\s+/g, ' ').slice(0, 40) : '';
    if (!label || !CARD_LABEL_RE.test(label)) return null;
  }
  if (raw.next) {
    const actor = typeof raw.next.actor === 'string' ? raw.next.actor.trim().slice(0, 40) : '';
    const step = typeof raw.next.text === 'string' ? raw.next.text.trim().slice(0, 200) : '';
    if (!actor || !CARD_LABEL_RE.test(actor) || !step) return null;
  }
  if (raw.custodyProof !== undefined) {
    const proof = typeof raw.custodyProof === 'string' ? raw.custodyProof.trim() : '';
    if (!proof || proof.length > 128 || /\s/.test(proof)) return null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Store lifecycle (house pattern: close → tolerant rm, cleanup never fails)
// ---------------------------------------------------------------------------

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const orders = new EscrowOrderStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  return { dir, sqliteStore, orders };
}

function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering Windows handle must never fail the test during cleanup
  }
}

async function createOrder(handlers, overrides = {}) {
  const result = await handlers.escrow_order_create({
    kind: 'mrc721',
    title: 'Test NFT Escrow',
    amount_cents: 9900,
    seller: 'sellerBot',
    buyer: 'buyerBot',
    agent: 'agentBot',
    item_pin_id: ITEM_PIN_ID,
    ...overrides,
  });
  return result;
}

const orderIdOf = (createResult) => {
  const match = /Escrow order (esc-[0-9a-z]+-[0-9a-f]+) created/.exec(textOf(createResult));
  assert.ok(match, `create result must carry the order id: ${textOf(createResult).slice(0, 200)}`);
  return match[1];
};

// ---------------------------------------------------------------------------
// 1. Creator role auto-detection + refusal when not a party
// ---------------------------------------------------------------------------

test('escrow_order_create auto-detects the creator role and refuses a non-party creator', async () => {
  const { dir, sqliteStore, orders } = await openStore('idbots-escrow-create-');
  try {
    const agentHandlers = buildToolsForBot(orders, 1);
    const result = await createOrder(agentHandlers, { kind: 'digital', item_pin_id: undefined });
    const text = textOf(result);
    assert.equal(result.isError, undefined, 'agent bot as agent party must create');
    const orderId = orderIdOf(result);
    assert.match(text, /you are the escrow_agent/);

    const doc = orders.get(orderId).payload;
    assert.equal(doc.roles.seller, ADDR_SELLER);
    assert.equal(doc.roles.buyer, ADDR_BUYER);
    assert.equal(doc.roles.escrowAgent, ADDR_AGENT);
    assert.equal(doc.creatorMetabotId, 1);
    assert.equal(doc.state, 'CREATED');
    assert.equal(doc.goodsKind, 'digital');

    // Seller creates the same order shape → role seller.
    const sellerHandlers = buildToolsForBot(orders, 2);
    const sellerResult = await createOrder(sellerHandlers);
    assert.equal(sellerResult.isError, undefined);
    assert.match(textOf(sellerResult), /you are the seller/);

    // A bot that is none of the three parties is refused.
    const outsiderHandlers = buildToolsForBot(orders, 4);
    const outsiderResult = await createOrder(outsiderHandlers);
    assert.equal(outsiderResult.isError, true);
    assert.match(textOf(outsiderResult), /not a party of this order/);
    assert.doesNotMatch(textOf(outsiderResult), /```escrow-card/, 'refusals carry no card');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('escrow_order_create refuses unresolvable parties and bad amounts', async () => {
  const { dir, sqliteStore, orders } = await openStore('idbots-escrow-refuse-');
  try {
    const agentHandlers = buildToolsForBot(orders, 1);
    const badParty = await createOrder(agentHandlers, { seller: 'noSuchBotOrAddress!' });
    assert.equal(badParty.isError, true);
    assert.match(textOf(badParty), /seller:/);

    const badAmount = await createOrder(agentHandlers, { amount_cents: 9900.5 });
    assert.equal(badAmount.isError, true);
    assert.match(textOf(badAmount), /amountCents must be a non-negative integer/);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

// ---------------------------------------------------------------------------
// 2. Happy path mrc721 order — full walk to RELEASED, card on every stateful reply
// ---------------------------------------------------------------------------

test('mrc721 happy path: create → escrow_goods → evidence → confirm → release, cards everywhere', async () => {
  const { dir, sqliteStore, orders } = await openStore('idbots-escrow-happy-');
  try {
    const agentHandlers = buildToolsForBot(orders, 1);
    const sellerHandlers = buildToolsForBot(orders, 2);
    const buyerHandlers = buildToolsForBot(orders, 3);

    const createResult = await createOrder(agentHandlers);
    const orderId = orderIdOf(createResult);
    let card = extractEscrowCard(textOf(createResult));
    assert.ok(card, 'create reply must carry a renderer-conformant escrow-card');
    assert.equal(card.state, 'CREATED');
    assert.equal(card.timerHours, 24);
    assert.equal(card.parties.agent, ADDR_AGENT);
    assert.equal(card.custodyProof, undefined, 'no custody proof before escrow_goods');

    // Custody leg 1: the SELLER transfers the item to the agent address with
    // its own mrc721_transfer (out of scope here) and records the txid.
    const escrowTx = hex64();
    const escrowResult = await sellerHandlers.escrow_order_act({ order_id: orderId, action: 'escrow_goods', proof: escrowTx, note: 'item transferred to agent custody' });
    assert.equal(escrowResult.isError, undefined, textOf(escrowResult));
    assert.match(textOf(escrowResult), /state CREATED → ITEM_ESCROWED/);
    card = extractEscrowCard(textOf(escrowResult));
    assert.ok(card);
    assert.equal(card.state, 'ITEM_ESCROWED');
    assert.equal(card.timerHours, 24);
    assert.equal(card.custodyProof, escrowTx);
    assert.equal(card.parties.seller, ADDR_SELLER);
    // Badge bridge: mrc721 orders also carry the stamped nft-card announcement.
    const badgeMatch = /```nft-card\n([\s\S]*?)\n```/.exec(textOf(escrowResult));
    assert.ok(badgeMatch, 'mrc721 stateful replies also append the nft-card badge fence');
    const badge = JSON.parse(badgeMatch[1]);
    assert.equal(badge.action, 'escrow');
    assert.equal(badge.pinId, ITEM_PIN_ID);
    assert.equal(badge.format, 'mrc721');
    assert.ok(badge.hostStamp, 'badge fence carries the host stamp');

    // Buyer pays outside the system, uploads the evidence (memo embeds order id).
    const evidenceResult = await buyerHandlers.escrow_order_act({
      order_id: orderId,
      action: 'upload_payment_evidence',
      proof: `payment-evidence:${orderId}`,
      basis_memo: `paid via bank transfer, memo ${orderId}`,
      note: 'screenshot archived',
    });
    assert.equal(evidenceResult.isError === true, false, textOf(evidenceResult));
    assert.match(textOf(evidenceResult), /state ITEM_ESCROWED → PAID_EVIDENCE_UPLOADED/);
    card = extractEscrowCard(textOf(evidenceResult));
    assert.ok(card);
    assert.equal(card.state, 'PAID_EVIDENCE_UPLOADED');
    assert.equal(card.timerHours, 48, 'T3 is the 48h confirm window');

    // Seller confirms the exact amount with the order id in the memo.
    const confirmResult = await sellerHandlers.escrow_order_act({
      order_id: orderId,
      action: 'confirm_received',
      proof: `receipt-check:${orderId}`,
      basis_amount_cents: 9900,
      basis_memo: `received ￥99.00 with memo ${orderId}`,
    });
    assert.equal(confirmResult.isError === true, false, textOf(confirmResult));
    assert.match(textOf(confirmResult), /state PAID_EVIDENCE_UPLOADED → SELLER_CONFIRMED/);
    card = extractEscrowCard(textOf(confirmResult));
    assert.ok(card);
    assert.equal(card.state, 'SELLER_CONFIRMED');
    assert.equal(card.timerHours, 24);

    // Custody leg 2: the AGENT transfers the item to the buyer and records it.
    const releaseTx = hex64();
    const releaseResult = await agentHandlers.escrow_order_act({ order_id: orderId, action: 'release_goods', proof: releaseTx });
    assert.equal(releaseResult.isError === true, false, textOf(releaseResult));
    assert.match(textOf(releaseResult), /state SELLER_CONFIRMED → RELEASED/);
    card = extractEscrowCard(textOf(releaseResult));
    assert.ok(card);
    assert.equal(card.state, 'RELEASED');
    assert.equal(card.timerHours, 0, 'terminal states carry no running timer');
    assert.equal(card.next, undefined, 'terminal states carry no next step');

    // The persisted document timeline reflects the full walk.
    const doc = orders.get(orderId).payload;
    assert.equal(doc.state, 'RELEASED');
    assert.deepEqual(doc.timeline.map((entry) => entry.action), [
      'escrow_goods', 'upload_payment_evidence', 'confirm_received', 'release_goods',
    ]);
    assert.equal(doc.timeline[2].basis.includes('amount=9900 cents'), true, 'confirm entry keeps the amount anchor (invariant 5)');

    // list + info surfaces
    const listResult = await sellerHandlers.escrow_order_list({ state: 'terminal' });
    assert.match(textOf(listResult), new RegExp(orderId));
    const infoResult = await buyerHandlers.escrow_order_info({ order_id: orderId });
    assert.match(textOf(infoResult), /timeline \(4 entries\)/);
    assert.match(textOf(infoResult), /escrow_goods/);
    assert.ok(extractEscrowCard(textOf(infoResult)), 'info reply also carries the current-state card');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

// ---------------------------------------------------------------------------
// 3. Wrong-actor refusal — the machine's own message surfaces
// ---------------------------------------------------------------------------

test('wrong-actor refusal: buyer cannot escrow_goods, machine message returned', async () => {
  const { dir, sqliteStore, orders } = await openStore('idbots-escrow-actor-');
  try {
    const agentHandlers = buildToolsForBot(orders, 1);
    const buyerHandlers = buildToolsForBot(orders, 3);
    const orderId = orderIdOf(await createOrder(agentHandlers));

    const result = await buyerHandlers.escrow_order_act({ order_id: orderId, action: 'escrow_goods', proof: hex64() });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /actor buyer may not perform escrow_goods from CREATED/);

    // Nothing changed.
    assert.equal(orders.get(orderId).payload.state, 'CREATED');
    assert.equal(orders.get(orderId).payload.timeline.length, 0);

    // A bot outside the order is refused before reaching the machine at all.
    const outsiderHandlers = buildToolsForBot(orders, 4);
    const outsider = await outsiderHandlers.escrow_order_act({ order_id: orderId, action: 'record_note', note: 'intrusion' });
    assert.equal(outsider.isError, true);
    assert.match(textOf(outsider), /not a party/);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

// ---------------------------------------------------------------------------
// 4. Missing-proof refusal (invariant 3)
// ---------------------------------------------------------------------------

test('missing-proof refusal: escrow_goods without a txid changes nothing', async () => {
  const { dir, sqliteStore, orders } = await openStore('idbots-escrow-proof-');
  try {
    const agentHandlers = buildToolsForBot(orders, 1);
    const sellerHandlers = buildToolsForBot(orders, 2);
    const orderId = orderIdOf(await createOrder(agentHandlers));

    const result = await sellerHandlers.escrow_order_act({ order_id: orderId, action: 'escrow_goods' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /requires proof/);

    const badFormat = await sellerHandlers.escrow_order_act({ order_id: orderId, action: 'escrow_goods', proof: 'not-a-txid' });
    assert.equal(badFormat.isError, true);
    assert.match(textOf(badFormat), /64-hex/);

    // Amount gate: a mismatched confirm amount is refused with the machine's message.
    await sellerHandlers.escrow_order_act({ order_id: orderId, action: 'escrow_goods', proof: hex64() });
    const buyerHandlers = buildToolsForBot(orders, 3);
    await buyerHandlers.escrow_order_act({
      order_id: orderId, action: 'upload_payment_evidence', proof: `ev:${orderId}`, basis_memo: orderId,
    });
    const confirm = await sellerHandlers.escrow_order_act({
      order_id: orderId, action: 'confirm_received', proof: `rc:${orderId}`, basis_amount_cents: 8800, basis_memo: orderId,
    });
    assert.equal(confirm.isError, true);
    assert.match(textOf(confirm), /amount mismatch/);
    assert.equal(orders.get(orderId).payload.state, 'PAID_EVIDENCE_UPLOADED');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

// ---------------------------------------------------------------------------
// 5. escrow_tick applies a due T-timeout via the system actor
// ---------------------------------------------------------------------------

test('escrow_tick applies the due T1 timeout (CREATED → CANCELLED, system actor)', async () => {
  const { dir, sqliteStore, orders } = await openStore('idbots-escrow-tick-');
  try {
    const agentHandlers = buildToolsForBot(orders, 1);
    const sellerHandlers = buildToolsForBot(orders, 2);
    const orderId = orderIdOf(await createOrder(agentHandlers));

    // Age the order past its T1 deadline (24h) by rewriting the anchor —
    // deadlines are NEVER stored, they re-derive from stateEnteredAt.
    const doc = orders.get(orderId).payload;
    doc.stateEnteredAt = Date.now() - 25 * 3_600_000;
    orders.update(doc);

    const tick = await sellerHandlers.escrow_tick({});
    assert.equal(tick.isError === true, false, textOf(tick));
    assert.match(textOf(tick), /TIMEOUT APPLIED: timeout_t1_cancel/);
    assert.match(textOf(tick), /state CREATED → CANCELLED \(system actor\)/);

    const ticked = orders.get(orderId).payload;
    assert.equal(ticked.state, 'CANCELLED');
    assert.equal(ticked.timeline.at(-1).actor, 'system');
    assert.equal(ticked.timeline.at(-1).action, 'timeout_t1_cancel');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('escrow_tick reports on-schedule orders and list/info refuse strangers', async () => {
  const { dir, sqliteStore, orders } = await openStore('idbots-escrow-schedule-');
  try {
    const agentHandlers = buildToolsForBot(orders, 1);
    const sellerHandlers = buildToolsForBot(orders, 2);
    const orderId = orderIdOf(await createOrder(agentHandlers));

    const tick = await sellerHandlers.escrow_tick({});
    assert.equal(tick.isError === true, false, textOf(tick));
    assert.match(textOf(tick), /on schedule/);
    assert.match(textOf(tick), /T1 running/);

    const outsider = await buildToolsForBot(orders, 4).escrow_order_info({ order_id: orderId });
    assert.equal(outsider.isError, true);
    assert.match(textOf(outsider), /neither a party nor the creator/);

    const emptyTick = await buildToolsForBot(orders, 4).escrow_tick({});
    assert.equal(emptyTick.isError === true, false);
    assert.match(textOf(emptyTick), /no active escrow orders/);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

// ---------------------------------------------------------------------------
// 6. EscrowOrderStore roundtrip (house temp-dir pattern)
// ---------------------------------------------------------------------------

test('EscrowOrderStore roundtrip: create/get/update/listByCreator/listByParticipant', async () => {
  const { dir, sqliteStore, orders } = await openStore('idbots-escrow-store-');
  try {
    const base = createEscrowOrder({
      orderId: 'esc-store-1',
      goodsKind: 'service',
      amountCents: 500,
      roles: { seller: ADDR_SELLER, buyer: ADDR_BUYER, escrowAgent: ADDR_AGENT },
      title: 'store roundtrip',
    });
    const doc = { ...base, creatorMetabotId: 7, parties: { seller: { metabotId: 2, address: ADDR_SELLER }, buyer: { metabotId: 3, address: ADDR_BUYER }, escrowAgent: { metabotId: 1, address: ADDR_AGENT } } };

    const created = orders.create(doc, 7);
    assert.equal(created.id, 'esc-store-1');
    assert.equal(created.metabotId, 7);
    assert.equal(created.state, 'CREATED');

    const fetched = orders.get('esc-store-1');
    assert.equal(fetched.payload.orderId, 'esc-store-1');
    assert.equal(fetched.payload.parties.buyer.metabotId, 3, 'extension fields round-trip through the JSON document');
    assert.equal(fetched.createdAt, created.createdAt);
    assert.equal(fetched.updatedAt, created.updatedAt);

    // Whole-document replace bumps updated_at, keeps created_at and creator.
    const moved = { ...doc, state: 'ITEM_ESCROWED', stateEnteredAt: doc.stateEnteredAt + 1000, timeline: [{ from: 'CREATED', to: 'ITEM_ESCROWED', actor: 'seller', action: 'escrow_goods', proof: 'service-snapshot-hash-placeholder', at: Date.now() }] };
    const updated = orders.update(moved);
    assert.equal(updated.state, 'ITEM_ESCROWED');
    assert.ok(updated.updatedAt >= updated.createdAt);
    assert.equal(updated.createdAt, created.createdAt, 'created_at is immutable');
    assert.equal(updated.metabotId, 7, 'creator column is immutable');
    const refetched = orders.get('esc-store-1');
    assert.equal(refetched.state, 'ITEM_ESCROWED');
    assert.equal(refetched.stateEnteredAt, doc.stateEnteredAt + 1000, 'state_entered_at column mirrors the document');

    assert.deepEqual(orders.listByCreator(7).map((row) => row.id), ['esc-store-1']);
    assert.deepEqual(orders.listByCreator(9), []);
    assert.deepEqual(orders.listByParticipant([ADDR_BUYER]).map((row) => row.id), ['esc-store-1']);
    assert.deepEqual(orders.listByParticipant([String(2)]), [], 'roles carry addresses, not local ids');
    assert.deepEqual(orders.listByParticipant(['nobody']), []);
    assert.deepEqual(orders.listByParticipant([ADDR_BUYER], ['CREATED']), []);
    assert.deepEqual(orders.listByParticipant([ADDR_BUYER], ['ITEM_ESCROWED']).map((row) => row.id), ['esc-store-1']);

    assert.throws(() => orders.update({ ...doc, orderId: 'esc-missing' }), /does not exist/);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});
