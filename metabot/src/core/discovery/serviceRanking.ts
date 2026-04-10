import { normalizeComparableGlobalMetaId } from './serviceDirectory';

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const isOnline = (onlineBots: Record<string, number>, service: any): boolean => {
  const globalMetaId = normalizeComparableGlobalMetaId(service?.providerGlobalMetaId || service?.globalMetaId);
  return Boolean(globalMetaId && onlineBots[globalMetaId]);
};

export const rankServicesForDirectory = (
  services: any[],
  onlineBots: Record<string, number>
): any[] => {
  return [...services].sort((left, right) => {
    const leftOnline = isOnline(onlineBots, left);
    const rightOnline = isOnline(onlineBots, right);
    if (leftOnline !== rightOnline) {
      return rightOnline ? 1 : -1;
    }

    const updatedDiff = toNumber(right?.updatedAt) - toNumber(left?.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;

    const ratingDiff = toNumber(right?.ratingCount) - toNumber(left?.ratingCount);
    if (ratingDiff !== 0) return ratingDiff;

    return toSafeString(left?.serviceName || left?.displayName).localeCompare(
      toSafeString(right?.serviceName || right?.displayName)
    );
  });
};
