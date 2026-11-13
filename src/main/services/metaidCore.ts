/**
 * MetaID Core Service: create Pin via worker subprocess.
 * Spawns src/main/libs/createPinWorker (compiled to dist-electron) with ELECTRON_RUN_AS_NODE
 * to avoid meta-contract "instanceof" issues in the main process. Uses app.getPath('exe') on
 * Electron so the correct executable path is used on Windows and macOS (avoids process.execPath
 * returning wrong name e.g. "lDBots.exe" on Windows).
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { MetabotStore } from '../metabotStore';
import { resolveElectronExecutablePath } from '../libs/runtimePaths';
import { fetchFromLocalOrFallback } from './localIndexerProxy';
import { getMvcSpendCoordinator } from './mvcSpendCoordinator';
import {
  clearMvcExcludedOutpoints,
  getMvcSpendSessionSnapshot,
  normalizeMvcCachedFundingUtxo,
  recordMvcSpentOutpoints,
  replaceMvcPendingFundingUtxos,
  type MvcCachedFundingUtxo,
} from './mvcSpendSessionState';
import {
  mergeMvcFundingCandidates,
  recoverMvcFundingCandidatesFromAddressHistory,
  recoverMvcFundingCandidatesFromPinHistory,
  fetchMvcAddressUtxos,
  filterRecoveredCandidatesByProvider,
} from './mvcFundingRecoveryService';
import { buildMetabotInfoPayloads, buildMetabotHomepagePayload, type MetabotInfoPayload } from './metabotInfoPayload';
import { OWNER_BINDING_PATH } from './ownerBindingService';
import { requestMvcGasSubsidy } from './mvcSubsidyService';
import { getMainWorkerCandidatePaths, resolveMainWorkerPath } from './workerPathResolver';
import { runMvcSponsorCreatePin, TrafficInsufficientError, type CreatePinFeeAssistMetadata } from './mvcSponsorCreatePin';
import { recordChainWriteFromCreatePin } from '../libs/chainWriteLedger';
import { assertChainWritePinRefs } from '../libs/chainPinRefGuard';
import { getConfiguredTrafficApiBase, isLegacyTrafficUserWithoutIdentity, resolveSponsorTrafficAccount } from './trafficAccountService';
import { deriveMvcSponsorAddress, type MvcSponsorTrafficAccount } from './mvcSponsorClient';
import { appendMetaidLog } from './metaidLog';
import {
  getTrafficFallbackPolicy,
  getTrafficPinMode,
  isMeTrafficBillingAllowed,
  type TrafficSettingsReader,
} from './trafficSettings';
import { resolveCreatePinFeeRate } from './feeRateStore';
import {
  buildNftAvatarDeclarationPayload,
  NFT_AVATAR_PATH,
  parseNftAvatarReference,
  prepareNftAvatarForIdentity,
} from './nftAvatarService';

const MANAPI_BASE = 'https://manapi.metaid.io';

function getErrorMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

export type Operation = 'init' | 'create' | 'modify' | 'revoke';

/** MetaID 7-tuple payload (SDD format). */
export interface MetaidDataPayload {
  operation: Operation;
  path?: string;
  encryption?: '0' | '1' | '2';
  version?: string;
  contentType?: string;
  /** Payload as string or Buffer. When Buffer, will be sent as base64 with encoding. */
  payload: string | Buffer;
  /** Encoding for string payload: 'utf-8' (default) or 'base64' (for binary). */
  encoding?: 'utf-8' | 'base64';
}

/** Supported network for createPin. Default 'mvc' for backward compatibility. */
export type CreatePinNetwork = 'mvc' | 'doge' | 'btc' | 'opcat';

export interface CreatePinWorkerDraftResult {
  unsignedTxHex: string;
  /** Upper-bound size estimate including one reserved sponsor input. */
  estimatedTxSize: number;
  feeRate: number;
  userInputs: MvcCachedFundingUtxo[];
  changeOutput: { outputIndex: number; satoshis: number } | null;
}

export interface CreatePinWorkerSuccess {
  txids: string[];
  pinId: string;
  totalCost: number;
  spentOutpoints?: string[];
  changeUtxo?: MvcCachedFundingUtxo | null;
  /** Present only when the worker ran in draft mode (MVC sponsor flow). */
  draft?: CreatePinWorkerDraftResult;
}

export interface CreatePinOptions {
  feeRate?: number;
  network?: CreatePinNetwork | string;
  /** Worker mode: 'broadcast' (default) or 'draft' (MVC sponsor flow, internal use). */
  mode?: 'broadcast' | 'draft';
  /** Per-call override of the global traffic.mode setting; MVC only. */
  sponsorMode?: 'traffic' | 'selfpay';
  /** Per-call override of the global traffic.fallbackPolicy setting; MVC only. */
  sponsorFallbackPolicy?: 'selfpay' | 'strict';
  /** Custom sponsor service base URL (defaults to the production assist-open-api). */
  sponsorBaseUrl?: string;
  /** fetch implementation override for the sponsor protocol (mainly tests). */
  sponsorFetchImpl?: typeof fetch;
  /** Explicit trafficAccount block for the sponsor pre (skips the resolver; mainly tests). */
  sponsorTrafficAccount?: MvcSponsorTrafficAccount;
  /**
   * Ledger tag: which caller/flow published this pin (e.g. 'rpc',
   * 'tool:post_buzz', 'internal:metaapp'). Recorded into
   * metabot_chain_writes.origin by the chain write ledger; internal origins
   * are excluded from the ledger entirely (see libs/chainWriteLedger.ts).
   */
  origin?: string;
}

/** createPin result: the worker fields plus optional fee-assist diagnostics. */
export type CreatePinResult = CreatePinWorkerSuccess & { feeAssist?: CreatePinFeeAssistMetadata };

interface CreatePinWorkerOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type MvcCreatePinSessionSnapshot = {
  excludeOutpoints: string[];
  preferredFundingUtxos: MvcCachedFundingUtxo[];
};

type MvcCreatePinFundingRecovery = typeof recoverMvcFundingCandidatesFromPinHistory;
type MvcCreatePinAddressHistoryFundingRecovery = typeof recoverMvcFundingCandidatesFromAddressHistory;

type MvcCreatePinSessionStore = Pick<
  MetabotStore,
  'getMetabotById' | 'listRecentPinTransactionsByAddress'
>;

type BuildMvcCreatePinSessionSnapshot = (
  metabotStore: MvcCreatePinSessionStore,
  metabotId: number,
) => Promise<MvcCreatePinSessionSnapshot>;

function isMvcInsufficientBalanceMessage(message: string): boolean {
  return /not enough balance|余额不足/i.test(message);
}

function isTerminalMvcStaleFundingMessage(message: string): boolean {
  return String(message || '').includes('所有已知 MVC 手续费输入都已失效');
}

function isMvcProviderStaleFundingMessage(message: string): boolean {
  return String(message || '').includes('MVC funding inputs are stale on the provider');
}

function getMvcWorkerStaleOutpoints(error: unknown): string[] | undefined {
  const candidate = error as { staleOutpoints?: unknown };
  return Array.isArray(candidate?.staleOutpoints)
    ? candidate.staleOutpoints.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function createTerminalMvcStaleFundingError(staleOutpoints: readonly string[]): Error & { staleOutpoints?: string[] } {
  const normalizedStaleOutpoints = Array.from(new Set(
    staleOutpoints
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean),
  ));
  const error = new Error(
    '所有已知 MVC 手续费输入都已失效，且当前没有获取到新的可花费 UTXO。'
    + ' 请先向该 MetaBot 的 MVC 地址转入一笔新的小额 SPACE，等待钱包/索引刷新后再重试。'
  ) as Error & { staleOutpoints?: string[] };
  error.staleOutpoints = normalizedStaleOutpoints;
  return error;
}

