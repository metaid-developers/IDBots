import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc, TxComposer } = require('meta-contract');

const {
  MRC721_ATOMIC_SWAP_SIGHASH,
  MRC721_MIN_SELL_PRICE_SATS,
  buildMvc721SellPartialTx,
  buildMrc721AtomicSwapListing,
  completeMvc721BuyTxLocally,
  estimateMvc721BuyNormalFee,
  sighashTypeOfScript,
} = await import('../dist-electron/main/libs/mrc721AtomicSwapTx.js');

const {
  buyMrc721Listing,
  isMrc721OutpointUnspent,
  listMrc721MySellOrders,
  recordMrc721Listing,
  sellMrc721Item,
  verifyMrc721Listing,
} = await import('../dist-electron/main/services/mrc721AtomicSwapService.js');

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  getMvcSpendSessionSnapshot,
  resetMvcSpendSessionStateForTests,
} = require('../dist-electron/main/services/mvcSpendSessionState.js');

const TXID = 'ab'.repeat(32);
const PIN_ID = `${TXID}i0`;
const Signature = mvc.crypto.Signature;

function keypair() {
  const key = new mvc.PrivateKey();
  return {
    key,
    wif: key.toWIF(),
    address: key.toAddress('livenet').toString(),
  };
}

function listingFor(seller, buyer, priceSats = MRC721_MIN_SELL_PRICE_SATS) {
  const outpoint = { txid: TXID, vout: 0, satoshis: 546 };
  const built = buildMvc721SellPartialTx({
    sellerWif: seller.wif,
    sellerAddress: seller.address,
    buyerAddress: buyer.address,
    outpoint,
    priceSats,
  });
  return buildMrc721AtomicSwapListing({
    itemPinId: PIN_ID,
    collectionPinId: `${'cd'.repeat(32)}i0`,
    outpoint,
    sellerAddress: seller.address,
    buyerAddress: buyer.address,
    priceSats,
    partialTx: built.partialTx,
    sigtype: built.sigtype,
    feeRate: 1,
    nowSeconds: 1_700_000_000,
  });
}

function itemInfo(seller, overrides = {}) {
  return {
    itemPinId: PIN_ID,
    ownerAddress: seller.address,
    output: `${TXID}:0`,
    outputValue: 546,
    burned: false,
    genesisChainName: 'mvc',
    collectionPinId: `${'cd'.repeat(32)}i0`,
    ...overrides,
  };
}

function verifyDeps(seller, unspent = async () => true, itemOverrides = {}) {
  return {
    fetchItemInfo: async () => itemInfo(seller, itemOverrides),
    isOutpointUnspent: unspent,
    nowSeconds: 1_700_000_100,
  };
}

test('sell partial locks the NFT at input 0 and the price at output 1 with sighash 193', () => {
  const seller = keypair();
  const buyer = keypair();
  const listing = listingFor(seller, buyer);
  const composer = TxComposer.deserialize(listing.partialTx);
  const tx = composer.tx;
  assert.equal(listing.sigtype, MRC721_ATOMIC_SWAP_SIGHASH);
  assert.equal(MRC721_ATOMIC_SWAP_SIGHASH, 193);
  assert.equal(tx.inputs.length, 1);
  assert.equal(tx.inputs[0].prevTxId.toString('hex'), TXID);
  assert.equal(tx.inputs[0].outputIndex, 0);
  assert.equal(tx.outputs[0].script.toAddress('livenet').toString(), buyer.address);
  assert.equal(tx.outputs[0].satoshis, 546);
  assert.equal(tx.outputs[1].script.toAddress('livenet').toString(), seller.address);
  assert.equal(tx.outputs[1].satoshis, MRC721_MIN_SELL_PRICE_SATS);
  assert.equal(sighashTypeOfScript(tx.inputs[0].script), MRC721_ATOMIC_SWAP_SIGHASH);
  assert.ok(tx.inputs[0].script.toBuffer().length > 0);
});

test('buy completion appends one input, keeps both outputs, and drops the seller signature if an output changes', async () => {
  const seller = keypair();
  const buyer = keypair();
  const listing = listingFor(seller, buyer);
  const { normalFeeSats } = estimateMvc721BuyNormalFee(listing.partialTx, 1);
  const paymentValue = listing.priceSats + normalFeeSats + 50;
  const paymentTxid = 'cd'.repeat(32);
  const bought = completeMvc721BuyTxLocally({
    partialTx: listing.partialTx,
    buyerWif: buyer.wif,
    buyerAddress: buyer.address,
    sellerAddress: seller.address,
    priceSats: listing.priceSats,
    outpoint: listing.outpoint,
    feeRate: 1,
    utxos: [{
      txId: paymentTxid,
      outputIndex: 1,
      satoshis: paymentValue,
      address: buyer.address,
      height: 10,
    }],
  });
  const tx = new mvc.Transaction(bought.txHex);
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 2);
  assert.equal(bought.feeSats, paymentValue - listing.priceSats);
  assert.equal(tx.inputs[1].prevTxId.toString('hex'), paymentTxid);
  assert.deepEqual(bought.spentOutpoints, [`${TXID}:0`, `${paymentTxid}:1`]);

  const tampered = TxComposer.deserialize(listing.partialTx);
  tampered.tx.outputs[1].satoshis = listing.priceSats + 1;
  const tamperedListing = {
    ...listing,
    priceSats: listing.priceSats + 1,
    partialTx: tampered.serialize(),
  };
  await assert.rejects(
    () => verifyMrc721Listing(tamperedListing, verifyDeps(seller)),
    /check 2 \(seller signature\)/,
  );
});

