/**
 * Projection gate copy (2026-11-12 owner ruling): a projection is the Twin
 * reporting to its boss, so it only happens at the END of a round — never a
 * mid-process "work has started" page while delegated work is still out
 * (session 09bb4098 projected a kickoff page while the worker was still
 * running and the owner had nothing to decide).
 *
 * Both projection entries consult this before projecting:
 *  - bot_browser_preview_local with projection=true → kind 'preview'
 *    (section-5 tool-result text, returned verbatim as the tool result);
 *  - the projection_begin host tool → kind 'begin' (section-6 text, returned
 *    instead of engaging fast mode).
 *
 * Pure module: the delegation list arrives already filtered to attempts
 * whose own status is queued/running (listStudioOpenDelegations with
 * activeAttemptsOnly) — the timed_out-with-running-worker heuristic must
 * NOT gate, since the attempt is marked completed before the Twin is
 * notified and a timed-out attempt can still recover.
 */

import type { StudioOpenDelegation } from './studioOpenDelegations';

export type StudioProjectionBlockKind = 'preview' | 'begin';

const WORKER_NAME_FALLBACK = 'a worker bot';
const TITLE_FALLBACK = 'the delegated task';

/**
 * The gate message for the open delegations, or null when nothing is still
 * out (the caller proceeds with the normal projection path). Worker names
 * are de-duplicated and joined with ", "; unnamed workers degrade to the
 * generic fallback. `{title}` is the first (earliest-started) delegation's
 * title.
 */
export function describeStudioProjectionBlock(
  delegations: readonly StudioOpenDelegation[],
  kind: StudioProjectionBlockKind,
): string | null {
  if (delegations.length === 0) return null;
  const workers = [...new Set(
    delegations.map((entry) => (entry.workerName ?? '').trim() || WORKER_NAME_FALLBACK),
  )].join(', ');
  const title = (delegations[0]?.title ?? '').trim() || TITLE_FALLBACK;
  if (kind === 'begin') {
    return `Not now: ${workers} is still working on the work you delegated ("${title}"), so do not write a projection page this turn. End the turn with a short chat reply instead; project the result after the worker reports back and you have verified it.`;
  }
  return `Not projected: ${workers} is still working on the work you delegated ("${title}"). A projection is a report to the owner, so it waits until that work is back and you have verified it. End this turn now with a short chat reply — who is doing what, and that you will check it and report when it is back. The Live Stage already shows the collaboration. Project the result page in the turn where the worker reports back.`;
}
