import { test, expect } from './fixtures';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login?invite=E2E-INVITE');
  await page.getByTestId('login-phone-input').fill('13800138000');
  await page.getByTestId('login-send-code').click();
  await page.getByTestId('login-code-input').fill('123456');
  await page.getByTestId('login-agree-checkbox').check();
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app\/?$/, { timeout: 60_000 });
}

async function openMe(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/app/');
  await page.getByRole('button', { name: 'Me', exact: true }).click();
  await expect(page.getByTestId('me-primary-page')).toBeVisible();
}

test('user and Bot each set a wallet-held NFT through one avatar-setting entry', async ({ page }) => {
  await signIn(page);
  await openMe(page);

  await page.getByTestId('user-card').click();
  await page.getByTestId('profile-avatar-change').click();
  await page.locator('[data-slot="avatar-source-nft"]').click();
  await page.locator('[data-slot="avatar-picker-nft-tile"]').first().click();
  await expect(page.getByTestId('profile-avatar')).toHaveAttribute('data-avatar-state', 'nft');
  await expect(page.getByTestId('profile-avatar').locator('[data-nft-ownership="verified"]')).toHaveCount(1);
  await expect(page.getByTestId('profile-avatar').locator('[data-nft-certified="true"]')).toHaveCount(1);

  await page.getByTestId('me-secondary-back').click();
  await page.getByTestId('me-entry-bots').click();
  await page.getByTestId('bot-row-1').click();
  await page.getByTestId('bot-avatar-change').click();
  await page.locator('[data-slot="avatar-source-nft"]').click();
  await page.locator('[data-slot="avatar-picker-nft-tile"]').first().click();
  await expect(page.getByTestId('bot-avatar-preview')).toHaveAttribute('data-avatar-state', 'nft');
  await expect(page.getByTestId('bot-avatar-preview').locator('[data-nft-ownership="verified"]')).toHaveCount(1);
  await page.getByTestId('bot-save').click();
  await expect(page.getByTestId('me-page-bots')).toBeVisible();
});
