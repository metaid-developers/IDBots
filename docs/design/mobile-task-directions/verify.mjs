import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const baseUrl = process.env.DESIGN_BASE_URL || 'http://127.0.0.1:4181/docs/design/mobile-task-directions';
const screenshotDir = path.join(projectDir, 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const directions = ['now-deck', 'native-library', 'task-pulse'];

async function verifyDirection(name) {
  const page = await browser.newPage({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const check = (condition, message) => { if (!condition) errors.push(message); };
  try {
    await page.goto(`${baseUrl}/design-demos/${name}.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
    const layout = await page.evaluate(() => {
      const phone = document.querySelector('.phone').getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
      const chat = document.querySelector('[data-task-id="t1"] [data-chat]').getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        phoneWidth: phone.width,
        phoneHeight: phone.height,
        navTop: nav.top,
        navBottom: nav.bottom,
        chatBottom: chat.bottom,
      };
    });
    check(layout.documentWidth <= layout.viewportWidth, `Horizontal overflow: ${JSON.stringify(layout)}`);
    check(Math.abs(layout.phoneWidth - 393) < 1, `Phone width is not 393: ${layout.phoneWidth}`);
    check(Math.abs(layout.phoneHeight - 852) < 1, `Phone height is not 852: ${layout.phoneHeight}`);
    check(layout.navTop >= 0 && layout.navBottom <= layout.viewportHeight + 1, `Bottom navigation is clipped: ${JSON.stringify(layout)}`);
    check(layout.chatBottom <= layout.navTop, `First task chat action is below the navigation: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), animations: 'disabled' });

    await page.locator('[data-task-id="t1"] [data-details]').last().click();
    await page.getByText('Acceptance criteria', { exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(screenshotDir, `${name}-detail.png`), animations: 'disabled' });
    await page.locator('.detail-footer [data-chat]').click();
    await page.locator('.chat-task-link').waitFor({ state: 'visible' });
    check((await page.locator('.chat-heading').textContent()).includes('Launch the mobile task center'), 'Linked chat lost task context.');
    await page.screenshot({ path: path.join(screenshotDir, `${name}-chat.png`), animations: 'disabled' });
    await page.locator('[data-back]').click();
    await page.locator('.detail-nav [data-back]').click();

    await page.locator('[data-open-filter]').click();
    await page.locator('.sheet-option[data-status-select="waiting_owner"]').click();
    await page.locator('[data-task-id="t2"]').waitFor({ state: 'visible' });
    check(await page.locator('[data-task-id="t1"]').count() === 0, 'Status filter did not exclude In progress tasks.');
    await page.locator('[data-open-filter]').click();
    await page.locator('.sheet-option[data-status-select="all"]').click();
    await page.locator('[data-search]').fill('skill');
    check(await page.locator('[data-task-id="t4"]').count() === 1, 'Search did not find the skill catalog task.');
    check(await page.locator('[data-task-id="t1"]').count() === 0, 'Search did not narrow the task list.');
    await page.locator('[data-search]').fill('');
    await page.locator('[data-open-filter]').click();
    await page.locator('.sheet-option[data-status-select="in_progress"]').click();

    await page.getByRole('tab', { name: 'Scheduled', exact: true }).click();
    await page.getByText('Morning MetaWeb brief', { exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(screenshotDir, `${name}-scheduled.png`), animations: 'disabled' });
    await page.locator('[data-schedule-run="sc1"]').click();
    await page.getByText('Running now', { exact: true }).waitFor({ state: 'visible' });
    await page.waitForTimeout(1300);
    await page.getByText('Completed · Just now', { exact: true }).waitFor({ state: 'visible' });
    await page.locator('[data-schedule-toggle="sc1"]').click();
    check(await page.locator('[data-schedule-toggle="sc1"]').getAttribute('aria-checked') === 'false', 'Schedule switch did not disable.');
    await page.locator('[data-schedule-new]').first().click();
    await page.locator('#schedule-name').fill('Design verification schedule');
    await page.locator('[data-schedule-save]').click();
    await page.getByText('Design verification schedule', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await page.getByText('Today, 09:00 · Completed · 1m 42s', { exact: true }).waitFor({ state: 'visible' });

    await page.goto(`${baseUrl}/design-demos/${name}.html?appearance=dark`, { waitUntil: 'networkidle' });
    check(await page.locator('.phone').getAttribute('data-appearance') === 'dark', 'Dark appearance query did not apply.');
    await page.screenshot({ path: path.join(screenshotDir, `${name}-dark.png`), animations: 'disabled' });
    await page.close();

    const desktop = await browser.newPage({ viewport: { width: 900, height: 1080 }, deviceScaleFactor: 1 });
    desktop.on('pageerror', (error) => errors.push(error.message));
    await desktop.goto(`${baseUrl}/design-demos/${name}.html`, { waitUntil: 'networkidle' });
    await desktop.locator('[data-appearance-toggle]').click();
    check(await desktop.locator('.phone').getAttribute('data-appearance') === 'dark', 'Appearance toggle did not switch to dark.');
    await desktop.locator('[data-appearance-toggle]').click();
    check(await desktop.locator('.phone').getAttribute('data-appearance') === 'light', 'Appearance toggle did not restore light.');
    await desktop.goto(pathToFileURL(path.join(projectDir, 'design-demos', `${name}.html`)).href, { waitUntil: 'load' });
    await desktop.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0));
    await desktop.locator('[data-task-id="t1"] [data-chat]').first().click();
    await desktop.locator('.chat-task-link').waitFor({ state: 'visible' });
    await desktop.close();
  } catch (error) {
    errors.push(error.stack || error.message);
    await page.close().catch(() => {});
  }
  return { id: name, ok: errors.length === 0, errors };
}

for (const direction of directions) results.push(await verifyDirection(direction));

try {
  const overview = await browser.newPage({ viewport: { width: 1440, height: 1120 }, deviceScaleFactor: 1 });
  const errors = [];
  overview.on('pageerror', (error) => errors.push(error.message));
  await overview.goto(`${baseUrl}/index.html`, { waitUntil: 'networkidle' });
  await overview.screenshot({ path: path.join(screenshotDir, 'overview.png'), fullPage: true, animations: 'disabled' });
  await overview.locator('#appearance').click();
  await overview.waitForTimeout(500);
  for (const frame of overview.frames().filter((item) => item !== overview.mainFrame())) {
    const appearance = await frame.locator('.phone').getAttribute('data-appearance');
    if (appearance !== 'dark') errors.push(`Overview appearance did not propagate: ${frame.url()}`);
  }
  await overview.close();
  results.push({ id: 'overview', ok: errors.length === 0, errors });
} catch (error) {
  results.push({ id: 'overview', ok: false, errors: [error.stack || error.message] });
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
