import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import type { ScheduledTask, ScheduledTaskRun, Schedule } from '../../bridge/types';
import { useScheduledTasks } from '../hooks/useScheduledTasks';
import type { OpenWorkSession } from '../hooks/useWorkActivity';
import { formatDurationMs, formatRunTime } from '../format';
import { BottomSheet } from '../components/BottomSheet';
import { Section } from '../components/Section';
import { Switch } from '../components/Switch';
import { UnifiedTasksSection } from '../components/unifiedTasks/UnifiedTasksSection';
import { UnifiedTaskDetail } from '../components/unifiedTasks/UnifiedTaskDetail';
import { useUnifiedTasks } from '../hooks/useUnifiedTasks';
import { NotificationBell } from '../components/NotificationBell';
import { isMeExpiredInviteTrial, useMeStore } from '../me/mePointsStore';

type ScheduleKind = 'interval' | 'daily' | 'cron';
type TaskScreen = ReturnType<typeof useScheduledTasks>;
type PrimaryTaskTab = 'tasks' | 'scheduled';

const PRIMARY_TASK_TAB_KEY = 'idbots.mobile.tasksPrimaryTab.v1';

function readPrimaryTaskTab(): PrimaryTaskTab {
  try {
    return window.localStorage.getItem(PRIMARY_TASK_TAB_KEY) === 'scheduled' ? 'scheduled' : 'tasks';
  } catch {
    return 'tasks';
  }
}

const LAST_STATUS_KEY: Record<NonNullable<ScheduledTask['state']['lastStatus']>, string> = {
  success: 'mobile.tasks.statusLabel.success',
  error: 'mobile.tasks.statusLabel.error',
  running: 'mobile.tasks.statusLabel.running',
  max_fires_reached: 'mobile.tasks.statusLabel.maxFiresReached',
};

