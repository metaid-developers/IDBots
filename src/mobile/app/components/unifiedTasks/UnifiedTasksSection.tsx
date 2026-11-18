import { useMemo, useState } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { partitionDoneArchiveCards } from '@/utils/taskBoardOrganization';
import { t } from '../../../i18n';
import type { UnifiedTaskScreen } from '../../hooks/useUnifiedTasks';
import {
  filterUnifiedTaskCards,
  liveTaskCounts,
  UNIFIED_TASK_COLUMNS,
  type UnifiedTaskFilter,
} from '../../unifiedTaskPresentation';
import { BottomSheet } from '../BottomSheet';
import { UnifiedTaskCard } from './UnifiedTaskCard';

const FILTERS: UnifiedTaskFilter[] = ['all', 'in_progress', 'waiting_owner', 'waiting_external', 'defining', 'paused', 'done'];

export function UnifiedTasksSection({ screen }: { screen: UnifiedTaskScreen }): JSX.Element {
  const [status, setStatus] = useState<UnifiedTaskFilter>('in_progress');
  const [query, setQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [showOlderArchived, setShowOlderArchived] = useState(false);
  const counts = useMemo(() => liveTaskCounts(screen.cards), [screen.cards]);
  const filtered = useMemo(() => filterUnifiedTaskCards(screen.cards, status, query), [screen.cards, status, query]);
  const doneGroups = useMemo(() => status === 'done' && !query.trim()
    ? partitionDoneArchiveCards(filtered)
    : { recentDone: filtered, archivedDone: [] }, [filtered, status, query]);
  const visibleCards = status === 'done' && !query.trim() ? doneGroups.recentDone : filtered;
  const archived = status === 'done' && !query.trim() ? doneGroups.archivedDone : [];
  const visibleIds = new Set(visibleCards.map((card) => card.id));

  const selectStatus = (next: UnifiedTaskFilter) => {
    setStatus(next);
    setFilterOpen(false);
    setShowOlderArchived(false);
  };

  return (
    <div data-testid="work-activity">
      {counts.waiting_owner > 0 ? (
        <button type="button" className="twin-unified-attention" onClick={() => selectStatus('waiting_owner')}>
          <span><strong>{t('mobile.taskCenter.status.waiting_owner')}</strong> · {t('mobile.taskCenter.attention', { count: counts.waiting_owner })}</span>
          <span>{t('mobile.taskCenter.review')}<ChevronRightIcon className="h-4 w-4" aria-hidden /></span>
        </button>
      ) : null}
      <div className="twin-unified-search-row">
        <label className="twin-unified-search">
          <MagnifyingGlassIcon className="h-[18px] w-[18px]" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('mobile.taskCenter.searchPlaceholder')}
            aria-label={t('mobile.taskCenter.searchPlaceholder')}
            type="search"
          />
        </label>
        <button type="button" className="twin-unified-filter" onClick={() => setFilterOpen(true)} aria-haspopup="dialog">
          {t(status === 'all' ? 'mobile.taskCenter.status.all' : `mobile.taskCenter.status.${status}`)}
          <ChevronDownIcon className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="twin-unified-live-strip" aria-label={t('mobile.taskCenter.liveLabel')}>
        <button type="button" aria-pressed={status === 'in_progress'} onClick={() => selectStatus('in_progress')}>
          {t('mobile.taskCenter.live.active', { count: counts.in_progress })}
        </button>
        <button type="button" aria-pressed={status === 'waiting_owner'} onClick={() => selectStatus('waiting_owner')}>
          {t('mobile.taskCenter.live.needsYou', { count: counts.waiting_owner })}
        </button>
        <button type="button" aria-pressed={status === 'waiting_external'} onClick={() => selectStatus('waiting_external')}>
          {t('mobile.taskCenter.live.waiting', { count: counts.waiting_external })}
        </button>
      </div>
      <div className="twin-unified-section-heading">
        <h2>{t(status === 'all' ? 'mobile.taskCenter.status.all' : `mobile.taskCenter.status.${status}`)}</h2>
        <span>{t('mobile.taskCenter.shown', { count: visibleCards.length + (showOlderArchived ? archived.length : 0) })}</span>
      </div>
      {screen.error ? (
        <div className="twin-notice twin-notice-error" role="alert">
          <p>{screen.error}</p>
          <button type="button" className="min-h-[44px]" onClick={() => void screen.reload()}>{t('mobile.tasks.retry')}</button>
        </div>
      ) : null}
      {screen.actionError ? <p className="twin-notice twin-notice-error" role="alert">{screen.actionError}</p> : null}
      {screen.loading && screen.cards.length === 0 ? <p className="twin-empty-copy">{t('mobile.common.loading')}</p> : null}
      {!screen.loading && visibleCards.length === 0 ? (
        <div className="twin-empty" data-testid="unified-task-empty">
          <p className="twin-empty-title">{screen.cards.length === 0 ? t('mobile.taskCenter.emptyBoardTitle') : t('mobile.taskCenter.emptyFilterTitle')}</p>
          <p className="twin-empty-copy">{screen.cards.length === 0 ? t('mobile.taskCenter.emptyBoardBody') : t('mobile.taskCenter.emptyFilterBody')}</p>
        </div>
      ) : null}
      <div className="twin-unified-list" data-testid="unified-task-list">
        {visibleCards.map((card, index) => (
          <UnifiedTaskCard
            key={card.id}
            card={card}
            featured={index === 0 && status === 'in_progress' && !query.trim()}
            indented={Boolean(card.parentTaskId && visibleIds.has(card.parentTaskId))}
            busy={screen.pending}
            onOpenDetails={() => screen.openDetail(card.id)}
            onOpenChat={() => void screen.openTaskChat(card.id)}
          />
        ))}
      </div>
      {archived.length > 0 ? (
        <div className="mt-2">
          <button type="button" className="twin-unified-archive-toggle" onClick={() => setShowOlderArchived((value) => !value)}>
            {t(showOlderArchived ? 'mobile.taskCenter.archive.hide' : 'mobile.taskCenter.archive.show', { count: doneGroups.archivedDone.length })}
          </button>
          {showOlderArchived ? (
            <div className="twin-unified-list mt-2">
              {doneGroups.archivedDone.map((card) => (
                <UnifiedTaskCard
                  key={card.id}
                  card={card}
                  featured={false}
                  indented={Boolean(card.parentTaskId && visibleIds.has(card.parentTaskId))}
                  busy={screen.pending}
                  onOpenDetails={() => screen.openDetail(card.id)}
                  onOpenChat={() => void screen.openTaskChat(card.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {filterOpen ? (
        <BottomSheet title={t('mobile.taskCenter.filterTitle')} onClose={() => setFilterOpen(false)}>
          <p className="twin-help mb-2">{t('mobile.taskCenter.filterBody')}</p>
          <div role="list" aria-label={t('mobile.taskCenter.filterTitle')}>
            {FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                className="twin-unified-filter-option"
                aria-pressed={status === filter}
                onClick={() => selectStatus(filter)}
              >
                <span>{t(filter === 'all' ? 'mobile.taskCenter.status.all' : `mobile.taskCenter.status.${filter}`)}</span>
                <span className="twin-unified-filter-count">
                  {filter === 'all' ? screen.cards.length : screen.cards.filter((card) => card.column === filter).length}
                </span>
                {status === filter ? <CheckIcon className="h-5 w-5 text-[var(--twin-warning)]" aria-hidden /> : <ChevronRightIcon className="h-4 w-4 text-[var(--twin-text-tertiary)]" aria-hidden />}
              </button>
            ))}
          </div>
          <div className="twin-unified-filter-legend">
            <ClockIcon className="h-4 w-4" aria-hidden />
            <span>{t('mobile.taskCenter.filterLegend', { count: UNIFIED_TASK_COLUMNS.length })}</span>
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}
