/**
 * Pure MVC transaction helpers for an MRC-721 atomic swap.
 *
 * Seller signs only input 0 with SIGHASH_ALL|FORKID|ANYONECANPAY so the two
 * outputs stay locked while the buyer may append payment inputs. The buyer
 * worker must not add outputs: SIGHASH_ALL would drop the seller signature.
 * Sighash 193 (1|64|128) is the value mvc.crypto.Signature computes; a live
 * 2-in/2-out smoke confirmed MVC accepts that byte.
 */

import { TxComposer, mvc } from 'meta-contract';
import { P2PKH_INPUT_SIZE, type SpendableMvcUtxo, getUtxoOutpointKey } from './mvcSpend';

const Signature = mvc.crypto.Signature;

/** ALL | FORKID | ANYONECANPAY. Do not hardcode a guessed byte; this is 193. */
export const MRC721_ATOMIC_SWAP_SIGHASH = Signature.SIGHASH_ALL
  | Signature.SIGHASH_FORKID
  | Signature.SIGHASH_ANYONECANPAY;

/** Same floor as MVC_NFT_MIN_SELL_PRICE_SATS in mvcNftService.ts. */
export const MRC721_MIN_SELL_PRICE_SATS = 22000;

/** Buyer fee may not exceed this multiple of the size-based normal fee. */
export const MRC721_MAX_FEE_MULTIPLIER = 3;

export const MRC721_LISTING_VERSION = 1;
export const MRC721_LISTING_KIND = 'mrc721-atomic-swap';

/** Off-chain display window stored on the listing. Not enforced by miners. */
export const MRC721_LISTING_TTL_SECONDS = 24 * 60 * 60;

/**
 * wallet-api v4 utxo-list hides outputs below this. A missing dust NFT
 * outpoint is therefore not proof that it was spent.
 */
export const MRC721_WALLET_UTXO_FLOOR_SATS = 600;

const interpreterFlags = mvc.Script.Interpreter as unknown as Record<string, number>;
const SCRIPT_VERIFY_FLAGS = interpreterFlags.SCRIPT_ENABLE_SIGHASH_FORKID
  | interpreterFlags.SCRIPT_VERIFY_STRICTENC
  | interpreterFlags.SCRIPT_VERIFY_DERSIG
  | interpreterFlags.SCRIPT_VERIFY_LOW_S
  | interpreterFlags.SCRIPT_VERIFY_NULLFAIL
  | interpreterFlags.SCRIPT_VERIFY_SIGPUSHONLY
  | interpreterFlags.SCRIPT_VERIFY_MINIMALDATA
  | interpreterFlags.SCRIPT_VERIFY_CLEANSTACK;

const NETWORK = mvc.Networks.livenet;

export interface Mrc721Outpoint {
  txid: string;
  vout: number;
  satoshis: number;
}

export interface Mrc721AtomicSwapListing {
  version: number;
  kind: typeof MRC721_LISTING_KIND;
  itemPinId: string;
  collectionPinId: string;
  outpoint: Mrc721Outpoint;
  sellerAddress: string;
  buyerAddress: string;
  priceSats: number;
  partialTx: string;
  sigtype: number;
  feeRate: number;
  createdAt: number;
  expiresAt: number;
}

export function mrc721ListingError(check: string, detail: string): Error {
  return new Error(`MRC-721 listing failed ${check}: ${detail}`);
}

export function mrc721PriceFloorError(): Error {
  return new Error(
    `Selling Price must be greater than or equals to ${MRC721_MIN_SELL_PRICE_SATS} satoshis. 销售价格最低为${MRC721_MIN_SELL_PRICE_SATS}聪。`,
  );
}

export function normalizeMrc721Outpoint(input: unknown): Mrc721Outpoint {
  const record = (input ?? {}) as Record<string, unknown>;
  const txid = String(record.txid ?? '').trim().toLowerCase();
  const vout = Number(record.vout);
  const satoshis = Number(record.satoshis);
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw mrc721ListingError('check 1 (outpoint)', 'listing outpoint.txid must be 64 hex characters');
  }
  if (!Number.isInteger(vout) || vout < 0) {
    throw mrc721ListingError('check 1 (outpoint)', 'listing outpoint.vout must be an integer >= 0');
  }
  if (!Number.isInteger(satoshis) || satoshis <= 0) {
    throw mrc721ListingError('check 1 (outpoint)', 'listing outpoint.satoshis must be a positive integer (the NFT output value)');
  }
  return { txid, vout, satoshis };
}

export function outpointKey(outpoint: Pick<Mrc721Outpoint, 'txid' | 'vout'>): string {
  return `${outpoint.txid.toLowerCase()}:${outpoint.vout}`;
}

