/**
 * Seller-side MRC-721 passive open-offer worker. Derives the seller key from
 * the passed mnemonic, signs the item input with SIGHASH_SINGLE|FORKID|
 * ANYONECANPAY over a tx whose output0 IS the price, and returns the signed
 * offer envelope WITHOUT broadcasting — the offer travels into a
 * /protocols/mrc721offer pin, not the mempool.
 *
 * Runs under ELECTRON_RUN_AS_NODE, same as buildMvcTransferRawTxWorker.
 */

import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';
import type { Mrc721Outpoint } from './mrc721AtomicSwapTx';
import { buildMrc721OpenOfferTx } from './mrc721OpenOfferTx';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ success: false, error: message }));
  process.exit(1);
}

async function main(): Promise<void> {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  const pathStr = (process.env.IDBOTS_METABOT_PATH || DEFAULT_PATH).trim();
  if (!mnemonic) {
    fail(new Error('IDBOTS_METABOT_MNEMONIC required'));
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
    priceSats?: number;
    outpoint?: Mrc721Outpoint;
  };
  if (!Number.isInteger(payload.priceSats) || Number(payload.priceSats) <= 0) {
    fail(new Error('priceSats (integer) is required'));
  }
  if (!payload.outpoint?.txid) {
    fail(new Error('outpoint {txid, vout, satoshis} is required'));
  }

  const addressIndex = parseAddressIndexFromPath(pathStr);
  const wallet = await getMvcWallet(mnemonic as string, addressIndex);
  const sellerAddress = wallet.getAddress();
  const built = buildMrc721OpenOfferTx({
    sellerWif: wallet.getPrivateKey(),
    sellerAddress,
    outpoint: payload.outpoint,
    priceSats: Number(payload.priceSats),
  });
  console.log(JSON.stringify({
    success: true,
    offerTx: built.offerTx,
    sigtype: built.sigtype,
    outpoint: built.outpoint,
    priceSats: built.priceSats,
  }));
}

if (require.main === module) {
  main().catch(fail);
}
