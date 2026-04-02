import { normalizeRawGlobalMetaId } from './globalMetaId';

type SortOrder = 'rating' | 'updated';

type GigSquareSortableService = {
  providerGlobalMetaId?: string | null;
  updatedAt?: number | null;
  ratingCount?: number | null;
};

function normalizeComparableGlobalMetaId(value: unknown): string {
  if (typeof value !== 'string') {
    return value == null ? '' : String(value).trim();
  }

  return normalizeRawGlobalMetaId(value) ?? value.trim();
}

function findOnlineBotLastSeen(
  onlineBots: Record<string, number>,
  providerGlobalMetaId: string | null | undefined,
): number | null {
  const normalizedProviderId = normalizeComparableGlobalMetaId(providerGlobalMetaId);
  if (!normalizedProviderId) return null;

  for (const [rawGlobalMetaId, rawLastSeen] of Object.entries(onlineBots || {})) {
    if (normalizeComparableGlobalMetaId(rawGlobalMetaId) !== normalizedProviderId) {
      continue;
    }

    if (typeof rawLastSeen === 'number' && Number.isFinite(rawLastSeen)) {
      return rawLastSeen;
    }
  }

  return null;
}

export function isGigSquareProviderOnline(
  onlineBots: Record<string, number>,
  providerGlobalMetaId: string | null | undefined,
): boolean {
  return findOnlineBotLastSeen(onlineBots, providerGlobalMetaId) != null;
}

export function sortGigSquareServicesByOnline<T extends GigSquareSortableService>(
  services: T[],
  onlineBots: Record<string, number>,
  sortOrder: SortOrder,
): T[] {
  return [...services].sort((left, right) => {
    const isOnlineLeft = isGigSquareProviderOnline(onlineBots, left.providerGlobalMetaId) ? 1 : 0;
    const isOnlineRight = isGigSquareProviderOnline(onlineBots, right.providerGlobalMetaId) ? 1 : 0;
    if (isOnlineRight !== isOnlineLeft) {
      return isOnlineRight - isOnlineLeft;
    }

    if (sortOrder === 'rating') {
      return (right.ratingCount ?? 0) - (left.ratingCount ?? 0);
    }

    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
}
