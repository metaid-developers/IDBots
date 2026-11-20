export const SURF_BEFORE_DREAM_ENABLED_KEY = 'surf_before_dream_enabled';
export const SURF_INTERACTION_BUDGET_KEY = 'surf_interaction_budget';
export const SURF_CREATION_BUDGET_KEY = 'surf_creation_budget';
export const SURF_CREATION_MODE_KEY = 'surf_creation_mode';
export const DAILY_REPORT_ENABLED_KEY = 'dailyReport.enabled';
export const DAILY_REPORT_HOUR_KEY = 'dailyReport.hour';

export const DEFAULT_SURF_INTERACTION_BUDGET = 50;
export const DEFAULT_SURF_CREATION_BUDGET = 3;
export const DEFAULT_DAILY_REPORT_HOUR = 8;
export const SURF_CREATION_MODES = ['off', 'organic', 'encouraged'] as const;

export type SurfCreationMode = (typeof SURF_CREATION_MODES)[number];

export function clampBudget(value: string, fallback: number, maximum: number): number {
  if (value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(0, Math.round(parsed)));
}

export function normalizeCreationMode(value: string | null): SurfCreationMode {
  return (SURF_CREATION_MODES as readonly string[]).includes(value ?? '')
    ? value as SurfCreationMode
    : 'organic';
}

export function dailyReportUnavailableCopyKey(reason: string): string {
  return [
    'no_twin',
    'experimental_disabled',
    'feature_disabled',
    'deferred',
    'already_running',
    'service_not_started',
    'service_stopped',
  ].includes(reason)
    ? `mobile.automation.dailyUnavailable.${reason}`
    : 'mobile.automation.dailyUnavailable.unknown';
}
