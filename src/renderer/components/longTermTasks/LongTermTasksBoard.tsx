import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { selectTask } from '../../store/slices/longTermTaskSlice';
import { longTermTaskService } from '../../services/longTermTask';
import { i18nService } from '../../services/i18n';
import { selectTrackedTasksNeedingAttention } from '../../utils/trackedTaskAttention';
import {
  filterTaskBoardCards,
  partitionDoneArchiveCards,
  sortColumnCards,
  type TaskBoardTierFilter,
} from '../../utils/taskBoardOrganization';
import {
  LONG_TERM_COLUMN_LABEL_KEYS,
  LONG_TERM_COLUMN_ORDER,
  type LongTermColumn,
  type LongTermTaskSummary,
} from '../../types/longTermTask';
import LongTermTaskCard from './LongTermTaskCard';
import LongTermTaskDetail from './LongTermTaskDetail';

const COLUMN_DOT_CLASS: Record<LongTermColumn, string> = {
  waiting_owner: 'bg-amber-400',
  in_progress: 'bg-sky-400',
  waiting_external: 'bg-violet-400',
  defining: 'bg-claude-textSecondary dark:bg-claude-darkTextSecondary',
  paused: 'bg-zinc-500',
  done: 'bg-emerald-400',
};

const COLUMN_FRAME_CLASS: Record<LongTermColumn, string> = {
  waiting_owner: 'border-amber-500/30',
  in_progress: 'dark:border-claude-darkBorder/40 border-claude-border/40',
  waiting_external: 'dark:border-claude-darkBorder/40 border-claude-border/40',
  defining: 'border-dashed dark:border-claude-darkBorder/50 border-claude-border/50',
  paused: 'dark:border-claude-darkBorder/30 border-claude-border/30',
  done: 'dark:border-claude-darkBorder/30 border-claude-border/30',
};

interface LongTermTasksBoardProps {
  onReturnToStudioChat?: () => void;
}

