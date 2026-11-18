// Scene-engine helper tests: the pure functions stage-scenes.js exposes on
// window.IDBotsLiveStageScenes.__test, run under vm like the other visuals
// tests. Plus the chain front-ribbon no-overlap invariant sampled at 5ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (relative) => fs.readFileSync(path.resolve('public/live-stage', relative), 'utf8').replace(/\r\n/g, '\n');

function loadScenes() {
  const window = {};
  vm.runInNewContext(read('stage-scenes.js'), {
    window,
    document: { querySelector: () => null, addEventListener: () => {}, body: { dataset: {} }, hidden: true },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    navigator: { language: 'en' },
    console,
  });
  return window.IDBotsLiveStageScenes.__test;
}

const T = loadScenes();
const j = (v) => JSON.stringify(v);

test('chainSlotLayout implements pos(k,p) = headS − (k+p)·pitch', () => {
  assert.equal(T.chainSlotLayout(0, 0, 46, 900), 900);
  assert.equal(T.chainSlotLayout(1, 0, 46, 900), 854);
  assert.equal(T.chainSlotLayout(0, 0.5, 46, 900), 877);
  assert.equal(T.chainSlotLayout(2, 1, 46, 900), 762);
});

test('front ribbon never overlaps: write and transfer cycles sampled every 5ms', () => {
  const pitch = 46, headS = 900, n = 6;
  // Write cycle timeline (ms): packet 0-900, unfold 900-1600, seal,
  // block join, ripple, slot shift 2400-3000. Sample the whole cycle.
  for (let e = 0; e <= 3200; e += 5) {
    let slots;
    if (e < 2400) slots = T.chainFrontSlots(n, 0, 'unfold', pitch, headS);
    else if (e < 3000) slots = T.chainFrontSlots(n, Math.min(1, (e - 2400) / 600), 'shift', pitch, headS);
    else slots = T.chainFrontSlots(n, 1, 'settled', pitch, headS);
    for (let i = 0; i + 1 < slots.length; i += 1) {
      const gap = slots[i].s - slots[i + 1].s; // sorted headS → tail, strictly decreasing
      assert.ok(gap >= pitch - 0.5, `write cycle e=${e}ms: gap ${gap} between ${slots[i].kind}@${slots[i].s} and ${slots[i + 1].kind}@${slots[i + 1].s}`);
    }
  }
  // Transfer cycles share the same shift mechanics — verify both phases again.
  for (let e = 0; e <= 3200; e += 5) {
    const slots = e < 2400
      ? T.chainFrontSlots(n, 0, 'unfold', pitch, headS)
      : e < 3000
        ? T.chainFrontSlots(n, Math.min(1, (e - 2400) / 600), 'shift', pitch, headS)
        : T.chainFrontSlots(n, 1, 'settled', pitch, headS);
    for (let i = 0; i + 1 < slots.length; i += 1) {
      assert.ok(slots[i].s - slots[i + 1].s >= pitch - 0.5, `transfer cycle e=${e}ms overlap`);
    }
  }
});

test('resolveSceneModifiers: speaking dims to .4 and pauses events; owner-needed freezes; problem slates; waiting .55', () => {
  assert.equal(j(T.resolveSceneModifiers('speaking')), j({ dim: 0.4, eventsPaused: true }));
  assert.equal(j(T.resolveSceneModifiers('owner-needed')), j({ freeze: true, dim: 0.35 }));
  assert.equal(j(T.resolveSceneModifiers('problem')), j({ slate: true, dim: 0.5, slow: 0.2 }));
  assert.equal(j(T.resolveSceneModifiers('waiting')), j({ dim: 0.55 }));
  assert.equal(j(T.resolveSceneModifiers('web2-research')), j({}));
});

