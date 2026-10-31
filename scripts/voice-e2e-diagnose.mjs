// One-off voice e2e diagnosis (not part of the suite).
import { chromium } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5196';

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  ...{ viewport: { width: 412, height: 915 } },
  permissions: ['microphone'],
});
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') console.log('[console]', msg.type(), msg.text());
});
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto(`${BASE_URL}/app/`);
await page.waitForSelector('[data-testid="session-new-chat"], nav');
await page.getByRole('button', { name: 'Sessions' }).click().catch(() => {});
await page.getByTestId('session-new-chat').click().catch(() => {});
await page.getByTestId('bot-picker-list').getByRole('button').first().click().catch(() => {});
await page.waitForTimeout(500);

// Probe the raw browser APIs first.
const probe = await page.evaluate(async () => {
  const out = { hasMediaDevices: !!navigator.mediaDevices, hasWorklet: typeof AudioWorklet !== 'undefined' };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    out.gumOk = true;
    out.tracks = stream.getAudioTracks().map((t) => t.label);
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    out.gumOk = false;
    out.gumError = String(e);
  }
  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    out.ctxRate = ctx.sampleRate;
    out.ctxState = ctx.state;
    await ctx.close();
  } catch (e) {
    out.ctxError = String(e);
  }
  return out;
});
console.log('[probe]', JSON.stringify(probe));

const mic = page.locator('[data-testid^="voice-btn"]');
console.log('[before]', await mic.getAttribute('data-testid'));
await mic.click();
for (let i = 0; i < 20; i += 1) {
  await page.waitForTimeout(500);
  const id = await mic.getAttribute('data-testid');
  console.log(`[${i}]`, id, 'value=', JSON.stringify(await page.locator('textarea').inputValue()));
  if (id === 'voice-btn-recording') break;
  if (id === 'voice-btn-error') {
    console.log('[error-text]', await page.locator('[data-testid="voice-error-text"]').textContent());
    break;
  }
}
await browser.close();
