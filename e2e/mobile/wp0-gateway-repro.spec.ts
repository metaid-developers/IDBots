import { test, expect, startNewChatViaPicker } from './fixtures';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);
const RECOVERY_READY_TIMEOUT_MS = 5_000;

test.describe('WP1 gateway regressions', () => {
  test.skip(!isGatewayRun, 'requires the real gateway harness');

  test('running session is restored after full reload @gateway', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Sessions' }).click();
    await startNewChatViaPicker(page);
    await page.getByPlaceholder('Type a message…').fill('restore this running session');
    await page.getByTestId('chat-composer-input').press('Enter');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'restore this running session' })).toBeVisible({ timeout: RECOVERY_READY_TIMEOUT_MS });
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: RECOVERY_READY_TIMEOUT_MS });
    await expect(page.getByTestId('turn-phase')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('This reply streamed over a real C2 gateway socket.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('工作目录', { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test('active tab and unsent draft survive a real-gateway reload @gateway', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(page.getByText('Scheduled tasks').first()).toBeVisible();
    await page.reload();
    await expect(page.getByText('Scheduled tasks').first()).toBeVisible();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Sessions' }).click();
    await startNewChatViaPicker(page);
    await page.getByPlaceholder('Type a message…').fill('unsent gateway draft');
    await page.reload();
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('unsent gateway draft');
  });

});
