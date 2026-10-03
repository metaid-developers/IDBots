import {
  REVIEWER_ACCURACY_FLOOR_BP,
  SUBMITTER_SHARE_BP_DEFAULT,
  SUBMITTER_SHARE_BP_MAX,
  SUBMITTER_SHARE_BP_MIN,
} from './constants';
import type {
  MetaTaskEstimation,
  MetaTaskShareEstimate,
  MetaTaskTaskProjection,
} from './types';

/**
 * Mid-task share estimate ("if the task settled now") for an in-progress
 * MetaTask. Pure derivation over a replay projection — no chain access, no
 * persistence, and never part of replayMetaTask's output (the engine alone owns
 * the authoritative manifest).
 *
 * It replicates the settlement math of engine.ts step for step so that a
 * COMPLETED task's estimate equals its manifest shares byte-for-byte: same
 * weight resolution (tree weights when every node carries an integer 1..10000
 * summing to exactly 10000, else the legacy uniform floor(10000/N) fallback),
 * same σ clamp, same R(n) filter, same Laplace accuracy a(r), same integer
 * rounding (floor at every step, residue discarded).
 *
 * Competitive mode (v1.3): the same loop answers the draft §3.7 estimation
 * extension — "if the task completed now via the currently leading partial
 * chain". The engine projects each satisfied node's leading candidate (earliest
 * chain-valid verified submission) as `node.submission` with status `verified`,
 * so paying every verified node its leader's split yields exactly the leading
 * partial chain; once the task completes the leading candidate on every node IS
 * the winning-chain member, so the estimate still equals the manifest.
 *
 * The only intentional difference is reachability: the engine falls back to
 * REVIEWER_ACCURACY_FLOOR_BP (2500) for a reviewer missing from its accuracy
 * map, which cannot happen for a reviewer whose vote counted; here an unknown
 * reviewer gets the a-priori Laplace value 5000 (zero recorded votes).
 */

/** Same clamp the engine applies to policy.split.submitterShareBP. */
const clampSubmitterShareBP = (value: unknown): number => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : SUBMITTER_SHARE_BP_DEFAULT;
  return Math.min(SUBMITTER_SHARE_BP_MAX, Math.max(SUBMITTER_SHARE_BP_MIN, raw));
};

/** Laplace-smoothed reviewer accuracy, clamped to the protocol floor. */
const accuracyOf = (
  stats: Map<string, { reviewCorrect: number; reviewTerminal: number }>,
  metaId: string
): number => {
  const record = stats.get(metaId);
  if (!record) return 5000;
  const smoothed = Math.floor((10000 * (record.reviewCorrect + 1)) / (record.reviewTerminal + 2));
  return Math.min(10000, Math.max(REVIEWER_ACCURACY_FLOOR_BP, smoothed));
};

export function estimateMetaTaskShares(projection: MetaTaskTaskProjection): MetaTaskEstimation {
  const nodes = Array.isArray(projection.nodes) ? projection.nodes : [];
  const nodeCount = nodes.length;

  // Weight resolution mirrors the engine's settlement precondition exactly.
  const weightByNode = new Map<string, number>();
  let weighted = nodeCount > 0;
  let totalWeight = 0;
  if (weighted) {
    for (const node of nodes) {
      const weight = node.weight;
      if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1 || weight > 10000) {
        weighted = false;
        break;
      }
      weightByNode.set(node.id, weight);
      totalWeight += weight;
    }
    if (totalWeight !== 10000) weighted = false;
  }
  // Legacy trees (pre-H_ACT2, no weight field): uniform floor(10000/N), the
  // residue deliberately discarded (rev-2 ruling: never to the root).
  const uniformWeight = nodeCount > 0 ? Math.floor(10000 / nodeCount) : 0;

  const accuracy = new Map<string, { reviewCorrect: number; reviewTerminal: number }>();
  for (const stats of projection.participants ?? []) {
    accuracy.set(stats.metaId, {
      reviewCorrect: stats.reviewCorrect,
      reviewTerminal: stats.reviewTerminal,
    });
  }

  // A persisted projection always carries the clamped σ; the fallback covers a
  // projection written before the field existed (estimates then assume the
  // default 8000 split for a custom-split task until the next refresh).
  const sigma = clampSubmitterShareBP(projection.policy?.submitterShareBP);

  const shareParts = new Map<string, { submittedBP: number; reviewedBP: number }>();
  const ensureShare = (metaId: string): { submittedBP: number; reviewedBP: number } => {
    let parts = shareParts.get(metaId);
    if (!parts) {
      parts = { submittedBP: 0, reviewedBP: 0 };
      shareParts.set(metaId, parts);
    }
    return parts;
  };

  for (const [nodeId, node] of Object.entries(projection.nodeStates ?? {})) {
    if (node.status !== 'verified' || !node.submission) continue;
    const w = weighted ? weightByNode.get(nodeId) ?? 0 : uniformWeight;
    if (w <= 0) continue;
    const submitterId = node.submission.submitter;
    const submitter = ensureShare(submitterId);
    const subBP = Math.floor((w * sigma) / 10000);
    submitter.submittedBP += subBP;
    const pool = w - subBP; // defined by subtraction: no double rounding
    // R(n): counted pass votes by anyone but the submission's own author and
    // the task root author. `counted` already encodes that identity filter, and
    // same-side roster votes were dropped upstream by the engine.
    const reviewers = (node.votes ?? []).filter(
      (vote) =>
        vote.verdict === 'pass' &&
        vote.counted &&
        vote.voter !== submitterId &&
        vote.voter !== projection.publisher
    );
    if (reviewers.length === 0) {
      submitter.submittedBP += pool; // defensive: empty R(n) pool goes to the submitter
      continue;
    }
    const accSum = reviewers.reduce((sum, vote) => sum + accuracyOf(accuracy, vote.voter), 0);
    for (const vote of reviewers) {
      const a = accuracyOf(accuracy, vote.voter);
      ensureShare(vote.voter).reviewedBP += Math.floor((pool * a) / accSum); // residue discarded
    }
  }

  const shares: MetaTaskShareEstimate[] = Array.from(shareParts, ([metaId, parts]) => ({
    metaId,
    shareBP: parts.submittedBP + parts.reviewedBP,
    from: parts,
  })).sort((a, b) => b.shareBP - a.shareBP || (a.metaId < b.metaId ? -1 : 1));

  return { basis: weighted ? 'weighted' : 'uniform', shares };
}
