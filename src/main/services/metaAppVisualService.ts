import fs from 'fs';
import path from 'path';
import { extractPinIdFromReference, resolvePinAssetSource } from './pinAssetService';

const METAFILE_ACCELERATE_CONTENT_API_BASE_URL = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/';

type MetaAppVisualRecord = {
  id?: string;
  appRoot?: string;
  icon?: string;
  cover?: string;
  authorAvatar?: string;
};

type ResolveMetaAppVisualOptions = {
  preferRemoteAssetUrls?: boolean;
};

const normalizeMetaAppVisualFallback = (value?: string): string | undefined => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.toLowerCase().startsWith('metafile://')) {
    return undefined;
  }
  return normalized;
};

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const isPathInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const toLocalMetaAppRelativePath = (record: MetaAppVisualRecord, reference: string): string | null => {
  if (!record.appRoot || !reference || reference.startsWith('data:') || /^https?:\/\//i.test(reference)) {
    return null;
  }
  if (
    reference.toLowerCase().startsWith('metafile://')
    || /^\/(?:content|metafile-indexer)\//i.test(reference)
    || (!reference.includes('/') && !reference.includes('\\') && !reference.includes(':') && !path.extname(reference))
  ) {
    return null;
  }

  const normalizedReference = reference.replace(/\\/g, '/').trim();
  let relativePath = normalizedReference.replace(/^\.\/+/, '');
  if (relativePath.startsWith('/')) {
    const appId = String(record.id || '').trim();
    const appPrefix = appId ? `/${appId}/` : '';
    if (!appPrefix || !relativePath.startsWith(appPrefix)) {
      return null;
    }
    relativePath = relativePath.slice(appPrefix.length);
  }

  const normalizedRelativePath = path.posix.normalize(relativePath);
  if (
    !normalizedRelativePath
    || normalizedRelativePath === '.'
    || normalizedRelativePath === '..'
    || normalizedRelativePath.startsWith('../')
    || path.posix.isAbsolute(normalizedRelativePath)
  ) {
    return null;
  }
  return normalizedRelativePath;
};

const resolveLocalMetaAppVisualSource = (
  record: MetaAppVisualRecord,
  reference?: string,
): string | null => {
  const normalized = String(reference || '').trim();
  const relativePath = toLocalMetaAppRelativePath(record, normalized);
  if (!relativePath || !record.appRoot) {
    return null;
  }

  try {
    const appRootRealPath = fs.realpathSync.native(path.resolve(record.appRoot));
    const candidatePath = path.resolve(appRootRealPath, ...relativePath.split('/'));
    const candidateRealPath = fs.realpathSync.native(candidatePath);
    if (!isPathInside(appRootRealPath, candidateRealPath)) {
      return null;
    }

    const stat = fs.statSync(candidateRealPath);
    if (!stat.isFile()) {
      return null;
    }

    const mime = IMAGE_MIME_BY_EXTENSION[path.extname(candidateRealPath).toLowerCase()] || 'application/octet-stream';
    const buffer = fs.readFileSync(candidateRealPath);
    if (!buffer.length) {
      return null;
    }
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
};

const resolveRemoteAssetUrl = (value?: string): string | undefined => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return undefined;
  }

  const pinId = extractPinIdFromReference(normalized);
  if (pinId) {
    return `${METAFILE_ACCELERATE_CONTENT_API_BASE_URL}${encodeURIComponent(pinId)}`;
  }

  return normalizeMetaAppVisualFallback(normalized);
};

const resolveLocalOrPinnedVisualSource = async (
  record: MetaAppVisualRecord,
  value?: string,
): Promise<string | undefined> => {
  const localSource = resolveLocalMetaAppVisualSource(record, value);
  if (localSource) {
    return localSource;
  }

  const pinSource = value ? await resolvePinAssetSource(value) : null;
  return pinSource || normalizeMetaAppVisualFallback(value);
};

export const resolveMetaAppVisualFields = async <T extends MetaAppVisualRecord>(
  record: T,
  options: ResolveMetaAppVisualOptions = {},
): Promise<T> => {
  if (options.preferRemoteAssetUrls) {
    return {
      ...record,
      icon: resolveRemoteAssetUrl(record.icon),
      cover: resolveRemoteAssetUrl(record.cover),
      authorAvatar: resolveRemoteAssetUrl(record.authorAvatar),
    };
  }

  const [icon, cover] = await Promise.all([
    resolveLocalOrPinnedVisualSource(record, record.icon),
    resolveLocalOrPinnedVisualSource(record, record.cover),
  ]);
  return {
    ...record,
    icon,
    cover,
  };
};
