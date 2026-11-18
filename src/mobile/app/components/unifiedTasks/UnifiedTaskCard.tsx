import { ChatBubbleLeftRightIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import type { LongTermParticipant, LongTermTaskSummary } from '@/types/longTermTask';
import { t } from '../../../i18n';
import { formatUnifiedTaskTime, unifiedTaskNextAction } from '../../unifiedTaskPresentation';
import { BotAvatar } from '../BotAvatar';

function Participants({ participants, taskId }: { participants: LongTermParticipant[]; taskId: string }): JSX.Element | null {
  if (participants.length === 0) return null;
  const visible = participants.slice(0, 4);
  return (
    <div className="twin-unified-participants" aria-label={t('mobile.taskCenter.participants')}>
      <span className="twin-unified-avatars">
        {visible.map((participant) => (
          <BotAvatar
            key={participant.id}
            name={participant.name}
            avatar={participant.avatar}
            size={26}
            testId={`task-participant-${taskId}-${participant.id}`}
          />
        ))}
      </span>
      <span className="twin-unified-participant-names">
        {visible.map((participant) => participant.name).join(', ')}
        {participants.length > visible.length ? ` +${participants.length - visible.length}` : ''}
      </span>
    </div>
  );
}

export function UnifiedTaskCard({
  card,
  featured,
  indented,
  busy,
  onOpenDetails,
  onOpenChat,
}: {
  card: LongTermTaskSummary;
  featured: boolean;
  indented: boolean;
  busy: boolean;
  onOpenDetails: () => void;
  onOpenChat: () => void;
}): JSX.Element {
  const active = card.counts.in_progress + card.counts.waiting_owner + card.counts.waiting_external;
  return (
    <article
      className={`twin-unified-card ${featured ? 'twin-unified-card-featured' : ''} ${indented ? 'twin-unified-card-child' : ''}`}
      data-testid={`unified-task-${card.id}`}
      data-task-status={card.column}
    >
      <div className="twin-unified-card-head">
        <span className={`twin-task-status twin-task-status-${card.column}`}>
          <span className="twin-task-status-dot" aria-hidden />
          {t(`mobile.taskCenter.status.${card.column}`)}
        </span>
        <span className="twin-unified-updated">{formatUnifiedTaskTime(card.updatedAt)}</span>
      </div>
      {card.parentTaskId && !indented && card.parentTaskTitle ? (
        <p className="twin-unified-parent">{t('mobile.taskCenter.parent', { title: card.parentTaskTitle })}</p>
      ) : null}
      <button
        type="button"
        className="twin-unified-title"
        onClick={onOpenDetails}
        data-testid={`task-title-${card.id}`}
      >
        {card.title}
      </button>
      <Participants participants={card.participants} taskId={card.id} />
      <div className="twin-unified-progress-row">
        <progress
          className="twin-unified-progress"
          max={100}
          value={card.progress.percent}
          aria-label={t('mobile.taskCenter.progressLabel')}
        />
        <span>{card.progress.accepted}/{card.progress.total} · {card.progress.percent}%</span>
      </div>
      <div className="twin-unified-counts">
        <span>{t('mobile.taskCenter.counts.accepted', { count: card.progress.accepted })}</span>
        <span>{t('mobile.taskCenter.counts.active', { count: active })}</span>
        <span>{t('mobile.taskCenter.counts.pending', { count: card.counts.pending })}</span>
      </div>
      {card.currentSubtaskTitle ? (
        <div className="twin-current-step">
          <p className="twin-current-step-label">{t('mobile.taskCenter.currentStep')}</p>
          <p className="twin-current-step-title">{card.currentSubtaskTitle}</p>
          {card.currentProgressNote && card.currentSubtaskStatus === 'in_progress' ? (
            <p className="twin-current-step-live">{card.currentProgressNote}</p>
          ) : null}
          <p className={`twin-current-step-next ${card.column === 'waiting_owner' ? 'twin-current-step-waiting' : ''}`}>
            <strong>{t('mobile.taskCenter.nextPrefix')}</strong> {unifiedTaskNextAction(card)}
          </p>
        </div>
      ) : null}
      <div className="twin-unified-card-footer">
        <span>{t('mobile.taskCenter.created', { time: new Date(card.createdAt).toLocaleDateString() })}</span>
      </div>
      <div className="twin-unified-card-actions">
        <button
          type="button"
          className="twin-button twin-button-primary"
          disabled={busy}
          onClick={onOpenChat}
          aria-label={`${t('mobile.taskCenter.openChat')} · ${card.title}`}
          data-testid={`task-open-chat-${card.id}`}
        >
          <ChatBubbleLeftRightIcon className="h-[18px] w-[18px]" aria-hidden />
          {t('mobile.taskCenter.openChat')}
        </button>
        <button
          type="button"
          className="twin-button twin-button-secondary"
          disabled={busy}
          onClick={onOpenDetails}
          aria-label={`${t('mobile.taskCenter.details')} · ${card.title}`}
          data-testid={`task-details-${card.id}`}
        >
          {t('mobile.taskCenter.details')}
          <ChevronRightIcon className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </div>
    </article>
  );
}
