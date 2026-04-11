/**
 * Transfer Service
 * Handles SPACE (MVC) and DOGE transfers for MetaBot wallets.
 * MVC signing runs in a subprocess worker to avoid meta-contract "instanceof" issues in Electron main.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import Decimal from 'decimal.js';
import { getMvcWallet, getDogeWallet, parseAddressIndexFromPath } from './metabotWalletService';
import { BtcWallet, AddressType, CoinType, SignType } from '@metalet/utxo-wallet-service';
import { resolveElectronExecutablePath } from '../libs/runtimePaths';
import type { MetabotStore } from '../metabotStore';
import { getMvcSpendCoordinator } from './mvcSpendCoordinator';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const SATOSHI_PER_UNIT = 100_000_000;
const SPACE_TO_SATS = new Decimal(10).pow(8);
const MIN_DOGE_TRANSFER_SATOSHIS = 1_000_000; // 0.01 DOGE

export type TransferChain = 'mvc' | 'doge' | 'btc';

export interface FeeRateOption {
  title: string;
  desc: string;
  feeRate: number;
}

export interface FeeSummaryResult {
  list: FeeRateOption[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = (await res.json()) as { code?: number; message?: string; data?: T };
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(json.message || 'API request failed');
  }
  const data = json.data ?? json;
  return data as T;
}

async function fetchPost<T>(url: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { code?: number; message?: string; data?: T };
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(json.message || 'API request failed');
  }
  return (json.data ?? json) as T;
}

/**
 * Fetch fee rate summary for a chain (MVC or DOGE). No auth required.
 * API returns { code: 0, data: { list: [...] } }; we normalize to { list }.
 */
export async function getFeeSummary(chain: TransferChain): Promise<FeeSummaryResult> {
  const path =
    chain === 'mvc'
      ? '/wallet-api/v4/mvc/fee/summary'
      : chain === 'btc' ? '/wallet-api/v3/btc/fee/summary'
      : '/wallet-api/v4/doge/fee/summary';
  const url = `${METALET_HOST}${path}?net=${NET}`;
  const res = await fetchJson<{ list: FeeRateOption[] }>(url);
  return Array.isArray(res) ? { list: res } : res;
}

/**
 * Get default (Avg) fee rate for a chain.
 */
export function getDefaultFeeRate(chain: TransferChain, list: FeeRateOption[]): number {
  const avg = list.find((x) => x.title === 'Avg');
  if (chain === 'mvc') return avg?.feeRate ?? 1;
  if (chain === 'btc') return avg?.feeRate ?? 2;
  return avg?.feeRate ?? 200_000; // DOGE sat/kB
}

/** Fetch DOGE UTXOs for address (no auth). */
interface DogeUtxoItem {
  address: string;
  txid: string;
  outIndex: number;
  value: number;
  height: number;
  flag?: string;
}

async function fetchDogeTxHex(txId: string): Promise<string> {
  const url = `${METALET_HOST}/wallet-api/v4/doge/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}`;
  const res = await fetchJson<{ rawTx: string }>(url);
  const raw = Array.isArray(res) ? undefined : ((res as any).hex ?? (res as any).rawTx);
  if (!raw) throw new Error(`Failed to fetch raw tx for ${txId}`);
  return raw;
}

async function fetchDogeUtxos(address: string): Promise<DogeUtxoItem[]> {
  const url = `${METALET_HOST}/wallet-api/v4/doge/address/utxo-list?net=${NET}&address=${encodeURIComponent(address)}`;
  const data = (await fetchJson<{ list: DogeUtxoItem[] }>(url)) as { list: DogeUtxoItem[] };
  const list = data?.list ?? [];
  const all = list.filter((u) => u.value >= MIN_DOGE_TRANSFER_SATOSHIS);
  const confirmed = all.filter((u: any) => u.height > 0);
  return confirmed.length > 0 ? confirmed : all;
}

/** Build DOGE UTXO array with rawTx (SDK expects rawTx for correct signing; reference uses needRawTx: true). */
async function fetchDogeUtxosForSign(address: string): Promise<{ txId: string; outputIndex: number; satoshis: number; address: string; rawTx?: string }[]> {
  const items = await fetchDogeUtxos(address);
  const utxos: { txId: string; outputIndex: number; satoshis: number; address: string; rawTx?: string }[] = items.map((u) => ({
    txId: u.txid,
    outputIndex: u.outIndex,
    satoshis: u.value,
    address: u.address || address,
  }));
  for (const utxo of utxos) {
    try {
      utxo.rawTx = await fetchDogeTxHex(utxo.txId);
    } catch (e) {
      console.warn('[Transfer] DOGE: failed to fetch rawTx for', utxo.txId, getErrorMessage(e));
    }
  }
  return utxos;
}

