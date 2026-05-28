import { extractPinIdFromReference, resolvePinAssetSource } from './pinAssetService';

const METAFILE_ACCELERATE_CONTENT_API_BASE_URL = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/';

type MetaAppVisualRecord = {
  icon?: string;
  cover?: string;
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

export const resolveMetaAppVisualFields = async <T extends MetaAppVisualRecord>(
  record: T,
  options: ResolveMetaAppVisualOptions = {},
): Promise<T> => {
  if (options.preferRemoteAssetUrls) {
    return {
      ...record,
      icon: resolveRemoteAssetUrl(record.icon),
      cover: resolveRemoteAssetUrl(record.cover),
    };
  }

  const [icon, cover] = await Promise.all([
    record.icon ? resolvePinAssetSource(record.icon) : Promise.resolve(null),
    record.cover ? resolvePinAssetSource(record.cover) : Promise.resolve(null),
  ]);
  return {
    ...record,
    icon: icon || normalizeMetaAppVisualFallback(record.icon),
    cover: cover || normalizeMetaAppVisualFallback(record.cover),
  };
};
