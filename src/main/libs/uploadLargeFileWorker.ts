import fs from 'fs';
import { API_NET, API_TARGET, TxComposer, Wallet, mvc } from 'meta-contract';
import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';

const {
  buildChunkedMetaFilePath,
  formatMiB,
  normalizeUploaderBaseUrl,
} = require('../services/metaFileUploadShared');

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const DEFAULT_MULTIPART_PART_SIZE = 1024 * 1024;
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

interface NormalizedUtxo {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  height: number;
  flag: string;
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

function normalizeUtxos(input: unknown, address: string): NormalizedUtxo[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const record = item as Record<string, unknown>;
      const txId = String(record.txId ?? record.txid ?? '').trim();
      const outputIndex = Number(record.outputIndex ?? record.outIndex ?? record.vout);
      const satoshis = Number(record.satoshis ?? record.value ?? 0);
      const height = Number(record.height ?? 0);
      return {
        txId,
        outputIndex,
        satoshis,
        address: String(record.address || address).trim() || address,
        height: Number.isFinite(height) ? height : 0,
        flag: String(record.flag || ''),
      };
    })
    .filter((utxo) => /^[0-9a-fA-F]{64}$/.test(utxo.txId) && Number.isInteger(utxo.outputIndex) && utxo.outputIndex >= 0 && utxo.satoshis > 600);
}

function pickUtxos(utxos: NormalizedUtxo[], amount: number, feeRate: number): NormalizedUtxo[] {
  let requiredAmount = amount + 34 * 2 * feeRate + 100;
  const candidateUtxos: NormalizedUtxo[] = [];
  const confirmed = utxos.filter((utxo) => utxo.height > 0).sort(() => Math.random() - 0.5);
  const unconfirmed = utxos.filter((utxo) => utxo.height <= 0).sort(() => Math.random() - 0.5);

  let current = 0;
  for (const utxo of [...confirmed, ...unconfirmed]) {
    current += utxo.satoshis;
    requiredAmount += feeRate * 148;
    candidateUtxos.push(utxo);
    if (current > requiredAmount) {
      return candidateUtxos;
    }
  }

  throw new Error('Insufficient MVC balance for chunked upload');
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
  const wallet = new Wallet(senderWif, API_NET.MAIN, feeRate, API_TARGET.APIMVC);
  const utxos = normalizeUtxos(await wallet.api.getUnspents(address), address);
  const pickedUtxos = pickUtxos(utxos, chunkPreTxOutputAmount + indexPreTxOutputAmount, feeRate);

  logStep('Building merge transaction');
  const merge = await wallet.sendArray(
    [
      { address, amount: chunkPreTxOutputAmount },
      { address, amount: indexPreTxOutputAmount },
    ],
    pickedUtxos,
    { noBroadcast: true },
  );

  const mergeTx = new mvc.Transaction(merge.txHex);
  if (mergeTx.outputs.length < 2) {
    throw new Error('Merge transaction did not produce the expected funding outputs');
  }

  const chunkPreTxHex = buildSignedPreTx({
    txId: merge.txId,
    outputIndex: 0,
    satoshis: Number(mergeTx.outputs[0].satoshis),
    address,
    privateKey: wallet.privateKey,
  });
  const indexPreTxHex = buildSignedPreTx({
    txId: merge.txId,
    outputIndex: 1,
    satoshis: Number(mergeTx.outputs[1].satoshis),
    address,
    privateKey: wallet.privateKey,
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

  const indexTxId = String(uploadResult?.indexTxId || uploadResult?.txId || '').trim();
  if (!indexTxId) {
    throw new Error('Chunked upload succeeded but indexTxId is missing');
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

main().catch((err: unknown) => {
  console.error(JSON.stringify({ success: false, error: getErrorMessage(err) }));
  process.exit(1);
});
