import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (relative) => fs.readFileSync(path.resolve('public/live-stage', relative), 'utf8');

test('orb families use curated official colors and continuous breathing parameters', () => {
  const window = {};
  vm.runInNewContext(read('liquid-orb.js'), { window });
  const expected = {
    received: 9,
    reasoning: 9,
    speaking: 9,
    'web2-research': 9,
    'metaweb-research': 9,
    making: 9,
    delegation: 9,
    waiting: 9,
    'worker-report': 9,
    verification: 9,
    'owner-needed': 9,
    problem: 9,
    'report-ready': 9,
    complete: 9,
  };
  for (const [family, style] of Object.entries(expected)) {
    assert.equal(window.liquidOrbStyleForFamily(family), style, family);
  }
  const source = read('liquid-orb.js');
  assert.match(source, /colorA: '#FFD86B'/);
  assert.match(source, /shellEdge: '#C5A9FF'/);
  assert.match(source, /glowColor: '#956CFF'/);
  assert.match(source, /exposure: 1\.36/);
  assert.doesNotMatch(source, /#FFDC51|#FF9D55|#FFF3B0/);
  assert.match(source, /params\.exposure, params\.style, params\.edgeSoftness/);
  assert.match(source, /c\.rgb \* fit, c\.a \* fit/);
  assert.match(source, /const breath = reduced \? 0 : Math\.sin\(phase \* 1\.32\)/);
  assert.match(source, /rendered\.radius = current\.radius \* \(1 \+ breath \* \.018\)/);
  assert.match(source, /setReduced,/);
  assert.match(source, /getSharedResources\(\) \{ return \{ device, shader, pipeline \}; \}/);
  assert.match(source, /canvas\.dataset\.firstFrameMs/);
});

test('Avatar stays above glass and Worker handoff is a timed curved interaction', () => {
  const css = read('stage.css');
  assert.match(css, /\.core-avatar\{[^}]*z-index:2;[^}]*width:112px;[^}]*height:112px/);
  assert.match(css, /\.hybrid-avatar\{[^}]*width:42px;[^}]*height:42px/);
  assert.match(css, /\.handoff-avatar\{[^}]*width:28px;[^}]*height:28px/);
  assert.match(css, /\.handoff-person\{display:flex;align-items:center;gap:8px\}/);
  assert.match(css, /\.liquid-orb-canvas\{[^}]*z-index:1/);
  assert.match(css, /transition:opacity \.9s/);
  assert.match(css, /@keyframes core-breathe/);
  assert.match(css, /body\[data-motion="reduced"\] \.membrane-wrap\{animation:none;scale:1;filter:none\}/);
  const stage = read('stage.js');
  assert.match(stage, /previous\.canvas\.dataset\.active = 'false'/);
  assert.match(stage, /previous\.fadeTimer = setTimeout\(\(\) => disposeOrbLayer\(previous\), 950\)/);
  assert.match(stage, /handoff\.direction === 'return' \? '0;1' : '1;0'/);
  assert.match(stage, /handoffTimer = setTimeout\(stopHandoff, 5000\)/);
  assert.match(stage, /function layoutHandoff\(\)/);
  assert.match(stage, /ctx\.quadraticCurveTo/);
  assert.match(stage, /updateWorkerVisual\(nodes\.worker\)/);
  assert.match(stage, /flow\.setAttribute\('hidden', ''\)/);
  assert.match(stage, /flow\.removeAttribute\('hidden'\)/);
  assert.doesNotMatch(stage, /\$\('\[data-handoff-flow\]'\)\.hidden/);
  assert.match(stage, /sharedResources: previous\?\.controller\?\.getSharedResources\(\)/);
  assert.match(stage, /if \(orbStarting \|\| orbFailed \|\| !state.enabled \|\| document.hidden\) return;/);
  assert.match(stage, /reduced !== \(body\.dataset\.motion === 'reduced'\)/);
  assert.match(read('stage.html'), /<animateMotion data-handoff-motion begin="indefinite" dur="2.8s" repeatCount="1"/);
  assert.match(read('stage.html'), /data-worker-avatar/);
  assert.match(read('stage.html'), /data-handoff-avatar/);
  const window = {};
  vm.runInNewContext(read('liquid-orb-effect.js'), { window });
  assert.match(window.LiquidOrbEffectSource, /max\(ballA, emissionAlpha\)/);
  assert.doesNotMatch(window.LiquidOrbEffectSource, /rimAlpha/);
});

test('interaction card renders through textContent only and drains clicks exactly once', () => {
  const stage = read('stage.js');
  assert.match(stage, /function renderInteraction\(\)/);
  assert.match(stage, /renderInteraction\(\);\n    restartParticles\(\);/);
  assert.match(stage, /drainInteractions\(\) \{\n      const items = interactionQueue\.splice\(0, interactionQueue\.length\);\n      return items;\n    \}/);
  assert.match(stage, /data-interaction-question/);
  assert.match(stage, /interaction-custom/);
  assert.match(stage, /interactionQueue\.push\(\{ requestId: interaction\.requestId, token: interaction\.token/);
  // The card is a presentation surface: every string reaches the DOM through
  // textContent — no HTML injection point anywhere in the stage script.
  assert.doesNotMatch(stage, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(read('stage.html'), /<section class="interaction-card" data-interaction-card hidden><\/section>/);
  const css = read('stage.css');
  assert.match(css, /\.interaction-card\{position:absolute;z-index:6/);
  assert.match(css, /\.interaction-card\[hidden\]\{display:none\}/);
  assert.match(css, /\.interaction-button\.is-primary\{background:var\(--brand\)/);
});

test('report recovery is a real button that navigates through the constrained Stage channel', () => {
  const stage = read('stage.js');
  assert.match(stage, /reportOpen\.addEventListener\('click'/);
  assert.match(stage, /source: 'idbots-live-stage'/);
  assert.match(stage, /type: 'open-report'/);
  assert.match(stage, /turnId: initial\.turnId/);
  assert.match(stage, /uri: reportUri/);
  assert.match(stage, /canOpenReport \? 'Open report' : 'Opening the final page'/);
  for (const file of ['stage.html', 'index.html']) {
    const html = read(file);
    assert.match(html, /<button class="core-report-ready" type="button" data-report-open disabled>/);
    assert.match(html, /data-report-open-label/);
  }
  const css = read('stage.css');
  assert.match(css, /\.core-report-ready:not\(:disabled\):hover/);
  assert.match(css, /\.core-report-ready:focus-visible/);
});
