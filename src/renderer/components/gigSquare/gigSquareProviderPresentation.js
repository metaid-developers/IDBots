import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths.js';

export const DEFAULT_GIG_SQUARE_PROVIDER_AVATAR = getDefaultMetabotAvatarUrl();

export function formatGigSquareProviderId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  if (normalized.length <= 16) return normalized;
  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
}

export function shortenGigSquareProviderGlobalMetaId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  if (normalized.length <= 16) return normalized;
  return `${normalized.slice(0, 6)}......${normalized.slice(-4)}`;
}

export async function copyGigSquareProviderIdToClipboard(value, clipboard) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || !clipboard?.writeText) return false;
  try {
    await clipboard.writeText(normalized);
    return true;
  } catch {
    return false;
  }
}

export function getGigSquareProviderDisplayName(info, providerGlobalMetaId) {
  const name = typeof info?.name === 'string' ? info.name.trim() : '';
  return name || formatGigSquareProviderId(providerGlobalMetaId) || '—';
}

export function getGigSquareProviderAvatarSrc(info) {
  const avatarUrl = typeof info?.avatarUrl === 'string' ? info.avatarUrl.trim() : '';
  return avatarUrl || DEFAULT_GIG_SQUARE_PROVIDER_AVATAR;
}
