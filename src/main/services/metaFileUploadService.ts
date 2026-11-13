import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { MetabotStore } from '../metabotStore';
import { resolveElectronExecutablePath } from '../libs/runtimePaths';
import { createPin, runMvcCreatePinWithInsufficientFundsRescue } from './metaidCore';
import { requestMvcGasSubsidy } from './mvcSubsidyService';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { getMvcSpendCoordinator } from './mvcSpendCoordinator';
import { verifyMetafileAvailability } from './metafileVerifier';
import {
  TrafficInsufficientError,
  uploadMvcSponsorDirectFile,
  type MvcSponsorFeeAssistMetadata,
} from './mvcSponsorUpload';
import { getConfiguredTrafficApiBase, getConfiguredTrafficPinMode } from './trafficAccountService';
import { getConfiguredTrafficFallbackPolicy } from './trafficAccountService';
import { resolveMetaFileUploadSharedModulePath } from './metaFileUploadSharedResolver';
import { getMainWorkerCandidatePaths, resolveMainWorkerPath } from './workerPathResolver';

function loadMetaFileUploadShared(): {
  DEFAULT_CHUNK_THRESHOLD_BYTES: number;
  DEFAULT_MAX_FILE_SIZE_BYTES: number;
  inferContentTypeFromFilePath: (filePath: string) => string;
  normalizeRpcUploadResult: (payload: Record<string, unknown>) => Record<string, unknown>;
  normalizeUploadContentType: (contentType: string) => string;
  normalizeUploadNetwork: (network?: string) => 'mvc' | 'btc' | 'opcat';
  getMetafileExtension: (input: { fileName?: string; contentType?: string }) => string;
  validateUploadSize: (input: { sizeBytes: number; maxSizeBytes?: number }) => number;
  selectUploadMode: (input: { sizeBytes: number; chunkThresholdBytes?: number }) => 'direct' | 'chunked';
} {
  const modulePath = resolveMetaFileUploadSharedModulePath({
    moduleDir: __dirname,
    appPath: app.getAppPath(),
    exists: fs.existsSync,
  });
  if (!modulePath) {
    throw new Error('metaFileUploadShared module not found');
  }
  return require(modulePath) as ReturnType<typeof loadMetaFileUploadShared>;
}

const {
  DEFAULT_CHUNK_THRESHOLD_BYTES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  inferContentTypeFromFilePath,
  normalizeRpcUploadResult,
  normalizeUploadContentType,
  normalizeUploadNetwork,
  getMetafileExtension,
  validateUploadSize,
  selectUploadMode,
} = loadMetaFileUploadShared();

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

const CHAIN_DEFAULT_WRITE_NETWORK_KEY = 'chain.defaultWriteNetwork';
const MVC_SPONSOR_UPLOAD_ENABLED_KEY = 'chain.mvcSponsorUploadEnabled';

