import React, { useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import MetaIdBadge from './MetaIdBadge';
import MetaTaskCopyMini from './MetaTaskCopyMini';
import { formatMetaTaskRelativeTime } from './metaTaskFormat';
import {
  candidateState,
  candidatesByPin,
  candTagLabel,
  candTagTone,
  shortMetaId,
  shortPin,
} from './metaTaskCandidateState';
import {
  candidateArtifactOf,
  gitFacts,
  pinViewUrl,
  resultMembers,
  resultSha,
  resultSummary,
  shortHash,
} from './metaTaskArtifact';
import type {
  MetaTaskIdentity,
  MetaTaskTaskProjection,
  MetaTaskVoteSummary,
} from '../../types/metatask';

/**
 * Detail v2 candidate drawer (competitive mode): the full story of ONE
 * candidate submission — what it delivers, what it builds on (parentrefs), its
 * review timeline, and its on-chain receipts. Slides in from the right over a
 * veil; closes on Esc / veil click / the close button. Design authority:
 * docs/design/metatask-detail-v2-mock.html (drawer section).
 */

const nameOf = (identities: Record<string, MetaTaskIdentity>, metaId: string): string =>
  identities[metaId]?.name?.trim() || shortMetaId(metaId);

const verdictTone = (verdict: string): string =>
  verdict === 'pass'
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
    : verdict === 'fail'
      ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
      : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';

const Fact: React.FC<{ k: string; children: React.ReactNode }> = ({ k, children }) => (
  <div className="flex gap-2 py-1 text-[12.5px]">
    <span className="w-[76px] shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{k}</span>
    <span className="min-w-0 flex-1 break-all dark:text-claude-darkText text-claude-text">{children}</span>
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] dark:text-claude-darkTextSecondary text-claude-textSecondary">
    {children}
  </div>
);

