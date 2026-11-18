import { test, expect, attachScreen } from './fixtures';

/**
 * A6 settings IA rework (IA-PLAN v1) e2e coverage:
 * 1. entry registry rendering — groups, rows, live value summaries;
 * 2. secondary-page navigation — every entry pushes its page (incl. the
 *    card entries user→profile and the S9 points hero→usage, and the
 *    third-level bots→botEdit push);
 * 3. back behavior — top-bar back, browser history back (Android system
 *    back rides the same popstate), and the dirty-profile discard confirm.
 */

async function openMe(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/app/');
  await page.getByRole('button', { name: 'Me', exact: true }).click();
  await expect(page.getByTestId('me-primary-page')).toBeVisible();
}

test.describe('A6 settings IA', () => {
  test('registry renders the three groups with live summaries', async ({ page }, testInfo) => {
    await openMe(page);

    await expect(page.getByTestId('me-group-bots')).toBeVisible();
    await expect(page.getByTestId('me-group-general')).toBeVisible();
    await expect(page.getByTestId('me-group-account')).toBeVisible();

    // Row order inside each group (IA-PLAN §4.1).
    const generalGroup = page.getByTestId('me-group-general');
    await expect(generalGroup.getByTestId('me-entry-usage')).toBeVisible();
    await expect(generalGroup.getByTestId('me-entry-skills')).toBeVisible();
    await expect(generalGroup.getByTestId('me-entry-memory')).toBeVisible();
    await expect(generalGroup.getByTestId('me-entry-model')).toBeVisible();
    await expect(generalGroup.getByTestId('me-entry-general')).toBeVisible();

    // Live summaries from the mock fixtures: 2 bots, 2 enabled skills,
    // memory on, language·theme combo, app version.
    await expect(page.getByTestId('me-entry-bots-summary')).toHaveText('2');
    // S9: the usage row carries the merged ME balance from the live ledger.
    await expect(page.getByTestId('me-entry-usage-summary')).toHaveText('34,730 ME');
    await expect(page.getByTestId('me-entry-skills-summary')).toHaveText('2 enabled');
    await expect(page.getByTestId('me-entry-memory-summary')).toHaveText('On');
    await expect(page.getByTestId('me-entry-general-summary')).toContainText('·');
    await expect(page.getByTestId('me-entry-about-summary')).toHaveText('1.0.2-mobile.mock');

    // The user card carries the identity + sync badge.
    await expect(page.getByTestId('user-card')).toContainText('Mock User');
    await expect(page.getByTestId('user-card-sync-badge')).toHaveAttribute('data-state', 'ok');
    await attachScreen(testInfo, page, 'a6-primary-registry');
  });

  test('home hides the duplicate plan catalog while Upgrade keeps the full chooser', async ({ page }) => {
    await openMe(page);
    await expect(page.getByTestId('me-tier-cards')).toHaveCount(0);
    await expect(page.getByTestId('me-tiers-empty')).toHaveCount(0);
    await page.getByRole('button', { name: 'Upgrade plan', exact: true }).click();
    await expect(page.getByTestId('me-purchase-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
    await expect(page.getByTestId('me-tier-cards')).toBeVisible();
  });

  test('every registry entry pushes its secondary page and back pops it', async ({ page }) => {
    await openMe(page);
    const entries: Array<{ row: string; page: string }> = [
      { row: 'me-entry-bots', page: 'me-page-bots' },
      { row: 'me-entry-usage', page: 'me-page-usage' },
      { row: 'me-entry-skills', page: 'me-page-skills' },
      { row: 'me-entry-memory', page: 'me-page-memory' },
      { row: 'me-entry-model', page: 'me-page-model' },
      { row: 'me-entry-general', page: 'me-page-general' },
      { row: 'me-entry-account', page: 'me-page-account' },
      { row: 'me-entry-about', page: 'me-page-about' },
    ];
    for (const entry of entries) {
      await page.getByTestId(entry.row).click();
      await expect(page.getByTestId(entry.page)).toBeVisible();
      await page.getByTestId('me-secondary-back').click();
      await expect(page.getByTestId('me-primary-page')).toBeVisible();
    }
  });

  test('card entries: user card → profile, points hero → usage; free tier hides the cashier', async ({ page }) => {
    await openMe(page);

    await page.getByTestId('user-card').click();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();

    await page.getByTestId('me-usage-link').click();
    await expect(page.getByTestId('me-page-usage')).toBeVisible();
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();

    // S9: the traffic page and its card are gone; a free-tier account sees
    // the "plan required" hint and no cashier entry at all.
    await expect(page.getByTestId('balance-card')).toHaveCount(0);
    await expect(page.getByTestId('me-topup-locked')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Top up ME' })).toHaveCount(0);
  });

  test('bots list pushes the full botEdit third level and back returns to the list', async ({ page }, testInfo) => {
    await openMe(page);

    await page.getByTestId('me-entry-bots').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    await expect(page.getByTestId('bot-row-1')).toContainText('Twin Bot');

    await page.getByTestId('bot-row-1').click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    await expect(page.getByTestId('bot-form')).toBeVisible();
    await attachScreen(testInfo, page, 'a6-bot-edit-third-level');

    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
  });

  test('browser history back (Android system back) pops the secondary page', async ({ page }) => {
    await openMe(page);

    await page.getByTestId('me-entry-about').click();
    await expect(page.getByTestId('me-page-about')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
  });

  test('dirty profile asks before discarding; cancel keeps editing', async ({ page }, testInfo) => {
    await openMe(page);

    await page.getByTestId('user-card').click();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();
    await page.getByTestId('profile-name').fill('Renamed User');

    // Dirty + top-bar back → confirm sheet, page stays mounted.
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByText('Discard changes?')).toBeVisible();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();
    await attachScreen(testInfo, page, 'a6-profile-discard-confirm');

    // Keep editing: still on the profile page.
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();

    // Discard: back on the primary, name unchanged.
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByText('Discard changes?')).toBeVisible();
    await page.getByTestId('discard-confirm').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
    await expect(page.getByTestId('user-card')).toContainText('Mock User');
  });

  test('profile save round-trips through updateName and refreshes the user card', async ({ page }, testInfo) => {
    await openMe(page);

    await page.getByTestId('user-card').click();
    await page.getByTestId('profile-name').fill('Renamed User');
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-saved')).toBeVisible();
    await attachScreen(testInfo, page, 'a6-profile-saved');

    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
    await expect(page.getByTestId('user-card')).toContainText('Renamed User');
  });

  test('usage & credits page renders the ME ledger, orders and the multiplier fold', async ({ page }, testInfo) => {
    await openMe(page);

    await page.getByTestId('me-usage-link').click();
    await expect(page.getByTestId('me-page-usage')).toBeVisible();

    // Ledger arrives from the mock ME history (grant/spend/topup/earned/bonus).
    await expect(page.getByTestId('usage-history')).toContainText('Grant');
    await expect(page.getByTestId('usage-history')).toContainText('Top-up');
    await expect(page.getByTestId('usage-history-empty')).toHaveCount(0);

    // Top-up order states are visible on the merged page.
    await expect(page.getByTestId('usage-orders')).toContainText('me_topup_demo_');

    // The multiplier explainer opens; the compliance lines stay on the page.
    await page.getByRole('button', { name: 'Rates & multipliers' }).click();
    await expect(page.getByTestId('usage-rates')).toContainText('1x');
    await expect(page.getByTestId('usage-compliance')).toContainText('never expires');
    await attachScreen(testInfo, page, 'a6-usage-credits');

    // The retired traffic surface is unreachable.
    await expect(page.getByTestId('me-page-traffic')).toHaveCount(0);
  });

  test('models page saves a custom provider without retaining its key in the form or phone storage', async ({ page }, testInfo) => {
    await openMe(page);
    await page.getByTestId('me-entry-model').click();
    await expect(page.getByTestId('model-form')).toBeVisible();
    await page.getByTestId('model-provider').selectOption('custom');
    await page.getByTestId('model-provider-name').fill('Playwright provider');
    await page.getByTestId('model-api-key').fill('playwright-test-key');
    await page.getByTestId('model-id').fill('playwright-model');
    await page.getByTestId('model-base-url').fill('https://models.example/v1');
    await page.getByTestId('model-save').click();

    await expect(page.getByTestId('model-saved')).toContainText('playwright-model');
    await expect(page.getByTestId('model-current')).toContainText('playwright-model');
    await expect(page.getByTestId('model-current')).toContainText('Playwright provider');
    await expect(page.getByTestId('model-api-key')).toHaveValue('');
    const storageContainsKey = await page.evaluate(() => {
      const values: string[] = [];
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key) values.push(storage.getItem(key) ?? '');
        }
      }
      return values.some((value) => value.includes('playwright-test-key'));
    });
    expect(storageContainsKey).toBe(false);
    await attachScreen(testInfo, page, 'mobile-model-custom-provider-saved');
  });
});
