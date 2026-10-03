import React, { useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { ArrowPathIcon, BoltIcon, QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { metaTaskService } from '../../services/metatask';
import { setView } from '../../store/slices/metataskSlice';
import { store } from '../../store';
import { i18nService } from '../../services/i18n';
import MetaTaskDetail from './MetaTaskDetail';
import MetaIdBadge from './MetaIdBadge';
import Tooltip from '../ui/Tooltip';
import { metaTaskLifeStatus, metaTaskLifeStatusLabel, metaTaskLifeStatusTone } from './metaTaskStatus';
import { formatMetaTaskRelativeTime } from './metaTaskFormat';
import type { MetaTaskAlert, MetaTaskBoardTask, MetaTaskIdentity } from '../../types/metatask';

/** Prefilled participation draft: the bot reads the task, picks an open node,
 * claims with the guard and completes it (prose-first; the button never acts).
 * Competitive tasks get the lock-free fork-race wording instead. */
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

/** Alerts are grouped into ONE actionable card per (kind+task+node) — the raw
 * feed was noisy (and the stored duplicates from the v1 dedupe bug are folded
 * away here until the 48h horizon prunes them). */
interface GroupedAlert {
  key: string;
  alert: MetaTaskAlert;
  count: number;
  taskTitle: string;
  competitive: boolean;
}

const MetaTaskBoard: React.FC = () => {
  const board = useSelector((state: RootState) => state.metatask.board);
  const view = useSelector((state: RootState) => state.metatask.view);
  const loading = useSelector((state: RootState) => state.metatask.loading);
  const refreshing = useSelector((state: RootState) => state.metatask.refreshing);
  const error = useSelector((state: RootState) => state.metatask.error);
  const bridgeMissingReason = useSelector((state: RootState) => state.metatask.bridgeMissingReason);
  const selectedRootPinId = useSelector((state: RootState) => state.metatask.selectedRootPinId);

  useEffect(() => {
    void metaTaskService.init();
    return () => metaTaskService.destroy();
  }, []);

  const tasks = board?.tasks ?? [];
  const mine = useMemo(() => tasks.filter((task) => task.myRoles.length > 0), [tasks]);
  const shown = view === 'mine' ? mine : tasks;

  const groupedAlerts: GroupedAlert[] = useMemo(() => {
    const byKey = new Map<string, GroupedAlert>();
    for (const alert of board?.alerts ?? []) {
      const task = tasks.find((t) => t.rootPinId === alert.rootPinId);
      const taskTitle = task?.title ?? '';
      const competitive = task?.mode === 'competitive';
      const key = `${alert.kind}|${alert.rootPinId}|${alert.node ?? ''}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        if (alert.createdAtMs > existing.alert.createdAtMs) existing.alert = alert;
      } else {
        byKey.set(key, { key, alert, count: 1, taskTitle, competitive });
      }
    }
    return Array.from(byKey.values()).slice(0, 4);
  }, [board?.alerts, tasks]);

  if (selectedRootPinId) {
    return <MetaTaskDetail key={selectedRootPinId} rootPinId={selectedRootPinId} />;
  }

  const tabButtonClass = (active: boolean): string =>
    `px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
      active
        ? 'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkText text-claude-text'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
    }`;

  return (
    <div className="flex flex-col h-full">
      {/* Header: inner views + refresh + activity anchor */}
      <div className="flex items-center justify-between border-b dark:border-claude-darkBorder border-claude-border px-4 py-2 shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => store.dispatch(setView('square'))}
            className={tabButtonClass(view === 'square')}
          >
            {i18nService.t('metatask.view.square')}
          </button>
          <button
            type="button"
            onClick={() => store.dispatch(setView('mine'))}
            className={tabButtonClass(view === 'mine')}
          >
            {i18nService.t('metatask.view.mine')}
          </button>
          <Tooltip content={i18nService.t('metatask.whatIsTip')} position="bottom" maxWidth="340px">
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-help">
              <QuestionMarkCircleIcon className="h-4 w-4" />
              {i18nService.t('metatask.whatIs')}
            </span>
          </Tooltip>
        </div>
        <div className="flex items-center gap-3">
          {board && (
            <span
              className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
              title={i18nService.t('metatask.activityAnchorTip')}
            >
              {i18nService
                .t('metatask.activityAnchor')
                .replace('{block}', String(board.refresh.boundaryBlock ?? '—'))}
            </span>
          )}
          <button
            type="button"
            onClick={() => void metaTaskService.refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50 transition-colors"
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? i18nService.t('metatask.refreshing') : i18nService.t('metatask.refresh')}
          </button>
        </div>
      </div>

      {(error || bridgeMissingReason) && (
        <div className="mx-4 mt-3 px-3 py-2 text-sm rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400">
          {bridgeMissingReason ?? error}
        </div>
      )}
      {board?.activation?.hAct2 != null &&
        (board.refresh.boundaryBlock === null || board.refresh.boundaryBlock < board.activation.hAct2) && (
          <div className="mx-4 mt-3 px-3 py-2 text-xs rounded-lg bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400">
            {i18nService
              .t('metatask.activationNotice')
              .replace('{hAct2}', String(board.activation.hAct2))
              .replace(
                '{block}',
                board.refresh.boundaryBlock === null ? '—' : String(board.refresh.boundaryBlock),
              )}
          </div>
        )}

      {/* Actionable alert cards (grouped; each offers the participate handoff) */}
      {groupedAlerts.length > 0 && (
        <div className="mx-4 mt-3 space-y-2">
          {groupedAlerts.map(({ key, alert, count, taskTitle, competitive }) => {
            const isClosing = alert.kind === 'closing_drive';
            const message = isClosing
              ? i18nService
                  .t('metatask.alertCard.closingDrive')
                  .replace('{title}', taskTitle || alert.rootPinId.slice(0, 12))
                  .replace('{count}', alert.detail ?? '')
              : alert.kind === 'claim_ttl_soon'
                ? i18nService
                    .t('metatask.alertCard.claimTtl')
                    .replace('{node}', alert.node ?? '—')
                    .replace('{detail}', alert.detail ?? '')
                : i18nService
                    .t('metatask.alertCard.submissionChange')
                    .replace('{node}', alert.node ?? '—')
                    .replace('{detail}', alert.detail ?? '');
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200/60 dark:border-amber-800/40"
              >
                <button
                  type="button"
                  onClick={() => metaTaskService.selectTask(alert.rootPinId)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block text-xs font-medium text-amber-700 dark:text-amber-400 truncate">
                    {message}
                    {count > 1 && (
                      <span className="ml-1 opacity-60">×{count}</span>
                    )}
                  </span>
                  {taskTitle && (
                    <span className="block text-[11px] text-amber-600/80 dark:text-amber-400/70 truncate">
                      {taskTitle}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => participateDraft(taskTitle || alert.rootPinId, alert.rootPinId, alert.node, competitive)}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 transition-colors"
                >
                  <BoltIcon className="h-3.5 w-3.5" />
                  {i18nService.t('metatask.participateNow')}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {board?.refresh.lastError && !error && (
        <div className="mx-4 mt-3 px-3 py-2 text-xs rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
          {board.refresh.lastError}
        </div>
      )}

      {/* Task cards */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loading && !board ? (
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-8 text-center">
            {i18nService.t('metatask.loading')}
          </div>
        ) : shown.length === 0 ? (
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-8 text-center">
            {view === 'mine' ? i18nService.t('metatask.mineEmpty') : i18nService.t('metatask.noTasks')}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((task) => (
              <MetaTaskCard key={task.rootPinId} task={task} identities={board?.identities} />
            ))}
          </div>
        )}
        <p className="mt-4 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metatask.indexLagNote')}
        </p>
      </div>
    </div>
  );
};

const MetaTaskCard: React.FC<{ task: MetaTaskBoardTask; identities?: Record<string, MetaTaskIdentity> }> = ({
  task,
  identities,
}) => {
  const progressPct = task.progress.total > 0 ? Math.round((task.progress.verified / task.progress.total) * 100) : 0;
  const lifeStatus = metaTaskLifeStatus({
    taskComplete: task.taskComplete,
    settlementFinalized: task.settlementFinalized,
    progress: task.progress,
    participantCount: task.participantCount,
  });
  const lastActive = formatMetaTaskRelativeTime(task.lastActivityMs);
  return (
    <div className="p-3 rounded-xl border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors flex flex-col gap-2">
      <button
        type="button"
        onClick={() => metaTaskService.selectTask(task.rootPinId)}
        className="text-left flex flex-col gap-2"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text line-clamp-2">
            {task.title}
          </span>
          <span className={`shrink-0 px-1.5 py-0.5 text-[11px] rounded ${metaTaskLifeStatusTone[lifeStatus]}`}>
            {metaTaskLifeStatusLabel(lifeStatus)}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <MetaIdBadge metaId={task.publisher} identities={identities} compact />
          <span>·</span>
          <span>
            {i18nService.t('metatask.participants').replace('{count}', String(task.participantCount))}
          </span>
        </div>
        {task.brief && (
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2">
            {task.brief}
          </span>
        )}
        {/* Progress bar */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metatask.progressVerified')
                .replace('{verified}', String(task.progress.verified))
                .replace('{total}', String(task.progress.total))}
            </span>
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{progressPct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover overflow-hidden">
            <div
              className="h-full bg-brand rounded-full transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
        {task.progress.disputed > 0 && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {i18nService.t('metatask.disputedCount').replace('{count}', String(task.progress.disputed))}
          </span>
        )}
        {task.myRoles.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {task.myRoles.includes('publisher') && (
              <span className="px-1.5 py-0.5 text-[11px] rounded bg-brand/10 text-brand">
                {i18nService.t('metatask.role.publisher')}
              </span>
            )}
            {task.myRoles.includes('participant') && (
              <span className="px-1.5 py-0.5 text-[11px] rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400">
                {i18nService.t('metatask.role.participant')}
              </span>
            )}
            {task.myStats && (
              <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metatask.myStatsSummary')
                  .replace('{verified}', String(task.myStats.verified))
                  .replace('{reviews}', String(task.myStats.reviewVotes))}
              </span>
            )}
            {!task.settlementFinalized && task.myStats && task.myStats.estShareBP > 0 && (
              <span
                className="px-1.5 py-0.5 text-[11px] rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400"
                title={i18nService.t('metatask.estShareTip')}
              >
                {i18nService.t('metatask.estShare').replace('{pct}', (task.myStats.estShareBP / 100).toFixed(2))}
              </span>
            )}
            {task.settlementFinalized && task.myStats && task.myStats.shareBP > 0 && (
              <span className="px-1.5 py-0.5 text-[11px] rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                {i18nService.t('metatask.myShare').replace('{pct}', (task.myStats.shareBP / 100).toFixed(2))}
              </span>
            )}
          </div>
        )}
        <span
          className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
          title={i18nService.t('metatask.activityAnchorTip')}
        >
          {lastActive && `${i18nService.t('metatask.lastActive').replace('{when}', lastActive)} · `}
          {i18nService.t('metatask.events').replace('{count}', String(task.freshness.eventCount))}
          {' · '}
          {i18nService.t('metatask.blockAnchor').replace('{block}', String(task.freshness.boundaryBlock))}
        </span>
      </button>
      {!task.taskComplete && (
        <button
          type="button"
          onClick={() => participateDraft(task.title, task.rootPinId, null, task.mode === 'competitive')}
          className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg btn-idchat-primary-filled"
        >
          <BoltIcon className="h-3.5 w-3.5" />
          {i18nService.t('metatask.participateNow')}
        </button>
      )}
    </div>
  );
};

export default MetaTaskBoard;
