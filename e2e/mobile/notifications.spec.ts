import { test, expect, expectAppShell } from './fixtures';

test.describe('notification center and deep links', () => {
  test('bell opens the unread inbox and a result opens its existing session', async ({ page }) => {
    await page.goto('/app/');
    await expectAppShell(page);
    await expect(page.getByTestId('notification-bell')).toContainText('1');

    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notifications-page')).toBeVisible();
    await expect(page.getByTestId('notification-mock-work-complete')).toBeVisible();
    await page.getByTestId('notification-mock-work-complete').click();

    await expect(page.getByTestId('chat-header-title')).toHaveText('Long-term document result');
    expect(page.url()).toContain('/app/sessions/mock-session-1');
  });

  test('a direct notification URL resolves the event and opens its target', async ({ page }) => {
    await page.goto('/app/notifications/mock-work-complete');
    await expect(page.getByTestId('chat-header-title')).toHaveText('Long-term document result');
    expect(page.url()).toContain('/app/sessions/mock-session-1');
  });

  test('PWA presents an honest push capability without asking for permission', async ({ page }) => {
    await page.goto('/app/notifications');
    await page.getByTestId('push-settings-toggle').click();
    await expect(page.getByText('System push requires the Android app. Completed work remains available in this notification center.')).toBeVisible();
    await expect(page.getByTestId('push-enable')).toHaveCount(0);
  });

  test('a native notification tap resolves the authoritative event and opens its session', async ({ page }) => {
    await page.addInitScript(() => {
      const target = window as unknown as {
        Capacitor: { isNativePlatform: () => boolean };
        idbotsNative: Record<string, unknown>;
        nativePushTap?: (eventId: string) => void;
      };
      target.Capacitor = { isNativePlatform: () => true };
      target.idbotsNative = {
        nativeBridgeVersion: 1,
        bootstrap: { phase: 'document-start', origin: window.location.origin, platform: 'ios' },
        getCapabilities: () => ({
          camera: false, photos: false, files: false, share: false, appState: false,
          backButton: false, externalUrls: false, secureScreen: false, pushNotifications: true,
        }),
        getPushPermission: async () => 'denied',
        onPushNotificationOpen: (callback: (eventId: string) => void) => {
          target.nativePushTap = callback;
          return () => undefined;
        },
      };
    });
    await page.goto('/app/');
    await expectAppShell(page);
    await page.evaluate(() => {
      (window as unknown as { nativePushTap: (eventId: string) => void }).nativePushTap('mock-work-complete');
    });
    await expect(page.getByTestId('chat-header-title')).toHaveText('Long-term document result');
    expect(page.url()).toContain('/app/sessions/mock-session-1');
  });

  test('Me exposes notifications and mark-all-read reconciles the badge', async ({ page }) => {
    await page.goto('/app/');
    await page.getByTestId('mobile-tab-me').click();
    await page.getByTestId('me-entry-notifications').click();
    await expect(page.getByTestId('notifications-page')).toBeVisible();
    await expect(page.getByTestId('notification-mock-work-complete')).toBeVisible();

    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByText('You are all caught up.')).toBeVisible();
    await page.getByTestId('notification-filter-all').click();
    await expect(page.getByTestId('notification-mock-permission-resolved')).toHaveAttribute('data-read', 'true');
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-entry-notifications')).not.toContainText('unread');
  });
});
