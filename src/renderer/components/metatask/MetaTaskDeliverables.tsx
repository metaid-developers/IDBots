import React, { useMemo } from 'react';
import {
  ArchiveBoxIcon,
  ArrowTopRightOnSquareIcon,
  CodeBracketIcon,
  DocumentIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import MetaTaskCopyMini from './MetaTaskCopyMini';
import { shortMetaId } from './metaTaskCandidateState';
import {
  candidateArtifactOf,
  gitFacts,
  pinViewUrl,
  resultMembers,
  resultSha,
  resultSummary,
  shortHash,
} from './metaTaskArtifact';
import type { ArtifactKind } from './metaTaskArtifact';
import type {
  MetaTaskIdentity,
  MetaTaskNodeProjection,
  MetaTaskSubmissionCandidate,
  MetaTaskTaskProjection,
} from '../../types/metatask';

/**
 * Detail v2 deliverables section (competitive mode): the final artifact as a
 * hero card (the winning chain's terminal node), plus one artifact row per
 * node of the winning chain. Mid-race (no settlement yet) the hero disappears
 * and the rows show each satisfied node's current LEADING candidate instead.
 * Design authority: docs/design/metatask-detail-v2-mock.html (deliver-hero +
 * artifact-rows). All content is read off the published result payloads —
 * pure display, no state re-derivation.
 */

const KIND_ICON: Record<ArtifactKind, React.ComponentType<{ className?: string }>> = {
  git: CodeBracketIcon,
  metafile: ArchiveBoxIcon,
  metaapp: Squares2X2Icon,
  other: DocumentIcon,
};

const kindTileTone: Record<ArtifactKind, string> = {
  git: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300',
  metafile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300',
  metaapp: 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-300',
  other: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

const nameOf = (identities: Record<string, MetaTaskIdentity>, metaId: string): string =>
  identities[metaId]?.name?.trim() || shortMetaId(metaId);

/** The artifact's best public view URL: the metafile viewer when the result
 * carries a metafile, else the submission pin's viewer page. */
const artifactViewUrl = (cand: MetaTaskSubmissionCandidate): string =>
  candidateArtifactOf(cand).metafileViewUrl ?? pinViewUrl(cand.pinId);

/** One-line artifact summary for the rows: commit@base for git-bundles, the
 * members list for metafiles, else the published result type. */
const artifactLine = (cand: MetaTaskSubmissionCandidate): string => {
  const artifact = candidateArtifactOf(cand);
  if (artifact.kind === 'git') {
    const { commit, baseCommit } = gitFacts(cand.result);
    if (commit && baseCommit) return `${commit.slice(0, 8)}… @ ${baseCommit.slice(0, 8)}`;
    if (commit) return `${commit.slice(0, 12)}…`;
  }
  const members = resultMembers(cand.result);
  if (members.length > 0) return members.join(' + ');
  return artifact.resultType ?? '—';
};

const MetaTaskDeliverables: React.FC<{ detail: MetaTaskTaskProjection }> = ({ detail }) => {
  const identities = detail.identities ?? {};
  const nodes = useMemo(
    () =>
      Object.values(detail.nodeStates).sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true }),
      ),
    [detail.nodeStates],
  );

  const winningSet = useMemo(() => {
    const chain = detail.settlement?.winningChain;
    return detail.settlement && Array.isArray(chain) && chain.length > 0 ? new Set(chain) : null;
  }, [detail.settlement]);

  /** Hero input: the winning candidate on the terminal node (policy.finalNode). */
  const hero = useMemo(() => {
    if (!winningSet || !detail.policy.finalNode) return null;
    const node = detail.nodeStates[detail.policy.finalNode];
    if (!node) return null;
    const cand = (node.submissions ?? []).find((c) => winningSet.has(c.pinId)) ?? null;
    return cand ? { node, cand } : null;
  }, [winningSet, detail.policy.finalNode, detail.nodeStates]);

  /** Row inputs: settled → every winning-chain candidate (the hero's node
   * excluded, it already has the spotlight); mid-race → each satisfied node's
   * leading candidate (chain-valid verified, engine-picked in node.submission). */
  const rows = useMemo(() => {
    const out: { node: MetaTaskNodeProjection; cand: MetaTaskSubmissionCandidate }[] = [];
    for (const node of nodes) {
      if (winningSet) {
        if (hero && node.id === hero.node.id) continue;
        const cand = (node.submissions ?? []).find((c) => winningSet.has(c.pinId));
        if (cand) out.push({ node, cand });
      } else {
        const leadPin = node.submission?.pinId;
        const cand = (node.submissions ?? []).find(
          (c) => c.pinId === leadPin && c.verified && c.chainValid,
        );
        if (cand) out.push({ node, cand });
      }
    }
    return out;
  }, [nodes, winningSet, hero]);

  if (!hero && rows.length === 0) return null;

  const heroArtifact = hero ? candidateArtifactOf(hero.cand) : null;
  const HeroIcon = heroArtifact ? KIND_ICON[heroArtifact.kind] : DocumentIcon;
  const heroSummary = hero ? resultSummary(hero.cand.result) : null;
  const heroMembers = hero ? resultMembers(hero.cand.result) : [];
  const heroSha = hero ? resultSha(hero.cand.result) ?? hero.cand.hash : null;

  return (
    <>
      {hero && heroArtifact && (
        <section>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('metatask.dlv.heroTitle')}
            <span className="ml-2 font-normal text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metatask.dlv.heroHint')}
            </span>
          </h3>
          <div className="flex items-start gap-4 rounded-[14px] border border-amber-300 dark:border-amber-300/60 bg-gradient-to-br from-amber-50 to-claude-surface dark:from-amber-950/20 dark:to-claude-darkSurface px-4 py-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] bg-amber-500 text-white dark:bg-amber-400 dark:text-slate-900">
              <HeroIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-amber-600 dark:text-amber-300">
                {hero.node.id} · {hero.node.title} — {nameOf(identities, hero.cand.submitter)}
              </div>
              <div className="mt-0.5 text-base font-semibold dark:text-claude-darkText text-claude-text">
                {hero.node.title}
              </div>
              <div className="mt-1 text-[12.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {heroSummary ?? i18nService.t(`metatask.dlv.descFallback.${heroArtifact.kind}`)}
              </div>
              {heroMembers.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {heroMembers.map((member) => (
                    <span
                      key={member}
                      className="rounded-[5px] border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-[7px] py-px font-mono text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    >
                      {member}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {heroSha && <span title={heroSha}>sha256 {shortHash(heroSha)}</span>}
                {heroSha && heroArtifact.metafileUri && <span>·</span>}
                {heroArtifact.metafileUri && (
                  <span className="inline-flex items-center gap-1 break-all" title={heroArtifact.metafileUri}>
                    {heroArtifact.metafileUri}
                    <MetaTaskCopyMini text={heroArtifact.metafileUri} />
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              {heroArtifact.metaAppId && (
                <button
                  type="button"
                  onClick={() => void window.electron.metaapps.open({ appId: heroArtifact.metaAppId! })}
                  className="rounded-lg border border-amber-500 bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:brightness-95 dark:border-amber-400 dark:bg-amber-400 dark:text-slate-900"
                >
                  {i18nService.t('metatask.dlv.openApp')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void window.electron.shell.openExternal(artifactViewUrl(hero.cand))}
                className="rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-3.5 py-1.5 text-xs font-semibold dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('metatask.dlv.viewOnMetaweb')}
              </button>
            </div>
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t(winningSet ? 'metatask.dlv.perNodeTitle' : 'metatask.dlv.inProgressTitle')}
            <span className="ml-2 font-normal text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t(winningSet ? 'metatask.dlv.perNodeHint' : 'metatask.dlv.inProgressHint')}
            </span>
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map(({ node, cand }) => {
              const artifact = candidateArtifactOf(cand);
              const RowIcon = KIND_ICON[artifact.kind];
              return (
                <div
                  key={cand.pinId}
                  className="flex items-center gap-2.5 rounded-[10px] border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-3 py-2"
                >
                  <span
                    className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] ${kindTileTone[artifact.kind]}`}
                  >
                    <RowIcon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold dark:text-claude-darkText text-claude-text" title={node.title}>
                      {node.id} · {node.title}
                    </span>
                    <span className="block truncate font-mono text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary" title={artifactLine(cand)}>
                      {artifactLine(cand)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <span className="block">{nameOf(identities, cand.submitter)}</span>
                    <span className="block font-mono">{artifact.resultType ?? artifact.kind}</span>
                  </span>
                  <button
                    type="button"
                    title={i18nService.t('metatask.dlv.viewOnMetaweb')}
                    onClick={() => void window.electron.shell.openExternal(artifactViewUrl(cand))}
                    className="shrink-0 rounded p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
                  >
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
};

export default MetaTaskDeliverables;
