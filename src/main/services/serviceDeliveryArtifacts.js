import fs from 'fs';
import os from 'os';
import path from 'path';
import metaFileUploadShared from './metaFileUploadShared.js';

const {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  inferContentTypeFromFilePath,
} = metaFileUploadShared;

export const DELIVERY_CONTENT_BASE_URL = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
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
  ...OTHER_EXPLICIT_EXTENSIONS,
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
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
  if (normalized === 'text' || normalized === 'image' || normalized === 'video' || normalized === 'other') {
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
  if (outputType === 'other') {
    return ext && !IMAGE_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)
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

  for (const message of messages || []) {
    const content = String(message?.content || '');
    if (!content.trim()) continue;
    for (const match of content.matchAll(regex)) {
      const resolved = normalizeMentionedPath(match[1], cwd);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      candidates.push(resolved);
    }
  }
  return candidates;
}

function scanGeneratedCandidates(cwd, outputType, orderStartedAt) {
  const root = path.resolve(String(cwd || process.cwd()));
  const startedAt = Number.isFinite(Number(orderStartedAt)) ? Number(orderStartedAt) : 0;
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

export function resolveServiceDeliveryArtifact(input) {
  const outputType = normalizeServiceOutputType(input?.outputType);
  if (outputType === 'text') {
    return { status: 'not_required' };
  }

  const cwd = path.resolve(String(input?.cwd || process.cwd()));
  const explicitCandidates = collectExplicitPathCandidates(input?.messages || [], cwd);
  for (const candidate of explicitCandidates) {
    const resolved = resolveCandidate(candidate, outputType, 'explicit');
    if (resolved?.status === 'invalid' || resolved?.status === 'found') {
      return resolved;
    }
  }

  if (outputType === 'image' || outputType === 'video') {
    for (const candidate of scanGeneratedCandidates(cwd, outputType, input?.orderStartedAt)) {
      const resolved = resolveCandidate(candidate, outputType, 'generated');
      if (resolved?.status === 'invalid' || resolved?.status === 'found') {
        return resolved;
      }
    }
  }

  return { status: 'missing', reason: 'no_matching_file' };
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
  const downloadUrl = pinId ? `${DELIVERY_CONTENT_BASE_URL}/${encodeURIComponent(pinId)}` : '';
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
