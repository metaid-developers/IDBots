import { test, expect, attachScreen } from './fixtures';

/**
 * UE rework 2026-10-29 (owner's seven-point PWA feedback, A1–A4):
 *
 * A1 — avatars: gateway-truncated data URLs must degrade to the letter
 *      fallback, never render as broken images (mobile-side gate; the full
 *      fix is the contract change request in the delivery note).
 * A2 — the in-conversation MetaBot switcher is gone; the header is
 *      avatar + title only.
 * A3 — "New chat" opens a Bot picker with avatars (Twin first).
 * A4 — the session drawer groups sessions by day with per-row Bot avatars.
 */

async function openChat(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/app/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
}

test.describe('chat UE rework', () => {
  test('A2: conversation header is avatar + title, no MetaBot switcher', async ({ page }, testInfo) => {
    await openChat(page);
    await expect(page.getByTestId('chat-header-avatar')).toBeVisible();
    await expect(page.getByTestId('chat-header-avatar')).toHaveAttribute('data-avatar-state', 'fallback');
    await expect(page.getByTestId('chat-header-title')).toBeVisible();
    // The old switcher strip carried this exact aria-label.
    await expect(page.locator('[aria-label="Bot"]')).toHaveCount(0);
    await expect(page.getByTestId('session-drawer-list')).toHaveCount(0);
    await attachScreen(testInfo, page, 'a2-chat-header');
  });

  test('A3: new chat opens the Bot picker with avatars, Twin first', async ({ page }, testInfo) => {
    await openChat(page);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect(page.getByTestId('session-drawer-list')).toBeVisible();
    await page.getByTestId('session-new-chat').click();

    const picker = page.getByTestId('bot-picker-list');
    await expect(picker).toBeVisible();
    const options = picker.getByRole('button');
    await expect(options.first()).toContainText('Twin Bot');
    await expect(picker.getByTestId(/bot-picker-avatar-/).first()).toBeVisible();
    await attachScreen(testInfo, page, 'a3-bot-picker');

    // Picking a Bot closes drawer+picker and lands on a fresh conversation.
    await options.first().click();
    await expect(picker).toBeHidden();
    await expect(page.getByTestId('chat-header-avatar')).toBeVisible();
    await attachScreen(testInfo, page, 'a3-after-pick');
  });

  test('A4: session drawer groups by day and shows per-row bot avatars', async ({ page }, testInfo) => {
    await openChat(page);
    await page.getByRole('button', { name: 'Sessions' }).click();
    const list = page.getByTestId('session-drawer-list');
    await expect(list).toBeVisible();
    // Seeded mock sessions were all touched "today" — one group header.
    await expect(list.getByTestId('session-group-today')).toBeVisible();
    const sessionRows = list.locator('[data-testid^="session-actions-"]');
    const rowCount = await sessionRows.count();
    expect(rowCount).toBeGreaterThan(0);
    const avatars = list.locator('[data-testid^="session-bot-avatar-"]');
    await expect(avatars).toHaveCount(rowCount);
    for (let index = 0; index < rowCount; index += 1) {
      await expect(avatars.nth(index)).toBeVisible();
    }
    await attachScreen(testInfo, page, 'a4-session-groups');
  });

  test('A1: a gateway-truncated avatar falls back to the letter, not a broken image', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.evaluate(() => {
      const api = window.electron;
      const originalList = api.metabot.list;
      api.metabot.list = async () => {
        const result = await originalList();
        if (result.list) {
          for (const bot of result.list) {
            // What the C2 gateway actually delivers for every avatar larger
            // than IPC_STRING_MAX_CHARS: a cut-off data URL + the marker.
            bot.avatar = `data:image/png;base64,${'A'.repeat(6000)}\n...[truncated in main IPC forwarding]`;
          }
        }
        return result;
      };
    });
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    // A6: the bot list moved to the My Bots secondary page.
    await page.getByTestId('me-entry-bots').click();
    const rows = page.locator('[data-testid^="bot-row-"]');
    await expect(rows.first()).toBeVisible();
    const avatars = rows.locator('[data-testid^="bot-avatar-"]');
    const avatarCount = await avatars.count();
    expect(avatarCount).toBeGreaterThan(0);
    for (let index = 0; index < avatarCount; index += 1) {
      await expect(avatars.nth(index)).toHaveAttribute('data-avatar-state', 'fallback');
    }
    await attachScreen(testInfo, page, 'a1-truncated-avatar-fallback');

    // The same gate applies to the chat header bot resolution.
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByTestId('chat-header-avatar')).toHaveAttribute('data-avatar-state', 'fallback');
  });
});
