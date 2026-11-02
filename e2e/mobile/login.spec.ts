import { test, expect, attachScreen } from './fixtures';

/**
 * P1 login flow (REQ-E-10) on the mock loginApi: a brand-new phone needs an
 * invite and the two consents before verify enables, then the preparing
 * screen polls the tenant progression and lands on /app/.
 */

test.describe('login sign-up flow', () => {
  test('invite → consents → preparing → app', async ({ page }, testInfo) => {
    await page.goto('/login');
    await expect(page.getByText('Sign in to IDBots')).toBeVisible();

    await page.getByPlaceholder('Phone number').fill('13800138000');
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByPlaceholder('SMS code').fill('123456');
    await attachScreen(testInfo, page, 'login-code-entered');

    // Both consents are required before the verify button enables at all.
    const checkboxes = page.getByRole('checkbox');
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await attachScreen(testInfo, page, 'login-consents');

    // New account: the first verify is rejected until an invite is entered.
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('An invite code is required to sign up.')).toBeVisible();
    await page.getByPlaceholder('Invite code').fill('E2E-INVITE');
    await attachScreen(testInfo, page, 'login-invite-visible');

    await page.getByRole('button', { name: 'Sign in' }).click();

    // Preparing screen polls provisioning → booting → onboarding → ready.
    await expect(page.getByText('Preparing your Bot')).toBeVisible();
    await attachScreen(testInfo, page, 'login-preparing');
    await page.waitForURL(/\/app\/?$/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'login-landed-in-app');

    // A later cold entry with the session cookie must use getMe and return to
    // the app instead of presenting a fresh login form again.
    await page.goto('/login');
    await page.waitForURL(/\/app\/?$/);
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'login-returning-session-restored');
  });
});
