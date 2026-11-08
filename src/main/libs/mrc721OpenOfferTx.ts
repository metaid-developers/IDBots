/**
 * Pure MVC transaction helpers for the MRC-721 PASSIVE open offer
 * (docs/nft-open-market-psbt-settlement.md — owner decision 2026-11-08).
 *
 * The seller signs the item input with SIGHASH_SINGLE|FORKID|ANYONECANPAY
 * over a tx whose output0 IS the price output. SIGHASH_SINGLE commits
 * exactly {input0 outpoint, output0} — the price is cryptographically
 * locked and the seller has committed to nothing else. The signed tx is
 * wrapped in a /protocols/mrc721offer pin; ANY buyer completes it offline:
 * append outputs[1] = the delivery output (item value to the buyer), append
 * their funding input(s), sign, broadcast. No seller cooperation, no
 * covenant, no counterparty risk in either direction.
 *
 * Layout note (the deliberate mirror of the directed swap): the directed
 * flow puts the delivery at output0 and the price at output1; the open
 * offer puts the PRICE at output0 (the SINGLE-paired output) and the buyer
 * appends the delivery at output1. Indexer rule R-E-3
 * (docs/nft-offer-indexer-requirements.md) reads the new owner from output1
 * in this layout.
 *
 * Sighash bytes follow the house rule: computed from mvc.crypto.Signature
 * constants and asserted in tests, never guessed (the directed swap's 193
 * was live-smoked; 194 = SINGLE|FORKID|ANYONECANPAY is exercised offline
 * here end-to-end).
 */

import { TxComposer, mvc } from 'meta-contract';
import { P2PKH_INPUT_SIZE, type SpendableMvcUtxo, getUtxoOutpointKey } from './mvcSpend';
import {
  MRC721_ATOMIC_SWAP_SIGHASH,
  MRC721_MAX_FEE_MULTIPLIER,
  MRC721_MIN_SELL_PRICE_SATS,
  MRC721_WALLET_UTXO_FLOOR_SATS,
  loadPartialComposer,
  mrc721ListingError,
  normalizeMrc721Outpoint,
  outpointKey,
  pickMvc721PaymentUtxo,
  sighashTypeOfScript,
  verifySellerSignature,
  type Mrc721Outpoint,
} from './mrc721AtomicSwapTx';

const Signature = mvc.crypto.Signature;

/** SINGLE | FORKID | ANYONECANPAY = 195 (SINGLE=0x03 | FORKID=0x40 | ACP=0x80).
 *  Computed from constants, pinned by tests — never guessed. */
export const MRC721_OPEN_OFFER_SIGHASH = Signature.SIGHASH_SINGLE
  | Signature.SIGHASH_FORKID
  | Signature.SIGHASH_ANYONECANPAY;

export const MRC721_OPEN_OFFER_VERSION = 1;
export const MRC721_OPEN_OFFER_KIND = 'mrc721-open-offer';
export const MRC721_OPEN_OFFER_PATH = '/protocols/mrc721offer';

/** Same pin shape as mrc721Service.isMrc721PinId: `<64-hex txid>i<index>`. */
const MRC721_PIN_ID_LOCAL_RE = /^[0-9a-f]{64}i\d+$/;

/** Rough serialized size of one P2PKH output (8-byte value + 25-byte script + varints). */
const P2PKH_OUTPUT_SIZE = 34;

export interface Mrc721OpenOfferTx {
  /** base64(TxComposer.serialize()) — the signed offer, buyer-decodable offline. */
  offerTx: string;
  sigtype: number;
  outpoint: Mrc721Outpoint;
  priceSats: number;
}

/** Base type SINGLE, plus the FORKID and ANYONECANPAY bits. */
export function isMrc721OpenOfferSighash(sigtype: number): boolean {
  const base = sigtype & 0x1f;
  return base === Signature.SIGHASH_SINGLE
    && (sigtype & Signature.SIGHASH_FORKID) !== 0
    && (sigtype & Signature.SIGHASH_ANYONECANPAY) !== 0;
}

function addressOf(value: string): mvc.Address {
  return new mvc.Address(value, mvc.Networks.livenet as never);
}

export function encodeMrc721OpenOfferTx(composer: TxComposer): string {
  return Buffer.from(composer.serialize(), 'utf8').toString('base64');
}

