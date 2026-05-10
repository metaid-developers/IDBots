import fs from 'fs';
import os from 'os';
import path from 'path';
import metaFileUploadShared from './metaFileUploadShared.js';

const {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  inferContentTypeFromFilePath,
} = metaFileUploadShared;

export const DELIVERY_CONTENT_BASE_URL = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
export const DELIVERY_ACCELERATE_CONTENT_BASE_URL = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);
const OTHER_EXPLICIT_EXTENSIONS = new Set([
  '.zip',
  '.pdf',
  '.txt',
  '.json',
  '.csv',
  '.md',
  '.html',
  '.xml',
  '.tar',
  '.gz',
]);
const ALL_REFERENCE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...OTHER_EXPLICIT_EXTENSIONS,
]);
const IGNORED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  '.vite',
]);

export function normalizeServiceOutputType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'text' || normalized === 'image' || normalized === 'video' || normalized === 'audio' || normalized === 'other') {
    return normalized;
  }
  return 'text';
}

function getDeliveryKindForPath(filePath, outputType) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (outputType === 'image') {
    return IMAGE_EXTENSIONS.has(ext) ? 'image' : null;
  }
  if (outputType === 'video') {
    return VIDEO_EXTENSIONS.has(ext) ? 'video' : null;
  }
  if (outputType === 'audio') {
    return AUDIO_EXTENSIONS.has(ext) ? 'audio' : null;
  }
  if (outputType === 'other') {
    return ext && !IMAGE_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext) && !AUDIO_EXTENSIONS.has(ext)
      ? 'other'
      : null;
  }
  return null;
}

