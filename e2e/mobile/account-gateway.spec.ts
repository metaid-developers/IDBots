import { test, expect, attachScreen } from './fixtures';
import type { Page } from '@playwright/test';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

async function pendingOrderId(page: Page): Promise<string> {
  return (await page.locator('.me-checkout-order').innerText()).trim();
}

async function installMeOrderStatus(page: Page, orderId: string, status: string): Promise<void> {
  await page.evaluate(({ orderId: id, status: nextStatus }) => {
    window.electron.mePoints.getSubscriptionOrder = async ({ orderId: requestedId }) => ({
      success: true,
      subscriptionOrder: {
        orderId: requestedId,
        planId: 'me_pro',
        period: 'quarter',
        channel: 'mobile',
        status: nextStatus,
        payAmount: 537.3,
        payCurrency: 'CNY',
        gatewayParams: {
          approvalUrl: `https://pay.gateway.fixture/${id}`,
          qrCode: `https://pay.gateway.fixture/${id}`,
          expiresAt: Date.now() - 60_000,
        },
        createdAt: Math.floor(Date.now() / 1000) - 900,
      },
    });
  }, { orderId, status });
}

test.describe('gateway account and daily use', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness');

  test('ME order recovery, exactly-once balance and the next chat use real C2 @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-tier-me_pro').click();
    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-payment-pending')).toBeVisible();
    const orderId = await pendingOrderId(page);
    expect(orderId).toBe('gw-me-subscription-1');

    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByTestId('me-tier-me_pro').click();
    await expect(page.locator('.me-checkout-order')).toHaveText(orderId);
    await page.reload();
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-usage-link').click();
    await page.getByTestId(`usage-resume-${orderId}`).click();
    await expect(page.locator('.me-checkout-order')).toHaveText(orderId);

    await expect(page.getByTestId('me-purchase-submitted')).toBeVisible({ timeout: 45_000 });
    const before = await page.evaluate(async () => (await window.electron.mePoints.getBalance()).balance);
    await page.evaluate(async (id) => {
      await window.electron.mePoints.getSubscriptionOrder({ orderId: id });
      await window.electron.mePoints.getSubscriptionOrder({ orderId: id });
    }, orderId);
    const after = await page.evaluate(async () => (await window.electron.mePoints.getBalance()).balance);
    expect(after.totalAvailable).toBe(before.totalAvailable);
    expect(after.weeklyGrant.amountMilli).toBe(before.weeklyGrant.amountMilli);
    expect(after.weeklyGrant.remainingMilli).toBe(before.weeklyGrant.remainingMilli);
    expect(after.persistent).toEqual(before.persistent);

    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByPlaceholder('Type a message…').fill('next message after gateway recharge');
    await page.getByTestId('chat-composer-input').press('Enter');
    await expect(page.getByText('Gateway fixture online.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await attachScreen(testInfo, page, 'gateway-recharge-next-chat');
  });

  test('an expired unpaid ME order reconciles to credited without a duplicate @gateway', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-tier-me_pro').click();
    await page.getByTestId('me-period-quarter').click();
    await page.getByTestId('me-purchase-submit').click();
    await expect(page.getByTestId('me-payment-pending')).toBeVisible();
    const orderId = await pendingOrderId(page);

    await installMeOrderStatus(page, orderId, 'submitted');
    await page.reload();
    await installMeOrderStatus(page, orderId, 'submitted');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-tier-me_pro').click();
    await expect(page.locator('.me-checkout-order')).toHaveText(orderId);

    await installMeOrderStatus(page, orderId, 'confirmed');
    await page.getByTestId('me-payment-check').click();
    await expect(page.getByTestId('me-purchase-submitted')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('me-tier-me_pro')).toBeEnabled();
    const matchingOrders = await page.evaluate(async (id) => {
      const result = await window.electron.mePoints.getSubscriptionOrders();
      return result.orders?.filter((order) => order.orderId === id).length ?? 0;
    }, orderId);
    expect(matchingOrders).toBe(1);
  });

  test('settings and global memory persist without exposing provider secrets @gateway', async ({ page }, testInfo) => {
    try {
      await page.goto('/app/');
      await page.getByRole('button', { name: 'Me', exact: true }).click();
      await page.getByTestId('me-entry-memory').click();
      const memory = page.getByRole('switch', { name: 'Enable memory' });
      await memory.click();
      await expect(memory).toHaveAttribute('aria-checked', 'false');
      await page.getByTestId('me-secondary-back').click();
      await page.getByTestId('me-entry-general').click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      await expect(page.locator('html')).toHaveClass(/dark/);
      await page.getByRole('button', { name: '中文', exact: true }).click();
      await expect(page.getByText('语言', { exact: true })).toBeVisible();

      await page.reload();
      await page.getByRole('button', { name: '我的', exact: true }).click();
      await page.getByTestId('me-entry-general').click();
      await expect(page.getByText('语言', { exact: true })).toBeVisible();
      await page.getByTestId('me-secondary-back').click();
      await page.getByTestId('me-entry-memory').click();
      await expect(page.getByRole('switch', { name: '启用记忆' })).toHaveAttribute('aria-checked', 'false');
      await expect(page.locator('html')).toHaveClass(/dark/);
      const config = await page.evaluate(async () => {
        const [appConfig, coworkConfig] = await Promise.all([
          window.electron.store.get('app_config'),
          window.electron.cowork.getConfig(),
        ]);
        return { appConfig, coworkConfig: coworkConfig.config };
      });
      expect(config.appConfig.language).toBe('zh');
      expect(config.appConfig.theme).toBe('dark');
      expect(config.appConfig.providers['metaid-free'].apiKey).toBe('__redacted__');
      expect(config.appConfig.providers['metaid-free'].baseUrl).toBe('https://gateway.fixture/relay');
      expect(config.appConfig.bootstrap.languageInitialized).toBe(true);
      expect(config.coworkConfig.memoryEnabled).toBe(false);
      await attachScreen(testInfo, page, 'gateway-settings-persisted');
    } finally {
      await page.evaluate(async () => {
        await window.electron.store.set('app_config', { language: 'en', theme: 'system' });
        await window.electron.cowork.setConfig({ memoryEnabled: true });
      });
    }
  });
});
