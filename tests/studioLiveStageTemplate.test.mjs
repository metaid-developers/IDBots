import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = Module.createRequire(import.meta.url);
const {
  resolveStudioLiveStageTemplate,
  loadLiveStageScenes,
  describeLiveStageFixtureIssues,
  resolveLiveStageScene,
} = require('../dist-electron/main/services/studioLiveStageTemplateRegistry.js');
const model = require('../dist-electron/main/services/studioLiveStageModel.js');
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');

const PACKAGE_ROOT = path.resolve('public/live-stage');
const DEMO_ROOT = path.join(PACKAGE_ROOT, 'demo');
// Playback order also declared by the demo player in index.html.
const DEMO_SEQUENCE = ['received', 'web2-research', 'metaweb-research', 'delegation', 'worker-report', 'verification', 'report-ready'];

const read = (relative) => fs.readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');

const message = (id, type, metadata = {}) => ({ id, type, content: '', timestamp: 1, metadata });

/** Minimal fake package: real render assets + injected manifest/scenes text. */
function fakePackage(t, { manifest, scenes, includeAssets = ['stage.css', 'liquid-orb-effect.js', 'liquid-orb.js', 'liquid-orb-LICENSE.txt'], renderOverride } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'live-stage-template-'));
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'stage.html'), path.join(cwd, 'stage.html'));
  if (renderOverride !== undefined) fs.writeFileSync(path.join(cwd, 'stage.html'), renderOverride, 'utf8');
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'index.html'), path.join(cwd, 'index.html'));
  for (const asset of includeAssets) fs.copyFileSync(path.join(PACKAGE_ROOT, asset), path.join(cwd, asset));
  fs.writeFileSync(path.join(cwd, 'template.json'), manifest ?? read('template.json'), 'utf8');
  fs.writeFileSync(path.join(cwd, 'scenes.json'), scenes ?? read('scenes.json'), 'utf8');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('official template resolves from the built-in package with a validated manifest and scenes', () => {
  const resolution = resolveStudioLiveStageTemplate({ assetRoot: PACKAGE_ROOT });
  assert.equal(resolution.status, 'ok');
  const template = resolution.template;
  assert.equal(template.templateId, 'studio-live-stage-official');
  assert.equal(template.templateVersion, '1.0.0');
  assert.equal(template.stageProtocol, 'idbots.live-stage.v1');
  assert.equal(template.sourceKind, 'builtin');
  assert.equal(template.entry, 'index.html');
  assert.equal(template.renderTemplate, 'stage.html');
  assert.equal(template.scenesPath, 'scenes.json');
  assert.equal(template.assetRoot, PACKAGE_ROOT);
  assert.deepEqual(template.capabilities, ['stage.applyPatch']);
  assert.equal(Object.keys(template.scenes.families).length, 16);
  assert.equal(fs.existsSync(path.join(PACKAGE_ROOT, template.entry)), true);
  assert.equal(fs.existsSync(path.join(DEMO_ROOT, 'received.json')), true);
});

test('incompatible manifests fall back safely instead of producing a blank projector', (t) => {
  const cases = [
    { name: 'unknown stage protocol', manifest: { stageProtocol: 'idbots.live-stage.v2' }, reason: /stageProtocol/ },
    { name: 'unsupported major version', manifest: { templateVersion: '2.0.0' }, reason: /major version/ },
    { name: 'malformed version', manifest: { templateVersion: '1.0' }, reason: /templateVersion/ },
    { name: 'missing entry file', manifest: { entry: 'nope.html' }, reason: /entry nope\.html is missing/ },
    { name: 'path traversal in render', manifest: { render: '../stage.html' }, reason: /invalid render path/ },
    { name: 'not offline', manifest: { offline: false }, reason: /offline/ },
    { name: 'unknown capability', manifest: { capabilities: ['stage.applyPatch', 'fs.read'] }, reason: /unknown capabilities/ },
    {
      name: 'broken render placeholder contract',
      renderOverride: '<!doctype html><html><body>no placeholders here</body></html>',
      reason: /__STAGE_CSS__/,
    },
    { name: 'missing render asset', includeAssets: ['stage.css', 'liquid-orb-effect.js', 'liquid-orb-LICENSE.txt'], reason: /liquid-orb\.js is missing/ },
  ];
  for (const testCase of cases) {
    const manifestJson = JSON.stringify({ ...JSON.parse(read('template.json')), ...testCase.manifest });
    const cwd = fakePackage(t, { manifest: manifestJson, includeAssets: testCase.includeAssets, renderOverride: testCase.renderOverride });
    const resolution = resolveStudioLiveStageTemplate({ assetRoot: cwd });
    assert.equal(resolution.status, 'fallback', testCase.name);
    assert.match(resolution.reason, testCase.reason, testCase.name);
  }
});