interface BroadcastDogeResponse {
  TxId: string;
}

/** Broadcast DOGE transaction. Returns TxId. */
async function broadcastDogeTx(rawTx: string): Promise<string> {
  const url = `${METALET_HOST}/wallet-api/v4/doge/tx/broadcast`;
  const data = await fetchPost<BroadcastDogeResponse>(url, { net: NET, rawTx });
  return data.TxId;
}

export interface TransferPreview {
  fromAddress: string;
  toAddress: string;
  amount: string;
  amountUnit: string;
  feeEstimated: string;
  feeEstimatedUnit: string;
  total: string;
  totalUnit: string;
  feeRateSatPerVb: number;
}

/**
 * Build transfer preview (for confirmation step). Validates inputs and returns estimated fee/total.
 */
export async function buildTransferPreview(
  store: MetabotStore,
  params: {
    metabotId: number;
    chain: TransferChain;
    toAddress: string;
    amountSpaceOrDoge: string;
    feeRate: number;
  }
): Promise<TransferPreview> {
  const wallet = store.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) throw new Error('Wallet not found');
  const addressIndex = parseAddressIndexFromPath(wallet.path ?? "m/44'/10001'/0'/0/0");

  const unit = params.chain === 'mvc' ? 'SPACE' : params.chain === 'btc' ? 'BTC' : 'DOGE';
  let amountSats: number;
  if (params.chain === 'mvc') {
    amountSats = new Decimal(params.amountSpaceOrDoge).mul(SPACE_TO_SATS).toNumber();
    if (!Number.isFinite(amountSats) || amountSats < 600) throw new Error('Invalid amount');
  } else if (params.chain === 'btc') {
    amountSats = Math.floor(new Decimal(params.amountSpaceOrDoge).mul(SATOSHI_PER_UNIT).toNumber());
    if (amountSats < 546) throw new Error('Minimum 546 satoshis');
  } else {
    amountSats = Math.floor(new Decimal(params.amountSpaceOrDoge).mul(SATOSHI_PER_UNIT).toNumber());
    if (amountSats < MIN_DOGE_TRANSFER_SATOSHIS) throw new Error('Minimum 0.01 DOGE');
  }

  const fromAddress =
    params.chain === 'mvc'
      ? (await getMvcWallet(wallet.mnemonic, addressIndex)).getAddress()
      : params.chain === 'btc'
      ? getBtcWalletForTransfer(wallet.mnemonic, addressIndex).getAddress()
      : (await getDogeWallet(wallet.mnemonic, addressIndex)).getAddress();

  const feeEstimatedSats = params.chain === 'mvc' ? 200 * params.feeRate : params.chain === 'btc' ? 150 * params.feeRate : 300 * (params.feeRate / 1000);
  const totalSats = amountSats + Math.ceil(feeEstimatedSats);
  const feeValue = feeEstimatedSats / SATOSHI_PER_UNIT;
  const totalValue = totalSats / SATOSHI_PER_UNIT;

  return {
    fromAddress,
    toAddress: params.toAddress,
    amount: new Decimal(amountSats).div(SATOSHI_PER_UNIT).toFixed(8),
    amountUnit: unit,
    feeEstimated: feeValue.toFixed(8),
    feeEstimatedUnit: unit,
    total: totalValue.toFixed(8),
    totalUnit: unit,
    feeRateSatPerVb: params.feeRate,
  };
}

export interface ExecuteTransferResult {
  success: boolean;
  txId?: string;
  error?: string;
}

function getBtcWalletForTransfer(mnemonic: string, addressIndex: number): BtcWallet {
  return new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex,
    network: 'livenet' as const,
    mnemonic,
  });
}

