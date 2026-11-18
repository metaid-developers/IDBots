/* Playwright verification for the Live Stage scene-system prototype.
   Requires the local server: python3 -m http.server 4790 --bind 127.0.0.1
   run from the worktree root. Writes screenshots into ./screenshots/.
   Note: LS_PROTO.step(n) is 0-based into the scenario's steps array;
   screenshots are named 1-based (scenario-concurrency-1..N). */
import { chromium } from 'playwright'; // run from a checkout with node_modules installed
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'screenshots');
mkdirSync(OUT, { recursive: true });

const URL = 'http://127.0.0.1:4790/docs/design/live-stage-scenes/index.html';
const STATES = [
  'idle', 'received', 'reasoning', 'recall', 'speaking',
  'local-run', 'local-read', 'making', 'desktop-control', 'browser-action', 'projecting',
  'web-search', 'web-read',
  'chain-read', 'chain-write', 'chain-transfer',
  'delegation', 'waiting', 'worker-report', 'verification', 'private-chat', 'group-task',
  'owner-needed', 'problem', 'report-ready', 'complete',
];
const VARIANT_B = ['web-search', 'web-read', 'chain-read', 'chain-write'];
const STRIP_STATES = [
  'received', 'recall', 'web-search', 'web-read',
  'chain-read', 'chain-write', 'chain-transfer', 'projecting',
  'delegation', 'worker-report', 'verification', 'private-chat', 'group-task',
];
const STRIP_OFFSETS = [400, 900, 1400, 1900];

