import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

interface ExpiryScenario {
  expiresAt: number;
  serverStatus: number;
  malformed?: boolean;
}

async function installExpiryScenario(page: Page, scenario: ExpiryScenario): Promise<void> {
  await page.evaluate((input) => {
    const orderKey = 'idbots.mobile.bundleOrder.v1';
    const statusKey = 'idbots.fixture.expiryServerStatus';
    const countKey = 'idbots.fixture.expiryReconciliationCount';
    window.localStorage.setItem(statusKey, String(input.serverStatus));
    if (!window.localStorage.getItem(countKey)) window.localStorage.setItem(countKey, '0');
    if (input.malformed) {
      window.localStorage.setItem(orderKey, JSON.stringify({ orderId: 'bo_expiry', expiresAt: input.expiresAt }));
    } else {
      const existing = JSON.parse(window.localStorage.getItem(orderKey) ?? 'null');
      if (!existing) {
        const now = Date.now();
        window.localStorage.setItem(orderKey, JSON.stringify({
          orderId: 'bo_expiry',
          qrCode: 'https://qr.alipay.com/expired-order',
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
          expiresAt: input.expiresAt,
          status: 1,
          createdAtMs: now,
        }));
      }
    }
    window.electron.bundle.getOrder = async ({ orderId }) => {
      if (orderId !== 'bo_expiry') return { success: false, error: 'unexpected order id' };
      window.localStorage.setItem(countKey, String(Number(window.localStorage.getItem(countKey) ?? 0) + 1));
      const order = JSON.parse(window.localStorage.getItem(orderKey) ?? '{}');
      const status = Number(window.localStorage.getItem(statusKey));
      return {
        success: true,
        order: {
          orderId,
          planId: order.plan?.planId ?? 'bundle_basic_cny',
          status,
          payAmount: order.plan?.payAmount ?? '129.00',
          payCurrency: order.plan?.payCurrency ?? 'CNY',
          trafficBytes: order.plan?.trafficBytes ?? 104857600,
          llmQuota: order.plan?.llmQuota ?? 2000000,
        },
      };
    };
    window.electron.bundle.createOrder = async () => {
      const countKey = 'idbots.fixture.unexpectedDuplicateCreates';
      const count = Number(window.localStorage.getItem(countKey) ?? 0) + 1;
      window.localStorage.setItem(countKey, String(count));
      throw new Error('unexpected duplicate order creation');
    };
  }, scenario);
}

async function openRecharge(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Me', exact: true }).click();
  await page.getByRole('button', { name: 'Recharge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recharge', exact: true })).toBeVisible();
}

async function reconciliationCount(page: Page): Promise<number> {
  return page.evaluate(() => Number(window.localStorage.getItem('idbots.fixture.expiryReconciliationCount') ?? 0));
}

// S9 (ME credits): the bundle/Alipay order-expiry flow is retired. Skipped
// (not deleted) pending owner confirmation; see recharge.spec.ts for the
// replacement coverage.
test.describe.skip('recharge expiry reconciliation [retired by S9]', () => {
  test('an order credited after local expiry reaches success without a duplicate', async ({ page }) => {
    const scenario = { expiresAt: Math.floor(Date.now() / 1000) - 60, serverStatus: 3 };
    await page.goto('/app/');
    await installExpiryScenario(page, scenario);
    await page.reload();
    await installExpiryScenario(page, scenario);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-success')).toBeVisible();
    expect(await reconciliationCount(page)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeEnabled();
    expect(await page.evaluate(() => window.localStorage.getItem('idbots.fixture.unexpectedDuplicateCreates'))).toBeNull();
  });

  test('an expired unpaid order stays blocked until the server later credits it', async ({ page }) => {
    const scenario = { expiresAt: Math.floor(Date.now() / 1000) - 60, serverStatus: 1 };
    await page.goto('/app/');
    await installExpiryScenario(page, scenario);
    await page.reload();
    await installExpiryScenario(page, scenario);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    expect(await reconciliationCount(page)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeDisabled();

    await page.evaluate(() => window.localStorage.setItem('idbots.fixture.expiryServerStatus', '3'));
    await page.getByRole('button', { name: 'Resume current order' }).click();
    await expect(page.getByTestId('recharge-success')).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem('idbots.fixture.unexpectedDuplicateCreates'))).toBeNull();
  });

  test('invalid expiry fails closed until the authoritative closed status arrives', async ({ page }) => {
    const scenario = { expiresAt: 0, serverStatus: 1 };
    await page.goto('/app/');
    await installExpiryScenario(page, scenario);
    await page.reload();
    await installExpiryScenario(page, scenario);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeDisabled();

    await page.evaluate(() => window.localStorage.setItem('idbots.fixture.expiryServerStatus', '4'));
    await page.getByRole('button', { name: 'Resume current order' }).click();
    await expect(page.getByText('The order was closed. Please order again.')).toBeVisible();
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeEnabled();
  });

  test('malformed recovery data blocks creation instead of being treated as no order', async ({ page }) => {
    const scenario = { expiresAt: 0, serverStatus: 1, malformed: true };
    await page.goto('/app/');
    await installExpiryScenario(page, scenario);
    await page.reload();
    await installExpiryScenario(page, scenario);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-uncertain')).toContainText('stored order recovery data is invalid');
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeDisabled();
    expect(await reconciliationCount(page)).toBe(0);
  });
});