const MetaTaskCandidateDrawer: React.FC<{
  detail: MetaTaskTaskProjection;
  nodeId: string;
  pinId: string;
  onClose: () => void;
  /** Jump to another candidate (parentrefs navigation). */
  onNavigate: (nodeId: string, pinId: string) => void;
}> = ({ detail, nodeId, pinId, onClose, onNavigate }) => {
  const rosterMetaIds = useSelector((state: RootState) => state.metatask.board?.localRosterMetaIds) ?? [];
  const rosterIds = useMemo(() => new Set(rosterMetaIds), [rosterMetaIds]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const identities = detail.identities ?? {};
  const node = detail.nodeStates[nodeId] ?? null;
  const cand = node?.submissions?.find((c) => c.pinId === pinId) ?? null;

  const nodes = useMemo(() => Object.values(detail.nodeStates), [detail.nodeStates]);
  const byPin = useMemo(() => candidatesByPin(nodes), [nodes]);
  /** pin → owning node id (parentref chips navigate to the candidate's card). */
  const pinToNode = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes) for (const c of n.submissions ?? []) map.set(c.pinId, n.id);
    return map;
  }, [nodes]);
  const winningSet = useMemo(() => {
    const chain = detail.settlement?.winningChain;
    return detail.settlement && Array.isArray(chain) ? new Set(chain) : null;
  }, [detail.settlement]);

  /** Review timeline of THIS candidate. Format-v3 projections carry each
   * vote's `targetid`, so the node-level list filters down exactly. Older
   * cached votes lack the field: fall back to the node list as-is (the
   * pre-v3 "votes of the node's effective submission" behavior). */
  const votes = useMemo(() => {
    if (!node || !cand) return [] as MetaTaskVoteSummary[];
    const all = node.votes ?? [];
    const hasTarget = all.some((vote) => typeof vote.targetid === 'string' && vote.targetid.length > 0);
    const filtered = hasTarget ? all.filter((vote) => vote.targetid === cand.pinId) : all;
    return [...filtered].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  }, [node, cand]);

  if (!node || !cand) return null;

  const state = candidateState(node, cand, byPin, winningSet);
  const artifact = candidateArtifactOf(cand);
  const git = gitFacts(cand.result);
  const members = resultMembers(cand.result);
  const summary = resultSummary(cand.result);
  const sha = resultSha(cand.result) ?? cand.hash;
  const isYou = rosterIds.has(cand.submitter);
  const parentrefs = Object.entries(cand.parentrefs ?? {});
  const supersedeid = (cand as { supersedeid?: string }).supersedeid;
  const viewUrl = artifact.metafileViewUrl ?? pinViewUrl(cand.pinId);
  const quorum = Math.max(1, detail.policy.verifyQuorum);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="absolute bottom-0 right-0 top-0 w-[460px] max-w-[94vw] overflow-y-auto border-l dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-[-12px_0_40px_rgba(0,0,0,0.12)]">
        <div className="px-5 py-4 pb-12">
          <button
            type="button"
            onClick={onClose}
            className="sticky top-0 z-10 float-right inline-flex items-center gap-1 rounded-[7px] border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-2.5 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
          >
            {i18nService.t('metatask.cand.close')}
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>

          {/* Identity header */}
          <div className="flex items-center gap-2.5">
            <MetaIdBadge metaId={cand.submitter} identities={identities} />
          </div>
          <div className="mt-1 text-[11.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService
              .t('metatask.cand.subLine')
              .replace('{node}', nodeId)
              .replace('{title}', node.title)
              .replace('{when}', formatMetaTaskRelativeTime(cand.atMs) || '—')}
            {cand.verified && cand.verifiedHeight !== null && cand.verifiedHeight >= 0 && (
              <span>
                {' · '}
                {i18nService.t('metatask.cand.verifiedBlock').replace('{height}', String(cand.verifiedHeight))}
              </span>
            )}
          </div>
          <div className="mb-1 mt-2.5 flex gap-1.5">
            <span className={`rounded px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider ${candTagTone[state]}`}>
              {candTagLabel(state)}
            </span>
            {isYou && (
              <span className="rounded bg-sky-400 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider text-slate-900">
                {i18nService.t('metatask.chain.you')}
              </span>
            )}
          </div>

          {/* What was delivered */}
          <div className="mt-5">
            <SectionTitle>{i18nService.t('metatask.cand.delivered')}</SectionTitle>
            <div className="rounded-[10px] border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-3 py-2.5 text-[12.5px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {summary ?? i18nService.t(`metatask.dlv.descFallback.${artifact.kind}`)}
            </div>
            <div className="mt-2">
              <Fact k={i18nService.t('metatask.cand.factType')}>
                {artifact.resultType ?? artifact.kind}
              </Fact>
              {artifact.kind === 'git' && (
                <>
                  {git.commit && (
                    <Fact k="commit">
                      <span className="font-mono text-[11.5px]" title={git.commit}>{shortHash(git.commit)}</span>
                    </Fact>
                  )}
                  {git.baseCommit && (
                    <Fact k="base">
                      <span className="font-mono text-[11.5px]" title={git.baseCommit}>{shortHash(git.baseCommit)}</span>
                    </Fact>
                  )}
                  {git.repoHint && (
                    <Fact k="repo">
                      {/^https?:\/\//.test(git.repoHint) ? (
                        <button
                          type="button"
                          onClick={() => void window.electron.shell.openExternal(git.repoHint!)}
                          className="font-mono text-[11.5px] text-sky-600 hover:underline dark:text-sky-400"
                        >
                          {git.repoHint}
                        </button>
                      ) : (
                        <span className="font-mono text-[11.5px]">{git.repoHint}</span>
                      )}
                    </Fact>
                  )}
                  {git.engine && (
                    <Fact k="engine">
                      <span className="font-mono text-[11.5px]">{git.engine}</span>
                    </Fact>
                  )}
                </>
              )}
              {members.length > 0 && (
                <Fact k={i18nService.t('metatask.cand.factMembers')}>
                  <span className="flex flex-wrap gap-1">
                    {members.map((member) => (
                      <span
                        key={member}
                        className="rounded-[5px] border dark:border-claude-darkBorder border-claude-border px-[7px] py-px font-mono text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
                      >
                        {member}
                      </span>
                    ))}
                  </span>
                </Fact>
              )}
              {artifact.metafileUri && (
                <Fact k={i18nService.t('metatask.cand.factArtifact')}>
                  <span className="inline-flex items-center gap-1 font-mono text-[11.5px]">
                    <span className="break-all" title={artifact.metafileUri}>{artifact.metafileUri}</span>
                    <MetaTaskCopyMini text={artifact.metafileUri} />
                  </span>
                </Fact>
              )}
              {cand.attachment && cand.attachment !== artifact.metafileUri && (
                <Fact k={i18nService.t('metatask.cand.factAttachment')}>
                  <span className="inline-flex items-center gap-1 font-mono text-[11.5px]">
                    <span className="break-all" title={cand.attachment}>{cand.attachment}</span>
                    <MetaTaskCopyMini text={cand.attachment} />
                  </span>
                </Fact>
              )}
              {sha && (
                <Fact k="sha256">
                  <span className="inline-flex items-center gap-1 font-mono text-[11.5px]">
                    <span title={sha}>{shortHash(sha)}</span>
                    <MetaTaskCopyMini text={sha} />
                  </span>
                </Fact>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              {artifact.metaAppId && (
                <button
                  type="button"
                  onClick={() => void window.electron.metaapps.open({ appId: artifact.metaAppId! })}
                  className="rounded-lg border border-amber-500 bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:brightness-95 dark:border-amber-400 dark:bg-amber-400 dark:text-slate-900"
                >
                  {i18nService.t('metatask.dlv.openApp')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void window.electron.shell.openExternal(viewUrl)}
                className="rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-3.5 py-1.5 text-xs font-semibold dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('metatask.dlv.viewOnMetaweb')}
              </button>
            </div>
          </div>

          {/* What it builds on */}
          <div className="mt-5">
            <SectionTitle>{i18nService.t('metatask.cand.parentrefs')}</SectionTitle>
            {parentrefs.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {parentrefs.map(([depId, refPin]) => {
                  const parent = byPin.get(refPin);
                  return (
                    <button
                      key={`${depId}-${refPin}`}
                      type="button"
                      title={refPin}
                      onClick={() => onNavigate(pinToNode.get(refPin) ?? depId, refPin)}
                      className="inline-flex items-center gap-1.5 rounded-[7px] border border-sky-300 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700 hover:border-sky-400 dark:border-sky-400/60 dark:bg-sky-950/30 dark:text-sky-300"
                    >
                      <span className="font-mono">{depId}</span>
                      <span>·</span>
                      <span>{parent ? nameOf(identities, parent.submitter) : shortPin(refPin)}</span>
                      <span className="font-mono">{shortPin(refPin)}</span>
                      <span>→</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="text-[12px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metatask.cand.noParentrefs')}
              </div>
            )}
          </div>

          {/* Review timeline */}
          <div className="mt-5">
            <SectionTitle>
              {i18nService
                .t('metatask.cand.reviewsTitle')
                .replace('{count}', String(votes.length))
                .replace('{quorum}', String(quorum))}
            </SectionTitle>
            {votes.length === 0 ? (
              <div className="text-[12px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metatask.cand.noVotes')}
              </div>
            ) : (
              <div className="divide-y divide-dashed dark:divide-claude-darkBorder divide-claude-border">
                {votes.map((vote) => (
                  <div key={vote.pinId} className="flex gap-2.5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <MetaIdBadge metaId={vote.voter} identities={identities} compact />
                        <span className={`rounded px-1.5 py-px text-[10px] font-bold uppercase ${verdictTone(vote.verdict)}`}>
                          {vote.verdict === 'pass'
                            ? i18nService.t('metatask.cand.verdictPass')
                            : vote.verdict === 'fail'
                              ? i18nService.t('metatask.cand.verdictFail')
                              : vote.verdict}
                        </span>
                        <span className="text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {vote.timestampMs ? formatMetaTaskRelativeTime(vote.timestampMs) : ''}
                          {typeof vote.height === 'number' && (
                            <>
                              {' · '}
                              {vote.height >= 0
                                ? i18nService.t('metatask.cand.blockHeight').replace('{height}', String(vote.height))
                                : i18nService.t('metatask.cand.mempool')}
                            </>
                          )}
                        </span>
                        {!vote.counted && (
                          <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {i18nService.t('metatask.cand.notCounted').replace('{reason}', vote.ignoreReason ?? '—')}
                          </span>
                        )}
                      </div>
                      {vote.failreasonText && (
                        <div className="mt-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                          <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-red-500 dark:text-red-400">
                            {i18nService.t('metatask.cand.failreason')}
                          </span>
                          {vote.failreasonText}
                        </div>
                      )}
                      {vote.semanticCheckText && (
                        <div className="mt-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-2.5 py-1.5 text-[11.5px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {i18nService.t('metatask.cand.semanticCheck')}
                          </span>
                          {vote.semanticCheckText}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* On-chain receipts */}
          <div className="mt-5">
            <SectionTitle>{i18nService.t('metatask.cand.receipts')}</SectionTitle>
            <Fact k={i18nService.t('metatask.cand.factPin')}>
              <span className="inline-flex items-center gap-1 font-mono text-[11.5px]">
                <span className="break-all" title={cand.pinId}>{cand.pinId}</span>
                <MetaTaskCopyMini text={cand.pinId} />
              </span>
            </Fact>
            {cand.hash && (
              <Fact k="hash">
                <span className="font-mono text-[11.5px]" title={cand.hash}>{shortHash(cand.hash)}</span>
              </Fact>
            )}
            {supersedeid && (
              <Fact k="supersede">
                <span className="font-mono text-[11.5px]" title={supersedeid}>{shortPin(supersedeid)}</span>
              </Fact>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
};

export default MetaTaskCandidateDrawer;
