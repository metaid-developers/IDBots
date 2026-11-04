import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// mrc721SellIntentService direct coverage: the two protocol-critical red
// lines (holder-view authority, pin path outside the item-mint namespace)
// plus the one-pin-per-item create→modify lifecycle and the doc's epoch-
// seconds schema. The agent-tool tests stub the control; these exercise the
// real service.

const require = Module.createRequire(import.meta.url);
const {
  declareMrc721SellIntent,
  cancelMrc721SellIntent,
  parseMrc721SellIntent,
  MRC721_SELL_INTENT_PATH,
} = require('../dist-electron/main/services/mrc721SellIntentService.js');

process.env.IDBOTS_MAN_P2P_LOCAL_BASE && delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;

const PINID = `${'ab'.repeat(32)}i0`;
const BOT_ADDRESS = '1SessionBotAddress1234';
const OTHER_ADDRESS = '1OtherBotAddress5678';
const METAID = '2eb21238314aca030b67ed7b7c4c613f2e8cb7e42ee9140589a4df9da3854aa2';

function makeKv() {
  const map = new Map();
  return { get: (key) => map.get(key), set: (key, value) => map.set(key, value) };
}

function makeDeps(calls) {
  return {
    createPin: async (metabotId, metaidData) => {
      calls.pins.push({ metabotId, ...metaidData });
      return { pinId: `${'se'.repeat(32)}i0`, txids: ['tx1'], totalCost: 500 };
    },
  };
}

const store = {
  getMetabotById: (id) => (id === 1
    ? { mvc_address: BOT_ADDRESS, globalmetaid: METAID }
    : null),
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withItemInfo(item, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ code: 1, data: item });
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test('declare broadcasts a CREATE pin on the fixed unofficial path with a duplicate-free payload', async () => {
  const calls = { pins: [] };
  await withItemInfo({ itemPinId: PINID, collectionName: 'pixel-cats', ownerAddress: BOT_ADDRESS, output: `${'ab'.repeat(32)}:0`, outputValue: 1 }, async () => {
    const result = await declareMrc721SellIntent(
      makeDeps(calls),
      { metabotId: 1, itemPinId: PINID, priceHintSats: 30000, store, intents: makeKv() },
    );
    assert.equal(calls.pins.length, 1);
    const pin = calls.pins[0];
    assert.equal(pin.operation, 'create', 'the protocol is create-only (append-only declaration log)');
    assert.equal(pin.path, '/protocols/mrc721sell', 'fixed path — no per-item suffix');
    assert.ok(!pin.path.startsWith('/nft/'), 'sell pins stay out of the OFFICIAL /nft/* namespace');
    const content = JSON.parse(pin.payload);
    assert.equal(content.active, true);
    assert.equal(content.sellerAddress, BOT_ADDRESS);
    assert.equal(content.itemPinId, PINID);
    assert.ok(!('protocol' in content), 'payload must not duplicate the pin 7-tuple protocol identity');
    assert.ok(!('version' in content), 'payload must not duplicate the pin version');
    assert.ok(!('contact' in content), 'no contact object — sellerMetaId is the only identity');
    assert.ok(!('metabotId' in content), 'local per-machine ids never go on-chain');
    assert.ok(content.createdAt < 1e12, 'createdAt must be epoch SECONDS per the doc schema');
    assert.equal(result.intent.itemPinId, PINID);
  });
});

test('declare refuses an item the bot does not hold — the holder view is the only sell authority', async () => {
  const calls = { pins: [] };
  await withItemInfo({ itemPinId: PINID, ownerAddress: OTHER_ADDRESS }, async () => {
    await assert.rejects(
      () => declareMrc721SellIntent(makeDeps(calls), { metabotId: 1, itemPinId: PINID, store, intents: makeKv() }),
      /not by the declaring bot/,
    );
  });
  assert.equal(calls.pins.length, 0, 'no pin may be broadcast for an item the bot does not hold');
});

test('declare → cancel → re-declare is an append-only log on the fixed path (latest pin wins)', async () => {
  const calls = { pins: [] };
  const kv = makeKv();
  await withItemInfo({ itemPinId: PINID, collectionName: 'pixel-cats', ownerAddress: BOT_ADDRESS }, async () => {
    await declareMrc721SellIntent(makeDeps(calls), { metabotId: 1, itemPinId: PINID, store, intents: kv });
    await cancelMrc721SellIntent(makeDeps(calls), { metabotId: 1, itemPinId: PINID, store, intents: kv });
    const relisted = await declareMrc721SellIntent(makeDeps(calls), { metabotId: 1, itemPinId: PINID, priceHintSats: 25000, store, intents: kv });
    assert.equal(relisted.intent.active, true);
    assert.equal(relisted.intent.priceHintSats, 25000);
  });
  assert.equal(calls.pins.length, 3);
  for (const pin of calls.pins) {
    assert.equal(pin.operation, 'create', 'every declaration is a CREATE pin (buzz pattern)');
    assert.equal(pin.path, '/protocols/mrc721sell', 'fixed path for the whole lifecycle');
  }
  assert.equal(JSON.parse(calls.pins[1].payload).active, false, 'cancel = a new declaration with active:false');
  assert.equal(JSON.parse(calls.pins[2].payload).active, true, 're-declare = a new active declaration; per itemPinId the LATEST pin wins');
});

test('parseMrc721SellIntent validates pinId and price-hint shape without protocol/version fields', () => {
  assert.throws(() => parseMrc721SellIntent({ itemPinId: 'nope', sellerAddress: BOT_ADDRESS }), /itemPinId/);
  assert.throws(() => parseMrc721SellIntent({ itemPinId: PINID, sellerAddress: 'not-an-address' }), /sellerAddress/);
  assert.throws(() => parseMrc721SellIntent({ itemPinId: PINID, sellerAddress: BOT_ADDRESS, priceHintSats: -5 }), /priceHintSats/);
  const parsed = parseMrc721SellIntent({ itemPinId: PINID, sellerAddress: BOT_ADDRESS });
  assert.deepEqual(parsed.acceptedCurrencies, ['space']);
  assert.deepEqual(parsed.settlement, ['atomic-swap', 'escrow']);
  assert.equal(parsed.active, true);
  assert.ok(!('protocol' in parsed) && !('version' in parsed) && !('contact' in parsed));
});
