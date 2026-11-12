/**
 * Quota detection for the mobile chat surface.
 *
 * Structured errors win: the runner stamps LLM_QUOTA_EXHAUSTED for the legacy
 * relay codes (free_quota_exhausted / quota_exhausted), while the ME metering
 * path reports INSUFFICIENT_ME. Persisted terminal Error rows carry no machine
 * code, so their text remains the only restore/resync fallback.
 *
 * The legacy relay codes no longer have separate "free" or "purchased" UI.
 * Every official quota death uses the ME plan/top-up surface and spendable-ME
 * semantics instead of the retired traffic-account vocabulary.
 */

export const LLM_QUOTA_EXHAUSTED_CODE = 'LLM_QUOTA_EXHAUSTED';
export const INSUFFICIENT_ME_CODE = 'INSUFFICIENT_ME';

export type QuotaExhaustedKind = 'me';

/** Restore-only fallback for the two legacy relay codes. */
export const RELAY_QUOTA_TEXT_FALLBACK = /(free_quota_exhausted|quota_exhausted)/i;

/** Restore-only fallback for an ME-balance death. */
export const INSUFFICIENT_ME_TEXT_FALLBACK = /INSUFFICIENT_ME/i;

export function insufficientMeFromErrorText(text: unknown): boolean {
  return INSUFFICIENT_ME_TEXT_FALLBACK.test(String(text ?? ''));
}

/** Both legacy relay codes map to the unified ME purchase path. */
export function quotaKindFromErrorText(text: unknown): QuotaExhaustedKind | null {
  return RELAY_QUOTA_TEXT_FALLBACK.test(String(text ?? '')) ? 'me' : null;
}
