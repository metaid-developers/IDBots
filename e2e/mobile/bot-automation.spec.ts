import { test, expect } from './fixtures';

async function openAutomation(page: import('@playwright/test').Page, botId = 1): Promise<void> {
  await page.goto('/app/');
  await page.getByRole('button', { name: 'Me', exact: true }).click();
  await page.getByTestId('me-entry-bots').click();
  await page.getByTestId(`bot-row-${botId}`).click();
  await page.getByTestId('bot-tab-automation').click();
  await expect(page.getByTestId('bot-automation-page')).toBeVisible();
}

test.describe('Bot automation parity', () => {
  test('settings persist after reload and a daily report opens its real session', async ({ page }) => {
    await openAutomation(page);
    await expect(page.getByRole('switch', { name: 'Allow experimental automation' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Surf before dreaming' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Enable daily report' })).toHaveAttribute('aria-checked', 'false');

    await page.getByLabel('Creations per run').fill('7');
    await page.getByLabel('Interactions per run').click();
    await page.getByLabel('Creation mode').selectOption('off');
    await page.getByLabel('Report time').selectOption('9');
    await page.getByRole('switch', { name: 'Enable daily report' }).click();
    await expect(page.getByRole('switch', { name: 'Enable daily report' })).toHaveAttribute('aria-checked', 'true');

    await page.reload();
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-entry-bots').click();
    await page.getByTestId('bot-row-1').click();
    await page.getByTestId('bot-tab-automation').click();
    await expect(page.getByLabel('Creations per run')).toHaveValue('7');
    await expect(page.getByLabel('Creation mode')).toHaveValue('off');
    await expect(page.getByLabel('Report time')).toHaveValue('9');
    await expect(page.getByRole('switch', { name: 'Enable daily report' })).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('bot-daily-run-now').click();
    await expect(page.getByTestId('chat-header-title')).toContainText('Daily report');
    await expect(page.getByText('Daily briefing: tasks completed, one decision needs review.')).toBeVisible();
  });

  test('Surf starts once and publishes a readable completion report', async ({ page }) => {
    await openAutomation(page);
    await page.getByTestId('bot-surf-run-now').click();
    await expect(page.getByTestId('bot-surf-run-now')).toBeDisabled();
    await expect(page.getByTestId('surf-run-mock-surf-2')).toBeVisible();
    await expect(page.getByTestId('surf-run-mock-surf-2')).toContainText('Completed');
    await page.getByTestId('surf-run-mock-surf-2').click();
    await expect(page.getByText('Reviewed fresh MetaWeb activity and saved the useful findings.')).toBeVisible();
  });

  test('a Surf notification opens the exact Bot and report', async ({ page }) => {
    await openAutomation(page);
    await page.getByTestId('bot-surf-run-now').click();
    await expect(page.getByTestId('surf-run-mock-surf-2')).toContainText('Completed');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByTestId('notification-bell').click();
    await page.getByTestId('notification-surf:mock-surf-2').click();
    await expect(page.getByTestId('bot-automation-page')).toBeVisible();
    expect(page.url()).toContain('/app/bots/1/automation');
    expect(page.url()).toContain('runId=mock-surf-2');
    await expect(page.getByTestId('surf-run-mock-surf-2')).toHaveJSProperty('open', true);
  });

  test('Bot enable state persists and the global automation gate is enforced', async ({ page }) => {
    await openAutomation(page, 2);
    await page.getByRole('switch', { name: 'Enabled', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Disabled', exact: true })).toHaveAttribute('aria-checked', 'false');
    await page.reload();
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-entry-bots').click();
    await page.getByTestId('bot-row-2').click();
    await page.getByTestId('bot-tab-automation').click();
    await expect(page.getByRole('switch', { name: 'Disabled', exact: true })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('switch', { name: 'Disabled', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Enabled', exact: true })).toHaveAttribute('aria-checked', 'true');

    await openAutomation(page);
    await page.getByRole('switch', { name: 'Allow experimental automation' }).click();
    await expect(page.getByRole('switch', { name: 'Enable daily report' })).toBeDisabled();
    await expect(page.getByText('Enable experimental automation above first.')).toBeVisible();
    const result = await page.evaluate(async () => window.electron.dailyReport.runNow());
    expect(result).toEqual({ status: 'unavailable', reason: 'experimental_disabled' });
  });
});
