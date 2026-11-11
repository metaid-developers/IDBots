import { test, expect, attachScreen, expectAppShell } from './fixtures';

/**
 * App shell (REQ-E-11): the three tabs mount from the lazy chunks and the
 * connection banner reflects the mock bridge's simulated reconnect.
 */

test.describe('app shell', () => {
  test('tabs mount and switch', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await expectAppShell(page);

    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(page.getByText('Scheduled tasks').first()).toBeVisible();
    await attachScreen(testInfo, page, 'shell-tasks-tab');

    await page.getByTestId('mobile-tab-me').click();
    await expect(page.getByText('Balance')).toBeVisible();
    await attachScreen(testInfo, page, 'shell-me-tab');

    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await attachScreen(testInfo, page, 'shell-chat-tab');
  });

  test('offline banner follows simulateReconnect', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await expectAppShell(page);

    const banner = page.locator('[data-connection-state]');
    await expect(banner).toHaveAttribute('data-connection-state', 'online');

    await page.evaluate(() => {
      (window as unknown as { idbotsMobile: { mock?: { simulateReconnect: () => void } } }).idbotsMobile.mock?.simulateReconnect();
    });
    await expect(banner).toHaveAttribute('data-connection-state', 'reconnecting');
    await expect(page.getByText('Reconnecting…')).toBeVisible();
    await attachScreen(testInfo, page, 'shell-reconnecting-banner');

    await expect(banner).toHaveAttribute('data-connection-state', 'online', { timeout: 15_000 });
    await attachScreen(testInfo, page, 'shell-back-online');
  });

  test('restores the active tab and unsent draft after reload', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(page.getByText('Scheduled tasks').first()).toBeVisible();
    await page.reload();
    await expect(page.getByText('Scheduled tasks').first()).toBeVisible();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Sessions' }).click();
    // A3 rework: "New chat" opens the Bot picker first — a conversation
    // starts FOR a specific MetaBot (avatar visible in the picker).
    await page.getByTestId('session-new-chat').click();
    const picker = page.getByTestId('bot-picker-list');
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId(/bot-picker-avatar-/).first()).toBeVisible();
    await picker.getByRole('button').first().click();
    await expect(picker).toBeHidden();
    await page.getByPlaceholder('Type a message…').fill('unsent recovery draft');
    await page.reload();
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('unsent recovery draft');
  });
});
