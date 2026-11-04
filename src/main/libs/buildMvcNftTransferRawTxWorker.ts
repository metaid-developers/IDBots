/**
 * MVC NFT transfer worker: runs in subprocess via ELECTRON_RUN_AS_NODE to
 * avoid meta-contract "instanceof" issues in the Electron main process
 * (same pattern as buildMvcFtTransferRawTxWorker). Builds the NftManager
 * transfer tx (noBroadcast) and prints { success, txHex, txid, spentOutpoints }
 * as the LAST stdout line; the parent broadcasts and owns retries.
 */

import { API_NET, API_TARGET, NftManager, mvc } from 'meta-contract';
import { getMvcWalletFromPath } from '../services/metabotWalletService';
import {
  attachMvcFundingSignatureContext,
  selectMvcFundingUtxos,
} from '../services/tokenTransferAdapters';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

function logStep(message: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[buildMvcNftTransferRawTxWorker] ${message}${suffix}\n`);
  } catch {
    // ignore logging failures
  }
}

function getMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

function normalizeExcludeOutpoints(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  return new Set(
    input
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );
}

async function fetchMvcFundingUtxos(address: string): Promise<Array<{ txid: string; outIndex: number; value: number; height: number }>> {
  const all: Array<{ txid: string; outIndex: number; value: number; height: number }> = [];
  let flag: string | undefined;
  while (true) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const res = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const json = (await res.json()) as { data?: { list?: Array<{ txid: string; outIndex: number; value: number; height: number; flag?: string }> } };
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    all.push(...list.filter((u) => u.value >= 600));
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
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
    genesis: string;
    codehash: string;
    tokenIndex: string;
    toAddress: string;
    feeRate: number;
    excludeOutpoints?: string[];
  };

  const genesis = String(payload.genesis || '').trim();
  const codehash = String(payload.codehash || '').trim();
  const tokenIndex = String(payload.tokenIndex || '').trim();
  const toAddress = String(payload.toAddress || '').trim();
  const feeRate = Number(payload.feeRate);
  if (!/^\d+$/.test(tokenIndex) || !genesis || !codehash || !toAddress || !Number.isFinite(feeRate) || feeRate <= 0) {
    console.log(JSON.stringify({ success: false, error: 'Invalid payload for MVC NFT transfer raw tx worker' }));
    process.exit(1);
  }

  const mvcWallet = await getMvcWalletFromPath(mnemonic, pathStr);
  const senderWif = mvcWallet.getPrivateKey();
  const senderAddress = mvcWallet.getAddress();

  const excludeOutpoints = normalizeExcludeOutpoints(payload.excludeOutpoints);
  const allUtxos = await fetchMvcFundingUtxos(senderAddress);
  let utxos = allUtxos
    .map((utxo) => ({
      txId: String(utxo.txid || '').trim(),
      outputIndex: Number(utxo.outIndex),
      satoshis: Number(utxo.value),
      height: Number(utxo.height),
      address: senderAddress,
    }))
    .filter((utxo) => {
      const key = `${utxo.txId.toLowerCase()}:${utxo.outputIndex}`;
      return /^[0-9a-f]{64}$/i.test(utxo.txId) && Number.isInteger(utxo.outputIndex) && utxo.outputIndex >= 0 && utxo.satoshis > 600 && !excludeOutpoints.has(key);
    });
  logStep('Fetched MVC NFT funding candidates', {
    candidateOutpoints: utxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    excludedOutpoints: Array.from(excludeOutpoints),
  });
  utxos = attachMvcFundingSignatureContext(utxos, {
    senderWif,
    senderAddress,
  });
  utxos = selectMvcFundingUtxos(utxos);
  if (utxos.length === 0) {
    console.log(JSON.stringify({ success: false, error: 'No spendable MVC UTXOs after exclusions' }));
    process.exit(1);
  }

  const nftManager = new NftManager({
    network: API_NET.MAIN,
    apiTarget: API_TARGET.APIMVC,
    purse: senderWif,
    feeb: feeRate,
  });

  const transferResult = await nftManager.transfer({
    genesis,
    codehash,
    tokenIndex,
    senderWif,
    receiverAddress: toAddress,
    utxos,
    noBroadcast: true,
  });

  const tx = new mvc.Transaction(transferResult.txHex);
  const spentOutpoints = tx.inputs.map(
    (input: any) => `${input.prevTxId.toString('hex')}:${Number(input.outputIndex)}`,
  );

  console.log(
    JSON.stringify({
      success: true,
      txHex: transferResult.txHex,
      txid: transferResult.txid,
      spentOutpoints,
    }),
  );
  logStep('Built MVC NFT transfer raw tx locally', {
    txid: transferResult.txid,
    spentOutpoints,
  });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ success: false, error: getMessage(err) }));
    process.exit(1);
  });
}
