/**
 * Structured-first quota-exhausted detection for the mobile chat surface.
 *
 * The runner (src/main/libs/coworkRunner.ts, REQ-A-25) stamps a stable machine
 * code on the `cowork:stream:error` frame when a turn dies on either relay
 * quota code: `metadata.errorCode = 'LLM_QUOTA_EXHAUSTED'`. The shared
 * CoworkSessionController stores it as `streamErrors[sessionId].code`, so the
 * live detection path reads the structured code and never parses copy.
 *
 * That frame is the ONLY payload carrying a machine-readable quota code:
 *
 *   - The persisted terminal `Error:` system row (what a restored / reopened
 *     session detail contains) provably carries no code — handleError
 *     persists `metadata: { error }` (text) only — so the restore path has
 *     nothing else to read, and
 *   - the frame metadata collapses both relay codes (free_quota_exhausted /
 *     quota_exhausted) into the single LLM_QUOTA_EXHAUSTED code, so picking
 *     the free-vs-purchased card copy still needs the relay code from the
 *     text.
 *
 * Every string match below is therefore confined to this one constant, used
 * only for payloads that provably carry no structured code.
 */

/** Stable machine code the runner stamps on cowork:stream:error metadata (REQ-A-25). */
export const LLM_QUOTA_EXHAUSTED_CODE = 'LLM_QUOTA_EXHAUSTED';

export type QuotaExhaustedKind = 'free' | 'purchased';

/**
 * STRING FALLBACK — the only free-text quota matcher in the mobile app.
 * Applies exclusively to payloads that provably carry no structured code:
 * persisted `Error:` system rows (restore/resync path) and the free/purchased
 * kind refinement of an already-structured stream error. Do not extend quota
 * detection with more copy matching; extend the structured code instead.
 * (quota_exhausted is a substring of free_quota_exhausted, so the alternation
 * pins the more specific code first.)
 */
export const RELAY_QUOTA_TEXT_FALLBACK = /(free_quota_exhausted|quota_exhausted)/i;

/**
 * Quota card copy kind ('free' vs 'purchased') from the relay code inside an
 * error text, or null when the text carries neither code.
 */
export function quotaKindFromErrorText(text: unknown): QuotaExhaustedKind | null {
  const match = RELAY_QUOTA_TEXT_FALLBACK.exec(String(text ?? ''));
  if (!match) return null;
  return match[1].toLowerCase() === 'quota_exhausted' ? 'purchased' : 'free';
}
