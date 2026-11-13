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
const { describeStudioTurnError } = require('../dist-electron/main/shared/studioTurnErrorCopy.js');
const { listStudioOpenDelegations } = require('../dist-electron/main/services/studioOpenDelegations.js');

const PACKAGE_ROOT = path.resolve('public/live-stage');
const DEMO_ROOT = path.join(PACKAGE_ROOT, 'demo');
// Playback order also declared by the demo player in index.html.
const DEMO_SEQUENCE = ['received', 'web2-research', 'metaweb-research', 'delegation', 'worker-report', 'verification', 'report-ready'];

const read = (relative) => fs.readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');

const message = (id, type, metadata = {}, content = '') => ({ id, type, content, timestamp: 1, metadata });

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
    speaking: model.reduceLiveStageMessage(fresh(), message('b', 'assistant', {}, 'Here is what I found. The details follow below.')),
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
    'report-ready': model.reportReadyLiveStage(fresh(), null),
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
  // phaseStartedAt is wall-clock in production; the fixtures pin one fixed
  // epoch so the derivation below stays deterministic.
  const NOW = 1_760_000_000_000;
  const context = { sessionId: 'demo-live-stage', turnId: 'demo-turn-1', botName: 'Nova', language: 'en', directorEnabled: false, nowMs: NOW };
  let state = model.createLiveStageState(context);
  const expected = { received: state };
  state = model.reduceLiveStageMessage(state, message('demo-tooluse-web-1', 'tool_use', { toolName: 'web_search', toolUseId: 'demo-web-1' }), { nowMs: NOW });
  expected['web2-research'] = state;
  state = model.reduceLiveStageMessage(state, message('demo-tooluse-omni-1', 'tool_use', { toolName: 'omni_reader', toolUseId: 'demo-omni-1' }), { nowMs: NOW });
  expected['metaweb-research'] = state;
  state = model.reduceLiveStageMessage(
    state,
    message('demo-tooluse-delegate-1', 'tool_use', { toolName: 'local_worker_delegate', toolUseId: 'demo-delegate-1', toolInput: { workerMetabotId: 7 } }),
    { workerName: 'Pixel', nowMs: NOW },
  );
  expected.delegation = state;
  state = model.reduceLiveStageMessage(
    state,
    message('demo-delivery-1', 'user', { origin: 'cross_session', sourceChannel: 'idbots_cross_session', sourceSessionId: 'demo-worker-session', crossSessionDeliveryId: 'demo-delivery-1' }),
    { workerName: 'Pixel', nowMs: NOW },
  );
  expected['worker-report'] = state;
  state = model.reduceLiveStageMessage(state, message('demo-tooluse-shot-1', 'tool_use', { toolName: 'bot_browser_screenshot', toolUseId: 'demo-shot-1' }), { nowMs: NOW });
  expected.verification = state;
  state = model.reportReadyLiveStage(state, null, NOW);
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

