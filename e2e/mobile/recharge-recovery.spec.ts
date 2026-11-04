import { test, expect, attachScreen } from './fixtures';
import type { Page } from '@playwright/test';

interface OrderHarnessOptions {
  missingQrOnCall?: number;
  createFailure?: 'accepted-lost' | 'generic-rejection' | 'authoritative-rejection';
}

async function installOrderHarness(page: Page, options: OrderHarnessOptions = {}): Promise<void> {
  await page.evaluate((opts) => {
    const bundle = window.electron.bundle;
    const savedOptions = JSON.parse(window.localStorage.getItem('idbots.fixture.rechargeHarnessOptions') ?? '{}');
    const effectiveOptions = { ...savedOptions, ...opts };
    window.localStorage.setItem('idbots.fixture.rechargeHarnessOptions', JSON.stringify(effectiveOptions));
    let createCalls = Number(window.localStorage.getItem('idbots.fixture.rechargeCreateCalls') ?? 0);
    const orderPlans = new Map<string, string>();
    let plans: NonNullable<Awaited<ReturnType<typeof bundle.getPlans>>['plans']> = [];
    const loadPlans = async () => {
      if (!plans.length) {
        const result = await bundle.getPlans();
        plans = result.plans ?? [];
      }
      return plans;
    };
    bundle.createOrder = async ({ planId }) => {
      createCalls += 1;
      window.localStorage.setItem('idbots.fixture.rechargeCreateCalls', String(createCalls));
      if (effectiveOptions.createFailure === 'generic-rejection' && createCalls === 1) {
        return { success: false, error: 'fixture HTTP 500', errorCode: 'BUNDLE_ORDER_OUTCOME_UNCERTAIN' };
      }
      if (effectiveOptions.createFailure === 'authoritative-rejection' && createCalls === 1) {
        return { success: false, error: 'fixture business rejection', errorCode: 'BUNDLE_ORDER_REJECTED' };
      }
      const catalog = await loadPlans();
      const plan = catalog.find((entry) => entry.planId === planId);
      if (!plan) return { success: false, error: 'unknown fixture plan', errorCode: 'BUNDLE_ORDER_REJECTED' };
      const orderId = `bo_harness_${createCalls}`;
      orderPlans.set(orderId, planId);
      const order = {
        orderId,
        planId,
        payAmount: plan.payAmount,
        payCurrency: plan.payCurrency,
        trafficBytes: plan.trafficBytes,
        llmQuota: plan.llmQuota,
        gatewayParams: {
          qrCode: effectiveOptions.missingQrOnCall === createCalls ? '' : `https://qr.alipay.com/harness-${createCalls}`,
        },
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      if (effectiveOptions.createFailure === 'accepted-lost' && createCalls === 1) {
        throw new Error('fixture connection lost after server accepted the order');
      }
      return { success: true, order };
    };
    bundle.getOrder = async ({ orderId }) => {
      const catalog = await loadPlans();
      const planId = orderPlans.get(orderId) ?? catalog[0].planId;
      const plan = catalog.find((entry) => entry.planId === planId) ?? catalog[0];
      return {
        success: true,
        order: {
          orderId,
          planId: plan.planId,
          status: 1,
          payAmount: plan.payAmount,
          payCurrency: plan.payCurrency,
          trafficBytes: plan.trafficBytes,
          llmQuota: plan.llmQuota,
        },
      };
    };
  }, options);
}

async function openRecharge(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Me', exact: true }).click();
  await page.getByRole('button', { name: 'Recharge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recharge', exact: true })).toBeVisible();
}

async function createCalls(page: Page): Promise<number> {
  return page.evaluate(() => Number(window.localStorage.getItem('idbots.fixture.rechargeCreateCalls') ?? 0));
}

// S9 (ME credits): the bundle/Alipay order-recovery flow is retired. These
// cases stay skipped (not deleted) until the owner confirms removing the old
// cashier specs; the live recharge path is covered by recharge.spec.ts.
test.describe.skip('recharge recovery [retired by S9]', () => {
  test('leaving and reloading restores the same order without creating another', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await installOrderHarness(page);
    await openRecharge(page);
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_1');

    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByTestId('recharge-pending-order')).toBeVisible();
    expect(await createCalls(page)).toBe(1);
    await page.getByRole('button', { name: 'Resume current order' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await openRecharge(page);
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_1');

    await page.reload();
    await installOrderHarness(page);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_1');
    expect(await createCalls(page)).toBe(1);
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('idbots.mobile.bundleOrder.v1') ?? '{}'));
    expect(stored.qrCode).toBe('https://qr.alipay.com/harness-1');
    expect(stored.status).toBe(1);
    expect(stored.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await attachScreen(testInfo, page, 'recharge-restored-order');
  });

  test('a missing QR on a new order never falls back to the previous order QR', async ({ page }) => {
    await page.goto('/app/');
    await installOrderHarness(page, { missingQrOnCall: 2 });
    await openRecharge(page);
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_1');

    await page.evaluate(() => {
      const key = 'idbots.mobile.bundleOrder.v1';
      const stored = JSON.parse(window.localStorage.getItem(key) ?? '{}');
      stored.status = 3;
      window.localStorage.setItem(key, JSON.stringify(stored));
    });
    await page.reload();
    await installOrderHarness(page);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-success')).toBeVisible();
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();

    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    expect(await createCalls(page)).toBe(2);
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('idbots.mobile.bundleOrder.v1') ?? '{}'));
    expect(stored.orderId).toBe('bo_harness_2');
    expect(stored.qrCode).toBe('');
    expect(JSON.stringify(stored)).not.toContain('harness-1');
    await expect(page.getByTestId('recharge-qr')).toHaveCount(0);
  });

  test('a server-accepted create with a lost response never creates a duplicate', async ({ page }) => {
    await page.goto('/app/');
    await installOrderHarness(page, { createFailure: 'accepted-lost' });
    await openRecharge(page);
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    expect(await createCalls(page)).toBe(1);
    const accepted = await page.evaluate(async () => (await window.electron.bundle.getOrder({ orderId: 'bo_harness_1' })).order);
    expect(accepted.status).toBe(1);

    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeDisabled();
    const attempt = await page.evaluate(() => JSON.parse(window.localStorage.getItem('idbots.mobile.bundleCreateAttempt.v1') ?? '{}'));
    expect(attempt.retryAfterMs).toBeGreaterThan(Date.now());

    await page.reload();
    await installOrderHarness(page);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    await expect(page.getByTestId('recharge-paying')).toHaveCount(0);
    expect(await createCalls(page)).toBe(1);
  });

  test('a generic create failure stays uncertain and blocks another order', async ({ page }) => {
    await page.goto('/app/');
    await installOrderHarness(page, { createFailure: 'generic-rejection' });
    await openRecharge(page);
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeDisabled();
    expect(await createCalls(page)).toBe(1);
  });

  test('an authoritative business rejection clears the attempt and permits a corrected retry', async ({ page }) => {
    await page.goto('/app/');
    await installOrderHarness(page, { createFailure: 'authoritative-rejection' });
    await openRecharge(page);
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-create-error')).toBeVisible();
    const attempt = await page.evaluate(() => window.localStorage.getItem('idbots.mobile.bundleCreateAttempt.v1'));
    expect(attempt).toBeNull();

    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_2');
    expect(await createCalls(page)).toBe(2);
  });
});
