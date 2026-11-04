/**
 * Buyer-side MRC-721 atomic-swap worker. Validates the seller partial,
 * appends one payment input, signs it, and broadcasts. It must not append
 * outputs: the seller's SIGHASH_ALL signature covers the existing outputs.
 *
 * Runs under ELECTRON_RUN_AS_NODE, same as buildMvcTransferRawTxWorker.
 */

import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';
import { broadcastMvcTx } from '../services/mrc721Service';
import { verifyMrc721Listing } from '../services/mrc721AtomicSwapService';
import type { SpendableMvcUtxo } from './mvcSpend';
import {
  completeMvc721BuyTxLocally,
  type Mrc721AtomicSwapListing,
} from './mrc721AtomicSwapTx';

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
    listing?: Mrc721AtomicSwapListing;
    feeRate?: number;
    excludeOutpoints?: string[];
  };
  const listing = payload.listing;
  if (!listing || typeof listing !== 'object') {
    fail(new Error('listing is required'));
  }
  const excluded = new Set(
    (payload.excludeOutpoints ?? [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );

  const verified = await verifyMrc721Listing(listing, { excludedOutpoints: excluded });
  const addressIndex = parseAddressIndexFromPath(pathStr);
  const wallet = await getMvcWallet(mnemonic as string, addressIndex);
  const buyerAddress = wallet.getAddress();
  if (buyerAddress !== verified.listing.buyerAddress) {
    fail(new Error(
      `this wallet is ${buyerAddress}, but the listing pays the NFT to ${verified.listing.buyerAddress}. `
      + 'The listing is bound to that buyer — ask the seller to create a new listing. Nothing was signed.',
    ));
  }
  const utxos = await fetchPaymentUtxos(buyerAddress);
  const built = completeMvc721BuyTxLocally({
    partialTx: verified.listing.partialTx,
    buyerWif: wallet.getPrivateKey(),
    buyerAddress,
    sellerAddress: verified.listing.sellerAddress,
    priceSats: verified.listing.priceSats,
    outpoint: verified.listing.outpoint,
    feeRate: Number(payload.feeRate),
    utxos,
    excludedOutpoints: excluded,
  });
  // Second pass of indexer owner/outpoint/burned and node-unspent checks,
  // after the buyer input is signed and before it is broadcast.
  await verifyMrc721Listing(verified.listing, { excludedOutpoints: excluded });
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
