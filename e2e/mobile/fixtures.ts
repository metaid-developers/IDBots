import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Shared helpers for the mobile e2e suite (REQ-E-26).
 */

/** Explicit per-screen screenshot attach (config keeps only-on-failure). */
export async function attachScreen(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
}

/** Waits for the app shell's bottom tab bar and returns the chat tab. */
export async function expectAppShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Me' })).toBeVisible();
}

/**
 * Starts a new conversation through the A3 (UE rework 2026-10-29) flow:
 * drawer → "New chat" opens the Bot picker → pick the first row. The picker
 * is Twin-first (sortBotsForList), so the first row keeps the pre-rework
 * default of starting chats with the Twin Bot.
 *
 * Drawer-idempotent: callers that already opened the drawer (the pre-rework
 * specs click "Sessions" themselves) must not have the second header click
 * blocked by the drawer's own backdrop.
 */
export async function startNewChatViaPicker(page: Page): Promise<void> {
  const drawerList = page.getByTestId('session-drawer-list');
  if (!(await drawerList.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Sessions' }).click();
  }
  await page.getByTestId('session-new-chat').click();
  await page.getByTestId('bot-picker-list').getByRole('button').first().click();
  await expect(page.getByTestId('bot-picker-list')).toBeHidden();
}

export { test, expect };
