/**
 * Create Pin worker: runs in subprocess via ELECTRON_RUN_AS_NODE to avoid meta-contract
 * instanceof issues in the main process.
 * Reads mnemonic/path from env, metaidData from stdin, outputs result to stdout.
 */

import { TxComposer, mvc } from 'meta-contract';
import {
  computeMvcTxidFromRawTx,
  ensureFreshMvcFundingCandidates,
  isRetryableMvcBroadcastError,
  isTxnAlreadyKnownError,
  pickUtxo,
  resolveBroadcastTxResult,
  getUtxoOutpointKey,
  type SpendableMvcUtxo,
  P2PKH_INPUT_SIZE,
} from './mvcSpend';
export {
  computeMvcTxidFromRawTx,
  ensureFreshMvcFundingCandidates,
  isRetryableMvcBroadcastError,
  isTxnAlreadyKnownError,
  pickUtxo,
  resolveBroadcastTxResult,
} from './mvcSpend';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 500;

type FetchJsonWithRetryOptions = {
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  init?: RequestInit;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchFailure(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('fetch failed')
    || message.includes('network')
    || message.includes('timeout')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('und_err')
    || message.includes('ssl_error')
  );
}

async function fetchJsonWithRetry<T>(
  url: string,
  options: FetchJsonWithRetryOptions = {},
): Promise<T> {
  const attempts = Number.isFinite(options.attempts) && (options.attempts ?? 0) > 0
    ? Math.max(1, Math.trunc(options.attempts as number))
    : FETCH_RETRY_ATTEMPTS;
  const delayMs = Number.isFinite(options.delayMs) && (options.delayMs ?? 0) >= 0
    ? Math.trunc(options.delayMs as number)
    : FETCH_RETRY_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, options.init);
      if (!response.ok && response.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        await sleep(delayMs * attempt);
        continue;
      }
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableFetchFailure(error)) {
        throw error;
      }
      logStep('Retrying MVC network request after transient fetch failure', {
        attempt,
        error: getErrorMessage(error),
      });
      await sleep(delayMs * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'fetch failed'));
}

export const fetchJsonWithRetryForTests = fetchJsonWithRetry;

async function fetchMVCUtxos(address: string): Promise<{ txid: string; outIndex: number; value: number; height: number }[]> {
  const all: { txid: string; outIndex: number; value: number; height: number }[] = [];
  let flag: string | undefined;
  while (true) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const json = await fetchJsonWithRetry<{
      data?: { list?: Array<{ txid: string; outIndex: number; value: number; height: number; flag?: string }> };
    }>(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    all.push(...list.filter((u) => u.value >= 600));
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
}

async function broadcastTx(rawTx: string): Promise<string> {
  const json = await fetchJsonWithRetry<{ code?: number; message?: string; data?: string }>(
    `${METALET_HOST}/wallet-api/v3/tx/broadcast`,
    {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain: 'mvc', net: NET, rawTx }),
      },
    },
  );
  return resolveBroadcastTxResult(rawTx, json);
}

const RETRYABLE_MVC_BROADCAST_ATTEMPTS = 3;
const RETRYABLE_MVC_BROADCAST_DELAY_MS = 750;

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
interface RpcPayload {
  feeRate?: number;
  excludeOutpoints?: string[];
  preferredFundingUtxos?: SpendableMvcUtxo[];
  /** Target network: 'mvc' (default), 'doge', 'btc'. Omit or empty defaults to 'mvc'. */
  network?: string;
  metaidData: {
    operation: string;
    path?: string;
    encryption?: string;
    version?: string;
    contentType?: string;
    payload: string;
    encoding?: 'utf-8' | 'base64';
  };
}

type SA_utxo = SpendableMvcUtxo;

