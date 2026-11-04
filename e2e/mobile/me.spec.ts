import { test, expect, attachScreen } from './fixtures';

/**
 * Me tab (REQ-E-14), updated for the A6 settings IA rework (IA-PLAN v1) and
 * S9: the primary page is the user card + the ME points home (merged balance,
 * four-bucket ledger, tier cards) + the entry registry; skills and language
 * live on their secondary pages.
 */

test.describe('me screen', () => {
  test('points home shows the merged ME balance and the four buckets', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    await expect(page.getByTestId('me-points-hero')).toBeVisible();
    await expect(page.getByText('Mock User')).toBeVisible();
    // Mock free-tier ledger: 1,480 weekly + 30,000 top-up + 2,000 bonus +
    // 1,250 earned = 34,730 ME merged.
    await expect(page.getByTestId('me-points-total')).toHaveText('34,730');
    const ledger = page.getByTestId('me-ledger-breakdown');
    await expect(ledger).toContainText('1,480');
    await expect(ledger).toContainText('30,000');
    await expect(ledger).toContainText('2,000');
    await expect(ledger).toContainText('1,250');
    // The retired traffic/LLM meters must not appear anywhere on the page.
    await expect(page.getByText('500 MB')).toHaveCount(0);
    await expect(page.getByText(/1,650,000 tokens/)).toHaveCount(0);
    await attachScreen(testInfo, page, 'me-points-home');
  });

  test('the skills list lives on the Skills secondary page, not the primary (A6)', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    // Primary: registry row only — the flat skill list never renders here.
    await expect(page.getByTestId('me-entry-skills')).toBeVisible();
    await expect(page.getByText('Mock User')).toBeVisible();
    await expect(page.getByText('web-search')).toHaveCount(0);

    // Secondary page carries the installed list with toggles.
    await page.getByTestId('me-entry-skills').click();
    await expect(page.getByTestId('me-page-skills')).toBeVisible();
    await expect(page.getByTestId('skills-row-web-search')).toBeVisible();
    await attachScreen(testInfo, page, 'me-skills-secondary');

    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
  });

  test('language switch flips the UI language (General secondary page)', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    await page.getByTestId('me-entry-general').click();
    await expect(page.getByTestId('me-page-general')).toBeVisible();
    await page.getByRole('button', { name: '中文' }).click();
    // The settings section subscribes to the i18n service and re-renders at
    // once; switching tabs then re-renders the shell's tab bar in zh.
    await expect(page.getByText('语言', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(page.getByRole('button', { name: '任务', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '我的', exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'me-language-zh');
  });
});
