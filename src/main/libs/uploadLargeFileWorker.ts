import fs from 'fs';
import { TxComposer, mvc } from 'meta-contract';
import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';
import { getUtxoOutpointKey } from './mvcSpend';
import {
  isRetryableChunkedUploadError,
  normalizeChunkedUploadUtxos,
  pickChunkedUploadFundingUtxos,
  type ChunkedUploadFundingUtxo,
} from './uploadLargeFileFunding';

const {
  buildChunkedMetaFilePath,
  formatMiB,
  normalizeUploaderBaseUrl,
} = require('../services/metaFileUploadShared');

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const DEFAULT_MULTIPART_PART_SIZE = 1024 * 1024;
const RETRYABLE_CHUNKED_UPLOAD_ATTEMPTS = 3;
const RETRYABLE_CHUNKED_UPLOAD_DELAY_MS = 750;
const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
// Match the existing MetaFS frontend flow in this repo: SIGHASH_NONE | SIGHASH_FORKID.
const PRE_TX_SIGTYPE =
  mvc.crypto.Signature.SIGHASH_NONE | mvc.crypto.Signature.SIGHASH_FORKID;

interface WorkerPayload {
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

interface JsonEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

interface MultipartInitiateData {
  uploadId: string;
  key: string;
}

interface MultipartUploadPartData {
  etag: string;
  partNumber: number;
}

interface MultipartCompleteData {
  key: string;
}

interface UploaderConfigData {
  maxFileSize?: number;
  chains?: Record<string, { maxFileSize?: number; chunkSize?: number; feeRate?: number }>;
}

interface ChunkedEstimateData {
  chunkPreTxFee?: number;
  indexPreTxFee?: number;
}

interface ChunkedUploadData {
  indexTxId?: string;
  txId?: string;
  status?: string;
  message?: string;
}

function getErrorMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

function logStep(message: string): void {
  try {
    process.stderr.write(`[uploadLargeFileWorker] ${message}\n`);
  } catch {
    // ignore logging failures
  }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: JsonEnvelope<T> | null = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as JsonEnvelope<T>;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    throw new Error(parsed?.message || text || `HTTP ${response.status}`);
  }
  if (parsed?.code != null && parsed.code !== 0) {
    throw new Error(parsed.message || 'Uploader request failed');
  }
  return (parsed?.data ?? (parsed as unknown)) as T;
}

async function uploadToMultipartStorage(
  uploaderBaseUrl: string,
  fileBuffer: Buffer,
  fileName: string,
  metaId: string,
  address: string,
): Promise<string> {
  logStep('Initiating multipart upload');
  const initiate = await readJson<MultipartInitiateData>(`${uploaderBaseUrl}/api/v1/files/multipart/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName,
      fileSize: fileBuffer.length,
      metaId,
      address,
    }),
  });
  if (!initiate?.uploadId || !initiate?.key) {
    throw new Error('multipart initiate did not return uploadId/key');
  }

  const parts: Array<{ partNumber: number; etag: string; size: number }> = [];
  const totalParts = Math.ceil(fileBuffer.length / DEFAULT_MULTIPART_PART_SIZE);
  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
    const start = (partNumber - 1) * DEFAULT_MULTIPART_PART_SIZE;
    const end = Math.min(start + DEFAULT_MULTIPART_PART_SIZE, fileBuffer.length);
    const partBuffer = fileBuffer.subarray(start, end);
    logStep(`Uploading multipart chunk ${partNumber}/${totalParts}`);
    const part = await readJson<MultipartUploadPartData>(`${uploaderBaseUrl}/api/v1/files/multipart/upload-part`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: initiate.uploadId,
        key: initiate.key,
        partNumber,
        content: partBuffer.toString('base64'),
      }),
    });
    if (!part?.etag) {
      throw new Error(`multipart upload-part ${partNumber} did not return etag`);
    }
    parts.push({
      partNumber,
      etag: part.etag,
      size: end - start,
    });
  }

  logStep('Completing multipart upload');
  const complete = await readJson<MultipartCompleteData>(`${uploaderBaseUrl}/api/v1/files/multipart/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: initiate.uploadId,
      key: initiate.key,
      parts,
    }),
  });
  return String(complete?.key || initiate.key).trim();
}

async function fetchUploaderLimits(uploaderBaseUrl: string): Promise<{ maxFileSize: number; feeRate: number }> {
  const config = await readJson<UploaderConfigData>(`${uploaderBaseUrl}/api/v1/config`);
  const mvcConfig = config?.chains?.mvc ?? {};
  return {
    maxFileSize: Number(mvcConfig.maxFileSize ?? config?.maxFileSize ?? 0),
    feeRate: Number(mvcConfig.feeRate ?? 0),
  };
}