function parseBooleanSetting(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

function resolveDefaultUploadNetwork(metabotStore: MetabotStore, metabotId: number): string {
  const configured = metabotStore.getMetabotSetting(metabotId, CHAIN_DEFAULT_WRITE_NETWORK_KEY);
  if (!configured) {
    return 'mvc';
  }
  return normalizeUploadNetwork(configured);
}

function isMvcSponsorUploadEnabled(metabotStore: MetabotStore, metabotId: number): boolean {
  return parseBooleanSetting(
    metabotStore.getMetabotSetting(metabotId, MVC_SPONSOR_UPLOAD_ENABLED_KEY),
    true,
  );
}

export interface UploadMetaFileParams {
  metabotId: number;
  /** Path to file on disk. Mutually exclusive with `data`. */
  filePath?: string;
  /** In-memory file bytes. Mutually exclusive with `filePath`. */
  data?: Buffer;
  /** File name used for contentType inference when `data` is provided. */
  dataFileName?: string;
  contentType?: string;
  network?: string;
  /** Request post-upload availability verification when supported. */
  verify?: boolean;
  /** Ledger tag forwarded to the createPin options of the direct /file pin. */
  origin?: string;
  chunkThresholdBytes?: number;
  maxSizeBytes?: number;
  uploaderBaseUrl?: string;
}

interface ChunkWorkerPayload {
  filePath: string;
  fileName: string;
  size: number;
  contentType: string;
  metaId: string;
  address: string;
  feeRate: number;
  maxSizeBytes: number;
  uploaderBaseUrl?: string;
}

function getErrorMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

async function runUploadLargeFileWorker(
  payload: ChunkWorkerPayload,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const workerBasename = 'uploadLargeFileWorker.js';
  const appPath = app.getAppPath();
  const candidatePaths = getMainWorkerCandidatePaths({
    moduleDir: __dirname,
    appPath,
    workerBasename,
  });
  const workerPath = resolveMainWorkerPath({
    moduleDir: __dirname,
    appPath,
    workerBasename,
    exists: fs.existsSync,
  });
  if (!workerPath) {
    throw new Error(`Worker not found: ${workerBasename}. Tried: ${candidatePaths.join(', ')}`);
  }

  const electronExe = resolveElectronExecutablePath();
  if (!electronExe || !fs.existsSync(electronExe)) {
    throw new Error('Electron executable not found');
  }

  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete baseEnv.NODE_PATH;

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(electronExe, [workerPath], {
      cwd: app.getPath('userData'),
      env: {
        ...baseEnv,
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', (err) => {
      reject(new Error(getErrorMessage(err)));
    });

    child.once('close', () => {
      const output = stdout.trim() || stderr.trim();
      if (!output) {
        reject(new Error('Worker returned empty output'));
        return;
      }

      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      try {
        const parsed = JSON.parse(last) as { success?: boolean; error?: string };
        if (!parsed.success) {
          reject(new Error(parsed.error || 'Large file upload worker failed'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error(output));
      }
    });

    child.stdin?.write(JSON.stringify(payload), () => {
      child.stdin?.end();
    });
  });
}

async function attachVerificationIfRequested(
  result: Record<string, unknown>,
  params: UploadMetaFileParams,
): Promise<Record<string, unknown>> {
  if (params.verify !== true) {
    return result;
  }
  const pinId = String(result?.pinId || '').trim();
  if (!pinId) {
    return result;
  }
  try {
    result.verification = await verifyMetafileAvailability({ pinId });
  } catch (error) {
    result.verification = {
      ok: false,
      url: null,
      attempts: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}

export async function uploadMetaFile(
  metabotStore: MetabotStore,
  params: UploadMetaFileParams,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(params.metabotId) || params.metabotId <= 0) {
    throw new Error('metabot_id must be a positive integer');
  }

  const useData = Buffer.isBuffer(params.data) && params.data.length > 0;
  const useFile = !useData && Boolean(String(params.filePath || '').trim());
  if (!useData && !useFile) {
    throw new Error('Either filePath or data is required');
  }

  let resolvedFilePath = '';
  let fileName = '';
  let size: number;
  let dataBuffer: Buffer | null = null;

  if (useData) {
    dataBuffer = params.data as Buffer;
    size = validateUploadSize({
      sizeBytes: dataBuffer.length,
      maxSizeBytes: params.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    });
    fileName = String(params.dataFileName || 'homepage-upload').trim() || 'homepage-upload';
  } else {
    resolvedFilePath = path.resolve(String(params.filePath || '').trim());
    if (!resolvedFilePath) {
      throw new Error('file_path is required');
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolvedFilePath);
    } catch {
      throw new Error(`File not found: ${resolvedFilePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${resolvedFilePath}`);
    }
    size = validateUploadSize({
      sizeBytes: stat.size,
      maxSizeBytes: params.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    });
    fileName = path.basename(resolvedFilePath);
  }

  const requestedNetwork = String(params.network || '').trim();
  const network = requestedNetwork
    ? normalizeUploadNetwork(requestedNetwork)
    : resolveDefaultUploadNetwork(metabotStore, params.metabotId);
  const contentType = normalizeUploadContentType(
    params.contentType || inferContentTypeFromFilePath(fileName),
  );
  const uploadMode = selectUploadMode({
    sizeBytes: size,
    chunkThresholdBytes: params.chunkThresholdBytes ?? DEFAULT_CHUNK_THRESHOLD_BYTES,
  });

  if (uploadMode === 'direct') {
    const buffer = dataBuffer ?? await fs.promises.readFile(resolvedFilePath);
    // P2: sha256 of the exact uploaded bytes — the group-task deliverable
    // dedupe key. The buffer is already in memory, so hashing adds no I/O.
    // Chunked uploads stay unhashed here; the daemon's verification pass
    // backfills them (with a size cap) from the on-chain bytes.
    const contentHash = createHash('sha256').update(buffer).digest('hex');
    const metabot = metabotStore.getMetabotById(params.metabotId);

    const selfPaidDirect = async (feeAssist?: MvcSponsorFeeAssistMetadata) => {
      const feeRate = getGlobalFeeRate(network);
      const result = await createPin(
        metabotStore,
        params.metabotId,
        {
          operation: 'create',
          path: '/file',
          encryption: '0',
          version: '1.0',
          contentType,
          payload: buffer,
        },
        {
          network,
          feeRate,
          origin: params.origin,
        },
      );
      const normalized = normalizeRpcUploadResult({
        pinId: result.pinId,
        fileName,
        size,
        contentType,
        uploadMode: 'direct',
        network,
        txids: result.txids,
        totalCost: result.totalCost,
        globalMetaId: metabot?.metaid?.trim() || undefined,
      });
      normalized.contentHash = contentHash;
      if (feeAssist) {
        normalized.feeAssist = feeAssist;
      }
      return normalized;
    };

    // Route by the global traffic billing mode (2026-09-12): the dedicated
    // sponsor upload only runs in 'traffic' (account-quota) mode. In
    // 'selfpay' mode it previously ran anyway and billed the shared legacy
    // sponsor quota, bypassing both the bot wallet and the settings toggle —
    // self-pay now goes straight to the bot-wallet createPin path below.
    const sponsorUploadAllowed = getConfiguredTrafficPinMode() === 'traffic';
    if (network === 'mvc' && !useData && metabot && sponsorUploadAllowed && isMvcSponsorUploadEnabled(metabotStore, params.metabotId)) {
      const sponsorWallet = metabotStore.getMetabotWalletByMetabotId(params.metabotId);
      if (sponsorWallet?.mnemonic?.trim() && metabot.mvc_address?.trim()) {
        const mvcAddress = metabot.mvc_address.trim();
        const mnemonic = sponsorWallet.mnemonic.trim();
        const walletPath = (sponsorWallet.path || DEFAULT_PATH).trim();
        const runDirectSponsor = () => uploadMvcSponsorDirectFile({
          filePath: resolvedFilePath,
          fileName,
          contentType,
          bytes: size,
          extension: getMetafileExtension({ fileName, contentType }),
          mnemonic,
          walletPath,
          mvcAddress,
          globalMetaId: metabot.metaid?.trim() || undefined,
          fallbackPolicy: getConfiguredTrafficFallbackPolicy(),
          baseUrl: getConfiguredTrafficApiBase(),
          selfPaidUpload: async (feeAssist) => selfPaidDirect(feeAssist),
        });
        const directUploadResult = await runMvcCreatePinWithInsufficientFundsRescue({
          metabotId: params.metabotId,
          operation: 'create',
          path: '/file',
          settleMs: 3000,
          requestFreshFunding: async () => {
            const subsidy = await requestMvcGasSubsidy({ mvcAddress, mnemonic, path: walletPath });
            return subsidy.success;
          },
          run: runDirectSponsor,
        });
        const sponsorResult = await attachVerificationIfRequested(
          directUploadResult,
          params,
        );
        sponsorResult.contentHash = contentHash;
        return sponsorResult;
      }
    }

    return attachVerificationIfRequested(await selfPaidDirect(), params);
  }

  if (network !== 'mvc') {
    throw new Error('Large file upload currently supports MVC only.');
  }

  if (getConfiguredTrafficPinMode() === 'traffic' && getConfiguredTrafficFallbackPolicy() === 'strict') {
    const detail = '大于 5 MiB 的分片文件上传需要自付钱包 SPACE（外部 MetaFS 分片服务暂不支持积分代付），当前已开启「流量使用积分支付」且禁止静默扣钱包；请将文件压缩至 5 MiB 以内以使用积分，或关闭积分支付开关后重试。';
    throw new TrafficInsufficientError({
      reason: 'pre_rejected',
      stage: 'address_info',
      detail,
      feeAssist: {
        attempted: true,
        used: false,
        mode: 'mvc_sponsor_v2',
        sponsor: 'mvc_sponsor_v2',
        reason: 'pre_rejected',
        stage: 'address_info',
        billedBy: 'me',
        txSize: size,
        detail,
      },
    });
  }

  const metabot = metabotStore.getMetabotById(params.metabotId);
  if (!metabot) {
    throw new Error(`MetaBot not found: ${params.metabotId}`);
  }
  if (!metabot.metaid?.trim()) {
    throw new Error(`MetaBot ${params.metabotId} has no metaid`);
  }
  if (!metabot.mvc_address?.trim()) {
    throw new Error(`MetaBot ${params.metabotId} has no mvc address`);
  }

  const wallet = metabotStore.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error(`MetaBot ${params.metabotId} wallet not found`);
  }

  const workerResult = await getMvcSpendCoordinator().runMvcSpendJob({
    metabotId: params.metabotId,
    action: `chunked_upload:${fileName}`,
    execute: async () => runUploadLargeFileWorker(
      {
        filePath: resolvedFilePath,
        fileName,
        size,
        contentType,
        metaId: metabot.metaid.trim(),
        address: metabot.mvc_address.trim(),
        feeRate: getGlobalFeeRate('mvc'),
        maxSizeBytes: params.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
        uploaderBaseUrl: params.uploaderBaseUrl,
      },
      {
        IDBOTS_METABOT_MNEMONIC: wallet.mnemonic.trim(),
        IDBOTS_METABOT_PATH: (wallet.path || DEFAULT_PATH).trim(),
      },
    ),
  });

  return attachVerificationIfRequested(
    normalizeRpcUploadResult({
      ...workerResult,
      network: 'mvc',
      txids: workerResult.txId ? [workerResult.txId] : [],
      globalMetaId: metabot.metaid.trim(),
    }),
    params,
  );
}
