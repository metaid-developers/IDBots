import { test, expect, attachScreen } from './fixtures';

test.describe('mobile Agent Browser', () => {
  test('ABC mobile shell mounts, validates URIs, and preserves tabs across app navigation', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    const frame = page.frameLocator('[data-testid="mobile-browser-frame"]');
    await expect(frame.locator('.browser-shell')).toBeVisible({ timeout: 30_000 });
    const address = frame.locator('.browser-address-form input');
    await expect(address).toBeVisible();
    await address.fill('');
    await address.pressSequentially('metaapp://bad');
    await expect(address).toHaveValue('metaapp://bad');
    await address.press('Enter');
    await expect(frame.getByText('Resolve failed')).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByText('Resource not found.')).toBeVisible();
    await attachScreen(testInfo, page, 'mobile-browser-invalid-uri');

    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await expect(address).toHaveValue('metaapp://bad');
  });

  test('NFT pin links open in the integrated Browser tab', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-entry-nfts').click();
    await page.getByText('Genesis Seed').click();
    await page.getByTestId('nft-open-browser').click();
    const frame = page.frameLocator('[data-testid="mobile-browser-frame"]');
    await expect(frame.locator('.browser-shell')).toBeVisible({ timeout: 30_000 });
    await expect(frame.locator('.browser-address-form input')).toHaveValue(`pin://${'a'.repeat(64)}i0`);
  });

  test('real MetaApp renders inline instead of downloading @gateway', async ({ page }) => {
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await page.goto('/app/');
    await page.evaluate(() => {
      window.electron.userIdentity.get = async () => ({
        success: true,
        identity: { name: 'Gateway User', globalmetaid: 'idq1gatewayuser' },
      });
    });
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    const frame = page.frameLocator('[data-testid="mobile-browser-frame"]');
    await expect(frame.locator('.browser-shell')).toBeVisible({ timeout: 30_000 });
    const address = frame.locator('.browser-address-form input');
    const uri = 'metaapp://7072d9242b5bef351b440b81de35fd087415a48d73e2c2f56931b207d8429aebi0';
    await address.fill(uri);
    await expect(address).toHaveValue(uri);
    await address.press('Enter');
    await expect.poll(
      () => page.frames().some((candidate) => candidate.url().includes('/files/')),
      { timeout: 60_000 },
    ).toBe(true);
    const metaApp = page.frames().find((candidate) => candidate.url().includes('/files/'))!;
    await expect(metaApp.locator('body')).toContainText('人情世故指南');
    expect(downloads).toEqual([]);
  });
});
