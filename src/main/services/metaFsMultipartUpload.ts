import fs from 'fs';

const DEFAULT_METAFS_UPLOADER_BASE = 'https://file.metaid.io/metafile-uploader';
const DEFAULT_MULTIPART_PART_SIZE = 1024 * 1024;

interface MetaFsEnvelope<T> {
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

export interface MetaFsUploaderConfig {
  maxFileSize: number;
  feeRate: number;
  chunkSize: number;
}

export interface UploadMetaFsMultipartInput {
  filePath?: string;
  data?: Buffer;
  fileName: string;
  size: number;
  metaId: string;
  address: string;
  maxSizeBytes?: number;
  uploaderBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface UploadMetaFsMultipartResult {
  storageKey: string;
  uploaderBaseUrl: string;
  limits: MetaFsUploaderConfig;
}

function normalizeUploaderBase(url?: string): string {
  const normalized = String(url || '').trim();
  return (normalized || DEFAULT_METAFS_UPLOADER_BASE).replace(/\/+$/, '');
}

async function readMetaFsJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let parsed: MetaFsEnvelope<T> | null = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as MetaFsEnvelope<T>;
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    throw new Error(parsed?.message || text || `HTTP ${response.status}`);
  }
  if (parsed?.code != null && parsed.code !== 0) {
    throw new Error(parsed.message || 'MetaFS uploader request failed');
  }
  return (parsed?.data ?? (parsed as unknown)) as T;
}

export async function fetchMetaFsUploaderLimits(
  uploaderBaseUrl?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MetaFsUploaderConfig> {
  const baseUrl = normalizeUploaderBase(uploaderBaseUrl);
  const config = await readMetaFsJson<{
    maxFileSize?: number;
    chains?: Record<string, { maxFileSize?: number; chunkSize?: number; feeRate?: number }>;
  }>(fetchImpl, `${baseUrl}/api/v1/config`);
  const mvcConfig = config?.chains?.mvc ?? {};
  const chunkSize = Number(mvcConfig.chunkSize ?? 0);
  return {
    maxFileSize: Number(mvcConfig.maxFileSize ?? config?.maxFileSize ?? 0),
    feeRate: Number(mvcConfig.feeRate ?? 0),
    chunkSize: Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : DEFAULT_MULTIPART_PART_SIZE,
  };
}

export async function uploadFileToMetaFsMultipart(
  input: UploadMetaFsMultipartInput,
): Promise<UploadMetaFsMultipartResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = normalizeUploaderBase(input.uploaderBaseUrl);
  const limits = await fetchMetaFsUploaderLimits(baseUrl, fetchImpl);
  const maxSizeBytes = Number(input.maxSizeBytes ?? 0);
  const effectiveMaxSize = limits.maxFileSize > 0 && maxSizeBytes > 0
    ? Math.min(maxSizeBytes, limits.maxFileSize)
    : maxSizeBytes > 0
      ? maxSizeBytes
      : limits.maxFileSize;
  if (effectiveMaxSize > 0 && input.size > effectiveMaxSize) {
    const mib = effectiveMaxSize / (1024 * 1024);
    const label = Number.isInteger(mib) ? `${mib} MiB` : `${mib.toFixed(2)} MiB`;
    throw new Error(`File size exceeds the effective chunked-upload limit of ${label}`);
  }

  const initiate = await readMetaFsJson<MultipartInitiateData>(
    fetchImpl,
    `${baseUrl}/api/v1/files/multipart/initiate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: input.fileName,
        fileSize: input.size,
        metaId: input.metaId,
        address: input.address,
      }),
    },
  );
  if (!initiate?.uploadId || !initiate?.key) {
    throw new Error('multipart initiate did not return uploadId/key');
  }

  const totalParts = Math.ceil(input.size / DEFAULT_MULTIPART_PART_SIZE);
  const parts: Array<{ partNumber: number; etag: string; size: number }> = [];

  if (Buffer.isBuffer(input.data)) {
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      const start = (partNumber - 1) * DEFAULT_MULTIPART_PART_SIZE;
      const end = Math.min(start + DEFAULT_MULTIPART_PART_SIZE, input.size);
      const partBuffer = input.data.subarray(start, end);
      const part = await readMetaFsJson<MultipartUploadPartData>(
        fetchImpl,
        `${baseUrl}/api/v1/files/multipart/upload-part`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uploadId: initiate.uploadId,
            key: initiate.key,
            partNumber,
            content: partBuffer.toString('base64'),
          }),
        },
      );
      if (!part?.etag) {
        throw new Error(`multipart upload-part ${partNumber} did not return etag`);
      }
      parts.push({ partNumber, etag: part.etag, size: end - start });
    }
  } else {
    const filePath = String(input.filePath || '').trim();
    if (!filePath) {
      throw new Error('Either filePath or data is required for multipart upload');
    }
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size !== input.size) {
        throw new Error(`File changed while preparing upload: expected ${input.size} bytes, got ${stat.size}`);
      }
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        const start = (partNumber - 1) * DEFAULT_MULTIPART_PART_SIZE;
        const length = Math.min(DEFAULT_MULTIPART_PART_SIZE, input.size - start);
        const partBuffer = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(partBuffer, offset, length - offset, start + offset);
          if (bytesRead <= 0) {
            throw new Error(`Unexpected EOF reading multipart chunk ${partNumber}`);
          }
          offset += bytesRead;
        }
        const part = await readMetaFsJson<MultipartUploadPartData>(
          fetchImpl,
          `${baseUrl}/api/v1/files/multipart/upload-part`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              uploadId: initiate.uploadId,
              key: initiate.key,
              partNumber,
              content: partBuffer.toString('base64'),
            }),
          },
        );
        if (!part?.etag) {
          throw new Error(`multipart upload-part ${partNumber} did not return etag`);
        }
        parts.push({ partNumber, etag: part.etag, size: length });
      }
    } finally {
      await handle.close();
    }
  }

  const complete = await readMetaFsJson<MultipartCompleteData>(
    fetchImpl,
    `${baseUrl}/api/v1/files/multipart/complete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: initiate.uploadId,
        key: initiate.key,
        parts,
      }),
    },
  );

  return {
    storageKey: String(complete?.key || initiate.key).trim(),
    uploaderBaseUrl: baseUrl,
    limits,
  };
}
