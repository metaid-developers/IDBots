import { test, expect, attachScreen } from './fixtures';

function botRow(page: import('@playwright/test').Page, name: string) {
  return page.locator('[data-testid^="bot-row-"]').filter({ hasText: name });
}

async function openMe(page: import('@playwright/test').Page) {
  await page.goto('/app/');
  await page.getByRole('button', { name: 'Me', exact: true }).click();
}

/** A6: the bot list lives on the My Bots secondary page. */
async function openBots(page: import('@playwright/test').Page) {
  await openMe(page);
  await page.getByTestId('me-entry-bots').click();
  await expect(page.getByTestId('me-page-bots')).toBeVisible();
}

test.describe('Bot lifecycle and configuration', () => {
  test('create, edit and per-Bot skills/model/A2A configuration persist (A6 navigation)', async ({ page }, testInfo) => {
    await openBots(page);
    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    // A5 rework: create mode is name+role ONLY — no tabs, no advanced area.
    await expect(form.getByTestId('bot-advanced-toggle')).toHaveCount(0);
    await expect(form.getByTestId('bot-tab-basic')).toHaveCount(0);
    await form.getByLabel('Name').fill('WP3 Worker');
    await form.getByLabel('Role').fill('Research worker');
    await form.getByTestId('bot-save').click();

    const row = botRow(page, 'WP3 Worker');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId(/bot-role-/)).toHaveText('Research worker');
    await expect(row.getByTestId(/bot-avatar-/)).toBeVisible();
    await attachScreen(testInfo, page, 'bot-created-on-chain');

    // Edit mode (A6 third level): tapping the row pushes the full editor.
    await row.click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    const editForm = page.getByTestId('bot-form');
    await expect(editForm.getByTestId('bot-tab-basic')).toHaveAttribute('aria-selected', 'true');
    for (const tab of ['persona', 'model', 'chatSettings', 'other']) {
      await expect(editForm.getByTestId(`bot-tab-${tab}`)).toBeVisible();
    }
    await editForm.getByTestId('bot-tab-basic').click();
    await editForm.getByLabel('Bio').fill('Created through the shared on-chain flow');
    await editForm.getByTestId('bot-tab-persona').click();
    await editForm.getByLabel('Persona (soul)').fill('Careful and concise');
    await editForm.getByTestId('bot-tab-model').click();
    await editForm.getByLabel('Default model').selectOption({ label: 'ID.Bots · GLM Flash' });
    await editForm.getByLabel('Reasoning effort', { exact: true }).first().selectOption('high');
    await editForm.getByTestId('bot-tab-chatSettings').click();
    await expect(editForm.getByTestId('bot-skills-toggle')).toHaveAttribute('aria-expanded', 'false');
    await editForm.getByTestId('bot-skills-toggle').click();
    await editForm.getByLabel('web-search').check();
    // A2A chat settings (desktop Chat Settings parity).
    await editForm.getByTestId('bot-a2a-auto-reply').uncheck();
    await editForm.getByTestId('bot-a2a-max-turns').selectOption('80');
    await editForm.getByTestId('bot-a2a-bye-cooldown').selectOption({ label: '10 min' });
    await editForm.getByTestId('bot-save').click();

    // A6: a synced save pops straight back to the list.
    await expect(page.getByTestId('me-page-bots')).toBeVisible();

    // Re-open: everything saved through the desktop-aligned tabs persists.
    await botRow(page, 'WP3 Worker').click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    const reopenForm = page.getByTestId('bot-form');
    await expect(reopenForm.getByLabel('Role')).toHaveValue('Research worker');
    await reopenForm.getByTestId('bot-tab-persona').click();
    await expect(reopenForm.getByLabel('Persona (soul)')).toHaveValue('Careful and concise');
    await reopenForm.getByTestId('bot-tab-chatSettings').click();
    await reopenForm.getByTestId('bot-skills-toggle').click();
    await expect(reopenForm.getByLabel('web-search')).toBeChecked();
    await expect(reopenForm.getByTestId('bot-a2a-auto-reply')).not.toBeChecked();
    await expect(reopenForm.getByTestId('bot-a2a-max-turns')).toHaveValue('80');
    await expect(reopenForm.getByTestId('bot-a2a-bye-cooldown')).toContainText('10 min');
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    // NOTE (A6, IA-PLAN §4.5): the old list-row enable switch is NOT part of
    // the new row spec — the enable/disable persistence segment of this test
    // was retired with it (capability suspended, flagged in the A6 delivery
    // note for the owner).
  });

  test('a locally saved pending Bot never creates a duplicate on the list (A6 rows)', async ({ page }, testInfo) => {
    await openBots(page);
    await page.evaluate(() => {
      const api = window.electron;
      const originalCreate = api.idbots.createMetaBotOnChain;
      const originalList = api.metabot.list;
      const originalResume = api.idbots.resumeMetabotSetup;
      let pending = true;
      let createCalls = 0;
      (window as unknown as { __botCreateCalls: number }).__botCreateCalls = 0;
      api.idbots.createMetaBotOnChain = async (input) => {
        createCalls += 1;
        (window as unknown as { __botCreateCalls: number }).__botCreateCalls = createCalls;
        const result = await originalCreate(input);
        return { ...result, chainSetupPending: true, chainError: 'fixture subsidy unavailable' };
      };
      api.metabot.list = async () => {
        const result = await originalList();
        if (pending && result.list) {
          for (const bot of result.list) {
            if (bot.name === 'WP3 Pending') {
              Object.assign(bot, {
                chain_sync_state: 'partial',
                chain_sync_pending_steps: ['name', 'chatpubkey', 'llm'],
                subsidy_state: 'failed',
                subsidy_error: 'fixture subsidy unavailable',
                metabot_info_pinid: null,
              });
            }
          }
        }
        return result;
      };
      api.idbots.resumeMetabotSetup = async (input) => {
        pending = false;
        return originalResume(input);
      };
    });

    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    await form.getByLabel('Name').fill('WP3 Pending');
    await form.getByLabel('Role').fill('Pending worker');
    await form.getByTestId('bot-save').click();
    await expect(page.getByTestId('bot-operation-result')).toHaveAttribute('data-state', 'local');
    await expect(form).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __botCreateCalls: number }).__botCreateCalls)).toBe(1);

    await page.getByRole('button', { name: '✕', exact: true }).click();
    // A6 rows (IA-PLAN §4.5) carry no inline chain badge or resume actions —
    // those capabilities are suspended with the flat section (delivery note).
    // What must still hold: exactly-once create and a stable list row.
    const row = botRow(page, 'WP3 Pending');
    await expect(row).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __botCreateCalls: number }).__botCreateCalls)).toBe(1);
    // The edit page still opens for the pending bot with skills collapsed
    // (create is name+role only since the A5 rework).
    await row.click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    await expect(page.getByTestId('bot-form').getByTestId('bot-skills-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    await attachScreen(testInfo, page, 'bot-pending-row-stable');
  });

  test('creating with only name and role succeeds (name+role-only path)', async ({ page }, testInfo) => {
    await openBots(page);
    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    // Guidance copy is visible on the create sheet; the A5 rework removed
    // the Advanced area entirely — only Name + Role exist at birth.
    await expect(form.getByTestId('bot-create-guide')).toContainText('Twin Bot');
    await expect(form.getByTestId('bot-advanced-toggle')).toHaveCount(0);
    await expect(form.getByTestId('bot-tab-basic')).toHaveCount(0);
    await form.getByLabel('Name').fill('Minimal Bot');
    await form.getByLabel('Role').fill('Starter helper');
    await form.getByTestId('bot-save').click();

    const row = botRow(page, 'Minimal Bot');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId(/bot-role-/)).toHaveText('Starter helper');
    // Skills stay collapsed in the editor opened from the row (A6 push).
    await row.click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    await expect(page.getByTestId('bot-form').getByTestId('bot-skills-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('me-secondary-back').click();
    await attachScreen(testInfo, page, 'bot-create-name-role-only');
  });
});
