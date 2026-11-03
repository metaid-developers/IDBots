import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const worktreeRoot = path.resolve(projectDir, '../../..');
const playwrightCandidates = [
  path.join(worktreeRoot, 'node_modules', 'playwright'),
  path.join(worktreeRoot, '../..', 'node_modules', 'playwright'),
];
const playwrightPath = playwrightCandidates.find((candidate) => fs.existsSync(candidate));
if (!playwrightPath) throw new Error('Playwright was not found in the worktree or host checkout.');
const { chromium } = require(playwrightPath);

const directions = [
  { id: 'material', appearance: 'Dark', restore: 'Light' },
  { id: 'cupertino', appearance: 'Dark', restore: 'Light' },
  { id: 'editorial', appearance: 'Dark', restore: 'Light' },
  { id: 'nocturne', appearance: 'Light appearance', restore: 'Dark appearance' },
];
const screenshotDir = path.join(projectDir, 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

async function verifyDirection(direction) {
  const page = await browser.newPage({ viewport: { width: 520, height: 1100 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  const url = pathToFileURL(path.join(projectDir, 'design-demos', `${direction.id}.html`)).href;
  await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
  await page.getByText('Twin Bot', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0), null, { timeout: 15_000 });
  await page.screenshot({ path: path.join(screenshotDir, `${direction.id}.png`), fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: /View plan/ }).first().click();
  await page.getByRole('button', { name: /^(Close|Close plan|Done)$/ }).first().click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).or(page.getByRole('tab', { name: 'Tasks', exact: true })).first().click();
  await page.getByRole('button', { name: 'Me', exact: true }).or(page.getByRole('tab', { name: 'Me', exact: true })).first().click();
  await page.getByRole('button', { name: 'Chat', exact: true }).or(page.getByRole('tab', { name: 'Chat', exact: true })).first().click();
  await page.getByRole('button', { name: 'Add a museum', exact: true }).click();

  const input = page.getByPlaceholder('Message Twin');
  await input.fill('Local UI verification');
  await input.press('Enter');
  const composerCleared = (await input.inputValue()) === '';
  if (!composerCleared) errors.push('Composer did not clear after sending.');

  await page.getByRole('button', { name: direction.appearance, exact: true }).click();
  await page.getByRole('button', { name: direction.restore, exact: true }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) errors.push('Horizontal overflow detected.');
  await page.close();
  return { id: direction.id, ok: errors.length === 0, errors };
}

for (const direction of directions) {
  try {
    results.push(await verifyDirection(direction));
  } catch (error) {
    results.push({ id: direction.id, ok: false, errors: [error.message] });
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1400 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:4179/index.html', { waitUntil: 'networkidle', timeout: 45_000 });
  await page.screenshot({ path: path.join(screenshotDir, 'overview.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'D · Nocturne', exact: true }).click();
  const focused = await page.locator('[data-direction]:visible').count();
  if (focused !== 1) results.push({ id: 'overview-focus', ok: false, errors: [`Expected one focused direction, received ${focused}.`] });
  else results.push({ id: 'overview-focus', ok: true, errors: [] });
  await page.close();
} catch (error) {
  results.push({ id: 'overview', ok: false, errors: [error.message] });
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
