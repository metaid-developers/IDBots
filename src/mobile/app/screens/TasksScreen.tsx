import { useCallback, useEffect, useState } from 'react';
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
import { ActivitySection } from '../components/ActivitySection';

type ScheduleKind = 'interval' | 'daily' | 'cron';
type TaskScreen = ReturnType<typeof useScheduledTasks>;

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
  onEdit,
  onDelete,
}: {
  task: ScheduledTask;
  screen: TaskScreen;
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
          disabled={pending !== null}
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

export default function TasksScreen({
  resyncCounter = 0,
  twinMetabotId,
  twinName,
  onOpenSession,
}: {
  resyncCounter?: number;
  twinMetabotId: number | null;
  twinName: string;
  onOpenSession: OpenWorkSession;
}): JSX.Element {
  const [activityRevision, setActivityRevision] = useState(0);
  const refreshActivity = useCallback(() => setActivityRevision((revision) => revision + 1), []);
  const screen = useScheduledTasks({ twinMetabotId, onOpenSession, resyncCounter, onChanged: refreshActivity });
  const [formOpen, setFormOpen] = useState(false);
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);

  const deleteTask = async (): Promise<void> => {
    if (!deleteTarget) return;
    if (await screen.deleteTask(deleteTarget.id)) setDeleteTarget(null);
  };

  return (
    <div className="twin-page">
      <div className="twin-topbar twin-topbar-simple">
        <h1 className="twin-title">{t('mobile.tasks.title')}</h1>
        <button type="button" onClick={() => { setEditTask(null); setFormOpen(true); }} className="twin-button twin-button-ghost">
          <PlusIcon className="h-5 w-5" aria-hidden />
          {t('mobile.tasks.create')}
        </button>
      </div>
      <div className="twin-scroll p-3">
        <ActivitySection resyncCounter={resyncCounter + activityRevision} onOpenSession={onOpenSession} />
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
              onEdit={() => { setEditTask(task); setFormOpen(true); }}
              onDelete={() => setDeleteTarget(task)}
            />
          ))}
        </Section>
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
