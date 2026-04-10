const RAW_GLOBAL_META_ID_VERSION_CHARS = new Set(['q', 'p', 'z', 'r', 'y', 't']);

export function normalizeRawGlobalMetaId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('metaid:')) {
    return null;
  }
  if (!normalized.startsWith('id')) {
    return null;
  }
  if (!RAW_GLOBAL_META_ID_VERSION_CHARS.has(normalized[2] ?? '')) {
    return null;
  }
  if (normalized[3] !== '1') {
    return null;
  }

  return normalized;
}
