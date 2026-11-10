import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);
const { createBotHubLiveStageService } = require('../dist-electron/main/services/botHubLiveStageService.js');
const { readBotHubLiveStageSettings, writeBotHubLiveStageSettings, BOT_HUB_LIVE_STAGE_KEY, BOT_HUB_LIVE_STAGE_DIRECTOR_KEY } = require('../dist-electron/main/services/botHubLiveStageSettings.js');

const message = (id, type, metadata = {}) => ({ id, type, content: '', timestamp: 1, metadata });

function fixture(t, directorEnabled = false, initialTabId = 7) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bothub-live-stage-'));
  const session = {
    cwd,
    sessionType: 'browser',
    assistantMode: true,
    metabotId: 1,
    metabotName: 'AI_Sunny',
    metabotAvatar: 'data:image/jpeg;base64,AA==',
  };
  const projected = [], patches = [], calls = [];
  const settings = { enabled: true, directorEnabled };
  const service = createBotHubLiveStageService({
    getSession: () => session,
    getMetabotById: () => ({ name: 'AI_Sunny', avatar: session.metabotAvatar, llm_id: 'brain', llm_provider: 'test' }),
    getSettings: () => settings,
    getLanguage: () => 'en',
    project: async (input) => { projected.push(input); return { uri: `preview-metaapp://localhost${input.localPath}`, tabId: initialTabId, announced: true }; },
    findStageTab: async () => 7,
    applyPatch: async (input) => { patches.push(input); },
    assetRoot: path.resolve('public/live-stage'),
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    reportDelayMs: 0,
    directScene: async (state) => {
      calls.push(state);
      return {
        scene: { headline: 'Generated scene', caption: 'Generated safely.', composition: state.composition, motif: 'liquid', motion: state.motion },
        usage: { inputTokens: 120, outputTokens: 24, cacheReadTokens: 80, cacheCreationTokens: 40, latencyMs: 12 },
      };
    },
  });
  t.after(() => {
    service.dispose();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });
  return { service, session, projected, patches, calls, settings };
}

test('settings default on and Director follows the Live Stage toggle', () => {
  const values = new Map();
  const store = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  assert.deepEqual(readBotHubLiveStageSettings(store), { enabled: true, directorEnabled: true });
  assert.deepEqual(writeBotHubLiveStageSettings(store, { directorEnabled: false }), { enabled: true, directorEnabled: true });
  assert.deepEqual(writeBotHubLiveStageSettings(store, { enabled: false }), { enabled: false, directorEnabled: false });
  assert.equal(values.get(BOT_HUB_LIVE_STAGE_KEY), '0');
  assert.equal(values.get(BOT_HUB_LIVE_STAGE_DIRECTOR_KEY), '0');
  assert.deepEqual(readBotHubLiveStageSettings(store), { enabled: false, directorEnabled: false });
  assert.deepEqual(writeBotHubLiveStageSettings(store, { enabled: true }), { enabled: true, directorEnabled: true });
  assert.equal(values.get(BOT_HUB_LIVE_STAGE_KEY), '1');
  assert.equal(values.get(BOT_HUB_LIVE_STAGE_DIRECTOR_KEY), '1');
});

test('service writes one stage per turn, dedupes messages, and preserves report readiness', async (t) => {
  const { service, projected, patches } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  let run = service.getRunInternals('s');
  await run.queue;
  const firstStage = run.stagePath;
  assert.ok(fs.existsSync(firstStage));
  assert.match(fs.readFileSync(firstStage, 'utf8'), /AI_Sunny/);
  assert.equal(projected.length, 1);

  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'local_worker_delegate', toolUseId: 'worker' }));
  await run.queue;
  assert.equal(service.getState('s').topology.mode, 'structured');
  const revision = service.getState('s').revision;
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'local_worker_delegate', toolUseId: 'worker' }));
  assert.equal(service.getState('s').revision, revision);
  assert.ok(patches.length >= 2);

  service.observeMessage('s', message('u2', 'user', { origin: 'user', submissionId: 'sub-2' }));
  run = service.getRunInternals('s');
  await run.queue;
  assert.notEqual(run.stagePath, firstStage, 'every turn owns a distinct history file');
  await service.projectReport({ sessionId: 's', localPath: '/tmp/final-report.html' }, async () => ({ uri: 'preview-metaapp://localhost/tmp/final-report.html', tabId: 7, announced: false }));
  assert.equal(service.getState('s').family, 'report-ready');
  assert.equal(service.getState('s').composition, 'ready');
});

test('Director coalesces calls and accumulates measured tokens without blocking the scene', async (t) => {
  const { service, calls } = fixture(t, true);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  for (let index = 0; index < 12; index += 1) {
    service.observeMessage('s', message(`tool-${index}`, 'tool_use', { toolName: index % 2 ? 'conversation_search' : 'local_worker_delegate', toolUseId: `t-${index}` }));
  }
  await new Promise((resolve) => setTimeout(resolve, 1150));
  const state = service.getState('s');
  assert.ok(calls.length > 0 && calls.length <= 8);
  assert.equal(state.metrics.directorCalls, calls.length);
  assert.equal(state.metrics.inputTokens, calls.length * 120);
  assert.equal(state.metrics.outputTokens, calls.length * 24);
  assert.equal(state.metrics.cacheReadTokens, calls.length * 80);
  assert.equal(state.metrics.cacheCreationTokens, calls.length * 40);
  assert.equal(state.metrics.fallbackCount, 0);
  assert.equal(state.headline, 'Generated scene');
});

test('a null first projection tab id is recovered through stage URI lookup', async (t) => {
  const { service, patches } = fixture(t, false, null);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  assert.equal(run.tabId, 7);
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'conversation_search', toolUseId: 'local' }));
  await run.queue;
  assert.equal(service.getState('s').family, 'local-recall');
  assert.ok(patches.some((patch) => patch.tabId === 7 && patch.state.family === 'local-recall'));
});
