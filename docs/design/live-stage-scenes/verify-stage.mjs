/* Visual verification for the PRODUCTION Live Stage renderer
   (public/live-stage/index.html served from the worktree root).

   States are built with the compiled host model
   (dist-electron/main/services/studioLiveStageModel.js) and pushed through
   IDBotsLiveStage.applyPatch with strictly increasing revisions, exactly as
   the host does. Companion sets and transients are injected where the
   reducer cannot produce them. Screenshots → ./screenshots/stage-*.png
   (git-ignored).

   Requires the worktree-root server on :4790
   (python3 -m http.server 4790 --bind 127.0.0.1). */
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const OUT = join(HERE, 'screenshots');
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(ROOT, 'package.json'));
const model = require(join(ROOT, 'dist-electron/main/services/studioLiveStageModel.js'));

const URL = 'http://127.0.0.1:4790/public/live-stage/index.html?orb=webgl2'; // headless has no WebGPU — force the WebGL2 backend
const NOW = Date.now();
const message = (id, type, metadata = {}, content = '') => ({ id, type, content, timestamp: 1, metadata });
const ctx = { sessionId: 'demo-live-stage', turnId: 'demo-turn-1', botName: 'Nova', language: 'en', directorEnabled: false, nowMs: NOW };

const WORKER = (n, i) => ({ id: `w-${n}`, name: n, avatar: '', direction: i, title: `${n} task`, startedAt: NOW });
const PEER = (id, name, status, preview = '') => ({ id, name, avatar: '', status, preview, updatedAt: NOW });
const GROUP = { id: 'g-demo', title: 'APEC brief', status: 'active', memberCount: 4, openteam: true, updatedAt: NOW, members: [
  { id: 'meta:peer-ren', name: 'Ren', role: 'chair', avatar: '' },
  { id: 'meta:nova', name: 'Nova', self: true, avatar: '' },
  { id: 'meta:peer-jun', name: 'Jun', avatar: '' },
  { id: 'meta:guest-ot', name: 'Rin', openteam: true, avatar: '' },
] };

/* Build the chain of real states. Each entry: [shotName, producer, extra] —
   producer takes the previous state, extra spreads injected fields. */
const tool = (toolName, toolInput) => (s, i) =>
  model.reduceLiveStageMessage(s, message(`vfy-${i}`, 'tool_use', { toolName, toolUseId: `vfy-${i}`, toolInput }), { nowMs: NOW });
const assistant = (meta, content) => (s, i) =>
  model.reduceLiveStageMessage(s, message(`vfy-${i}`, 'assistant', meta, content), { nowMs: NOW });
const direct = (fn, arg) => (s) => fn(s, arg, NOW);

