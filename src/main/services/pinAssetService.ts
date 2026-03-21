import { Buffer } from 'buffer';
import { fetchContentWithFallback } from './localIndexerProxy';

const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/content';
const PIN_CONTENT_PATTERNS = [
  /^\/content\/([^/?#]+)/i,
  /^\/metafile-indexer\/content\/([^/?#]+)/i,
  /^\/metafile-indexer\/thumbnail\/([^/?#]+)/i,
  /^\/metafile-indexer\/api\/v1\/files\/content\/([^/?#]+)/i,
];

const resolvedPinAssetCache = new Map<string, Promise<string | null>>();

const normalizeReference = (reference: string | null | undefined): string => (
  typeof reference === 'string' ? reference.trim() : ''
);

export function clearResolvedPinAssetCache(): void {
  resolvedPinAssetCache.clear();
}

export function extractPinIdFromReference(reference: string | null | undefined): string | null {
  const normalized = normalizeReference(reference);
  if (!normalized || normalized.startsWith('data:')) {
    return null;
  }

  if (normalized.toLowerCase().startsWith('metafile://')) {
    const pinId = normalized.slice('metafile://'.length).trim();
    return pinId || null;
  }

  for (const pattern of PIN_CONTENT_PATTERNS) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      for (const pattern of PIN_CONTENT_PATTERNS) {
        const match = url.pathname.match(pattern);
        if (match?.[1]) {
          return decodeURIComponent(match[1]);
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  if (!normalized.includes('/') && !normalized.includes(':')) {
    return normalized;
  }

  return null;
}

export function resolveMetaidAvatarReference(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) {
    return null;
  }

  const avatarId = normalizeReference(typeof data.avatarId === 'string' ? data.avatarId : null);
  if (avatarId) {
    return avatarId;
  }

  const avatar = normalizeReference(typeof data.avatar === 'string' ? data.avatar : null);
  if (avatar) {
    return avatar;
  }

  const contentId = normalizeReference(typeof data.contentId === 'string' ? data.contentId : null);
  if (contentId) {
    return contentId;
  }

  return null;
}

async function resolvePinAssetSourceUncached(reference: string): Promise<string | null> {
  if (reference.startsWith('data:')) {
    return reference;
  }

  if (/^https?:\/\//i.test(reference) && !extractPinIdFromReference(reference)) {
    return reference;
  }

  const pinId = extractPinIdFromReference(reference);
  if (!pinId) {
    return null;
  }

  const response = await fetchContentWithFallback(
    pinId,
    `${METAID_CONTENT_BASE}/${encodeURIComponent(pinId)}`,
  );
  if (!response.ok) {
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    return null;
  }

  const mime = (response.headers.get('content-type') || 'application/octet-stream')
    .split(';')[0]
    .trim();
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

export async function resolvePinAssetSource(reference: string | null | undefined): Promise<string | null> {
  const normalized = normalizeReference(reference);
  if (!normalized) {
    return null;
  }

  const cached = resolvedPinAssetCache.get(normalized);
  if (cached) {
    return cached;
  }

  const pending = resolvePinAssetSourceUncached(normalized)
    .then((result) => {
      if (!result) {
        resolvedPinAssetCache.delete(normalized);
      }
      return result;
    })
    .catch((error) => {
      resolvedPinAssetCache.delete(normalized);
      console.warn('[pin-asset] resolve failed', normalized, error instanceof Error ? error.message : String(error));
      return null;
    });

  resolvedPinAssetCache.set(normalized, pending);
  return pending;
}

export async function resolveMetaidAvatarSource(data: Record<string, unknown> | null | undefined): Promise<string | null> {
  return resolvePinAssetSource(resolveMetaidAvatarReference(data));
}
