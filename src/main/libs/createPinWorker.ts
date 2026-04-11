/**
 * Create Pin worker: runs in subprocess via ELECTRON_RUN_AS_NODE to avoid meta-contract
 * instanceof issues in the main process.
 * Reads mnemonic/path from env, metaidData from stdin, outputs result to stdout.
 */

import { TxComposer, mvc } from 'meta-contract';
import {
  computeMvcTxidFromRawTx,
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
  isRetryableMvcBroadcastError,
  isTxnAlreadyKnownError,
  pickUtxo,
  resolveBroadcastTxResult,
} from './mvcSpend';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

async function fetchMVCUtxos(address: string): Promise<{ txid: string; outIndex: number; value: number; height: number }[]> {
  const all: { txid: string; outIndex: number; value: number; height: number }[] = [];
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

const RETRYABLE_MVC_BROADCAST_ATTEMPTS = 3;
const RETRYABLE_MVC_BROADCAST_DELAY_MS = 750;

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
interface RpcPayload {
  feeRate?: number;
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
  const excludedOutpoints = new Set<string>();
  for (let attempt = 1; attempt <= RETRYABLE_MVC_BROADCAST_ATTEMPTS; attempt++) {
    let pickedForAttempt: SA_utxo[] = [];
    try {
      const utxos = await fetchMVCUtxos(address);
      const usableUtxos: SA_utxo[] = utxos.map((u) => ({
        txId: u.txid,
        outputIndex: u.outIndex,
        satoshis: u.value,
        address,
        height: u.height,
      }));
      logStep('Fetched MVC pin funding candidates', {
        attempt,
        operation: metaidData.operation,
        path: metaidData.path || '',
        candidateOutpoints: usableUtxos.map((utxo) => getUtxoOutpointKey(utxo)),
        excludedOutpoints: Array.from(excludedOutpoints),
      });

      const txComposer = new TxComposer();
      txComposer.appendP2PKHOutput({
        address: addressObj,
        satoshis: 1,
      });
      txComposer.appendOpReturnOutput(opReturnParts);

      const tx = txComposer.tx;
      const totalOutput = tx.outputs.reduce((acc, o) => acc + o.satoshis, 0);
      const picked = pickUtxo(usableUtxos, totalOutput, feeRate, estimatedTxSizeWithoutInputs, excludedOutpoints);
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
      logStep('Broadcasted MVC pin transaction', {
        attempt,
        txid,
        pinId,
        totalCost,
      });
      console.log(JSON.stringify({ success: true, txids: [txid], pinId, totalCost, feeRate }));
      return;
    } catch (err) {
      lastError = err;
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as Error).message)
        : String(err);
      logStep('MVC pin transaction attempt failed', { attempt, error: message });
      if (isInsufficientFeeError(message)) {
        throw new Error('MetaBot 余额不足，无法支付本次上链所需的手续费，请先充值后重试。');
      }
      if (attempt < RETRYABLE_MVC_BROADCAST_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
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
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Broadcast failed'));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const msg = err && typeof err === 'object' && 'message' in err
      ? String((err as Error).message)
      : String(err);
    console.error(JSON.stringify({ success: false, error: msg }));
    process.exit(1);
  });
}