const consoleErrors = [];
const pageErrors = [];
const assertions = [];
function assert(name, cond, detail) {
  assertions.push({ name, pass: Boolean(cond), detail });
  console.log(`  assert ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.LS_PROTO && document.body.dataset.orbBackend !== 'loading', null, { timeout: 30000 });
await page.waitForTimeout(1200);

const frame = await page.$('.stage-frame');
const backend = await page.evaluate(() => document.body.dataset.orbBackend);
console.log('orb backend:', backend);

async function shotState(id, suffix = '', wait = 2100) {
  await page.evaluate((sid) => window.LS_PROTO.select(sid), id);
  await page.waitForTimeout(wait);
  await frame.screenshot({ path: join(OUT, `state-${id}${suffix}.png`) });
  console.log(`  state-${id}${suffix}.png`);
}

console.log('capturing A-variant states…');
for (const id of STATES) await shotState(id);

console.log('capturing B variants…');
for (const id of VARIANT_B) {
  const place = id.startsWith('web') ? 'web' : 'chain';
  await page.evaluate((p) => window.LS_PROTO.setVariant(p, 'B'), place);
  await shotState(id, '-B');
  await page.evaluate((p) => window.LS_PROTO.setVariant(p, 'A'), place);
}

console.log('capturing event strips (restart + 0.4/0.9/1.4/1.9s)…');
for (const id of STRIP_STATES) {
  await page.evaluate((sid) => window.LS_PROTO.select(sid, { restart: true }), id);
  let prev = 0;
  for (let i = 0; i < STRIP_OFFSETS.length; i += 1) {
    await page.waitForTimeout(STRIP_OFFSETS[i] - prev);
    prev = STRIP_OFFSETS[i];
    await frame.screenshot({ path: join(OUT, `strip-${id}-${i + 1}.png`) });
  }
  console.log(`  strip-${id}-1..4.png`);
}

// assertions on states that need them
await page.evaluate(() => window.LS_PROTO.select('private-chat'));
await page.waitForTimeout(1600);
let dbg = await page.evaluate(() => window.LS_PROTO._debug());
assert('peer arc starts at orb edge', dbg.peerArc && Math.abs(dbg.peerArc.edge) <= 4,
  dbg.peerArc ? `edge=${dbg.peerArc.edge.toFixed(1)}px` : 'no peer arc');

await page.evaluate(() => window.LS_PROTO.select('chain-write'));
await page.waitForTimeout(1200);
dbg = await page.evaluate(() => window.LS_PROTO._debug());
assert('chain head x ≤ 0.92W', dbg.chainHeadX != null && dbg.chainHeadX <= 0.92 * 1280,
  `chainHeadX=${dbg.chainHeadX && dbg.chainHeadX.toFixed(0)} (limit ${(0.92 * 1280).toFixed(0)})`);

console.log('capturing concurrency scenario (all steps, 1-based names)…');
await page.evaluate(() => window.LS_PROTO.playScenario('concurrency'));
await page.waitForTimeout(300);
const stepCount = await page.evaluate(() => window.LS_CATALOG.scenarios.concurrency.steps.length);
console.log(`  ${stepCount} steps`);
for (let n = 0; n < stepCount; n += 1) {
  await page.evaluate((i) => window.LS_PROTO.step(i), n);
  await page.waitForTimeout(1400); // lets the 400ms ring fade complete
  const d = await page.evaluate(() => window.LS_PROTO._debug());
  if (!d.hero || d.hero.type !== 'groups') {
    assert(`step ${n + 1}: no ring members when hero≠groups`, d.members === 0, `members=${d.members}`);
  }
  await frame.screenshot({ path: join(OUT, `scenario-concurrency-${n + 1}.png`) });
}

console.log('capturing companions-override (3w/2p/1g + OT, group-task)…');
await page.evaluate(() => {
  window.LS_PROTO.setCompanions({ workers: 3, peers: 2, groups: 1, ot: true });
  window.LS_PROTO.select('group-task');
});
await page.waitForTimeout(2000);
await frame.screenshot({ path: join(OUT, 'companions-override.png') });
dbg = await page.evaluate(() => window.LS_PROTO._debug());
assert('override: hero is groups', dbg.hero && dbg.hero.type === 'groups', JSON.stringify(dbg.hero));
assert('override: ring members on stage', dbg.members >= 4, `members=${dbg.members}`);
await page.evaluate(() => window.LS_PROTO.setCompanions({ workers: 0, peers: 0, groups: 0 }));

console.log('capturing transients…');
await page.evaluate(() => window.LS_PROTO.select('chain-read'));
await page.waitForTimeout(1600);
for (const tid of ['steer', 'retry', 'model-switch', 'chain-confirmed', 'tool-error']) {
  await page.evaluate((id) => window.LS_PROTO.trigger(id), tid);
  await page.waitForTimeout(tid === 'steer' ? 1100 : 700);
  await frame.screenshot({ path: join(OUT, `transient-${tid}.png`) });
  console.log(`  transient-${tid}.png`);
}

console.log('capturing en-language chain-write…');
await page.evaluate(() => {
  window.LS_PROTO.setLanguage('en');
  window.LS_PROTO.select('chain-write');
});
await page.waitForTimeout(2100);
await frame.screenshot({ path: join(OUT, 'state-chain-write-en.png') });
await page.evaluate(() => window.LS_PROTO.setLanguage('zh'));

console.log('capturing reduced-motion chain-write…');
await page.evaluate(() => { document.querySelector('[data-open-tweaks]').click(); });
await page.waitForTimeout(200);
await page.evaluate(() => {
  const input = document.querySelector('[data-tw="reduced"]');
  if (input && !input.checked) input.click();
});
await page.waitForTimeout(200);
await page.evaluate(() => window.LS_PROTO.select('chain-write'));
await page.waitForTimeout(600);
await frame.screenshot({ path: join(OUT, 'state-chain-write-reduced.png') });
await page.evaluate(() => {
  const input = document.querySelector('[data-tw="reduced"]');
  if (input && input.checked) input.click();
  document.querySelector('[data-close-tweaks]').click();
});

console.log('capturing full page…');
await page.evaluate(() => window.LS_PROTO.select('group-task'));
await page.waitForTimeout(2200);
await page.screenshot({ path: join(OUT, 'page.png'), fullPage: false });

console.log('\n--- assertions:', assertions.filter((a) => !a.pass).length, 'failed of', assertions.length);
console.log('--- console errors:', consoleErrors.length);
consoleErrors.slice(0, 30).forEach((e) => console.log('  CE:', e.slice(0, 220)));
console.log('--- page errors:', pageErrors.length);
pageErrors.slice(0, 30).forEach((e) => console.log('  PE:', e.slice(0, 220)));

await browser.close();
console.log('done.');