test('buy rejects an oversized fee before signing and a missing UTXO', () => {
  const seller = keypair();
  const buyer = keypair();
  const listing = listingFor(seller, buyer);
  const { normalFeeSats } = estimateMvc721BuyNormalFee(listing.partialTx, 1);
  assert.throws(
    () => completeMvc721BuyTxLocally({
      partialTx: listing.partialTx,
      buyerWif: buyer.wif,
      buyerAddress: buyer.address,
      sellerAddress: seller.address,
      priceSats: listing.priceSats,
      outpoint: listing.outpoint,
      feeRate: 1,
      utxos: [{
        txId: '11'.repeat(32),
        outputIndex: 0,
        satoshis: listing.priceSats + normalFeeSats * 4,
        address: buyer.address,
        height: 3,
      }],
    }),
    /Nothing was signed/,
  );
  assert.throws(
    () => completeMvc721BuyTxLocally({
      partialTx: listing.partialTx,
      buyerWif: buyer.wif,
      buyerAddress: buyer.address,
      sellerAddress: seller.address,
      priceSats: listing.priceSats,
      outpoint: listing.outpoint,
      feeRate: 1,
      utxos: [{
        txId: '22'.repeat(32),
        outputIndex: 0,
        satoshis: 1000,
        address: buyer.address,
        height: 3,
      }],
    }),
    /Not enough MVC balance/,
  );
});

test('verify rejects a SIGHASH_SINGLE listing even if the envelope claims sighash 193', async () => {
  const seller = keypair();
  const buyer = keypair();
  const listing = listingFor(seller, buyer);
  const composer = TxComposer.deserialize(listing.partialTx);
  const single = Signature.SIGHASH_SINGLE | Signature.SIGHASH_FORKID | Signature.SIGHASH_ANYONECANPAY;
  composer.unlockP2PKHInput(seller.key, 0, single);
  const attacked = { ...listing, partialTx: composer.serialize(), sigtype: MRC721_ATOMIC_SWAP_SIGHASH };
  await assert.rejects(
    () => verifyMrc721Listing(attacked, verifyDeps(seller)),
    /check 1 \(sigtype\)/,
  );
});

test('verify matrix rejects tampered price, wrong buyer output, bad owner, burn, and a spent outpoint', async () => {
  const seller = keypair();
  const buyer = keypair();
  const listing = listingFor(seller, buyer);
  const happy = verifyDeps(seller);

  await assert.rejects(
    () => verifyMrc721Listing({ ...listing, priceSats: listing.priceSats + 1 }, happy),
    /check 1 \(outputs\)/,
  );

  const stranger = keypair();
  const moved = JSON.parse(listing.partialTx);
  moved.tx.outputs[0].script = mvc.Script.buildPublicKeyHashOut(stranger.address).toHex();
  await assert.rejects(
    () => verifyMrc721Listing({ ...listing, partialTx: JSON.stringify(moved) }, happy),
    /check 1 \(outputs\)/,
  );

  await assert.rejects(
    () => verifyMrc721Listing(listing, verifyDeps(seller, async () => true, { ownerAddress: stranger.address })),
    /check 3 \(ownership\)/,
  );
  await assert.rejects(
    () => verifyMrc721Listing(listing, verifyDeps(seller, async () => true, { burned: true })),
    /check 3 \(burned\)/,
  );
  await assert.rejects(
    () => verifyMrc721Listing(listing, verifyDeps(seller, async () => false)),
    /check 4 \(unspent\)/,
  );
  await assert.rejects(
    () => verifyMrc721Listing({ ...listing, priceSats: 1000 }, happy),
    /22000/,
  );
});

test('sell checks ownership before building, and buy does not touch the wallet when verify fails', async () => {
  const seller = keypair();
  const buyer = keypair();
  let built = 0;
  let bought = 0;
  const store = {
    getMetabotById: (id) => ({ mvc_address: id === 1 ? seller.address : buyer.address }),
  };
  await assert.rejects(
    () => sellMrc721Item(
      { buildPartialTx: async () => { built += 1; throw new Error('should not build'); } },
      {
        store,
        metabotId: 1,
        itemPinId: PIN_ID,
        buyerAddress: buyer.address,
        priceSats: MRC721_MIN_SELL_PRICE_SATS,
        feeRate: 1,
        itemInfo: itemInfo(seller, { ownerAddress: buyer.address }),
      },
    ),
    /not this session bot/,
  );
  assert.equal(built, 0);

  const listing = listingFor(seller, buyer);
  await assert.rejects(
    () => buyMrc721Listing(
      { completeBuy: async () => { bought += 1; throw new Error('should not buy'); } },
      {
        store,
        metabotId: 2,
        listing,
        feeRate: 1,
        verifyDeps: verifyDeps(seller, async () => false),
      },
    ),
    /check 4 \(unspent\)/,
  );
  assert.equal(bought, 0);
});

