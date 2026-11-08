// mrc721OpenOfferService direct coverage: the /protocols/mrc721offer pin
// lifecycle (publish → cancel, latest-wins, epoch-seconds schema), the
// holder-view sell authority, and the take-side verification gates (lying
// advertisement refused, stale outpoint refused). The agent-tool layer stubs
// the control; these exercise the REAL service against a stubbed indexer.

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { mvc } = require('meta-contract');

const {
  publishMrc721OpenOffer,
  cancelMrc721OpenOffer,
  listMrc721MyOpenOffers,
  verifyMrc721OpenOffer,
  takeMrc721OpenOffer,
  parseMrc721OpenOffer,
  fetchMrc721OpenOffers,
  MRC721_OPEN_OFFER_PATH,
} = require('../dist-electron/main/services/mrc721OpenOfferService.js');
const { buildMrc721OpenOfferTx } = require('../dist-electron/main/libs/mrc721OpenOfferTx.js');
const { MRC721_MIN_SELL_PRICE_SATS } = require('../dist-electron/main/libs/mrc721AtomicSwapTx.js');

const TXID = `${'ab'.repeat(32)}`;
const PINID = `${TXID}i0`;

function keypair() {
  const key = new mvc.PrivateKey();
  return { key, wif: key.toWIF(), address: key.toAddress('livenet').toString() };
}

function makeKv() {
  const map = new Map();
  return { get: (key) => map.get(key), set: (key, value) => map.set(key, value) };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Stub the indexer read layer: `item` is the holder-view row the service sees. */
function installFetch(item) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ code: 1, data: item });
  return () => { globalThis.fetch = previous; };
}

function itemFor(sellerAddress) {
  return {
    pinId: PINID,
    ownerAddress: sellerAddress,
    burned: false,
    output: `${TXID}:0`,
    outputValue: 546,
    collectionName: 'pixel-cats',
    collectionPinId: `${'cd'.repeat(32)}i0`,
  };
}

function makePinDeps(calls) {
  return {
    createPin: async (metabotId, metaidData) => {
      calls.pins.push({ metabotId, ...metaidData });
      return { pinId: `${'of'.repeat(32)}i0`, txids: ['tx1'], totalCost: 500 };
    },
  };
}

test('publish signs the offer, broadcasts the /protocols/mrc721offer pin, and records it (epoch seconds)', async () => {
  const seller = keypair();
  const restore = installFetch(itemFor(seller.address));
  try {
    const calls = { pins: [] };
    const offers = makeKv();
    const result = await publishMrc721OpenOffer(
      {
        createPin: makePinDeps(calls).createPin,
        buildOfferTx: async (_store, params) => buildMrc721OpenOfferTx({
          sellerWif: seller.wif,
          sellerAddress: seller.address,
          outpoint: params.outpoint,
          priceSats: params.priceSats,
        }),
      },
      {
        metabotId: 1,
        itemPinId: PINID,
        priceSats: 30_000,
        store: { getMetabotById: () => ({ mvc_address: seller.address }) },
        offers,
      },
    );
    assert.equal(result.offerPinId, `${'of'.repeat(32)}i0`);
    assert.equal(result.outpoint.txid, TXID);
    assert.equal(calls.pins.length, 1);
    assert.equal(calls.pins[0].path, MRC721_OPEN_OFFER_PATH);
    assert.equal(calls.pins[0].operation, 'create');
    const payload = JSON.parse(calls.pins[0].payload);
    assert.equal(payload.active, true);
    assert.equal(payload.itemPinId, PINID);
    assert.equal(payload.priceSats, 30_000);
    assert.ok(Number.isInteger(payload.createdAt), 'createdAt is epoch SECONDS');
    assert.ok(payload.offerTx.length > 100);

    const records = listMrc721MyOpenOffers(offers, 1);
    const view = (await records)[0];
    assert.equal(view.status, 'active');
    assert.equal(view.offer.priceSats, 30_000);
  } finally {
    restore();
  }
});

test('publish refuses an item this bot does not hold, a burned item, and a sub-floor price', async () => {
  const seller = keypair();
  const stranger = keypair();
  const deps = {
    createPin: async () => { throw new Error('should not broadcast'); },
    buildOfferTx: async () => { throw new Error('should not sign'); },
  };
  const base = { metabotId: 1, itemPinId: PINID, priceSats: 30_000, store: { getMetabotById: () => ({ mvc_address: seller.address }) }, offers: makeKv() };

  const restoreOther = installFetch(itemFor(stranger.address));
  try {
    await assert.rejects(() => publishMrc721OpenOffer(deps, base), /not by the publishing bot/);
  } finally { restoreOther(); }

  const restoreBurned = installFetch(itemFor(seller.address));
  try {
    globalThis.fetch = async () => jsonResponse({ code: 1, data: { ...itemFor(seller.address), burned: true } });
    await assert.rejects(() => publishMrc721OpenOffer(deps, base), /burned/);
  } finally { restoreBurned(); }

  await assert.rejects(
    () => publishMrc721OpenOffer(deps, { ...base, priceSats: MRC721_MIN_SELL_PRICE_SATS - 1 }),
    /22000/,
  );
});

