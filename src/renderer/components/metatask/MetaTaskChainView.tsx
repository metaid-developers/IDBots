import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import MetaIdBadge from './MetaIdBadge';
import { formatMetaTaskRelativeTime } from './metaTaskFormat';
import type {
  MetaTaskNodeProjection,
  MetaTaskSubmissionCandidate,
  MetaTaskTaskProjection,
} from '../../types/metatask';

/**
 * Competitive-mode (v1.3) "chain view": one column per node, laid out
 * left-to-right by deps topological depth, with every competing candidate
 * submission as a card and the parentrefs wiring drawn as an SVG overlay. The
 * gold thread is the leading chain (or, once settled, the manifest's
 * winningChain). Replaces the TreeMap for `policy.mode === 'competitive'`.
 * Design authority: docs/design/metatask-chainview-mock.html.
 *
 * The renderer never re-derives replay state: every card's display state is a
 * pure mapping over the engine-computed candidate flags (verified / chainValid
 * / superseded / failed), the node's leading candidate (`node.submission`),
 * and — for the in-review lookup only — the STORED chainValid flag of the
 * referenced candidates (a table lookup, not a chain-validity recursion).
 *
 * Gold vs amber channel note: the leading/winner signal (amber border +
 * attached glow shadow) is deliberately a different visual channel from the
 * disputed signal (a detached 2px outer ring floating off the card, the same
 * ring the TreeMap puts on dots) — both use the amber family but can never be
 * confused, and a leading AND disputed card shows both.
 */
type CandState =
  | 'winner'
  | 'leading'
  | 'behind'
  | 'inReview'
  | 'awaitingDeps'
  | 'optimistic'
  | 'replaced'
  | 'rejected';

/** Pure display mapping over engine flags — see the ordering comment in the
 * task design: terminal truth first (killed / replaced), then the gold
 * settlement override, then verified position, then review pipeline. */
const candidateState = (
  node: MetaTaskNodeProjection,
  cand: MetaTaskSubmissionCandidate,
  byPin: Map<string, MetaTaskSubmissionCandidate>,
  winningSet: Set<string> | null,
): CandState => {
  if (cand.failed) return 'rejected';
  if (cand.superseded) return 'replaced';
  if (winningSet?.has(cand.pinId)) return 'winner';
  if (cand.verified && cand.chainValid) {
    return node.submission?.pinId === cand.pinId ? 'leading' : 'behind';
  }
  if (cand.verified) return 'awaitingDeps'; // verified but an ancestor is not chain-valid
  const refs = cand.parentrefs ?? {};
  const refPins = Object.values(refs);
  const allParentsChainValid = refPins.every((pin) => byPin.get(pin)?.chainValid === true);
  return allParentsChainValid ? 'inReview' : 'optimistic';
};

const tagLabel = (state: CandState): string => i18nService.t(`metatask.chain.tag.${state}`);

/** Card chrome per display state (border treatment is the state channel). */
const cardTone: Record<CandState, string> = {
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
};

const tagTone: Record<CandState, string> = {
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
};

interface EdgeSpec {
  from: string;
  to: string;
  gold: boolean;
  opt: boolean;
}

/** deps topological depth (entry nodes = 0). The engine guarantees acyclicity;
 * the stack guard only keeps a malformed legacy payload from recursing. */
const computeDepths = (nodes: MetaTaskNodeProjection[]): Map<string, number> => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (stack.has(id)) return 0;
    stack.add(id);
    let depth = 0;
    for (const dep of byId.get(id)?.deps ?? []) {
      if (byId.has(dep)) depth = Math.max(depth, visit(dep, stack) + 1);
    }
    stack.delete(id);
    memo.set(id, depth);
    return depth;
  };
  for (const node of nodes) visit(node.id, new Set());
  return memo;
};

const shortPin = (pinId: string): string =>
  pinId.length > 10 ? `${pinId.slice(0, 5)}…${pinId.slice(-3)}` : pinId;

const shortMetaId = (metaId: string): string =>
  metaId.length > 14 ? `${metaId.slice(0, 8)}…${metaId.slice(-4)}` : metaId;

