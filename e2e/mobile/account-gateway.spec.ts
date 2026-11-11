import { test, expect, attachScreen } from './fixtures';
import type { Page } from '@playwright/test';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

async function installExpiredOrder(page: Page, serverStatus: number): Promise<void> {
  await page.evaluate((status) => {
    const orderKey = 'idbots.mobile.bundleOrder.v1';
    const statusKey = 'idbots.fixture.expiryServerStatus';
    window.localStorage.setItem(statusKey, String(status));
    const now = Date.now();
    window.localStorage.setItem(orderKey, JSON.stringify({
      orderId: 'gw-expired-order',
      qrCode: 'https://qr.alipay.com/gateway-expired-order',
      plan: {
        planId: 'bundle_basic_cny',
        name: 'Basic',
        nameEn: 'Basic',
        payCurrency: 'CNY',
        payAmount: '129.00',
        trafficBytes: 104857600,
        llmQuota: 2000000,
        llmQuotaUnit: 'tokens',
        status: 1,
        sort: 10,
        remark: '',
      },
      expiresAt: Math.floor(now / 1000) - 60,
      status: 1,
      createdAtMs: now,
    }));
    window.electron.bundle.getOrder = async ({ orderId }) => {
      const order = JSON.parse(window.localStorage.getItem(orderKey) ?? '{}');
      return {
        success: true,
        order: {
          orderId,
          planId: order.plan.planId,
          status: Number(window.localStorage.getItem(statusKey)),
          payAmount: order.plan.payAmount,
          payCurrency: order.plan.payCurrency,
          trafficBytes: order.plan.trafficBytes,
          llmQuota: order.plan.llmQuota,
        },
      };
    };
    window.electron.bundle.createOrder = async () => {
      throw new Error('unexpected duplicate gateway order creation');
    };
  }, serverStatus);
}

test.describe('gateway account and daily use', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness');

  test('order recovery, exactly-once meters and the next chat use real C2 @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByRole('button', { name: 'Recharge', exact: true }).click();
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'gw-bundle-1');

    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Recharge', exact: true }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'gw-bundle-1');
    await page.reload();
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByRole('button', { name: 'Recharge', exact: true }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'gw-bundle-1');

    const success = page.getByTestId('recharge-success');
    await expect(success).toBeVisible({ timeout: 45_000 });
    await expect(success).toContainText('10.5 GB');
    await expect(success).toContainText(/51,650,000 tokens/);
    const before = await page.evaluate(async () => (await window.electron.bundle.getMeters()).meters);
    await page.evaluate(async () => {
      await window.electron.bundle.getOrder({ orderId: 'gw-bundle-1' });
      await window.electron.bundle.getOrder({ orderId: 'gw-bundle-1' });
    });
    const after = await page.evaluate(async () => (await window.electron.bundle.getMeters()).meters);
    expect(after.llm).toEqual(before.llm);

    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByPlaceholder('Type a message…').fill('next message after gateway recharge');
    await page.getByTestId('chat-composer-input').press('Enter');
    await expect(page.getByText('Gateway fixture online.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await attachScreen(testInfo, page, 'gateway-recharge-next-chat');
  });

  test('an expired unpaid order reconciles to credited before another order is allowed @gateway', async ({ page }) => {
    await page.goto('/app/');
    await installExpiredOrder(page, 1);
    await page.reload();
    await installExpiredOrder(page, 1);
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByRole('button', { name: 'Recharge', exact: true }).click();
    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeDisabled();

    await page.evaluate(() => window.localStorage.setItem('idbots.fixture.expiryServerStatus', '3'));
    await page.getByRole('button', { name: 'Resume current order' }).click();
    await expect(page.getByTestId('recharge-success')).toBeVisible();
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeEnabled();
  });

  test('settings and global memory persist without exposing provider secrets @gateway', async ({ page }, testInfo) => {
    try {
      await page.goto('/app/');
      await page.getByRole('button', { name: 'Me', exact: true }).click();
      // A6: memory toggles live on the memory page, language/theme on general.
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
