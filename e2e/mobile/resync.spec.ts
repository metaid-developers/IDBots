import { test, expect, attachScreen } from './fixtures';

/**
 * REQ-E-5 / AC-E-4 evidence: a forced reconnect in the middle of a streamed
 * reply — the reply completes after recovery with no duplicated content.
 * The mock's simulateReconnect blacks out for ~3 s while the stream keeps
 * producing, which is exactly the airplane-mode-then-resume scenario.
 */
test.describe('reconnect resync @resync', () => {
  test('stream completes without duplicates after a mid-stream reconnect', async ({ page }, testInfo) => {
    await page.goto('/app/');
    const composer = page.getByPlaceholder('Type a message…');
    await composer.fill('tell me a story');
    await page.getByTestId('chat-composer-input').press('Enter');

    // Let the stream start, then black out mid-reply.
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      (window as unknown as { idbotsMobile: { mock?: { simulateReconnect: () => void } } }).idbotsMobile.mock?.simulateReconnect();
    });
    await page.waitForTimeout(400);
    await attachScreen(testInfo, page, 'resync-mid-blackout');

    // Recovery: the reply finishes after the socket returns.
    await expect(page.getByText('Mock bridge online.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await attachScreen(testInfo, page, 'resync-after-recovery');

    // Exactly one assistant message carries the canned marker (no duplicates).
    await expect(page.getByText('Mock bridge online.', { exact: true })).toHaveCount(1);
  });
});