function serviceFixture(t, { resolveTemplate, applyPatch, listOpenDelegations, directScene, getLanguage, now, delegationRecheckMs, directorEnabled = false, getTabUri, stageTabUri } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-stage-template-'));
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-stage-root-'));
  const session = { cwd, sessionType: 'browser', assistantMode: true, metabotId: 1, metabotName: 'AI_Sunny', metabotAvatar: 'data:image/jpeg;base64,AA==' };
  const projected = [];
  let resolveCalls = 0;
  // Mirrors the renderer binding: the stage-role tab's current URI, updated
  // by each stage projection so the "already on the entry" fast path is real.
  let boundStageUri = stageTabUri ?? null;
  const service = createStudioLiveStageService({
    getSession: (id) => (id === 's' ? session : (id === 'worker-session' ? { ...session, metabotId: 2, metabotName: 'Builder阿码', metabotAvatar: 'data:image/png;base64,BB==' } : null)),
    getMetabotById: (id) => ({ name: id === 2 ? 'Builder阿码' : 'AI_Sunny', avatar: id === 2 ? 'data:image/png;base64,BB==' : session.metabotAvatar, llm_id: 'brain', llm_provider: 'test' }),
    getSettings: () => ({ enabled: true, directorEnabled }),
    getLanguage: getLanguage ?? (() => 'en'),
    project: async (input) => {
      projected.push(input);
      const uri = `preview-metaapp://localhost${input.localPath}`;
      if (input.role === 'stage') boundStageUri = uri;
      return { uri, tabId: 7, announced: true };
    },
    getStageTab: async () => ({ id: 7, uri: boundStageUri }),
    ...(getTabUri ? { getTabUri } : {}),
    applyPatch: applyPatch ?? (async () => undefined),
    ...(listOpenDelegations ? { listOpenDelegations } : {}),
    ...(directScene ? { directScene } : {}),
    ...(now ? { now } : {}),
    ...(delegationRecheckMs ? { delegationRecheckMs } : {}),
    stageRoot,
    assetRoot: PACKAGE_ROOT,
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    resolveTemplate: resolveTemplate
      ? () => {
          resolveCalls += 1;
          return resolveTemplate();
        }
      : undefined,
  });
  t.after(() => {
    service.dispose();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(stageRoot, { recursive: true, force: true });
    } catch { /* temp dirs are OS-swept */ }
  });
  return { service, session, projected, getResolveCalls: () => resolveCalls, getBoundStageUri: () => boundStageUri };
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
  // The persistent entry boots unclaimed — identity arrives through patches,
  // so the page carries the stage protocol and orb runtime, not a bot name.
  assert.match(stage, /idbots\.live-stage\.v1/, 'the fallback render keeps the stage protocol');
  assert.match(stage, /liquidOrbStyleForFamily/, 'the same packaged orb runtime backs the fallback render');
  assert.match(stage, /__INITIAL_LIVE_STAGE__=null/, 'the entry boots unclaimed for the first patch to claim');
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reasoned = (reason) => {
  const error = new Error(`patch rejected: ${reason}`);
  error.reason = reason;
  return error;
};

test('patch delivery retries a not-ready frame and lands the latest revision', async (t) => {
  const delivered = [];
  let failures = 2;
  const { service } = serviceFixture(t, {
    applyPatch: async (input) => {
      if (failures > 0) {
        failures -= 1;
        throw reasoned('not-ready');
      }
      delivered.push(input);
    },
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Please build the report.'));
  const run = service.getRunInternals('s');
  await run.queue;
  // More activity lands while the page is still not ready: retries must
  // deliver the LATEST state, never a queued older revision.
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'read', toolUseId: 'r1' }));
  service.observeMessage('s', message('tool-2', 'tool_use', { toolName: 'write', toolUseId: 'w1' }));
  await sleep(1400);
  await run.queue;
  assert.equal(failures, 0, 'the not-ready failures were retried');
  assert.ok(delivered.length >= 1, 'a patch eventually landed');
  assert.equal(delivered.at(-1).state.revision, service.getState('s').revision, 'the last delivery is the latest revision');
  assert.ok(delivered.at(-1).state.revision >= 3, 'later messages were coalesced into the delivered state');
});

test('a stale-revision rejection counts as delivered with no retry or re-projection', async (t) => {
  const delivered = [];
  let staleOnce = true;
  const { service, projected } = serviceFixture(t, {
    applyPatch: async (input) => {
      if (staleOnce) {
        staleOnce = false;
        throw reasoned('stale-revision');
      }
      delivered.push(input);
    },
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Please build the report.'));
  const run = service.getRunInternals('s');
  await run.queue;
  await sleep(300);
  assert.equal(run.retryTimer, null, 'stale-revision never arms a retry');
  assert.equal(run.selfHeals, 0, 'stale-revision never re-projects');
  assert.equal(projected.length, 1);
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'read', toolUseId: 'r1' }));
  await run.queue;
  await sleep(100);
  assert.ok(delivered.some((patch) => patch.state.revision > 1), 'the next revision still delivers after a stale rejection');
});