test('invalid scenes documents fall back with a reason', (t) => {
  const base = JSON.parse(read('scenes.json'));
  const cases = [
    { name: 'unknown family', mutate: (scenes) => { scenes.families['made-up'] = { orb: { style: 1, preset: 'x' } }; }, reason: /unknown scene family/ },
    { name: 'missing family', mutate: (scenes) => { delete scenes.families.waiting; }, reason: /missing scene family: waiting/ },
    { name: 'unbounded scene fields', mutate: (scenes) => { scenes.families.received.workerName = 'Sneaky'; }, reason: /unknown scene fields/ },
    { name: 'motion out of bounds', mutate: (scenes) => { scenes.families.making.motion.energy = 1.5; }, reason: /energy out of range/ },
    { name: 'fallback cycle', mutate: (scenes) => {
      scenes.families.received = { fallback: 'complete' };
      scenes.families.complete = { fallback: 'received' };
    }, reason: /fallback cycle/ },
    { name: 'fallback restating explicit fields', mutate: (scenes) => { scenes.families.received = { fallback: 'complete', composition: 'presence' }; }, reason: /must not restate/ },
    { name: 'wrong protocol', mutate: (scenes) => { scenes.protocol = 'idbots.live-stage.v2'; }, reason: /scenes protocol/ },
    { name: 'bad palette color', mutate: (scenes) => { scenes.palette.colorA = 'red'; }, reason: /palette/ },
    { name: 'reduced motion behavior outside the official set', mutate: (scenes) => { scenes.reducedMotion.behavior = 'spin'; }, reason: /reducedMotion/ },
  ];
  for (const testCase of cases) {
    const scenesJson = structuredClone(base);
    testCase.mutate(scenesJson);
    const result = loadLiveStageScenes(JSON.stringify(scenesJson));
    assert.equal(result.reason !== undefined, true, testCase.name);
    assert.match(result.reason, testCase.reason, testCase.name);
  }
});

test('scenes.json orb styles agree with the packaged orb family mapping', () => {
  const { scenes } = loadLiveStageScenes(read('scenes.json'));
  const window = {};
  vm.runInNewContext(read('liquid-orb.js'), { window });
  for (const [family, entry] of Object.entries(scenes.families)) {
    const resolved = resolveLiveStageScene(scenes, family);
    assert.equal(resolved.scene !== undefined, true, family);
    assert.equal(resolved.scene.orb.style, window.liquidOrbStyleForFamily(family), family);
  }
});

