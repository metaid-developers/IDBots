// Probe: why is shouldUseMockMic() false inside the app? (one-off)
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${process.env.E2E_BASE_URL || 'http://localhost:5198'}/app/?voiceMockMic=1`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const info = await page.evaluate(async () => {
  const out = { href: location.href, search: location.search };
  try {
    const mod = await import('/src/mobile/app/voice/mockMic.ts');
    out.shouldUseMockMic = mod.shouldUseMockMic();
  } catch (e) {
    out.mockImportError = String(e);
  }
  try {
    const flags = await import('/src/mobile/buildFlags.ts');
    out.MOCK_LOGIN_API = flags.MOCK_LOGIN_API;
  } catch (e) {
    out.flagsImportError = String(e);
  }
  return out;
});
console.log('[probe]', JSON.stringify(info, null, 1));
await browser.close();
