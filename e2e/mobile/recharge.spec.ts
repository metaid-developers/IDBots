import { test, expect, attachScreen } from './fixtures';

async function confirmOrder(page: import('@playwright/test').Page, orderId: string): Promise<void> {
  const confirmed = await page.evaluate((id) => {
    return (window as unknown as {
      idbotsMobile: { mock?: { confirmMeOrder?: (orderId: string) => boolean } };
    }).idbotsMobile.mock?.confirmMeOrder?.(id) ?? false;
  }, orderId);
  expect(confirmed).toBe(true);
}

async function pendingOrderId(page: import('@playwright/test').Page): Promise<string> {
  const text = await page.locator('.me-checkout-order').innerText();
  expect(text).toContain('me_');
  return text.trim();
}

test.describe('ME purchase & topup', () => {
  test('free tier: server checkout → credited → subscription order in usage', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();
    await page.getByTestId('me-tier-me_pro').click();
    await expect(page.getByTestId('me-purchase-page')).toBeVisible();
    await expect(page.getByTestId('me-purchase-page').getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
    await attachScreen(testInfo, page, 'me-purchase-subscribe');

    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-payment-pending')).toBeVisible();
    const orderId = await pendingOrderId(page);
    await attachScreen(testInfo, page, 'me-purchase-pending');

    await confirmOrder(page, orderId);
    await page.getByTestId('me-payment-check').click();
    await expect(page.getByTestId('me-purchase-submitted')).toBeVisible();
    await attachScreen(testInfo, page, 'me-purchase-credited');

    await page.getByRole('button', { name: 'View order status' }).click();
    await expect(page.getByTestId('me-page-usage')).toBeVisible();
    await expect(page.getByTestId('usage-orders')).toContainText(orderId);
    await expect(page.getByTestId('usage-unified')).toContainText('On-chain reads and writes');
    await attachScreen(testInfo, page, 'me-usage-credits');
  });

  test('free tier has no cashier; a paid subscriber can create and confirm a top-up', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();
    await expect(page.getByTestId('me-topup-locked')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Top up ME' })).toHaveCount(0);

    const rejected = await page.evaluate(async () => {
      const api = (window as unknown as { electron: { mePoints: { submitTopupOrder: (input: { packageId: string }) => Promise<Record<string, unknown>> } } }).electron.mePoints;
      return api.submitTopupOrder({ packageId: 'me_topup_a' });
    });
    expect(rejected.success).toBe(false);
    expect(rejected.errorCode).toBe('SUBSCRIPTION_REQUIRED');

    await page.evaluate(() => {
      (window as unknown as { idbotsMobile: { mock?: { setMeSubscribed?: (value: boolean) => void } } })
        .idbotsMobile.mock?.setMeSubscribed?.(true);
    });
    await page.locator('[data-testid="me-points-hero"] button[aria-label="Retry"]').click();
    await page.getByRole('button', { name: 'Top up ME' }).click();
    await expect(page.getByTestId('me-topup-packages')).toBeVisible();
    await expect(page.getByTestId('me-topup-me_topup_a')).toBeVisible();
    await expect(page.getByTestId('me-topup-me_topup_b')).toBeVisible();
    await attachScreen(testInfo, page, 'me-topup-packages');

    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-payment-pending')).toBeVisible();
    const orderId = await pendingOrderId(page);
    await confirmOrder(page, orderId);
    await page.getByTestId('me-payment-check').click();
    await expect(page.getByTestId('me-purchase-submitted')).toBeVisible();
  });

  test('an active-plan upgrade requires the full-price confirmation step', async ({ page }) => {
    await page.goto('/app/');
    await page.evaluate(() => {
      (window as unknown as { idbotsMobile: { mock?: { setMeSubscribed?: (value: boolean) => void } } })
        .idbotsMobile.mock?.setMeSubscribed?.(true);
    });
    await page.getByRole('button', { name: 'Me' }).click();
    await page.locator('[data-testid="me-points-hero"] button[aria-label="Retry"]').click();
    await page.getByTestId('me-tier-me_max').click();
    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-upgrade-confirm')).toBeVisible();
    await expect(page.getByTestId('me-payment-pending')).toHaveCount(0);
    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-payment-pending')).toBeVisible();
  });

  test('reload restores the same pending order from the order list without recreating it', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();
    await page.getByTestId('me-tier-me_pro').click();
    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-payment-pending')).toBeVisible();
    const orderId = await pendingOrderId(page);

    await page.reload();
    await page.getByRole('button', { name: 'Me' }).click();
    await page.getByTestId('me-usage-link').click();
    await page.getByTestId(`usage-resume-${orderId}`).click();
    await expect(page.getByTestId('me-payment-pending')).toBeVisible();
    await expect(page.locator('.me-checkout-order')).toHaveText(orderId);
    await page.getByTestId('me-payment-check').click();
    const matchingOrders = await page.evaluate(async (id) => {
      const result = await window.electron.mePoints.getSubscriptionOrders();
      return result.orders?.filter((order) => order.orderId === id).length ?? 0;
    }, orderId);
    expect(matchingOrders).toBe(1);
  });
});