const CHAIN = [
  ['received', (s) => s],
  ['idle', (s) => ({ ...s, revision: s.revision + 1, family: 'idle', motif: 'idle', composition: 'presence', place: 'mind', kicker: 'Nova', headline: '', caption: '' })],
  ['reasoning', assistant({ isThinking: true }, '…')],
  ['local-run', tool('bash')],
  ['local-read', tool('read')],
  ['local-recall', tool('memory_search')],
  ['desktop-control', tool('cua_click')],
  ['projecting', tool('projection_begin')],
  ['making', tool('write')],
  ['browser-action', tool('open_metaapp')],
  ['web2-research', tool('web_search'), { strip: true }],
  ['web-read', tool('web_fetch')],
  ['metaweb-research', tool('omni_reader')],
  ['chain-write', tool('post_simpleanswer'), { strip: true }],
  ['chain-transfer', tool('wallet_transfer'), { strip: true }],
  ['delegation', (s, i) => model.reduceLiveStageMessage(s, message(`vfy-${i}`, 'tool_use', { toolName: 'local_worker_delegate', toolUseId: `vfy-${i}`, toolInput: { workerMetabotId: 7 } }), { workerName: 'Pixel', nowMs: NOW }), { inject: { activeWorkers: [WORKER('Pixel', 'working')], companionFocus: { type: 'workers', id: 'w-Pixel' } } }],
  ['waiting', tool('longterm_subtask_wait'), { inject: { activeWorkers: [WORKER('Pixel', 'waiting')] } }],
  ['worker-report', (s, i) => model.reduceLiveStageMessage(s, message(`vfy-${i}`, 'user', { origin: 'cross_session', sourceChannel: 'idbots_cross_session', sourceSessionId: 'demo-worker-session', crossSessionDeliveryId: `vfy-${i}` }), { workerName: 'Pixel', nowMs: NOW }), { inject: { activeWorkers: [WORKER('Pixel', 'return')], companionFocus: { type: 'workers', id: 'w-Pixel' } } }],
  ['verification', tool('bot_browser_screenshot'), { strip: true }],
  ['private-chat', tool('send_private_chat', { to: 'meta:peer-mira' }), { strip: true, inject: { activePeers: [PEER('meta:peer-mira', 'Mira', 'sending', 'Draft the agenda')], companionFocus: { type: 'peers', id: 'meta:peer-mira' } } }],
  ['group-task', tool('group_chat', { action: 'send_group_message', groupId: 'g-demo' }), { strip: true, inject: { activeGroups: [{ ...GROUP, status: 'posting' }], companionFocus: { type: 'groups', id: 'g-demo' } } }],
  ['owner-needed', (s) => model.presentLiveStageInteraction(s, {
    requestId: 'vfy-ask', token: 'tok', kind: 'ask', title: 'Need a decision',
    detail: '', questions: [{ question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
    expiresAt: null, timeoutDefault: null,
  }, NOW)],
  ['problem', (s) => model.liveStageError(s, undefined, NOW)],
  ['report-ready', (s) => model.reportReadyLiveStage(s, null, NOW)],
  ['speaking', assistant({}, 'Here is the summary you asked for.'), { note: 'dimmed-place' }],
  ['complete', (s) => model.completeLiveStage(s, NOW)], // from speaking → keepSpeech complete frame
];

const consoleErrors = [];
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.IDBotsLiveStage && window.__liveStageMotion, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const patch = (st) => page.evaluate((p) => window.IDBotsLiveStage.applyPatch(p), JSON.parse(JSON.stringify(st)));

let state = model.createLiveStageState(ctx);
let seq = 0;
await shot('stage-received');
console.log('stage-received (boot)');

for (const [name, produce, extra = {}] of CHAIN.slice(1)) {
  seq += 1;
  state = { ...produce(state, seq), ...(extra.inject || {}) };
  const accepted = await patch(state);
  if (!accepted) { console.log(`REJECTED ${name} rev=${state.revision}`); continue; }
  if (name === 'owner-needed') {
    await page.waitForTimeout(1400);
    await shot('stage-owner-needed');
    console.log(`stage-owner-needed rev=${state.revision}`);
    state = model.dismissLiveStageInteraction(state, 'vfy-ask');
    await patch(state);
    continue;
  }
  if (extra.strip) {
    for (const off of [300, 900, 1600, 2400]) {
      await page.waitForTimeout(off === 300 ? 300 : off - [300, 900, 1600, 2400][[300, 900, 1600, 2400].indexOf(off) - 1]);
      await shot(`stage-${name}-${off}`);
    }
  } else {
    await page.waitForTimeout(name === 'problem' || name === 'owner-needed' ? 1200 : 1900);
    await shot(`stage-${name}`);
  }
  console.log(`stage-${name}${extra.strip ? ' (4-frame strip)' : ''} rev=${state.revision}`);
}

// speaking over web (dimmed web place): patch web2 then a speech patch
seq += 1; state = tool('web_search')(state, seq); await patch(state); await page.waitForTimeout(1500);
seq += 1; state = assistant({}, 'The search results are in — here is the gist.')(state, seq);
await patch(state); await page.waitForTimeout(1400); await shot('stage-speaking-over-web');
console.log('stage-speaking-over-web');

// crowded concurrency frame + frame-interval measurement
seq += 1; state = tool('post_simpleanswer')(state, seq);
const crowded = { ...state,
  activeWorkers: [WORKER('Pixel', 'working'), WORKER('Glyph', 'dispatch'), WORKER('Bram', 'waiting')],
  activePeers: [PEER('meta:peer-mira', 'Mira', 'awaiting', 'Draft the agenda'), PEER('meta:peer-tav', 'Tav', 'incoming', 'Sent you the deck')],
  activeGroups: [GROUP],
  companionFocus: { type: 'workers', id: 'w-Pixel' } };
await patch(crowded); await page.waitForTimeout(1800); await shot('stage-concurrency');
console.log('stage-concurrency');
const timing = await page.evaluate(() => new Promise((res) => {
  const t = [];
  const tick = (n) => { t.push(n); if (t.length < 190) requestAnimationFrame(tick); else res(t); };
  requestAnimationFrame(tick);
  setTimeout(() => res(t), 3200);
}));
const deltas = timing.slice(1).map((v, i) => v - timing[i]);
const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
console.log(`frame interval: mean ${mean.toFixed(1)}ms over ${deltas.length} frames (crowded chain-write)`);

// transients — one shot each, 'at' set fresh in page time
for (const kind of ['steer', 'retry', 'model-switch', 'chain-confirmed', 'tool-error']) {
  seq += 1;
  const st = { ...state, revision: state.revision + 1 };
  await page.evaluate(([p, k]) => { p.transient = { kind: k, id: `vfy-tr-${k}-${Date.now()}`, label: `vfy ${k}`, at: Date.now() }; window.IDBotsLiveStage.applyPatch(p); }, [JSON.parse(JSON.stringify(st)), kind]);
  await page.waitForTimeout(500); await shot(`stage-transient-${kind}`); await page.waitForTimeout(900);
  console.log(`stage-transient-${kind}`);
  state = st;
}

// memberLayouts must stay flat in a steady group-task scene
seq += 1;
const groupHero = { ...crowded, revision: seq, companionFocus: { type: 'groups', id: 'g-demo' } };
await patch(groupHero);
await page.waitForTimeout(2000);
const dbg0 = await page.evaluate(() => window.__liveStageMotion().scene);
await page.waitForTimeout(2000);
const dbg1 = await page.evaluate(() => window.__liveStageMotion().scene);
console.log(`memberLayouts steady-state: ${dbg0.memberLayouts} -> ${dbg1.memberLayouts} (${dbg1.memberLayouts - dbg0.memberLayouts} extra in 2s)`);
state = groupHero;

// enabled=false must stop the scene rAF (static frame); re-enable resumes it
seq += 1;
const off = { ...state, revision: seq, enabled: false };
const offOk = await patch(off); await page.waitForTimeout(700);
const dOff0 = await page.evaluate(() => window.__liveStageMotion().scene);
await page.waitForTimeout(500);
const dOff1 = await page.evaluate(() => window.__liveStageMotion().scene);
console.log(`enabled=false: patch=${offOk}, raf=${dOff1.raf}, frames ${dOff0.frames}->${dOff1.frames} (expect raf=false, flat)`);
seq += 1;
state = { ...state, revision: seq, enabled: true };
await patch(state); await page.waitForTimeout(700);
const dOn = await page.evaluate(() => window.__liveStageMotion().scene);
console.log(`enabled=true: raf=${dOn.raf} (expect true)`);

/* ---- fit checks: crowded companions + group hero at four stage sizes ---- */
const FIT_SIZES = [[900, 600], [1000, 640], [1280, 760], [1600, 1000]];
const overlap = (a, b) => {
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return w > 0 && h > 0 ? Math.min(w, h) : 0;
};
for (const [w, h] of FIT_SIZES) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(1100); // ResizeObserver → measure → density + clamp settle
  seq += 1;
  const st = { ...groupHero, revision: seq, transient: null };
  await patch(st);
  await page.waitForTimeout(1800); // hero slide + rail stagger + ring fade settle
  const r = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const rc = (el) => { const x = el.getBoundingClientRect(); return { l: x.left, t: x.top, r: x.right, b: x.bottom }; };
    const cv = q('.liquid-orb-canvas[data-active="true"]');
    const railEl = q('[data-companion-rail]');
    const disc0 = cv || q('.membrane');
    const br = disc0.getBoundingClientRect();
    const rr = (br.width / 2) * (cv ? 0.72 : 0.5);
    const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
    const hud = q('.task-hud');
    const hudVis = hud && !hud.hidden && hud.offsetParent !== null ? rc(hud) : null;
    return {
      disc: { l: cx - rr, r: cx + rr, t: cy - rr, b: cy + rr },
      rail: rc(railEl),
      copy: rc(q('.core-copy')),
      hud: hudVis,
      members: [...document.querySelectorAll('.group-member')].map(rc),
      density: document.body.dataset.railDensity || '',
      railItems: railEl.querySelectorAll('.rail-item').length,
      railClip: railEl.lastElementChild
        ? railEl.lastElementChild.getBoundingClientRect().bottom - railEl.getBoundingClientRect().bottom
        : 0,
      railMore: (() => {
        const m = railEl.querySelector('.rail-more');
        return m ? { bottom: m.getBoundingClientRect().bottom, text: m.textContent } : null;
      })(),
    };
  });
  const dRail = overlap(r.disc, r.rail);
  const cRail = overlap(r.copy, r.rail);
  const hRail = r.hud ? overlap(r.hud, r.rail) : 0;
  const mRail = Math.max(0, ...r.members.map((m) => overlap(m, r.rail)));
  const discGap = r.rail.l - r.disc.r;
  // rail must not clip its last child, and "+N" must be visible (and inside
  // the rail bounds) whenever items are hidden — the crowded spec has 6
  const hidden = 6 - r.railItems;
  const moreOk = hidden <= 0 || (r.railMore && r.railMore.bottom <= r.rail.b + 1);
  console.log(`fit ${w}x${h} density=${r.density}: disc→rail gap ${discGap.toFixed(1)}px, ` +
    `disc∩rail ${dRail.toFixed(1)}, rail∩copy ${cRail.toFixed(1)}, rail∩hud ${hRail.toFixed(1)}, members∩rail ${mRail.toFixed(1)}`);
  console.log(`    rail: ${r.railItems}/6 items, clip ${r.railClip.toFixed(1)}px (expect ≤1), ` +
    `+N row ${r.railMore ? `"${r.railMore.text}" bottom ${(r.railMore.bottom - r.rail.b).toFixed(1)}` : 'absent'} ` +
    `(hidden ${hidden}, +N ok: ${moreOk})`);
  await shot(`stage-fit-${w}x${h}`);
}

await browser.close();
console.log(`console errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 10).forEach((e) => console.log('  ERR', e.slice(0, 160)));
