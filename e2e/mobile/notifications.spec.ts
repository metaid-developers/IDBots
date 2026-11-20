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
