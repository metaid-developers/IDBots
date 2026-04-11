/**
 * MVC transfer worker: runs in subprocess via ELECTRON_RUN_AS_NODE to avoid
 * meta-contract "instanceof" issues in the Electron main process.
 * Reads mnemonic/path from env, transfer params from stdin, broadcasts with
 * provider-order UTXO selection + stale-outpoint retries, then outputs txid.
 */

import { TxComposer, mvc } from 'meta-contract';
import {
  ensureFreshMvcFundingCandidates,
  getUtxoOutpointKey,
  isRetryableMvcBroadcastError,
  pickUtxo,
  resolveBroadcastTxResult,
  type SpendableMvcUtxo,
} from './mvcSpend';
export {
  ensureFreshMvcFundingCandidates,
  isRetryableMvcBroadcastError,
  pickUtxo,
} from './mvcSpend';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const RETRYABLE_MVC_BROADCAST_ATTEMPTS = 3;
const RETRYABLE_MVC_BROADCAST_DELAY_MS = 750;
const ESTIMATED_TX_SIZE_WITHOUT_INPUTS = 4 + 1 + 1 + 43 + 43 + 4;

function logStep(message: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[transferMvcWorker] ${message}${suffix}\n`);
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

async function fetchMVCUtxos(address: string): Promise<Array<{ txid: string; outIndex: number; value: number; height: number }>> {
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

async function broadcastTx(rawTx: string): Promise<string> {
  const res = await fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: NET, rawTx }),
  });
  const json = (await res.json()) as { code?: number; message?: string; data?: string };
  return resolveBroadcastTxResult(rawTx, json);
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

  const network = mvc.Networks.livenet;
  const mneObj = mvc.Mnemonic.fromString(mnemonic);
  const hdpk = mneObj.toHDPrivateKey('', network as any);
  const addressIndexMatch = pathStr.match(/\/0\/(\d+)$/);
  const addressIndex = addressIndexMatch ? parseInt(addressIndexMatch[1], 10) : 0;
  const derivePath = `m/44'/10001'/0'/0/${addressIndex}`;
  const childPk = hdpk.deriveChild(derivePath);
  const fromAddress = childPk.publicKey.toAddress(network as any).toString();
  const addressObj = new mvc.Address(fromAddress, network as any);
  const privateKey = childPk.privateKey;
  const excludedOutpoints = new Set<string>();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRYABLE_MVC_BROADCAST_ATTEMPTS; attempt++) {
    let pickedForAttempt: SpendableMvcUtxo[] = [];
    try {
      const utxos = await fetchMVCUtxos(fromAddress);
      const usableUtxos: SpendableMvcUtxo[] = utxos.map((u) => ({
        txId: u.txid,
        outputIndex: u.outIndex,
        satoshis: u.value,
        address: fromAddress,
        height: u.height,
      }));
      logStep('Fetched MVC transfer funding candidates', {
        attempt,
        candidateOutpoints: usableUtxos.map((utxo) => getUtxoOutpointKey(utxo)),
        excludedOutpoints: Array.from(excludedOutpoints),
      });
      ensureFreshMvcFundingCandidates(usableUtxos, excludedOutpoints);

      const txComposer = new TxComposer();
      txComposer.appendP2PKHOutput({
        address: new mvc.Address(toAddress, network as any),
        satoshis: amountSats,
      });

      const picked = pickUtxo(
        usableUtxos,
        amountSats,
        feeRate,
        ESTIMATED_TX_SIZE_WITHOUT_INPUTS,
        excludedOutpoints,
      );
      pickedForAttempt = picked;
      logStep('Picked MVC transfer funding inputs', {
        attempt,
        pickedOutpoints: picked.map((utxo) => getUtxoOutpointKey(utxo)),
      });

      for (const utxo of picked) {
        txComposer.appendP2PKHInput({
          address: addressObj,
          txId: utxo.txId,
          outputIndex: utxo.outputIndex,
          satoshis: utxo.satoshis,
        });
      }
      txComposer.appendChangeOutput(addressObj, feeRate);

      const tx = txComposer.tx;
      for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
        txComposer.unlockP2PKHInput(privateKey, inputIndex);
      }

      const rawHex = txComposer.getRawHex();
      const txId = await broadcastTx(rawHex);
      logStep('Broadcasted MVC transfer transaction', { attempt, txId });
      console.log(JSON.stringify({ success: true, txId }));
      return;
    } catch (err) {
      lastError = err;
      const message = getMessage(err);
      if (attempt < RETRYABLE_MVC_BROADCAST_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        for (const utxo of pickedForAttempt) {
          excludedOutpoints.add(getUtxoOutpointKey(utxo));
        }
        logStep('Retrying MVC transfer after retryable broadcast failure', {
          attempt,
          error: message,
          blacklistedOutpoints: pickedForAttempt.map((utxo) => getUtxoOutpointKey(utxo)),
          excludedOutpoints: Array.from(excludedOutpoints),
        });
        await new Promise((resolve) => setTimeout(resolve, RETRYABLE_MVC_BROADCAST_DELAY_MS));
        continue;
      }
      logStep('MVC transfer failed', { attempt, error: message });
      console.error(JSON.stringify({ success: false, error: message }));
      process.exit(1);
    }
  }

  console.error(JSON.stringify({ success: false, error: getMessage(lastError ?? 'Broadcast failed') }));
  process.exit(1);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ success: false, error: getMessage(err) }));
    process.exit(1);
  });
}
