import { test, expect, attachScreen } from './fixtures';

/**
 * ME purchase / top-up flow (S9 §5) against the mock ME channel.
 *
 * The retired bundle channel (traffic bytes / LLM tokens / Alipay polling) is
 * gone: a subscription order is the free tier's path in, a top-up order is
 * reserved for paid subscribers, and order states live on the merged
 * Usage & credits page.
 */

test.describe('ME purchase & topup', () => {
  test('free tier: plan order submitted → usage page shows the order', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    await page.getByTestId('me-tier-me_pro').click();
    await expect(page.getByTestId('me-purchase-page')).toBeVisible();
    await expect(page.getByTestId('me-purchase-page').getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
    await attachScreen(testInfo, page, 'me-purchase-subscribe');

    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-purchase-submitted')).toBeVisible();
    await attachScreen(testInfo, page, 'me-purchase-submitted');

    await page.getByRole('button', { name: 'View order status' }).click();
    await expect(page.getByTestId('me-page-usage')).toBeVisible();
    await expect(page.getByTestId('usage-orders')).toContainText('me_topup_demo_');
    await attachScreen(testInfo, page, 'me-usage-credits');
  });

  test('free tier has no cashier; the bridge answers SUBSCRIPTION_REQUIRED; a paid subscriber can top up', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    // 1) Free tier: no top-up entry, only the "plan required" hint.
    await expect(page.getByTestId('me-topup-locked')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Top up ME' })).toHaveCount(0);

    // 2) The backend rule is enforced through the same channel the UI uses.
    const rejected = await page.evaluate(async () => {
      const api = (window as unknown as { electron: { mePoints: { submitTopupOrder: (input: { packageId: string }) => Promise<Record<string, unknown>> } } }).electron.mePoints;
      return api.submitTopupOrder({ packageId: 'me_topup_a' });
    });
    expect(rejected.success).toBe(false);
    expect(rejected.errorCode).toBe('SUBSCRIPTION_REQUIRED');

    // 3) Flip the mock to an active subscription and refresh the ledger.
    await page.evaluate(() => {
      (window as unknown as { idbotsMobile: { mock?: { setMeSubscribed?: (value: boolean) => void } } })
        .idbotsMobile.mock?.setMeSubscribed?.(true);
    });
    await page.locator('[data-testid="me-points-hero"] button[aria-label="Retry"]').click();
    const topupButton = page.getByRole('button', { name: 'Top up ME' });
    await expect(topupButton).toBeVisible();
    await topupButton.click();

    await expect(page.getByTestId('me-topup-packages')).toBeVisible();
    await expect(page.getByTestId('me-topup-me_topup_a')).toBeVisible();
    await expect(page.getByTestId('me-topup-me_topup_b')).toBeVisible();
    await attachScreen(testInfo, page, 'me-topup-packages');

    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-purchase-submitted')).toBeVisible();
  });
});
