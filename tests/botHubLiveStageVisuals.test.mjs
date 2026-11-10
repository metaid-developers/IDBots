import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (relative) => fs.readFileSync(path.resolve('public/live-stage', relative), 'utf8');

test('orb families use bounded official styles and continuous breathing parameters', () => {
  const window = {};
  vm.runInNewContext(read('liquid-orb.js'), { window });
  const expected = {
    received: 9,
    reasoning: 15,
    speaking: 9,
    'web2-research': 10,
    'metaweb-research': 13,
    making: 23,
    delegation: 24,
    waiting: 24,
    'worker-report': 14,
    verification: 12,
    'owner-needed': 21,
    problem: 21,
    'report-ready': 9,
    complete: 9,
  };
  for (const [family, style] of Object.entries(expected)) {
    assert.equal(window.liquidOrbStyleForFamily(family), style, family);
  }
  const source = read('liquid-orb.js');
  assert.match(source, /params\.exposure, params\.style, params\.edgeSoftness/);
  assert.match(source, /c\.rgb \* fit, c\.a \* fit/);
  assert.doesNotMatch(source, /c\.rgb \* fit \* c\.a/);
  assert.match(source, /const breath = reduced \? 0 : Math\.sin\(phase \* 1\.32\)/);
  assert.match(source, /rendered\.radius = current\.radius \* \(1 \+ breath \* \.018\)/);
  assert.match(source, /setReduced,/);
  assert.match(source, /getSharedResources\(\) \{ return \{ device, shader, pipeline \}; \}/);
});

test('Avatar stays above original opaque glass and style changes cross-fade canvases', () => {
  const css = read('stage.css');
  assert.match(css, /\.core-avatar\{[^}]*z-index:2;[^}]*width:112px;[^}]*height:112px/);
  assert.match(css, /\.liquid-orb-canvas\{[^}]*z-index:1/);
  assert.match(css, /transition:opacity \.9s/);
  assert.match(css, /@keyframes core-breathe/);
  assert.match(css, /body\[data-motion="reduced"\] \.membrane-wrap\{animation:none;scale:1;filter:none\}/);
  const stage = read('stage.js');
  assert.match(stage, /previous\.canvas\.dataset\.active = 'false'/);
  assert.match(stage, /previous\.fadeTimer = setTimeout\(\(\) => disposeOrbLayer\(previous\), 950\)/);
  assert.match(stage, /handoff\.direction === 'return' \? '0;1' : '1;0'/);
  assert.match(stage, /\$\('\[data-handoff-flow\]'\)\.setAttribute\('hidden', ''\)/);
  assert.match(stage, /\$\('\[data-handoff-flow\]'\)\.removeAttribute\('hidden'\)/);
  assert.doesNotMatch(stage, /\$\('\[data-handoff-flow\]'\)\.hidden/);
  assert.match(stage, /sharedResources: previous\?\.controller\?\.getSharedResources\(\)/);
  assert.match(stage, /if \(orbStarting \|\| orbFailed \|\| !state.enabled \|\| document.hidden\) return;/);
  assert.match(stage, /reduced !== \(body\.dataset\.motion === 'reduced'\)/);
  const window = {};
  vm.runInNewContext(read('liquid-orb-effect.js'), { window });
  assert.match(window.LiquidOrbEffectSource, /max\(ballA, emissionAlpha\)/);
  assert.doesNotMatch(window.LiquidOrbEffectSource, /rimAlpha/);
  assert.match(read('stage.html'), /<animateMotion data-handoff-motion begin="indefinite"/);
});
