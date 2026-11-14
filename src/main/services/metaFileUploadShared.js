import path from 'path';

const DEFAULT_CHUNK_THRESHOLD_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_METAFS_UPLOADER_BASE = 'https://file.metaid.io/metafile-uploader';
const PREVIEW_URL_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
const DOWNLOAD_URL_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';
const LEGACY_CONTENT_URL_BASE = 'https://file.metaid.io/metafile-indexer/content';
const METAWEB_SHARE_BASE = 'https://openagentinternet.org/browser/metafile';
const METAFILE_URI_PREFIX = 'metafile://';
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
const CONTENT_TYPE_EXTENSION_MAP = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-tar': '.tar',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/css': '.css',
  'application/javascript': '.js',
  'application/x-javascript': '.js',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/markdown': '.md',
  'text/csv': '.csv',
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
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function normalizeMetafileExtension(ext) {
  const normalized = String(ext || '').trim().toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(normalized) ? normalized : '';
}

function getMetafileExtension(input = {}) {
  const fileName = String(input.fileName || input.filePath || '').trim();
  const fileExt = normalizeMetafileExtension(path.extname(fileName));
  if (fileExt) return fileExt;

  const contentType = String(input.contentType || '').split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSION_MAP[contentType] || '';
}

function stripMetafileUriPrefix(value) {
  const text = String(value || '').trim();
  return text.toLowerCase().startsWith(METAFILE_URI_PREFIX)
    ? text.slice(METAFILE_URI_PREFIX.length).trim()
    : text;
}

function hasMetafileUriExtension(pinIdOrUri) {
  const raw = stripMetafileUriPrefix(pinIdOrUri).split('?')[0].split('#')[0].trim();
  const tail = raw.split('/').pop() || raw;
  return Boolean(normalizeMetafileExtension(path.extname(tail)));
}

function buildMetafileUri(pinIdOrUri, input = {}) {
  const raw = stripMetafileUriPrefix(pinIdOrUri);
  if (!raw) {
    throw new Error('pinId is required');
  }
  const extension = hasMetafileUriExtension(raw) ? '' : getMetafileExtension(input);
  return `${METAFILE_URI_PREFIX}${raw}${extension}`;
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
  if (normalized === 'mvc' || normalized === 'btc' || normalized === 'opcat') {
    return normalized;
  }
  if (normalized === 'doge') {
    throw new Error('DOGE is not supported for file upload. Use mvc, btc, or opcat.');
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
  return sizeBytes >= chunkThresholdBytes ? 'chunked' : 'direct';
}

function validateUploadSize({ sizeBytes, maxSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES }) {
  assertPositiveInteger(sizeBytes, 'sizeBytes');
  assertPositiveInteger(maxSizeBytes, 'maxSizeBytes');
  if (sizeBytes > maxSizeBytes) {
    throw new Error(`File exceeds maximum upload size of ${maxSizeBytes} bytes.`);
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

function buildDownloadUrl(pinId) {
  const normalizedPinId = String(pinId || '').trim();
  if (!normalizedPinId) {
    throw new Error('pinId is required');
  }
  return `${DOWNLOAD_URL_BASE}/${normalizedPinId}`;
}

function buildLegacyContentUrl(pinId) {
  const normalizedPinId = String(pinId || '').trim();
  if (!normalizedPinId) {
    throw new Error('pinId is required');
  }
  return `${LEGACY_CONTENT_URL_BASE}/${normalizedPinId}`;
}

function buildMetawebUrl(pinId) {
  const normalizedPinId = String(pinId || '').trim();
  if (!normalizedPinId) {
    throw new Error('pinId is required');
  }
  return `${METAWEB_SHARE_BASE}/${normalizedPinId}`;
}

function buildUploadSuccessPayload({
  pinId,
  fileName,
  size,
  contentType,
  uploadMode,
  network,
  txids,
  totalCost,
  globalMetaId,
}) {
  const normalizedPinId = String(pinId || '').trim();
  if (!normalizedPinId) {
    throw new Error('pinId is required');
  }

  assertPositiveInteger(size, 'size');

  const normalizedUploadMode = uploadMode === 'chunked' ? 'chunked' : 'direct';
  const extension = getMetafileExtension({ fileName, contentType });
  const normalizedTxids = Array.isArray(txids)
    ? txids.map((txid) => String(txid || '').trim()).filter(Boolean)
    : [];
  const hasTotalCost = Number.isFinite(Number(totalCost)) && Number(totalCost) >= 0;

  return {
    success: true,
    pinId: normalizedPinId,
    metafileUri: buildMetafileUri(normalizedPinId, { fileName, contentType }),
    previewUrl: buildPreviewUrl(normalizedPinId),
    downloadUrl: buildDownloadUrl(normalizedPinId),
    metawebUrl: buildMetawebUrl(normalizedPinId),
    fileName: String(fileName || ''),
    size,
    bytes: size,
    extension,
    contentType: String(contentType || 'application/octet-stream'),
    uploadMode: normalizedUploadMode,
    network: String(network || 'mvc').toLowerCase(),
    txids: normalizedTxids,
    ...(hasTotalCost ? { totalCost: Number(totalCost) } : {}),
    ...(globalMetaId ? { globalMetaId: String(globalMetaId).trim() } : {}),
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
    network: payload.network,
    txids: payload.txids,
    totalCost: payload.totalCost,
    globalMetaId: payload.globalMetaId,
  });
}

const metaFileUploadShared = {
  DEFAULT_CHUNK_THRESHOLD_BYTES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_METAFS_UPLOADER_BASE,
  MIME_MAP,
  CONTENT_TYPE_EXTENSION_MAP,
  buildChunkedMetaFilePath,
  LEGACY_CONTENT_URL_BASE,
  METAFILE_URI_PREFIX,
  METAWEB_SHARE_BASE,
  PREVIEW_URL_BASE,
  DOWNLOAD_URL_BASE,
  buildDownloadUrl,
  buildLegacyContentUrl,
  buildMetawebUrl,
  buildMetafileUri,
  buildPreviewUrl,
  buildUploadSuccessPayload,
  formatMiB,
  getMetafileExtension,
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

export {
  DEFAULT_CHUNK_THRESHOLD_BYTES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_METAFS_UPLOADER_BASE,
  CONTENT_TYPE_EXTENSION_MAP,
  LEGACY_CONTENT_URL_BASE,
  METAFILE_URI_PREFIX,
  METAWEB_SHARE_BASE,
  MIME_MAP,
  PREVIEW_URL_BASE,
  DOWNLOAD_URL_BASE,
  buildChunkedMetaFilePath,
  buildDownloadUrl,
  buildLegacyContentUrl,
  buildMetawebUrl,
  buildMetafileUri,
  buildPreviewUrl,
  buildUploadSuccessPayload,
  formatMiB,
  getMetafileExtension,
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

export default metaFileUploadShared;
