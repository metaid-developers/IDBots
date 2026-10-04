import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { ArrowLeftIcon, BoltIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { metaTaskService } from '../../services/metatask';
import { i18nService } from '../../services/i18n';
import MetaIdBadge from './MetaIdBadge';
import MetaTaskCandidateDrawer from './MetaTaskCandidateDrawer';
import MetaTaskChainView from './MetaTaskChainView';
import MetaTaskDeliverables from './MetaTaskDeliverables';
import MetaTaskNodeSections from './MetaTaskNodeSections';
import MetaTaskTreeMap from './MetaTaskTreeMap';
import {
  metaTaskChildrenOf,
  metaTaskLifeStatus,
  metaTaskLifeStatusLabel,
  metaTaskLifeStatusTone,
  metaTaskNodeStatusLabel,
  metaTaskSubtreeHasAttention,
  metaTaskSubtreeStats,
} from './metaTaskStatus';
import { formatMetaTaskRelativeTime } from './metaTaskFormat';
import type { MetaTaskIdentity, MetaTaskNodeProjection } from '../../types/metatask';

const statusTone: Record<string, string> = {
  open: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  claimed: 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400',
  verified: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
};

const statusLabel = metaTaskNodeStatusLabel;

/** Closing-checklist row: ✓ (emerald) when the condition holds, ○ otherwise. */
const ClosingCheckRow: React.FC<{ ok: boolean; text: string }> = ({ ok, text }) => (
  <li className="flex items-start gap-1.5">
    <span
      className={`shrink-0 ${
        ok
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
      }`}
    >
      {ok ? '✓' : '○'}
    </span>
    <span
      className={
        ok
          ? 'dark:text-claude-darkText text-claude-text'
          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
      }
    >
      {text}
    </span>
  </li>
);

/** One row of the local-participation feed: a node plus what the local bots
 * currently have in flight on it. */
type MineItemKind = 'claimed' | 'submitted' | 'voted' | 'verified';

interface MineItem {
  kind: MineItemKind;
  node: MetaTaskNodeProjection;
  groupId: string | null;
  text: string;
}

/** In-flight work first: claimed → submitted → voted → verified. */
const mineKindOrder: Record<MineItemKind, number> = { claimed: 0, submitted: 1, voted: 2, verified: 3 };

const mineKindDot: Record<MineItemKind, string> = {
  claimed: 'bg-sky-400',
  submitted: 'bg-amber-400',
  verified: 'bg-emerald-400',
  voted: 'bg-slate-400 dark:bg-slate-500',
};

const mineKindText: Record<MineItemKind, string> = {
  claimed: 'text-sky-600 dark:text-sky-400',
  submitted: 'text-amber-600 dark:text-amber-400',
  verified: 'text-emerald-600 dark:text-emerald-400',
  voted: 'dark:text-claude-darkTextSecondary text-claude-textSecondary',
};

const participateDraft = (title: string, rootPinId: string, nodeHint?: string | null, competitive = false): void => {
  const text = i18nService
    .t(competitive ? 'metatask.participateDraftCompetitive' : 'metatask.participateDraft')
    .replace('{title}', title)
    .replace('{root}', rootPinId)
    .replace(
      '{node_hint}',
      nodeHint ? i18nService.t('metatask.participateNodeHint').replace('{node}', nodeHint) : '',
    );
  window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text } }));
};

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * Task detail: node table where each row EXPANDS to show the branch task's
 * actual content — tree params (what the node asks for), the effective
 * submission (result payload, hashes, attachment) of whichever bot holds it,
 * and the review votes. Settlement shows when the task closes; until then an
 * explicit empty state explains what is still missing.
 */
