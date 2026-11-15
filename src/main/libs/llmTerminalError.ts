/**
 * Terminal-error classification for one-shot (non-DSH) LLM calls.
 *
 * The DSH turn path classifies structured turn outcomes (libs/coworkAssistantReply.ts);
 * one-shot cognitive calls (private chat, group tasks, dreams, summaries) surface
 * plain Errors whose message carries the upstream status/body. This classifier is
 * the one-shot counterpart: it decides when retrying the SAME route can never
 * succeed (quota dead, credential rejected, model/config not served), which gates
 * the system-rescue rung in services/llmFallback.runWithSystemRescue. Transient
 * shapes (timeouts, 5xx, connection resets, bare 429 rate limits, aborts)
 * deliberately do NOT classify — a rescue switch must never mask a flaky network.
 *
 * Kept dependency-light (pure text matching) so the policy is unit-testable from
 * compiled output. Fingerprints mirror coworkAssistantReply.ts and
 * privateChatSkillTurnPolicy.ts: ASCII upstream fingerprints only, never
 * natural-language intent.
 */

export type OneShotLlmTerminalKind = 'quota' | 'auth' | 'config';

const toErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error == null) return '';
  return String(error);
};

/** Relay quota machine codes + upstream "account has no spendable credit" bodies. */
const QUOTA_MACHINE_CODE = /free_quota_exhausted|quota_exhausted|insufficient_quota|insufficient_me|me_insufficient|me_daily_limit/i;
const QUOTA_FINGERPRINT = /insufficient[ _-]?(credits?|quota|balance|funds)|quota[ _-]?exceeded|billing[ _-]?limit/i;
const QUOTA_JSON_CODE = /["']code["']\s*:\s*["']quota["']/i;

/** Upstream credential-rejection bodies; a bare 401/403 status also classifies. */
const AUTH_FINGERPRINT = /authentication[ _-]?fails?|auth[ _-]?failure|invalid[ _-](api[ _-]?)?(key|token)|api[ _-]?key[^\n]{0,24}is[ _-]?invalid|incorrect[ _-]api[ _-]?key|missing[ _-]api[ _-]?key|\bunauthorized\b|invalid_api_key|authentication_error/i;
const AUTH_STATUS = /(?:^|[^0-9])40[13](?:[^0-9]|$)/;

/** Provider does not serve the requested model id. */
const MODEL_MISSING_FINGERPRINT = /\bmodel[ _-]?not[ _-]?found\b|model[ _-]does[ _-]?not[ _-]?exist|\b404\b[^\n]{0,48}\bmodel\b/i;
/** Local resolution failures (claudeSettings.resolveMatchedProvider): the bound
 *  brain does not resolve to any enabled provider at all. */
const RESOLUTION_FAILURE = /no enabled provider found for model|no available model configured|is missing base url|requires api key/i;

/**
 * Classify a one-shot LLM failure. Returns the terminal kind when the SAME
 * route can never heal this error, null for transient/unknown failures.
 * 'quota' and 'auth' indict the provider account; 'config' indicts the
 * model/binding. All three justify one rescue attempt on a different provider.
 */
export function classifyOneShotLlmTerminalError(error: unknown): OneShotLlmTerminalKind | null {
  const text = toErrorText(error);
  if (!text) return null;
  if (QUOTA_MACHINE_CODE.test(text) || QUOTA_FINGERPRINT.test(text) || QUOTA_JSON_CODE.test(text)) {
    return 'quota';
  }
  if (AUTH_FINGERPRINT.test(text) || AUTH_STATUS.test(text)) {
    return 'auth';
  }
  if (MODEL_MISSING_FINGERPRINT.test(text) || RESOLUTION_FAILURE.test(text)) {
    return 'config';
  }
  return null;
}
