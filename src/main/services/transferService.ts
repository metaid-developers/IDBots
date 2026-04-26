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
import {
  clearMvcExcludedOutpoints,
  getMvcCachedFundingOutpointKey,
  getMvcSpendSessionSnapshot,
  normalizeMvcCachedFundingUtxo,
  recordMvcSpentOutpoints,
  replaceMvcPendingFundingUtxos,
} from './mvcSpendSessionState';
import {
  mergeMvcFundingCandidates,
  recoverMvcFundingCandidatesFromPinHistory,
} from './mvcFundingRecoveryService';
import { broadcastBtcTx as broadcastBtcTxViaProvider, fetchBtcUtxos as fetchBtcUtxosViaProvider } from '../libs/btcApi';

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

interface MvcCachedFundingUtxo {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  height: number;
}

interface MvcPendingFundingCacheEntry extends MvcCachedFundingUtxo {
  createdAt: number;
}

interface MvcSpendSessionState {
  excludedOutpoints: Map<string, number>;
  pendingFundingUtxos: MvcPendingFundingCacheEntry[];
}

type MvcTransferSessionSnapshot = {
  excludeOutpoints: string[];
  preferredFundingUtxos: MvcCachedFundingUtxo[];
};

type MvcTransferFundingRecovery = typeof recoverMvcFundingCandidatesFromPinHistory;

type MvcTransferSessionStore = Pick<
  MetabotStore,
  'getMetabotById' | 'listRecentPinTransactionsByAddress'
>;

type BuildMvcTransferSessionSnapshot = (
  metabotStore: MvcTransferSessionStore,
  metabotId: number,
) => Promise<MvcTransferSessionSnapshot>;

interface MvcTransferWorkerSuccess {
  success: true;
  txId: string;
  spentOutpoints?: string[];
  changeUtxo?: MvcCachedFundingUtxo | null;
}

interface MvcTransferWorkerFailure {
  success: false;
  error: string;
  staleOutpoints?: string[];
  requestedSats?: number;
  spendableSats?: number;
}

function isMvcProviderStaleFundingMessage(message: string): boolean {
  return String(message || '').includes('MVC funding inputs are stale on the provider');
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
  return await fetchBtcUtxosViaProvider(address, true);
}

async function broadcastBtcTx(rawTx: string): Promise<string> {
  return await broadcastBtcTxViaProvider(rawTx);
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
  excludeOutpoints?: string[];
  preferredFundingUtxos?: MvcCachedFundingUtxo[];
}): Promise<MvcTransferWorkerSuccess | MvcTransferWorkerFailure> {
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
    excludeOutpoints: params.excludeOutpoints ?? [],
    preferredFundingUtxos: params.preferredFundingUtxos ?? [],
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
      if (!output) {
        resolve({ success: false, error: 'MVC worker returned empty output' });
        return;
      }
      const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? output;
      try {
        const result = JSON.parse(lastLine) as Record<string, unknown>;
        if (result.success === true && result.txId) {
          resolve({
            success: true,
            txId: String(result.txId),
            spentOutpoints: Array.isArray(result.spentOutpoints) ? result.spentOutpoints : undefined,
            changeUtxo: normalizeMvcCachedFundingUtxo(result.changeUtxo) ?? null,
          });
        } else {
          resolve({
            success: false,
            error: String(result.error || 'Worker did not return txId'),
            staleOutpoints: Array.isArray(result.staleOutpoints) ? result.staleOutpoints : undefined,
            requestedSats: Number.isFinite(Number(result.requestedSats)) ? Number(result.requestedSats) : undefined,
            spendableSats: Number.isFinite(Number(result.spendableSats)) ? Number(result.spendableSats) : undefined,
          });
        }
      } catch (e) {
        console.error('[Transfer] MVC worker output parse failed:', output);
        resolve({ success: false, error: output || getErrorMessage(e) });
      }
    });
  });
}

