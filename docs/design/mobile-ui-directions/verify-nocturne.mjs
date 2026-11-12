import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const worktreeRoot = path.resolve(projectDir, '../../..');
const candidates = [
  path.join(worktreeRoot, 'node_modules', 'playwright'),
  path.join(worktreeRoot, '../..', 'node_modules', 'playwright'),
];
const playwrightPath = candidates.find((candidate) => fs.existsSync(candidate));
if (!playwrightPath) throw new Error('Playwright was not found.');
const { chromium } = require(playwrightPath);
const baseUrl = 'http://127.0.0.1:4179';
const screenshotDir = path.join(projectDir, 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

async function verifyLight() {
  const page = await browser.newPage({ viewport: { width: 520, height: 1100 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${baseUrl}/design-demos/nocturne.html?appearance=light`, { waitUntil: 'load' });
  const appearance = await page.locator('#phone').getAttribute('data-appearance');
  if (appearance !== 'light') errors.push(`Expected light appearance, received ${appearance}.`);
  await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: path.join(screenshotDir, 'nocturne-light.png'), fullPage: true, animations: 'disabled' });

  const selectedColor = await page.locator('.tab[aria-selected="true"]').evaluate((element) => getComputedStyle(element).color);
  if (selectedColor !== 'rgb(107, 82, 0)') errors.push(`Unexpected light accent color: ${selectedColor}.`);

  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, 'nocturne-light-tasks.png'), fullPage: true, animations: 'disabled' });
  await page.locator('[data-screen="tasks"] [data-open-plan]').click();
  await page.locator('#planLayer.open').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(screenshotDir, 'nocturne-light-plan.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const input = page.getByPlaceholder('Message Twin');
  await input.fill('Light appearance verification');
  await input.press('Enter');
  if ((await input.inputValue()) !== '') errors.push('Composer did not clear.');
  await page.getByRole('button', { name: 'Dark appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Light appearance', exact: true }).click();
  await page.close();
  return { id: 'nocturne-light', ok: errors.length === 0, errors };
}

async function verifyComparison() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1300 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${baseUrl}/nocturne-compare.html`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(screenshotDir, 'nocturne-comparison.png'), fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  for (const frame of page.frames().filter((item) => item !== page.mainFrame())) {
    const visible = await frame.locator('[data-screen="tasks"]').isVisible();
    if (!visible) errors.push(`Tasks did not open in ${frame.url()}.`);
  }
  await page.screenshot({ path: path.join(screenshotDir, 'nocturne-compare-tasks.png'), fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: 'Expanded plan', exact: true }).click();
  for (const frame of page.frames().filter((item) => item !== page.mainFrame())) {
    await frame.locator('#planLayer.open').waitFor({ state: 'visible' });
  }
  await page.screenshot({ path: path.join(screenshotDir, 'nocturne-compare-plan.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.close();
  return { id: 'nocturne-comparison', ok: errors.length === 0, errors };
}

for (const verify of [verifyLight, verifyComparison]) {
  try {
    results.push(await verify());
  } catch (error) {
    results.push({ id: verify.name, ok: false, errors: [error.message] });
  }
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
