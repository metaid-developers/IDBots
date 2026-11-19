/**
 * Seller-side MRC-721 atomic-swap worker. Builds a one-input partial tx and
 * signs only input 0. It never selects or spends any other wallet UTXO.
 *
 * Runs under ELECTRON_RUN_AS_NODE, same as buildMvcTransferRawTxWorker.
 */

import { getMvcWalletFromPath } from '../services/metabotWalletService';
import {
  buildMvc721SellPartialTx,
  normalizeMrc721Outpoint,
} from './mrc721AtomicSwapTx';

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
    buyerAddress?: string;
    priceSats?: number;
    outpoint?: { txid?: string; vout?: number; satoshis?: number };
  };

  // Path-aware derivation (parity with buildMvcTransferRawTxWorker): a legacy
  // 236-segment issuer bot must derive its own address, not the 10001 default.
  const wallet = await getMvcWalletFromPath(mnemonic as string, pathStr);
  const sellerAddress = wallet.getAddress();
  const outpoint = normalizeMrc721Outpoint(payload.outpoint);
  const built = buildMvc721SellPartialTx({
    sellerWif: wallet.getPrivateKey(),
    sellerAddress,
    buyerAddress: String(payload.buyerAddress || '').trim(),
    outpoint,
    priceSats: Number(payload.priceSats),
  });
  console.log(JSON.stringify({
    success: true,
    partialTx: built.partialTx,
    sigtype: built.sigtype,
    sellerAddress,
  }));
}

if (require.main === module) {
  main().catch(fail);
}
