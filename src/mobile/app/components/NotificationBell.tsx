import { BellIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';

export function NotificationBell({ count, onClick }: { count: number; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="twin-icon-button twin-notification-button"
      aria-label={t('mobile.notifications.bellLabel', { count })}
      data-testid="notification-bell"
    >
      <BellIcon aria-hidden />
      {count > 0 ? <span className="twin-notification-badge" aria-hidden>{Math.min(99, count)}</span> : null}
    </button>
  );
}