test('scenes.json agrees with the host model for composition, topology, and motion', () => {
  const { scenes } = loadLiveStageScenes(read('scenes.json'));
  const context = { sessionId: 's', turnId: 't', botName: 'B', language: 'en', directorEnabled: false };
  const fresh = () => model.createLiveStageState(context);
  // Deterministic entry path per family: the reducer for mid-turn families,
  // the dedicated terminal helpers for report-ready/complete/problem.
  const derived = {
    received: fresh(),
    reasoning: model.reduceLiveStageMessage(fresh(), message('a', 'assistant', { isThinking: true })),
    speaking: model.reduceLiveStageMessage(fresh(), message('b', 'assistant', {})),
    'local-recall': model.reduceLiveStageMessage(fresh(), message('c', 'tool_use', { toolName: 'read', toolUseId: 'c' })),
    'web2-research': model.reduceLiveStageMessage(fresh(), message('d', 'tool_use', { toolName: 'web_search', toolUseId: 'd' })),
    'metaweb-research': model.reduceLiveStageMessage(fresh(), message('e', 'tool_use', { toolName: 'omni_reader', toolUseId: 'e' })),
    making: model.reduceLiveStageMessage(fresh(), message('f', 'tool_use', { toolName: 'write', toolUseId: 'f' })),
    delegation: model.reduceLiveStageMessage(fresh(), message('g', 'tool_use', { toolName: 'local_worker_delegate', toolUseId: 'g' })),
    waiting: model.reduceLiveStageMessage(fresh(), message('h', 'tool_use', { toolName: 'longterm_subtask_wait', toolUseId: 'h' })),
    'worker-report': model.reduceLiveStageMessage(fresh(), message('i', 'user', { origin: 'cross_session' })),
    verification: model.reduceLiveStageMessage(fresh(), message('j', 'tool_use', { toolName: 'bot_browser_screenshot', toolUseId: 'j' })),
    'browser-action': model.reduceLiveStageMessage(fresh(), message('k', 'tool_use', { toolName: 'bot_browser_click', toolUseId: 'k' })),
    'owner-needed': model.reduceLiveStageMessage(fresh(), message('l', 'tool_use', { toolName: 'ask_user_question', toolUseId: 'l' })),
    problem: model.liveStageError(fresh()),
    'report-ready': model.reportReadyLiveStage(fresh()),
    complete: model.completeLiveStage(fresh()),
  };
  for (const [family, state] of Object.entries(derived)) {
    assert.equal(state.family, family, family);
    const scene = resolveLiveStageScene(scenes, family).scene;
    assert.equal(scene.composition, state.composition, `${family} composition`);
    assert.equal(scene.topology.mode, state.topology.mode, `${family} topology`);
    assert.equal(scene.motion.durationMs, state.motion.durationMs, `${family} durationMs`);
    assert.equal(scene.motion.energy, state.motion.energy, `${family} energy`);
    assert.equal(scene.motion.density, state.motion.density, `${family} density`);
    assert.equal(scene.motion.easing, state.motion.easing, `${family} easing`);
  }
});

test('demo fixtures are valid states, strictly increasing, and provably model-derived', () => {
  const fixtures = DEMO_SEQUENCE.map((name) => JSON.parse(read(path.join('demo', `${name}.json`))));
  const context = { sessionId: 'demo-live-stage', turnId: 'demo-turn-1', botName: 'Nova', language: 'en', directorEnabled: false };
  let state = model.createLiveStageState(context);
  const expected = { received: state };
  state = model.reduceLiveStageMessage(state, message('demo-tooluse-web-1', 'tool_use', { toolName: 'web_search', toolUseId: 'demo-web-1' }));
  expected['web2-research'] = state;
  state = model.reduceLiveStageMessage(state, message('demo-tooluse-omni-1', 'tool_use', { toolName: 'omni_reader', toolUseId: 'demo-omni-1' }));
  expected['metaweb-research'] = state;
  state = model.reduceLiveStageMessage(
    state,
    message('demo-tooluse-delegate-1', 'tool_use', { toolName: 'local_worker_delegate', toolUseId: 'demo-delegate-1', toolInput: { workerMetabotId: 7 } }),
    { workerName: 'Pixel' },
  );
  expected.delegation = state;
  state = model.reduceLiveStageMessage(
    state,
    message('demo-delivery-1', 'user', { origin: 'cross_session', sourceChannel: 'idbots_cross_session', sourceSessionId: 'demo-worker-session', crossSessionDeliveryId: 'demo-delivery-1' }),
    { workerName: 'Pixel' },
  );
  expected['worker-report'] = state;
  state = model.reduceLiveStageMessage(state, message('demo-tooluse-shot-1', 'tool_use', { toolName: 'bot_browser_screenshot', toolUseId: 'demo-shot-1' }));
  expected.verification = state;
  state = model.reportReadyLiveStage(state);
  expected['report-ready'] = state;

  let previousRevision = -1;
  DEMO_SEQUENCE.forEach((name, index) => {
    const fixture = fixtures[index];
    assert.deepEqual(describeLiveStageFixtureIssues(fixture), [], name);
    assert.deepEqual(fixture, expected[name], `${name} must match the host model derivation`);
    assert.ok(fixture.revision > previousRevision, `${name} revision must strictly increase`);
    previousRevision = fixture.revision;
  });
});

