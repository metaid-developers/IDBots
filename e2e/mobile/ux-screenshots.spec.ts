import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Evidence capture spec for the UX batch 2026-10-28 + A6 IA rework
 * (2026-10-29). Only runs when E2E_EVIDENCE_DIR is set (evidence mode);
 * full suite runs keep it skipped so default e2e runs are untouched.
 */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? '';

test.describe('UX batch evidence screenshots (390x844 via iPhone 14 project)', () => {
  test.skip(!EVIDENCE_DIR, 'evidence mode requires E2E_EVIDENCE_DIR');

  async function shot(page: import('@playwright/test').Page, name: string, fullPage = false) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage });
  }

  test('captures the A6 Me primary page and every secondary page', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
    await expect(page.getByTestId('me-entry-about')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'a6-me-primary');

    // User card → profile.
    await page.getByTestId('user-card').click();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, 'a6-page-profile');
    await page.getByTestId('me-secondary-back').click();

    // Balance card → traffic.
    await page.getByTestId('balance-card').click();
    await expect(page.getByTestId('me-page-traffic')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'a6-page-traffic');
    await page.getByTestId('me-secondary-back').click();

    // Registry pages.
    const pages: Array<[string, string, string]> = [
      ['me-entry-bots', 'me-page-bots', 'a6-page-bots'],
      ['me-entry-skills', 'me-page-skills', 'a6-page-skills'],
      ['me-entry-memory', 'me-page-memory', 'a6-page-memory'],
      ['me-entry-general', 'me-page-general', 'a6-page-general'],
      ['me-entry-account', 'me-page-account', 'a6-page-account'],
      ['me-entry-about', 'me-page-about', 'a6-page-about'],
    ];
    for (const [entry, pageId, shotName] of pages) {
      await page.getByTestId(entry).click();
      await expect(page.getByTestId(pageId)).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, shotName);
      await page.getByTestId('me-secondary-back').click();
      await expect(page.getByTestId('me-primary-page')).toBeVisible();
    }

    // Third level: bot edit.
    await page.getByTestId('me-entry-bots').click();
    await expect(page.getByTestId('bot-row-1')).toBeVisible();
    await page.getByTestId('bot-row-1').click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    await expect(page.getByTestId('bot-form')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, 'a6-page-bot-edit');
  });

  test('captures the A5 create sheet from the bots page (A6 navigation)', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-entry-bots').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();

    // Owner contract: Twin Bot is always row 1; the rest follow created_at ascending.
    const rows = page.locator('[data-testid^="bot-row-"]');
    await expect(rows.first()).toBeVisible();
    const firstRowName = await rows.first().innerText();
    expect(firstRowName).toContain('Twin Bot');

    // Create sheet: name+role only — the A5 rework removed the Advanced
    // area entirely (the old 'create-form-advanced-open' shot is obsolete).
    await page.getByTestId('bot-create').click();
    const createForm = page.getByTestId('bot-form');
    await expect(createForm.getByTestId('bot-create-guide')).toBeVisible();
    await expect(createForm.getByTestId('bot-advanced-toggle')).toHaveCount(0);
    await createForm.getByLabel('Name').fill('Demo Bot');
    await createForm.getByLabel('Role').fill('Demo role');
    await shot(page, 'create-form-name-role');
    await page.getByRole('button', { name: '✕', exact: true }).click();
  });

  test('captures the chat UE rework screens (A2 header, A4 groups, A3 picker)', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.waitForTimeout(400);
    // A2: conversation header = bot avatar + title (switcher removed).
    await shot(page, 'a2-chat-header-avatar-title');

    // A4: session drawer grouped by day with per-row bot avatars.
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect(page.getByTestId('session-drawer-list')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'a4-session-drawer-grouped');

    // A3: the new-chat bot picker with avatars, Twin first.
    await page.getByTestId('session-new-chat').click();
    await expect(page.getByTestId('bot-picker-list')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'a3-new-chat-bot-picker');
  });
});