function TaskRuns({
  taskId,
  runs,
  screen,
}: {
  taskId: string;
  runs: ScheduledTaskRun[];
  screen: TaskScreen;
}): JSX.Element {
  const error = screen.historyErrorFor(taskId);
  return (
    <div className="mt-2 border-t border-[var(--border-color)] pt-2" data-testid={`task-runs-${taskId}`}>
      <p className="mb-1 text-xs font-medium uppercase text-[var(--text-secondary)]">{t('mobile.tasks.historyTitle')}</p>
      {error ? (
        <div role="alert" className="py-2 text-sm text-red-600">
          <p>{error}</p>
          <button type="button" className="min-h-[44px]" onClick={() => void screen.loadRuns(taskId)}>
            {t('mobile.tasks.retry')}
          </button>
        </div>
      ) : null}
      {screen.historyLoadingFor(taskId) ? <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      {!error && runs.length === 0 && !screen.historyLoadingFor(taskId) ? (
        <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.tasks.noRuns')}</p>
      ) : (
        runs.map((run) => (
          <div key={run.id} className="border-b border-[var(--border-color)] py-2 text-sm last:border-b-0" data-testid={`task-run-${run.id}`}>
            <p className="text-[var(--text-primary)]">{t(`mobile.tasks.runStatus.${run.status}`)}</p>
            <p className="text-xs text-[var(--text-secondary)]">
              {new Date(run.startedAt).toLocaleString()}
              {run.durationMs !== null && run.durationMs !== undefined
                ? ` · ${t('mobile.tasks.durationMs', { ms: formatDurationMs(run.durationMs) ?? '0' })}`
                : ''}
              {` · ${t(`mobile.tasks.trigger.${run.trigger}`)}`}
            </p>
            {run.error ? <p className="mt-1 text-xs text-red-600">{run.error}</p> : null}
            {run.skipReason ? <p className="mt-1 text-xs text-[var(--text-secondary)]">{t(`mobile.tasks.skipReason.${run.skipReason}`)}</p> : null}
            <button
              type="button"
              disabled={!run.sessionId}
              title={run.sessionId ? undefined : t('mobile.activity.unbound')}
              onClick={() => void screen.openRun(run)}
              aria-label={`${t('mobile.activity.openResult')} · ${run.id}`}
              className="mt-1 min-h-[44px] rounded-xl px-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)] disabled:opacity-40"
            >
              {t('mobile.activity.openResult')}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function TaskRow({
  task,
  screen,
  trialExpired,
  onEdit,
  onDelete,
}: {
  task: ScheduledTask;
  screen: TaskScreen;
  trialExpired?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const runs = screen.runsFor(task.id);
  const running = task.state.runningAtMs !== null;
  const pending = screen.pendingFor(task.id);
  const error = screen.errorFor(task.id);
  const nextRun = formatRunTime(task.state.nextRunAtMs);
  const lastRun = formatRunTime(task.state.lastRunAtMs);
  const lastStatus = task.state.lastStatus;

  return (
    <div className="twin-task-row" data-testid={`task-row-${task.id}`}>
      <div className="twin-task-main">
        <button
          type="button"
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            if (next) void screen.loadRuns(task.id);
          }}
          aria-expanded={expanded}
          className="twin-icon-button"
          aria-label={`${t(expanded ? 'mobile.tasks.hideHistory' : 'mobile.tasks.showHistory')} · ${task.name}`}
        >
          {expanded ? <ChevronDownIcon className="h-5 w-5" aria-hidden /> : <ChevronRightIcon className="h-5 w-5" aria-hidden />}
        </button>
        <div className="twin-list-copy">
          <p className="twin-list-title truncate">{task.name}</p>
          <p className="twin-list-subtitle">
            {nextRun ? t('mobile.tasks.nextRun', { time: nextRun }) : t('mobile.tasks.noNextRun')}
            {lastRun ? ` · ${t('mobile.tasks.lastRun', { time: lastRun })}` : ''}
          </p>
          <p className="twin-list-subtitle">
            {lastStatus
              ? t('mobile.tasks.lastStatus', { status: t(LAST_STATUS_KEY[lastStatus]) })
              : t('mobile.tasks.neverRun')}
          </p>
        </div>
        <Switch
          checked={task.enabled}
          disabled={pending !== null}
          onChange={(checked) => void screen.toggleTask(task.id, checked)}
          label={`${t('mobile.tasks.enabled')} · ${task.name}`}
        />
      </div>
      <div className="twin-task-actions">
        <button
          type="button"
          onClick={onEdit}
          disabled={pending !== null}
          aria-label={`${t('mobile.tasks.edit')} · ${task.name}`}
          className="twin-button twin-button-secondary twin-button-small"
        >
          <PencilSquareIcon className="h-4 w-4" aria-hidden />
          {t('mobile.tasks.edit')}
        </button>
        <button
          type="button"
          onClick={() => void (running ? screen.stopTask(task.id) : screen.runTask(task.id))}
          disabled={pending !== null || (!running && Boolean(trialExpired))}
          aria-label={`${t(running ? 'mobile.tasks.stop' : 'mobile.tasks.runNow')} · ${task.name}`}
          className="twin-button twin-button-secondary twin-button-small"
        >
          {running ? <StopIcon className="h-4 w-4" aria-hidden /> : <PlayIcon className="h-4 w-4" aria-hidden />}
          {t(running ? 'mobile.tasks.stop' : 'mobile.tasks.runNow')}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={pending !== null}
          aria-label={`${t('mobile.tasks.deleteConfirm')} · ${task.name}`}
          className="twin-icon-button twin-icon-button-danger"
        >
          <TrashIcon className="h-5 w-5" aria-hidden />
        </button>
      </div>
      {running ? <p className="twin-help text-[var(--twin-warning)]">{t('mobile.tasks.running')}</p> : null}
      {error ? <p role="alert" className="twin-notice twin-notice-error mt-2">{error}</p> : null}
      {expanded ? <TaskRuns taskId={task.id} runs={runs} screen={screen} /> : null}
    </div>
  );
}

function TaskFormSheet({
  screen,
  task,
  twinName,
  twinAvailable,
  open,
  onClose,
}: {
  screen: TaskScreen;
  task: ScheduledTask | null;
  twinName: string;
  twinAvailable: boolean;
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('interval');
  const [intervalMinutes, setIntervalMinutes] = useState('');
  const [dailyTime, setDailyTime] = useState('09:00');
  const [cronExpression, setCronExpression] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const saving = task ? screen.pendingFor(task.id) === 'save' : screen.creating;

  useEffect(() => {
    if (!open) return;
    setName(task?.name ?? '');
    setPrompt(task?.prompt ?? '');
    setValidation(null);
    const schedule = task?.schedule;
    if (schedule?.type === 'interval') {
      setScheduleKind('interval');
      setIntervalMinutes(String(schedule.intervalMs / 60_000));
    } else if (schedule?.type === 'cron') {
      const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(schedule.expression);
      if (match) {
        setScheduleKind('daily');
        setDailyTime(`${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`);
      } else {
        setScheduleKind('cron');
        setCronExpression(schedule.expression);
      }
    } else {
      setScheduleKind('interval');
      setIntervalMinutes('');
    }
  }, [open, task]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) {
      setValidation(t('mobile.tasks.validation.name'));
      return;
    }
    if (!prompt.trim()) {
      setValidation(t('mobile.tasks.validation.prompt'));
      return;
    }
    let schedule: Schedule;
    if (scheduleKind === 'interval') {
      const minutes = Number(intervalMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setValidation(t('mobile.tasks.validation.interval'));
        return;
      }
      schedule = { type: 'interval', intervalMs: minutes * 60_000, unit: 'minutes', value: minutes };
    } else if (scheduleKind === 'daily') {
      const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dailyTime);
      if (!match) {
        setValidation(t('mobile.tasks.validation.dailyTime'));
        return;
      }
      schedule = { type: 'cron', expression: `${Number(match[2])} ${Number(match[1])} * * *` };
    } else {
      if (cronExpression.trim().split(/\s+/).length !== 5) {
        setValidation(t('mobile.tasks.validation.cron'));
        return;
      }
      schedule = { type: 'cron', expression: cronExpression.trim() };
    }
    setValidation(null);
    const saved = task
      ? await screen.updateTask(task.id, { name: name.trim(), prompt: prompt.trim(), schedule })
      : await screen.createTask({ name: name.trim(), prompt: prompt.trim(), schedule });
    if (saved) onClose();
  };

  const inputClass = 'twin-input';
  const segmented = (kind: ScheduleKind, labelKey: string) => (
    <button
      type="button"
      onClick={() => setScheduleKind(kind)}
      aria-pressed={scheduleKind === kind}
      className="twin-segment"
    >
      {t(labelKey)}
    </button>
  );

  return (
    <BottomSheet title={t(task ? 'mobile.tasks.editTitle' : 'mobile.tasks.createTitle')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <input aria-label={t('mobile.tasks.namePlaceholder')} value={name} onChange={(event) => setName(event.target.value)} placeholder={t('mobile.tasks.namePlaceholder')} className={inputClass} />
        <textarea aria-label={t('mobile.tasks.promptPlaceholder')} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t('mobile.tasks.promptPlaceholder')} rows={3} className={`${inputClass} resize-none`} />
        {!task ? (
          <p className={`text-sm ${twinAvailable ? 'text-[var(--text-secondary)]' : 'text-red-600'}`}>
            {twinAvailable ? t('mobile.tasks.twinBinding', { name: twinName }) : t('mobile.tasks.twinUnavailable')}
          </p>
        ) : null}
        <p className="twin-section-label">{t('mobile.tasks.scheduleLabel')}</p>
        <div className="twin-segmented">
          {segmented('interval', 'mobile.tasks.scheduleInterval')}
          {segmented('daily', 'mobile.tasks.scheduleDaily')}
          {scheduleKind === 'cron' ? segmented('cron', 'mobile.tasks.scheduleCron') : null}
        </div>
        {scheduleKind === 'interval' ? (
          <input aria-label={t('mobile.tasks.intervalPlaceholder')} value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} placeholder={t('mobile.tasks.intervalPlaceholder')} inputMode="decimal" className={inputClass} />
        ) : scheduleKind === 'daily' ? (
          <label className="flex min-h-[44px] items-center gap-3 text-sm text-[var(--text-secondary)]">
            {t('mobile.tasks.dailyTimeLabel')}
            <input aria-label={t('mobile.tasks.dailyTimeLabel')} type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} className={`${inputClass} flex-1`} />
          </label>
        ) : (
          <input aria-label={t('mobile.tasks.scheduleCron')} value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} placeholder={t('mobile.tasks.cronPlaceholder')} className={inputClass} />
        )}
        {validation ? <p role="alert" className="twin-notice twin-notice-error">{validation}</p> : null}
        {(task ? screen.errorFor(task.id) : screen.createError) ? (
          <p role="alert" className="twin-notice twin-notice-error">{task ? screen.errorFor(task.id) : screen.createError}</p>
        ) : null}
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="twin-button twin-button-secondary flex-1">
            {t('mobile.tasks.cancel')}
          </button>
          <button type="button" onClick={() => void submit()} disabled={saving} className="twin-button twin-button-primary flex-1">
            {t('mobile.tasks.save')}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function ScheduledRunHistory({ screen }: { screen: TaskScreen }): JSX.Element {
  if (screen.allRunsLoading && screen.allRuns.length === 0) {
    return <p className="py-4 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p>;
  }
  return (
    <div data-testid="scheduled-run-history">
      {screen.allRunsError ? (
        <div role="alert" className="twin-notice twin-notice-error mb-3">
          <p>{screen.allRunsError}</p>
          <button type="button" className="min-h-[44px]" onClick={() => void screen.loadAllRuns()}>{t('mobile.tasks.retry')}</button>
        </div>
      ) : null}
      {!screen.allRunsLoading && screen.allRuns.length === 0 ? (
        <p className="py-4 text-sm text-[var(--text-secondary)]">{t('mobile.tasks.noRuns')}</p>
      ) : null}
      <div className="twin-unified-history-list">
        {screen.allRuns.map((run) => {
          const taskName = run.taskName ?? screen.tasks.find((task) => task.id === run.taskId)?.name ?? run.taskId;
          return (
            <article key={run.id} className="twin-unified-history-row" data-testid={`scheduled-history-run-${run.id}`}>
              <h3>{taskName}</h3>
              <p>
                {new Date(run.startedAt).toLocaleString()} · {t(`mobile.tasks.runStatus.${run.status}`)}
                {run.durationMs !== null && run.durationMs !== undefined ? ` · ${formatDurationMs(run.durationMs)}ms` : ''}
              </p>
              {run.error ? <p className="text-[var(--twin-danger)]">{run.error}</p> : null}
              {run.skipReason ? <p>{t(`mobile.tasks.skipReason.${run.skipReason}`)}</p> : null}
              {screen.errorFor(run.taskId) ? <p role="alert" className="text-[var(--twin-danger)]">{screen.errorFor(run.taskId)}</p> : null}
              <button
                type="button"
                className="twin-button twin-button-secondary twin-button-small mt-2"
                disabled={!run.sessionId}
                onClick={() => void screen.openRun(run)}
                aria-label={`${t('mobile.activity.openResult')} · ${run.id}`}
              >
                {t('mobile.activity.openResult')}
              </button>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export default function TasksScreen({
  resyncCounter = 0,
  twinMetabotId,
  twinName,
  onOpenSession,
  onOpenDraft = () => undefined,
  onOpenUri = () => undefined,
  onOpenSubscribe,
  onAttentionCount = () => undefined,
  notificationUnreadCount = 0,
  onOpenNotifications,
  requestedTaskId,
  requestedScheduledRun,
}: {
  resyncCounter?: number;
  twinMetabotId: number | null;
  twinName: string;
  onOpenSession: OpenWorkSession;
  onOpenDraft?: (draft: string) => void;
  onOpenUri?: (uri: string) => void;
  onOpenSubscribe?: () => void;
  onAttentionCount?: (count: number) => void;
  notificationUnreadCount?: number;
  onOpenNotifications?: () => void;
  requestedTaskId?: string;
  requestedScheduledRun?: { taskId: string; runId: string };
}): JSX.Element {
  const me = useMeStore();
  const trialExpired = isMeExpiredInviteTrial(me.subscription);
  const [primaryTab, setPrimaryTab] = useState<PrimaryTaskTab>(readPrimaryTaskTab);
  const [scheduledSubTab, setScheduledSubTab] = useState<'schedules' | 'history'>('schedules');
  const [activityRevision, setActivityRevision] = useState(0);
  const refreshActivity = useCallback(() => setActivityRevision((revision) => revision + 1), []);
  const screen = useScheduledTasks({ twinMetabotId, onOpenSession, resyncCounter, onChanged: refreshActivity });
  const unified = useUnifiedTasks({ resyncCounter: resyncCounter + activityRevision, onOpenSession });
  const [formOpen, setFormOpen] = useState(false);
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const deepLinkHandledRef = useRef('');
  const attentionCount = unified.cards.filter((card) => card.column === 'waiting_owner' && card.stage !== 'done' && card.stage !== 'cancelled').length;

  useEffect(() => {
    if (!requestedTaskId) return;
    setPrimaryTab('tasks');
    unified.openDetail(requestedTaskId);
  }, [requestedTaskId, unified.openDetail]);

  useEffect(() => {
    const request = requestedScheduledRun;
    if (!request) return;
    setPrimaryTab('scheduled');
    setScheduledSubTab('history');
    const run = screen.allRuns.find((entry) => entry.id === request.runId && entry.taskId === request.taskId);
    if (!run) return;
    const key = `${request.taskId}:${request.runId}`;
    if (deepLinkHandledRef.current === key) return;
    deepLinkHandledRef.current = key;
    void screen.openRun(run);
  }, [requestedScheduledRun, screen.allRuns, screen.openRun]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PRIMARY_TASK_TAB_KEY, primaryTab);
    } catch {
      return;
    }
  }, [primaryTab]);

  useEffect(() => {
    onAttentionCount(attentionCount);
  }, [attentionCount, onAttentionCount]);

  const deleteTask = async (): Promise<void> => {
    if (!deleteTarget) return;
    if (await screen.deleteTask(deleteTarget.id)) setDeleteTarget(null);
  };
  const openScheduleForm = () => {
    setEditTask(null);
    setFormOpen(true);
  };

  if (primaryTab === 'tasks' && unified.selectedTaskId) {
    return <UnifiedTaskDetail screen={unified} onOpenDraft={onOpenDraft} onOpenUri={onOpenUri} />;
  }

  return (
    <div className="twin-page">
      <div className="twin-topbar twin-topbar-simple">
        <div>
          <h1 className="twin-title">{t(primaryTab === 'tasks' ? 'mobile.taskCenter.title' : 'mobile.tasks.title')}</h1>
          <p className="twin-subtitle">
            {primaryTab === 'tasks'
              ? t('mobile.taskCenter.subtitle', { count: unified.cards.filter((card) => card.column === 'in_progress').length })
              : t('mobile.taskCenter.scheduledSubtitle')}
          </p>
        </div>
        <div className="flex items-center">
          {onOpenNotifications ? <NotificationBell count={notificationUnreadCount ?? 0} onClick={onOpenNotifications} /> : null}
          <button
            type="button"
            disabled={trialExpired}
            onClick={primaryTab === 'tasks' ? () => onOpenDraft(t('mobile.taskCenter.newTaskDraft')) : openScheduleForm}
            className="twin-icon-button twin-icon-button-primary disabled:opacity-40"
            aria-label={t(primaryTab === 'tasks' ? 'mobile.taskCenter.newTask' : 'mobile.tasks.create')}
            data-testid="task-center-create"
          >
            <PlusIcon aria-hidden />
          </button>
        </div>
      </div>
      <div className="twin-unified-primary-tabs" role="tablist" aria-label={t('mobile.taskCenter.primaryTabs')}>
        <button type="button" role="tab" aria-selected={primaryTab === 'tasks'} onClick={() => setPrimaryTab('tasks')}>
          {t('mobile.taskCenter.tasksTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={primaryTab === 'scheduled'}
          onClick={() => { setPrimaryTab('scheduled'); unified.closeDetail(); }}
        >
          {t('mobile.taskCenter.scheduledTab')}
        </button>
      </div>
      {trialExpired ? (
        <div
          data-testid="tasks-trial-expired-bar"
          className="mx-3 mt-2.5 flex items-center justify-between gap-3 rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3.5 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-bold text-[var(--text-primary)]">{t('mobile.trial.expiredTitle')}</p>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{t('mobile.trial.expiredTasksSub')}</p>
          </div>
          {onOpenSubscribe ? (
            <button
              type="button"
              data-testid="tasks-trial-subscribe-cta"
              onClick={onOpenSubscribe}
              className="twin-button twin-button-primary twin-button-small shrink-0 rounded-full px-3.5"
            >
              {t('mobile.trial.subscribeCta')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="twin-scroll p-3">
        {primaryTab === 'tasks' ? <UnifiedTasksSection screen={unified} /> : (
          <>
            <div className="twin-unified-schedule-tools">
              <div className="twin-unified-schedule-tabs" role="tablist" aria-label={t('mobile.taskCenter.scheduledViews')}>
                <button type="button" role="tab" aria-selected={scheduledSubTab === 'schedules'} onClick={() => setScheduledSubTab('schedules')}>
                  {t('mobile.taskCenter.schedules')}
                </button>
                <button type="button" role="tab" aria-selected={scheduledSubTab === 'history'} onClick={() => setScheduledSubTab('history')}>
                  {t('mobile.taskCenter.history')}
                </button>
              </div>
              <button
                type="button"
                disabled={trialExpired}
                className="twin-button twin-button-primary twin-button-small disabled:opacity-40"
                onClick={openScheduleForm}
              >
                {t('mobile.tasks.create')}
              </button>
            </div>
            {scheduledSubTab === 'history' ? <ScheduledRunHistory screen={screen} /> : (
              <Section title={t('mobile.tasks.title')}>
                {screen.loadError ? (
                  <div role="alert" className="py-2 text-sm text-red-600">
                    <p>{screen.loadError}</p>
                    <button type="button" className="min-h-[44px]" onClick={() => void screen.reload()}>{t('mobile.tasks.retry')}</button>
                  </div>
                ) : null}
                {!screen.loading && screen.tasks.length === 0 ? <p className="py-4 text-sm text-[var(--text-secondary)]">{t('mobile.tasks.empty')}</p> : null}
                {screen.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    screen={screen}
                    trialExpired={trialExpired}
                    onEdit={() => { setEditTask(task); setFormOpen(true); }}
                    onDelete={() => setDeleteTarget(task)}
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
      <TaskFormSheet
        screen={screen}
        task={editTask}
        twinName={twinName}
        twinAvailable={twinMetabotId !== null}
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditTask(null); }}
      />
      {deleteTarget ? (
        <BottomSheet title={t('mobile.tasks.deleteTitle')} onClose={() => setDeleteTarget(null)}>
          <p className="text-sm text-[var(--text-primary)]">{t('mobile.tasks.deleteBody', { name: deleteTarget.name })}</p>
          {screen.errorFor(deleteTarget.id) ? <p role="alert" className="mt-2 text-sm text-red-600">{screen.errorFor(deleteTarget.id)}</p> : null}
          <div className="mt-4 flex gap-3">
            <button type="button" onClick={() => setDeleteTarget(null)} className="twin-button twin-button-secondary flex-1">{t('mobile.tasks.cancel')}</button>
            <button type="button" disabled={screen.pendingFor(deleteTarget.id) !== null} onClick={() => void deleteTask()} className="twin-button twin-button-danger flex-1">
              {t('mobile.tasks.deleteConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}