test('demo fixtures carry fictional data only', () => {
  for (const name of DEMO_SEQUENCE) {
    const raw = read(path.join('demo', `${name}.json`));
    const fixture = JSON.parse(raw);
    assert.equal(fixture.metrics.directorEnabled, false, name);
    assert.equal(fixture.metrics.directorCalls, 0, name);
    assert.equal(fixture.sessionId, 'demo-live-stage', name);
    assert.equal(fixture.botName, 'Nova', name);
    assert.doesNotMatch(raw, /\/Users\/|C:\\\\|AI_Sunny|sk-[a-zA-Z0-9]|preview-metaapp:/, name);
    assert.equal(raw.includes('data:image'), false, `${name}: no identity avatar in demo data`);
  }
});

test('.metaapp.json carries publication metadata consistent with the manifest and free of private data', () => {
  const raw = read('.metaapp.json');
  const metaapp = JSON.parse(raw);
  const template = JSON.parse(read('template.json'));
  assert.equal(metaapp.appName, 'studio-live-stage');
  assert.equal(metaapp.version, template.templateVersion, 'publication version must match template.json');
  assert.equal(metaapp.runtime, 'browser');
  assert.equal(metaapp.indexFile, template.entry, 'indexFile must match the template entry');
  assert.ok(typeof metaapp.title === 'string' && metaapp.title.trim(), 'title is required');
  assert.ok(Array.isArray(metaapp.tags) && metaapp.tags.length > 0, 'tags are required');
  // Publication metadata only: no local paths, credentials, runtime
  // bookkeeping keys, or identity avatars may leak into it.
  assert.doesNotMatch(raw, /\/Users\/|C:\\\\|sk-[a-zA-Z0-9]|preview-metaapp:|data:image/);
  assert.doesNotMatch(raw, /sessionId|turnId|pinId/, 'no runtime bookkeeping in publication metadata');
});

test('demo player stage DOM carries every data hook the packaged stage.js reads', () => {
  // stage.js throws inside applyState when a hook is missing (the worker-avatar
  // drift turned every demo patch into a silent mid-apply crash); keep the
  // player skeleton in lockstep with the packaged runtime.
  const html = read('index.html');
  const stageJs = read('stage.js');
  const hooks = [...new Set([...stageJs.matchAll(/\$\('\[data-([a-z-]+)\]'\)/g)].map((match) => match[1]))];
  assert.ok(hooks.length >= 15, 'hook extraction must stay meaningful');
  for (const hook of hooks) {
    assert.ok(html.includes(`data-${hook}`), `demo player must carry the data-${hook} element stage.js reads`);
  }
});

test('demo player is offline, self-contained, and boots the real stage runtime', () => {
  const html = read('index.html');
  const stageIndex = html.indexOf("stageScript.src = 'stage.js'");
  assert.ok(stageIndex > 0, 'stage.js must be injected dynamically');
  assert.ok(html.indexOf('__INITIAL_LIVE_STAGE__') < stageIndex, 'initial state must be set before stage.js boots');
  assert.ok(html.indexOf('sessionStorage.removeItem') !== -1 && html.indexOf('sessionStorage.removeItem') < stageIndex, 'stale demo revisions must be cleared before boot');
  assert.match(html, /IDBotsLiveStage\.applyPatch/);
  assert.match(html, /fictional/i, 'the page must disclose that the demo is fictional');
  // Every referenced asset is a relative file inside the package.
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  for (const reference of references) {
    assert.doesNotMatch(reference, /^(?:[a-z]+:)?\/\//, `no network references: ${reference}`);
    assert.doesNotMatch(reference, /^\/|\.\./, `package-relative only: ${reference}`);
    if (!reference.startsWith('demo/')) {
      assert.equal(fs.existsSync(path.join(PACKAGE_ROOT, reference)), true, reference);
    }
  }
  const sequenceMatch = html.match(/SEQUENCE = \[([^\]]+)\]/);
  assert.ok(sequenceMatch, 'playback order must be declared');
  const declaredSequence = sequenceMatch[1].split(',').map((item) => item.trim().replaceAll("'", ''));
  assert.deepEqual(declaredSequence, DEMO_SEQUENCE);
  for (const name of DEMO_SEQUENCE) {
    assert.equal(fs.existsSync(path.join(DEMO_ROOT, `${name}.json`)), true, name);
  }
  // The per-turn render template keeps its placeholder contract and the package carries its license.
  for (const asset of ['stage.html', 'stage.css', 'stage.js', 'liquid-orb.js', 'liquid-orb-effect.js', 'liquid-orb-LICENSE.txt', 'template.json', 'scenes.json', 'APP.md', 'default_metabot.png']) {
    assert.equal(fs.existsSync(path.join(PACKAGE_ROOT, asset)), true, asset);
  }
});

