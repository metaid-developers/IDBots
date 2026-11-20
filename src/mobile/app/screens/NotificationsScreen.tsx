import type { AgentNotification } from '@/types/notification';
import { t } from '../../i18n';
import { useNotifications } from '../hooks/useNotifications';
import type { NotificationFilter } from '../hooks/useNotifications';
import { SecondaryPageShell } from './me/SecondaryPageShell';

const FILTERS: NotificationFilter[] = ['unread', 'all', 'work', 'action', 'report', 'system'];

function NotificationRow({ item, onOpen }: { item: AgentNotification; onOpen: (item: AgentNotification) => void }): JSX.Element {
  const unread = item.readAt === null;
  return (
    <button
      type="button"
      className="twin-list-row w-full text-left"
      onClick={() => onOpen(item)}
      data-testid={`notification-${item.eventId}`}
      data-read={!unread}
    >
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${unread ? 'bg-[var(--twin-accent)]' : 'bg-transparent'}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="twin-list-title">{item.title}</span>
          <span className="twin-list-value">{t(`mobile.notifications.category.${item.category}`)}</span>
        </span>
        <span className="twin-list-subtitle">{item.body}</span>
        <span className="twin-list-subtitle">{new Date(item.createdAt).toLocaleString()}</span>
      </span>
    </button>
  );
}

export default function NotificationsScreen({
  resyncCounter = 0,
  onBack,
  onOpenNotification,
}: {
  resyncCounter?: number;
  onBack: () => void;
  onOpenNotification: (item: AgentNotification) => Promise<boolean>;
}): JSX.Element {
  const controller = useNotifications(resyncCounter);
  const open = async (item: AgentNotification) => {
    if (item.readAt === null) await controller.markRead(item.eventId);
    await onOpenNotification(item);
  };

  return (
    <SecondaryPageShell
      title={t('mobile.notifications.title')}
      onBack={onBack}
      testId="notifications-page"
      action={controller.unreadCount > 0 ? (
        <button type="button" className="twin-button twin-button-ghost twin-button-small" onClick={() => void controller.markAllRead()}>
          {t('mobile.notifications.markAllRead')}
        </button>
      ) : null}
    >
      <p className="px-1 text-xs text-[var(--text-secondary)]">{t('mobile.notifications.subtitle', { count: controller.unreadCount })}</p>
      <div className="twin-chip-row" role="tablist" aria-label={t('mobile.notifications.filters')}>
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            role="tab"
            aria-selected={controller.filter === filter}
            className="twin-chip"
            onClick={() => controller.setFilter(filter)}
            data-testid={`notification-filter-${filter}`}
          >
            {t(`mobile.notifications.filter.${filter}`)}
          </button>
        ))}
      </div>
      {controller.error ? (
        <div role="alert" className="twin-notice twin-notice-error">
          <p>{controller.error}</p>
          <button type="button" className="min-h-[44px]" onClick={() => void controller.reload()}>{t('mobile.common.retry')}</button>
        </div>
      ) : null}
      {controller.loading && controller.items.length === 0 ? <p className="py-6 text-center text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      {!controller.loading && controller.visibleItems.length === 0 ? (
        <div className="twin-empty py-12">
          <p className="twin-empty-title">{t('mobile.notifications.emptyTitle')}</p>
          <p className="twin-empty-copy">{t(controller.filter === 'unread' ? 'mobile.notifications.emptyUnread' : 'mobile.notifications.emptyCategory')}</p>
        </div>
      ) : null}
      <div className="twin-list" data-testid="notification-list">
        {controller.visibleItems.map((item) => <NotificationRow key={item.eventId} item={item} onOpen={open} />)}
      </div>
    </SecondaryPageShell>
  );
}
