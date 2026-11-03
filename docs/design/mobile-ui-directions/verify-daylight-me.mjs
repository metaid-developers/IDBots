import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const worktreeRoot = path.resolve(projectDir, '../../..');
const candidates = [path.join(worktreeRoot, 'node_modules', 'playwright'), path.join(worktreeRoot, '../..', 'node_modules', 'playwright')];
const playwrightPath = candidates.find((candidate) => fs.existsSync(candidate));
if (!playwrightPath) throw new Error('Playwright was not found.');
const { chromium } = require(playwrightPath);
const screenshotDir = path.join(projectDir, 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 520, height: 1100 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

async function open(suffix, pageName) {
  await page.goto(`http://127.0.0.1:4179/design-demos/daylight-me.html${suffix}`, { waitUntil: 'load' });
  if (pageName) await page.locator(`[data-page="${pageName}"].open`).waitFor({ state: 'visible' });
  await page.waitForTimeout(280);
}

try {
  await open('');
  await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: path.join(screenshotDir, 'daylight-me.png'), fullPage: true, animations: 'disabled' });

  await open('?page=general', 'general');
  await page.screenshot({ path: path.join(screenshotDir, 'daylight-me-general.png'), fullPage: true, animations: 'disabled' });
  const memoryReview = page.getByRole('switch', { name: 'Memory review', exact: true });
  await memoryReview.click();
  if ((await memoryReview.getAttribute('aria-checked')) !== 'true') errors.push('Memory review switch did not turn on.');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  if ((await page.locator('#phone').getAttribute('data-appearance')) !== 'dark') errors.push('Dark appearance did not apply.');
  await page.getByRole('button', { name: 'Light', exact: true }).click();

  await open('?page=bots', 'bots');
  await page.getByRole('button', { name: /Twin Bot Personal companion/ }).click();
  await page.locator('[data-page="botEdit"].open').waitFor({ state: 'visible' });
  await page.waitForTimeout(280);
  await page.screenshot({ path: path.join(screenshotDir, 'daylight-me-bot-basic.png'), fullPage: true, animations: 'disabled' });

  await page.getByRole('tab', { name: 'Model', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, 'daylight-me-bot-model.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('tab', { name: 'Chat settings', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, 'daylight-me-bot-chat.png'), fullPage: true, animations: 'disabled' });

  await page.getByRole('tab', { name: 'Basic', exact: true }).click();
  const name = page.locator('#botName');
  await name.fill('Twin Bot Updated');
  if (await page.locator('#saveBot').isDisabled()) errors.push('Save did not become enabled after editing.');
  await page.locator('#saveBot').click();
  if (!(await page.locator('#saveBot').isDisabled())) errors.push('Save did not return to a clean state.');
  await page.locator('[data-page="botEdit"] [data-back]').click();
  await page.locator('[data-page="bots"] [data-back]').click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'Me', exact: true }).click();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) errors.push('Horizontal overflow detected.');
} catch (error) {
  errors.push(error.message);
}

await browser.close();
console.log(JSON.stringify([{ id: 'daylight-me', ok: errors.length === 0, errors }], null, 2));
if (errors.length) process.exitCode = 1;
