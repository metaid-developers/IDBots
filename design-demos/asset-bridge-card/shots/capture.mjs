import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(here, '..');
const shotsDir = path.join(demoDir, 'shots');
const indexUrl = pathToFileURL(path.join(demoDir, 'index.html')).href;
await mkdir(shotsDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));

const shots = [];
let feeDetailsTest = null;
let disabledHoldTest = null;
async function shot(name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(320);
  const file = path.join(shotsDir, name);
  await page.screenshot({ path: file, fullPage: true });
  shots.push(file);
  console.log(`[shot] ${name}`);
}
async function clickAndWait(selector) {
  await page.locator(selector).click();
  await page.waitForTimeout(260);
}
async function resetReview(scenario = 'S2', state = 'quote') {
  await clickAndWait(`#scenarioGroup [data-scenario="${scenario}"]`);
  await clickAndWait(`#stateGroup [data-state="${state}"]`);
}
async function setTheme(theme) {
  await clickAndWait(`#themeGroup [data-theme="${theme}"]`);
}
async function setWidth(width) {
  await clickAndWait(`#widthGroup [data-width="${width}"]`);
}

try {
  await page.goto(indexUrl, { waitUntil: 'load' });
  await page.waitForSelector('.tk-card[data-state="quote"]');
  await page.waitForTimeout(500);

  feeDetailsTest = await page.evaluate(() => {
    const details = document.querySelector('.direction-a .fee-details');
    if (!details) return { found: false, opened: false, closed: false };
    const summary = details.querySelector('summary');
    summary.click();
    const opened = details.open && details.querySelector('.ledger-box').offsetHeight > 0;
    summary.click();
    return { found: true, opened, closed: !details.open };
  });

  await shot('01-quote-S2-dark.png');

  await page.locator('#timeLapseBtn').click();
  await page.evaluate(() => window.AssetBridgeDemo.debugSetProgress(1, 0.45, false));
  await shot('02-bridging-S2-dark.png');

  await page.evaluate(() => window.AssetBridgeDemo.debugSetProgress(1, 0.9, true));
  await shot('03-slow-S2-dark.png');

  await clickAndWait('#stateGroup [data-state="completed"]');
  await shot('04-completed-S2-dark.png');

  await resetReview('S1', 'quote');
  await setTheme('light');
  await shot('05-quote-S1-light.png');

  await setTheme('dark');
  await resetReview('S3', 'quote-insufficient');
  await shot('06-insufficient-S3-dark.png');

  disabledHoldTest = await page.evaluate(async () => {
    const hold = document.querySelector('.direction-c [data-hold-confirm]');
    if (!hold) return { found: false };
    hold.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 1100));
    const fill = hold.querySelector('.hold-fill');
    return {
      found: true,
      disabled: hold.disabled,
      holding: hold.classList.contains('holding'),
      state: hold.closest('.tk-card').dataset.state,
      fillWidth: window.getComputedStyle(fill).width
    };
  });

  await resetReview('S2', 'completed');
  await shot('07-arrival-notice-dark.png');

  await resetReview('S2', 'quote');
  await setWidth('320');
  await shot('08-quote-S2-320px-dark.png');

  await page.evaluate(() => window.AssetBridgeDemo.debugSetProgress(1, 0.45, false));
  await shot('09-bridging-S2-320px-dark.png');

  await setWidth('392');
  await resetReview('S3', 'quote-insufficient');
  await setTheme('light');
  await shot('10-insufficient-S3-light.png');
  await setTheme('dark');

  // Click-test: every direction's real confirm control walks quote -> signing -> bridging -> completed.
  await setWidth('392');
  await resetReview('S2', 'quote');
  const lapsePressed = await page.locator('#timeLapseBtn').getAttribute('aria-pressed');
  if (lapsePressed !== 'true') await page.locator('#timeLapseBtn').click();

  await page.locator('.direction-a [data-action="confirm"]').click();
  await page.locator('.direction-b [data-action="confirm"]').click();

  const hold = page.locator('.direction-c [data-hold-confirm]');
  await hold.hover();
  await page.mouse.down();
  await page.waitForTimeout(1100);
  await page.mouse.up();

  await page.waitForSelector('.direction-a[data-state="bridging"], .direction-a[data-state="bridging-slow"]', { timeout: 5000 });
  await page.waitForSelector('.direction-b[data-state="bridging"], .direction-b[data-state="bridging-slow"]', { timeout: 5000 });
  await page.waitForSelector('.direction-c[data-state="bridging"], .direction-c[data-state="bridging-slow"]', { timeout: 5000 });

  // Use the demo block control three times so the click-test exercises the same engine
  // path without waiting through three x60 ten-minute block intervals.
  for (let i = 0; i < 3; i += 1) {
    await page.locator('#findBlockBtn').click();
    await page.waitForTimeout(180);
  }

  await page.waitForSelector('.direction-a[data-state="completed"]', { timeout: 12000 });
  await page.waitForSelector('.direction-b[data-state="completed"]', { timeout: 12000 });
  await page.waitForSelector('.direction-c[data-state="completed"]', { timeout: 12000 });

  const clickResults = {};
  for (const direction of ['a', 'b', 'c']) {
    clickResults[direction] = await page.locator(`.direction-${direction}`).getAttribute('data-state');
  }
  await writeFile(path.join(shotsDir, 'click-results.json'), JSON.stringify({
    clickResults,
    feeDetailsTest,
    disabledHoldTest,
    consoleErrors,
    pageErrors,
    screenshots: shots.map((file) => path.basename(file))
  }, null, 2));
  console.log(`[click-test] ${JSON.stringify(clickResults)}`);
  console.log(`[fee-details-test] ${JSON.stringify(feeDetailsTest)}`);
  console.log(`[disabled-hold-test] ${JSON.stringify(disabledHoldTest)}`);
  console.log(`[errors] console=${consoleErrors.length} page=${pageErrors.length}`);

  if (consoleErrors.length || pageErrors.length) {
    throw new Error(`console/page errors: ${JSON.stringify({ consoleErrors, pageErrors })}`);
  }
  if (Object.values(clickResults).some((state) => state !== 'completed')) {
    throw new Error(`click-test did not complete: ${JSON.stringify(clickResults)}`);
  }
} finally {
  await browser.close();
}
