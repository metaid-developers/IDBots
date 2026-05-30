export const DEFAULT_METABOT_LIMIT = 20;
export const METABOT_LIMIT_REACHED_ERROR = 'METABOT_LIMIT_REACHED';

const normalizeCount = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
};

const normalizeLimit = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_METABOT_LIMIT;
  return Math.max(1, Math.trunc(value));
};

export function isMetabotLimitReached(count: number, limit = DEFAULT_METABOT_LIMIT): boolean {
  return normalizeCount(count) >= normalizeLimit(limit);
}

export function getMetabotLimitError(count: number, limit = DEFAULT_METABOT_LIMIT): string | null {
  return isMetabotLimitReached(count, limit) ? METABOT_LIMIT_REACHED_ERROR : null;
}