async function fetchBtcUtxosForTransfer(address: string): Promise<{ txId: string; outputIndex: number; satoshis: number; address: string; rawTx?: string; confirmed?: boolean }[]> {
  const url = `${METALET_HOST}/wallet-api/v3/address/btc-utxo?net=${NET}&address=${encodeURIComponent(address)}&unconfirmed=1`;
  const list = await fetchJson<Array<{ txId: string; outputIndex: number; satoshis: number; address?: string; confirmed?: boolean }>>(url);
  const all = (list ?? []).filter((u) => u.satoshis >= 600).map((u) => ({ txId: u.txId, outputIndex: u.outputIndex, satoshis: u.satoshis, address: u.address || address, confirmed: u.confirmed, rawTx: undefined as string | undefined }));
  const confirmed = all.filter((u) => u.confirmed !== false);
  const filtered = confirmed.length > 0 ? confirmed : all;
  for (const utxo of filtered) {
    try {
      const r = await fetchJson<{ rawTx?: string; hex?: string }>(`${METALET_HOST}/wallet-api/v3/tx/raw?net=${NET}&txId=${encodeURIComponent(utxo.txId)}&chain=btc`);
      utxo.rawTx = (r as any)?.rawTx ?? (r as any)?.hex ?? '';
    } catch { /* skip */ }
  }
  return filtered;
}

async function broadcastBtcTx(rawTx: string): Promise<string> {
  const url = `${METALET_HOST}/wallet-api/v3/tx/broadcast`;
  const data = await fetchPost<string>(url, { chain: 'btc', net: NET, rawTx });
  if (!data || typeof data !== 'string') throw new Error('BTC broadcast failed');
  return data;
}

/** Safe error message extraction without relying on instanceof Error (avoids cross-realm issues). */
function getErrorMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

/**
 * Run MVC transfer in a subprocess worker to avoid meta-contract "instanceof" issues in Electron main.
 * The worker owns UTXO selection + broadcast retries and returns the final txid.
 */
