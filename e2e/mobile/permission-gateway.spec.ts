import { test, expect, attachScreen, startNewChatViaPicker } from './fixtures';

/**
 * F-17a gateway regression (2026-10-28 阿燃 incident): a real ask_user_question
 * permission request crossing the REAL C2 gateway event fan-out must keep its
 * option objects (the old IPC sanitize depth cap crushed them into the string
 * '[truncated-depth]', and the mobile panel then rendered the unanswerable
 * "Request unavailable" card). The fixture raises the incident payload over
 * cowork:stream:permission on session start; this spec asserts the structured
 * wizard renders and the answer reaches the tenant side.
 */

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

test.describe('gateway permission rendering (F-17a)', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness (scripts/run-mobile-e2e-gateway.mjs)');

  test('real ask payload renders options through the gateway fan-out @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sessions' }).click();
    await startNewChatViaPicker(page);
    await page.getByPlaceholder('Type a message…').fill('__f17a_emit_ask__');
    await page.getByTestId('chat-composer-input').press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // The incident's schema differences (id + snake_case multi_select + detail)
    // ride with the question; the wizard must still render the choices.
    await expect(page.getByText('这张卡可以照着建吗？')).toBeVisible();
    await expect(page.getByText('就这个（推荐）')).toBeVisible();
    await expect(page.getByText('名字换一个')).toBeVisible();
    await expect(page.getByText('Request unavailable')).toHaveCount(0);
    await attachScreen(testInfo, page, 'gateway-f17a-permission-options');

    await page.getByRole('radio', { name: /就这个（推荐）/ }).click();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();

    // Resolution: touching the fixture removes the pending permission and the
    // page must drop the sheet (no stale overlay, no invented approval).
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await attachScreen(testInfo, page, 'gateway-f17a-permission-answered');
  });
});
