/**
 * Buyer-side MRC-721 passive open-offer worker. Verifies the seller's
 * SINGLE-signed offer against the live holder view (the price output is the
 * seller's only commitment — SIGHASH_SINGLE|FORKID|ANYONECANPAY), appends the
 * delivery output at index 1 and one funding input, signs, re-verifies, and
 * broadcasts. NO seller cooperation anywhere.
 *
 * Runs under ELECTRON_RUN_AS_NODE, same as completeMvc721BuyTxWorker.
 */

import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';
import { broadcastMvcTx, fetchMrc721ItemInfo } from '../services/mrc721Service';
import { isMrc721OutpointUnspent } from '../services/mrc721AtomicSwapService';
import type { SpendableMvcUtxo } from './mvcSpend';
import {
  completeMrc721OpenOfferTx,
  decodeMrc721OpenOfferTx,
} from './mrc721OpenOfferTx';
import { verifyMrc721OpenOffer } from '../services/mrc721OpenOfferService';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ success: false, error: message }));
  process.exit(1);
}

async function fetchPaymentUtxos(address: string): Promise<SpendableMvcUtxo[]> {
  const all: SpendableMvcUtxo[] = [];
  let flag: string | undefined;
  while (true) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const response = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const json = await response.json() as {
      data?: { list?: Array<{ txid?: string; outIndex?: number; value?: number; height?: number; flag?: string }> };
    };
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    for (const utxo of list) {
      const txId = String(utxo.txid || '').trim();
      const outputIndex = Number(utxo.outIndex);
      const satoshis = Number(utxo.value);
      if (!/^[0-9a-fA-F]{64}$/.test(txId) || !Number.isInteger(outputIndex) || outputIndex < 0) continue;
      if (!Number.isInteger(satoshis) || satoshis <= 600) continue;
      all.push({
        txId,
        outputIndex,
        satoshis,
        address,
        height: Number(utxo.height ?? 0) || 0,
      });
    }
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
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
    offer?: { itemPinId?: string; priceSats?: number; offerTx?: string };
    feeRate?: number;
    excludeOutpoints?: string[];
  };
  const offer = payload.offer;
  if (!offer?.itemPinId || !offer.offerTx) {
    fail(new Error('offer {itemPinId, priceSats, offerTx} is required'));
  }
  const excluded = new Set(
    (payload.excludeOutpoints ?? [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );

  // Full gate pass against the live holder view: item exists/unburned, input0
  // is the item's CURRENT outpoint, output0 pays the owner the advertised
  // price, sigtype is SINGLE|FORKID|ACP, the seller signature verifies, and
  // the outpoint is unspent.
  const verified = await verifyMrc721OpenOffer(offer, { excludedOutpoints: excluded });

  const addressIndex = parseAddressIndexFromPath(pathStr);
  const wallet = await getMvcWallet(mnemonic as string, addressIndex);
  const buyerAddress = wallet.getAddress();
  if (buyerAddress === verified.sellerAddress) {
    fail(new Error('the buyer wallet is the item owner — taking your own offer is refused. Nothing was signed.'));
  }
  const utxos = await fetchPaymentUtxos(buyerAddress);
  const built = completeMrc721OpenOfferTx({
    offerTx: verified.offer.offerTx,
    outpoint: verified.outpoint,
    sellerAddress: verified.sellerAddress,
    priceSats: verified.offer.priceSats,
    buyerWif: wallet.getPrivateKey(),
    buyerAddress,
    feeRate: Number(payload.feeRate),
    utxos,
    excludedOutpoints: excluded,
  });
  // Second pass of the holder/outpoint/burned and unspent checks after the
  // buyer input is signed and before broadcast (same double-check as the
  // directed buy worker).
  await verifyMrc721OpenOffer(offer, { excludedOutpoints: excluded });
  const txId = await broadcastMvcTx(built.txHex);
  console.log(JSON.stringify({
    success: true,
    txHex: built.txHex,
    txid: txId,
    spentOutpoints: built.spentOutpoints,
    feeSats: built.feeSats,
    feeRateEffective: built.feeRateEffective,
    normalFeeSats: built.normalFeeSats,
  }));
}

if (require.main === module) {
  main().catch(fail);
}