async function runMvcTransferWorker(params: {
  mnemonic: string;
  path: string;
  toAddress: string;
  amountSats: number;
  feeRate: number;
}): Promise<{ success: true; txId: string } | { success: false; error: string }> {
  const appPath = app.getAppPath();
  const candidatePaths = [
    path.join(__dirname, '..', 'libs', 'transferMvcWorker.js'),
    path.join(appPath, 'dist-electron', 'libs', 'transferMvcWorker.js'),
    path.join(appPath, 'libs', 'transferMvcWorker.js'),
  ];
  const workerPathResolved = candidatePaths.find((p) => fs.existsSync(p)) ?? candidatePaths[0];
  if (!fs.existsSync(workerPathResolved)) {
    console.error('[Transfer] transferMvcWorker.js not found. Tried:', candidatePaths);
    return { success: false, error: 'Transfer worker not found. Run npm run compile:electron.' };
  }
  const workerPath = path.isAbsolute(workerPathResolved) ? workerPathResolved : path.resolve(appPath, workerPathResolved);
  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete baseEnv.NODE_PATH;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    IDBOTS_METABOT_MNEMONIC: params.mnemonic,
    IDBOTS_METABOT_PATH: params.path,
  };
  const electronExe = resolveElectronExecutablePath();
  if (!electronExe || !fs.existsSync(electronExe)) {
    console.error('[Transfer] Electron executable not found for worker');
    return { success: false, error: 'Electron executable not found' };
  }
  const spawnCwd = app.getPath('userData');
  const payloadStr = JSON.stringify({
    toAddress: params.toAddress,
    amountSats: params.amountSats,
    feeRate: params.feeRate,
  });

  return new Promise((resolve) => {
    const child = spawn(electronExe, [workerPath], {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.stdin?.write(payloadStr, () => child.stdin?.end());
    child.on('error', (err) => {
      console.error('[Transfer] MVC worker spawn error:', getErrorMessage(err));
      resolve({ success: false, error: getErrorMessage(err) });
    });
    child.on('close', (code) => {
      const output = stdout.trim() || stderr.trim();
      if (stderr.trim()) console.log('[Transfer] MVC worker stderr:', stderr.trim());
      if (code !== 0) console.error('[Transfer] MVC worker exit code:', code, 'stderr:', stderr || '(none)');
      try {
        const result = JSON.parse(output) as { success: boolean; txId?: string; error?: string };
        if (result.success && result.txId) {
          resolve({ success: true, txId: result.txId });
        } else {
          resolve({ success: false, error: result.error || 'Worker did not return txId' });
        }
      } catch (e) {
        console.error('[Transfer] MVC worker output parse failed:', output);
        resolve({ success: false, error: output || getErrorMessage(e) });
      }
    });
  });
}

/**
 * Execute SPACE (MVC) or DOGE transfer. Does not implement BTC.
 * MVC uses a subprocess worker to avoid meta-contract instanceof issues in Electron main.
 */
export async function executeTransfer(
  store: MetabotStore,
  params: {
    metabotId: number;
    chain: TransferChain;
    toAddress: string;
    amountSpaceOrDoge: string;
    feeRate: number;
  }
): Promise<ExecuteTransferResult> {
  console.log('[Transfer] executeTransfer start', {
    chain: params.chain,
    metabotId: params.metabotId,
    toAddress: params.toAddress,
    amountSpaceOrDoge: params.amountSpaceOrDoge,
    feeRate: params.feeRate,
  });
  const wallet = store.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    console.error('[Transfer] Wallet not found for metabot', params.metabotId);
    return { success: false, error: 'Wallet not found' };
  }
  const addressIndex = parseAddressIndexFromPath(wallet.path ?? "m/44'/10001'/0'/0/0");

  try {
    if (params.chain === 'mvc') {
      console.log('[Transfer] MVC: queueing governed spend job', {
        metabotId: params.metabotId,
        action: 'mvc_transfer',
      });
      return getMvcSpendCoordinator().runMvcSpendJob({
        metabotId: params.metabotId,
        action: 'mvc_transfer',
        execute: async () => {
          const amountSats = Math.floor(new Decimal(params.amountSpaceOrDoge).mul(SPACE_TO_SATS).toNumber());
          console.log('[Transfer] MVC: running worker', { amountSats, feeRate: params.feeRate, toAddress: params.toAddress });
          const workerResult = await runMvcTransferWorker({
            mnemonic: wallet.mnemonic,
            path: wallet.path ?? "m/44'/10001'/0'/0/0",
            toAddress: params.toAddress,
            amountSats,
            feeRate: params.feeRate,
          });
          if (!workerResult.success) {
            const errMsg = (workerResult as { success: false; error: string }).error;
            console.error('[Transfer] MVC worker failed:', errMsg);
            return { success: false, error: errMsg };
          }
          const txId = (workerResult as { success: true; txId: string }).txId;
          console.log('[Transfer] MVC governed spend completed', {
            metabotId: params.metabotId,
            txId,
          });
          return { success: true, txId };
        },
      });
    }

    if (params.chain === 'doge') {
      const amountSatoshis = Math.floor(new Decimal(params.amountSpaceOrDoge).mul(SATOSHI_PER_UNIT).toNumber());
      if (amountSatoshis < MIN_DOGE_TRANSFER_SATOSHIS) {
        return { success: false, error: 'Minimum transfer is 0.01 DOGE' };
      }
      console.log('[Transfer] DOGE: signing', { amountSatoshis, feeRate: params.feeRate });
      const dogeWallet = await getDogeWallet(wallet.mnemonic, addressIndex);
      const address = dogeWallet.getAddress();
      const utxos = await fetchDogeUtxosForSign(address);
      if (utxos.length === 0) {
        console.error('[Transfer] DOGE: no UTXOs');
        return { success: false, error: 'No UTXOs available' };
      }
      const { txId, rawTx } = await dogeWallet.signTransaction({
        utxos,
        outputs: [{ address: params.toAddress, satoshis: amountSatoshis }],
        feeRate: params.feeRate,
        changeAddress: address,
      });
      const broadcastTxId = await broadcastDogeTx(rawTx);
      console.log('[Transfer] DOGE success txId:', broadcastTxId ?? txId);
      return { success: true, txId: broadcastTxId ?? txId };
    }

    if (params.chain === 'btc') {
      const amountSatoshis = Math.floor(new Decimal(params.amountSpaceOrDoge).mul(SATOSHI_PER_UNIT).toNumber());
      if (amountSatoshis < 546) return { success: false, error: 'Minimum transfer is 546 satoshis' };
      console.log('[Transfer] BTC: signing', { amountSatoshis, feeRate: params.feeRate });
      const btcWallet = getBtcWalletForTransfer(wallet.mnemonic, addressIndex);
      const btcAddress = btcWallet.getAddress();
      const utxos = await fetchBtcUtxosForTransfer(btcAddress);
      if (utxos.length === 0) return { success: false, error: 'No BTC UTXOs available' };
      const { rawTx: btcRawTx } = btcWallet.signTx(SignType.SEND, {
        utxos: utxos as any,
        outputs: [{ address: params.toAddress, satoshis: amountSatoshis }],
        feeRate: params.feeRate,
        changeAddress: btcAddress,
      });
      const broadcastTxId = await broadcastBtcTx(btcRawTx);
      console.log('[Transfer] BTC success txId:', broadcastTxId);
      return { success: true, txId: broadcastTxId };
    }

    return { success: false, error: 'Unsupported chain' };
  } catch (err) {
    const message = getErrorMessage(err);
    console.error('[Transfer] executeTransfer error:', message);
    return { success: false, error: message };
  }
}