function parseJsonLineFromWorkerOutput(output: string): Record<string, unknown> | null {
  const lines = String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

function readWorkerRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCreatePinWorkerResult(output: CreatePinWorkerOutput): CreatePinWorkerSuccess {
  const result = parseJsonLineFromWorkerOutput(output.stdout)
    ?? parseJsonLineFromWorkerOutput(output.stderr);
  if (result?.success === true && result.mode === 'draft' && typeof result.unsignedTxHex === 'string' && result.unsignedTxHex) {
    const userInputs = Array.isArray(result.userInputs)
      ? result.userInputs
        .map((item) => normalizeMvcCachedFundingUtxo(item))
        .filter((item): item is MvcCachedFundingUtxo => item !== null)
      : [];
    const changeOutputRecord = readWorkerRecord(result.changeOutput);
    const changeOutputIndex = Number(changeOutputRecord?.outputIndex);
    const changeOutputSatoshis = Number(changeOutputRecord?.satoshis);
    const changeOutput = changeOutputRecord
      && Number.isInteger(changeOutputIndex)
      && changeOutputIndex >= 0
      && Number.isFinite(changeOutputSatoshis)
      && changeOutputSatoshis >= 600
      ? { outputIndex: changeOutputIndex, satoshis: changeOutputSatoshis }
      : null;
    return {
      txids: [],
      pinId: '',
      totalCost: 0,
      spentOutpoints: Array.isArray(result.spentOutpoints)
        ? result.spentOutpoints.filter((item): item is string => typeof item === 'string')
        : undefined,
      changeUtxo: null,
      draft: {
        unsignedTxHex: result.unsignedTxHex,
        estimatedTxSize: Number.isFinite(Number(result.estimatedTxSize)) ? Number(result.estimatedTxSize) : 0,
        feeRate: Number.isFinite(Number(result.feeRate)) ? Number(result.feeRate) : 0,
        userInputs,
        changeOutput,
      },
    };
  }
  if (result?.success === true && Array.isArray(result.txids)) {
    const txids = result.txids.map((item) => String(item || '').trim()).filter(Boolean);
    if (txids.length > 0) {
      const pinId = String(result.pinId || `${txids[0]}i0`);
      appendMetaidLog('INFO', 'createPin success', { txid: txids[0], pinId });
      return {
        txids,
        pinId,
        totalCost: Number.isFinite(Number(result.totalCost)) ? Number(result.totalCost) : 0,
        spentOutpoints: Array.isArray(result.spentOutpoints)
          ? result.spentOutpoints.filter((item): item is string => typeof item === 'string')
          : undefined,
        changeUtxo: (result.changeUtxo as MvcCachedFundingUtxo | null | undefined) ?? null,
      };
    }
  }

  const message = result
    ? String(result.error || 'Worker failed')
    : (output.stderr.trim() || output.stdout.trim() || `Worker exited with code ${output.exitCode}`);
  const error = new Error(message) as Error & {
    staleOutpoints?: string[];
    requestedSats?: number;
    spendableSats?: number;
  };
  if (Array.isArray(result?.staleOutpoints)) {
    error.staleOutpoints = result.staleOutpoints.filter((item): item is string => typeof item === 'string');
  }
  if (Number.isFinite(Number(result?.requestedSats))) {
    error.requestedSats = Number(result?.requestedSats);
  }
  if (Number.isFinite(Number(result?.spendableSats))) {
    error.spendableSats = Number(result?.spendableSats);
  }
  throw error;
}

export const parseCreatePinWorkerResultForTests = parseCreatePinWorkerResult;

export async function buildMvcCreatePinSessionSnapshot(
  metabotStore: MvcCreatePinSessionStore,
  metabotId: number,
  options: {
    recoverMvcFundingCandidates?: MvcCreatePinFundingRecovery;
    recoverMvcAddressHistoryFundingCandidates?: MvcCreatePinAddressHistoryFundingRecovery;
  } = {},
): Promise<MvcCreatePinSessionSnapshot> {
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

  const recoverMvcFundingCandidates =
    options.recoverMvcFundingCandidates ?? recoverMvcFundingCandidatesFromPinHistory;
  let recoveredFundingUtxos: MvcCachedFundingUtxo[] = [];
  const recentPinTransactions = metabotStore.listRecentPinTransactionsByAddress(mvcAddress, 8);
  if (recentPinTransactions.length > 0) {
    try {
      recoveredFundingUtxos = await recoverMvcFundingCandidates({
        address: mvcAddress,
        recentPinTransactions,
        excludedOutpoints: sessionSnapshot.excludeOutpoints,
        onRecoverError: ({ txid, error }) => {
          appendMetaidLog('WARN', 'MVC createPin funding recovery tx probe failed', {
            metabot_id: metabotId,
            mvcAddress,
            txid,
            error,
          });
        },
      });
    } catch (error) {
      appendMetaidLog('WARN', 'MVC createPin funding recovery failed; falling back to provider UTXOs', {
        metabot_id: metabotId,
        mvcAddress,
        error: getErrorMessage(error),
      });
    }
  }

  if (recoveredFundingUtxos.length === 0) {
    const recoverMvcAddressHistoryFundingCandidates =
      options.recoverMvcAddressHistoryFundingCandidates ?? recoverMvcFundingCandidatesFromAddressHistory;
    try {
      recoveredFundingUtxos = await recoverMvcAddressHistoryFundingCandidates({
        address: mvcAddress,
        excludedOutpoints: sessionSnapshot.excludeOutpoints,
        onRecoverError: ({ txid, error }) => {
          appendMetaidLog('WARN', 'MVC createPin address-history funding recovery tx probe failed', {
            metabot_id: metabotId,
            mvcAddress,
            txid,
            error,
          });
        },
      });
    } catch (error) {
      appendMetaidLog('WARN', 'MVC createPin address-history funding recovery failed; falling back to provider UTXOs', {
        metabot_id: metabotId,
        mvcAddress,
        error: getErrorMessage(error),
      });
    }
  }

  if (recoveredFundingUtxos.length === 0) {
    appendMetaidLog('INFO', 'MVC createPin funding recovery found no usable local candidates', {
      metabot_id: metabotId,
      mvcAddress,
      recentPinTransactions: recentPinTransactions.map((item) => item.txid),
      excludedOutpoints: sessionSnapshot.excludeOutpoints,
    });
    return sessionSnapshot;
  }

  appendMetaidLog('INFO', 'Recovered MVC createPin funding candidates from local pin history', {
    metabot_id: metabotId,
    mvcAddress,
    recoveredOutpoints: recoveredFundingUtxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
  });

  // Cross-reference recovered candidates against the live provider to filter out phantom
  // UTXOs from dropped/rejected transactions.
  let providerValidatedUtxos = recoveredFundingUtxos;
  try {
    const providerUtxos = await fetchMvcAddressUtxos(mvcAddress);
    const providerOutpoints = new Set(providerUtxos.map((u) => `${u.txId}:${u.outputIndex}`));
    providerValidatedUtxos = filterRecoveredCandidatesByProvider(recoveredFundingUtxos, providerUtxos);
    if (providerValidatedUtxos.length < recoveredFundingUtxos.length) {
      appendMetaidLog('WARN', 'Filtered out phantom recovered UTXOs not confirmed by provider', {
        metabot_id: metabotId,
        mvcAddress,
        providerOutpoints: Array.from(providerOutpoints),
        recoveredOutpoints: recoveredFundingUtxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
        validatedOutpoints: providerValidatedUtxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
      });
    }
  } catch (error) {
    appendMetaidLog('WARN', 'Failed to cross-reference recovered UTXOs against provider; using all recovered', {
      metabot_id: metabotId,
      mvcAddress,
      error: getErrorMessage(error),
    });
  }

  if (providerValidatedUtxos.length === 0) {
    return sessionSnapshot;
  }

  return {
    excludeOutpoints: sessionSnapshot.excludeOutpoints,
    preferredFundingUtxos: mergeMvcFundingCandidates(
      sessionSnapshot.preferredFundingUtxos,
      providerValidatedUtxos,
    ),
  };
}

export async function runMvcCreatePinWorkerWithSessionRecovery(params: {
  metabotStore: MvcCreatePinSessionStore;
  metabotId: number;
  buildSessionSnapshot?: BuildMvcCreatePinSessionSnapshot;
  requestFreshFunding?: () => Promise<boolean>;
  runWorkerForSession: (
    sessionSnapshot: MvcCreatePinSessionSnapshot
  ) => Promise<CreatePinWorkerSuccess>;
}): Promise<{
  workerResult: CreatePinWorkerSuccess;
  sessionSnapshot: MvcCreatePinSessionSnapshot;
  retriedAfterStaleFunding: boolean;
  requestedFreshFundingAfterStale: boolean;
}> {
  const buildSessionSnapshot = params.buildSessionSnapshot ?? buildMvcCreatePinSessionSnapshot;
  const initialSnapshot = await buildSessionSnapshot(params.metabotStore, params.metabotId);
  try {
    const workerResult = await params.runWorkerForSession(initialSnapshot);
    return {
      workerResult,
      sessionSnapshot: initialSnapshot,
      retriedAfterStaleFunding: false,
      requestedFreshFundingAfterStale: false,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    const staleOutpoints = getMvcWorkerStaleOutpoints(error) ?? [];
    if (!isMvcProviderStaleFundingMessage(message) || staleOutpoints.length === 0) {
      throw error;
    }

    recordMvcSpentOutpoints(params.metabotId, staleOutpoints);
    let latestStaleError = error;
    const recoveredSnapshot = await buildSessionSnapshot(params.metabotStore, params.metabotId);
    if (recoveredSnapshot.preferredFundingUtxos.length > 0) {
      try {
        const workerResult = await params.runWorkerForSession(recoveredSnapshot);
        return {
          workerResult,
          sessionSnapshot: recoveredSnapshot,
          retriedAfterStaleFunding: true,
          requestedFreshFundingAfterStale: false,
        };
      } catch (retryError) {
        const retryMessage = getErrorMessage(retryError);
        const retryStaleOutpoints = getMvcWorkerStaleOutpoints(retryError) ?? [];
        if (!isMvcProviderStaleFundingMessage(retryMessage) || retryStaleOutpoints.length === 0) {
          throw retryError;
        }
        latestStaleError = retryError;
        recordMvcSpentOutpoints(params.metabotId, retryStaleOutpoints);
      }
    }

    if (!params.requestFreshFunding) {
      clearMvcExcludedOutpoints(params.metabotId);
      throw createTerminalMvcStaleFundingError(getMvcSpendSessionSnapshot(params.metabotId).excludeOutpoints);
    }
    const requestedFreshFunding = await params.requestFreshFunding();
    if (!requestedFreshFunding) {
      clearMvcExcludedOutpoints(params.metabotId);
      throw createTerminalMvcStaleFundingError(getMvcSpendSessionSnapshot(params.metabotId).excludeOutpoints);
    }
    const refreshedSnapshot = await buildSessionSnapshot(params.metabotStore, params.metabotId);
    let workerResult: CreatePinWorkerSuccess;
    try {
      workerResult = await params.runWorkerForSession(refreshedSnapshot);
    } catch (refreshedError) {
      const refreshedMessage = getErrorMessage(refreshedError);
      const refreshedStaleOutpoints = getMvcWorkerStaleOutpoints(refreshedError) ?? [];
      if (isMvcProviderStaleFundingMessage(refreshedMessage) && refreshedStaleOutpoints.length > 0) {
        clearMvcExcludedOutpoints(params.metabotId);
        throw createTerminalMvcStaleFundingError(getMvcSpendSessionSnapshot(params.metabotId).excludeOutpoints);
      }
      throw refreshedError;
    }
    return {
      workerResult,
      sessionSnapshot: refreshedSnapshot,
      retriedAfterStaleFunding: true,
      requestedFreshFundingAfterStale: true,
    };
  }
}

export function resolveCreatePinNetwork(network?: CreatePinNetwork | string): CreatePinNetwork {
  return (
    (network != null && String(network).trim() !== '')
      ? String(network).toLowerCase().trim()
      : 'mvc'
  ) as CreatePinNetwork;
}

/**
 * Unified empty-wallet rescue for governed MVC createPin (2026-09-12). The
 * sponsored (traffic-mode) flow still drafts the pin from the bot wallet's
 * own UTXOs — the sponsor only covers the miner fee — so a bot with an empty
 * wallet failed BOTH the sponsored draft and the self-paid fallback with
 * "MetaBot 余额不足", even with a funded traffic account. Any governed MVC
 * pin that fails for insufficient bot-wallet funds now requests the Metaso
 * gas subsidy once, clears stale UTXO exclusions, and retries the whole
 * dispatch a single time, for every createPin caller (bot edit sync,
 * simplemsg, buzz, MetaApp publish, RPC writes) without per-callsite
 * wrappers. The original error is rethrown when the subsidy request fails.
 */
const MVC_SUBSIDY_SETTLE_MS = 3000;

export async function runMvcCreatePinWithInsufficientFundsRescue<T>(params: {
  metabotId: number;
  operation: string;
  path: string;
  requestFreshFunding: (trigger?: string) => Promise<boolean>;
  run: () => Promise<T>;
  /**
   * Wait after a granted subsidy before the retry. The subsidy payout is
   * broadcast by the service and can take a moment to reach the UTXO
   * provider; retrying in the same instant re-read an empty wallet (2026-11-13
   * first-run Twin: bio/persona/llm/chatSkills all failed "Not enough balance"
   * right after "Fresh MVC funding request ... succeeded").
   */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } catch (error) {
    const message = getErrorMessage(error);
    const isNoUserUtxoStrict =
      error instanceof TrafficInsufficientError && error.reason === 'no_user_utxo';
    if (!isNoUserUtxoStrict && !isMvcInsufficientBalanceMessage(message)) {
      throw error;
    }
    appendMetaidLog('WARN', 'MVC createPin failed for insufficient bot-wallet funds — requesting gas subsidy and retrying once', {
      metabot_id: params.metabotId,
      operation: params.operation,
      path: params.path,
      error: message,
    });
    const funded = await params.requestFreshFunding('insufficient bot-wallet funds');
    if (!funded) {
      throw error;
    }
    clearMvcExcludedOutpoints(params.metabotId);
    if ((params.settleMs ?? 0) > 0) await (params.sleep ?? sleep)(params.settleMs!);
    return params.run();
  }
}

/** Global kv reader for traffic settings; unset outside the app runtime => safe defaults. */
function getMetaidCoreKvReader(): TrafficSettingsReader | null {
  try {
    return storeGetter?.() ?? null;
  } catch {
    return null;
  }
}

export interface SpawnCreatePinWorkerParams {
  mnemonic: string;
  walletPath: string;
  metaidData: MetaidDataPayload;
  options?: CreatePinOptions;
  sessionSnapshot?: MvcCreatePinSessionSnapshot;
}

/**
 * Low-level createPin worker spawn shared by MetaBot pins (createPin) and
 * non-MetaBot identity pins (createPinForIdentity). Resolves the worker
 * bundle, forwards the mnemonic via env, spawns, and parses the result.
 */
export async function spawnCreatePinWorker(params: SpawnCreatePinWorkerParams): Promise<CreatePinWorkerSuccess> {
  const { mnemonic, walletPath, metaidData, options, sessionSnapshot } = params;

  // Pre-broadcast pin-reference guard: fail closed BEFORE the worker spawns —
  // a malformed pin://, metafile://, or metaapp:// reference in the payload
  // must never reach the chain (fee burned + a permanent invalid record).
  assertChainWritePinRefs(metaidData);

  // Worker lives under dist-electron/main/libs in Vite dev builds; keep legacy fallbacks for packaging.
  const appPath = app.getAppPath();
  const workerBasename = 'createPinWorker.js';
  const candidatePaths = getMainWorkerCandidatePaths({
    moduleDir: __dirname,
    appPath,
    workerBasename,
  });
  const workerPathResolved = resolveMainWorkerPath({
    moduleDir: __dirname,
    appPath,
    workerBasename,
    exists: fs.existsSync,
  });
  if (!workerPathResolved) {
    appendMetaidLog('ERROR', 'createPinWorker.js not found', { candidatePaths });
    throw new Error(
      `createPinWorker.js not found. Tried: ${candidatePaths.join(', ')}. Run "npm run compile:electron" and ensure IDBots is started from project root.`
    );
  }
  const workerPath = path.isAbsolute(workerPathResolved) ? workerPathResolved : path.resolve(appPath, workerPathResolved);

  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete baseEnv.NODE_PATH;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    IDBOTS_METABOT_MNEMONIC: mnemonic,
    IDBOTS_METABOT_PATH: walletPath,
  };

  const serializedPayload =
    typeof metaidData.payload === 'string'
      ? metaidData.payload
      : Buffer.isBuffer(metaidData.payload)
        ? metaidData.payload.toString('base64')
        : String(metaidData.payload);
  const encoding: 'utf-8' | 'base64' =
    Buffer.isBuffer(metaidData.payload) ? 'base64' : (metaidData.encoding ?? 'utf-8');

  const network = resolveCreatePinNetwork(options?.network);
  const payloadStr = JSON.stringify({
    feeRate: resolveCreatePinFeeRate(network, options?.feeRate),
    network,
    ...(options?.mode === 'draft' ? { mode: 'draft' } : {}),
    metaidData: {
      ...metaidData,
      payload: serializedPayload,
      encoding,
    },
  });

  // Use robust Electron executable resolution; some Windows installs can report
  // inconsistent process/app paths during first-run/update windows.
  const electronExe = resolveElectronExecutablePath();
  if (!electronExe || !fs.existsSync(electronExe)) {
    appendMetaidLog('ERROR', 'Electron executable not found for createPin worker', {
      electronExe,
      appExe: (() => {
        try {
          return app.getPath('exe');
        } catch {
          return null;
        }
      })(),
      processExecPath: process.execPath,
    });
    throw new Error(`Electron executable not found: ${electronExe || '(empty)'}`);
  }

  // Never use app.getAppPath() as cwd in packaged mode (it may be app.asar file).
  // A file cwd makes spawn fail with ENOENT/ENOTDIR on Windows first-run paths.
  const spawnCwd = app.getPath('userData');
  return new Promise<CreatePinWorkerSuccess>((resolve, reject) => {
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
    const workerPayload = JSON.stringify({
      ...JSON.parse(payloadStr),
      excludeOutpoints: sessionSnapshot?.excludeOutpoints ?? [],
      preferredFundingUtxos: sessionSnapshot?.preferredFundingUtxos ?? [],
    });
    child.stdin?.write(workerPayload, () => child.stdin?.end());
    child.on('error', (err) => {
      appendMetaidLog('ERROR', 'Worker spawn failed', { error: String(err) });
      reject(err);
    });
    child.on('close', (code) => {
      try {
        resolve(parseCreatePinWorkerResult({ stdout, stderr, exitCode: code }));
      } catch (error) {
        appendMetaidLog('ERROR', 'Worker output parse failed', {
          exitCode: code,
          stderr,
          stdout,
          message: getErrorMessage(error),
        });
        reject(error);
      }
    });
  });
}

/**
 * True when an identity pin goes through the sponsor: an MVC write on the
 * desktop with credits payment (积分支付, traffic mode) on. Server-mode tenants
 * keep identity pins wallet-paid this phase (D4 leaves tenant billing as is).
 */
export function isIdentityPinSponsored(input: {
  network?: CreatePinNetwork | string;
  reader: TrafficSettingsReader | null | undefined;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCreatePinNetwork(input.network) === 'mvc' && isMeTrafficBillingAllowed(input.reader, input.env);
}

/**
 * Create a pin for a non-MetaBot identity (e.g. the local human user identity).
 * Unlike createPin this bypasses the per-MetaBot MVC spend coordinator: the
 * caller owns serialization for the identity wallet and may thread
 * sessionSnapshot excludeOutpoints/preferredFundingUtxos between sequential pins.
 *
 * With credits payment on (isIdentityPinSponsored) the pin runs the same
 * sponsor flow as MetaBot pins: the identity address is bound to the user's
 * traffic account, so the write is billed to the account (ME credits once the
 * sponsor offers them) and falls back to the identity wallet on any sponsor
 * failure. The sponsored result carries spentOutpoints/changeUtxo like the
 * wallet-paid one, so the caller's session snapshot keeps working.
 */
export async function createPinForIdentity(params: {
  mnemonic: string;
  path?: string;
  metaidData: MetaidDataPayload;
  options?: { feeRate?: number; network?: CreatePinNetwork | string };
  sessionSnapshot?: MvcCreatePinSessionSnapshot;
}): Promise<CreatePinWorkerSuccess> {
  const mnemonic = params.mnemonic?.trim();
  if (!mnemonic) {
    throw new Error('Identity mnemonic is empty');
  }
  const walletPath = params.path || "m/44'/10001'/0'/0/0";
  const runBroadcastWorker = () => spawnCreatePinWorker({
    mnemonic,
    walletPath,
    metaidData: params.metaidData,
    options: params.options,
    sessionSnapshot: params.sessionSnapshot,
  });
  if (!isIdentityPinSponsored({ network: params.options?.network, reader: getMetaidCoreKvReader() })) {
    return runBroadcastWorker();
  }

  let identityAddress = '';
  try {
    identityAddress = deriveMvcSponsorAddress({ mnemonic, path: walletPath });
  } catch {
    // An empty address makes the sponsor flow fall back to the identity wallet.
  }
  appendMetaidLog('INFO', 'Attempting sponsored MVC createPin for the user identity (credits payment)', {
    mvcAddress: identityAddress,
    operation: params.metaidData.operation,
    path: params.metaidData.path || '',
  });
  return runMvcCreatePinWithInsufficientFundsRescue({
    metabotId: 0,
    operation: params.metaidData.operation,
    path: params.metaidData.path || '',
    settleMs: MVC_SUBSIDY_SETTLE_MS,
    requestFreshFunding: async () => {
      if (!identityAddress) return false;
      const subsidy = await requestMvcGasSubsidy({ mvcAddress: identityAddress, mnemonic, path: walletPath });
      return subsidy.success;
    },
    run: () => runMvcSponsorCreatePin(
      {
        // Not a MetaBot: 0 marks identity writes in the sponsor logs, which also carry mvcAddress.
        metabotId: 0,
        mnemonic,
        walletPath,
        mvcAddress: identityAddress,
        feeRate: resolveCreatePinFeeRate('mvc', params.options?.feeRate),
        fallbackPolicy: getTrafficFallbackPolicy(getMetaidCoreKvReader()),
        baseUrl: getConfiguredTrafficApiBase(),
        journalKind: params.metaidData.path || undefined,
      },
      {
        runDraftWorker: () => spawnCreatePinWorker({
          mnemonic,
          walletPath,
          metaidData: params.metaidData,
          options: { ...params.options, mode: 'draft' },
          sessionSnapshot: params.sessionSnapshot,
        }),
        runBroadcastWorker,
        // The caller threads spentOutpoints/changeUtxo from the result into its own snapshot.
        recordSpentOutpoints: () => {},
        replacePendingFundingUtxos: () => {},
        resolveTrafficAccount: ({ challengeId, billing }) => resolveSponsorTrafficAccount({
          botAddress: identityAddress,
          challengeId,
          botMnemonic: mnemonic,
          botWalletPath: walletPath,
          billing,
        }),
      },
    ),
  });
}

/**
 * Create Pin for a MetaBot: spawn skill worker with mnemonic, returns txids.
 * @param options.network - Target network: 'mvc' (default), 'doge', 'btc', 'opcat'. Omit or empty defaults to 'mvc'.
 * @param options.sponsorMode - MVC only: 'traffic' runs the sponsor-paid flow (draft -> pre -> sign -> commit),
 *   'selfpay' keeps the regular self-paid broadcast. Defaults to the global traffic.mode setting
 *   ('traffic' unless the user switched to MetaBot self-pay). Falls back per traffic.fallbackPolicy.
 *   Either way, a first insufficient-funds failure triggers one gas-subsidy rescue + retry
 *   (runMvcCreatePinWithInsufficientFundsRescue).
 */
export async function createPin(
  metabotStore: MetabotStore,
  metabot_id: number,
  metaidData: MetaidDataPayload,
  options?: CreatePinOptions
): Promise<CreatePinResult> {
  const wallet = metabotStore.getMetabotWalletByMetabotId(metabot_id);
  if (!wallet) {
    throw new Error(`MetaBot ${metabot_id} has no wallet`);
  }
  const mnemonic = wallet.mnemonic?.trim();
  if (!mnemonic) {
    throw new Error(`MetaBot ${metabot_id} wallet mnemonic is empty`);
  }

  const walletPath = wallet.path || "m/44'/10001'/0'/0/0";
  const network = resolveCreatePinNetwork(options?.network);

  if (network === 'mvc') {
    appendMetaidLog('INFO', 'Queueing governed MVC createPin job', {
      metabot_id,
      action: `createPin:${metaidData.path || metaidData.operation}`,
      operation: metaidData.operation,
      path: metaidData.path || '',
    });
    const result = await getMvcSpendCoordinator().runMvcSpendJob<CreatePinResult>({
      metabotId: metabot_id,
      action: `createPin:${metaidData.path || metaidData.operation}`,
      execute: async () => {
        const requestFreshFunding = async (trigger = 'stale createPin inputs') => {
          const metabot = metabotStore.getMetabotById(metabot_id);
          const mvcAddress = String(metabot?.mvc_address || '').trim();
          if (!mvcAddress) {
            return false;
          }
          appendMetaidLog('INFO', `Requesting fresh MVC funding after ${trigger}`, {
            metabot_id,
            mvcAddress,
            operation: metaidData.operation,
            path: metaidData.path || '',
          });
          const subsidy = await requestMvcGasSubsidy({
            mvcAddress,
            mnemonic,
            path: wallet.path || "m/44'/10001'/0'/0/0",
          });
          if (!subsidy.success) {
            appendMetaidLog('WARN', `Fresh MVC funding request after ${trigger} failed`, {
              metabot_id,
              mvcAddress,
              error: subsidy.error || 'Traffic subsidy request failed',
            });
            return false;
          }
          appendMetaidLog('INFO', `Fresh MVC funding request after ${trigger} succeeded`, {
            metabot_id,
            mvcAddress,
          });
          return true;
        };
        const runBroadcastWorker = async (): Promise<CreatePinWorkerSuccess> => {
          try {
            const workerSessionResult = await runMvcCreatePinWorkerWithSessionRecovery({
              metabotStore,
              metabotId: metabot_id,
              requestFreshFunding,
              runWorkerForSession: (sessionSnapshot) =>
                spawnCreatePinWorker({ mnemonic, walletPath, metaidData, options, sessionSnapshot }),
            });
            const result = workerSessionResult.workerResult;
            if (workerSessionResult.retriedAfterStaleFunding) {
              appendMetaidLog('INFO', 'Retried MVC createPin worker with recovered funding after stale provider state', {
                metabot_id,
                operation: metaidData.operation,
                path: metaidData.path || '',
                success: true,
                requestedFreshFundingAfterStale: workerSessionResult.requestedFreshFundingAfterStale,
              });
            }
            recordMvcSpentOutpoints(metabot_id, result.spentOutpoints);
            replaceMvcPendingFundingUtxos(metabot_id, result.changeUtxo);
            appendMetaidLog('INFO', 'Governed MVC createPin job completed', {
              metabot_id,
              txid: result.txids[0],
              pinId: result.pinId,
              spentOutpoints: result.spentOutpoints ?? [],
            });
            return result;
          } catch (error) {
            const message = getErrorMessage(error);
            if (isMvcInsufficientBalanceMessage(message) || isTerminalMvcStaleFundingMessage(message)) {
              clearMvcExcludedOutpoints(metabot_id);
            } else {
              recordMvcSpentOutpoints(metabot_id, getMvcWorkerStaleOutpoints(error));
            }
            appendMetaidLog('ERROR', 'Governed MVC createPin job failed', {
              metabot_id,
              error: message,
              operation: metaidData.operation,
              path: metaidData.path || '',
              staleOutpoints: getMvcWorkerStaleOutpoints(error) ?? [],
            });
            throw error;
          }
        };

        const runModeDispatch = async (): Promise<CreatePinResult> => {
          const sponsorMode = options?.sponsorMode ?? getTrafficPinMode(getMetaidCoreKvReader());
          if (sponsorMode !== 'traffic') {
            return runBroadcastWorker();
          }

          const sponsorMetabot = metabotStore.getMetabotById(metabot_id);
          const sponsorMvcAddress = String(sponsorMetabot?.mvc_address || '').trim();
          appendMetaidLog('INFO', 'Attempting sponsored MVC createPin (traffic mode)', {
            metabot_id,
            mvcAddress: sponsorMvcAddress,
            operation: metaidData.operation,
            path: metaidData.path || '',
          });
          const defaultFallbackPolicy = getTrafficFallbackPolicy(getMetaidCoreKvReader());
          const fallbackPolicy = options?.sponsorFallbackPolicy
            ?? (isLegacyTrafficUserWithoutIdentity() ? 'selfpay' : defaultFallbackPolicy);
          return runMvcSponsorCreatePin(
            {
              metabotId: metabot_id,
              mnemonic,
              walletPath,
              mvcAddress: sponsorMvcAddress,
              feeRate: resolveCreatePinFeeRate('mvc', options?.feeRate),
              fallbackPolicy,
              baseUrl: options?.sponsorBaseUrl ?? getConfiguredTrafficApiBase(),
              fetchImpl: options?.sponsorFetchImpl,
              trafficAccount: options?.sponsorTrafficAccount,
              journalKind: metaidData.path || undefined,
            },
            {
              runDraftWorker: async () => {
                const workerSessionResult = await runMvcCreatePinWorkerWithSessionRecovery({
                  metabotStore,
                  metabotId: metabot_id,
                  requestFreshFunding,
                  runWorkerForSession: (sessionSnapshot) =>
                    spawnCreatePinWorker({
                      mnemonic,
                      walletPath,
                      metaidData,
                      options: { ...options, mode: 'draft' },
                      sessionSnapshot,
                    }),
                });
                return workerSessionResult.workerResult;
              },
              runBroadcastWorker,
              recordSpentOutpoints: (outpoints) => recordMvcSpentOutpoints(metabot_id, outpoints),
              replacePendingFundingUtxos: (utxo) => replaceMvcPendingFundingUtxos(metabot_id, utxo),
              // Traffic-account billing (Phase D): resolves to undefined and keeps
              // the legacy quota path whenever the feature is off or unbound;
              // billing 'me' bills ME credits when the sponsor advertises it.
              resolveTrafficAccount: ({ challengeId, billing }) => resolveSponsorTrafficAccount({
                botAddress: sponsorMvcAddress,
                challengeId,
                botMnemonic: mnemonic,
                botWalletPath: walletPath,
                billing,
              }),
            },
          );
        };

        return runMvcCreatePinWithInsufficientFundsRescue<CreatePinResult>({
          metabotId: metabot_id,
          operation: metaidData.operation,
          path: metaidData.path || '',
          requestFreshFunding,
          run: runModeDispatch,
          settleMs: MVC_SUBSIDY_SETTLE_MS,
        });
      },
    });
    // Ledger: record the broadcast pin (no-op for draft-phase results, chat
    // paths, /info/* sync pins, and internal origins — see chainWriteLedger).
    recordChainWriteFromCreatePin(metabot_id, metaidData, result, options?.origin);
    return result;
  }

  const result = await spawnCreatePinWorker({ mnemonic, walletPath, metaidData, options });
  recordChainWriteFromCreatePin(metabot_id, metaidData, result, options?.origin);
  return result;
}

/** Sleep for ms milliseconds. Used between sequential chain ops to avoid UTXO double-spend. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract MIME type and raw base64 from data URL or return null. */
export function parseDataUrlAvatar(avatar: string | null | undefined): { mime: string; base64: string; buffer: Buffer } | null {
  if (!avatar || typeof avatar !== 'string') return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(avatar);
  if (!match) return null;
  const mime = match[1].trim().toLowerCase();
  const supportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  if (!supportedMimeTypes.has(mime)) return null;
  const base64 = match[2];
  if (!base64) return null;
  if (base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    return null;
  }
  try {
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0 || buffer.toString('base64') !== base64) {
      return null;
    }
    return { mime, base64, buffer };
  } catch {
    return null;
  }
}

export interface SyncMetaBotResult {
  success: boolean;
  error?: string;
  /** True when name pin succeeded but at least one optional Bot Info step failed; caller may allow skip. */
  canSkip?: boolean;
  /** Latest successful profile PinID among /info/bio, /info/persona, /info/llm, /info/chatSkills. */
  metabotInfoPinId?: string;
  /** PinID for /info/chatpubkey (chat_public_key_pin_id) */
  chatPublicKeyPinId?: string;
  /** TXIDs in attempted sync order. */
  txids?: string[];
  /** Step keys this sync planned to publish (create/partial reporting). */
  plannedSteps?: SyncMetaBotStep[];
  /** Step keys that actually confirmed on-chain (txid returned). */
  syncedSteps?: SyncMetaBotStep[];
}

export type SyncMetaBotStep = 'name' | 'avatar' | 'nftAvatar' | 'chatpubkey' | 'bio' | 'persona' | 'llm' | 'chatSkills' | 'homepage' | 'owner';
export type SyncMetaBotEditStep = Exclude<SyncMetaBotStep, 'chatpubkey'>;

export interface SyncMetaBotEditChangesInput {
  metabotId: number;
  syncName?: boolean;
  syncAvatar?: boolean;
  syncNftAvatar?: boolean;
  syncBio?: boolean;
  syncPersona?: boolean;
  syncLlm?: boolean;
  syncChatSkills?: boolean;
  syncHomepage?: boolean;
  /** Publish an /info/owner pin: signed binding payload, or '' to unbind. */
  syncOwner?: boolean;
  ownerBindingPayload?: string | null;
}

export interface SyncMetaBotEditChangesResult {
  success: boolean;
  error?: string;
  metabotInfoPinId?: string;
  txids?: string[];
  syncedSteps?: SyncMetaBotEditStep[];
}

type SyncMetaBotEditChangesDeps = {
  createPin?: typeof createPin;
  sleep?: typeof sleep;
  prepareNftAvatar?: typeof prepareNftAvatarForIdentity;
};

type SyncMetaBotToChainDeps = {
  createPin?: typeof createPin;
  sleep?: typeof sleep;
  prepareNftAvatar?: typeof prepareNftAvatarForIdentity;
};

export interface MetabotInfoSyncStep {
  key: SyncMetaBotStep;
  path: string;
  contentType: string;
  payload: string | Buffer;
  encoding?: 'base64';
}

function isProfileSyncStep(step: SyncMetaBotStep): step is 'bio' | 'persona' | 'llm' | 'chatSkills' {
  return step === 'bio' || step === 'persona' || step === 'llm' || step === 'chatSkills';
}

const METAFILE_AVATAR_PATTERN = /^metafile:\/\/([0-9a-f]{64}i\d+)(\.[a-z0-9][a-z0-9+-]{0,31})?$/i;

export function normalizeMetafileAvatarReference(avatar: string | null | undefined): string | null {
  const normalized = typeof avatar === 'string' ? avatar.trim() : '';
  const match = normalized.match(METAFILE_AVATAR_PATTERN);
  if (!match?.[1]) return null;
  return `metafile://${match[1].toLowerCase()}${match[2]?.toLowerCase() ?? ''}`;
}

function buildAvatarSyncStep(avatar: string | null | undefined): MetabotInfoSyncStep | null {
  const metafileReference = normalizeMetafileAvatarReference(avatar);
  if (metafileReference) {
    return {
      key: 'avatar',
      path: '/info/avatar',
      contentType: 'text/plain',
      payload: metafileReference,
    };
  }

  const avatarData = parseDataUrlAvatar(avatar);
  if (!avatarData) {
    return null;
  }

  return {
    key: 'avatar',
    path: '/info/avatar',
    contentType: `${avatarData.mime};binary`,
    payload: avatarData.buffer,
    encoding: 'base64',
  };
}

function buildNftAvatarDeclarationSyncStep(metabot: any): MetabotInfoSyncStep {
  const parsed = parseNftAvatarReference(metabot?.avatar);
  const ownerAddress = String(metabot?.mvc_address ?? parsed?.ownerAddress ?? '').trim();
  return {
    key: 'nftAvatar',
    path: NFT_AVATAR_PATH,
    contentType: 'application/json',
    payload: parsed
      ? buildNftAvatarDeclarationPayload({ itemPinId: parsed.itemPinId, ownerAddress })
      : '',
  };
}

/**
 * Build the `/info/avatar` step for an edit sync. Binary uploads keep the
 * original image-byte contract. A valid MetaFile reference is pinned as a
 * small text payload so built-in avatars never upload duplicate image bytes.
 */
function buildEditAvatarSyncStep(metabot: any): MetabotInfoSyncStep {
  const avatarRaw = typeof metabot?.avatar === 'string' ? metabot.avatar.trim() : '';
  const nftReference = parseNftAvatarReference(avatarRaw);
  const imageSource = nftReference ? metabot?.avatar_fallback : avatarRaw;
  if (!imageSource) {
    if (nftReference) throw new Error('NFT avatar cover is unavailable; retry the avatar sync after the cover resolves.');
    return {
      key: 'avatar',
      path: '/info/avatar',
      contentType: 'text/plain',
      payload: '',
    };
  }
  const avatarStep = buildAvatarSyncStep(imageSource);
  if (!avatarStep) {
    throw new Error(
      'Invalid avatar data URL: /info/avatar requires a supported image data URL (data:image/png|jpeg|webp|gif;base64,...) or a valid metafile://<pinId>[.<ext>] reference. Normalize an http(s)/local source to a data URL before syncing.',
    );
  }
  return avatarStep;
}

/**
 * True when a Bot Info profile payload carries no content (empty bio, persona
 * with all blank fields, or chatSkills with empty arrays). The llm step always
 * counts as content so it is never skipped.
 */
function isEmptyMetabotInfoPayload(payload: MetabotInfoPayload): boolean {
  if (payload.step === 'llm') return false;
  if (payload.step === 'bio') return !payload.payload.trim();
  try {
    const parsed = JSON.parse(payload.payload) as Record<string, unknown>;
    if (payload.step === 'persona') {
      return !String(parsed?.role ?? '').trim()
        && !String(parsed?.soul ?? '').trim()
        && !String(parsed?.goal ?? '').trim();
    }
    if (payload.step === 'chatSkills') {
      const privateSkills = Array.isArray(parsed?.allowPrivateChatSkills) ? parsed.allowPrivateChatSkills : [];
      const groupSkills = Array.isArray(parsed?.allowGroupChatSkills) ? parsed.allowGroupChatSkills : [];
      return privateSkills.length === 0 && groupSkills.length === 0;
    }
  } catch {
    // Keep the step when the payload cannot be inspected.
  }
  return false;
}

export function buildFullMetabotInfoSyncPlan(
  metabot: any,
  options?: { ownerBindingPayload?: string | null; skipEmptyInfoSteps?: boolean }
): MetabotInfoSyncStep[] {
  const skipEmptyInfoSteps = options?.skipEmptyInfoSteps === true;
  const steps: MetabotInfoSyncStep[] = [{
    key: 'name',
    path: '/info/name',
    contentType: 'text/plain',
    payload: metabot?.name || 'MetaBot',
  }];

  const nftReference = parseNftAvatarReference(metabot?.avatar);
  const avatarStep = buildAvatarSyncStep(nftReference ? metabot?.avatar_fallback : metabot?.avatar);
  if (avatarStep) {
    steps.push(avatarStep);
  }
  const syncedNftReference = typeof metabot?.nft_avatar_synced_reference === 'string'
    ? metabot.nft_avatar_synced_reference
    : '';
  if ((nftReference && metabot.avatar !== syncedNftReference) || (!nftReference && syncedNftReference)) {
    steps.push(buildNftAvatarDeclarationSyncStep(metabot));
  }

  const chatPubKey = typeof metabot?.chat_public_key === 'string'
    ? metabot.chat_public_key.trim()
    : '';
  if (!metabot?.chat_public_key_pin_id && chatPubKey) {
    steps.push({
      key: 'chatpubkey',
      path: '/info/chatpubkey',
      contentType: 'text/plain',
      payload: chatPubKey,
    });
  }

  for (const payload of buildMetabotInfoPayloads(metabot ?? {})) {
    if (skipEmptyInfoSteps && isEmptyMetabotInfoPayload(payload)) continue;
    steps.push({
      key: payload.step,
      path: payload.path,
      contentType: payload.contentType,
      payload: payload.payload,
    });
  }

  // Homepage is an independent /info/homepage step. In skip-empty mode (create
  // and manual resync) an empty/Default homepage is not pinned; otherwise the
  // step is always present (edit plan relies on that to publish cleared values).
  const homepagePayload = buildMetabotHomepagePayload(metabot?.homepage);
  if (!skipEmptyInfoSteps || homepagePayload.payload.trim()) {
    steps.push({
      key: 'homepage',
      path: homepagePayload.path,
      contentType: homepagePayload.contentType,
      payload: homepagePayload.payload,
    });
  }

  // Owner binding is an optional trailing step ('' payload = unbind).
  if (typeof options?.ownerBindingPayload === 'string') {
    steps.push({
      key: 'owner',
      path: OWNER_BINDING_PATH,
      contentType: 'application/json',
      payload: options.ownerBindingPayload,
    });
  }

  return steps;
}

export function buildEditMetabotInfoSyncPlan(
  input: SyncMetaBotEditChangesInput & { metabot: any }
): MetabotInfoSyncStep[] {
  const wanted = new Set<SyncMetaBotStep>();
  if (input.syncName) wanted.add('name');
  if (input.syncAvatar) wanted.add('avatar');
  if (input.syncBio) wanted.add('bio');
  if (input.syncPersona) wanted.add('persona');
  if (input.syncLlm) wanted.add('llm');
  if (input.syncChatSkills) wanted.add('chatSkills');
  if (input.syncHomepage) wanted.add('homepage');

  const steps = buildFullMetabotInfoSyncPlan({
    ...input.metabot,
    chat_public_key_pin_id: input.metabot?.chat_public_key_pin_id || 'skip-edit-chatpubkey',
  }).filter((step) => step.key !== 'avatar' && step.key !== 'nftAvatar' && step.key !== 'chatpubkey' && wanted.has(step.key));

  if (input.syncAvatar) {
    const avatarStep = buildEditAvatarSyncStep(input.metabot);
    const insertIndex = input.syncName ? 1 : 0;
    steps.splice(insertIndex, 0, avatarStep);
  }
  const needsNftDeclaration = parseNftAvatarReference(input.metabot?.avatar)
    || input.metabot?.nft_avatar_synced_reference
    || input.syncNftAvatar;
  if ((input.syncAvatar || input.syncNftAvatar) && needsNftDeclaration) {
    const insertIndex = (input.syncName ? 1 : 0) + (input.syncAvatar ? 1 : 0);
    steps.splice(insertIndex, 0, buildNftAvatarDeclarationSyncStep(input.metabot));
  }

  // Owner binding (signed payload, or '' to unbind) is published as an
  // independent trailing step.
  if (input.syncOwner) {
    steps.push({
      key: 'owner',
      path: OWNER_BINDING_PATH,
      contentType: 'application/json',
      payload: typeof input.ownerBindingPayload === 'string' ? input.ownerBindingPayload : '',
    });
  }

  return steps;
}

/**
 * Sync MetaBot basic info to chain: Name, Avatar, ChatPubKey, and Bot Info protocol profile paths.
 * Sequential execution with sleep between steps to avoid UTXO double-spend (indexer delay).
 * On success, updates metabot_info_pinid and chat_public_key_pin_id in SQLite.
 */
export async function syncMetaBotToChain(
  metabotStore: MetabotStore,
  metabot_id: number,
  deps: SyncMetaBotToChainDeps = {},
  options: { ownerBindingPayload?: string | null } = {}
): Promise<SyncMetaBotResult> {
  const createPinRunner = deps.createPin ?? createPin;
  const sleepRunner = deps.sleep ?? sleep;
  const log = (msg: string, data?: object) => {
    console.log(`[syncMetaBot] metabot_id=${metabot_id} ${msg}`, data ?? '');
  };
  const logErr = (msg: string, data?: object) => {
    console.error(`[syncMetaBot] metabot_id=${metabot_id} ERROR ${msg}`, data ?? '');
  };

  log('Starting syncMetaBotToChain');

  const metabot = metabotStore.getMetabotById(metabot_id);
  if (!metabot) {
    logErr('MetaBot not found');
    return { success: false, error: `MetaBot ${metabot_id} not found` };
  }

  log('MetaBot loaded', {
    name: metabot.name,
    hasAvatar: !!metabot.avatar,
    hasChatPublicKey: !!String(metabot.chat_public_key || '').trim(),
    role: metabot.role?.slice(0, 50),
  });

  const txids: string[] = [];
  const syncedSteps: SyncMetaBotStep[] = [];
  let chatPublicKeyPinId: string | null = null;
  let metabotInfoPinId: string | null = null;
  let ownerBindingPinId: string | null = null;
  let someStepFailed = false;
  let lastError = '';
  const chatPubKey = typeof metabot.chat_public_key === 'string' ? metabot.chat_public_key.trim() : '';
  if (!metabot.chat_public_key_pin_id && !chatPubKey) {
    someStepFailed = true;
    lastError = 'Missing chat public key; /info/chatpubkey was not synced';
    logErr('Missing chat public key; continuing with skippable profile sync');
  }

  let metabotForSync = metabot;
  if (parseNftAvatarReference(metabot.avatar)) {
    try {
      const prepared = await (deps.prepareNftAvatar ?? prepareNftAvatarForIdentity)({
        reference: metabot.avatar!,
        ownerAddress: metabot.mvc_address,
        globalMetaId: metabot.globalmetaid,
      });
      metabotStore.updateMetabot(metabot_id, { avatar: prepared.reference, avatar_fallback: prepared.avatarUrl });
      metabotForSync = { ...metabot, avatar: prepared.reference, avatar_fallback: prepared.avatarUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message, canSkip: true, plannedSteps: [], syncedSteps };
    }
  }
  const plannedSteps = buildFullMetabotInfoSyncPlan(metabotForSync, { ...options, skipEmptyInfoSteps: true });
  log('Prepared full sync plan', { plannedSteps: plannedSteps.map((step) => step.key) });

  for (let index = 0; index < plannedSteps.length; index += 1) {
    const step = plannedSteps[index];
    log(`Step ${index + 1}: Pinning ${step.key} to ${step.path}`, {
      contentType: step.contentType,
      payloadBytes: Buffer.isBuffer(step.payload) ? step.payload.length : Buffer.byteLength(String(step.payload)),
    });

    try {
      const result = await createPinRunner(metabotStore, metabot_id, {
        operation: 'create',
        path: step.path,
        contentType: step.contentType,
        payload: step.payload,
        encoding: step.encoding,
        // /info/* is already ledger-excluded by path; the origin tag is a
        // second layer so identity sync never lands in metabot_chain_writes.
      }, { origin: 'internal:identity-sync' });
      const txid = result.txids[0];
      if (!txid) {
        const message = `${step.key} pin failed: no txid`;
        if (step.key === 'name') {
          logErr('Name pin: no txid returned');
          return { success: false, error: message, canSkip: false, plannedSteps: plannedSteps.map((s) => s.key), syncedSteps };
        }
        logErr(`${step.key} pin: no txid returned (skipped)`);
        someStepFailed = true;
        lastError = message;
      } else {
        txids.push(txid);
        syncedSteps.push(step.key);
        if (step.key === 'chatpubkey') {
          chatPublicKeyPinId = result.pinId ?? `${txid}i0`;
        } else if (isProfileSyncStep(step.key)) {
          metabotInfoPinId = result.pinId ?? `${txid}i0`;
        } else if (step.key === 'nftAvatar') {
          metabotStore.updateMetabot(metabot_id, {
            nft_avatar_pin_id: result.pinId ?? `${txid}i0`,
            nft_avatar_synced_reference: metabotForSync.avatar ?? '',
          });
        } else if (step.key === 'owner') {
          ownerBindingPinId = result.pinId ?? `${txid}i0`;
        }
        log(`${step.key} pin success`, { txid, pinId: result.pinId });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (step.key === 'name') {
        logErr('Chain sync failed at name step', { error: msg });
        return { success: false, error: msg, canSkip: false, plannedSteps: plannedSteps.map((s) => s.key), syncedSteps };
      }
      logErr(`${step.key} pin failed (skipped)`, { error: msg });
      someStepFailed = true;
      lastError = msg;
    }

    if (index < plannedSteps.length - 1) {
      log('Waiting 3s for indexer before next step');
      await sleepRunner(3000);
    }
  }

  if (someStepFailed) {
    log('Some steps failed; updating DB with partial results and returning canSkip=true');
    try {
      const updateInput: { chat_public_key_pin_id?: string | null; metabot_info_pinid?: string | null; owner_binding_pinid?: string | null } = {};
      if (chatPublicKeyPinId) updateInput.chat_public_key_pin_id = chatPublicKeyPinId;
      if (metabotInfoPinId) updateInput.metabot_info_pinid = metabotInfoPinId;
      if (ownerBindingPinId) updateInput.owner_binding_pinid = ownerBindingPinId;
      log('DB update payload', updateInput);
      metabotStore.updateMetabot(metabot_id, updateInput);
    } catch (dbErr) {
      logErr('Database update failed on partial sync', { error: String(dbErr) });
    }
    return {
      success: false,
      error: lastError,
      canSkip: true,
      txids,
      plannedSteps: plannedSteps.map((step) => step.key),
      syncedSteps,
      metabotInfoPinId: metabotInfoPinId ?? undefined,
      chatPublicKeyPinId: chatPublicKeyPinId ?? undefined,
    };
  }

  // Database update
  log('Updating database with PinIDs');
  try {
    const updateInput: { chat_public_key_pin_id?: string | null; metabot_info_pinid?: string | null; owner_binding_pinid?: string | null } = {};
    if (chatPublicKeyPinId) updateInput.chat_public_key_pin_id = chatPublicKeyPinId;
    if (metabotInfoPinId) updateInput.metabot_info_pinid = metabotInfoPinId;
    if (ownerBindingPinId) updateInput.owner_binding_pinid = ownerBindingPinId;

    log('DB update payload', updateInput);

    const updated = metabotStore.updateMetabot(metabot_id, updateInput);
    if (!updated) {
      logErr('updateMetabot returned null');
      return {
        success: false,
        error: 'Chain sync succeeded but database update failed',
        metabotInfoPinId: metabotInfoPinId ?? undefined,
        chatPublicKeyPinId: chatPublicKeyPinId ?? undefined,
        txids,
      };
    }
    log('Database updated successfully', {
      chat_public_key_pin_id: updated.chat_public_key_pin_id,
      metabot_info_pinid: updated.metabot_info_pinid,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr('Database update failed', { error: msg });
    return {
      success: false,
      error: `Chain sync succeeded but database update failed: ${msg}`,
      metabotInfoPinId: metabotInfoPinId ?? undefined,
      chatPublicKeyPinId: chatPublicKeyPinId ?? undefined,
      txids,
    };
  }

  log('syncMetaBotToChain completed successfully');
  return {
    success: true,
    plannedSteps: plannedSteps.map((step) => step.key),
    syncedSteps,
    metabotInfoPinId: metabotInfoPinId ?? undefined,
    chatPublicKeyPinId: chatPublicKeyPinId ?? undefined,
    txids,
  };
}

export async function syncMetaBotEditChangesToChain(
  metabotStore: MetabotStore,
  input: SyncMetaBotEditChangesInput,
  deps: SyncMetaBotEditChangesDeps = {}
): Promise<SyncMetaBotEditChangesResult> {
  const metabotId = Number(input.metabotId);
  const createPinRunner = deps.createPin ?? createPin;
  const sleepRunner = deps.sleep ?? sleep;

  const log = (msg: string, data?: object) => {
    console.log(`[syncMetaBotEdit] metabot_id=${metabotId} ${msg}`, data ?? '');
  };
  const logErr = (msg: string, data?: object) => {
    console.error(`[syncMetaBotEdit] metabot_id=${metabotId} ERROR ${msg}`, data ?? '');
  };

  if (!metabotId || !Number.isFinite(metabotId)) {
    logErr('Invalid metabot id', { metabotId: input.metabotId });
    return { success: false, error: 'Invalid metabot id' };
  }
  const metabot = metabotStore.getMetabotById(metabotId);
  if (!metabot) {
    logErr('MetaBot not found');
    return { success: false, error: `MetaBot ${metabotId} not found` };
  }

  let metabotForSync = metabot;
  let plannedSteps: MetabotInfoSyncStep[];
  try {
    if ((input.syncAvatar || input.syncNftAvatar) && parseNftAvatarReference(metabot.avatar)) {
      const prepared = await (deps.prepareNftAvatar ?? prepareNftAvatarForIdentity)({
        reference: metabot.avatar!,
        ownerAddress: metabot.mvc_address,
        globalMetaId: metabot.globalmetaid,
      });
      metabotStore.updateMetabot(metabotId, { avatar: prepared.reference, avatar_fallback: prepared.avatarUrl });
      metabotForSync = { ...metabot, avatar: prepared.reference, avatar_fallback: prepared.avatarUrl };
    }
    plannedSteps = buildEditMetabotInfoSyncPlan({ ...input, metabot: metabotForSync });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr('Failed to build edit sync plan', { error: msg });
    return { success: false, error: msg };
  }
  if (plannedSteps.length === 0) {
    log('No requested steps, skip sync');
    return { success: true, txids: [], syncedSteps: [] };
  }

  log('Starting edit sync', { plannedSteps: plannedSteps.map((step) => step.key) });

  const txids: string[] = [];
  const syncedSteps: SyncMetaBotEditStep[] = [];
  let metabotInfoPinId: string | null = null;

  const persistProfilePinId = (pinId: string): string | null => {
    try {
      const updated = metabotStore.updateMetabot(metabotId, {
        metabot_info_pinid: pinId,
      });
      if (!updated) {
        logErr('Failed to update metabot_info_pinid after profile sync');
        return 'Profile sync succeeded but failed to update metabot_info_pinid';
      }
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logErr('Database update failed after profile sync', { error: msg });
      return `Profile sync succeeded but database update failed: ${msg}`;
    }
  };

  for (let i = 0; i < plannedSteps.length; i += 1) {
    const step = plannedSteps[i];
    try {
      log(`Pinning ${step.key} to ${step.path}`, {
        contentType: step.contentType,
        payloadBytes: Buffer.isBuffer(step.payload) ? step.payload.length : Buffer.byteLength(String(step.payload)),
      });
      const result = await createPinRunner(metabotStore, metabotId, {
        operation: 'create',
        path: step.path,
        contentType: step.contentType,
        payload: step.payload,
        encoding: step.encoding,
      });
      const txid = result.txids[0];
      if (!txid) {
        logErr(`${step.key} pin returned no txid`);
        return { success: false, error: `${step.key} pin failed: no txid`, txids, syncedSteps };
      }
      txids.push(txid);
      if (isProfileSyncStep(step.key)) {
        metabotInfoPinId = result.pinId ?? `${txid}i0`;
        const persistError = persistProfilePinId(metabotInfoPinId);
        if (persistError) {
          return {
            success: false,
            error: persistError,
            txids,
            syncedSteps,
            metabotInfoPinId,
          };
        }
      }
      if (step.key === 'nftAvatar') {
        metabotStore.updateMetabot(metabotId, {
          nft_avatar_pin_id: result.pinId ?? `${txid}i0`,
          nft_avatar_synced_reference: metabotForSync.avatar ?? '',
        });
      }
      if (step.key === 'owner') {
        // '' payload = unbind: clear the stored binding pin id.
        const ownerPinId = String(step.payload) === '' ? null : (result.pinId ?? `${txid}i0`);
        try {
          metabotStore.updateMetabot(metabotId, { owner_binding_pinid: ownerPinId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logErr('Owner pin sync succeeded but database update failed', { error: msg });
          return { success: false, error: `Owner sync succeeded but database update failed: ${msg}`, txids, syncedSteps };
        }
      }
      syncedSteps.push(step.key as SyncMetaBotEditStep);
      log(`${step.key} pin success`, { txid, pinId: result.pinId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logErr(`Step failed: ${step.key}`, {
        error: msg,
        plannedSteps: plannedSteps.map((plannedStep) => plannedStep.key),
        syncedSteps,
        txids,
      });
      return { success: false, error: msg, txids, syncedSteps, metabotInfoPinId: metabotInfoPinId ?? undefined };
    }

    if (i < plannedSteps.length - 1) {
      log('Waiting 3s for indexer before next step');
      await sleepRunner(3000);
    }
  }

  log('Edit sync completed successfully', { plannedSteps, syncedSteps, txidCount: txids.length });
  return {
    success: true,
    txids,
    syncedSteps,
    metabotInfoPinId: metabotInfoPinId ?? undefined,
  };
}

/** Raw PIN data from manapi.metaid.io (subset used for persist). */
type PinDataRow = Record<string, unknown>;

function toSqlBool(v: unknown): number {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  return 0;
}

function toSqlText(v: unknown): string | null {
  if (v == null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' || Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

function toSqlInt(v: unknown): number | null {
  if (v == null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

let storeGetter: (() => SqliteStore | null) | null = null;

export function setMetaidCoreStore(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

function rowToPinData(columns: string[], row: unknown[]): PinDataRow {
  const obj: PinDataRow = {};
  const boolKeys = new Set(['isTransfered', 'blocked', 'is_recommended']);
  const jsonKeys = new Set(['mrc20MintId', 'modify_history']);
  columns.forEach((col, i) => {
    const v = row[i];
    if (boolKeys.has(col)) {
      obj[col] = v === 1 || v === '1' || v === true;
    } else if (jsonKeys.has(col) && typeof v === 'string' && v) {
      try {
        obj[col] = JSON.parse(v);
      } catch {
        obj[col] = v;
      }
    } else {
      obj[col] = v ?? null;
    }
  });
  return obj;
}

/**
 * Fetch PIN data: prefer local SQLite, fallback to manapi.metaid.io.
 * If local hit: return from DB. If miss: fetch remote, persist when persist=true, then return.
 */
export async function getPinData(pinId: string, persist: boolean): Promise<PinDataRow> {
  const store = storeGetter?.() ?? null;
  if (store) {
    const db = store.getDatabase();
    const result = db.exec('SELECT * FROM metaid_pins WHERE id = ?', [pinId]);
    if (result[0]?.values?.[0]) {
      const columns = result[0].columns as string[];
      const row = result[0].values[0] as unknown[];
      return rowToPinData(columns, row);
    }
  }

  const localPath = `/api/pin/${encodeURIComponent(pinId)}`;
  const fallbackUrl = `${MANAPI_BASE}/pin/${encodeURIComponent(pinId)}`;
  const res = await fetchFromLocalOrFallback(localPath, fallbackUrl);
  if (!res.ok) {
    throw new Error(`manapi fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { code?: number; message?: string; data?: PinDataRow };
  const data = json?.data;
  if (!data || typeof data !== 'object') {
    throw new Error(json?.message ?? 'No data in manapi response');
  }

  if (persist && store) {
    const db = store.getDatabase();
    const id = (data.id != null ? String(data.id) : pinId) || pinId;
    const cols = [
      'id', 'number', 'metaid', 'address', 'creator', 'createMetaId', 'globalMetaId', 'initialOwner',
      'output', 'outputValue', 'timestamp', 'genesisFee', 'genesisHeight', 'genesisTransaction',
      'txIndex', 'txInIndex', '"offset"', 'location', 'operation', 'path', 'parentPath', 'originalPath',
      'encryption', 'version', 'contentType', 'contentTypeDetect', 'contentBody', 'contentLength',
      'contentSummary', 'originalContentBody', 'originalContentSummary', 'status', 'originalId',
      'isTransfered', 'preview', 'content', 'pop', 'popLv', 'popScore', 'popScoreV1', 'chainName',
      'dataValue', 'mrc20MintId', 'host', 'blocked', 'is_recommended', 'modify_history',
    ];
    const values = [
      id,
      toSqlInt(data.number),
      toSqlText(data.metaid),
      toSqlText(data.address),
      toSqlText(data.creator),
      toSqlText(data.createMetaId),
      toSqlText(data.globalMetaId),
      toSqlText(data.initialOwner),
      toSqlText(data.output),
      toSqlInt(data.outputValue),
      toSqlInt(data.timestamp),
      toSqlInt(data.genesisFee),
      toSqlInt(data.genesisHeight),
      toSqlText(data.genesisTransaction),
      toSqlInt(data.txIndex),
      toSqlInt(data.txInIndex),
      toSqlInt(data.offset),
      toSqlText(data.location),
      toSqlText(data.operation),
      toSqlText(data.path),
      toSqlText(data.parentPath),
      toSqlText(data.originalPath),
      toSqlText(data.encryption),
      toSqlText(data.version),
      toSqlText(data.contentType),
      toSqlText(data.contentTypeDetect),
      toSqlText(data.contentBody),
      toSqlInt(data.contentLength),
      toSqlText(data.contentSummary),
      toSqlText(data.originalContentBody),
      toSqlText(data.originalContentSummary),
      toSqlInt(data.status),
      toSqlText(data.originalId),
      toSqlBool(data.isTransfered),
      toSqlText(data.preview),
      toSqlText(data.content),
      toSqlText(data.pop),
      toSqlInt(data.popLv),
      toSqlText(data.popScore),
      toSqlText(data.popScoreV1),
      toSqlText(data.chainName),
      toSqlInt(data.dataValue),
      toSqlText(data.mrc20MintId),
      toSqlText(data.host),
      toSqlBool(data.blocked),
      toSqlBool(data.is_recommended),
      toSqlText(data.modify_history),
    ];
    const placeholders = cols.map(() => '?').join(',');
    db.run(
      `INSERT OR REPLACE INTO metaid_pins (${cols.join(',')}) VALUES (${placeholders})`,
      values
    );
    store.getSaveFunction()();
  }

  return data as PinDataRow;
}