test('pickHero honours focus ids and falls back per type', () => {
  const spec = {
    workers: [{ who: 'w1', status: 'working' }, { who: 'w2', status: 'verifying' }],
    peers: [{ who: 'p1', status: 'open' }, { who: 'p2', status: 'incoming' }],
    groups: [{ id: 'g1', status: 'active', members: [] }],
  };
  assert.equal(T.pickHero(null, spec), null);
  assert.equal(j(T.pickHero({ type: 'workers', id: 'w1' }, spec)), j({ type: 'workers', id: 'w1' }));
  // missing id → worker in dispatch/return/verifying first
  assert.equal(j(T.pickHero({ type: 'workers' }, spec)), j({ type: 'workers', id: 'w2' }));
  // unknown id → same fallback
  assert.equal(j(T.pickHero({ type: 'workers', id: 'gone' }, spec)), j({ type: 'workers', id: 'w2' }));
  assert.equal(j(T.pickHero({ type: 'peers' }, spec)), j({ type: 'peers', id: 'p2' }));
  assert.equal(j(T.pickHero({ type: 'groups' }, spec)), j({ type: 'groups', id: 'g1' }));
  assert.equal(T.pickHero({ type: 'groups' }, { workers: spec.workers }), null);
});

test('railOrder pins the hero, caps at 5, emits +N, and never leaves an orphan heading', () => {
  const spec = {
    workers: [
      { who: 'w1', status: 'waiting' }, { who: 'w2', status: 'working' },
      { who: 'w3', status: 'dispatch' }, { who: 'w4', status: 'working' },
    ],
    peers: [{ who: 'p1', status: 'open' }, { who: 'p2', status: 'awaiting' }],
    groups: [{ id: 'g1', status: 'active', members: [] }],
  };
  const hero = { type: 'workers', id: 'w1' };
  const out = T.railOrder(spec, hero, 5);
  const all = out.sections.flatMap((sec) => sec.items);
  // hero pinned first among visible picks
  assert.ok(all.includes(spec.workers[0]), 'hero is always visible');
  assert.equal(all.length, 4); // 7 total − cap 4 (one row reserved for +N)
  assert.equal(out.more, 3);
  // no section heading without a visible item
  for (const sec of out.sections) assert.ok(sec.items.length > 0);
  // active-now sorts before working before waiting
  const wIdx = out.sections.findIndex((sec) => sec.type === 'workers');
  assert.ok(wIdx >= 0);
  // without the cap everything shows and no +N row
  const wide = T.railOrder(spec, hero, 10);
  assert.equal(wide.more, 0);
});

test('shouldPlayTransient dedupes by id and rejects stale events older than 6s', () => {
  const seen = new Set();
  const t = { kind: 'steer', id: 'a1', label: 'x', at: 1000 };
  assert.equal(T.shouldPlayTransient(seen, t, 2000), true);
  assert.equal(T.shouldPlayTransient(seen, t, 3000), false); // dedupe
  assert.equal(T.shouldPlayTransient(seen, { kind: 'steer', id: 'a2', label: 'x', at: 1000 }, 30000), false); // >6s gate
  assert.equal(T.shouldPlayTransient(seen, { kind: 'steer', id: 'a3', label: 'x', at: 29000 }, 30000), true);
  assert.equal(T.shouldPlayTransient(seen, null, 30000), false);
});

test('placeGlow returns the per-place tint', () => {
  assert.equal(T.placeGlow('mind'), '#956CFF');
  assert.equal(T.placeGlow('machine'), '#D9A25F');
  assert.equal(T.placeGlow('web'), '#6FA0FF');
  assert.equal(T.placeGlow('chain'), '#46D6E6');
});

test('chain-transfer drawing path uses no gold and no diamond', () => {
  const src = read('stage-scenes.js');
  // Extract the transfer-only branches of drawWriteCycle.
  const write = src.indexOf('function drawWriteCycle');
  assert.ok(write > 0);
  const body = src.slice(write, src.indexOf('function drawRibbon', write));
  // the only gold user inside the cycle is the write-only seal branch
  assert.doesNotMatch(body, /isTransfer \? fxSeal\(\)/, 'transfer must not pick the gold seal hue');
  const ripple = body.slice(body.indexOf('e >= 1950'));
  assert.doesNotMatch(ripple, /255,220,81/, 'transfer shares the write ripple — no gold literal allowed after join');
  // the only fxSeal() (gold) call in the cycle lives inside the write-only
  // `!isTransfer && e >= 1250` seal block
  const sealCalls = [...body.matchAll(/fxSeal\(\)/g)].map((m) => m.index);
  const sealGate = body.indexOf('!isTransfer && e >= 1250');
  assert.ok(sealGate > 0, 'seal must be write-only');
  const sealEnd = body.indexOf('restore();', sealGate);
  for (const idx of sealCalls) {
    assert.ok(idx > sealGate && idx < sealEnd, `gold call outside the write-only seal block @${idx}`);
  }
  assert.equal(sealCalls.length, 1, 'gold is used exactly once — the write seal');
  assert.doesNotMatch(body, /rotate\(Math\.PI \/ 4\)[\s\S]{0,80}fillRect/, 'no rotated-square diamond in the packet path');
  // packets: cyan glint + violet rounded squares crossing midway
  assert.match(body, /'197,169,255'/);
  assert.match(body, /ctrlDown/);
});

