import { i18nService } from '../../services/i18n';
import type {
  MetaTaskNodeProjection,
  MetaTaskSubmissionCandidate,
} from '../../types/metatask';

/**
 * Shared candidate display-state mapping (v1.3 competitive mode). Extracted
 * from MetaTaskChainView so the chain cards, the node requirement sections
 * and the candidate drawer all tag a candidate the SAME way — the mapping is
 * a pure function over engine-computed flags (verified / chainValid /
 * superseded / failed), the node's leading candidate (`node.submission`), and
 * — for the in-review lookup only — the STORED chainValid flag of the
 * referenced candidates (a table lookup, not a chain-validity recursion).
 */
export type CandState =
  | 'winner'
  | 'leading'
  | 'behind'
  | 'inReview'
  | 'awaitingDeps'
  | 'optimistic'
  | 'replaced'
  | 'rejected'
  | 'stalled';

/** Pure display mapping over engine flags — see the ordering comment in the
 * task design: terminal truth first (killed / replaced), then the gold
 * settlement override, then verified position, then review pipeline. 'stalled'
 * = the candidate itself is live but a referenced parent was rejected/replaced,
 * so the chain under it can never close (a new submission must re-pin). */
export const candidateState = (
  node: MetaTaskNodeProjection,
  cand: MetaTaskSubmissionCandidate,
  byPin: Map<string, MetaTaskSubmissionCandidate>,
  winningSet: Set<string> | null,
): CandState => {
  if (cand.failed) return 'rejected';
  if (cand.superseded) return 'replaced';
  if (winningSet?.has(cand.pinId)) return 'winner';
  const refs = cand.parentrefs ?? {};
  const refPins = Object.values(refs);
  if (refPins.some((pin) => {
    const parent = byPin.get(pin);
    return parent !== undefined && (parent.failed || parent.superseded);
  })) {
    return 'stalled';
  }
  if (cand.verified && cand.chainValid) {
    return node.submission?.pinId === cand.pinId ? 'leading' : 'behind';
  }
  if (cand.verified) return 'awaitingDeps'; // verified but an ancestor is not chain-valid
  const allParentsChainValid = refPins.every((pin) => byPin.get(pin)?.chainValid === true);
  return allParentsChainValid ? 'inReview' : 'optimistic';
};

export const candTagLabel = (state: CandState): string => i18nService.t(`metatask.chain.tag.${state}`);

/** Card chrome per display state (border treatment is the state channel). */
export const candCardTone: Record<CandState, string> = {
  winner:
    'border-amber-400 dark:border-amber-300 shadow-[0_0_0_1px_#f5b83d,0_0_18px_-4px_rgba(245,184,61,0.35)]',
  leading:
    'border-amber-400 dark:border-amber-300 shadow-[0_0_0_1px_#f5b83d,0_0_18px_-4px_rgba(245,184,61,0.35)]',
  behind: 'border-emerald-500/50 dark:border-emerald-400/50',
  inReview: 'border-dashed border-sky-500/60 dark:border-sky-400/60',
  awaitingDeps: 'border-dotted border-violet-500/60 dark:border-violet-400/60',
  optimistic: 'border-dotted border-violet-500/60 dark:border-violet-400/60',
  replaced: 'opacity-40',
  rejected: 'opacity-45',
  stalled: 'border-dashed border-slate-400/60 dark:border-slate-500/60 opacity-60',
};

/** In-review candidates sitting on the race line (the deepest live chain) get
 * a solid sky border instead of dashed — "this one currently carries the race". */
export const onRaceLineTone =
  'border-solid border-sky-500 dark:border-sky-400 shadow-[0_0_10px_-3px_rgba(56,189,248,0.45)]';

export const candTagTone: Record<CandState, string> = {
  winner: 'bg-amber-400 dark:bg-amber-300 text-slate-900',
  leading: 'bg-amber-400 dark:bg-amber-300 text-slate-900',
  behind:
    'border border-emerald-500/50 dark:border-emerald-400/50 text-emerald-600 dark:text-emerald-400 bg-claude-bg dark:bg-claude-darkBg',
  inReview:
    'border border-sky-500/60 dark:border-sky-400/60 text-sky-600 dark:text-sky-400 bg-claude-bg dark:bg-claude-darkBg',
  awaitingDeps:
    'border border-violet-500/60 dark:border-violet-400/60 text-violet-600 dark:text-violet-400 bg-claude-bg dark:bg-claude-darkBg',
  optimistic:
    'border border-violet-500/60 dark:border-violet-400/60 text-violet-600 dark:text-violet-400 bg-claude-bg dark:bg-claude-darkBg',
  replaced:
    'border border-slate-400/50 text-slate-500 dark:text-slate-400 bg-claude-bg dark:bg-claude-darkBg',
  rejected:
    'border border-red-500/60 dark:border-red-400/60 text-red-600 dark:text-red-400 bg-claude-bg dark:bg-claude-darkBg',
  stalled:
    'border border-slate-400/60 text-slate-500 dark:text-slate-400 bg-claude-bg dark:bg-claude-darkBg',
};

export const shortPin = (pinId: string): string =>
  pinId.length > 10 ? `${pinId.slice(0, 5)}…${pinId.slice(-3)}` : pinId;

export const shortMetaId = (metaId: string): string =>
  metaId.length > 14 ? `${metaId.slice(0, 8)}…${metaId.slice(-4)}` : metaId;

/** Candidate lookup table across every node of a task (chain view, drawer
 * navigation and node sections all need the same pin → candidate index). */
export const candidatesByPin = (
  nodes: MetaTaskNodeProjection[],
): Map<string, MetaTaskSubmissionCandidate> => {
  const byPin = new Map<string, MetaTaskSubmissionCandidate>();
  for (const node of nodes) {
    for (const cand of node.submissions ?? []) byPin.set(cand.pinId, cand);
  }
  return byPin;
};
