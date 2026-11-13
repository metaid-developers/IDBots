import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (relative) => fs.readFileSync(path.resolve('public/live-stage', relative), 'utf8');

test('orb families keep one dark-glass material with calm-only autonomous breathing', () => {
  const window = {};
  vm.runInNewContext(read('liquid-orb.js'), { window });
  const families = [
    'received', 'reasoning', 'speaking', 'local-recall', 'web2-research',
    'metaweb-research', 'making', 'delegation', 'waiting', 'worker-report',
    'verification', 'browser-action', 'owner-needed', 'problem', 'report-ready', 'complete',
  ];
  for (const family of families) assert.equal(window.liquidOrbStyleForFamily(family), 9, family);
  const source = read('liquid-orb.js');
  assert.match(source, /colorA: '#FFD86B'/);
  assert.match(source, /shellEdge: '#C5A9FF'/);
  assert.match(source, /glowColor: '#956CFF'/);
  assert.match(source, /exposure: 1\.36/);
  assert.doesNotMatch(source, /#FFDC51|#FF9D55|#FFF3B0/);
  assert.match(source, /params\.exposure, params\.style, params\.edgeSoftness/);
  assert.match(source, /c\.rgb \* fit, c\.a \* fit/);
  assert.match(source, /const breath = reduced \? 0 : Math\.sin\(phase \* 1\.32\)/);
  assert.match(source, /const breathWeight = Math\.max\(0, Math\.min\(1, \(\.12 - current\.contourDeform\) \/ \.06\)\)/);
  assert.match(source, /rendered\.radius = current\.radius \* \(1 \+ breath \* \.018 \* breathWeight\)/);
  assert.match(source, /rendered\.edgeGlow = current\.edgeGlow \* \(1 \+ breath \* \.32 \* breathWeight\)/);
  assert.match(source, /setReduced,/);
  assert.match(source, /getSharedResources\(\) \{ return \{ device, shader, pipeline \}; \}/);
  assert.match(source, /canvas\.dataset\.firstFrameMs/);
});

test('active states deform the quiet material without autonomous size or exposure pulses', () => {
  const window = {};
  vm.runInNewContext(read('liquid-orb.js'), { window });
  const speaking = window.liquidOrbParamsForFamily('speaking');
  const active = [
    'received', 'reasoning', 'local-recall', 'web2-research', 'metaweb-research',
    'making', 'delegation', 'waiting', 'worker-report', 'verification', 'browser-action',
  ];
  const shared = ['style', 'radius', 'glassOpacity', 'edgeGlow', 'exposure', 'colorA', 'colorB', 'colorC', 'colorD', 'glowColor', 'shellMid', 'shellEdge'];
  for (const family of active) {
    const params = window.liquidOrbParamsForFamily(family);
    for (const key of shared) assert.equal(params[key], speaking[key], `${family} ${key}`);
  }
  const reasoning = window.liquidOrbParamsForFamily('reasoning');
  const complete = window.liquidOrbParamsForFamily('complete');
  assert.ok(reasoning.contourDeform >= .9);
  assert.ok(reasoning.speed > speaking.speed);
  assert.ok(speaking.contourDeform <= .045);
  assert.ok(complete.contourDeform <= .01);
  assert.equal(window.liquidOrbActivityForFamily('reasoning'), 'thinking');
  assert.equal(window.liquidOrbActivityForFamily('web2-research'), 'working');
  assert.equal(window.liquidOrbActivityForFamily('speaking'), 'speaking');
  assert.equal(window.liquidOrbActivityForFamily('complete'), 'resting');
  const source = read('liquid-orb.js');
  assert.match(source, /rendered\.contourDeform = Math\.max\(0, current\.contourDeform \+ fluidity/);
  assert.doesNotMatch(source, /familyPalettes|exposure: 1\.42/);
  const stage = read('stage.js');
  assert.match(stage, /initialFamily: family/);
  assert.match(stage, /startPhase: Number\.isFinite\(previousPhase\)/);
  assert.match(stage, /radius: textMotion\.energy \* \.008/);
  assert.match(stage, /edgeGlow: quiet \? textMotion\.energy \* \.07 : 0/);
  assert.match(stage, /exposure: quiet \? textMotion\.energy \* \.08 : 0/);
  const css = read('stage.css');
  assert.match(css, /body\[data-activity="working"\] \.membrane-wrap,body\[data-activity="thinking"\] \.membrane-wrap\{animation:none;translate:0 0;scale:1;filter:none\}/);
  assert.match(css, /body\[data-activity="speaking"\] \.membrane-wrap,body\[data-activity="resting"\] \.membrane-wrap\{animation:core-breathe/);
  const liquid = css.match(/@keyframes membrane-liquid\{([^}]*\}){3}/);
  assert.ok(liquid);
  assert.doesNotMatch(liquid[0], /scale\(/);
});

test('text pacing and the equalizer follow actual character updates only', () => {
  const stage = read('stage.js');
  assert.match(stage, /if \(channel\.value === next\) return;/);
  assert.match(stage, /channel\.typed \+= 1;/);
  assert.match(stage, /textMotion\.voiceUntil = now \+ 150;/);
  assert.match(stage, /body\.dataset\.voice = !effectiveReduced\(\) && now < textMotion\.voiceUntil \? 'on' : 'off'/);
  assert.match(stage, /setTextChannel\(textChannels\[0\], state\.headline, now\)/);
  assert.match(stage, /setTextChannel\(textChannels\[1\], state\.caption, now\)/);
  assert.match(stage, /const fresh = document\.createElement\('span'\)/);
  assert.match(stage, /fresh\.className = 'core-fresh'/);
  const css = read('stage.css');
  assert.match(css, /\.core-voice\{opacity:0;visibility:hidden/);
  assert.match(css, /body\[data-voice="on"\] \.core-voice/);
  assert.match(css, /body\[data-voice="on"\] \.core-voice i\{animation:voice-wave/);
  assert.match(css, /body\[data-motion="reduced"\] \.core-voice\{display:none\}/);
  assert.match(css, /\.core-caret\{[^}]*animation:core-caret-blink/);
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
  assert.match(stage, /emitInteraction\(/);
  // The card is a presentation surface: every string reaches the DOM through
  // textContent — no HTML injection point anywhere in the stage script.
  assert.doesNotMatch(stage, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(read('stage.html'), /<section class="interaction-card" data-interaction-card hidden><\/section>/);
  const css = read('stage.css');
  assert.match(css, /\.interaction-card\{position:absolute;z-index:6/);
  assert.match(css, /\.interaction-card\[hidden\]\{display:none\}/);
  assert.match(css, /\.interaction-button\.is-primary\{background:var\(--brand\)/);
  // Owner note 2026-11-12: a default scrollbar on the card is unacceptable —
  // when overflow is unavoidable it renders as a hairline brand-tinted rail.
  assert.match(css, /\.interaction-card\{max-height:78vh;scrollbar-width:thin;scrollbar-color:rgba\(155,244,255,\.3\) transparent\}/);
  assert.match(css, /\.interaction-card::-webkit-scrollbar\{width:4px\}/);
  assert.match(css, /\.interaction-question-detail::-webkit-scrollbar-thumb\{background:rgba\(148,163,184,\.25\);border-radius:999px\}/);
});

test('ask wizard submit is reachable by the validity gate (2026-11-12 incident pin)', () => {
  const stage = read('stage.js');
  // Writer and reader must reference the SAME attribute: the validity gate
  // re-enables the submit through [data-interaction-submit]; the 2026-11-12
  // device incident shipped a submit that never carried it, so the ask
  // wizard's submit stayed disabled forever while options stayed clickable.
  assert.match(stage, /submit\.dataset\.interactionSubmit = '';/);
  assert.match(stage, /card\.querySelector\('\[data-interaction-submit\]'\)/);
  assert.match(stage, /submit\.disabled = isAsk;/);
  // The gate must actually flip the flag for the initial disabled state to
  // ever lift (no early return that skips the write).
  assert.match(stage, /submit\.disabled = !ready;/);
  // The gate itself must NOT bail on the disabled state: the ask submit
  // STARTS disabled, so a `submit.disabled` guard returns before the write
  // and the button never lifts (the second half of the incident, MetaPo
  // retest 2026-11-12). The terminal state is the card-level done flag.
  assert.match(stage, /if \(!card \|\| card\.dataset\.interactionDone === 'true'\) return;/);
  assert.doesNotMatch(stage, /if \(!submit \|\| submit\.disabled\) return;/);
  assert.match(stage, /card\.dataset\.interactionDone = 'true';/, 'completeInteraction marks the card done');
  assert.match(stage, /card\.dataset\.interactionDone = 'false';/, 'a rebuilt card clears the done flag');
});

test('the ask card offers an always-clickable skip that never fabricates an answer', () => {
  const stage = read('stage.js');
  assert.match(stage, /interactionCopy\('跳过', 'Skip'\)/);
  assert.match(stage, /behavior: 'allow', skip: true/);
  // Skip must not be gated on selections: it queues even with nothing picked.
  assert.doesNotMatch(stage, /skip\.disabled/);
});

test('report recovery is a real button that navigates through the constrained Stage channel', () => {
  const stage = read('stage.js');
  assert.match(stage, /reportOpen\.addEventListener\('click'/);
  assert.match(stage, /source: 'idbots-live-stage'/);
  assert.match(stage, /type: 'open-report'/);
  // The persistent stage posts only the uri; the bridge validates the
  // preview-metaapp prefix and focuses the showcase tab itself.
  assert.match(stage, /type: 'open-report',\s*\n\s*uri\s*\n?\s*\}, '\*'\)/);
  assert.match(stage, /state\.reportUri/);
  assert.doesNotMatch(stage, /turnId: initial\.turnId/, 'open-report no longer depends on a baked per-turn initial state');
  assert.match(stage, /uri\.startsWith\('preview-metaapp:\/\/localhost\/'\)/);
  assert.match(stage, /canOpenReport \? tr\('打开汇报', 'Open report'\) : tr\('正在打开最终页面', 'Opening the final page'\)/);
  for (const file of ['stage.html', 'index.html']) {
    const html = read(file);
    assert.match(html, /<button class="core-report-ready" type="button" data-report-open disabled>/);
    assert.match(html, /data-report-open-label/);
  }
  const css = read('stage.css');
  assert.match(css, /\.core-report-ready:not\(:disabled\):hover/);
  assert.match(css, /\.core-report-ready:focus-visible/);
});

test('stage clicks push straight to the shell bridge alongside the poll queue', () => {
  const stage = read('stage.js');
  assert.match(stage, /function emitInteraction\(entry\)/);
  assert.match(stage, /window\.parent\.postMessage\(\{ source: 'idbots-live-stage', type: 'stage-interaction', entry \}, '\*'\)/);
  assert.match(stage, /emitInteraction\(\{ requestId: interaction\.requestId, token: interaction\.token, behavior: 'deny' \}\)/);
  assert.match(stage, /emitInteraction\(\{ requestId: interaction\.requestId, token: interaction\.token, behavior: 'allow', skip: true \}\)/);
  assert.doesNotMatch(stage, /interactionQueue\.push\(\{ requestId: interaction\.requestId, token: interaction\.token, behavior: 'deny'/, 'every click leaves through the emitter');
});

test('speaking keeps the base headline size and a wider brighter caption', () => {
  const stage = read('stage.js');
  // A streaming reply grows sentence by sentence; length tiers would flash
  // sizes mid-speech, so the attribute is removed for the speaking family.
  assert.match(stage, /state\.family === 'speaking'\) \{\s*\n?\s*titleEl\.removeAttribute\('data-length'\)/);
  const css = read('stage.css');
  assert.match(css, /body\[data-family="speaking"\] \.core-copy\{width:44%;max-width:480px\}/);
  assert.match(css, /body\[data-family="speaking"\] \.core-copy h1\{max-width:480px\}/);
  assert.match(css, /body\[data-family="speaking"\] \.core-copy p\{max-width:480px;color:#c9d3df;font-size:clamp\(16px,1\.5vw,20px\);line-height:1\.7\}/);
});

test('particles integrate phase and follow the orb activity multiplier', () => {
  const stage = read('stage.js');
  // No absolute-time angle: energy/family changes retune velocity without
  // teleporting the field, and reduced motion freezes the accumulated phase.
  assert.doesNotMatch(stage, /t \* particle\.speed \* state\.motion\.energy/);
  assert.match(stage, /particle\.phase \+= dt \* particle\.speed \* rate/);
  assert.match(stage, /particle\.angle \+ particle\.phase/);
  assert.match(stage, /PARTICLE_ACTIVITY = \{ working: 1\.75, speaking: \.6, resting: \.5 \}/);
  assert.match(stage, /liquidOrbActivityForFamily\(state\.family\)/);
  assert.match(stage, /1 - Math\.exp\(-dt \/ \.8\)/, '~0.8 s ease toward the activity target');
  assert.match(stage, /if \(!reduced && dt > 0\)/, 'reduced motion never advances the phase');
  assert.match(stage, /particles: \{ activity: particleClock\.activity/, 'debug hook exposes the eased multiplier');
});

test('WebGPU orb compiles pipelines asynchronously and tears down late timed-out devices', () => {
  const orb = read('liquid-orb.js');
  const stage = read('stage.js');
  assert.match(orb, /device\.createRenderPipelineAsync\(pipelineDescriptor\)/);
  assert.match(orb, /const abortIfSignaled = \(\) =>/);
  assert.match(stage, /signal: abort\?\.signal/);
  assert.match(stage, /controller\.dispose\(!previous\?\.controller\)/);
});
