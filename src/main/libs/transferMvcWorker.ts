/**
 * MVC transfer worker: runs in subprocess via ELECTRON_RUN_AS_NODE to avoid
 * meta-contract "instanceof" issues in the Electron main process.
 * Reads mnemonic/path from env, transfer params from stdin, broadcasts with
 * local pending-funding preference + stale-outpoint retries, then outputs txid.
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
const STALE_PROVIDER_ERROR_MESSAGE = 'MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.';

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

function normalizeOutpointList(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  return new Set(
    input
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );
}

function normalizePreferredFundingUtxos(input: unknown, fallbackAddress: string): SpendableMvcUtxo[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const txId = String(record.txId || '').trim().toLowerCase();
    const outputIndex = Number(record.outputIndex);
    const satoshis = Number(record.satoshis);
    const address = String(record.address || fallbackAddress).trim() || fallbackAddress;
    const height = Number(record.height ?? -1);
    if (!/^[0-9a-f]{64}$/.test(txId)) return [];
    if (!Number.isInteger(outputIndex) || outputIndex < 0) return [];
    if (!Number.isFinite(satoshis) || satoshis < 600) return [];
    return [{
      txId,
      outputIndex,
      satoshis,
      address,
      height: Number.isFinite(height) ? height : -1,
    }];
  });
}

function mergeFundingCandidates(
  preferredFundingUtxos: SpendableMvcUtxo[],
  providerFundingUtxos: SpendableMvcUtxo[],
): SpendableMvcUtxo[] {
  const merged: SpendableMvcUtxo[] = [];
  const seen = new Set<string>();
  for (const utxo of preferredFundingUtxos.concat(providerFundingUtxos)) {
    const outpoint = getUtxoOutpointKey(utxo);
    if (seen.has(outpoint)) continue;
    seen.add(outpoint);
    merged.push(utxo);
  }
  return merged;
}

function buildChangeUtxo(tx: mvc.Transaction, txId: string, address: string): SpendableMvcUtxo | null {
  if (!Array.isArray(tx.outputs) || tx.outputs.length <= 1) {
    return null;
  }
  const changeIndex = tx.outputs.length - 1;
  const changeOutput: any = tx.outputs[changeIndex];
  const satoshis = Number(changeOutput?.satoshis);
  if (!Number.isFinite(satoshis) || satoshis < 600) {
    return null;
  }
  return {
    txId,
    outputIndex: changeIndex,
    satoshis,
    address,
    height: -1,
  };
}

function isProviderStaleFundingError(message: string): boolean {
  return String(message || '').includes(STALE_PROVIDER_ERROR_MESSAGE);
}

function computeSpendableSatoshisAfterExclusions(
  candidates: SpendableMvcUtxo[],
  excludedOutpoints: ReadonlySet<string>,
): number {
  return candidates.reduce((total, utxo) => {
    const outpoint = getUtxoOutpointKey(utxo);
    if (excludedOutpoints.has(outpoint)) return total;
    return total + Number(utxo.satoshis || 0);
  }, 0);
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
    excludeOutpoints?: string[];
    preferredFundingUtxos?: SpendableMvcUtxo[];
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
  const excludedOutpoints = normalizeOutpointList(payload.excludeOutpoints);
  const preferredFundingUtxos = normalizePreferredFundingUtxos(payload.preferredFundingUtxos, fromAddress);
  const preferredOutpoints = new Set(preferredFundingUtxos.map((utxo) => getUtxoOutpointKey(utxo)));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRYABLE_MVC_BROADCAST_ATTEMPTS; attempt++) {
    let pickedForAttempt: SpendableMvcUtxo[] = [];
    let candidatesForAttempt: SpendableMvcUtxo[] = [];
    try {
      const providerUtxos = await fetchMVCUtxos(fromAddress);
      const providerFundingUtxos: SpendableMvcUtxo[] = providerUtxos.flatMap((u) => {
        const txId = String(u.txid || '').trim().toLowerCase();
        const outputIndex = Number(u.outIndex);
        const satoshis = Number(u.value);
        const height = Number(u.height);
        if (!/^[0-9a-f]{64}$/.test(txId)) return [];
        if (!Number.isInteger(outputIndex) || outputIndex < 0) return [];
        if (!Number.isFinite(satoshis) || satoshis < 600) return [];
        return [{
          txId,
          outputIndex,
          satoshis,
          address: fromAddress,
          height: Number.isFinite(height) ? height : -1,
        }];
      });
      const usableUtxos = mergeFundingCandidates(preferredFundingUtxos, providerFundingUtxos);
      candidatesForAttempt = usableUtxos;
      logStep('Fetched MVC transfer funding candidates', {
        attempt,
        candidateOutpoints: usableUtxos.map((utxo) => getUtxoOutpointKey(utxo)),
        providerCandidateOutpoints: providerFundingUtxos.map((utxo) => getUtxoOutpointKey(utxo)),
        preferredOutpoints: Array.from(preferredOutpoints),
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
        preferredOutpoints,
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
      const changeUtxo = buildChangeUtxo(tx, txId, fromAddress);
      const spentOutpoints = picked.map((utxo) => getUtxoOutpointKey(utxo));
      logStep('Broadcasted MVC transfer transaction', {
        attempt,
        txId,
        spentOutpoints,
        changeOutpoint: changeUtxo ? getUtxoOutpointKey(changeUtxo) : null,
      });
      console.log(JSON.stringify({ success: true, txId, spentOutpoints, changeUtxo }));
      return;
    } catch (err) {
      lastError = err;
      const message = getMessage(err);
      const pickedOutpoints = pickedForAttempt.map((utxo) => getUtxoOutpointKey(utxo));
      const discoveredStaleOutpoints = Array.from(excludedOutpoints);
      if (attempt < RETRYABLE_MVC_BROADCAST_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        for (const utxo of pickedForAttempt) {
          excludedOutpoints.add(getUtxoOutpointKey(utxo));
        }
        logStep('Retrying MVC transfer after retryable broadcast failure', {
          attempt,
          error: message,
          blacklistedOutpoints: pickedOutpoints,
          excludedOutpoints: Array.from(excludedOutpoints),
        });
        await new Promise((resolve) => setTimeout(resolve, RETRYABLE_MVC_BROADCAST_DELAY_MS));
        continue;
      }
      const spendableSats = computeSpendableSatoshisAfterExclusions(candidatesForAttempt, excludedOutpoints);
      const staleOutpoints =
        pickedOutpoints.length > 0 && isRetryableMvcBroadcastError(message)
          ? pickedOutpoints
          : discoveredStaleOutpoints.length > 0
            ? discoveredStaleOutpoints
            : isProviderStaleFundingError(message)
              ? Array.from(excludedOutpoints)
              : undefined;
      logStep('MVC transfer failed', { attempt, error: message });
      console.error(JSON.stringify({
        success: false,
        error: message,
        requestedSats: Number(amountSats),
        spendableSats,
        staleOutpoints,
      }));
      process.exit(1);
    }
  }

  const finalError = getMessage(lastError ?? 'Broadcast failed');
  console.error(JSON.stringify({
    success: false,
    error: finalError,
    staleOutpoints: excludedOutpoints.size > 0 ? Array.from(excludedOutpoints) : undefined,
  }));
  process.exit(1);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ success: false, error: getMessage(err) }));
    process.exit(1);
  });
}
