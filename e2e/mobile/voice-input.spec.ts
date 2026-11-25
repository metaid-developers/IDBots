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

  test('pressing hold immediately shows Preparing, vibrates on ready, and undulates the waveform with speech', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const vibrateCalls: Array<number | number[]> = [];
      (window as unknown as { __vibrateCalls?: Array<number | number[]> }).__vibrateCalls = vibrateCalls;
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        writable: true,
        value: (pattern: number | number[]) => {
          vibrateCalls.push(pattern);
          return true;
        },
      });

      const NativeWebSocket = window.WebSocket;
      class DelayedOpenWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes('/voice') || String(url).includes('/asr')) {
            this.addEventListener(
              'message',
              (event: MessageEvent) => {
                if (typeof event.data === 'string' && event.data.includes('"asr.open"')) {
                  event.stopImmediatePropagation();
                  const cloned = new MessageEvent('message', { data: event.data });
                  setTimeout(() => {
                    this.onopen; // keep reference alive
                    this.onmessage?.(cloned);
                  }, 420);
                }
              },
              { capture: true },
            );
          }
        }
      }
      window.WebSocket = DelayedOpenWebSocket as unknown as typeof WebSocket;
    });

    await page.goto('/app/?voiceMockMic=1');
    await expectAppShell(page);
    await startNewChatViaPicker(page);

    await touchTap(page, 'voice-btn-idle');
    const holdButton = page.getByTestId('voice-hold-button');
    await expect(holdButton).toBeVisible();

    const box = await holdButton.boundingBox();
    if (!box) throw new Error('voice-hold-button has no boundingBox');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();

    // 1. Immediate Preparing UI before ASR handshake completes, with ZERO premature vibration.
    const preparingOverlay = page.getByTestId('voice-overlay-preparing');
    await expect(preparingOverlay).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId('voice-overlay-text')).toContainText('speak after the vibration');
    expect(
      await page.evaluate(() => (window as unknown as { __vibrateCalls?: unknown[] }).__vibrateCalls?.length ?? 0),
    ).toBe(0);
    await attachScreen(testInfo, page, 'voice-preparing-state');
    await page.screenshot({ path: shot('voice-preparing-state.png'), fullPage: false });

    // 2. Once BOTH mic capture and `asr.open` are ready, phone vibrates and UI switches to Recording.
    await expect(page.getByTestId('voice-overlay-recording')).toBeVisible({ timeout: 10_000 });
    expect(
      await page.evaluate(() => (window as unknown as { __vibrateCalls?: unknown[] }).__vibrateCalls),
    ).toEqual([35]);

    // 3. Waveform bars actively undulate with live speech input while partials stream in.
    await expect(page.getByTestId('voice-overlay-text')).toContainText('今天天气怎么样', { timeout: 15_000 });
    const readBarHeights = () =>
      page.getByTestId('voice-level-bar').evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).style.height),
      );
    const sampleA = await readBarHeights();
    await page.waitForTimeout(120);
    const sampleB = await readBarHeights();
    expect(sampleA.length).toBe(15);
    expect(sampleB).not.toEqual(sampleA);

    await attachScreen(testInfo, page, 'voice-recording-wave');
    await page.screenshot({ path: shot('voice-recording-wave.png'), fullPage: false });

    await page.mouse.up();
    await expect(page.getByTestId('chat-user-message').last()).toHaveText('今天天气怎么样？', { timeout: 15_000 });
  });
});