function serviceFixture(t, { resolveTemplate } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-stage-template-'));
  const session = { cwd, sessionType: 'browser', assistantMode: true, metabotId: 1, metabotName: 'AI_Sunny', metabotAvatar: 'data:image/jpeg;base64,AA==' };
  let resolveCalls = 0;
  const service = createStudioLiveStageService({
    getSession: (id) => (id === 's' ? session : null),
    getMetabotById: (id) => ({ name: 'AI_Sunny', avatar: session.metabotAvatar, llm_id: 'brain', llm_provider: 'test' }),
    getSettings: () => ({ enabled: true, directorEnabled: false }),
    getLanguage: () => 'en',
    project: async (input) => ({ uri: `preview-metaapp://localhost${input.localPath}`, tabId: 7, announced: true }),
    findStageTab: async () => 7,
    applyPatch: async () => undefined,
    assetRoot: PACKAGE_ROOT,
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    reportDelayMs: 0,
    resolveTemplate: resolveTemplate
      ? () => {
          resolveCalls += 1;
          return resolveTemplate();
        }
      : undefined,
  });
  t.after(() => {
    service.dispose();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temp dirs are OS-swept */ }
  });
  return { service, session, getResolveCalls: () => resolveCalls };
}

test('the service resolves the template once per turn and pins it for the whole turn', async (t) => {
  const { service, getResolveCalls } = serviceFixture(t, {
    resolveTemplate: () => resolveStudioLiveStageTemplate({ assetRoot: PACKAGE_ROOT }),
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  let run = service.getRunInternals('s');
  await run.queue;
  assert.equal(getResolveCalls(), 1);
  assert.equal(run.template.status, 'ok');
  assert.equal(run.template.template.templateId, 'studio-live-stage-official');
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'web_search', toolUseId: 'w' }));
  await run.queue;
  assert.equal(getResolveCalls(), 1, 'patches within a turn must not re-resolve the template');
  service.observeMessage('s', message('u2', 'user', { origin: 'user', submissionId: 'sub-2' }));
  run = service.getRunInternals('s');
  await run.queue;
  assert.equal(getResolveCalls(), 2, 'a new turn resolves the template again');
});

test('the service falls back to raw built-in assets when template resolution fails', async (t) => {
  const { service } = serviceFixture(t, { resolveTemplate: () => ({ status: 'fallback', reason: 'manifest unreadable' }) });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  assert.equal(run.template.status, 'fallback');
  const stage = fs.readFileSync(run.stagePath, 'utf8');
  assert.match(stage, /AI_Sunny/, 'the per-turn instance still renders with the built-in appearance');
  assert.match(stage, /liquidOrbStyleForFamily/, 'the same packaged orb runtime backs the fallback render');
  assert.match(stage, /"family":"received"/);
});

test('the built-in render path and the loader consume the same package source', async (t) => {
  const { renderLiveStageHtml } = require('../dist-electron/main/services/studioLiveStageTemplate.js');
  const fixture = JSON.parse(read(path.join('demo', 'worker-report.json')));
  const html = renderLiveStageHtml({
    state: fixture,
    avatarDataUri: 'data:image/png;base64,AA==',
    assets: { assetRoot: PACKAGE_ROOT, fallbackAvatarDataUri: 'data:image/png;base64,AA==' },
  });
  assert.match(html, /"family":"worker-report"/);
  assert.match(html, /"revision":4/);
  assert.match(html, /liquidOrbStyleForFamily/);
  assert.doesNotMatch(html, /__STAGE_CSS__|__INITIAL_STATE__|__ORB_EFFECT__|__ORB_RENDERER__|__STAGE_JS__|__AVATAR_DATA_URI__/);
  // The official package and its render output describe the same scene for the same fixture.
  const { scenes } = loadLiveStageScenes(read('scenes.json'));
  const orbWindow = {};
  vm.runInNewContext(read('liquid-orb.js'), { window: orbWindow });
  assert.equal(
    resolveLiveStageScene(scenes, fixture.family).scene.orb.style,
    orbWindow.liquidOrbStyleForFamily(fixture.family),
  );
});
