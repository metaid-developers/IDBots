/**
 * MVC transfer worker: runs in subprocess via ELECTRON_RUN_AS_NODE to avoid
 * meta-contract "instanceof" issues in the Electron main process.
 * Reads mnemonic/path from env, transfer params from stdin, outputs { success, txHex } or { success: false, error }.
 */

import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';
import { API_NET, API_TARGET, Wallet } from 'meta-contract';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

function getMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

async function main(): Promise<void> {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  const pathStr = (process.env.IDBOTS_METABOT_PATH || DEFAULT_PATH).trim();
  if (!mnemonic) {
    console.log(JSON.stringify({ success: false, error: 'IDBOTS_METABOT_MNEMONIC required' }));
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
    toAddress: string;
    amountSats: number;
    feeRate: number;
  };
  const { toAddress, amountSats, feeRate } = payload;
  if (!toAddress || amountSats == null || amountSats < 600 || feeRate == null) {
    console.log(JSON.stringify({ success: false, error: 'Invalid payload: toAddress, amountSats (>=600), feeRate required' }));
    process.exit(1);
  }

  const addressIndex = parseAddressIndexFromPath(pathStr);
  const mvcWallet = await getMvcWallet(mnemonic, addressIndex);
  const purse = mvcWallet.getPrivateKey();
  const network: API_NET = API_NET.MAIN;
  const w = new Wallet(purse, network, feeRate, API_TARGET.APIMVC);
  const receivers = [{ address: toAddress, amount: amountSats }];
  const res = await w.sendArray(receivers, undefined, { noBroadcast: true });
  console.log(JSON.stringify({ success: true, txHex: res.txHex }));
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ success: false, error: getMessage(err) }));
  process.exit(1);
});