export async function buildMvcTransferSessionSnapshot(
  metabotStore: MvcTransferSessionStore,
  metabotId: number,
  options: {
    recoverMvcFundingCandidates?: MvcTransferFundingRecovery;
  } = {},
): Promise<MvcTransferSessionSnapshot> {
  const sessionSnapshot = getMvcSpendSessionSnapshot(metabotId);
  if (sessionSnapshot.preferredFundingUtxos.length > 0) {
    return sessionSnapshot;
  }
  if (sessionSnapshot.excludeOutpoints.length === 0) {
    return sessionSnapshot;
  }

  const metabot = metabotStore.getMetabotById(metabotId);
  const mvcAddress = String(metabot?.mvc_address || '').trim();
  if (!mvcAddress) {
    return sessionSnapshot;
  }

  const recentPinTransactions = metabotStore.listRecentPinTransactionsByAddress(mvcAddress, 8);
  if (recentPinTransactions.length === 0) {
    return sessionSnapshot;
  }

  const recoverMvcFundingCandidates =
    options.recoverMvcFundingCandidates ?? recoverMvcFundingCandidatesFromPinHistory;
  let recoveredFundingUtxos: MvcCachedFundingUtxo[] = [];
  try {
    recoveredFundingUtxos = await recoverMvcFundingCandidates({
      address: mvcAddress,
      recentPinTransactions,
      excludedOutpoints: sessionSnapshot.excludeOutpoints,
      onRecoverError: ({ txid, error }) => {
        console.warn('[Transfer] MVC funding recovery tx probe failed', {
          metabotId,
          mvcAddress,
          txid,
          error,
        });
      },
    });
  } catch (error) {
    console.warn('[Transfer] MVC funding recovery failed; falling back to provider UTXOs', {
      metabotId,
      mvcAddress,
      error: getErrorMessage(error),
    });
    return sessionSnapshot;
  }

  if (recoveredFundingUtxos.length === 0) {
    return sessionSnapshot;
  }

  console.log('[Transfer] Recovered MVC funding candidates from local pin history', {
    metabotId,
    mvcAddress,
    recoveredOutpoints: recoveredFundingUtxos.map((utxo) => getMvcCachedFundingOutpointKey(utxo)),
  });

  return {
    excludeOutpoints: sessionSnapshot.excludeOutpoints,
    preferredFundingUtxos: mergeMvcFundingCandidates(
      sessionSnapshot.preferredFundingUtxos,
      recoveredFundingUtxos,
    ),
  };
}