function buildSignedPreTx(params: {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  privateKey: InstanceType<typeof mvc.PrivateKey>;
}): string {
  const txComposer = new TxComposer();
  txComposer.appendP2PKHInput({
    address: new mvc.Address(params.address, 'livenet'),
    txId: params.txId,
    outputIndex: params.outputIndex,
    satoshis: params.satoshis,
  });
  txComposer.unlockP2PKHInput(params.privateKey, 0, PRE_TX_SIGTYPE);
  return txComposer.getRawHex();
}

async function fetchMvcFundingUtxos(address: string): Promise<ChunkedUploadFundingUtxo[]> {
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
  return normalizeChunkedUploadUtxos(all, address);
}

export function buildChunkedUploadMergeTxLocally(params: {
  senderWif: string;
  address: string;
  feeRate: number;
  chunkPreTxOutputAmount: number;
  indexPreTxOutputAmount: number;
  utxos: ChunkedUploadFundingUtxo[];
  excludedOutpoints?: ReadonlySet<string>;
}): {
  txHex: string;
  txId: string;
  spentOutpoints: string[];
  changeOutpoint: string | null;
  privateKey: InstanceType<typeof mvc.PrivateKey>;
} {
  const privateKey = mvc.PrivateKey.fromWIF(params.senderWif);
  const addressObj = new mvc.Address(params.address, 'livenet');
  const pickedUtxos = pickChunkedUploadFundingUtxos(
    params.utxos,
    params.chunkPreTxOutputAmount + params.indexPreTxOutputAmount,
    params.feeRate,
    params.excludedOutpoints ?? new Set(),
  );

  const txComposer = new TxComposer();
  txComposer.appendP2PKHOutput({
    address: addressObj,
    satoshis: params.chunkPreTxOutputAmount,
  });
  txComposer.appendP2PKHOutput({
    address: addressObj,
    satoshis: params.indexPreTxOutputAmount,
  });
  for (const utxo of pickedUtxos) {
    txComposer.appendP2PKHInput({
      address: addressObj,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
      satoshis: utxo.satoshis,
    });
  }
  txComposer.appendChangeOutput(addressObj, params.feeRate);

  const tx = txComposer.tx;
  for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex += 1) {
    txComposer.unlockP2PKHInput(privateKey, inputIndex);
  }

  const txHex = txComposer.getRawHex();
  const txId = tx.id;
  const changeIndex = tx.outputs.length > 2 ? tx.outputs.length - 1 : -1;

  return {
    txHex,
    txId,
    spentOutpoints: pickedUtxos.map((utxo) => getUtxoOutpointKey(utxo)),
    changeOutpoint: changeIndex >= 0 ? `${txId}:${changeIndex}` : null,
    privateKey,
  };
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
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as WorkerPayload;

  const filePath = String(payload.filePath || '').trim();
  const fileName = String(payload.fileName || '').trim();
  const metaId = String(payload.metaId || '').trim();
  const address = String(payload.address || '').trim();
  const contentType = String(payload.contentType || '').trim() || 'application/octet-stream';
  const size = Number(payload.size);
  const feeRateInput = Number(payload.feeRate);
  const maxSizeBytes = Number(payload.maxSizeBytes);
  const uploaderBaseUrl = normalizeUploaderBaseUrl(payload.uploaderBaseUrl);

  if (!filePath || !fileName || !metaId || !address || !Number.isFinite(size) || size <= 0) {
    console.log(JSON.stringify({ success: false, error: 'Invalid worker payload for large file upload' }));
    process.exit(1);
  }

  const fileBuffer = await fs.promises.readFile(filePath);
  if (fileBuffer.length !== size) {
    throw new Error(`File changed while preparing upload: expected ${size} bytes, got ${fileBuffer.length}`);
  }

  logStep('Fetching uploader config');
  const uploaderLimits = await fetchUploaderLimits(uploaderBaseUrl);
  const effectiveMaxSize = uploaderLimits.maxFileSize > 0
    ? Math.min(maxSizeBytes, uploaderLimits.maxFileSize)
    : maxSizeBytes;
  if (effectiveMaxSize > 0 && fileBuffer.length > effectiveMaxSize) {
    throw new Error(
      `File size exceeds the effective chunked-upload limit of ${formatMiB(effectiveMaxSize)}`,
    );
  }

  const feeRate = Number.isFinite(feeRateInput) && feeRateInput > 0
    ? Math.floor(feeRateInput)
    : Number.isFinite(uploaderLimits.feeRate) && uploaderLimits.feeRate > 0
      ? Math.floor(uploaderLimits.feeRate)
      : 1;
  const uploadPath = buildChunkedMetaFilePath(fileName);
  const storageKey = await uploadToMultipartStorage(
    uploaderBaseUrl,
    fileBuffer,
    fileName,
    metaId,
    address,
  );

  logStep('Estimating chunked upload fee');
  const estimate = await readJson<ChunkedEstimateData>(`${uploaderBaseUrl}/api/v1/files/estimate-chunked-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName,
      path: uploadPath,
      contentType,
      feeRate,
      storageKey,
    }),
  });
  const chunkPreTxFee = Number(estimate?.chunkPreTxFee ?? 0);
  const indexPreTxFee = Number(estimate?.indexPreTxFee ?? 0);
  if (!Number.isFinite(chunkPreTxFee) || chunkPreTxFee <= 0 || !Number.isFinite(indexPreTxFee) || indexPreTxFee <= 0) {
    throw new Error('Uploader did not return valid chunkPreTxFee/indexPreTxFee');
  }

  const chunkPreTxOutputAmount = chunkPreTxFee + Math.ceil((200 + 150) * feeRate);
  const indexPreTxOutputAmount = indexPreTxFee + Math.ceil((200 + 150) * feeRate);

  const addressIndex = parseAddressIndexFromPath(pathStr);
  const mvcWallet = await getMvcWallet(mnemonic, addressIndex);
  const senderWif = mvcWallet.getPrivateKey();
  const excludedOutpoints = new Set<string>();
  let indexTxId = '';
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRYABLE_CHUNKED_UPLOAD_ATTEMPTS; attempt++) {
    let pickedUtxos: ChunkedUploadFundingUtxo[] = [];
    try {
      const utxos = await fetchMvcFundingUtxos(address);
      const merge = buildChunkedUploadMergeTxLocally({
        senderWif,
        address,
        feeRate,
        chunkPreTxOutputAmount,
        indexPreTxOutputAmount,
        utxos,
        excludedOutpoints,
      });
      pickedUtxos = merge.spentOutpoints.map((outpoint) => {
        const matched = utxos.find((utxo) => getUtxoOutpointKey(utxo) === outpoint);
        if (!matched) {
          throw new Error(`Failed to resolve picked chunked-upload funding utxo: ${outpoint}`);
        }
        return matched;
      });
      logStep(`Building merge transaction with outpoints: ${pickedUtxos.map((utxo) => getUtxoOutpointKey(utxo)).join(', ')}`);

      const mergeTx = new mvc.Transaction(merge.txHex);
      if (mergeTx.outputs.length < 2) {
        throw new Error('Merge transaction did not produce the expected funding outputs');
      }

      const chunkPreTxHex = buildSignedPreTx({
        txId: merge.txId,
        outputIndex: 0,
        satoshis: Number(mergeTx.outputs[0].satoshis),
        address,
        privateKey: merge.privateKey,
      });
      const indexPreTxHex = buildSignedPreTx({
        txId: merge.txId,
        outputIndex: 1,
        satoshis: Number(mergeTx.outputs[1].satoshis),
        address,
        privateKey: merge.privateKey,
      });

      logStep('Submitting chunked upload to MetaFS');
      const uploadResult = await readJson<ChunkedUploadData>(`${uploaderBaseUrl}/api/v1/files/chunked-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metaId,
          address,
          fileName,
          path: uploadPath,
          operation: 'create',
          contentType,
          chunkPreTxHex,
          indexPreTxHex,
          mergeTxHex: merge.txHex,
          feeRate,
          isBroadcast: true,
          storageKey,
        }),
      });

      if (uploadResult?.status && uploadResult.status !== 'success') {
        throw new Error(uploadResult.message || `Chunked upload returned status ${uploadResult.status}`);
      }

      indexTxId = String(uploadResult?.indexTxId || uploadResult?.txId || '').trim();
      if (!indexTxId) {
        throw new Error('Chunked upload succeeded but indexTxId is missing');
      }
      break;
    } catch (error) {
      lastError = error;
      const message = getErrorMessage(error);
      if (attempt < RETRYABLE_CHUNKED_UPLOAD_ATTEMPTS && isRetryableChunkedUploadError(message)) {
        for (const utxo of pickedUtxos) {
          excludedOutpoints.add(getUtxoOutpointKey(utxo));
        }
        logStep(`Retrying chunked upload after stale-input failure: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, RETRYABLE_CHUNKED_UPLOAD_DELAY_MS));
        continue;
      }
      throw error;
    }
  }

  if (!indexTxId) {
    throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError ?? 'Chunked upload failed'));
  }

  console.log(
    JSON.stringify({
      success: true,
      pinId: `${indexTxId}i0`,
      fileName,
      size: fileBuffer.length,
      contentType,
      uploadMode: 'chunked',
      txId: indexTxId,
    }),
  );
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ success: false, error: getErrorMessage(err) }));
    process.exit(1);
  });
}