test('scene engine DOM writes never use markup-injection sinks', () => {
  const src = read('stage-scenes.js');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/, 'rail/member DOM must be built with createElement + replaceChildren only');
  assert.match(src, /rail\.replaceChildren\(\)/);
  assert.match(src, /createElementNS\(SVG_NS, 'svg'\)/, 'rail glyphs come from the constant path table');
});

test('rail density + hero orb scaling pins', () => {
  const scenes = read('stage-scenes.js');
  assert.match(scenes, /S\.W < 900 \? 2 : S\.W < 1180 \? 1 : 0/, 'density derives from measured stage width');
  assert.match(scenes, /document\.body\.dataset\.railDensity = d/);
  assert.match(scenes, /M\.density === 'mini' \? Math\.min\(3, total\)/, 'mini density caps visible items at 3');
  const css = fs.readFileSync('public/live-stage/stage.css', 'utf8');
  assert.match(css, /body\[data-hero="true"\] \.core-entity\{left:56%;transform:scale\(\.85\)\}/);
  assert.match(css, /body\[data-hero="true"\]\[data-rail-density="mini"\] \.core-entity\{transform:scale\(\.78\)\}/);
  assert.match(css, /body\[data-rail-density="compact"\] \.companion-rail\{max-width:192px\}/);
  assert.match(css, /body\[data-rail-density="mini"\] \.companion-rail\{max-width:160px/);
  assert.match(css, /body\[data-rail-density="compact"\] \.rail-sub\{display:none\}/);
});

test('rail caps visible items by measured band height, reserving the +N row', () => {
  const src = read('stage-scenes.js');
  assert.match(src, /function railFitCap\(countCap, cand, total\)/, 'height-based fit cap exists');
  assert.match(src, /measureRailUnits\(cand\)/, 'item\/heading\/more units measured per density + kind');
  assert.match(src, /u\.density !== M\.density/, 'units are keyed to the density');
  assert.match(src, /u\.item\[RAIL_KIND\[e\.type\]\]/, 'per-kind item heights: a hero group card is taller');
  assert.match(src, /c < total \? u\.more \+ u\.gap : 0/, 'the +N row is reserved whenever items hide');
  assert.match(src, /new Set\(picked\.map\(\(e\) => e\.type\)\)\.size/, 'estimate counts section headings');
  assert.match(src, /railFitCap\(railCountCap\(total\), cand, total\) !== M\.lastCap\) buildRail\(\)/, 'relayout refits on stage resize');
  assert.match(src, /isHeroItem\(b\.type, b\.c\) - isHeroItem\(a\.type, a\.c\)/, 'hero stays pinned first in the ordered candidates');
});

test('the scene glow tint is re-applied after every orb setState', () => {
  const stage = read('stage.js');
  assert.match(stage, /let lastOrbTint = null/, 'stage caches the last scene tint');
  assert.match(stage, /orbTint: \(glowColor\) => \{\s*lastOrbTint = glowColor/, 'orbTint stores before applying');
  // mountOrb's async controller hand-off resets glowColor via setState — re-apply
  assert.match(
    stage,
    /controller\.setState\(layer\.family, effectiveReduced\(\)\);\s*if \(lastOrbTint\) controller\.setParams\(\{ glowColor: lastOrbTint \}\)/,
    'freshly mounted controller gets the cached tint back'
  );
  // syncOrb's same-style setState path resets it too — re-apply
  assert.match(
    stage,
    /orb\.controller\?\.setState\(family, effectiveReduced\(\)\);\s*if \(lastOrbTint\) orb\.controller\?\.setParams\(\{ glowColor: lastOrbTint \}\)/,
    'same-layer setState re-applies the cached tint'
  );
});