export async function runMvcTransferWorkerWithSessionRecovery(params: {
  metabotStore: MvcTransferSessionStore;
  metabotId: number;
  buildSessionSnapshot?: BuildMvcTransferSessionSnapshot;
  runWorkerForSession: (
    sessionSnapshot: MvcTransferSessionSnapshot
  ) => Promise<MvcTransferWorkerSuccess | MvcTransferWorkerFailure>;
}): Promise<{
  workerResult: MvcTransferWorkerSuccess | MvcTransferWorkerFailure;
  sessionSnapshot: MvcTransferSessionSnapshot;
  retriedAfterStaleFunding: boolean;
}> {
  const buildSessionSnapshot = params.buildSessionSnapshot ?? buildMvcTransferSessionSnapshot;
  const initialSnapshot = await buildSessionSnapshot(params.metabotStore, params.metabotId);
  const initialResult = await params.runWorkerForSession(initialSnapshot);
  if (initialResult.success) {
    return {
      workerResult: initialResult,
      sessionSnapshot: initialSnapshot,
      retriedAfterStaleFunding: false,
    };
  }

  const initialFailure = initialResult as MvcTransferWorkerFailure;
  const staleOutpoints = Array.isArray(initialFailure.staleOutpoints)
    ? initialFailure.staleOutpoints
    : [];
  if (!isMvcProviderStaleFundingMessage(initialFailure.error) || staleOutpoints.length === 0) {
    return {
      workerResult: initialResult,
      sessionSnapshot: initialSnapshot,
      retriedAfterStaleFunding: false,
    };
  }

  recordMvcSpentOutpoints(params.metabotId, staleOutpoints);
  const recoveredSnapshot = await buildSessionSnapshot(params.metabotStore, params.metabotId);
  if (recoveredSnapshot.preferredFundingUtxos.length === 0) {
    return {
      workerResult: initialResult,
      sessionSnapshot: initialSnapshot,
      retriedAfterStaleFunding: false,
    };
  }

  const retryResult = await params.runWorkerForSession(recoveredSnapshot);
  return {
    workerResult: retryResult,
    sessionSnapshot: recoveredSnapshot,
    retriedAfterStaleFunding: true,
  };
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
          const workerSessionResult = await runMvcTransferWorkerWithSessionRecovery({
            metabotStore: store,
            metabotId: params.metabotId,
            runWorkerForSession: async (sessionSnapshot) => {
              console.log('[Transfer] MVC: running worker', {
                amountSats,
                feeRate: params.feeRate,
                toAddress: params.toAddress,
                excludedOutpoints: sessionSnapshot.excludeOutpoints,
                preferredFundingOutpoints: sessionSnapshot.preferredFundingUtxos.map((utxo) => getMvcCachedFundingOutpointKey(utxo)),
              });
              return runMvcTransferWorker({
                mnemonic: wallet.mnemonic,
                path: wallet.path ?? "m/44'/10001'/0'/0/0",
                toAddress: params.toAddress,
                amountSats,
                feeRate: params.feeRate,
                excludeOutpoints: sessionSnapshot.excludeOutpoints,
                preferredFundingUtxos: sessionSnapshot.preferredFundingUtxos,
              });
            },
          });
          const workerResult = workerSessionResult.workerResult;
          if (workerSessionResult.retriedAfterStaleFunding) {
            console.log('[Transfer] MVC: retried worker with recovered funding after stale provider state', {
              metabotId: params.metabotId,
              success: workerResult.success,
            });
          }
          if (workerResult.success) {
            const successResult = workerResult as MvcTransferWorkerSuccess;
            recordMvcSpentOutpoints(params.metabotId, successResult.spentOutpoints);
            replaceMvcPendingFundingUtxos(params.metabotId, successResult.changeUtxo);
            const txId = successResult.txId;
            console.log('[Transfer] MVC governed spend completed', {
              metabotId: params.metabotId,
              txId,
              spentOutpoints: successResult.spentOutpoints ?? [],
              changeOutpoint: successResult.changeUtxo
                ? getMvcCachedFundingOutpointKey(successResult.changeUtxo)
                : null,
            });
            return { success: true, txId };
          } else {
            const failureResult = workerResult as MvcTransferWorkerFailure;
            const isInsufficient = String(failureResult.error || '').toLowerCase().includes('not enough balance');
            if (isInsufficient) {
              // Provider balance/index state may have drifted; do not carry stale exclusions across requests.
              clearMvcExcludedOutpoints(params.metabotId);
            } else {
              recordMvcSpentOutpoints(params.metabotId, failureResult.staleOutpoints);
            }
            let errMsg = failureResult.error;
            if (
              isInsufficient
              && Number.isFinite(failureResult.requestedSats)
              && Number.isFinite(failureResult.spendableSats)
            ) {
              const requested = new Decimal(failureResult.requestedSats as number).div(SATOSHI_PER_UNIT).toFixed(8);
              const spendable = new Decimal(failureResult.spendableSats as number).div(SATOSHI_PER_UNIT).toFixed(8);
              errMsg = `${failureResult.error} (requested ${requested} SPACE, spendable ${spendable} SPACE with current provider UTXOs)`;
            }
            console.error('[Transfer] MVC worker failed:', errMsg, {
              staleOutpoints: failureResult.staleOutpoints ?? [],
              requestedSats: failureResult.requestedSats,
              spendableSats: failureResult.spendableSats,
            });
            return { success: false, error: errMsg };
          }
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
