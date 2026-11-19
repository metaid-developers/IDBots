import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (relative) => fs.readFileSync(path.resolve('public/live-stage', relative), 'utf8').replace(/\r\n/g, '\n');

test('orb families keep one dark-glass material with calm-only autonomous breathing', () => {
  const window = {};
  vm.runInNewContext(read('liquid-orb.js'), { window });
  const families = [
    'received', 'reasoning', 'speaking', 'local-recall', 'web2-research',
    'metaweb-research', 'making', 'delegation', 'waiting', 'worker-report',
    'verification', 'browser-action', 'owner-needed', 'problem', 'report-ready', 'complete',
    'local-run', 'local-read', 'desktop-control', 'projecting', 'web-read',
    'chain-write', 'chain-transfer', 'private-chat', 'group-task',
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

test('Avatar stays above glass and the scene engine replaces the handoff/hybrid/particle visuals', () => {
  const css = read('stage.css');
  assert.match(css, /\.core-avatar\{[^}]*z-index:2;[^}]*width:112px;[^}]*height:112px/);
  assert.match(css, /\.liquid-orb-canvas\{[^}]*z-index:1/);
  assert.match(css, /transition:opacity \.9s/);
  assert.match(css, /@keyframes core-breathe/);
  assert.match(css, /body\[data-motion="reduced"\] \.membrane-wrap\{animation:none;scale:1;filter:none\}/);
  // retired layers are gone; the scene rail + hero slide replace them
  assert.doesNotMatch(css, /hybrid-avatar|handoff-avatar|worker-constellation|handoff-flow|data-topology/);
  assert.match(css, /\.companion-back\{z-index:2\}/);
  assert.match(css, /\.companion-front\{z-index:4\}/);
  assert.match(css, /body\[data-hero="true"\] \.core-entity\{left:56%/);
  assert.match(css, /\.companion-rail\{[^}]*right:4\.5%;top:14%/);
  const stage = read('stage.js');
  assert.match(stage, /previous\.canvas\.dataset\.active = 'false'/);
  assert.match(stage, /previous\.fadeTimer = setTimeout\(\(\) => disposeOrbLayer\(previous\), 950\)/);
  assert.match(stage, /sharedResources: previous\?\.controller\?\.getSharedResources\(\)/);
  assert.match(stage, /if \(orbStarting \|\| orbFailed \|\| !state.enabled \|\| document.hidden\) return;/);
  assert.doesNotMatch(stage, /handoff|worker-constellation|hybrid-node|drawParticles|restartParticles|particleClock/);
  const html = read('stage.html');
  assert.match(html, /data-companion-back/);
  assert.match(html, /data-companion-front/);
  assert.match(html, /data-group-members/);
  assert.match(html, /data-companion-rail/);
  assert.match(html, /data-transient-chip/);
  assert.doesNotMatch(html, /handoff-flow|hybrid-node|worker-constellation|animateMotion/);
  // the scene engine ships as its own asset, loaded before stage.js
  assert.ok(html.indexOf('__STAGE_SCENES_JS__') < html.indexOf('__STAGE_JS__'));
  const window = {};
  vm.runInNewContext(read('liquid-orb-effect.js'), { window });
  assert.match(window.LiquidOrbEffectSource, /max\(ballA, emissionAlpha\)/);
  assert.doesNotMatch(window.LiquidOrbEffectSource, /rimAlpha/);
});

test('interaction card renders through textContent only and drains clicks exactly once', () => {
  const stage = read('stage.js');
  assert.match(stage, /function renderInteraction\(\)/);
  assert.match(stage, /renderInteraction\(\);\n    scenesApi\?\.update\(state\);/);
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

test('the scene engine owns the rAF loop and applies state through update(state)', () => {
  const stage = read('stage.js');
  const scenes = read('stage-scenes.js');
  // the ambient particle field lives in the scene engine again (one shared
  // persistent instance for mind+machine); stage.js only drives the engine.
  assert.doesNotMatch(stage, /particleClock|drawParticles|restartParticles/);
  assert.match(stage, /scenesApi\?\.update\(state\)/, 'applyState drives the scene engine');
  assert.match(stage, /onFrame: updateTextMotion/, 'the engine frame hook keeps text pacing alive');
  assert.match(stage, /scene: scenesApi\?\.debug\?\.\(\) \?\? null/, 'debug hook reports scene state');
  assert.match(scenes, /window\.IDBotsLiveStageScenes/);
  assert.match(scenes, /requestAnimationFrame\(loop\)/);
  assert.match(scenes, /placeFactories\.particles/);
  assert.match(scenes, /mind: 'particles', machine: 'particles'/, 'mind + machine share one persistent particle field');
  assert.match(scenes, /placeFactories\['web-a'\]/);
  assert.match(scenes, /placeFactories\['chain-a'\]/);
  // prototype-only variants stay out of the production package
  assert.doesNotMatch(scenes, /placeFactories\['web-b'\]|placeFactories\['chain-b'\]|wire globe|hex lattice/i);
  // the starfield and circuit-board renderers are gone with the PCB route
  assert.doesNotMatch(scenes, /starfield|const far = \[|const mid = \[|workerRoute|circuit/i);
  assert.match(stage, /liquidOrbActivityForFamily\(state\.family\)/);
});

test('particles integrate phase and follow the orb activity multiplier', () => {
  const scenes = read('stage-scenes.js');
  // Ported verbatim from the pre-scene-system drawParticles: no absolute-time
  // angle — energy/family changes retune velocity without teleporting the
  // field, and reduced motion freezes the accumulated phase.
  assert.doesNotMatch(scenes, /now \* particle\.speed \* state\.motion\.energy/);
  assert.match(scenes, /p\.phase \+= dt \* p\.speed \* rate/);
  assert.match(scenes, /p\.angle \+ p\.phase \+ seed \* \.0001/);
  assert.match(scenes, /PARTICLE_ACTIVITY = \{ working: 1\.75, speaking: \.6, resting: \.5 \}/);
  assert.match(scenes, /bucket === 'waiting' \? \.95/, 'waiting keeps its slow .95 multiplier');
  assert.match(scenes, /1 - Math\.exp\(-dt \/ \.8\)/, '~0.8 s ease toward the activity target');
  assert.match(scenes, /if \(!reduced && dt > 0\)/, 'reduced motion never advances the phase');
  assert.match(scenes, /110 \+ random\(2\) \* 250/, 'radius band 110–360 from the original seed formula');
  assert.match(scenes, /\.18 \+ p\.drift \* \.35/, 'original alpha formula');
  assert.match(scenes, /index % 7 === 0/, 'cyan every seventh particle');
  // gather pull returns for the recall/run/read families (old local-recall)
  assert.match(scenes, /GATHER_FAMILIES = new Set\(\['local-recall', 'local-run', 'local-read'\]\)/);
  assert.match(scenes, /\.68 \+ Math\.sin\(tNow \* \.8 \+ p\.drift \* 6\) \* \.18/);
  // compressed orbit while a hero is active; presence orbit otherwise
  assert.match(scenes, /heroNow\) return \{ x: \.65, y: \.45 \}/);
  assert.match(scenes, /return \{ x: 1\.1, y: \.62 \}/);
  // report-ready / complete fixed arc
  assert.match(scenes, /-Math\.PI \* \.85 \+ \(index \/ particles\.length\) \* Math\.PI \* 1\.7/);
});

test('original worker connector curves: quadratic, dashed low-frequency, chevron head', () => {
  const scenes = read('stage-scenes.js');
  // Ported verbatim from the 36ff3c60d constellation block — curves only,
  // never polylines; no orthogonal/45° route helper may remain.
  assert.match(scenes, /g\.quadraticCurveTo\(ctrl\.x, ctrl\.y, toPt\.x, toPt\.y\)/);
  assert.match(scenes, /const bend = Math\.min\(34, Math\.max\(12, Math\.abs\(dx\) \* \.12\)\)/);
  assert.match(scenes, /x: r\.x - 4, y: r\.y \+ r\.h \/ 2/, 'card left-middle anchor');
  assert.match(scenes, /g\.setLineDash\(\[5, 7\]\)/, 'dashed low-frequency waiting/verifying link');
  assert.match(scenes, /dir === 'return' \|\| dir === 'verifying'/, 'returning direction');
  assert.match(scenes, /family\(\) === 'waiting' \|\| dir === 'waiting' \|\| dir === 'verifying'/, 'low-frequency gate');
  assert.match(scenes, /returning \? \.44 : \.38/, 'gold .44 / cyan .38 stroke alpha');
  assert.match(scenes, /headLen = 7/, 'chevron head length');
  assert.match(scenes, /angle - \.46/, 'chevron ±.46 rad');
  assert.match(scenes, /lowFreqWait \? \.11 : \.32/, 'pulse speeds');
  assert.match(scenes, /lowFreqWait \? 2 : 1/, 'two pulses while waiting');
  assert.match(scenes, /lowFreqWait \? 2\.8 : 3\.5/, 'pulse radii');
  assert.match(scenes, /t \* speed \+ index \* \.23 \+ pIdx \* \.5/, 'original pulse phase');
  assert.doesNotMatch(scenes, /workerRoute/, 'no orthogonal route helper remains');
});

test('SCENE_TIME_SCALE slows only the new scene animations', () => {
  const scenes = read('stage-scenes.js');
  assert.match(scenes, /LS\.SCENE_TIME_SCALE = 0\.6;/);
  // applied to place clocks, the scene clock, the group ring and reveals
  assert.match(scenes, /entry\.key === 'particles' \? dt : dt \* LS\.SCENE_TIME_SCALE/, 'particle field exempt');
  assert.match(scenes, /S\.tScene \+= dt \* LS\.SCENE_TIME_SCALE/, 'scene clock drives transients/verification/peers');
  assert.match(scenes, /drawGroupRing\(gBack, gFront, dt \* LS\.SCENE_TIME_SCALE, ts, fx\)/, 'group ring slowed');
  assert.match(scenes, /\(now - entry\.revealT0\) \* 1000 \* LS\.SCENE_TIME_SCALE/, 'reveal duration ×1/0.6');
  // worker curves take the real clock t, not the slowed ts
  assert.match(scenes, /drawWorker\(gFront, el, c\.status, fx, t, i, reduced\)/, 'worker curves exempt');
});

test('web/chain scene alpha is dimmed: base ×0.6, highlights ×0.75', () => {
  const scenes = read('stage-scenes.js');
  assert.match(scenes, /LS\.SCENE_ALPHA_BASE = 0\.6;/);
  assert.match(scenes, /LS\.SCENE_ALPHA_HI = 0\.75;/);
  assert.match(scenes, /g\.globalAlpha \*= aBase/, 'web mesh statics dimmed');
  assert.match(scenes, /0\.12 \* fade \* m \* aHi/, 'web waves are highlights');
  assert.match(scenes, /0\.13 \* m \* dimMul \+ \(boost \* 0\.42 \+ flash\) \* mHi \* dimMul/, 'chain block base vs lift/flash split');
});

test('scene avatars always resolve to a valid src and swap to the fallback once', () => {
  const scenes = read('stage-scenes.js');
  assert.match(scenes, /function setAvatar\(img, src\)/);
  assert.match(scenes, /window\.__FALLBACK_AVATAR__/);
  assert.match(scenes, /addEventListener\('error', \(\) => \{\s*if \(img\.src !== fb\) img\.src = fb;\s*\}, \{ once: true \}\)/, 'one-shot error swap, no retry loop');
  const stack = scenes.match(/setAvatar\(img, person\(pid\)\.avatar\)/);
  assert.ok(stack, 'group rail stack avatars use the fallback helper');
  assert.match(scenes, /setAvatar\(img, person\(c\.who\)\.avatar\)/, 'rail avatars use the fallback helper');
  assert.match(scenes, /setAvatar\(img, p\.avatar\)/, 'member/twin avatars use the fallback helper');
});

test('orb presets for the computer families revert to their original equivalents', () => {
  const orb = read('liquid-orb.js');
  assert.match(orb, /'local-recall': \{ style: 9, speed: \.85, radius: \.72, warp: 3\.5, contourDeform: \.55, glassOpacity: \.64, edgeGlow: \.08 \}/);
  assert.match(orb, /'local-run': \{ style: 9, speed: \.85, radius: \.72, warp: 3\.5, contourDeform: \.55, glassOpacity: \.64, edgeGlow: \.08 \}/, 'local-run = local-recall values');
  assert.match(orb, /'local-read': \{ style: 9, speed: \.85, radius: \.72, warp: 3\.5, contourDeform: \.55, glassOpacity: \.64, edgeGlow: \.08 \}/, 'local-read = local-recall values');
  assert.match(orb, /'browser-action': \{ style: 9, speed: \.92, radius: \.72, warp: 3\.6, contourDeform: \.48, glassOpacity: \.64, edgeGlow: \.08 \}/);
  assert.match(orb, /'desktop-control': \{ style: 9, speed: \.92, radius: \.72, warp: 3\.6, contourDeform: \.48, glassOpacity: \.64, edgeGlow: \.08 \}/, 'desktop-control = browser-action values');
  assert.match(orb, /projecting: \{ style: 9, speed: \.92, radius: \.72, warp: 3\.6, contourDeform: \.48, glassOpacity: \.64, edgeGlow: \.08 \}/, 'projecting = browser-action values');
});

test('the family membrane poses survive the scene engine (resting breathing regression)', () => {
  const css = read('stage.css');
  // The 2026-11-18 regression: a blanket body[data-family] reset added after
  // the family rules killed the report-ready/complete membrane transforms at
  // equal specificity. It must never come back.
  assert.doesNotMatch(css, /body\[data-family\] \.membrane-wrap\{transform:none/);
  assert.match(css, /body\[data-family="complete"\] \.membrane-wrap\{transform:scale\(\.88\)\}/);
  assert.match(css, /body\[data-family="report-ready"\] \.membrane-wrap\{transform:translateY\(-14px\) scale\(\.9\)\}/);
});

test('WebGPU orb compiles pipelines asynchronously and tears down late timed-out devices', () => {
  const orb = read('liquid-orb.js');
  const stage = read('stage.js');
  assert.match(orb, /device\.createRenderPipelineAsync\(pipelineDescriptor\)/);
  assert.match(orb, /const abortIfSignaled = \(\) =>/);
  assert.match(stage, /signal: abort\?\.signal/);
  assert.match(stage, /controller\.dispose\(!previous\?\.controller\)/);
  assert.match(stage, /fixedStyle: style/);
  assert.match(stage, /const ORB_START_TIMEOUT_MS = 20000;/);
  assert.match(stage, /console\.warn\('\[LiveStage\] WebGPU fallback:', message\)/);
  // A hung requestAdapter()/requestDevice() must still hit the 4.5s budget:
  // the GPU calls are raced against the budget signal so the WebGL2 tier runs
  // (a never-settling promise used to bypass the budget entirely).
  assert.match(orb, /function raceWithAbort\(/);
  assert.match(orb, /acquireHardwareDevice\(abortIfSignaled, budgetAbort\?\.signal\)/);
  // Terminal fallback is recoverable: bounded retry + re-show retry, and a
  // mid-session WebGL2 loss remounts instead of parking on the CSS membrane.
  assert.match(stage, /scheduleOrbRecovery\(\)/);
  assert.match(stage, /WebGL2 orb lost mid-session, remounting/);
  assert.match(stage, /orbFailed = false/);
  assert.match(stage, /clearOrbRecoveryTimer\(\)/);
});

test('WebGPU orb specializes and dead-code strips WGSL and provides a pixel-equivalent WebGL2 fallback', () => {
  const window = {};
  vm.runInNewContext(read('liquid-orb-effect.js'), { window });
  vm.runInNewContext(read('liquid-orb.js'), { window });
  const specialized = window.buildLiquidOrbShaderSource(window.LiquidOrbEffectSource, 9);
  assert.match(specialized, /fn glsPresetFluid\(p: vec2<f32>, style: i32, t: f32\) -> vec3<f32> \{\s*\n\s*return glsSiriFluid\(p, t\);\s*\n\}/);
  assert.match(specialized, /fn glsContourStrength\(\) -> f32 \{\s*\n\s*return 0\.09;\s*\n\}/);
  assert.match(specialized, /let style = 9;/);
  assert.match(specialized, /let s = 9;/);
  assert.doesNotMatch(specialized, /glsAuroraFluid/);
  assert.doesNotMatch(specialized, /fn glsFluid\(/);
  assert.doesNotMatch(specialized, /else \{ fcol = glsFluid\(fu, md, t\); \}/);
  assert.ok(specialized.length < window.LiquidOrbEffectSource.length * 0.5, 'dead-code stripping drops unused fluid presets');

  const glsl = window.buildLiquidOrbGlslSource(window.LiquidOrbEffectSource, 9);
  assert.match(glsl, /^#version 300 es/);
  assert.match(glsl, /layout\(std140\) uniform Uniforms \{[\s\S]*?\} u;/);
  assert.match(glsl, /vec3 glsSiriFluid\(vec2 p, float t\)/);
  assert.doesNotMatch(glsl, /glsAuroraFluid/);
  assert.doesNotMatch(glsl, /vec[234]<f32>|\batan2\(|\bselect\(/);

  const fullGlsl = window.buildLiquidOrbGlslSource(window.LiquidOrbEffectSource);
  assert.match(fullGlsl, /vec3 glsAuroraFluid\(vec2 p, float t\)/);
  assert.doesNotMatch(fullGlsl, /vec[234]<f32>|\batan2\(|\bselect\(/);

  const orb = read('liquid-orb.js');
  assert.match(orb, /powerPreference: 'high-performance'/);
  assert.match(orb, /powerPreference: 'low-power'/);
  assert.match(orb, /featureLevel: 'compatibility'/);
  assert.match(orb, /adapter\.info\?\.isFallbackAdapter \|\| adapter\.isFallbackAdapter/);
  assert.match(orb, /initWebGL2Backend\(canvas, options, startedAt, false\)/);
  // WebGPU canvas context must be requested AFTER pipeline compilation so a
  // failed/timed-out WebGPU startup leaves the canvas clean for WebGL2.
  assert.ok(orb.indexOf('createRenderPipelineAsync(pipelineDescriptor)') < orb.indexOf("canvas.getContext('webgpu')"));

  const stage = read('stage.js');
  assert.match(stage, /preferWebGL: orbPreferWebGL/);
  assert.match(stage, /WebGPU lost mid-session, switching to WebGL2/);

  const css = read('stage.css');
  assert.match(css, /body\[data-orb-backend="webgl2"\] \.liquid-orb-canvas\[data-active="true"\]\{opacity:1\}/);
  assert.match(css, /body\[data-orb-backend="webgl2"\] \.membrane\{border-color:transparent/);

  const main = fs.readFileSync(path.resolve('src/main/main.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(main, /app\.getGPUFeatureStatus\(\)/);
  assert.match(main, /app\.getGPUInfo\('basic'\)/);
  assert.match(main, /\\\[\(\?:LiveStage\|GenesisStage\|LiquidOrb\)\\\]\|WebGPU\|WebGL/);
});

test('companion rail avatars only accept the validated avatar schemes', () => {
  const scenes = read('stage-scenes.js');
  assert.match(scenes, /VALID_AVATAR = \/\^\(\?:data:image\\\/\|https\?:\\\/\\\/\|avatars\\\/\)\/i/);
  const css = read('stage.css');
  assert.match(css, /\.rail-avatar\{width:28px;height:28px/);
  assert.match(css, /\.rail-item\[data-hero="peer"\] \.rail-avatar\{width:40px;height:40px/);
});
