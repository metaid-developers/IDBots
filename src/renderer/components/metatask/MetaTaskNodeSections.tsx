import React, { useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import MetaIdBadge from './MetaIdBadge';
import { formatMetaTaskRelativeTime } from './metaTaskFormat';
import {
  candidateState,
  candidatesByPin,
  candTagLabel,
  candTagTone,
  shortMetaId,
  shortPin,
} from './metaTaskCandidateState';
import type { CandState } from './metaTaskCandidateState';
import type {
  MetaTaskIdentity,
  MetaTaskNodeProjection,
  MetaTaskSubmissionCandidate,
  MetaTaskTaskProjection,
} from '../../types/metatask';

/**
 * Detail v2 node requirement sections (competitive mode): one card per node —
 * what the node asks for (acceptance rubric from params.rubric, spec/workspace
 * summary) on the left, and every candidate submission on the right (click a
 * row to open the candidate drawer). Nodes with candidates default to
 * expanded; all cards are collapsible. Design authority:
 * docs/design/metatask-detail-v2-mock.html (node-sec).
 */

const nameOf = (identities: Record<string, MetaTaskIdentity>, metaId: string): string =>
  identities[metaId]?.name?.trim() || shortMetaId(metaId);

/** Row order: gold/verified first, live reviews next, terminal states last;
 * chain order is kept inside each rank. */
const stateRank: Record<CandState, number> = {
  winner: 0,
  leading: 1,
  inReview: 2,
  optimistic: 3,
  awaitingDeps: 4,
  behind: 5,
  stalled: 6,
  replaced: 7,
  rejected: 8,
};

const rubricOf = (node: MetaTaskNodeProjection): string[] => {
  const rubric = node.params?.rubric;
  if (!Array.isArray(rubric)) return [];
  return rubric.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
};

const workspaceOf = (node: MetaTaskNodeProjection): string | null => {
  const workspace = node.params?.workspace;
  return typeof workspace === 'string' && workspace.trim() ? workspace.trim() : null;
};

const NodeSection: React.FC<{
  node: MetaTaskNodeProjection;
  detail: MetaTaskTaskProjection;
  byPin: Map<string, MetaTaskSubmissionCandidate>;
  winningSet: Set<string> | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelectCandidate: (nodeId: string, pinId: string) => void;
}> = ({ node, detail, byPin, winningSet, collapsed, onToggle, onSelectCandidate }) => {
  const identities = detail.identities ?? {};
  const quorum = Math.max(1, detail.policy.verifyQuorum);
  const candidates = useMemo(() => {
    const list = [...(node.submissions ?? [])];
    list.sort(
      (a, b) =>
        stateRank[candidateState(node, a, byPin, winningSet)] -
        stateRank[candidateState(node, b, byPin, winningSet)],
    );
    return list;
  }, [node, byPin, winningSet]);

  const winnerCand = winningSet ? candidates.find((cand) => winningSet.has(cand.pinId)) : undefined;
  const leaderCand =
    !winnerCand && node.submission
      ? candidates.find((cand) => cand.pinId === node.submission?.pinId && cand.verified && cand.chainValid)
      : undefined;

  const headState = winnerCand ? (
    <span className="rounded-[5px] bg-amber-500 px-[7px] py-0.5 text-[10px] font-bold uppercase tracking-wider text-white dark:bg-amber-400 dark:text-slate-900">
      {i18nService.t('metatask.node.headWinner').replace('{name}', nameOf(identities, winnerCand.submitter))}
    </span>
  ) : leaderCand ? (
    <span className="rounded-[5px] border border-amber-400 px-[7px] py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:border-amber-300 dark:text-amber-300">
      {i18nService.t('metatask.node.headLeading').replace('{name}', nameOf(identities, leaderCand.submitter))}
    </span>
  ) : candidates.length > 0 ? (
    <span className="rounded-[5px] border border-sky-300 px-[7px] py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-600 dark:border-sky-400/60 dark:text-sky-400">
      {i18nService.t('metatask.node.headCompeting').replace('{count}', String(candidates.length))}
    </span>
  ) : (
    <span className="rounded-[5px] border dark:border-claude-darkBorder border-claude-border px-[7px] py-0.5 text-[10px] font-bold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
      {i18nService.t('metatask.node.headOpen')}
    </span>
  );

  const rubric = rubricOf(node);
  const workspace = workspaceOf(node);

  return (
    <div
      id={`metatask-node-${node.id}`}
      className="overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface"
    >      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3.5 py-[11px] text-left hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover/60 transition-colors"
      >
        {collapsed ? (
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        ) : (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        )}
        <span className="shrink-0 rounded-[5px] border dark:border-claude-darkBorder border-claude-border px-1.5 py-px font-mono text-[11px] font-bold dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {node.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold dark:text-claude-darkText text-claude-text" title={node.title}>
          {node.title}
        </span>
        <span className="shrink-0 font-mono text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {node.kind}
        </span>
        {node.weight !== null && (
          <span className="shrink-0 font-mono text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {(node.weight / 100).toFixed(0)}% · {node.weight}BP
          </span>
        )}
        {headState}
        {node.disputed && (
          <span className="shrink-0 rounded-[5px] border border-amber-500/60 px-[7px] py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-300">
            {i18nService.t('metatask.disputed')}
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="grid grid-cols-1 gap-4 border-t dark:border-claude-darkBorder border-claude-border px-3.5 py-3 lg:grid-cols-2">
          {/* Acceptance criteria */}
          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metatask.node.rubricTitle')}
            </div>
            {rubric.length > 0 ? (
              <ul className="divide-y divide-dashed dark:divide-claude-darkBorder/60 divide-claude-border/60">
                {rubric.map((item, index) => (
                  <li key={index} className="flex gap-2 py-1 text-[12.5px] dark:text-claude-darkText text-claude-text">
                    <span className="shrink-0 pt-px font-mono text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {index + 1}
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            ) : node.params && Object.keys(node.params).length > 0 ? (
              <details className="text-[12px]">
                <summary className="cursor-pointer dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('metatask.node.paramsJson')}
                </summary>
                <pre className="mt-1 max-h-56 overflow-x-auto rounded-lg bg-claude-bg p-2 text-[11px] dark:bg-claude-darkBg dark:text-claude-darkText text-claude-text">
                  {JSON.stringify(node.params, null, 2)}
                </pre>
              </details>
            ) : (
              <div className="text-[12px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metatask.node.noRubric')}
              </div>
            )}
            {(node.specid || workspace) && (
              <div className="mt-2 break-all font-mono text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {node.specid && <span>spec: {node.specid}</span>}
                {node.specid && workspace && <span> · </span>}
                {workspace && <span>workspace: {workspace}</span>}
              </div>
            )}
          </div>

          {/* Candidate submissions */}
          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metatask.node.candsTitle').replace('{count}', String(candidates.length))}
            </div>
            {candidates.length === 0 ? (
              <div className="text-[12px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metatask.node.noCands')}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {candidates.map((cand) => {
                  const state = candidateState(node, cand, byPin, winningSet);
                  const gold = state === 'winner' || state === 'leading';
                  return (
                    <button
                      key={cand.pinId}
                      type="button"
                      title={cand.pinId}
                      onClick={() => onSelectCandidate(node.id, cand.pinId)}
                      className={`flex items-center gap-2 rounded-[9px] border px-2.5 py-[7px] text-left transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover/60 ${
                        gold
                          ? 'border-amber-300 bg-amber-50 dark:border-amber-300/50 dark:bg-amber-950/20'
                          : 'dark:border-claude-darkBorder border-claude-border'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <MetaIdBadge metaId={cand.submitter} identities={identities} compact />
                          <span className="shrink-0 font-mono text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {shortPin(cand.pinId)}
                          </span>
                        </span>
                      </span>
                      <span
                        className="inline-flex shrink-0 items-center gap-[3px]"
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
                      <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wider ${candTagTone[state]}`}>
                        {candTagLabel(state)}
                      </span>
                      <span className="shrink-0 text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {formatMetaTaskRelativeTime(cand.atMs)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const MetaTaskNodeSections: React.FC<{
  detail: MetaTaskTaskProjection;
  onSelectCandidate: (nodeId: string, pinId: string) => void;
}> = ({ detail, onSelectCandidate }) => {
  const nodes = useMemo(
    () =>
      Object.values(detail.nodeStates).sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true }),
      ),
    [detail.nodeStates],
  );
  const byPin = useMemo(() => candidatesByPin(nodes), [nodes]);
  const winningSet = useMemo(() => {
    const chain = detail.settlement?.winningChain;
    return detail.settlement && Array.isArray(chain) ? new Set(chain) : null;
  }, [detail.settlement]);

  /** Nodes WITHOUT candidates start collapsed; the rest start expanded. The
   * default is computed once per task so refresh pushes never clobber the
   * user's manual toggles. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const initForRef = useRef<string | null>(null);
  if (initForRef.current !== detail.rootPinId) {
    initForRef.current = detail.rootPinId;
    setCollapsed(new Set(nodes.filter((node) => (node.submissions ?? []).length === 0).map((node) => node.id)));
  }

  const toggle = (nodeId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  return (
    <section>
      <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
        {i18nService.t('metatask.node.sectionsTitle')}
        <span className="ml-2 font-normal text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metatask.node.sectionsHint')}
        </span>
      </h3>
      <div className="flex flex-col gap-2.5">
        {nodes.map((node) => (
          <NodeSection
            key={node.id}
            node={node}
            detail={detail}
            byPin={byPin}
            winningSet={winningSet}
            collapsed={collapsed.has(node.id)}
            onToggle={() => toggle(node.id)}
            onSelectCandidate={onSelectCandidate}
          />
        ))}
      </div>
    </section>
  );
};

export default MetaTaskNodeSections;