test('take gates: the real offer passes, a lying advertisement and a stale outpoint are refused', async () => {
  const seller = keypair();
  const buyer = keypair();
  const built = buildMrc721OpenOfferTx({
    sellerWif: seller.wif,
    sellerAddress: seller.address,
    outpoint: { txid: TXID, vout: 0, satoshis: 546 },
    priceSats: 30_000,
  });
  const offer = { itemPinId: PINID, priceSats: 30_000, offerTx: built.offerTx };
  const item = itemFor(seller.address);

  const restore = installFetch(item);
  try {
    const verified = await verifyMrc721OpenOffer(offer, { isOutpointUnspent: async () => true });
    assert.equal(verified.sellerAddress, seller.address);
    assert.equal(verified.outpoint.txid, TXID);

    const taken = await takeMrc721OpenOffer(
      {
        completeOfferTx: async (_store, params) => {
          assert.equal(params.offer.itemPinId, PINID);
          assert.equal(params.offer.priceSats, 30_000);
          return { txId: 'f'.repeat(64), spentOutpoints: [`${TXID}:0`], feeSats: 300, feeRateEffective: 1 };
        },
        isOutpointUnspent: async () => true,
      },
      { metabotId: 2, offer, feeRate: 1, store: { getMetabotById: () => ({}) } },
    );
    assert.equal(taken.txId, 'f'.repeat(64));
    assert.equal(taken.sellerAddress, seller.address);
  } finally { restore(); }

  // A lying advertisement: the payload claims 30_100 but the signature locked 30_000.
  const restoreTampered = installFetch(item);
  try {
    await assert.rejects(
      () => verifyMrc721OpenOffer({ ...offer, priceSats: 30_100 }, { isOutpointUnspent: async () => true }),
      /seller signature|check 1 \(outputs\)/,
    );
  } finally { restoreTampered(); }

  // A stale offer: the item outpoint moved on-chain.
  const restoreStale = installFetch(item);
  try {
    await assert.rejects(
      () => verifyMrc721OpenOffer(offer, { isOutpointUnspent: async () => false }),
      /already spent/,
    );
  } finally { restoreStale(); }
});

test('cancel flips the local record and broadcasts active:false; re-cancel is refused', async () => {
  const seller = keypair();
  const restore = installFetch(itemFor(seller.address));
  try {
    const calls = { pins: [] };
    const offers = makeKv();
    const deps = {
      createPin: makePinDeps(calls).createPin,
      buildOfferTx: async (_store, params) => buildMrc721OpenOfferTx({
        sellerWif: seller.wif,
        sellerAddress: seller.address,
        outpoint: params.outpoint,
        priceSats: params.priceSats,
      }),
    };
    const storeStub = { getMetabotById: () => ({ mvc_address: seller.address }) };
    await publishMrc721OpenOffer(deps, { metabotId: 1, itemPinId: PINID, priceSats: 30_000, store: storeStub, offers });
    const cancelled = await cancelMrc721OpenOffer(deps, { metabotId: 1, itemPinId: PINID, store: storeStub, offers });
    assert.equal(cancelled.offer.active, false);
    assert.equal(calls.pins.length, 2);
    assert.equal(JSON.parse(calls.pins[1].payload).active, false);
    await assert.rejects(
      () => cancelMrc721OpenOffer(deps, { metabotId: 1, itemPinId: PINID, store: storeStub, offers }),
      /already cancelled/,
    );
    const views = await listMrc721MyOpenOffers(offers, 1);
    assert.equal(views[0].status, 'cancelled');
  } finally {
    restore();
  }
});

test('parse refuses a sub-floor price, a malformed pinId, and a missing offerTx', () => {
  assert.throws(() => parseMrc721OpenOffer({ itemPinId: PINID, priceSats: 1000, offerTx: 'x' }), /22000/);
  assert.throws(() => parseMrc721OpenOffer({ itemPinId: 'nope', priceSats: 30_000, offerTx: 'x' }), /itemPinId/);
  assert.throws(() => parseMrc721OpenOffer({ itemPinId: PINID, priceSats: 30_000 }), /offerTx/);
});

test('market fetch maps the R-E-2 list envelope, passes filters, and degrades honestly on 404', async () => {
  const seen = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return jsonResponse({
      code: 1,
      data: {
        list: [
          { itemPinId: PINID, offerPinId: `${'of'.repeat(32)}i0`, active: true, priceSats: 30_000, createdAt: 1_700_000_000, height: 197_900 },
          { itempinid: `${'ef'.repeat(32)}i0`, offerpinid: `${'ee'.repeat(32)}i0`, active: true },
        ],
        total: 2,
        cursor: 'c2',
      },
    });
  };
  try {
    const page = await fetchMrc721OpenOffers({ collectionPinId: 'col-i0', size: 5 });
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].itemPinId, PINID);
    assert.equal(page.items[0].priceSats, 30_000);
    assert.equal(page.items[1].itemPinId, `${'ef'.repeat(32)}i0`, 'lowercase-duplicate rows are read too');
    assert.equal(page.cursor, 'c2');
    const marketUrl = seen.find((url) => url.includes('/api/mrc721/offers'));
    assert.ok(marketUrl, 'the list endpoint was queried');
    assert.ok(marketUrl.includes('collectionPinId=col-i0'), 'filters ride the query');
    assert.ok(marketUrl.includes('active=true'), 'the market reads live offers only');

    globalThis.fetch = async () => new Response(JSON.stringify({ code: 40400, message: 'not served here' }), { status: 404, headers: { 'content-type': 'application/json' } });
    await assert.rejects(() => fetchMrc721OpenOffers({}), (error) => error.mrc721Status === 404 || error.mrc721Code !== undefined, 'the absent endpoint surfaces its structured marker');
  } finally {
    globalThis.fetch = previous;
  }
});
