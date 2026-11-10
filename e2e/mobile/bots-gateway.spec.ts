import { test, expect, attachScreen } from './fixtures';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

test.describe('gateway Bot lifecycle', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness');

  test('on-chain create, persistent configuration and next-session brain use real C2 @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');
    const existing = await page.evaluate(async () => window.electron.cowork.startSession({
      prompt: 'existing C2 session',
      metabotId: 2,
      model: 'c2-session-model',
      modelProvider: 'c2-session-provider',
    }));
    expect(existing.success).toBe(true);

    await page.getByRole('button', { name: 'Me', exact: true }).click();
    // A6: the bot list lives on the My Bots secondary page.
    await page.getByTestId('me-entry-bots').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    // A5 rework: create is name+role only; the brain is auto-filled and the
    // specific model is selected right after, through the edit sheet.
    await form.getByPlaceholder('Name').fill('C2 Worker');
    await form.getByPlaceholder('Role').fill('Gateway research worker');
    await form.getByTestId('bot-save').click();

    const row = page.locator('[data-testid^="bot-row-"]').filter({ hasText: 'C2 Worker' });
    await expect(row).toBeVisible({ timeout: 30_000 });

    // A6: tapping the row pushes the full-screen editor (third level).
    await row.click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    await page.getByTestId('bot-form').getByTestId('bot-tab-model').click();
    await page.getByTestId('bot-form').getByLabel('Default model').selectOption({ label: 'ID.Bots · GLM Flash' });
    await page.getByTestId('bot-form').getByLabel('Reasoning effort', { exact: true }).first().selectOption('high');
    await page.getByTestId('bot-form').getByTestId('bot-tab-chatSettings').click();
    await page.getByTestId('bot-form').getByTestId('bot-skills-toggle').click();
    await page.getByTestId('bot-form').getByLabel('web-search').check();
    await page.getByTestId('bot-save').click();
    // A6: a synced save pops back to the bots list.
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    const created = await page.evaluate(async () => {
      const result = await window.electron.metabot.list();
      return result.list.find((bot) => bot.name === 'C2 Worker');
    });
    expect(created.llm_id).toBe('glm-flash');
    expect(created.llm_provider).toBe('metaid-free');
    expect(created.llm_effort).toBe('high');
    expect(created.allow_chat_skills).toEqual(['web-search']);

    await row.click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    await page.getByTestId('bot-form').getByTestId('bot-tab-chatSettings').click();
    await page.getByTestId('bot-form').getByTestId('bot-skills-toggle').click();
    await page.getByTestId('bot-form').getByRole('checkbox', { name: 'memory' }).check();
    await page.getByTestId('bot-save').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();

    const next = await page.evaluate(async (metabotId) => window.electron.cowork.startSession({ prompt: 'next C2 session', metabotId }), created.id);
    expect(next.session.model).toBe('glm-flash');
    expect(next.session.modelProvider).toBe('metaid-free');
    const reopened = await page.evaluate(async (id) => window.electron.cowork.getSession(id), existing.session.id);
    expect(reopened.session.model).toBe('c2-session-model');
    expect(reopened.session.modelProvider).toBe('c2-session-provider');

    // NOTE (A6, IA-PLAN §4.5): the list-row enable switch retired with the
    // flat section (capability suspended, delivery note); enabled-state
    // persistence is asserted through the channel read below.
    await page.reload();
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-entry-bots').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    const restored = page.locator('[data-testid^="bot-row-"]').filter({ hasText: 'C2 Worker' });
    await expect(restored).toBeVisible();
    const persisted = await page.evaluate(async (id) => window.electron.metabot.get(id), created.id);
    expect(persisted.metabot.allow_chat_skills).toEqual(['web-search', 'memory']);
    await attachScreen(testInfo, page, 'gateway-bot-configured');
  });
});