const LongTermTasksBoard: React.FC<LongTermTasksBoardProps> = ({ onReturnToStudioChat }) => {
  const dispatch = useDispatch();
  const { available, bridgeMissingReason, board, loading, selectedTaskId } = useSelector(
    (state: RootState) => state.longTermTask,
  );
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  const longTermNeedsDecisionCount = useMemo(
    () => selectTrackedTasksNeedingAttention({ longTermTask: { board: longTermBoard } }).longTerm,
    [longTermBoard],
  );

  const [tierFilter, setTierFilter] = useState<TaskBoardTierFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showOlderArchived, setShowOlderArchived] = useState(false);

  const threeStateSummary = useMemo(() => {
    const counts = { waiting_owner: 0, in_progress: 0, waiting_external: 0 };
    for (const card of board?.cards ?? []) {
      if (card.stage === 'done' || card.stage === 'cancelled') continue;
      const state = card.managedState
        ?? (card.stage === 'defining' || card.stage === 'paused' || card.column === 'waiting_owner'
          ? 'waiting_owner'
          : card.column === 'waiting_external'
            ? 'waiting_external'
            : 'in_progress');
      counts[state] += 1;
    }
    return counts;
  }, [board]);

  const allCards = useMemo(() => board?.cards ?? [], [board]);
  const filteredCards = useMemo(
    () => filterTaskBoardCards(allCards, { tier: tierFilter, query: searchQuery }),
    [allCards, tierFilter, searchQuery],
  );
  const filteredById = useMemo(
    () => new Map<string, LongTermTaskSummary>(filteredCards.map((card) => [card.id, card])),
    [filteredCards],
  );

  useEffect(() => {
    void longTermTaskService.init();
  }, []);

  const openCreationSession = () => {
    if (onReturnToStudioChat) {
      onReturnToStudioChat();
      return;
    }
    window.dispatchEvent(
      new CustomEvent('cowork:newChatWithDraft', { detail: { text: i18nService.t('longTermTask.newTaskDraft') } }),
    );
  };

  if (selectedTaskId) {
    return <LongTermTaskDetail taskId={selectedTaskId} />;
  }

  const isEmpty = allCards.length === 0;
  const hasActiveSearch = searchQuery.trim().length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: creation entry + tier filters/search + 3-state live summary pills */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={openCreationSession} className="btn-idchat-primary-filled inline-flex h-9 items-center justify-center rounded-[var(--shape-radius-lg)] px-3 text-sm font-medium">
            {i18nService.t('longTermTask.newTask')}
          </button>
          <div
            data-slot="task-board-tier-filter"
            className="inline-flex items-center rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 p-0.5 text-xs"
          >
            {(['all', 'long_term', 'standard'] as const).map((mode) => {
              const labelKey =
                mode === 'all'
                  ? 'longTermTask.filter.all'
                  : mode === 'long_term'
                    ? 'longTermTask.filter.longTerm'
                    : 'longTermTask.filter.standard';
              const active = tierFilter === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTierFilter(mode)}
                  className={`rounded-md px-2.5 py-1 font-medium transition ${
                    active
                      ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
                      : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:opacity-90'
                  }`}
                >
                  {i18nService.t(labelKey)}
                </button>
              );
            })}
          </div>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={i18nService.t('longTermTask.searchPlaceholder')}
            className="h-8 w-52 rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 dark:bg-claude-darkSurface bg-claude-surface px-2.5 text-xs dark:text-claude-darkText text-claude-text placeholder:opacity-60"
          />
          <p className="hidden xl:block text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('longTermTask.newTaskHint')}
          </p>
        </div>

        <div
          data-slot="studio-managed-task-summary"
          className="flex items-center gap-2 text-xs"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-amber-700 dark:text-amber-300">
            {longTermNeedsDecisionCount > 0 ? (
              <span
                data-testid="long-term-tab-decision-indicator"
                title={i18nService.t('trackedTaskNeedsDecision').replace('{count}', String(longTermNeedsDecisionCount))}
                aria-label={i18nService.t('trackedTaskNeedsDecision').replace('{count}', String(longTermNeedsDecisionCount))}
                role="img"
                className="tracked-task-decision-indicator shrink-0"
              />
            ) : (
              <span className="h-2 w-2 rounded-full bg-amber-400" />
            )}
            <span>{i18nService.t('longTermTask.column.waitingOwner')}</span>
            <span className="tabular-nums font-semibold">{threeStateSummary.waiting_owner}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border dark:border-claude-darkBorder/60 border-claude-border/60 px-2.5 py-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="h-2 w-2 rounded-full bg-sky-400" />
            <span>{i18nService.t('longTermTask.column.inProgress')}</span>
            <span className="tabular-nums font-semibold">{threeStateSummary.in_progress}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border dark:border-claude-darkBorder/60 border-claude-border/60 px-2.5 py-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="h-2 w-2 rounded-full bg-violet-400" />
            <span>{i18nService.t('longTermTask.column.waitingExternal')}</span>
            <span className="tabular-nums font-semibold">{threeStateSummary.waiting_external}</span>
          </span>
        </div>
      </div>

      {!available && (
        <div className="mx-4 mt-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-4">
          <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('longTermTask.bridgeMissingTitle')}
          </div>
          <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {bridgeMissingReason ?? i18nService.t('longTermTask.bridgeMissingHint')}
          </div>
        </div>
      )}

      {available && isEmpty && !loading && (
        <div className="mx-4 mt-4 rounded-xl border border-dashed dark:border-claude-darkBorder border-claude-border p-6 text-center">
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('longTermTask.empty')}
          </div>
        </div>
      )}

      {available && !isEmpty && (
        <div className="mt-3 flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full gap-3 px-4 pb-3" style={{ minWidth: 'max-content' }}>
            {LONG_TERM_COLUMN_ORDER.map((column) => {
              const columnDef = board?.columns.find((entry) => entry.column === column);
              const rawCards = (columnDef?.cardIds ?? [])
                .map((id) => filteredById.get(id))
                .filter((card): card is LongTermTaskSummary => Boolean(card));
              const cards = sortColumnCards(column, rawCards);
              const isDoneCol = column === 'done';
              const { recentDone, archivedDone } = isDoneCol
                ? partitionDoneArchiveCards(cards)
                : { recentDone: cards, archivedDone: [] as LongTermTaskSummary[] };
              const visibleCards = isDoneCol && !hasActiveSearch ? recentDone : cards;
              const visibleIds = new Set(visibleCards.map((c) => c.id));
              const archivedIds = new Set(archivedDone.map((c) => c.id));
              const openCard = (taskId: string) => {
                dispatch(selectTask(taskId));
                void longTermTaskService.loadTask(taskId);
              };
              return (
                <section
                  key={column}
                  className={`flex w-72 shrink-0 flex-col rounded-xl border dark:bg-claude-darkSurface/40 bg-claude-surface/40 ${COLUMN_FRAME_CLASS[column]}`}
                >
                  <header className="flex items-center gap-2 border-b dark:border-claude-darkBorder/30 border-claude-border/30 px-3 py-2.5">
                    <span className={`h-2 w-2 rounded-full ${COLUMN_DOT_CLASS[column]}`} />
                    <span className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
                      {i18nService.t(LONG_TERM_COLUMN_LABEL_KEYS[column])}
                    </span>
                    <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{cards.length}</span>
                  </header>
                  <div className="flex-1 space-y-2 overflow-y-auto p-2">
                    {visibleCards.map((card) => (
                      <LongTermTaskCard
                        key={card.id}
                        card={card}
                        indentedUnderParent={Boolean(card.parentTaskId && visibleIds.has(card.parentTaskId))}
                        onOpen={openCard}
                      />
                    ))}
                    {isDoneCol && !hasActiveSearch && archivedDone.length > 0 && (
                      <div className="pt-1">
                        <button
                          type="button"
                          data-slot="done-archive-fold-toggle"
                          onClick={() => setShowOlderArchived((prev) => !prev)}
                          className="w-full rounded-lg border border-dashed dark:border-claude-darkBorder/50 border-claude-border/50 px-2.5 py-1.5 text-left text-[11px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:opacity-90"
                        >
                          {i18nService
                            .t(
                              showOlderArchived
                                ? 'longTermTask.archive.olderToggleHide'
                                : 'longTermTask.archive.olderToggleShow',
                            )
                            .replace('{count}', String(archivedDone.length))}
                        </button>
                        {showOlderArchived && (
                          <div className="mt-2 space-y-2">
                            {archivedDone.map((card) => (
                              <LongTermTaskCard
                                key={card.id}
                                card={card}
                                indentedUnderParent={Boolean(card.parentTaskId && archivedIds.has(card.parentTaskId))}
                                onOpen={openCard}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default LongTermTasksBoard;