const MetaTaskDetail: React.FC<{ rootPinId: string }> = ({ rootPinId }) => {
  const detail = useSelector((state: RootState) => state.metatask.details[rootPinId] ?? null);
  const rosterMetaIds = useSelector((state: RootState) => state.metatask.board?.localRosterMetaIds) ?? [];
  const rosterIds = new Set(rosterMetaIds);
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** Competitive v2: the candidate currently shown in the drawer (null = closed). */
  const [selectedCand, setSelectedCand] = useState<{ nodeId: string; pinId: string } | null>(null);
  const groupsInitForRef = useRef<string | null>(null);

  useEffect(() => {
    void metaTaskService.loadTask(rootPinId);
  }, [rootPinId]);

  // Default group expansion, computed once per task: groups with in-flight or
  // disputed descendants open; quiet groups stay collapsed. Refresh pushes
  // must not clobber the user's manual toggles.
  useEffect(() => {
    if (!detail || groupsInitForRef.current === rootPinId) return;
    groupsInitForRef.current = rootPinId;
    const childrenOf = metaTaskChildrenOf(Object.values(detail.nodeStates));
    const root = Object.values(detail.nodeStates).find((node) => node.parent === null);
    const defaults = new Set<string>();
    for (const child of childrenOf.get(root?.id ?? '') ?? []) {
      if ((childrenOf.get(child.id)?.length ?? 0) > 0 && metaTaskSubtreeHasAttention(childrenOf, child.id)) {
        defaults.add(child.id);
      }
    }
    setExpandedGroups(defaults);
  }, [detail, rootPinId]);

  if (!detail) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border">
          <button
            type="button"
            onClick={() => metaTaskService.selectTask(null)}
            className="inline-flex items-center gap-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            {i18nService.t('back')}
          </button>
        </div>
        <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-8 text-center">
          {i18nService.t('metatask.loading')}
        </div>
      </div>
    );
  }

  const identities = detail.identities ?? {};
  const roster = [...detail.participants].sort(
    (a, b) => b.verifiedContrib - a.verifiedContrib || a.metaId.localeCompare(b.metaId)
  );
  // Mid-task estimates (present only until a settlement manifest exists); the
  // renderer never computes shares, it only displays the engine's numbers.
  const showEstShare = !detail.settlement && !!detail.estimation;
  const estShareByMetaId = new Map(
    (detail.estimation?.shares ?? []).map((share) => [share.metaId, share.shareBP])
  );
  const nodes = Object.values(detail.nodeStates).sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true })
  );
  const openNodes = nodes.filter((node) => node.status === 'open');
  const isCompetitive = detail.policy.mode === 'competitive';
  const rootNode = nodes.find((node) => node.parent === null);
  const lifeStatus = metaTaskLifeStatus({
    taskComplete: detail.taskComplete,
    settlementFinalized: detail.settlement !== null,
    progress: detail.progress,
    participantCount: detail.participants.length,
  });
  const lastActive = formatMetaTaskRelativeTime(detail.lastActivityMs);

  const childrenOf = metaTaskChildrenOf(nodes);
  const childIds = new Set(Array.from(childrenOf.values()).flat().map((node) => node.id));
  const baseChildren = rootNode
    ? childrenOf.get(rootNode.id) ?? []
    : nodes.filter((node) => !childIds.has(node.id));
  const groups = baseChildren.filter((node) => (childrenOf.get(node.id)?.length ?? 0) > 0);
  const topLeaves = baseChildren.filter((node) => !(childrenOf.get(node.id)?.length));

  // Local-participation feed: what the local roster currently holds or has done
  // on this task's nodes (claim TTL, pending review, local votes).
  const groupIdSet = new Set(groups.map((group) => group.id));
  const mineItems: MineItem[] = [];
  if (rosterIds.size > 0) {
    const now = Date.now();
    for (const node of nodes) {
      const effective = node.submission && !node.submission.superseded ? node.submission : null;
      const groupId = node.parent && groupIdSet.has(node.parent) ? node.parent : null;
      if (effective && rosterIds.has(effective.submitter)) {
        mineItems.push({
          kind: node.status === 'verified' ? 'verified' : 'submitted',
          node,
          groupId,
          text:
            node.status === 'verified'
              ? i18nService.t('metatask.mine.verified')
              : i18nService
                  .t('metatask.mine.submitted')
                  .replace('{votes}', String(node.passVotes))
                  .replace('{quorum}', String(detail.policy.verifyQuorum)),
        });
      } else if (
        !effective &&
        node.status === 'claimed' &&
        node.holder &&
        rosterIds.has(node.holder.claimant)
      ) {
        const remainingMs = detail.policy.claimTtlHours * 3600e3 - (now - node.holder.sinceMs);
        mineItems.push({
          kind: 'claimed',
          node,
          groupId,
          text: i18nService
            .t('metatask.mine.claimed')
            .replace('{hours}', String(Math.max(0, Math.ceil(remainingMs / 3600e3)))),
        });
      }
      // Votes carry no submission reference, so a local ballot is attributed to
      // the node's effective submission — the only one votes can act on.
      const localVote = effective ? node.votes.find((vote) => rosterIds.has(vote.voter)) : undefined;
      if (localVote) {
        const verdict =
          localVote.verdict === 'pass'
            ? i18nService.t('metatask.mine.votedPass')
            : i18nService.t('metatask.mine.votedFail');
        mineItems.push({
          kind: 'voted',
          node,
          groupId,
          text: localVote.counted
            ? verdict
            : verdict +
              i18nService
                .t('metatask.mine.voteNotCounted')
                .replace('{reason}', localVote.ignoreReason ?? '—'),
        });
      }
    }
    mineItems.sort((a, b) => mineKindOrder[a.kind] - mineKindOrder[b.kind]);
  }

  const toggleGroup = (groupId: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };
  const scrollToNode = (nodeId: string): void => {
    window.setTimeout(() => {
      document.getElementById(`metatask-node-${nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  };
  const selectNodeFromMap = (nodeId: string, groupId: string | null): void => {
    if (groupId) setExpandedGroups((prev) => new Set(prev).add(groupId));
    setExpandedNode(nodeId);
    scrollToNode(nodeId);
  };
  const toggleGroupFromMap = (groupId: string): void => {
    const willExpand = !expandedGroups.has(groupId);
    toggleGroup(groupId);
    if (willExpand) scrollToNode(groupId);
  };

  const renderTreeRow = (node: MetaTaskNodeProjection): React.ReactNode => {
    const children = childrenOf.get(node.id) ?? [];
    const isGroup = children.length > 0;
    const collapsed = !expandedGroups.has(node.id);
    return (
      <div key={node.id}>
        <NodeRow
          node={node}
          identities={identities}
          verifyQuorum={detail.policy.verifyQuorum}
          expanded={expandedNode === node.id}
          onToggleExpand={() => setExpandedNode(expandedNode === node.id ? null : node.id)}
          isGroup={isGroup}
          groupCollapsed={collapsed}
          groupStats={isGroup ? metaTaskSubtreeStats(childrenOf, node.id) : undefined}
          onToggleGroup={() => toggleGroup(node.id)}
        />
        {expandedNode === node.id && <NodeExpanded node={node} identities={identities} />}
        {isGroup && !collapsed && (
          <div className="border-t dark:border-claude-darkBorder border-claude-border">
            <div className="ml-6 border-l dark:border-claude-darkBorder border-claude-border divide-y dark:divide-claude-darkBorder divide-claude-border">
              {children.map((child) => renderTreeRow(child))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <button
          type="button"
          onClick={() => metaTaskService.selectTask(null)}
          className="inline-flex items-center gap-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          {i18nService.t('back')}
        </button>
        <div className="mt-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text truncate">
                {detail.title}
              </h2>
              <span className={`shrink-0 px-1.5 py-0.5 text-[11px] rounded ${metaTaskLifeStatusTone[lifeStatus]}`}>
                {metaTaskLifeStatusLabel(lifeStatus)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 flex-wrap text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <span className="inline-flex items-center gap-1">
                {i18nService.t('metatask.publisher')}
                <MetaIdBadge metaId={detail.publisher} identities={identities} compact />
              </span>
              <span>·</span>
              <span>
                {i18nService.t('metatask.progressVerified')
                  .replace('{verified}', String(detail.progress.verified))
                  .replace('{total}', String(detail.progress.total))}
              </span>
              <span>·</span>
              {lastActive && (
                <>
                  <span>{i18nService.t('metatask.lastActive').replace('{when}', lastActive)}</span>
                  <span>·</span>
                </>
              )}
              <span title={i18nService.t('metatask.activityAnchorTip')}>
                {i18nService.t('metatask.blockAnchor').replace(
                  '{block}',
                  String(detail.freshness.boundaryBlock),
                )}
              </span>
              <span>·</span>
              <span>{i18nService.t('metatask.events').replace('{count}', String(detail.freshness.eventCount))}</span>
            </div>
          </div>
          {!detail.taskComplete && (
            <button
              type="button"
              onClick={() => participateDraft(detail.title, detail.rootPinId, openNodes[0]?.id ?? null, isCompetitive)}
              className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg btn-idchat-primary-filled"
            >
              <BoltIcon className="h-4 w-4" />
              {i18nService.t('metatask.participateNow')}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metatask.detail.explainer')}
        </p>
        {detail.brief && (
          <p className="mt-1.5 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{detail.brief}</p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {/* Deliverables (competitive v2): final artifact hero + per-node
            artifact rows; renders nothing while there is no artifact yet */}
        {isCompetitive && <MetaTaskDeliverables detail={detail} />}

        {/* How to join: open nodes as one-click participation candidates */}
        {!detail.taskComplete && openNodes.length > 0 && (
          <section className="rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2.5">
            <div className="text-xs font-medium text-sky-700 dark:text-sky-300">{i18nService.t('metatask.howToJoin')}</div>
            <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t(isCompetitive ? 'metatask.howToJoinHintCompetitive' : 'metatask.howToJoinHint').replace('{count}', String(openNodes.length))}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {openNodes.slice(0, 6).map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => participateDraft(detail.title, detail.rootPinId, node.id, isCompetitive)}
                  className="inline-flex items-center gap-1.5 max-w-[200px] px-2 py-1 text-xs rounded-lg border border-sky-500/50 text-sky-700 dark:text-sky-300 hover:bg-sky-500/10 transition-colors"
                >
                  <span className="font-mono shrink-0">{node.id}</span>
                  <span className="truncate">{node.title}</span>
                </button>
              ))}
              {openNodes.length > 6 && (
                <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('metatask.moreOpenNodes').replace('{count}', String(openNodes.length - 6))}
                </span>
              )}
            </div>
          </section>
        )}

        {/* Local participation: what this machine's bots hold or did here */}
        {mineItems.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
              {i18nService.t('metatask.mine.title')}
            </h3>
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden divide-y dark:divide-claude-darkBorder divide-claude-border">
              {mineItems.map((item, index) => (
                <button
                  key={`${item.kind}-${item.node.id}-${index}`}
                  type="button"
                  onClick={() => selectNodeFromMap(item.node.id, item.groupId)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover/60 transition-colors"
                >
                  <span className={`h-2 w-2 rounded-full shrink-0 ${mineKindDot[item.kind]}`} />
                  <span className="font-mono text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
                    {item.node.id}
                  </span>
                  <span
                    className="truncate dark:text-claude-darkText text-claude-text"
                    title={item.node.title}
                  >
                    {item.node.title}
                  </span>
                  <span className={`ml-auto shrink-0 text-[11px] ${mineKindText[item.kind]}`}>
                    {item.text}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Structure overview: competitive tasks race as a deps chain (v1.3);
            tree tasks keep the group/dot structure map */}
        {detail.policy.mode === 'competitive' ? (
          <MetaTaskChainView
            detail={detail}
            onSelectNode={(nodeId) => {
              const node = detail.nodeStates[nodeId];
              selectNodeFromMap(nodeId, node?.parent && groupIdSet.has(node.parent) ? node.parent : null);
            }}
            onSelectCandidate={(nodeId, pinId) => setSelectedCand({ nodeId, pinId })}
          />
        ) : (
          <MetaTaskTreeMap
            root={rootNode}
            groups={groups}
            topLeaves={topLeaves}
            childrenOf={childrenOf}
            onSelectNode={selectNodeFromMap}
            onToggleGroup={toggleGroupFromMap}
          />
        )}

        {/* Nodes: competitive tasks get the v2 requirement+candidate sections
            (rubric left, candidates right, rows open the drawer); tree tasks
            keep the expandable row table */}
        {isCompetitive ? (
          <MetaTaskNodeSections
            detail={detail}
            onSelectCandidate={(nodeId, pinId) => setSelectedCand({ nodeId, pinId })}
          />
        ) : (
        <section>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('metatask.nodes')}
            <span className="ml-2 font-normal text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metatask.nodesHint')}
            </span>
          </h3>
          <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden divide-y dark:divide-claude-darkBorder divide-claude-border">
            {rootNode && (
              <div>
                <NodeRow
                  node={rootNode}
                  identities={identities}
                  verifyQuorum={detail.policy.verifyQuorum}
                  expanded={expandedNode === rootNode.id}
                  onToggleExpand={() => setExpandedNode(expandedNode === rootNode.id ? null : rootNode.id)}
                />
                {expandedNode === rootNode.id && <NodeExpanded node={rootNode} identities={identities} />}
              </div>
            )}
            {baseChildren.map((node) => renderTreeRow(node))}
          </div>
        </section>
        )}

        {/* Roster */}
        <section>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('metatask.roster')}
          </h3>
          <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.participant')}</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.claims')}</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.verifiedContrib')}</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.reviewVotes')}</th>
                  {showEstShare && (
                    <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.estShareCol')}</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                {roster.map((participant) => {
                  const estShareBP = estShareByMetaId.get(participant.metaId);
                  return (
                    <tr key={participant.metaId}>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <MetaIdBadge metaId={participant.metaId} identities={identities} compact />
                          {rosterIds.has(participant.metaId) && (
                            <span className="text-[11px] text-sky-600 dark:text-sky-400">{i18nService.t('metatask.mineTag')}</span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2 dark:text-claude-darkText text-claude-text">
                        {participant.effectiveClaims}
                      </td>
                      <td className="px-3 py-2 dark:text-claude-darkText text-claude-text">
                        {participant.verifiedContrib}
                      </td>
                      <td className="px-3 py-2 dark:text-claude-darkText text-claude-text">
                        {participant.reviewVotes}
                      </td>
                      {showEstShare && (
                        <td className="px-3 py-2 dark:text-claude-darkText text-claude-text">
                          {estShareBP === undefined ? '—' : `${(estShareBP / 100).toFixed(2)}%`}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Settlement: manifest when closed; explicit empty state until then */}
        <section>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('metatask.settlement')}
          </h3>
          {detail.settlement ? (
            <>
              <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.participant')}</th>
                      <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.shareBP')}</th>
                      <th className="text-left px-3 py-2 font-medium">%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                    {detail.settlement.shares.map((share) => (
                      <tr key={share.metaId}>
                        <td className="px-3 py-2">
                          <MetaIdBadge metaId={share.metaId} identities={identities} compact />
                        </td>
                        <td className="px-3 py-2 dark:text-claude-darkText text-claude-text">
                          {share.shareBP} bp
                          <span className="ml-1 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            ({share.from.submittedBP}+{share.from.reviewedBP})
                          </span>
                        </td>
                        <td className="px-3 py-2 dark:text-claude-darkText text-claude-text">
                          {(share.shareBP / 100).toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.settlement.unpaidHistory.length > 0 && (
                <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('metatask.unpaidCount').replace(
                    '{count}',
                    String(detail.settlement.unpaidHistory.length),
                  )}
                </p>
              )}
              {detail.progress.verified < detail.progress.total && (
                <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('metatask.legacyCompletionNote')}
                </p>
              )}
            </>
          ) : (
            <div className="px-3 py-3 text-xs rounded-xl border border-dashed dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService
                .t('metatask.settlementPending')
                .replace('{verified}', String(detail.progress.verified))
                .replace('{total}', String(detail.progress.total))}
              <ul className="mt-2 space-y-1">
                <ClosingCheckRow
                  ok={detail.progress.verified === detail.progress.total}
                  text={i18nService
                    .t('metatask.closing.allVerified')
                    .replace('{verified}', String(detail.progress.verified))
                    .replace('{total}', String(detail.progress.total))}
                />
                <ClosingCheckRow
                  ok={rootNode?.status === 'verified'}
                  text={i18nService.t('metatask.closing.rootAggregated')}
                />
                <ClosingCheckRow
                  ok={detail.progress.disputed === 0}
                  text={i18nService
                    .t('metatask.closing.noDisputes')
                    .replace('{count}', String(detail.progress.disputed))}
                />
              </ul>
              {rootNode && rootNode.status !== 'verified' && (
                <span className="block mt-1">{i18nService.t('metatask.settlementRootOpen')}</span>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Candidate drawer (competitive v2): opened from chain cards, node
          sections and parentref chips; parentref navigation swaps the
          selection in place */}
      {selectedCand && (
        <MetaTaskCandidateDrawer
          detail={detail}
          nodeId={selectedCand.nodeId}
          pinId={selectedCand.pinId}
          onClose={() => setSelectedCand(null)}
          onNavigate={(nodeId, pinId) => setSelectedCand({ nodeId, pinId })}
        />
      )}
    </div>
  );
};

/** One node row: group collapse toggle (when it has children) + the main
 * button that expands the branch task's definition/submission/votes. */
const NodeRow: React.FC<{
  node: MetaTaskNodeProjection;
  identities: Record<string, MetaTaskIdentity>;
  verifyQuorum: number;
  expanded: boolean;
  onToggleExpand: () => void;
  isGroup?: boolean;
  groupCollapsed?: boolean;
  groupStats?: { verified: number; total: number };
  onToggleGroup?: () => void;
}> = ({
  node,
  identities,
  verifyQuorum,
  expanded,
  onToggleExpand,
  isGroup,
  groupCollapsed,
  groupStats,
  onToggleGroup,
}) => (
  <div
    id={`metatask-node-${node.id}`}
    className="w-full flex items-center gap-1 px-3 py-2 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover/60 transition-colors"
  >
    {isGroup && (
      <button
        type="button"
        onClick={onToggleGroup}
        title={i18nService.t('metatask.groupToggleTip')}
        className="shrink-0 p-0.5 rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
      >
        {groupCollapsed ? (
          <ChevronRightIcon className="h-3.5 w-3.5" />
        ) : (
          <ChevronDownIcon className="h-3.5 w-3.5" />
        )}
      </button>
    )}
    <button
      type="button"
      onClick={onToggleExpand}
      title={i18nService.t('metatask.nodeExpandTip')}
      className="flex items-center gap-2 min-w-0 flex-1 text-left"
    >
      <span className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className="font-mono text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
          {node.id}
        </span>
        <span className="truncate text-xs dark:text-claude-darkText text-claude-text" title={node.title}>
          {node.title}
        </span>
        {node.weight !== null && (
          <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {(node.weight / 100).toFixed(2)}%
          </span>
        )}
        {isGroup && groupStats && groupStats.total > 0 && (
          <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {groupStats.verified}/{groupStats.total}
          </span>
        )}
      </span>
      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[11px] ${statusTone[node.status] ?? ''}`}>
        {statusLabel(node.status)}
        {node.disputed ? ` · ${i18nService.t('metatask.disputed')}` : ''}
      </span>
      {node.holder && (
        <span className="shrink-0 hidden sm:inline-flex">
          <MetaIdBadge metaId={node.holder.claimant} identities={identities} compact />
        </span>
      )}
      <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary w-14 text-right">
        {node.passVotes}/{verifyQuorum}
        {node.failVotes > 0 ? ` ·${node.failVotes}✗` : ''}
      </span>
      {expanded ? (
        <ChevronUpIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
      ) : (
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
      )}
    </button>
  </div>
);

/** The expanded node body: what the branch task asks for + what was submitted. */
const NodeExpanded: React.FC<{
  node: MetaTaskNodeProjection;
  identities: Record<string, MetaTaskIdentity>;
}> = ({ node, identities }) => (
  <div className="px-4 py-3 bg-claude-surfaceHover/40 dark:bg-claude-darkSurfaceHover/20 space-y-3 text-xs">
    {/* What this branch task asks for */}
    <div>
      <div className="font-medium dark:text-claude-darkText text-claude-text mb-1">
        {i18nService.t('metatask.node.taskDef')}
      </div>
      <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <span className="font-mono mr-1">{node.kind}</span>
        {node.specid && (
          <span className="break-all">
            spec: <span className="font-mono">{node.specid}</span>
          </span>
        )}
      </div>
      {node.params && Object.keys(node.params).length > 0 && (
        <pre className="mt-1 p-2 rounded-lg bg-claude-surface dark:bg-claude-darkSurface overflow-x-auto text-[11px] dark:text-claude-darkText text-claude-text">
          {prettyJson(node.params)}
        </pre>
      )}
    </div>
    {/* The submitted work (chain fact — any bot's submission is viewable) */}
    {node.submission ? (
      <div>
        <div className="font-medium dark:text-claude-darkText text-claude-text mb-1 flex items-center flex-wrap gap-1">
          {i18nService.t('metatask.node.submissionBy')}
          <span className="ml-1 inline-flex">
            <MetaIdBadge metaId={node.submission.submitter} identities={identities} compact />
          </span>
          <span className="ml-2 font-mono font-normal text-[10px] opacity-70" title={node.submission.pinId}>
            {node.submission.pinId.slice(0, 18)}…
          </span>
        </div>
        {node.submission.result && (
          <pre className="mt-1 p-2 rounded-lg bg-claude-surface dark:bg-claude-darkSurface overflow-x-auto text-[11px] dark:text-claude-darkText text-claude-text max-h-56">
            {prettyJson(node.submission.result)}
          </pre>
        )}
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {node.submission.hash && (
            <span className="font-mono text-[10px] break-all" title={node.submission.hash}>
              hash {node.submission.hash.slice(0, 24)}…
            </span>
          )}
          {node.submission.attachment && (
            <span className="font-mono text-[10px] break-all" title={node.submission.attachment}>
              attachment {node.submission.attachment.slice(0, 48)}
            </span>
          )}
        </div>
      </div>
    ) : (
      <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('metatask.node.noSubmissionYet')}
      </div>
    )}
    {/* Review votes */}
    {node.votes.length > 0 && (
      <div>
        <div className="font-medium dark:text-claude-darkText text-claude-text mb-1">
          {i18nService.t('metatask.node.votes')}
        </div>
        <div className="space-y-0.5">
          {node.votes.map((vote) => (
            <div key={vote.pinId} className="flex items-center gap-2 flex-wrap">
              <MetaIdBadge metaId={vote.voter} identities={identities} compact />
              <span
                className={`px-1 py-0.5 rounded text-[10px] ${
                  vote.verdict === 'pass'
                    ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                    : 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                }`}
              >
                {vote.verdict}
              </span>
              {!vote.counted && (
                <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {vote.ignoreReason ?? 'not counted'}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
);

export default MetaTaskDetail;
