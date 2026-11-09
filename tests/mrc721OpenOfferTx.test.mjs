/**
 * Offline round-trips for the MRC-721 passive open offer tx primitives
 * (docs/nft-open-market-psbt-settlement.md). Pure meta-contract TxComposer
 * math — no network, no chain. The core property under test: the seller's
 * SIGHASH_SINGLE|FORKID|ANYONECANPAY signature locks EXACTLY {item outpoint,
 * output0 price}, survives every buyer append, and breaks under any price
 * tampering — so a seller can publish the offer and walk away.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mvc, TxComposer } = require('meta-contract');

const {
  MRC721_OPEN_OFFER_SIGHASH,
  MRC721_OPEN_OFFER_KIND,
  MRC721_OPEN_OFFER_PATH,
  buildMrc721OpenOfferTx,
  decodeMrc721OpenOfferTx,
  completeMrc721OpenOfferTx,
  buildMrc721OpenOfferPayload,
  isMrc721OpenOfferSighash,
} = await import('../dist-electron/main/libs/mrc721OpenOfferTx.js');

const {
  MRC721_ATOMIC_SWAP_SIGHASH,
  MRC721_MIN_SELL_PRICE_SATS,
  sighashTypeOfScript,
  verifySellerSignature,
} = await import('../dist-electron/main/libs/mrc721AtomicSwapTx.js');

const TXID = 'ab'.repeat(32);
const PIN_ID = `${TXID}i0`;
const ITEM_SATS = 546;

function keypair() {
  const key = new mvc.PrivateKey();
  return {
    key,
    wif: key.toWIF(),
    address: key.toAddress('livenet').toString(),
  };
}

function itemOutpoint() {
  return { txid: TXID, vout: 0, satoshis: ITEM_SATS };
}

function buildOffer(seller, priceSats = MRC721_MIN_SELL_PRICE_SATS) {
  return buildMrc721OpenOfferTx({
    sellerWif: seller.wif,
    sellerAddress: seller.address,
    outpoint: itemOutpoint(),
    priceSats,
  });
}

test('the open offer locks the price at output0 with sighash 195 (SINGLE|FORKID|ANYONECANPAY)', () => {
  const seller = keypair();
  const offer = buildOffer(seller);
  // SINGLE = 0x03 | FORKID = 0x40 | ACP = 0x80 → 195. Computed from the lib
  // constants (never guessed) — the byte is now pinned by this test.
  assert.equal(MRC721_OPEN_OFFER_SIGHASH, 195);
  assert.equal(offer.sigtype, 195);
  assert.ok(isMrc721OpenOfferSighash(offer.sigtype));
  assert.ok(!isMrc721OpenOfferSighash(MRC721_ATOMIC_SWAP_SIGHASH), 'the directed swap 193 is NOT an open-offer signature');

  const composer = decodeMrc721OpenOfferTx(offer.offerTx);
  const tx = composer.tx;
  assert.equal(tx.inputs.length, 1);
  assert.equal(tx.inputs[0].prevTxId.toString('hex'), TXID);
  assert.equal(tx.inputs[0].outputIndex, 0);
  assert.equal(tx.outputs.length, 1, 'the offer commits exactly one output: the price');
  assert.equal(tx.outputs[0].script.toAddress('livenet').toString(), seller.address);
  assert.equal(tx.outputs[0].satoshis, MRC721_MIN_SELL_PRICE_SATS);
  assert.equal(sighashTypeOfScript(tx.inputs[0].script), MRC721_OPEN_OFFER_SIGHASH);
});

test('a buyer completes the offer with zero seller cooperation and the seller signature still verifies', () => {
  const seller = keypair();
  const buyer = keypair();
  const offer = buildOffer(seller);
  const paymentTxid = 'cd'.repeat(32);
  const bought = completeMrc721OpenOfferTx({
    offerTx: offer.offerTx,
    outpoint: offer.outpoint,
    sellerAddress: seller.address,
    priceSats: offer.priceSats,
    buyerWif: buyer.wif,
    buyerAddress: buyer.address,
    feeRate: 1,
    utxos: [{
      txId: paymentTxid,
      outputIndex: 1,
      satoshis: offer.priceSats + 400,
      address: buyer.address,
      height: 10,
    }],
  });

  const tx = new mvc.Transaction(bought.txHex);
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 2, 'outputs: [price to seller, delivery to buyer]');
  // outputs[0] is the signed price, untouched.
  assert.equal(tx.outputs[0].script.toAddress('livenet').toString(), seller.address);
  assert.equal(tx.outputs[0].satoshis, MRC721_MIN_SELL_PRICE_SATS);
  // outputs[1] is the DELIVERY output: the item value moves to the buyer (R-E-3 layout).
  assert.equal(tx.outputs[1].script.toAddress('livenet').toString(), buyer.address);
  assert.equal(tx.outputs[1].satoshis, ITEM_SATS);
  assert.equal(bought.feeSats, 400);
  assert.deepEqual(bought.spentOutpoints, [`${TXID}:0`, `${paymentTxid}:1`]);

  // The seller's SINGLE|ACP signature still verifies on the FINAL tx — the
  // seller signed {item outpoint, output0} and nothing else, so the buyer's
  // appends (input 1, output 1) cannot invalidate it.
  const reloaded = new mvc.Transaction(bought.txHex);
  reloaded.inputs[0].output = mvc.Transaction.Output.fromObject({
    script: mvc.Script.buildPublicKeyHashOut(new mvc.Address(seller.address, mvc.Networks.livenet)).toHex(),
    satoshis: ITEM_SATS,
  });
  verifySellerSignature(reloaded, seller.address, ITEM_SATS);
});

test('a lying advertisement cannot move money: tampered price breaks the seller signature', () => {
  const seller = keypair();
  const buyer = keypair();
  const offer = buildOffer(seller);

  // The attacker rewrites output0 (the price) and re-advertises the higher price.
  const composer = decodeMrc721OpenOfferTx(offer.offerTx);
  composer.tx.outputs[0].satoshis = offer.priceSats + 100;
  const attackedOfferTx = Buffer.from(composer.serialize(), 'utf8').toString('base64');

  assert.throws(
    () => completeMrc721OpenOfferTx({
      offerTx: attackedOfferTx,
      outpoint: offer.outpoint,
      sellerAddress: seller.address,
      priceSats: offer.priceSats + 100,
      buyerWif: buyer.wif,
      buyerAddress: buyer.address,
      feeRate: 1,
      utxos: [{ txId: 'cd'.repeat(32), outputIndex: 0, satoshis: offer.priceSats + 1000, address: buyer.address, height: 3 }],
    }),
    /check 2 \(seller signature\)/,
  );
});

test('an offer envelope with more than the price output is refused — the buyer builds everything else', () => {
  const seller = keypair();
  const buyer = keypair();
  const offer = buildOffer(seller);
  const composer = decodeMrc721OpenOfferTx(offer.offerTx);
  composer.appendP2PKHOutput({
    address: new mvc.Address(seller.address, mvc.Networks.livenet),
    satoshis: 1,
  });
  const padded = Buffer.from(composer.serialize(), 'utf8').toString('base64');
  assert.throws(
    () => completeMrc721OpenOfferTx({
      offerTx: padded,
      outpoint: offer.outpoint,
      sellerAddress: seller.address,
      priceSats: offer.priceSats,
      buyerWif: buyer.wif,
      buyerAddress: buyer.address,
      feeRate: 1,
      utxos: [{ txId: 'cd'.repeat(32), outputIndex: 0, satoshis: offer.priceSats + 1000, address: buyer.address, height: 3 }],
    }),
    /check 1 \(outputs\)/,
  );
});

test('an ALL|ACP re-sign masquerading as an open offer is refused (it would commit unknown outputs)', () => {
  const seller = keypair();
  const buyer = keypair();
  const offer = buildOffer(seller);
  const composer = decodeMrc721OpenOfferTx(offer.offerTx);
  composer.unlockP2PKHInput(seller.key, 0, MRC721_ATOMIC_SWAP_SIGHASH);
  const masquerade = Buffer.from(composer.serialize(), 'utf8').toString('base64');
  assert.throws(
    () => completeMrc721OpenOfferTx({
      offerTx: masquerade,
      outpoint: offer.outpoint,
      sellerAddress: seller.address,
      priceSats: offer.priceSats,
      buyerWif: buyer.wif,
      buyerAddress: buyer.address,
      feeRate: 1,
      utxos: [{ txId: 'cd'.repeat(32), outputIndex: 0, satoshis: offer.priceSats + 1000, address: buyer.address, height: 3 }],
    }),
    /check 1 \(sigtype\)/,
  );
});

test('price floor and key/address mismatch refuse before anything is signed', () => {
  const seller = keypair();
  assert.throws(
    () => buildMrc721OpenOfferTx({
      sellerWif: seller.wif,
      sellerAddress: seller.address,
      outpoint: itemOutpoint(),
      priceSats: MRC721_MIN_SELL_PRICE_SATS - 1,
    }),
    /22000/,
  );
  const stranger = keypair();
  assert.throws(
    () => buildMrc721OpenOfferTx({
      sellerWif: seller.wif,
      sellerAddress: stranger.address,
      outpoint: itemOutpoint(),
      priceSats: MRC721_MIN_SELL_PRICE_SATS,
    }),
    /does not match sellerAddress/,
  );
});

test('a large funding UTXO pays with change; the seller signature survives the change output', () => {
  const seller = keypair();
  const buyer = keypair();
  const offer = buildOffer(seller);
  const funding = offer.priceSats + 50_000;
  const bought = completeMrc721OpenOfferTx({
    offerTx: offer.offerTx,
    outpoint: offer.outpoint,
    sellerAddress: seller.address,
    priceSats: offer.priceSats,
    buyerWif: buyer.wif,
    buyerAddress: buyer.address,
    feeRate: 1,
    utxos: [{ txId: '11'.repeat(32), outputIndex: 0, satoshis: funding, address: buyer.address, height: 3 }],
  });
  const tx = new mvc.Transaction(bought.txHex);
  assert.equal(tx.outputs.length, 3, 'outputs: [price → seller, delivery → buyer, change → buyer]');
  assert.equal(tx.outputs[0].satoshis, offer.priceSats);
  assert.equal(tx.outputs[1].satoshis, ITEM_SATS);
  assert.equal(tx.outputs[2].script.toAddress('livenet').toString(), buyer.address);
  assert.equal(tx.outputs[2].satoshis, bought.changeSats);
  assert.equal(bought.feeSats + bought.changeSats + offer.priceSats, funding, 'value conserved: funding = price + fee + change');
  assert.ok(bought.feeSats > 0 && bought.feeSats < 1000, `fee stays normal (${bought.feeSats})`);
  tx.inputs[0].output = mvc.Transaction.Output.fromObject({
    script: mvc.Script.buildPublicKeyHashOut(new mvc.Address(seller.address, mvc.Networks.livenet)).toHex(),
    satoshis: ITEM_SATS,
  });
  verifySellerSignature(tx, seller.address, ITEM_SATS);
});

test('several small UTXOs are combined when no single one covers the price', () => {
  const seller = keypair();
  const buyer = keypair();
  const offer = buildOffer(seller);
  const bought = completeMrc721OpenOfferTx({
    offerTx: offer.offerTx,
    outpoint: offer.outpoint,
    sellerAddress: seller.address,
    priceSats: offer.priceSats,
    buyerWif: buyer.wif,
    buyerAddress: buyer.address,
    feeRate: 1,
    utxos: [
      { txId: '31'.repeat(32), outputIndex: 0, satoshis: 9_000, address: buyer.address, height: 3 },
      { txId: '32'.repeat(32), outputIndex: 0, satoshis: 9_000, address: buyer.address, height: 3 },
      { txId: '33'.repeat(32), outputIndex: 0, satoshis: 9_000, address: buyer.address, height: 3 },
    ],
  });
  const tx = new mvc.Transaction(bought.txHex);
  assert.equal(tx.inputs.length, 4, 'item input + three funding inputs');
  assert.equal(bought.spentOutpoints.length, 4);
  assert.equal(bought.feeSats + bought.changeSats + offer.priceSats, 27_000);
});

test('dust-sized change folds into a bounded fee, and an empty wallet refuses before signing', () => {
  const seller = keypair();
  const buyer = keypair();
  const offer = buildOffer(seller);
  const base = {
    offerTx: offer.offerTx,
    outpoint: offer.outpoint,
    sellerAddress: seller.address,
    priceSats: offer.priceSats,
    buyerWif: buyer.wif,
    buyerAddress: buyer.address,
    feeRate: 1,
  };
  // 22000 + 700: covers price + normal fee, leftover too small for a visible change output.
  const tight = completeMrc721OpenOfferTx({
    ...base,
    utxos: [{ txId: '41'.repeat(32), outputIndex: 0, satoshis: offer.priceSats + 700, address: buyer.address, height: 3 }],
  });
  assert.equal(tight.changeSats, 0);
  assert.equal(tight.feeSats, 700);
  assert.equal(new mvc.Transaction(tight.txHex).outputs.length, 2);
  assert.throws(
    () => completeMrc721OpenOfferTx({
      ...base,
      utxos: [{ txId: '22'.repeat(32), outputIndex: 0, satoshis: 1000, address: buyer.address, height: 3 }],
    }),
    /Not enough MVC balance[\s\S]*Nothing was signed/,
  );
});

test('the offer pin payload mirrors the signed price and validates the item pinId', () => {
  const seller = keypair();
  const offer = buildOffer(seller, 30_000);
  const payload = buildMrc721OpenOfferPayload({
    itemPinId: PIN_ID,
    priceSats: 30_000,
    offerTx: offer.offerTx,
  });
  assert.deepEqual(payload, {
    itemPinId: PIN_ID,
    priceSats: 30_000,
    offerTx: offer.offerTx,
    active: true,
  });
  // The payload's offerTx decodes back to the signed offer — round-trip.
  const composer = decodeMrc721OpenOfferTx(payload.offerTx);
  assert.equal(composer.tx.outputs[0].satoshis, 30_000);
  assert.throws(() => buildMrc721OpenOfferPayload({ itemPinId: 'not-a-pin', priceSats: 1, offerTx: offer.offerTx }), /itemPinId/);
  assert.throws(() => buildMrc721OpenOfferPayload({ itemPinId: PIN_ID, priceSats: 0, offerTx: offer.offerTx }), /priceSats/);
  assert.throws(() => buildMrc721OpenOfferPayload({ itemPinId: PIN_ID, priceSats: 1, offerTx: '' }), /offerTx/);
});

test('the seller signature survives arbitrary buyer-appended outputs (committed to nothing else)', () => {
  const seller = keypair();
  const buyer = keypair();
  const offer = buildOffer(seller);
  const composer = decodeMrc721OpenOfferTx(offer.offerTx);
  // The buyer appends ANY outputs — a tip to a stranger, whatever: the seller
  // has signed only {input0, output0}, so these cannot invalidate it.
  composer.appendP2PKHOutput({
    address: new mvc.Address(buyer.address, mvc.Networks.livenet),
    satoshis: ITEM_SATS,
  });
  composer.appendP2PKHOutput({
    address: new mvc.Address(buyer.address, mvc.Networks.livenet),
    satoshis: 999,
  });
  composer.appendP2PKHInput({
    address: new mvc.Address(buyer.address, mvc.Networks.livenet),
    txId: 'cd'.repeat(32),
    outputIndex: 0,
    satoshis: offer.priceSats + 2000,
  });
  // Hydrate the buyer prevout so the interpreter can verify input 0.
  const itemPrev = composer.tx.inputs[0];
  if (!itemPrev.output) {
    itemPrev.output = mvc.Transaction.Output.fromObject({
      script: mvc.Script.buildPublicKeyHashOut(new mvc.Address(seller.address, mvc.Networks.livenet)).toHex(),
      satoshis: ITEM_SATS,
    });
  }
  verifySellerSignature(composer.tx, seller.address, ITEM_SATS);
});
