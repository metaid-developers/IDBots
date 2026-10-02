import { CHALLENGE_TTL_DAYS_DEFAULT } from './constants';
import type { MetaTaskTaskProjection } from './types';

/**
 * Time-driven replay deadlines, derived from a persisted projection.
 *
 * replayMetaTask applies exactly THREE clocks when it is given a clock
 * (`options.now`, which the refresher always passes):
 *
 *  1. claimTTL — engine.ts:745-755 ("expiry pass"): a held node whose current
 *     cycle has NO effective submission reopens once
 *     `now - holder.sinceMs > claim_ttl_hours * 1h`.
 *  2. reviewWindow — engine.ts:756-760: a held node whose effective submission
 *     still lacks quorum reopens once
 *     `now - submission.atMs > verify_window_hours * 1h`, gated on
 *     `countedPassVoters < quorum`.
 *  3. challengeTTL — engine.ts:937-943: an OPEN challenge expires once
 *     `now - challenge.timestampMs > challenge_ttl_days * 24h`, which lifts the
 *     settlement holdout (a disputed task becomes finalizable).
 *
 * All three transition on a STRICT `>` comparison, so this returns the
 * THRESHOLD instant D of the earliest such clock: the state can change for any
 * `now > D`. Callers replay when `D >= persistedEvaluatedAtMs && D < now` — a D
 * below the last replay instant already fired then (the engine applied it), a D
 * at/after it has not been seen yet.
 *
 * Two deliberate over-approximations, both safe (they can only cause one extra
 * replay, never a missed transition):
 *  - the claimTTL candidate is added for every held node, because the
 *    projection does not say which cycle the holder owns: a release followed by
 *    a fresh claim leaves `node.submission` pointing at the older cycle, so the
 *    engine's claimTTL branch cannot be told apart from the reviewWindow one;
 *  - challenge timestamps are supplied by the caller (the projection carries
 *    only the `disputed` flag), and passing every scoped challenge pin — even a
 *    withdrawn or already-overturned one — only adds candidates.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface NextDeadlineOptions {
  /** Candidate `timestampMs` values of challenge pins scoped to the task. */
  challengeTimestampsMs?: number[];
}

export function nextTimeDeadlineMs(
  projection: MetaTaskTaskProjection,
  options: NextDeadlineOptions = {}
): number | null {
  const candidates: number[] = [];
  const ttlHours = projection.policy?.claimTtlHours ?? 0;
  const windowHours = projection.policy?.verifyWindowHours ?? 0;
  const challengeTtlDays = projection.policy?.challengeTtlDays ?? CHALLENGE_TTL_DAYS_DEFAULT;
  // The most conservative reading of a missing quorum is the smallest one.
  const quorum = Math.max(1, projection.policy?.verifyQuorum ?? 1);
  // Competitive mode (v1.3 draft §3.10): claim_ttl_hours and
  // verify_window_hours carry no semantics — claims are intent-only and
  // submissions never expire — so neither clock may produce a deadline. Only
  // the challenge TTL still applies. (Persisted rows from older versions lack
  // policy.mode and read as tree; competitive nodes also always carry
  // holder:null, so the two guards below agree.)
  const isCompetitive = projection.policy?.mode === 'competitive';

  if (!isCompetitive) {
    for (const node of Object.values(projection.nodeStates ?? {})) {
      const holder = node.holder;
      if (holder && ttlHours > 0) {
        candidates.push(holder.sinceMs + ttlHours * HOUR_MS);
      }
      const submission = node.submission;
      if (submission && windowHours > 0 && (node.passVotes ?? 0) < quorum) {
        candidates.push(submission.atMs + windowHours * HOUR_MS);
      }
    }
  }

  for (const timestampMs of options.challengeTimestampsMs ?? []) {
    // The engine ignores a challenge clock when the pin carries no timestamp.
    if (typeof timestampMs === 'number' && timestampMs > 0) {
      candidates.push(timestampMs + challengeTtlDays * DAY_MS);
    }
  }

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
