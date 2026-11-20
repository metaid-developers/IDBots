import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { getPushNotificationCoordinator, type NotificationCategoryPreference, type PushNotificationCoordinator, type PushSettingsSnapshot } from '../../native/pushNotifications';

const CATEGORIES: NotificationCategoryPreference[] = ['work', 'action', 'report', 'system'];

export function PushNotificationSettings(): JSX.Element {
  const coordinator = useRef<PushNotificationCoordinator | null>(null);
  if (!coordinator.current) coordinator.current = getPushNotificationCoordinator();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PushSettingsSnapshot>(coordinator.current.state());
  const [busy, setBusy] = useState(false);

  const run = async (operation: () => Promise<PushSettingsSnapshot>) => {
    setBusy(true);
    try {
      setSnapshot(await operation());
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run(() => coordinator.current!.load());
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const current = coordinator.current!;
    void run(() => current.load());
    return undefined;
  }, [open]);

  return (
    <section className="twin-panel twin-panel-padded" data-testid="push-notification-settings">
      <button
        type="button"
        className="flex min-h-[44px] w-full items-center justify-between gap-3 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-testid="push-settings-toggle"
      >
        <span className="twin-list-title">{t('mobile.notifications.pushSettings')}</span>
        <span aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-3 border-t border-[var(--border-color)] pt-3">
          {!snapshot.available ? <p className="text-sm text-[var(--text-secondary)]">{t('mobile.notifications.pushWebUnavailable')}</p> : (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={snapshot.preferences.enabled && snapshot.registered}
                className="twin-list-row"
                disabled={busy}
                onClick={() => void run(() => coordinator.current!.update({ enabled: !snapshot.preferences.enabled }))}
                data-testid="push-master-switch"
              >
                <span>{t('mobile.notifications.pushMaster')}</span>
                <span>{snapshot.preferences.enabled && snapshot.registered ? '✓' : '—'}</span>
              </button>
              {snapshot.provider === 'disabled' ? <p className="text-sm text-[var(--text-secondary)]">{t('mobile.notifications.pushProviderDisabled')}</p> : null}
              {snapshot.permission === 'denied' ? (
                <button type="button" className="twin-button twin-button-secondary twin-button-full" disabled={busy} onClick={() => void run(() => coordinator.current!.openSystemSettings())}>
                  {t('mobile.notifications.pushOpenSettings')}
                </button>
              ) : null}
              {snapshot.permission === 'prompt' || (snapshot.permission === 'granted' && !snapshot.registered) ? (
                <button type="button" className="twin-button twin-button-primary twin-button-full" disabled={busy} onClick={() => void run(() => coordinator.current!.enable())} data-testid="push-enable">
                  {t('mobile.notifications.pushEnable')}
                </button>
              ) : null}
              {snapshot.registered ? <p className="text-sm text-[var(--text-secondary)]">{t('mobile.notifications.pushRegistered')}</p> : null}
              {CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  role="switch"
                  aria-checked={snapshot.preferences[category]}
                  className="flex min-h-[44px] w-full items-center justify-between gap-3 text-left text-sm"
                  disabled={busy || !snapshot.preferences.enabled}
                  onClick={() => void run(() => coordinator.current!.update({ [category]: !snapshot.preferences[category] }))}
                  data-testid={`push-category-${category}`}
                >
                  <span>{t(`mobile.notifications.category.${category}`)}</span>
                  <span>{snapshot.preferences[category] ? '✓' : '—'}</span>
                </button>
              ))}
            </>
          )}
          {snapshot.error ? <p role="alert" className="text-sm text-[var(--twin-danger)]">{t('mobile.notifications.pushUnavailable')}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