test('a session-mismatch rejection re-projects the stage entry and delivers the latest state', async (t) => {
  const delivered = [];
  const { service, projected } = serviceFixture(t, {
    applyPatch: async (input) => {
      if (projected.length === 1) throw reasoned('session-mismatch');
      delivered.push(input);
    },
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Please build the report.'));
  const run = service.getRunInternals('s');
  await run.queue;
  await sleep(400);
  await run.queue;
  assert.equal(projected.length, 2, 'the stage file was re-projected for the right turn');
  assert.equal(run.selfHeals, 1);
  assert.ok(delivered.length >= 1, 'the patch landed after the heal');
  assert.equal(delivered.at(-1).state.revision, service.getState('s').revision);
});

test('a narration bubble produces a speaking scene with markdown stripped and split', async (t) => {
  const { service } = serviceFixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeMessage('s', message('a1', 'assistant', {}, '**Ready.** The [report](https://example.com) is attached.\nSecond sentence here.'));
  await run.queue;
  const state = service.getState('s');
  assert.equal(state.family, 'speaking');
  assert.equal(state.kicker, 'AI_Sunny', 'the speaking kicker is the bot name, never a raw family id');
  assert.equal(state.headline, 'Ready.');
  assert.equal(state.caption, 'The report is attached. Second sentence here.');
  assert.equal(state.captionSource, 'specific');
  assert.doesNotMatch(state.headline + state.caption, /\*\*|\[|\]|https?:/);
});

test('the projector report receipt bubble never moves the scene', async (t) => {
  const { service } = serviceFixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  const before = service.getState('s');
  service.observeMessage('s', message('receipt', 'assistant', { projectorReport: { uri: 'preview-metaapp://localhost/x' } }, 'Receipt text that must not speak.'));
  await run.queue;
  assert.equal(service.getState('s'), before, 'the receipt is bookkeeping, not narration');
  assert.equal(service.getState('s').revision, before.revision);
});

test('observeMessageUpdate streams text for a seen assistant id and ignores unknown ids', async (t) => {
  const { service } = serviceFixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeMessage('s', message('a1', 'assistant', {}, 'Hello there. This is the start.'));
  await run.queue;
  assert.equal(service.getState('s').family, 'speaking');
  const revision = service.getState('s').revision;

  service.observeMessageUpdate('s', 'a1', 'Hello there. This is the start. And more.', { isStreaming: true });
  await run.queue;
  const streamed = service.getState('s');
  assert.ok(streamed.revision > revision);
  assert.match(streamed.caption, /And more/);

  service.observeMessageUpdate('s', 'a1', 'Hello there. This is the start. And more. Even more.', { isStreaming: true });
  await run.queue;
  assert.equal(service.getState('s').revision, streamed.revision, 'intermediate updates inside the throttle window are dropped');

  service.observeMessageUpdate('s', 'ghost-id', 'Whatever the owner never saw.', { isFinal: true });
  await run.queue;
  assert.equal(service.getState('s').revision, streamed.revision, 'unknown assistant ids are ignored');

  service.observeMessageUpdate('s', 'a1', 'Hello there. This is the start. And more. Even more.', { isFinal: true });
  await run.queue;
  const final = service.getState('s');
  assert.ok(final.revision > streamed.revision, 'a final update applies immediately');
  assert.match(final.caption, /Even more/);
});

test('describeLiveStageActivity narrates tools in plain owner-facing words', () => {
  const activity = model.describeLiveStageActivity;
  const bash = activity('bash', { description: 'Run the focused test file' }, 'en');
  assert.equal(bash.headline, 'Working on the computer');
  assert.equal(bash.caption, 'Run the focused test file');
  assert.equal(activity('bash', { description: 'x'.repeat(200) }, 'en').caption, undefined, 'overlong descriptions stay off the stage');
  assert.equal(activity('read', { path: '/tmp/reports/q3-summary.txt' }, 'en').headline, 'Reading q3-summary.txt');
  assert.equal(activity('read', { path: '/tmp/reports/q3-summary.txt' }, 'zh').headline, '正在查看 q3-summary.txt');
  const delegate = activity('local_worker_delegate', { objective: 'Fix the login flow. Then verify it.' }, 'en', 'Builder阿码');
  assert.equal(delegate.headline, 'Handing the task to Builder阿码');
  assert.equal(delegate.caption, 'Fix the login flow.');
  assert.equal(activity('web_search', { query: 'live stage projector' }, 'zh').headline, '正在网上查：live stage projector');
  assert.equal(activity('totally_unknown_tool', {}, 'en'), null, 'unknown tools fall back to the family default');
});

test('observeError renders honest owner-facing copy for quota and compaction failures', async (t) => {
  const { service } = serviceFixture(t, { getLanguage: () => 'zh' });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeError('s', 'LLM request failed: free_quota_exhausted (HTTP 402)');
  let state = service.getState('s');
  assert.equal(state.family, 'problem');
  assert.equal(state.headline, '这一轮没能完成');
  assert.match(state.caption, /模型的免费额度用完了/);
  assert.match(state.caption, /继续/);

  const { service: serviceEn } = serviceFixture(t);
  serviceEn.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const runEn = serviceEn.getRunInternals('s');
  await runEn.queue;
  serviceEn.observeError('s', 'DSH turn failed: Cannot switch to metaid-free/deepseek-4.1-flash: context compaction failed: no adapter registered for provider "deepseek-official"');
  state = serviceEn.getState('s');
  assert.equal(state.family, 'problem');
  assert.match(state.caption, /compaction failed/);
  assert.doesNotMatch(state.caption, /deepseek-official|adapter registered/, 'raw runtime details never reach the owner');

  assert.equal(describeStudioTurnError('free_quota_exhausted', 'zh').reason, '模型的免费额度用完了');
  assert.equal(describeStudioTurnError('free_quota_exhausted', 'en').reason, "The model's free quota is used up");
  assert.equal(describeStudioTurnError('mysterious failure', 'zh').reason, '运行时出了点问题');
});

test('completion after an observed error keeps the problem scene', async (t) => {
  const { service } = serviceFixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeError('s', 'boom');
  service.observeComplete('s');
  await run.queue;
  assert.equal(service.getState('s').family, 'problem', 'a late complete never overwrites the failure');
});

test('completion with open delegations waits on the workers, then completes when they finish', async (t) => {
  const startedAt = Date.now() - 3_600_000;
  // The real lookup sorts by startedAt ascending — the earliest worker is
  // the one the stage names.
  let open = [
    { attemptId: 'att-2', workerMetabotId: 3, workerName: 'Pixel', workerSessionId: 'ws-2', title: 'Draw the icon', startedAt },
    { attemptId: 'att-1', workerMetabotId: 2, workerName: 'Builder阿码', workerAvatar: 'data:image/png;base64,BB==', workerSessionId: 'ws-1', title: 'Fix the login bug', startedAt: startedAt + 60_000 },
  ];
  const { service } = serviceFixture(t, { listOpenDelegations: () => open, delegationRecheckMs: 20 });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeComplete('s');
  await run.queue;
  let state = service.getState('s');
  assert.equal(state.family, 'waiting', 'an unfinished delegation is never shown as done');
  assert.equal(state.topology.mode, 'structured');
  assert.equal(state.topology.nodes.find((node) => node.kind === 'worker').label, 'Pixel and 1 more', 'multiple workers collapse to first + count');
  assert.equal(state.topology.nodes.find((node) => node.kind === 'worker').avatar, undefined, 'the first worker has no avatar here');
  assert.match(state.caption, /Draw the icon/, 'the caption carries the first delegation title');
  assert.equal(state.phaseStartedAt, startedAt, 'the elapsed clock measures from the earliest worker start');
  assert.equal(run.awaitingDelegation, true);

  open = [];
  await sleep(90);
  await run.queue;
  state = service.getState('s');
  assert.equal(state.family, 'complete', 'the stage completes once no workers remain');
  assert.equal(run.awaitingDelegation, false);
});

test('listStudioOpenDelegations keeps timed-out-but-running workers and enforces the 24h cutoff', () => {
  const NOW = Date.parse('2026-02-01T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const attempts = [
    { id: 'att-run', stepId: 'step-1', workerMetabotId: 2, workerSessionId: 'ws-1', status: 'running', queuedAt: iso(NOW - 3_600_000), startedAt: iso(NOW - 3_500_000) },
    { id: 'att-timeout', stepId: 'step-2', workerMetabotId: 3, workerSessionId: 'ws-2', status: 'timed_out', queuedAt: iso(NOW - 7_200_000), startedAt: iso(NOW - 7_000_000) },
    { id: 'att-ancient', stepId: 'step-3', workerMetabotId: 4, workerSessionId: 'ws-3', status: 'running', queuedAt: iso(NOW - 25 * 3_600_000), startedAt: null },
    { id: 'att-done', stepId: 'step-4', workerMetabotId: 5, workerSessionId: 'ws-4', status: 'running', queuedAt: iso(NOW - 1_000_000), startedAt: iso(NOW - 900_000) },
    { id: 'att-dead-worker', stepId: 'step-5', workerMetabotId: 6, workerSessionId: 'ws-5', status: 'timed_out', queuedAt: iso(NOW - 600_000), startedAt: iso(NOW - 500_000) },
  ];
  const deps = {
    listAttemptsForSourceSessions: (ids) => (ids.includes('src-session') ? attempts : []),
    getStep: (id) => ({ id, title: `Step title for ${id}` }),
    getTaskForStep: (id) => (id === 'step-4'
      ? { status: 'completed', ownerIntent: 'Already done' }
      : { status: 'running', ownerIntent: `First line of intent for ${id}\nsecond line stays out` }),
    getSession: (id) => ({ status: id === 'ws-2' ? 'running' : 'completed' }),
    getMetabotById: (id) => ({ name: `Bot${id}`, avatar: id === 2 ? 'data:image/png;base64,AA==' : 'file:///not-allowed' }),
  };
  const list = listStudioOpenDelegations(deps, 'src-session', NOW);
  assert.deepEqual(list.map((entry) => entry.attemptId), ['att-timeout', 'att-run'], 'sorted by startedAt; the timed-out-but-running worker stays open');
  const timeout = list[0];
  assert.equal(timeout.workerName, 'Bot3');
  assert.equal(timeout.workerAvatar, undefined, 'non-http(s)/data avatars are dropped');
  assert.equal(timeout.title, 'First line of intent for step-2');
  assert.equal(timeout.startedAt, NOW - 7_000_000);
  const running = list[1];
  assert.equal(running.workerAvatar, 'data:image/png;base64,AA==');
  assert.equal(listStudioOpenDelegations(deps, 'other-session', NOW).length, 0, 'attempts belong to their source session only');
});

test('activity after a finished run starts a fresh stage while runtime noise does not', async (t) => {
  const { service, projected } = serviceFixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run1 = service.getRunInternals('s');
  await run1.queue;
  service.observeComplete('s');
  await run1.queue;
  assert.equal(service.getState('s').family, 'complete');
  assert.equal(projected.length, 1);

  service.observeMessage('s', message('noise', 'system', { sdkRuntimeStatus: 'requesting' }));
  assert.strictEqual(service.getRunInternals('s'), run1, 'system runtime-status noise never restarts the stage');
  assert.equal(projected.length, 1);

  service.observeMessage('s', message('a1', 'assistant', {}, 'A fresh turn narration.'));
  const run2 = service.getRunInternals('s');
  assert.notStrictEqual(run2, run1, 'real activity after completion owns a new stage');
  assert.notEqual(run2.state.turnId, run1.state.turnId, 'the new run is a new turn on the same persistent page');
  assert.equal(run2.stagePath, run1.stagePath, 'every run shares the materialized entry');
  await run2.queue;
  assert.equal(projected.length, 1, 'the bound stage tab already shows the entry — the new turn only patches');
  assert.equal(service.getState('s').family, 'speaking');
});

test('a worker report arriving after the projection starts a fresh run', async (t) => {
  const { service, projected } = serviceFixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  await service.projectReport({ sessionId: 's', localPath: '/tmp/report.html' }, async () => ({ uri: 'preview-metaapp://localhost/tmp/report.html', tabId: 7, announced: true }));
  assert.equal(run.reportProjected, true);
  const projectedCount = projected.length;
  service.observeMessage('s', message('w1', 'user', { sourceChannel: 'idbots_cross_session', sourceSessionId: 'worker-session', crossSessionDeliveryId: 'd-1' }));
  const run2 = service.getRunInternals('s');
  assert.notStrictEqual(run2, run, 'a post-projection worker report is a new beat, not ignored history');
  await run2.queue;
  // The report lives on the showcase tab now: the stage keeps its persistent
  // page and the new beat arrives as ordinary patches — no re-projection.
  assert.equal(projected.length, projectedCount, 'the persistent stage patches the new beat without re-projecting');
  assert.equal(run2.stagePath, run.stagePath);
  assert.equal(service.getState('s').family, 'worker-report');
});

test('the Director restyles only family-default captions and never runs for speaking', async (t) => {
  const calls = [];
  const { service } = serviceFixture(t, {
    directorEnabled: true,
    directScene: async (state) => {
      calls.push(state);
      return {
        scene: { caption: 'Director caption.', composition: state.composition, motif: 'liquid', motion: state.motion },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, latencyMs: 1 },
      };
    },
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  service.observeMessage('s', message('t1', 'tool_use', { toolName: 'read', toolUseId: 'r1' }));
  await sleep(1200);
  let state = service.getState('s');
  assert.ok(calls.length >= 1, 'the Director ran for a working family with a default caption');
  assert.equal(state.caption, 'Director caption.');
  assert.equal(state.headline, 'Reading a file', 'the headline is host-owned — the Director cannot rewrite it');

  service.observeMessage('s', message('a1', 'assistant', {}, 'Here is the answer you asked for.'));
  await sleep(1200);
  state = service.getState('s');
  assert.equal(state.family, 'speaking');
  const callsAfterSpeech = calls.length;
  await sleep(1200);
  assert.equal(calls.length, callsAfterSpeech, 'the Director is skipped for speaking and specific captions');
});

test('a self-heal never projects over a tab the Twin navigated to another page', async (t) => {
  let tabUri = 'metaapp://localhost/twin-workspace/app';
  const { service, projected } = serviceFixture(t, {
    getTabUri: async () => tabUri,
    applyPatch: async () => { throw reasoned('session-mismatch'); },
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Please build the report.'));
  const run = service.getRunInternals('s');
  await run.queue;
  await sleep(50);
  assert.equal(projected.length, 1, 'no re-projection while the tab shows a foreign page');
  assert.equal(run.selfHeals, 0);
  assert.equal(run.tabParked, true);
  assert.equal(run.retryTimer, null, 'parked delivery arms no retry timer');

  // The next state change earns exactly one cheap delivery attempt; the tab
  // is still foreign, so it parks again without healing.
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'read', toolUseId: 'r1' }));
  await run.queue;
  await sleep(50);
  assert.equal(projected.length, 1);
  assert.equal(run.selfHeals, 0);
  assert.equal(run.tabParked, true);

  // The tab is gone entirely → the heal is allowed again.
  tabUri = null;
  service.observeMessage('s', message('tool-2', 'tool_use', { toolName: 'write', toolUseId: 'w1' }));
  await run.queue;
  await sleep(100);
  await run.queue;
  assert.equal(projected.length, 2, 'a missing tab heals normally');
  assert.equal(run.selfHeals, 1);
  assert.equal(run.tabParked, false);
});

test('a streamed final reply lands as speaking even after work families', async (t) => {
  const { service } = serviceFixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Please build the report.'));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'write', toolUseId: 'w1' }));
  await run.queue;
  assert.equal(service.getState('s').family, 'making');
  // The final reply bubble arrives with empty content — the text only shows
  // up through messageUpdate afterwards.
  service.observeMessage('s', message('a1', 'assistant', {}, ''));
  await run.queue;
  assert.equal(service.getState('s').family, 'making', 'the empty bubble does not move the scene yet');
  assert.equal(run.latestSpeakingId, 'a1');

  service.observeMessageUpdate('s', 'a1', 'The report is ready. Every number was double-checked.', { isFinal: true });
  await run.queue;
  const state = service.getState('s');
  assert.equal(state.family, 'speaking');
  assert.equal(state.headline, 'The report is ready.');
  assert.match(state.caption, /double-checked/);

  // An update for an older assistant id is rejected even though it is known.
  service.observeMessage('s', message('a2', 'assistant', {}, 'A newer bubble.'));
  await run.queue;
  const beforeStale = service.getState('s').revision;
  service.observeMessageUpdate('s', 'a1', 'Stale text from the older bubble.', { isFinal: true });
  await run.queue;
  assert.equal(service.getState('s').revision, beforeStale, 'older assistant ids never reach the stage');
});
