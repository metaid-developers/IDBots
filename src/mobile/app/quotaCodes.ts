/**
 * Quota detection for the mobile chat surface.
 *
 * Structured errors win: the runner stamps LLM_QUOTA_EXHAUSTED for the legacy
 * relay codes (free_quota_exhausted / quota_exhausted), while the ME metering
 * path reports INSUFFICIENT_ME. Persisted terminal Error rows carry no machine
 * code, so their text remains the only restore/resync fallback.
 *
 * The legacy relay codes no longer have separate "free" or "purchased" UI.
 * Actual ME insufficiency uses the plan/top-up surface. A server-confirmed
 * positive ME balance after a legacy relay rejection uses a service-recovery
 * notice instead of incorrectly demanding another recharge.
 */

export const LLM_QUOTA_EXHAUSTED_CODE = 'LLM_QUOTA_EXHAUSTED';
export const INSUFFICIENT_ME_CODE = 'INSUFFICIENT_ME';

export type QuotaExhaustedKind = 'me' | 'relay_mismatch';

/** Restore-only fallback for the two legacy relay codes. */
export const RELAY_QUOTA_TEXT_FALLBACK = /(free_quota_exhausted|quota_exhausted)/i;

/** Restore-only fallback for an ME-balance death. */
export const INSUFFICIENT_ME_TEXT_FALLBACK = /INSUFFICIENT_ME/i;

export function insufficientMeFromErrorText(text: unknown): boolean {
  return INSUFFICIENT_ME_TEXT_FALLBACK.test(String(text ?? ''));
}

/** Positive signed ME after a legacy relay rejection is not an empty account. */
export function quotaKindFromErrorText(text: unknown): QuotaExhaustedKind | null {
  const value = String(text ?? '');
  if (/ME_ADMISSION_MISMATCH/i.test(value)) return 'relay_mismatch';
  return RELAY_QUOTA_TEXT_FALLBACK.test(value) ? 'me' : null;
}