export function decodeMrc721OpenOfferTx(offerTxB64: string): TxComposer {
  let json: string;
  try {
    json = Buffer.from(String(offerTxB64 ?? ''), 'base64').toString('utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw mrc721ListingError('check 1 (offer tx)', `offerTx is not valid base64 (${message})`);
  }
  try {
    return loadPartialComposer(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw mrc721ListingError('check 1 (offer tx)', `offerTx does not deserialize (${message})`);
  }
}

/**
 * The offer tx commits exactly one input (the item, carrying the SINGLE
 * signature) and exactly one output (the price to the seller). Anything
 * else in the envelope is refused: the buyer builds every other output.
 */
export function assertMrc721OpenOfferShape(params: {
  composer: TxComposer;
  outpoint: Mrc721Outpoint;
  sellerAddress: string;
  priceSats: number;
}): void {
  const { composer, outpoint, sellerAddress, priceSats } = params;
  const tx = composer.tx;
  if (tx.inputs.length !== 1) {
    throw mrc721ListingError(
      'check 1 (inputs)',
      `offer tx has ${tx.inputs.length} inputs; an open offer contains only the item input`,
    );
  }
  const input = tx.inputs[0];
  const prevTxId = input.prevTxId.toString('hex').toLowerCase();
  if (prevTxId !== outpoint.txid || Number(input.outputIndex) !== outpoint.vout) {
    throw mrc721ListingError(
      'check 1 (inputs)',
      `input 0 spends ${prevTxId}:${input.outputIndex}, not the item outpoint ${outpointKey(outpoint)}`,
    );
  }
  if (tx.outputs.length !== 1) {
    throw mrc721ListingError(
      'check 1 (outputs)',
      `offer tx has ${tx.outputs.length} outputs; it must commit exactly one — the price at output 0. The buyer appends the delivery output and funding.`,
    );
  }
  let priceAddress: string;
  try {
    priceAddress = tx.outputs[0].script.toAddress('livenet').toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw mrc721ListingError('check 1 (outputs)', `output 0 is not a standard P2PKH script (${message})`);
  }
  if (priceAddress !== sellerAddress || Number(tx.outputs[0].satoshis) !== priceSats) {
    throw mrc721ListingError(
      'check 1 (outputs)',
      `output 0 is ${tx.outputs[0].satoshis} sats to ${priceAddress}; the offer must pay ${priceSats} sats to the seller ${sellerAddress}`,
    );
  }
  const sigtype = sighashTypeOfScript(input.script);
  if (!isMrc721OpenOfferSighash(sigtype)) {
    throw mrc721ListingError(
      'check 1 (sigtype)',
      `input 0 is signed with sighash ${sigtype}, not SIGHASH_SINGLE|FORKID|ANYONECANPAY (${MRC721_OPEN_OFFER_SIGHASH}). An ALL-signed tx would commit unknown future outputs, so it is not a valid open offer.`,
    );
  }
}

/**
 * Build the signed passive offer. Offline: pure tx math, no network.
 */
export function buildMrc721OpenOfferTx(params: {
  sellerWif: string;
  sellerAddress: string;
  outpoint: Mrc721Outpoint;
  priceSats: number;
}): Mrc721OpenOfferTx {
  if (!Number.isInteger(params.priceSats) || params.priceSats < MRC721_MIN_SELL_PRICE_SATS) {
    throw mrc721ListingError(
      'check 1 (price)',
      `open offer price ${params.priceSats} is below the ${MRC721_MIN_SELL_PRICE_SATS}-sat floor`,
    );
  }
  const outpoint = normalizeMrc721Outpoint(params.outpoint);
  const seller = addressOf(params.sellerAddress);
  const privateKey = mvc.PrivateKey.fromWIF(params.sellerWif);
  if (privateKey.toAddress('livenet').toString() !== params.sellerAddress) {
    throw new Error('seller private key does not match sellerAddress');
  }

  const composer = new TxComposer();
  // output 0 = the price: the SIGHASH_SINGLE-paired output, committed by the signature.
  composer.appendP2PKHOutput({ address: seller, satoshis: params.priceSats });
  composer.appendP2PKHInput({
    address: seller,
    txId: outpoint.txid,
    outputIndex: outpoint.vout,
    satoshis: outpoint.satoshis,
  });
  composer.unlockP2PKHInput(privateKey, 0, MRC721_OPEN_OFFER_SIGHASH);

  assertMrc721OpenOfferShape({
    composer,
    outpoint,
    sellerAddress: params.sellerAddress,
    priceSats: params.priceSats,
  });
  verifySellerSignature(composer.tx, params.sellerAddress, outpoint.satoshis);
  return {
    offerTx: encodeMrc721OpenOfferTx(composer),
    sigtype: MRC721_OPEN_OFFER_SIGHASH,
    outpoint,
    priceSats: params.priceSats,
  };
}

/**
 * The /protocols/mrc721offer pin payload (docs §4): minimal, no
 * protocol/version fields (the pin tuple carries them), no contact fields
 * (the pin creator is the seller identity). priceSats is a mirror — the
 * authority is output0 inside offerTx.
 */
export function buildMrc721OpenOfferPayload(params: {
  itemPinId: string;
  priceSats: number;
  offerTx: string;
  active?: boolean;
}): { itemPinId: string; priceSats: number; offerTx: string; active: boolean } {
  const itemPinId = String(params.itemPinId ?? '').trim().toLowerCase();
  if (!MRC721_PIN_ID_LOCAL_RE.test(itemPinId)) {
    throw new Error(`itemPinId "${params.itemPinId}" is not a valid MRC-721 item pinId (64-hex txid + "i" + output index)`);
  }
  if (!Number.isInteger(params.priceSats) || params.priceSats <= 0) {
    throw new Error('priceSats must be a positive integer');
  }
  if (!params.offerTx || typeof params.offerTx !== 'string') {
    throw new Error('offerTx (base64 signed offer) is required');
  }
  return {
    itemPinId,
    priceSats: params.priceSats,
    offerTx: params.offerTx,
    active: params.active !== false,
  };
}

/**
 * Complete a passive offer offline: verify the seller's locked price, append
 * the delivery output at index 1 (item value to the buyer) and the funding
 * input, sign, and produce the broadcast-ready tx. No network, no seller.
 */
export function completeMrc721OpenOfferTx(params: {
  offerTx: string;
  outpoint: Mrc721Outpoint;
  sellerAddress: string;
  priceSats: number;
  buyerWif: string;
  buyerAddress: string;
  utxos: SpendableMvcUtxo[];
  feeRate: number;
  excludedOutpoints?: ReadonlySet<string>;
}): {
  txHex: string;
  txId: string;
  spentOutpoints: string[];
  feeSats: number;
  feeRateEffective: number;
  normalFeeSats: number;
} {
  const outpoint = normalizeMrc721Outpoint(params.outpoint);
  const composer = decodeMrc721OpenOfferTx(params.offerTx);
  assertMrc721OpenOfferShape({
    composer,
    outpoint,
    sellerAddress: params.sellerAddress,
    priceSats: params.priceSats,
  });
  // The heart of the design: the seller signature binds {item outpoint, output0
  // price}. It is verified against the DECLARED price/outpoint here and re-
  // verified after every buyer append below — any tampering breaks it.
  verifySellerSignature(composer.tx, params.sellerAddress, outpoint.satoshis);

  // Delivery output at index 1 (R-E-3 layout): the item value moves to the buyer.
  const buyer = addressOf(params.buyerAddress);
  composer.appendP2PKHOutput({ address: buyer, satoshis: outpoint.satoshis });

  // Fee estimate AFTER the delivery output exists; the buyer input is not yet
  // unlocked, so add one P2PKH input size. The item value is value-neutral for
  // the buyer (input itemValue → output itemValue), so the buyer's net outlay
  // is price + fee — the same pickMvc721PaymentUtxo economics as the directed swap.
  const estimatedSize = Math.ceil(composer.getRawHex().length / 2) + P2PKH_INPUT_SIZE;
  const normalFeeSats = Math.ceil(estimatedSize * params.feeRate);
  const excludedOutpoints = new Set(params.excludedOutpoints ?? []);
  excludedOutpoints.add(outpointKey(outpoint));
  const payment = pickMvc721PaymentUtxo({
    utxos: params.utxos,
    priceSats: params.priceSats,
    normalFeeSats,
    excludedOutpoints,
  });

  const buyerKey = mvc.PrivateKey.fromWIF(params.buyerWif);
  if (buyerKey.toAddress('livenet').toString() !== params.buyerAddress) {
    throw new Error('buyer private key does not match buyerAddress');
  }
  const inputIndex = composer.appendP2PKHInput({
    address: buyer,
    txId: payment.txId,
    outputIndex: payment.outputIndex,
    satoshis: payment.satoshis,
  });
  composer.unlockP2PKHInput(buyerKey, inputIndex);

  // The seller signature must STILL verify after the buyer appended an input
  // and the delivery output — the SINGLE|ACP digest covers neither. If this
  // ever fails, the offer was not what it claimed.
  verifySellerSignature(composer.tx, params.sellerAddress, outpoint.satoshis);

  const txHex = composer.getRawHex();
  const txId = composer.getTxId();
  const feeSats = payment.satoshis - params.priceSats;
  const size = txHex.length / 2;
  return {
    txHex,
    txId,
    spentOutpoints: [outpointKey(outpoint), getUtxoOutpointKey(payment)],
    feeSats,
    feeRateEffective: size > 0 ? feeSats / size : 0,
    normalFeeSats,
  };
}

/** Re-exported so tool/service layers need only this module for offer flows. */
export { MRC721_ATOMIC_SWAP_SIGHASH, MRC721_MAX_FEE_MULTIPLIER, MRC721_WALLET_UTXO_FLOOR_SATS };