function getErrorMessage(err: unknown): string {
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

function parseAddressIndexFromPath(pathStr: string): number {
  if (!pathStr || typeof pathStr !== 'string') return 0;
  const m = pathStr.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function logStep(message: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[createPinWorker] ${message}${suffix}\n`);
  } catch {
    // ignore logging failures
  }
}

function buildMvcOpReturn(data: RpcPayload['metaidData']): (string | Buffer)[] {
  const result: (string | Buffer)[] = ['metaid', data.operation];
  if (data.operation !== 'init') {
    result.push((data.path || '').toLowerCase());
    result.push(data.encryption || '0');
    result.push(data.version || '1.0');
    result.push(data.contentType || 'text/plain;utf-8');
    const encoding = data.encoding === 'base64' ? 'base64' : 'utf-8';
    const body = Buffer.from(data.payload, encoding);
    result.push(body);
  }
  return result;
}

/** Size in bytes of the OP_RETURN script (OP_RETURN + pushes for each part). */
function getOpReturnScriptSize(parts: (string | Buffer)[]): number {
  let size = 1; // OP_RETURN
  for (const p of parts) {
    const len = Buffer.isBuffer(p) ? p.length : Buffer.byteLength(p, 'utf8');
    if (len < 76) size += 1 + len;
    else if (len <= 0xff) size += 2 + len;
    else if (len <= 0xffff) size += 3 + len;
    else size += 5 + len; // OP_PUSHDATA4
  }
  return size;
}

/**
 * Total tx size in bytes without inputs: version(4) + vin_count(1) + vout_count(1)
 * + P2PKH_output(43) + OP_RETURN_output(9+scriptLen) + locktime(4) = 62 + scriptLen.
 * With n inputs: 62 + scriptLen + n * P2PKH_INPUT_SIZE.
 */
function getEstimatedTxSizeWithoutInputs(opReturnScriptSize: number): number {
  return 4 + 1 + 1 + 43 + (9 + opReturnScriptSize) + 4;
}

/**
 * Pick UTXOs so that sum(satoshis) >= totalOutput + fee, where fee = txSize * feeRate.
 * Tx size depends on number of inputs, so we add UTXOs until sum >= required.
 */
const FALLBACK_FEE_RATES: Record<string, number> = { mvc: 1, btc: 2, doge: 5000000 };

function isInsufficientFeeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('insufficient priority') ||
    m.includes('mempool min fee not met') ||
    m.includes('min relay fee not met') ||
    m.includes('insufficient fee') ||
    m.includes('too-long-mempool-chain')
  );
}

function resolveWorkerFeeRate(payload: RpcPayload, networkKind: string): number {
  if (payload.feeRate != null && Number.isFinite(payload.feeRate) && payload.feeRate > 0) {
    return Math.floor(payload.feeRate);
  }
  return FALLBACK_FEE_RATES[networkKind] ?? 1;
}

async function main(): Promise<void> {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  const pathStr = (process.env.IDBOTS_METABOT_PATH || DEFAULT_PATH).trim();
  if (!mnemonic) {
    console.error(JSON.stringify({ success: false, error: 'IDBOTS_METABOT_MNEMONIC required' }));
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const payload: RpcPayload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  const { metaidData, network: networkParam } = payload;
  const networkKind = (String(networkParam ?? '').toLowerCase().trim() || 'mvc') as string;
  const feeRate = resolveWorkerFeeRate(payload, networkKind);

  if (networkKind === 'doge') {
    const log = (msg: string) => {
      try {
        process.stderr.write(`[createPinWorker:doge] ${msg}\n`);
      } catch {
        /* noop */
      }
    };
    const { runDogeCreatePin } = await import('./dogeInscribe');
    log(`feeRate=${feeRate} (from ${payload.feeRate != null ? 'global store' : 'fallback'})`);
    const result = await runDogeCreatePin(
      mnemonic,
      pathStr,
      metaidData,
      feeRate
    );
    console.log(
      JSON.stringify({
        success: true,
        txids: result.txids,
        pinId: result.pinId,
        totalCost: result.totalCost,
      })
    );
    return;
  }

  if (networkKind === 'btc') {
    const btcLog = (msg: string) => {
      try { process.stderr.write(`[createPinWorker:btc] ${msg}\n`); } catch { /* noop */ }
    };
    const { runBtcCreatePin } = await import('./btcInscribe');
    btcLog(`feeRate=${feeRate} (from ${payload.feeRate != null ? 'global store' : 'fallback'})`);
    const result = await runBtcCreatePin(mnemonic, pathStr, metaidData, feeRate);
    console.log(
      JSON.stringify({
        success: true,
        txids: result.txids,
        pinId: result.pinId,
        totalCost: result.totalCost,
      })
    );
    return;
  }
  const addressIndex = parseAddressIndexFromPath(pathStr);

  const network = mvc.Networks.livenet;
  const mneObj = mvc.Mnemonic.fromString(mnemonic);
  const hdpk = mneObj.toHDPrivateKey('', network as any);
  const derivePath = `m/44'/10001'/0'/0/${addressIndex}`;
  const childPk = hdpk.deriveChild(derivePath);
  const address = childPk.publicKey.toAddress(network as any).toString();
  const privateKey = childPk.privateKey;

  const addressObj = new mvc.Address(address, network as any);
  const opReturnParts = buildMvcOpReturn(metaidData);
  const opReturnScriptSize = getOpReturnScriptSize(opReturnParts);
  const estimatedTxSizeWithoutInputs = getEstimatedTxSizeWithoutInputs(opReturnScriptSize);
  let lastError: unknown = null;
  const excludedOutpoints = normalizeOutpointList(payload.excludeOutpoints);
  const preferredFundingUtxos = normalizePreferredFundingUtxos(payload.preferredFundingUtxos, address);
  const preferredOutpoints = new Set(preferredFundingUtxos.map((utxo) => getUtxoOutpointKey(utxo)));
  const maxBroadcastAttempts = Math.max(
    RETRYABLE_MVC_BROADCAST_ATTEMPTS,
    Math.min(24, preferredFundingUtxos.length + RETRYABLE_MVC_BROADCAST_ATTEMPTS),
  );
  for (let attempt = 1; attempt <= maxBroadcastAttempts; attempt++) {
    let pickedForAttempt: SA_utxo[] = [];
    try {
      const utxos = await fetchMVCUtxos(address);
      const providerFundingUtxos: SA_utxo[] = utxos.map((u) => ({
        txId: u.txid,
        outputIndex: u.outIndex,
        satoshis: u.value,
        address,
        height: u.height,
      }));
      const usableUtxos = mergeFundingCandidates(preferredFundingUtxos, providerFundingUtxos);
      logStep('Fetched MVC pin funding candidates', {
        attempt,
        operation: metaidData.operation,
        path: metaidData.path || '',
        candidateOutpoints: usableUtxos.map((utxo) => getUtxoOutpointKey(utxo)),
        providerCandidateOutpoints: providerFundingUtxos.map((utxo) => getUtxoOutpointKey(utxo)),
        preferredOutpoints: Array.from(preferredOutpoints),
        excludedOutpoints: Array.from(excludedOutpoints),
      });
      ensureFreshMvcFundingCandidates(usableUtxos, excludedOutpoints);

      const txComposer = new TxComposer();
      txComposer.appendP2PKHOutput({
        address: addressObj,
        satoshis: 1,
      });
      txComposer.appendOpReturnOutput(opReturnParts);

      const tx = txComposer.tx;
      const totalOutput = tx.outputs.reduce((acc, o) => acc + o.satoshis, 0);
      const picked = pickUtxo(
        usableUtxos,
        totalOutput,
        feeRate,
        estimatedTxSizeWithoutInputs,
        excludedOutpoints,
        preferredOutpoints,
      );
      pickedForAttempt = picked;
      logStep('Picked MVC pin funding inputs', {
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

      for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
        txComposer.unlockP2PKHInput(privateKey, inputIndex);
      }

      const rawHex = txComposer.getRawHex();
      const inputTotal = tx.inputs.reduce((s, inp) => s + (inp.output?.satoshis || 0), 0);
      const outputTotal = tx.outputs.reduce((s, o) => s + o.satoshis, 0);
      const totalCost = inputTotal - outputTotal;

      const txid = await broadcastTx(rawHex);
      const pinId = `${txid}i0`;
      const changeUtxo = buildChangeUtxo(tx, txid, address);
      const spentOutpoints = picked.map((utxo) => getUtxoOutpointKey(utxo));
      logStep('Broadcasted MVC pin transaction', {
        attempt,
        txid,
        pinId,
        totalCost,
        spentOutpoints,
        changeOutpoint: changeUtxo ? getUtxoOutpointKey(changeUtxo) : null,
      });
      console.log(JSON.stringify({
        success: true,
        txids: [txid],
        pinId,
        totalCost,
        feeRate,
        spentOutpoints,
        changeUtxo,
      }));
      return;
    } catch (err) {
      lastError = err;
      const message = getErrorMessage(err);
      logStep('MVC pin transaction attempt failed', { attempt, error: message });
      if (isInsufficientFeeError(message)) {
        throw new Error('MetaBot 余额不足，无法支付本次上链所需的手续费，请先充值后重试。');
      }
      if (attempt < maxBroadcastAttempts && isRetryableMvcBroadcastError(message)) {
        for (const utxo of pickedForAttempt) {
          excludedOutpoints.add(getUtxoOutpointKey(utxo));
        }
        logStep('Retrying MVC pin transaction after retryable failure', {
          attempt,
          blacklistedOutpoints: pickedForAttempt.map((utxo) => getUtxoOutpointKey(utxo)),
          excludedOutpoints: Array.from(excludedOutpoints),
        });
        await new Promise((resolve) => setTimeout(resolve, RETRYABLE_MVC_BROADCAST_DELAY_MS));
        continue;
      }
      const failure = new Error(message);
      if (isRetryableMvcBroadcastError(message) || excludedOutpoints.size > 0) {
        (failure as Error & { staleOutpoints?: string[] }).staleOutpoints = Array.from(excludedOutpoints);
      }
      throw failure;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Broadcast failed'));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const msg = getErrorMessage(err);
    const details = err as Error & {
      staleOutpoints?: string[];
      requestedSats?: number;
      spendableSats?: number;
    };
    console.log(JSON.stringify({
      success: false,
      error: msg,
      staleOutpoints: Array.isArray(details?.staleOutpoints) ? details.staleOutpoints : undefined,
      requestedSats: Number.isFinite(details?.requestedSats) ? details.requestedSats : undefined,
      spendableSats: Number.isFinite(details?.spendableSats) ? details.spendableSats : undefined,
    }));
    process.exit(1);
  });
}