function normalizeMentionedPath(candidate, cwd) {
  const trimmed = String(candidate || '')
    .trim()
    .replace(/^[`"'“‘《<（(]+/, '')
    .replace(/[`"'”’》。>,，,；;:：!！?？)）]+$/, '');
  if (!trimmed) return '';
  if (/^metafile:\/\//i.test(trimmed)) return '';

  const expanded = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : trimmed;
  return path.resolve(cwd || process.cwd(), expanded);
}

function normalizeScopeValue(value) {
  return String(value || '').trim().toLowerCase();
}

function parseMessageMetadata(message) {
  const metadata = message?.metadata;
  if (!metadata) return {};
  if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata;
  }
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function getMessageTime(message) {
  const raw = message?.created_at ?? message?.createdAt ?? message?.timestamp;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function metadataMatchesOrderScope(metadata, scope) {
  if (!metadata || typeof metadata !== 'object') return false;
  const orderTxid = scope.orderTxid;
  const paymentTxid = scope.paymentTxid;
  const metadataOrderTxids = [
    metadata.orderTxid,
    metadata.orderMessageTxid,
    metadata.orderMessageTxID,
  ].map(normalizeScopeValue).filter(Boolean);
  const metadataPaymentTxids = [
    metadata.paymentTxid,
    metadata.orderPaymentTxid,
    metadata.paymentTxID,
  ].map(normalizeScopeValue).filter(Boolean);
  return Boolean(
    (orderTxid && metadataOrderTxids.includes(orderTxid))
    || (paymentTxid && metadataPaymentTxids.includes(paymentTxid))
  );
}

function contentMatchesOrderScope(content, scope) {
  const text = normalizeScopeValue(content);
  if (!text) return false;
  return Boolean(
    (scope.orderTxid && text.includes(scope.orderTxid))
    || (scope.paymentTxid && text.includes(scope.paymentTxid))
  );
}

function filterMessagesForOrderScope(messages, input) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const scope = {
    orderTxid: normalizeScopeValue(input?.orderTxid),
    paymentTxid: normalizeScopeValue(input?.paymentTxid),
  };
  if (!scope.orderTxid && !scope.paymentTxid) {
    return sourceMessages;
  }

  const scoped = sourceMessages.filter((message) => {
    const metadata = parseMessageMetadata(message);
    return metadataMatchesOrderScope(metadata, scope)
      || contentMatchesOrderScope(message?.content, scope);
  });
  if (scoped.length > 0) {
    return scoped;
  }

  return filterMessagesForOrderTimeWindow(sourceMessages, input);
}

function filterMessagesForOrderTimeWindow(messages, input) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const startedAt = Number(input?.orderStartedAt);
  const endedAt = Number(input?.orderCompletedAt ?? input?.orderEndedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return [];
  }
  return sourceMessages.filter((message) => {
    const messageTime = getMessageTime(message);
    if (!messageTime) return false;
    if (messageTime < startedAt - 2000) return false;
    if (Number.isFinite(endedAt) && endedAt > 0 && messageTime > endedAt + 5000) return false;
    return true;
  });
}

function isNonArtifactStatusMessage(message) {
  const metadata = parseMessageMetadata(message);
  const orderProtocolTag = normalizeScopeValue(metadata.orderProtocolTag);
  if (
    orderProtocolTag === 'delivery'
    || orderProtocolTag === 'order_status'
    || orderProtocolTag === 'needsrating'
    || orderProtocolTag === 'order_end'
  ) {
    return true;
  }
  if (
    metadata.orderDeliveryMessage === true
    || metadata.orderDeliveryUploadNotice === true
    || metadata.orderDeliveryUploadRetryNotice === true
    || metadata.orderDeliveryFailed === true
    || metadata.orderDeliveryResent === true
    || metadata.orderDeliveryUploadComplete === true
    || metadata.orderProcessingNotice === true
    || metadata.orderTimeoutFallback === true
  ) {
    return true;
  }
  return /^\s*\[(?:DELIVERY|ORDER_STATUS|NeedsRating|ORDER_END)(?::|\]|\s)/i.test(String(message?.content || ''));
}

function makeArtifact(filePath, deliveryKind, source) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  if (stat.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
    return {
      status: 'invalid',
      reason: 'file_too_large',
      artifact: {
        filePath,
        fileName: path.basename(filePath),
        size: stat.size,
        contentType: inferContentTypeFromFilePath(filePath),
        deliveryKind,
        source,
      },
    };
  }
  return {
    status: 'found',
    artifact: {
      filePath,
      fileName: path.basename(filePath),
      size: stat.size,
      contentType: inferContentTypeFromFilePath(filePath),
      deliveryKind,
      source,
    },
  };
}

function collectExplicitPathCandidates(messages, cwd) {
  const candidates = [];
  const seen = new Set();
  const extensionPattern = Array.from(ALL_REFERENCE_EXTENSIONS)
    .map((ext) => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const regex = new RegExp(
    String.raw`(?:^|[\s:：，,（(])([~./A-Za-z0-9_\-][~./A-Za-z0-9_@\-]*\.(${extensionPattern}))(?=$|[\s。；;，,)）])`,
    'gi',
  );

  for (const [messageIndex, message] of (messages || []).entries()) {
    const content = String(message?.content || '');
    if (!content.trim()) continue;
    const messageTime = getMessageTime(message) || messageIndex;
    for (const match of content.matchAll(regex)) {
      const resolved = normalizeMentionedPath(match[1], cwd);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      candidates.push({
        filePath: resolved,
        messageTime,
        index: candidates.length,
      });
    }
  }
  return candidates
    .sort((left, right) => (
      right.messageTime - left.messageTime
      || right.index - left.index
    ))
    .map((candidate) => candidate.filePath);
}

function scanGeneratedCandidates(cwd, outputType, orderStartedAt, orderCompletedAt) {
  const root = path.resolve(String(cwd || process.cwd()));
  const startedAt = Number.isFinite(Number(orderStartedAt)) ? Number(orderStartedAt) : 0;
  const completedAt = Number.isFinite(Number(orderCompletedAt)) ? Number(orderCompletedAt) : 0;
  const candidates = [];

  function walk(dir, depth) {
    if (depth > 3 || candidates.length > 200) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (candidates.length > 200) return;
      if (entry.isDirectory()) {
        if (!IGNORED_SCAN_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name), depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      const deliveryKind = getDeliveryKindForPath(filePath, outputType);
      if (!deliveryKind) continue;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (startedAt && stat.mtimeMs < startedAt - 2000) continue;
      if (completedAt && stat.mtimeMs > completedAt + 5000) continue;
      candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  walk(root, 0);
  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((candidate) => candidate.filePath);
}

function resolveCandidate(filePath, outputType, source) {
  const deliveryKind = getDeliveryKindForPath(filePath, outputType);
  if (!deliveryKind) return null;
  return makeArtifact(filePath, deliveryKind, source);
}

function resolveExplicitCandidates(messages, cwd, outputType) {
  const explicitCandidates = collectExplicitPathCandidates(messages, cwd);
  for (const candidate of explicitCandidates) {
    const resolved = resolveCandidate(candidate, outputType, 'explicit');
    if (resolved?.status === 'invalid' || resolved?.status === 'found') {
      return resolved;
    }
  }
  return null;
}

export function resolveServiceDeliveryArtifact(input) {
  const outputType = normalizeServiceOutputType(input?.outputType);
  if (outputType === 'text') {
    return { status: 'not_required' };
  }

  const cwd = path.resolve(String(input?.cwd || process.cwd()));
  const scopedMessages = filterMessagesForOrderScope(input?.messages || [], input);
  let explicitMessages = scopedMessages.filter((message) => !isNonArtifactStatusMessage(message));
  let explicitResult = resolveExplicitCandidates(explicitMessages, cwd, outputType);
  if (explicitResult) {
    return explicitResult;
  }

  const timeWindowMessages = filterMessagesForOrderTimeWindow(input?.messages || [], input)
    .filter((message) => !isNonArtifactStatusMessage(message));
  if (timeWindowMessages.length > 0) {
    explicitResult = resolveExplicitCandidates(timeWindowMessages, cwd, outputType);
    if (explicitResult) {
      return explicitResult;
    }
  }

  if (outputType === 'image' || outputType === 'video' || outputType === 'audio') {
    for (const candidate of scanGeneratedCandidates(cwd, outputType, input?.orderStartedAt, input?.orderCompletedAt ?? input?.orderEndedAt)) {
      const resolved = resolveCandidate(candidate, outputType, 'generated');
      if (resolved?.status === 'invalid' || resolved?.status === 'found') {
        return resolved;
      }
    }
  }

  return { status: 'missing', reason: 'no_matching_file' };
}

function firstPositiveFiniteNumber(values, fallback) {
  for (const value of values) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && numberValue > 0) {
      return numberValue;
    }
  }
  return fallback;
}

export function buildServiceDeliveryArtifactResolutionInput(input) {
  const order = input?.order || {};
  const now = Number.isFinite(Number(input?.now)) ? Number(input.now) : Date.now();
  return {
    outputType: input?.outputType,
    cwd: input?.cwd,
    orderStartedAt: firstPositiveFiniteNumber([
      input?.orderStartedAt,
      order.createdAt,
    ], undefined),
    orderCompletedAt: firstPositiveFiniteNumber([
      input?.orderCompletedAt,
      input?.orderEndedAt,
      order.deliveredAt,
      order.failedAt,
      order.orderEndedAt,
    ], now),
    orderTxid: order.orderMessageTxid || order.orderTxid || input?.orderTxid,
    paymentTxid: order.paymentTxid || input?.paymentTxid,
    messages: input?.messages,
  };
}

export function resolveServiceDeliveryArtifactForOrder(input) {
  return resolveServiceDeliveryArtifact(buildServiceDeliveryArtifactResolutionInput(input));
}

function formatBytes(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(mib >= 10 ? 1 : 2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function getMetafileExtension(fileName, contentType) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext) return ext;
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('image/png')) return '.png';
  if (normalized.includes('image/jpeg')) return '.jpg';
  if (normalized.includes('video/mp4')) return '.mp4';
  if (normalized.includes('audio/mpeg')) return '.mp3';
  if (normalized.includes('audio/wav')) return '.wav';
  if (normalized.includes('audio/ogg')) return '.ogg';
  if (normalized.includes('application/zip')) return '.zip';
  return '';
}

export function buildMetafileUri(pinId, artifact) {
  const normalizedPinId = String(pinId || '').trim();
  if (!normalizedPinId) return '';
  return `metafile://${normalizedPinId}${getMetafileExtension(artifact?.fileName, artifact?.contentType)}`;
}

export function buildMetafileDeliverySummary(input) {
  const artifact = input?.artifact;
  const upload = input?.upload || {};
  const pinId = String(upload.pinId || '').trim();
  const metafileUri = buildMetafileUri(pinId, artifact);
  const downloadUrl = pinId ? `${DELIVERY_ACCELERATE_CONTENT_BASE_URL}/${encodeURIComponent(pinId)}` : '';
  const lines = [
    '数字成果已生成并上传链上交付。',
    metafileUri ? `交付文件: ${metafileUri}` : '',
    pinId ? `PINID: ${pinId}` : '',
    artifact?.fileName ? `文件名: ${artifact.fileName}` : '',
    artifact?.contentType ? `格式: ${artifact.contentType}` : '',
    artifact?.size != null ? `大小: ${formatBytes(artifact.size)}` : '',
    downloadUrl ? `下载链接: ${downloadUrl}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

export function getDeliveryArtifactPinId(upload) {
  return String(upload?.pinId || '').trim();
}

async function fetchWithTimeout(url, options = {}) {
  if (typeof fetch !== 'function') {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyDeliveryArtifactUpload(upload) {
  const pinId = getDeliveryArtifactPinId(upload);
  if (!pinId) {
    return false;
  }
  const url = `${DELIVERY_ACCELERATE_CONTENT_BASE_URL}/${encodeURIComponent(pinId)}`;
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD' });
    if (head?.ok) {
      return true;
    }
    const get = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });
    return Boolean(get?.ok);
  } catch {
    return false;
  }
}

export async function uploadVerifiedDeliveryArtifact(input) {
  const artifact = input?.artifact;
  const request = input?.request || {};
  const uploadDeliveryArtifact = input?.uploadDeliveryArtifact;
  const verifyUpload = input?.verifyDeliveryArtifactUpload;
  const maxAttempts = Math.max(1, Math.trunc(Number(input?.maxAttempts) || 2));
  if (typeof uploadDeliveryArtifact !== 'function') {
    throw new Error('Delivery artifact uploader is not available');
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const upload = await uploadDeliveryArtifact(artifact, request);
      const pinId = getDeliveryArtifactPinId(upload);
      if (!pinId) {
        throw new Error('Upload returned empty pinId');
      }
      const verified = typeof verifyUpload === 'function'
        ? await verifyUpload(upload, artifact, request)
        : true;
      if (!verified) {
        throw new Error(`Delivery artifact PINID ${pinId} could not be verified`);
      }
      return {
        ok: true,
        upload,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && typeof input?.onRetry === 'function') {
        await input.onRetry({ attempt, error });
      }
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    error: lastError instanceof Error ? lastError : new Error(String(lastError || 'Delivery artifact upload failed')),
  };
}