test('sell records a local listing and buy records the spent outpoints', async () => {
  const seller = keypair();
  const buyer = keypair();
  const store = {
    getMetabotById: (id) => ({ mvc_address: id === 1 ? seller.address : buyer.address }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrc721-orders-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const orders = {
      get: (key) => sqliteStore.get(key),
      set: (key, value) => sqliteStore.set(key, value),
    };
    const listing = await sellMrc721Item(
      {
        buildPartialTx: async (_store, params) => buildMvc721SellPartialTx({
          sellerWif: seller.wif,
          sellerAddress: seller.address,
          buyerAddress: params.buyerAddress,
          outpoint: params.outpoint,
          priceSats: params.priceSats,
        }),
      },
      {
        store,
        metabotId: 1,
        itemPinId: PIN_ID,
        buyerAddress: buyer.address,
        priceSats: MRC721_MIN_SELL_PRICE_SATS,
        feeRate: 1,
        itemInfo: itemInfo(seller),
        orders,
        nowSeconds: 1_700_000_000,
      },
    );
    assert.equal(listing.kind, 'mrc721-atomic-swap');
    const views = await listMrc721MySellOrders(orders, 1, verifyDeps(seller));
    assert.equal(views.length, 1);
    assert.equal(views[0].status, 'valid');

    const stale = recordMrc721Listing(orders, 1, {
      ...listing,
      itemPinId: `${'ef'.repeat(32)}i0`,
    });
    const mixed = await listMrc721MySellOrders(orders, 1, {
      fetchItemInfo: async (pinId) => (pinId === PIN_ID ? itemInfo(seller) : null),
      isOutpointUnspent: async () => true,
      nowSeconds: 1_700_000_100,
    });
    const invalid = mixed.find((view) => view.id === stale.id);
    assert.equal(invalid.status, 'invalid');
    assert.match(invalid.reason, /not in the index/);

    resetMvcSpendSessionStateForTests();
    const { normalFeeSats } = estimateMvc721BuyNormalFee(listing.partialTx, 1);
    const result = await buyMrc721Listing(
      {
        completeBuy: async () => ({
          txId: 'f'.repeat(64),
          spentOutpoints: [`${TXID}:0`, `${'cd'.repeat(32)}:1`],
          feeSats: normalFeeSats,
          feeRateEffective: 1,
        }),
      },
      {
        store,
        metabotId: 2,
        listing,
        feeRate: 1,
        verifyDeps: verifyDeps(seller),
      },
    );
    assert.equal(result.txId, 'f'.repeat(64));
    assert.ok(getMvcSpendSessionSnapshot(2).excludeOutpoints.includes(`${TXID}:0`));
  } finally {
    try { sqliteStore.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle */ }
    resetMvcSpendSessionStateForTests();
  }
});

test('unspent check treats a dust outpoint missing from the wallet list as spent only when a later tx spends it', async () => {
  const seller = keypair();
  const outpoint = { txid: TXID, vout: 0, satoshis: 546 };
  const otherTxid = '11'.repeat(32);
  const spending = new TxComposer();
  spending.appendP2PKHOutput({
    address: new mvc.Address(seller.address, mvc.Networks.livenet),
    satoshis: 546,
  });
  spending.appendP2PKHInput({
    address: new mvc.Address(seller.address, mvc.Networks.livenet),
    txId: TXID,
    outputIndex: 0,
    satoshis: 546,
  });
  const idle = new TxComposer();
  idle.appendP2PKHOutput({
    address: new mvc.Address(seller.address, mvc.Networks.livenet),
    satoshis: 1000,
  });
  idle.appendP2PKHInput({
    address: new mvc.Address(seller.address, mvc.Networks.livenet),
    txId: '22'.repeat(32),
    outputIndex: 0,
    satoshis: 2000,
  });

  function fetchImpl(rawByTxid) {
    return async (url) => {
      const href = String(url);
      const body = href.includes('/utxo-list')
        ? { code: 0, data: { list: [] } }
        : href.includes('/tx-list')
          ? { code: 0, data: { list: [{ txid: otherTxid, flag: 'p1' }] } }
          : { code: 0, data: { hex: rawByTxid[new URL(href).searchParams.get('txId')] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }

  assert.equal(await isMrc721OutpointUnspent({
    address: seller.address,
    outpoint,
    fetchImpl: fetchImpl({ [otherTxid]: idle.getRawHex() }),
  }), true);
  assert.equal(await isMrc721OutpointUnspent({
    address: seller.address,
    outpoint,
    fetchImpl: fetchImpl({ [otherTxid]: spending.getRawHex() }),
  }), false);
  assert.equal(await isMrc721OutpointUnspent({
    address: seller.address,
    outpoint: { ...outpoint, satoshis: 10000 },
    fetchImpl: fetchImpl({ [otherTxid]: idle.getRawHex() }),
  }), false);
});