/** SVG/edge CSS that Tailwind cannot express: the gold flow keyframes (gated
 * on prefers-reduced-motion, belt-and-braces with motion-reduce:animate-none
 * on the paths) and the terminal column's dashed-gold underline. */
const CHAIN_VIEW_CSS = `
.metatask-chain-edge { fill: none; stroke-width: 1.5; }
.metatask-chain-edge-gold { stroke-width: 2.5; filter: drop-shadow(0 0 3px rgba(245, 184, 61, 0.35)); }
.metatask-chain-edge-opt { stroke-dasharray: 3 4; opacity: 0.7; }
.metatask-chain-edge-flow { stroke-dasharray: 6 8; animation: metatask-chain-edge-flow 1.6s linear infinite; }
@keyframes metatask-chain-edge-flow { to { stroke-dashoffset: -14; } }
@media (prefers-reduced-motion: reduce) { .metatask-chain-edge-flow { animation: none; } }
.metatask-chain-rule-finish { background: repeating-linear-gradient(90deg, rgba(245, 184, 61, 0.35) 0 8px, transparent 8px 14px); }
`;

const MetaTaskChainView: React.FC<{
  detail: MetaTaskTaskProjection;
  onSelectNode: (nodeId: string) => void;
}> = ({ detail, onSelectNode }) => {
  const rosterMetaIds = useSelector((state: RootState) => state.metatask.board?.localRosterMetaIds) ?? [];
  const rosterIds = useMemo(() => new Set(rosterMetaIds), [rosterMetaIds]);
  const chainRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const nodeList = useMemo(() => Object.values(detail.nodeStates), [detail.nodeStates]);
  const depths = useMemo(() => computeDepths(nodeList), [nodeList]);
  // Column order: deps depth asc, then natural node id.
  const nodes = useMemo(
    () =>
      [...nodeList].sort((a, b) => {
        const da = depths.get(a.id) ?? 0;
        const db = depths.get(b.id) ?? 0;
        if (da !== db) return da - db;
        return a.id.localeCompare(b.id, undefined, { numeric: true });
      }),
    [nodeList, depths],
  );

  const quorum = Math.max(1, detail.policy.verifyQuorum);
  const identities = detail.identities ?? {};
  const winningSet = useMemo(() => {
    const chain = detail.settlement?.winningChain;
    return detail.settlement && Array.isArray(chain) ? new Set(chain) : null;
  }, [detail.settlement]);

  const terminalId = useMemo(() => {
    if (detail.policy.finalNode && detail.nodeStates[detail.policy.finalNode]) {
      return detail.policy.finalNode;
    }
    const referenced = new Set<string>();
    for (const node of nodes) for (const dep of node.deps) referenced.add(dep);
    const sinks = nodes.filter((node) => !referenced.has(node.id));
    return sinks.length === 1 ? sinks[0].id : null;
  }, [detail.policy.finalNode, detail.nodeStates, nodes]);

  /** Candidate lookup + display state for every candidate (the edge pass and
   * the in-review parent lookup both read this table). */
  const { byPin, stateByPin } = useMemo(() => {
    const byPin = new Map<string, MetaTaskSubmissionCandidate>();
    const stateByPin = new Map<string, CandState>();
    for (const node of nodes) {
      for (const cand of node.submissions ?? []) byPin.set(cand.pinId, cand);
    }
    for (const node of nodes) {
      for (const cand of node.submissions ?? []) {
        stateByPin.set(cand.pinId, candidateState(node, cand, byPin, winningSet));
      }
    }
    return { byPin, stateByPin };
  }, [nodes, winningSet]);

  const edges = useMemo(() => {
    const specs: EdgeSpec[] = [];
    for (const node of nodes) {
      for (const cand of node.submissions ?? []) {
        const refs = cand.parentrefs ?? {};
        for (const dep of node.deps) {
          const from = refs[dep];
          if (!from || !byPin.has(from)) continue;
          const fromState = stateByPin.get(from);
          const toState = stateByPin.get(cand.pinId);
          // Settled: the manifest's winningChain IS the gold thread. Mid-race:
          // the leading-to-leading path. (display mapping, not re-derivation)
          const gold = winningSet
            ? winningSet.has(from) && winningSet.has(cand.pinId)
            : fromState === 'leading' && toState === 'leading';
          const opt = !gold && (toState === 'optimistic' || toState === 'awaitingDeps');
          specs.push({ from, to: cand.pinId, gold, opt });
        }
      }
    }
    return specs;
  }, [nodes, byPin, stateByPin, winningSet]);

  const edgesRef = useRef<EdgeSpec[]>(edges);
  edgesRef.current = edges;

  /** Imperative edge pass: measures the candidate cards (data-cand-pin) and
   * rebuilds the SVG bezier overlay. Runs after layout and on any resize of
   * the chain canvas (column wrap, avatar images arriving, window resize). */
  const drawEdges = useCallback(() => {
    const chainEl = chainRef.current;
    const svgEl = svgRef.current;
    if (!chainEl || !svgEl) return;
    const box = chainEl.getBoundingClientRect();
    svgEl.setAttribute('width', String(chainEl.scrollWidth));
    svgEl.setAttribute('height', String(chainEl.scrollHeight));
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    for (const edge of edgesRef.current) {
      const fromEl = chainEl.querySelector(`[data-cand-pin="${edge.from}"]`);
      const toEl = chainEl.querySelector(`[data-cand-pin="${edge.to}"]`);
      if (!fromEl || !toEl) continue;
      const a = fromEl.getBoundingClientRect();
      const b = toEl.getBoundingClientRect();
      const x1 = a.right - box.left;
      const y1 = a.top + a.height / 2 - box.top;
      const x2 = b.left - box.left;
      const y2 = b.top + b.height / 2 - box.top;
      const mx = (x1 + x2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      path.setAttribute(
        'class',
        edge.gold
          ? 'metatask-chain-edge metatask-chain-edge-gold metatask-chain-edge-flow stroke-amber-400 dark:stroke-amber-300 motion-reduce:animate-none'
          : edge.opt
            ? 'metatask-chain-edge metatask-chain-edge-opt stroke-violet-400 dark:stroke-violet-300'
            : 'metatask-chain-edge stroke-claude-border dark:stroke-claude-darkBorder',
      );
      svgEl.appendChild(path);
    }
  }, []);

  useLayoutEffect(() => {
    drawEdges();
  }, [edges, drawEdges]);

  useEffect(() => {
    const el = chainRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => drawEdges());
    observer.observe(el);
    window.addEventListener('resize', drawEdges);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', drawEdges);
    };
  }, [drawEdges]);

  const stepStateWord = (node: MetaTaskNodeProjection): { text: string; gold: boolean } => {
    const candidates = node.submissions ?? [];
    const winnerCand = winningSet ? candidates.find((cand) => winningSet.has(cand.pinId)) : undefined;
    const nameOf = (metaId: string): string => identities[metaId]?.name?.trim() || shortMetaId(metaId);
    if (winnerCand) {
      return {
        text: i18nService.t('metatask.chain.stepWinner').replace('{name}', nameOf(winnerCand.submitter)),
        gold: true,
      };
    }
    if (node.submission && candidates.some((cand) => cand.pinId === node.submission?.pinId && cand.verified && cand.chainValid)) {
      return {
        text: i18nService.t('metatask.chain.stepLeading').replace('{name}', nameOf(node.submission.submitter)),
        gold: true,
      };
    }
    if (candidates.some((cand) => cand.verified && cand.chainValid)) {
      return { text: i18nService.t('metatask.chain.stepVerified'), gold: false };
    }
    const pending = candidates.filter((cand) => {
      const state = stateByPin.get(cand.pinId);
      return state === 'optimistic' || state === 'awaitingDeps';
    });
    if (candidates.length > 0 && pending.length === candidates.length) {
      return {
        text: i18nService.t('metatask.chain.stepOptimistic').replace('{count}', String(candidates.length)),
        gold: false,
      };
    }
    if (candidates.length > 0) {
      return {
        text: i18nService.t('metatask.chain.stepCompeting').replace('{count}', String(candidates.length)),
        gold: false,
      };
    }
    return { text: i18nService.t('metatask.chain.stepOpen'), gold: false };
  };

  const legendSwatch = 'inline-block h-3 w-[18px] rounded border bg-claude-surface dark:bg-claude-darkSurface';

  return (
    <section>
      <style>{CHAIN_VIEW_CSS}</style>
      <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
        {i18nService.t('metatask.chain.title')}
        <span className="ml-2 font-normal text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metatask.chain.hint')}
        </span>
      </h3>

      {/* Rules strip: how the race works + what the gold thread means */}
      <div className="mb-3 flex items-center gap-2.5 rounded-[10px] border border-l-[3px] dark:border-claude-darkBorder border-claude-border border-l-amber-400 dark:border-l-amber-300 dark:bg-claude-darkSurface bg-claude-surface px-3.5 py-2.5">
        <p className="text-[13px] leading-snug dark:text-claude-darkText text-claude-text">
          <strong className="font-semibold">{i18nService.t('metatask.chain.rulesTitle')}</strong>
          <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary"> · </span>
          {i18nService.t('metatask.chain.rulesRace')}
          <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary"> · </span>
          {i18nService.t('metatask.chain.rulesGoldA')}
          <span className="font-semibold text-amber-600 dark:text-amber-300">
            {i18nService.t('metatask.chain.rulesGoldWord')}
          </span>
          {i18nService.t('metatask.chain.rulesGoldB')}
        </p>
      </div>

      {/* Chain canvas: columns by deps depth, horizontal scroll, SVG edges */}
      <div className="overflow-x-auto pb-1">
        <div ref={chainRef} className="relative flex gap-16 px-3 pt-2 pb-4 min-w-min w-max">
          <svg ref={svgRef} className="absolute inset-0 pointer-events-none z-0" />
          {nodes.map((node) => {
            const candidates = node.submissions ?? [];
            const isTerminal = node.id === terminalId;
            const word = stepStateWord(node);
            const anyVerified = candidates.some((cand) => cand.verified && cand.chainValid);
            const ruleClass = word.gold
              ? isTerminal
                ? 'bg-amber-400 dark:bg-amber-300'
                : 'bg-gradient-to-r from-amber-400 to-amber-400/30 dark:from-amber-300 dark:to-amber-300/30'
              : anyVerified
                ? 'bg-emerald-500 dark:bg-emerald-400'
                : isTerminal
                  ? 'metatask-chain-rule-finish'
                  : 'dark:bg-claude-darkBorder bg-claude-border';
            return (
              <div key={node.id} className="relative z-10 w-56 flex-none flex flex-col gap-2.5">
                <div className="px-0.5">
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`shrink-0 whitespace-nowrap rounded-[5px] border px-1.5 py-px text-[10.5px] font-bold uppercase tracking-widest ${
                        isTerminal
                          ? 'border-amber-400/40 dark:border-amber-300/40 text-amber-600 dark:text-amber-300'
                          : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary'
                      }`}
                    >
                      {isTerminal ? `${i18nService.t('metatask.chain.finish')} · ${node.id}` : node.id}
                    </span>
                    <span
                      className="truncate text-[13px] font-semibold dark:text-claude-darkText text-claude-text"
                      title={node.title}
                    >
                      {node.title}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2">
                    <span
                      className={`text-[11.5px] ${
                        word.gold
                          ? 'text-amber-600 dark:text-amber-300'
                          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
                      }`}
                    >
                      {word.text}
                    </span>
                    {node.weight !== null && (
                      <span className="shrink-0 font-mono text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {(node.weight / 100).toFixed(0)}% · {node.weight}BP
                      </span>
                    )}
                  </div>
                  <div className={`mt-1.5 h-0.5 rounded-full ${ruleClass}`} />
                </div>

                {candidates.length === 0 && (
                  <div className="whitespace-pre-line rounded-[10px] border border-dashed dark:border-claude-darkBorder border-claude-border px-[11px] py-3.5 text-center text-[11.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('metatask.chain.empty')}
                  </div>
                )}

                {candidates.map((cand) => {
                  const state = stateByPin.get(cand.pinId) ?? 'optimistic';
                  const isYou = rosterIds.has(cand.submitter);
                  const disputeRing =
                    node.disputed && node.submission?.pinId === cand.pinId ? (
                      <span className="pointer-events-none absolute -inset-1 rounded-xl border-2 border-amber-500 dark:border-amber-400" />
                    ) : null;
                  return (
                    <button
                      key={cand.pinId}
                      type="button"
                      data-cand-pin={cand.pinId}
                      title={cand.pinId}
                      onClick={() => onSelectNode(node.id)}
                      className={`relative rounded-[10px] border px-[11px] pt-[9px] pb-2 text-left transition-transform hover:-translate-y-px dark:bg-claude-darkSurface bg-claude-surface ${cardTone[state]}`}
                    >
                      {disputeRing}
                      <span
                        className={`absolute -top-[7px] right-2 rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${tagTone[state]}`}
                      >
                        {tagLabel(state)}
                      </span>
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className={state === 'rejected' ? 'line-through' : undefined}>
                          <MetaIdBadge metaId={cand.submitter} identities={identities} compact />
                        </span>
                        {isYou && (
                          <span className="shrink-0 rounded bg-sky-400 px-1 text-[9px] font-bold tracking-wider text-slate-900">
                            {i18nService.t('metatask.chain.you')}
                          </span>
                        )}
                      </span>
                      <span className="mt-1.5 flex items-center gap-2 text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        <span className="font-mono">{shortPin(cand.pinId)}</span>
                        <span>{formatMetaTaskRelativeTime(cand.atMs)}</span>
                        <span
                          className="ml-auto inline-flex items-center gap-[3px]"
                          title={i18nService
                            .t('metatask.chain.votesTip')
                            .replace('{pass}', String(cand.passVotes))
                            .replace('{quorum}', String(quorum))
                            .replace('{fail}', String(cand.failVotes))}
                        >
                          {Array.from({ length: quorum }, (_, i) => (
                            <span
                              key={`p${i}`}
                              className={`h-[7px] w-[7px] rounded-full border ${
                                i < cand.passVotes
                                  ? 'border-emerald-500 bg-emerald-500 dark:border-emerald-400 dark:bg-emerald-400'
                                  : 'dark:border-claude-darkTextSecondary border-claude-textSecondary'
                              }`}
                            />
                          ))}
                          {Array.from({ length: cand.failVotes }, (_, i) => (
                            <span
                              key={`f${i}`}
                              className="h-[7px] w-[7px] rounded-full border border-red-500 bg-red-500 dark:border-red-400 dark:bg-red-400"
                            />
                          ))}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {winningSet && (
          <span className="inline-flex items-center gap-1.5">
            <span className={`${legendSwatch} border-amber-400 bg-amber-400 dark:border-amber-300 dark:bg-amber-300`} />
            {i18nService.t('metatask.chain.legend.winner')}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`${legendSwatch} border-amber-400 dark:border-amber-300 shadow-[0_0_6px_-1px_rgba(245,184,61,0.35)]`}
          />
          {i18nService.t('metatask.chain.legend.leading')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${legendSwatch} border-emerald-500/60 dark:border-emerald-400/60`} />
          {i18nService.t('metatask.chain.legend.behind')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${legendSwatch} border-dashed border-sky-500/60 dark:border-sky-400/60`} />
          {i18nService.t('metatask.chain.legend.inReview')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${legendSwatch} border-dotted border-violet-500/60 dark:border-violet-400/60`} />
          {i18nService.t('metatask.chain.legend.awaitingDeps')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${legendSwatch} border-dotted border-violet-500/60 dark:border-violet-400/60`} />
          {i18nService.t('metatask.chain.legend.optimistic')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${legendSwatch} opacity-40 dark:border-claude-darkBorder border-claude-border`} />
          {i18nService.t('metatask.chain.legend.replaced')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${legendSwatch} border-red-500/60 opacity-45 dark:border-red-400/60`} />
          {i18nService.t('metatask.chain.legend.rejected')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-[3px]">
            <span className="h-[7px] w-[7px] rounded-full border border-emerald-500 bg-emerald-500 dark:border-emerald-400 dark:bg-emerald-400" />
            <span className="h-[7px] w-[7px] rounded-full border dark:border-claude-darkTextSecondary border-claude-textSecondary" />
          </span>
          {i18nService.t('metatask.chain.legend.votes').replace('{quorum}', String(quorum))}
        </span>
      </div>
    </section>
  );
};

export default MetaTaskChainView;
