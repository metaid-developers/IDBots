import { test, expect, attachScreen } from './fixtures';

/**
 * P1 login & invite sign-up flow (REQ-E-10 + CR-WSE-005 Variant A):
 * - Segmented Sign in / Invite sign-up tabs with single agreement checkbox;
 * - Submitting a new phone on Sign in switches to Invite sign-up on INVITE_REQUIRED;
 * - `?invite=CODE` auto-selects Invite sign-up, pre-fills code, and renders plan+days badge;
 * - `?invite=CAPFULL` renders the daily capacity soft-gate banner without consuming the code.
 */

test.describe('login sign-up flow', () => {
  test('signin new phone -> auto-switches to invite sign-up -> preparing -> app -> session restore', async ({ page }, testInfo) => {
    await page.goto('/login');
    await expect(page.getByTestId('login-tab-signin')).toBeVisible();
    await expect(page.getByTestId('login-tab-signup')).toBeVisible();

    await page.getByTestId('login-phone-input').fill('13800138000');
    await page.getByTestId('login-send-code').click();
    await page.getByTestId('login-code-input').fill('123456');
    await attachScreen(testInfo, page, 'login-code-entered');

    await page.getByTestId('login-agree-checkbox').check();
    await attachScreen(testInfo, page, 'login-consents');

    // New phone on Sign in tab triggers INVITE_REQUIRED and switches to Invite sign-up tab.
    await page.getByTestId('login-submit').click();
    await expect(page.getByText('An invite code is required to sign up.')).toBeVisible();
    await expect(page.getByTestId('login-invite-input')).toBeVisible();
    await page.getByTestId('login-invite-input').fill('E2E-INVITE');
    await attachScreen(testInfo, page, 'login-invite-visible');

    await page.getByTestId('login-submit').click();

    // Preparing screen polls provisioning -> booting -> onboarding -> ready.
    await expect(page.getByText('Preparing your Bot')).toBeVisible();
    await attachScreen(testInfo, page, 'login-preparing');
    await page.waitForURL(/\/app\/?$/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'login-landed-in-app');

    // Cold entry with session cookie uses getMe and returns directly to /app/.
    await page.goto('/login');
    await page.waitForURL(/\/app\/?$/);
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'login-returning-session-restored');
  });

  test('?invite= pre-fills Invite sign-up tab with plan badge and preserves returnTo', async ({ page }) => {
    const returnTo = '/app/notifications/mock-work-complete';
    await page.goto(`/login?invite=IDB-7K9M-X4&returnTo=${encodeURIComponent(returnTo)}`);

    await expect(page.getByTestId('login-invite-input')).toHaveValue('IDB-7K9M-X4');
    await expect(page.getByTestId('login-invite-perk-badge')).toContainText('ID.Student');
    await expect(page.getByTestId('login-invite-perk-badge')).toContainText('14');

    await page.getByTestId('login-phone-input').fill('13800138001');
    await page.getByTestId('login-send-code').click();
    await page.getByTestId('login-code-input').fill('123456');
    await page.getByTestId('login-agree-checkbox').check();
    await page.getByTestId('login-submit').click();

    await expect(page.getByText('Preparing your Bot')).toBeVisible();
    await page.waitForURL(/\/app\/sessions\/mock-session-1/, { timeout: 60_000 });
    await expect(page.getByTestId('chat-header-title')).toHaveText('Long-term document result');
  });

  test('daily capacity soft gate disables sign-up gracefully when CAPFULL', async ({ page }) => {
    await page.goto('/login?invite=CAPFULL');
    await expect(page.getByTestId('login-capacity-alert')).toContainText('cloud seats are full');
    await expect(page.getByTestId('login-submit')).toBeDisabled();
  });
});
