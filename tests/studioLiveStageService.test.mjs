import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');
const { readStudioLiveStageSettings, writeStudioLiveStageSettings, STUDIO_LIVE_STAGE_KEY, STUDIO_LIVE_STAGE_DIRECTOR_KEY } = require('../dist-electron/main/services/studioLiveStageSettings.js');

const message = (id, type, metadata = {}) => ({ id, type, content: '', timestamp: 1, metadata });

function fixture(t, directorEnabled = false, initialTabId = 7, directSceneOverride = null) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-stage-'));
  const session = {
    cwd,
    sessionType: 'browser',
    assistantMode: true,
    metabotId: 1,
    metabotName: 'AI_Sunny',
    metabotAvatar: 'data:image/jpeg;base64,AA==',
  };
  const projected = [], patches = [], calls = [], drainQueue = [], responses = [];
  const settings = { enabled: true, directorEnabled };
  const service = createStudioLiveStageService({
    getSession: (id) => id === 'worker-session' ? { ...session, metabotId: 2, metabotName: 'Builder阿码', metabotAvatar: 'data:image/png;base64,BB==' } : session,
    getMetabotById: (id) => ({ name: id === 2 ? 'Builder阿码' : 'AI_Sunny', avatar: id === 2 ? 'data:image/png;base64,BB==' : session.metabotAvatar, llm_id: 'brain', llm_provider: 'test' }),
    getSettings: () => settings,
    getLanguage: () => 'en',
    project: async (input) => { projected.push(input); return { uri: `preview-metaapp://localhost${input.localPath}`, tabId: initialTabId, announced: true }; },
    findStageTab: async () => 7,
    applyPatch: async (input) => { patches.push(input); },
    drainInteractions: async () => drainQueue.splice(0, drainQueue.length),
    respondToPermission: (requestId, result) => { responses.push({ requestId, result }); },
    interactionPollMs: 10,
    assetRoot: path.resolve('public/live-stage'),
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    directScene: directSceneOverride ?? (async (state) => {
      calls.push(state);
      return {
        scene: { headline: 'Generated scene', caption: 'Generated safely.', composition: state.composition, motif: 'liquid', motion: state.motion },
        usage: { inputTokens: 120, outputTokens: 24, cacheReadTokens: 80, cacheCreationTokens: 40, latencyMs: 12 },
      };
    }),
  });
  t.after(() => {
    service.dispose();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });
  return { service, session, projected, patches, calls, settings, drainQueue, responses };
}

test('settings default on and Director follows the Live Stage toggle', () => {
  const values = new Map();
  const store = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  assert.deepEqual(readStudioLiveStageSettings(store), { enabled: true, directorEnabled: true });
  assert.deepEqual(writeStudioLiveStageSettings(store, { directorEnabled: false }), { enabled: true, directorEnabled: true });
  assert.deepEqual(writeStudioLiveStageSettings(store, { enabled: false }), { enabled: false, directorEnabled: false });
  assert.equal(values.get(STUDIO_LIVE_STAGE_KEY), '0');
  assert.equal(values.get(STUDIO_LIVE_STAGE_DIRECTOR_KEY), '0');
  assert.deepEqual(readStudioLiveStageSettings(store), { enabled: false, directorEnabled: false });
  assert.deepEqual(writeStudioLiveStageSettings(store, { enabled: true }), { enabled: true, directorEnabled: true });
  assert.equal(values.get(STUDIO_LIVE_STAGE_KEY), '1');
  assert.equal(values.get(STUDIO_LIVE_STAGE_DIRECTOR_KEY), '1');
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
  await service.projectReport({ sessionId: 's', localPath: '/tmp/final-report.html' }, async () => ({ uri: 'preview-metaapp://localhost/tmp/final-report.html', tabId: 7, announced: true }));
  assert.equal(service.getState('s').family, 'report-ready');
  assert.equal(service.getState('s').composition, 'ready');
  assert.equal(run.reportProjected, true);
  const patchCount = patches.length;
  service.observeMessage('s', message('final', 'assistant', { isFinal: true }));
  service.observeComplete('s');
  await run.queue;
  assert.equal(service.getState('s').family, 'report-ready');
  assert.equal(patches.length, patchCount, 'late turn events never patch the report frame');
});

