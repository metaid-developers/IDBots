const DEFAULT_CHUNK_THRESHOLD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const DEFAULT_METAFS_UPLOADER_BASE = 'https://file.metaid.io/metafile-uploader';
const PREVIEW_URL_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
};

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}

function formatMiB(bytes) {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MiB` : `${mib.toFixed(2)} MiB`;
}

function inferContentTypeFromFilePath(filePath) {
  const path = require('path');
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function isTextContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase().trim();
  return (
    normalized.startsWith('text/') ||
    normalized.startsWith('application/json') ||
    normalized.startsWith('application/javascript') ||
    normalized.startsWith('application/xml')
  );
}

function normalizeUploadContentType(contentType) {
  const normalized = String(contentType || '').trim() || 'application/octet-stream';
  if (isTextContentType(normalized)) {
    return normalized;
  }
  return normalized.includes(';binary') ? normalized : `${normalized};binary`;
}

function sanitizeUploadPathSegment(name) {
  const normalized = String(name || '').trim().replace(/[^\w.-]/g, '_');
  return normalized || 'file';
}

function buildChunkedMetaFilePath(fileName) {
  return `/file/${sanitizeUploadPathSegment(fileName)}`;
}

function normalizeUploadNetwork(network) {
  const normalized = String(network || '').trim().toLowerCase();
  if (normalized === 'doge' || normalized === 'btc') {
    return normalized;
  }
  return 'mvc';
}

function normalizeUploaderBaseUrl(url) {
  const normalized = String(url || '').trim();
  return (normalized || DEFAULT_METAFS_UPLOADER_BASE).replace(/\/+$/, '');
}

function selectUploadMode({ sizeBytes, chunkThresholdBytes = DEFAULT_CHUNK_THRESHOLD_BYTES }) {
  assertPositiveInteger(sizeBytes, 'sizeBytes');
  assertPositiveInteger(chunkThresholdBytes, 'chunkThresholdBytes');
  return sizeBytes > chunkThresholdBytes ? 'chunked' : 'direct';
}

function validateUploadSize({ sizeBytes, maxSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES }) {
  assertPositiveInteger(sizeBytes, 'sizeBytes');
  assertPositiveInteger(maxSizeBytes, 'maxSizeBytes');
  if (sizeBytes > maxSizeBytes) {
    throw new Error(`File size exceeds the ${formatMiB(maxSizeBytes)} hard limit`);
  }
  return sizeBytes;
}

function buildPreviewUrl(pinId) {
  const normalizedPinId = String(pinId || '').trim();
  if (!normalizedPinId) {
    throw new Error('pinId is required');
  }
  return `${PREVIEW_URL_BASE}/${normalizedPinId}`;
}

function buildUploadSuccessPayload({
  pinId,
  fileName,
  size,
  contentType,
  uploadMode,
}) {
  const normalizedPinId = String(pinId || '').trim();
  if (!normalizedPinId) {
    throw new Error('pinId is required');
  }

  assertPositiveInteger(size, 'size');

  return {
    success: true,
    pinId: normalizedPinId,
    previewUrl: buildPreviewUrl(normalizedPinId),
    fileName: String(fileName || ''),
    size,
    contentType: String(contentType || 'application/octet-stream'),
    uploadMode: uploadMode === 'chunked' ? 'chunked' : 'direct',
  };
}

function normalizeRpcUploadResult(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('upload result payload is required');
  }

  if (payload.success === false) {
    return payload;
  }

  return buildUploadSuccessPayload({
    pinId: payload.pinId,
    fileName: payload.fileName,
    size: Number(payload.size),
    contentType: payload.contentType,
    uploadMode: payload.uploadMode,
  });
}

module.exports = {
  DEFAULT_CHUNK_THRESHOLD_BYTES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_METAFS_UPLOADER_BASE,
  MIME_MAP,
  buildChunkedMetaFilePath,
  PREVIEW_URL_BASE,
  buildPreviewUrl,
  buildUploadSuccessPayload,
  formatMiB,
  inferContentTypeFromFilePath,
  isTextContentType,
  normalizeRpcUploadResult,
  normalizeUploadContentType,
  normalizeUploadNetwork,
  normalizeUploaderBaseUrl,
  sanitizeUploadPathSegment,
  selectUploadMode,
  validateUploadSize,
};
