import { lastA2AErrorDetail } from '../../../main/shared/a2aInternalMessageFilter';
import type { CoworkMessage, CoworkSessionStatus } from '../../types/cowork';

/**
 * Visibility of the free-quota banner pinned above the composer.
 *
 * The free-quota relay surfaces 429 + code free_quota_exhausted, annotated into
 * the error text by the OpenAI-compat proxy, and the runner persists it as a
 * system error message while flipping the session to status 'error'. The
 * banner used to derive from "any system message in the transcript carries the
 * code", which can never become false again: once a session hit the quota, the
 * red bar stayed pinned at the bottom for the session's whole life — after the
 * user configured their own key and the conversation was flowing again, even
 * across restarts — and only a brand-new conversation got rid of it.
 *
 * The banner is a call to action for the CURRENT failure, so it follows the
 * live error state instead: it shows only while the session is in status
 * 'error' AND the newest system error is the quota one. Starting the next turn
 * flips the session to 'running' (both start and continue paths do that before
 * anything else), which hides the banner immediately; a successful turn keeps
 * it hidden, a repeat quota failure brings it back, and a different failure
 * leaves it to that failure's own surfacing. The inline "Error: …" system
 * message below the failed turn stays in the transcript as the historical
 * record and scrolls away with the conversation.
 *
 * 'error_retried' is deliberately not treated as live: it marks an
 * orchestration attempt whose step was already retried (historical failure).
 */

export const FREE_QUOTA_EXHAUSTED_CODE = 'free_quota_exhausted';

export const isFreeQuotaErrorLive = (
  messages: ReadonlyArray<CoworkMessage> | null | undefined,
  status: CoworkSessionStatus | null | undefined,
): boolean => {
  if (status !== 'error') return false;
  // No cap: the code sits at the tail of a long "DSH turn failed: …" message
  // and a truncated detail would miss it.
  const latestError = lastA2AErrorDetail([...(messages ?? [])], Number.POSITIVE_INFINITY);
  return latestError !== null && latestError.includes(FREE_QUOTA_EXHAUSTED_CODE);
};

/**
 * REQ-A-25: the quota relay surfaces a second machine code, quota_exhausted
 * (the purchased pool is used up), alongside free_quota_exhausted (the
 * identity never had purchased quota). Same live-state rule as above — both
 * codes are annotated into the error text by the OpenAI-compat proxy.
 */
export const QUOTA_EXHAUSTED_CODES = [
  FREE_QUOTA_EXHAUSTED_CODE,
  'quota_exhausted',
  'insufficient_me',
  'me_insufficient',
  'me_daily_limit',
  'ME_DAILY_LIMIT',
  'INSUFFICIENT_ME',
];

export type LiveQuotaErrorKind = 'free' | 'me_quota' | 'me_daily_limit';

export const liveQuotaErrorKind = (
  messages: ReadonlyArray<CoworkMessage> | null | undefined,
  status: CoworkSessionStatus | null | undefined,
): LiveQuotaErrorKind | null => {
  if (status !== 'error') return null;
  const latestError = lastA2AErrorDetail([...(messages ?? [])], Number.POSITIVE_INFINITY);
  if (latestError === null) return null;
  const lower = latestError.toLowerCase();
  if (lower.includes('me_daily_limit')) return 'me_daily_limit';
  if (lower.includes('insufficient_me') || lower.includes('me_insufficient') || lower.includes('quota_exhausted')) {
    return lower.includes(FREE_QUOTA_EXHAUSTED_CODE) ? 'free' : 'me_quota';
  }
  if (lower.includes(FREE_QUOTA_EXHAUSTED_CODE)) return 'free';
  return null;
};

export const isQuotaExhaustedErrorLive = (
  messages: ReadonlyArray<CoworkMessage> | null | undefined,
  status: CoworkSessionStatus | null | undefined,
): boolean => liveQuotaErrorKind(messages, status) !== null;
