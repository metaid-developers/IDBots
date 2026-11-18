import { test, expect, attachScreen, expectAppShell, startNewChatViaPicker } from './fixtures';

const shotDir = process.env.VOICE_SHOT_DIR || 'test-results/voice-shots';
const shot = (name: string) => `${shotDir}/${name}`;

test.use({
  launchOptions: {
    args: ['--autoplay-policy=no-user-gesture-required'],
  },
});

async function holdAndRelease(page: import('@playwright/test').Page, testId: string): Promise<void> {
  const surface = page.getByTestId(testId);
  const box = await surface.boundingBox();
  if (!box) throw new Error(`${testId} has no press surface`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('voice-overlay-recording')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('voice-overlay-text')).toContainText('今天天气怎么样', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.mouse.up();
}

async function touchTap(page: import('@playwright/test').Page, testId: string): Promise<void> {
  const surface = page.getByTestId(testId);
  const box = await surface.boundingBox();
  if (!box) throw new Error(`${testId} has no press surface`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe('voice input @voice', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'voice e2e targets the pixel7 chromium project');
  test.skip(() => process.env.VOICE_E2E !== '1', 'requires the voice stub runner (VOICE_E2E=1)');

  test('holding the mic in text mode releases to send without switching the composer', async ({ page }, testInfo) => {
    await page.goto('/app/?voiceMockMic=1');
    await expectAppShell(page);
    await startNewChatViaPicker(page);
    const textarea = page.getByTestId('chat-composer-input');
    await expect(textarea).toHaveValue('');

    await holdAndRelease(page, 'voice-btn-idle');

    await expect(page.getByTestId('chat-user-message').last()).toHaveText('今天天气怎么样？', { timeout: 15_000 });
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue('');
    await expect(page.getByTestId('voice-hold-button')).toHaveCount(0);
    await expect(page.getByTestId('voice-error')).toHaveCount(0);
    await attachScreen(testInfo, page, 'voice-direct-hold-sent');
    await page.screenshot({ path: shot('voice-direct-hold-sent.png'), fullPage: false });
  });

  test('touch taps switch modes without mic access, hold sends, and the text draft survives', async ({ page }, testInfo) => {
    await page.goto('/app/?voiceMockMic=1');
    await expectAppShell(page);
    await startNewChatViaPicker(page);
    const textarea = page.getByTestId('chat-composer-input');
    await textarea.fill('帮我记录：');

    await page.evaluate(() => {
      (window as unknown as { __voiceMockMicCalls?: number }).__voiceMockMicCalls = 0;
    });
    await touchTap(page, 'voice-btn-idle');
    const holdButton = page.getByTestId('voice-hold-button');
    await expect(holdButton).toHaveText('Hold to talk');
    await expect(page.getByTestId('voice-keyboard-button')).toBeVisible();
    await expect(textarea).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __voiceMockMicCalls?: number }).__voiceMockMicCalls)).toBe(0);
    await attachScreen(testInfo, page, 'voice-wide-hold-mode');
    await page.screenshot({ path: shot('voice-wide-hold-mode.png'), fullPage: false });

    await touchTap(page, 'voice-hold-button');
    await expect(holdButton).toBeVisible();
    await expect(page.getByTestId('voice-hint')).toContainText('Pressed too briefly');
    expect(await page.evaluate(() => (window as unknown as { __voiceMockMicCalls?: number }).__voiceMockMicCalls)).toBe(0);
    await holdAndRelease(page, 'voice-hold-button');
    expect(await page.evaluate(() => (window as unknown as { __voiceMockMicCalls?: number }).__voiceMockMicCalls)).toBe(1);
    await expect(page.getByTestId('chat-user-message').last()).toHaveText('今天天气怎么样？', { timeout: 15_000 });

    await touchTap(page, 'voice-keyboard-button');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue('帮我记录：');
    await expect(page.getByTestId('voice-btn-idle')).toBeVisible();
    await expect(page.getByTestId('voice-error')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __voiceMockMicCalls?: number }).__voiceMockMicCalls)).toBe(1);

    await page.getByTestId('voice-btn-idle').click();
    await expect(holdButton).toHaveText('Hold to talk');
    await page.getByTestId('voice-keyboard-button').click();
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue('帮我记录：');
    expect(await page.evaluate(() => (window as unknown as { __voiceMockMicCalls?: number }).__voiceMockMicCalls)).toBe(1);
  });
});