function addressOf(value: string): mvc.Address {
  return new mvc.Address(value, NETWORK as never);
}

function outputAddress(output: mvc.Transaction.Output): string {
  try {
    return output.script.toAddress('livenet').toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw mrc721ListingError(
      'check 1 (outputs)',
      `an output is not a standard P2PKH script (${message}). The atomic swap only pays the NFT to the buyer and the price to the seller.`,
    );
  }
}

export function sighashTypeOfScript(script: mvc.Script): number {
  const buf = script?.chunks?.[0]?.buf as Buffer | undefined;
  if (!buf || buf.length < 2) {
    throw mrc721ListingError(
      'check 1 (sigtype)',
      'input 0 has no P2PKH signature. The seller must sign the NFT input before handing over the listing.',
    );
  }
  return buf[buf.length - 1];
}

/** Base type ALL, plus the FORKID and ANYONECANPAY bits. Rejects SINGLE variants. */
export function isAtomicSwapSighash(sigtype: number): boolean {
  const base = sigtype & 0x1f;
  return base === Signature.SIGHASH_ALL
    && (sigtype & Signature.SIGHASH_FORKID) !== 0
    && (sigtype & Signature.SIGHASH_ANYONECANPAY) !== 0;
}

export function loadPartialComposer(partialTx: string): TxComposer {
  let composer: TxComposer;
  try {
    composer = TxComposer.deserialize(partialTx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw mrc721ListingError(
      'check 1 (partial tx)',
      `TxComposer could not parse partialTx (${message}). Ask the seller for a fresh listing.`,
    );
  }
  let parsed: { txPrevOutputs?: Array<Record<string, unknown> | null> };
  try {
    parsed = JSON.parse(partialTx) as { txPrevOutputs?: Array<Record<string, unknown> | null> };
  } catch {
    throw mrc721ListingError('check 1 (partial tx)', 'partialTx is not the JSON envelope TxComposer.serialize() returns');
  }
  composer.tx.inputs.forEach((input, index) => {
    if (!input.output && parsed.txPrevOutputs?.[index]) {
      input.output = new mvc.Transaction.Output(parsed.txPrevOutputs[index] as never);
    }
  });
  return composer;
}

function assertSellerPrevout(
  input: mvc.Transaction.Input,
  sellerAddress: string,
  satoshis: number,
): void {
  if (!input.output) {
    throw mrc721ListingError(
      'check 2 (seller signature)',
      'input 0 is missing its declared prevout, so the seller signature cannot be checked',
    );
  }
  const prevoutAddress = outputAddress(input.output);
  if (prevoutAddress !== sellerAddress) {
    throw mrc721ListingError(
      'check 2 (seller signature)',
      `input 0 prevout pays ${prevoutAddress}, not the declared seller ${sellerAddress}`,
    );
  }
  if (Number(input.output.satoshis) !== satoshis) {
    throw mrc721ListingError(
      'check 2 (seller signature)',
      `input 0 prevout has ${input.output.satoshis} sats, not the declared NFT value ${satoshis}`,
    );
  }
}

export function verifySellerSignature(tx: mvc.Transaction, sellerAddress: string, satoshis: number): void {
  const input = tx.inputs[0];
  if (!input) {
    throw mrc721ListingError('check 2 (seller signature)', 'partial tx has no input 0');
  }
  assertSellerPrevout(input, sellerAddress, satoshis);
  let ok = false;
  try {
    const interpreter = new mvc.Script.Interpreter();
    ok = interpreter.verify(
      input.script,
      input.output.script,
      tx,
      0,
      SCRIPT_VERIFY_FLAGS,
      input.output.satoshisBN,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw mrc721ListingError(
      'check 2 (seller signature)',
      `the seller signature did not verify (${message}). The listing was tampered with or built for a different output.`,
    );
  }
  if (!ok) {
    throw mrc721ListingError(
      'check 2 (seller signature)',
      'the seller signature does not verify against the declared prevout. Changing either output, or using a SIGHASH_SINGLE variant, makes this signature fail — ask the seller to rebuild the listing.',
    );
  }
}

/**
 * Check 1 of the buy-side audit: input 0 is the NFT, output 0 pays the buyer
 * the NFT value, output 1 pays the seller the price, and nothing else exists.
 */
export function assertPartialTxShape(params: {
  composer: TxComposer;
  outpoint: Mrc721Outpoint;
  buyerAddress: string;
  sellerAddress: string;
  priceSats: number;
}): void {
  const { composer, outpoint, buyerAddress, sellerAddress, priceSats } = params;
  const tx = composer.tx;
  if (tx.inputs.length !== 1) {
    throw mrc721ListingError(
      'check 1 (inputs)',
      `partial tx has ${tx.inputs.length} inputs; the seller listing must contain only the NFT input so the buyer can append payment`,
    );
  }
  const input = tx.inputs[0];
  const prevTxId = input.prevTxId.toString('hex').toLowerCase();
  if (prevTxId !== outpoint.txid || Number(input.outputIndex) !== outpoint.vout) {
    throw mrc721ListingError(
      'check 1 (inputs)',
      `input 0 spends ${prevTxId}:${input.outputIndex}, not the listing outpoint ${outpointKey(outpoint)}. The indexer attributes the NFT from input 0.`,
    );
  }
  if (tx.outputs.length !== 2) {
    throw mrc721ListingError(
      'check 1 (outputs)',
      `partial tx has ${tx.outputs.length} outputs; an atomic swap has exactly two: output 0 NFT to the buyer, output 1 price to the seller. Extra outputs are not covered by a safe listing.`,
    );
  }
  const nftAddress = outputAddress(tx.outputs[0]);
  if (nftAddress !== buyerAddress || Number(tx.outputs[0].satoshis) !== outpoint.satoshis) {
    throw mrc721ListingError(
      'check 1 (outputs)',
      `output 0 is ${tx.outputs[0].satoshis} sats to ${nftAddress}; it must be ${outpoint.satoshis} sats to the buyer ${buyerAddress}. The indexer reads the new owner from output 0.`,
    );
  }
  const priceAddress = outputAddress(tx.outputs[1]);
  if (priceAddress !== sellerAddress || Number(tx.outputs[1].satoshis) !== priceSats) {
    throw mrc721ListingError(
      'check 1 (outputs)',
      `output 1 is ${tx.outputs[1].satoshis} sats to ${priceAddress}; it must be ${priceSats} sats to the seller ${sellerAddress}. A listing that does not pay the seller is refused.`,
    );
  }
  const sigtype = sighashTypeOfScript(input.script);
  if (!isAtomicSwapSighash(sigtype)) {
    throw mrc721ListingError(
      'check 1 (sigtype)',
      `input 0 is signed with sighash ${sigtype}, which is not SIGHASH_ALL|FORKID|ANYONECANPAY (${MRC721_ATOMIC_SWAP_SIGHASH}). SIGHASH_SINGLE leaves the price output unprotected, so this listing is refused.`,
    );
  }
}

export function buildMvc721SellPartialTx(params: {
  sellerWif: string;
  sellerAddress: string;
  buyerAddress: string;
  outpoint: Mrc721Outpoint;
  priceSats: number;
}): { partialTx: string; sigtype: number } {
  if (!Number.isInteger(params.priceSats) || params.priceSats < MRC721_MIN_SELL_PRICE_SATS) {
    throw mrc721PriceFloorError();
  }
  const outpoint = normalizeMrc721Outpoint(params.outpoint);
  const seller = addressOf(params.sellerAddress);
  const buyer = addressOf(params.buyerAddress);
  const privateKey = mvc.PrivateKey.fromWIF(params.sellerWif);
  if (privateKey.toAddress('livenet').toString() !== params.sellerAddress) {
    throw new Error('seller private key does not match sellerAddress');
  }

  const composer = new TxComposer();
  composer.appendP2PKHOutput({ address: buyer, satoshis: outpoint.satoshis });
  composer.appendP2PKHOutput({ address: seller, satoshis: params.priceSats });
  composer.appendP2PKHInput({
    address: seller,
    txId: outpoint.txid,
    outputIndex: outpoint.vout,
    satoshis: outpoint.satoshis,
  });
  composer.unlockP2PKHInput(privateKey, 0, MRC721_ATOMIC_SWAP_SIGHASH);
  assertPartialTxShape({
    composer,
    outpoint,
    buyerAddress: params.buyerAddress,
    sellerAddress: params.sellerAddress,
    priceSats: params.priceSats,
  });
  verifySellerSignature(composer.tx, params.sellerAddress, outpoint.satoshis);
  return {
    partialTx: composer.serialize(),
    sigtype: MRC721_ATOMIC_SWAP_SIGHASH,
  };
}

export function estimateMvc721BuyNormalFee(partialTx: string, feeRate: number): { normalFeeSats: number; estimatedSize: number } {
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error('feeRate must be a positive number');
  }
  const composer = loadPartialComposer(partialTx);
  const estimatedSize = Math.ceil(composer.getRawHex().length / 2) + P2PKH_INPUT_SIZE;
  return {
    estimatedSize,
    normalFeeSats: Math.ceil(estimatedSize * feeRate),
  };
}

/**
 * Smallest single UTXO that covers price + normal fee, rejecting a coin whose
 * leftover (the whole miner fee, since there is no change output) is more than
 * 3× that normal fee. Throws before the caller signs.
 */
export function pickMvc721PaymentUtxo(params: {
  utxos: SpendableMvcUtxo[];
  priceSats: number;
  normalFeeSats: number;
  excludedOutpoints?: ReadonlySet<string>;
}): SpendableMvcUtxo {
  const excluded = params.excludedOutpoints ?? new Set<string>();
  const ordered = params.utxos
    .filter((utxo) => !excluded.has(getUtxoOutpointKey(utxo).toLowerCase()) && utxo.satoshis > MRC721_WALLET_UTXO_FLOOR_SATS)
    .slice()
    .sort((left, right) => left.satoshis - right.satoshis || left.outputIndex - right.outputIndex);
  const required = params.priceSats + params.normalFeeSats;
  const pick = ordered.find((utxo) => utxo.satoshis >= required);
  if (!pick) {
    throw new Error(
      `Not enough MVC balance to pay ${params.priceSats} sats plus about ${params.normalFeeSats} sats of fee. `
      + 'This purchase spends one UTXO and does not add a change output, so nothing was signed. '
      + 'Fund the buyer wallet with a single UTXO just above the price, then retry.',
    );
  }
  const feeSats = pick.satoshis - params.priceSats;
  const ceiling = params.normalFeeSats * MRC721_MAX_FEE_MULTIPLIER;
  if (feeSats > ceiling) {
    throw new Error(
      `The smallest UTXO that can pay this listing (${pick.satoshis} sats at ${pick.txId}:${pick.outputIndex}) `
      + `would leave ${feeSats} sats as the miner fee, more than ${MRC721_MAX_FEE_MULTIPLIER}× the normal fee (${params.normalFeeSats} sats). `
      + 'There is no change output, so the extra would be spent. Nothing was signed — split a smaller UTXO and retry.',
    );
  }
  return pick;
}

export function completeMvc721BuyTxLocally(params: {
  partialTx: string;
  buyerWif: string;
  buyerAddress: string;
  sellerAddress: string;
  priceSats: number;
  outpoint: Mrc721Outpoint;
  feeRate: number;
  utxos: SpendableMvcUtxo[];
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
  const composer = loadPartialComposer(params.partialTx);
  assertPartialTxShape({
    composer,
    outpoint,
    buyerAddress: params.buyerAddress,
    sellerAddress: params.sellerAddress,
    priceSats: params.priceSats,
  });
  verifySellerSignature(composer.tx, params.sellerAddress, outpoint.satoshis);

  const outputCountBefore = composer.tx.outputs.length;
  const { normalFeeSats } = estimateMvc721BuyNormalFee(params.partialTx, params.feeRate);
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
    address: addressOf(params.buyerAddress),
    txId: payment.txId,
    outputIndex: payment.outputIndex,
    satoshis: payment.satoshis,
  });
  if (composer.tx.outputs.length !== outputCountBefore) {
    throw new Error('buy path added an output; SIGHASH_ALL seller signatures would break');
  }
  composer.unlockP2PKHInput(buyerKey, inputIndex);
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

export function buildMrc721AtomicSwapListing(params: {
  itemPinId: string;
  collectionPinId?: string;
  outpoint: Mrc721Outpoint;
  sellerAddress: string;
  buyerAddress: string;
  priceSats: number;
  partialTx: string;
  sigtype: number;
  feeRate: number;
  nowSeconds?: number;
}): Mrc721AtomicSwapListing {
  if (params.sigtype !== MRC721_ATOMIC_SWAP_SIGHASH) {
    throw mrc721ListingError(
      'check 1 (sigtype)',
      `listing sigtype ${params.sigtype} is not ${MRC721_ATOMIC_SWAP_SIGHASH}`,
    );
  }
  if (!Number.isFinite(params.feeRate) || params.feeRate <= 0) {
    throw new Error('feeRate must be a positive number');
  }
  const createdAt = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    version: MRC721_LISTING_VERSION,
    kind: MRC721_LISTING_KIND,
    itemPinId: params.itemPinId,
    collectionPinId: params.collectionPinId ?? '',
    outpoint: normalizeMrc721Outpoint(params.outpoint),
    sellerAddress: params.sellerAddress,
    buyerAddress: params.buyerAddress,
    priceSats: params.priceSats,
    partialTx: params.partialTx,
    sigtype: params.sigtype,
    feeRate: params.feeRate,
    createdAt,
    expiresAt: createdAt + MRC721_LISTING_TTL_SECONDS,
  };
}