test('Director coalesces calls and accumulates measured tokens without blocking the scene', async (t) => {
  const { service, calls } = fixture(t, true);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  for (let index = 0; index < 12; index += 1) {
    service.observeMessage('s', message(`tool-${index}`, 'tool_use', { toolName: index % 2 ? 'conversation_search' : 'local_worker_delegate', toolUseId: `t-${index}` }));
  }
  await new Promise((resolve) => setTimeout(resolve, 1150));
  const state = service.getState('s');
  assert.ok(calls.length > 0 && calls.length <= 4);
  assert.equal(state.metrics.directorCalls, calls.length);
  assert.equal(state.metrics.inputTokens, calls.length * 120);
  assert.equal(state.metrics.outputTokens, calls.length * 24);
  assert.equal(state.metrics.cacheReadTokens, calls.length * 80);
  assert.equal(state.metrics.cacheCreationTokens, calls.length * 40);
  assert.equal(state.metrics.fallbackCount, 0);
  assert.equal(state.headline, 'Generated scene');
});

test('Director stops requesting after consecutive failures and keeps deterministic scenes', async (t) => {
  const failures = [];
  const { service } = fixture(t, true, 7, async () => {
    failures.push('failed');
    throw new Error('provider unavailable');
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'conversation_search', toolUseId: 'tool-1' }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  service.observeMessage('s', message('tool-2', 'tool_use', { toolName: 'conversation_search', toolUseId: 'tool-2' }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(failures.length, 2);
  assert.equal(service.getState('s').metrics.fallbackCount, 2);
  assert.equal(service.getState('s').family, 'local-recall');
});

test('projection cancels queued Director work', async (t) => {
  const { service, calls } = fixture(t, true);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  assert.ok(run.directorTimer);
  await service.projectReport({ sessionId: 's', localPath: '/tmp/final-report.html' }, async () => ({ uri: 'preview-metaapp://localhost/tmp/final-report.html', tabId: 7, announced: true }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(calls.length, 0);
  assert.equal(run.directorTimer, null);
  assert.equal(run.reportProjected, true);
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


test('real worker receipts stay in the same turn and name the source session Bot', async (t) => {
  const { service } = fixture(t);
  service.observeMessage('s', message('human', 'user', { origin: 'user', submissionId: 'turn-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  const stagePath = run.stagePath;

  service.observeMessage('s', message('delegate', 'tool_use', {
    toolName: 'local_worker_delegate',
    toolInput: { workerMetabotId: 2 },
    toolUseId: 'call-1',
  }));
  await run.queue;
  assert.deepEqual(service.getState('s').handoff, { direction: 'dispatch', eventId: 'call-1' });
  assert.equal(service.getState('s').topology.nodes.find((node) => node.kind === 'worker').label, 'Builder阿码');

  service.observeMessage('s', message('orch_notify:delivery-1', 'user', {
    sourceChannel: 'idbots_cross_session',
    sourceSessionId: 'worker-session',
    crossSessionDeliveryId: 'delivery-1',
  }));
  await run.queue;
  assert.strictEqual(service.getRunInternals('s'), run, 'a worker receipt must not start a new turn');
  assert.equal(run.stagePath, stagePath);
  assert.equal(service.getState('s').family, 'worker-report');
  assert.deepEqual(service.getState('s').handoff, { direction: 'return', eventId: 'delivery-1' });
  assert.equal(service.getState('s').topology.nodes.find((node) => node.kind === 'worker').label, 'Builder阿码');

  service.observeMessage('s', message('verify', 'tool_use', { toolName: 'twin_task_accept', toolUseId: 'accept-1' }));
  await run.queue;
  assert.equal(service.getState('s').family, 'verification');
  assert.equal(service.getState('s').handoff, null);
});


test('prepareSession starts the stage before the first message without Director work', async (t) => {
  const { service, projected, calls } = fixture(t);
  service.prepareSession('s');
  const run = service.getRunInternals('s');
  await run.queue;
  assert.equal(projected.length, 1);
  assert.equal(run.state.family, 'received');
  assert.equal(run.state.metrics.directorCalls, 0);
  assert.equal(calls.length, 0);
  service.prepareSession('s');
  await run.queue;
  assert.equal(projected.length, 1, 'prewarm must be idempotent');
});

test('worker identity resolves the Avatar from the trusted source session', async (t) => {
  const { service } = fixture(t);
  service.prepareSession('s');
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeMessage('s', message('receipt', 'user', {
    sourceChannel: 'idbots_cross_session',
    sourceSessionId: 'worker-session',
    crossSessionDeliveryId: 'delivery-avatar',
  }));
  await run.queue;
  assert.equal(service.getState('s').topology.nodes.find((node) => node.kind === 'worker').avatar, 'data:image/png;base64,BB==');
});

const waitFor = async (predicate, ms = 1000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const askRequest = (requestId = 'ask-1') => ({
  requestId,
  toolName: 'AskUserQuestion',
  toolInput: { questions: [{ question: 'Which speed?', options: [{ label: 'Fast' }, { label: 'Slow' }] }] },
});

test('a presented ask drains a stage answer into the host permission sink', async (t) => {
  const { service, patches, responses, drainQueue } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;

  assert.equal(service.presentInteraction('s', askRequest()), 'presented');
  const interaction = service.getState('s').interaction;
  assert.ok(interaction);
  assert.match(interaction.token, /^[0-9a-f]{32}$/);
  await run.queue;
  assert.ok(patches.some((patch) => patch.state.interaction?.requestId === 'ask-1'), 'the card reached the stage');

  drainQueue.push({ requestId: 'ask-1', token: interaction.token, behavior: 'allow', answers: { 'Which speed?': 'Fast' } });
  await waitFor(() => responses.length > 0);
  assert.equal(responses[0].requestId, 'ask-1');
  assert.equal(responses[0].result.behavior, 'allow');
  assert.equal(responses[0].result.updatedInput.answers['Which speed?'], 'Fast');
  assert.equal(service.getState('s').interaction, null, 'the card clears once answered');
});

test('a stage deny resolves fail-closed and mismatched tokens are dropped', async (t) => {
  const { service, responses, drainQueue } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.presentInteraction('s', askRequest('ask-2'));
  const token = service.getState('s').interaction.token;

  drainQueue.push({ requestId: 'ask-2', token: 'wrong-token', behavior: 'allow', answers: {} });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(responses.length, 0, 'a forged token never resolves the prompt');

  drainQueue.push({ requestId: 'ask-2', token, behavior: 'deny' });
  await waitFor(() => responses.length > 0);
  assert.equal(responses[0].result.behavior, 'deny');
});

test('plain approvals answer with a bare allow and watchdog metadata stays intact', async (t) => {
  const { service, responses, drainQueue } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.presentInteraction('s', { requestId: 'perm-1', toolName: 'Bash', toolInput: { reason: 'run tests' }, expiresAt: Date.now() + 60000, timeoutDefault: 'deny' });
  const interaction = service.getState('s').interaction;
  assert.equal(interaction.kind, 'approval');
  assert.equal(interaction.timeoutDefault, 'deny');

  drainQueue.push({ requestId: 'perm-1', token: interaction.token, behavior: 'allow' });
  await waitFor(() => responses.length > 0);
  assert.deepEqual(responses[0].result, { behavior: 'allow' });
});

test('A2A and delete-safety prompts decline the stage and busy cards queue in order', async (t) => {
  const { service, patches } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;

  assert.equal(service.presentInteraction('s', {
    requestId: 'a2a-9',
    toolName: 'AskUserQuestion',
    toolInput: { context: { a2aApproval: true }, questions: [{ question: 'Pay?', options: [{ label: 'Yes' }] }] },
  }), 'declined');
  assert.equal(service.presentInteraction('s', {
    requestId: 'safety-9',
    toolName: 'AskUserQuestion',
    toolInput: { context: { requestedToolName: 'bash', requestedToolInput: {} }, questions: [{ question: 'Delete?', options: [{ label: 'Allow' }] }] },
  }), 'declined');

  assert.equal(service.presentInteraction('s', askRequest('first')), 'presented');
  assert.equal(service.presentInteraction('s', askRequest('second')), 'busy', 'one card at a time');
  service.clearInteraction('s', 'wrong-id');
  assert.equal(service.getState('s').interaction.requestId, 'first', 'mismatched clear is a no-op');
  service.clearInteraction('s', 'first');
  await run.queue;
  assert.equal(service.getState('s').interaction, null);
  assert.equal(service.presentInteraction('s', askRequest('second')), 'presented');
  await run.queue;
  assert.equal(patches.at(-1).state.interaction.requestId, 'second');
});

test('stage disabled or session without a run never presents', () => {
  const values = new Map();
  const store = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  writeStudioLiveStageSettings(store, { enabled: false });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-stage-off-'));
  const service = createStudioLiveStageService({
    getSession: () => null,
    getMetabotById: () => null,
    getSettings: () => readStudioLiveStageSettings(store),
    getLanguage: () => 'en',
    project: async () => ({ uri: 'u', tabId: null, announced: false }),
    applyPatch: async () => {},
    assetRoot: path.resolve('public/live-stage'),
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
  });
  try {
    assert.equal(service.presentInteraction('s', askRequest()), 'declined');
    assert.equal(service.getState('s'), null);
  } finally {
    service.dispose();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});
