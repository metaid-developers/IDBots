import { useState } from 'react';
import { t } from '../../i18n';
import { useWorkActivity, type OpenWorkSession } from '../hooks/useWorkActivity';
import type { WorkActivity } from '../activity';
import { BottomSheet } from './BottomSheet';
import { Section } from './Section';

function ActivityCard({
  activity,
  busy,
  onOpen,
  onStage,
  onCancel,
}: {
  activity: WorkActivity;
  busy: boolean;
  onOpen: () => void;
  onStage: (action: 'pause' | 'resume' | 'cancel') => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <article
      className="border-b border-[var(--border-color)] py-3 last:border-b-0"
      data-testid={`activity-${activity.kind}-${activity.kind === 'longterm' ? activity.taskId : activity.runId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-[var(--text-secondary)]">{t(`mobile.activity.${activity.kind}`)}</p>
          <h3 className="break-words text-[15px] font-medium text-[var(--text-primary)]">{activity.title}</h3>
        </div>
        <span className="shrink-0 text-xs text-[var(--text-secondary)]">{t(`mobile.activity.status.${activity.status}`)}</span>
      </div>
      {activity.participants.length ? (
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          {t('mobile.activity.participants', { names: activity.participants.join(', ') })}
        </p>
      ) : null}
      {activity.currentSubtaskTitle ? (
        <p className="mt-2 text-sm text-[var(--text-primary)]">
          {t('mobile.activity.currentSubtask', { title: activity.currentSubtaskTitle })}
        </p>
      ) : null}
      {activity.progress ? (
        <div className="mt-2">
          <progress
            className="h-1.5 w-full accent-[var(--color-primary)]"
            max={100}
            value={activity.progress.percent}
            aria-label={t('mobile.activity.progressLabel')}
          />
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {t('mobile.activity.progress', activity.progress)}
          </p>
        </div>
      ) : null}
      {activity.waitingReason ? (
        <p className="mt-2 text-sm text-amber-700">{t('mobile.activity.waitingReason', { reason: activity.waitingReason })}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onOpen}
          aria-label={`${t('mobile.activity.openResult')} · ${activity.title} · ${activity.runId ?? activity.taskId}`}
          className="twin-button twin-button-secondary twin-button-small"
        >
          {t('mobile.activity.openResult')}
        </button>
        {activity.kind === 'longterm' && (activity.stage === 'active' || activity.stage === 'defining') ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStage('pause')}
            aria-label={`${t('mobile.activity.pause')} · ${activity.title}`}
            className="twin-button twin-button-secondary twin-button-small"
          >
            {t('mobile.activity.pause')}
          </button>
        ) : null}
        {activity.kind === 'longterm' && activity.stage === 'paused' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStage('resume')}
            aria-label={`${t('mobile.activity.resume')} · ${activity.title}`}
            className="twin-button twin-button-secondary twin-button-small"
          >
            {t('mobile.activity.resume')}
          </button>
        ) : null}
        {activity.kind === 'longterm' && activity.stage !== 'done' && activity.stage !== 'cancelled' ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label={`${t('mobile.activity.cancel')} · ${activity.title}`}
            className="twin-button twin-button-danger-secondary twin-button-small"
          >
            {t('mobile.activity.cancel')}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function ActivitySection({
  resyncCounter = 0,
  onOpenSession,
}: {
  resyncCounter?: number;
  onOpenSession: OpenWorkSession;
}): JSX.Element {
  const activity = useWorkActivity(resyncCounter);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WorkActivity | null>(null);

  const open = async (item: WorkActivity): Promise<void> => {
    setBusyId(item.id);
    try {
      await activity.openActivity(item, onOpenSession);
    } finally {
      setBusyId(null);
    }
  };

  const setStage = async (item: WorkActivity, action: 'pause' | 'resume' | 'cancel'): Promise<void> => {
    setBusyId(item.id);
    try {
      await activity.setStage(item.taskId, action);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Section title={t('mobile.activity.title')}>
        <div data-testid="work-activity">
          {activity.error ? <p role="alert" className="py-2 text-sm text-red-600">{activity.error}</p> : null}
          {activity.longTermError ? <p role="alert" className="py-2 text-sm text-amber-700">{activity.longTermError}</p> : null}
          {!activity.loading && activity.activities.length === 0 ? (
            <p className="py-4 text-sm text-[var(--text-secondary)]">{t('mobile.activity.empty')}</p>
          ) : null}
          {activity.activities.map((item) => (
            <ActivityCard
              key={item.id}
              activity={item}
              busy={busyId !== null}
              onOpen={() => void open(item)}
              onStage={(action) => void setStage(item, action)}
              onCancel={() => setCancelTarget(item)}
            />
          ))}
        </div>
      </Section>
      {cancelTarget ? (
        <BottomSheet title={t('mobile.activity.cancelTitle')} onClose={() => setCancelTarget(null)}>
          <p className="text-sm text-[var(--text-primary)]">{t('mobile.activity.cancelBody', { name: cancelTarget.title })}</p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => setCancelTarget(null)}
              className="twin-button twin-button-secondary flex-1"
            >
              {t('mobile.tasks.cancel')}
            </button>
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => {
                const target = cancelTarget;
                setCancelTarget(null);
                void setStage(target, 'cancel');
              }}
              className="twin-button twin-button-danger flex-1"
            >
              {t('mobile.activity.cancelConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
    </>
  );
}
