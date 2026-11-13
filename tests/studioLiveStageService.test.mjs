import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');
const { readStudioLiveStageSettings, writeStudioLiveStageSettings, STUDIO_LIVE_STAGE_KEY, STUDIO_LIVE_STAGE_DIRECTOR_KEY } = require('../dist-electron/main/services/studioLiveStageSettings.js');

const message = (id, type, metadata = {}, content = '') => ({ id, type, content, timestamp: 1, metadata });

function fixture(t, directorEnabled = false, initialTabId = 7, directSceneOverride = null, depOverrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-stage-'));
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-stage-root-'));
  const session = {
    cwd,
    sessionType: 'browser',
    assistantMode: true,
    metabotId: 1,
    metabotName: 'AI_Sunny',
    metabotAvatar: 'data:image/jpeg;base64,AA==',
    messages: [],
  };
  const projected = [], patches = [], calls = [], drainQueue = [], responses = [], activations = [];
  const settings = { enabled: true, directorEnabled };
  // The stage-role binding remembers which URI its tab currently shows; the
  // mock mirrors that so the service's "already on the entry" fast path and
  // heal/re-projection decisions see realistic binding state.
  let boundStageUri = null;
  const service = createStudioLiveStageService({
    getSession: (id) => id === 'worker-session' ? { ...session, metabotId: 2, metabotName: 'Builder阿码', metabotAvatar: 'data:image/png;base64,BB==' } : session,
    getMetabotById: (id) => ({ name: id === 2 ? 'Builder阿码' : 'AI_Sunny', avatar: id === 2 ? 'data:image/png;base64,BB==' : session.metabotAvatar, llm_id: 'brain', llm_provider: 'test' }),
    getSettings: () => settings,
    getLanguage: () => 'en',
    project: async (input) => {
      projected.push(input);
      const uri = `preview-metaapp://localhost${input.localPath}`;
      if (input.role === 'stage') boundStageUri = uri;
      return { uri, tabId: initialTabId, announced: true };
    },
    getStageTab: async () => ({ id: 7, uri: boundStageUri }),
    activateStageTab: async (sessionId) => { activations.push(sessionId); },
    applyPatch: async (input) => { patches.push(input); },
    drainInteractions: async () => drainQueue.splice(0, drainQueue.length),
    respondToPermission: (requestId, result) => { responses.push({ requestId, result }); },
    interactionPollMs: 10,
    stageRoot,
    assetRoot: path.resolve('public/live-stage'),
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    directScene: directSceneOverride ?? (async (state) => {
      calls.push(state);
      return {
        scene: { headline: 'Generated scene', caption: 'Generated safely.', composition: state.composition, motif: 'liquid', motion: state.motion },
        usage: { inputTokens: 120, outputTokens: 24, cacheReadTokens: 80, cacheCreationTokens: 40, latencyMs: 12 },
      };
    }),
    projectionRetryBackoffMs: [0, 0],
    ...depOverrides,
  });
  t.after(() => {
    service.dispose();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(stageRoot, { recursive: true, force: true });
    } catch {}
  });
  return { service, session, projected, patches, calls, settings, drainQueue, responses, activations, stageRoot, getBoundStageUri: () => boundStageUri };
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

test('service materializes one persistent stage entry, dedupes messages, and keeps patching after the report', async (t) => {
  const { service, projected, patches, activations } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Please build the report.'));
  let run = service.getRunInternals('s');
  await run.queue;
  const firstStage = run.stagePath;
  // The persistent entry is materialized once under stageRoot and boots
  // unclaimed — identity and turn state arrive through patches, never baked in.
  assert.ok(firstStage && fs.existsSync(firstStage));
  assert.match(firstStage, /live-stage.*stage\.html$/);
  assert.match(fs.readFileSync(firstStage, 'utf8'), /__INITIAL_LIVE_STAGE__=null/);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].role, 'stage', 'stage projections land in the stage role');
  // A new human turn activates the stage tab (background, open-session guarded).
  await waitFor(() => activations.includes('s'));

  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'local_worker_delegate', toolUseId: 'worker' }));
  await run.queue;
  assert.equal(service.getState('s').topology.mode, 'structured');
  const revision = service.getState('s').revision;
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'local_worker_delegate', toolUseId: 'worker' }));
  assert.equal(service.getState('s').revision, revision);
  assert.ok(patches.length >= 2);

  service.observeMessage('s', message('u2', 'user', { origin: 'user', submissionId: 'sub-2' }, 'Now check the numbers.'));
  run = service.getRunInternals('s');
  await run.queue;
  assert.equal(run.stagePath, firstStage, 'every turn shares the persistent entry');
  assert.equal(projected.length, 1, 'a bound stage tab on the entry needs no re-projection');
  await service.projectReport({ sessionId: 's', localPath: '/tmp/final-report.html' }, async () => ({ uri: 'preview-metaapp://localhost/tmp/final-report.html', tabId: 7, announced: true }));
  assert.equal(service.getState('s').family, 'report-ready');
  assert.equal(service.getState('s').composition, 'ready');
  assert.equal(service.getState('s').reportUri, 'preview-metaapp://localhost/tmp/final-report.html', 'the report URI travels in stage state');
  assert.equal(run.reportProjected, true);
  const patchCount = patches.length;
  // The report lives on the showcase tab; the stage keeps patching — the
  // Twin's closing words still move the live scene after the projection.
  service.observeMessage('s', message('final', 'assistant', { isFinal: true }, 'The report is ready for your review.'));
  service.observeComplete('s');
  await run.queue;
  assert.ok(patches.length > patchCount, 'the stage keeps receiving patches after the report — it is a separate tab now');
  assert.equal(service.presentInteraction('s', askRequest('after-report')), 'declined', 'a projected report leaves the prompt on its visible desktop seat');
  assert.equal(service.getState('s').interaction, null);
  assert.deepEqual(service.listPresentedRequestIds(), [], 'the overlay is never suppressed for an invisible stage card');
});

test('final projection reports through the showcase role and carries the report URI in stage state', async (t) => {
  const { service } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  let stageTabId = 'unset';
  await service.projectReport({ sessionId: 's', localPath: '/tmp/final-report.html' }, async (tabId) => {
    stageTabId = tabId;
    return { uri: 'preview-metaapp://localhost/tmp/final-report.html', tabId: 7, announced: true };
  });
  // The report never targets the stage tab: the callback receives null and
  // main.ts wires the showcase role + reveal itself.
  assert.equal(stageTabId, null);
  assert.equal(service.getState('s').reportUri, 'preview-metaapp://localhost/tmp/final-report.html');
  const stage = fs.readFileSync(run.stagePath, 'utf8');
  assert.match(stage, /data-report-open/);
  assert.match(stage, /data-report-open-label/);
  assert.doesNotMatch(stage, /__LIVE_STAGE_REPORT_URI__/, 'the report URI is patch state, not baked page chrome');
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
  assert.equal(state.caption, 'Generated safely.', 'the Director restyles the caption');
  assert.notEqual(state.headline, 'Generated scene', 'the headline is host-owned and never Director output');
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
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Please build the report.'));
  service.observeMessage('s', message('tool-1', 'tool_use', { toolName: 'conversation_search', toolUseId: 'search-1' }));
  const run = service.getRunInternals('s');
  assert.ok(run.directorTimer, 'a working family with a default caption arms the Director');
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
  // Data-URI avatars never travel in patches: they are materialized once
  // under the stage dir and referenced by the relative avatars/ path.
  const avatar = service.getState('s').topology.nodes.find((node) => node.kind === 'worker').avatar;
  assert.match(avatar, /^avatars\/[0-9a-f]{16}\.png$/, 'worker avatar is a stage-relative asset path');
  assert.ok(fs.existsSync(path.join(run.stageDir, avatar)), 'the avatar file was written beside stage.html');
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
  assert.equal(service.getState('s').family, 'owner-needed');
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

test('a stage-level skip returns every question as honestly unanswered', async (t) => {
  const { service, responses, drainQueue } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.presentInteraction('s', {
    requestId: 'ask-3',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Q1', options: [{ label: 'A' }] }, { question: 'Q2', options: [{ label: 'B' }] }] },
  });
  drainQueue.push({ requestId: 'ask-3', token: service.getState('s').interaction.token, behavior: 'allow', skip: true });
  await waitFor(() => responses.length > 0);
  assert.equal(responses[0].result.behavior, 'allow');
  assert.deepEqual(responses[0].result.updatedInput.answers, {});
  assert.deepEqual(responses[0].result.updatedInput.skippedQuestions, ['Q1', 'Q2']);
  assert.equal(service.getState('s').interaction, null, 'skip clears the card');
});

test('listPresentedRequestIds mirrors exactly the cards on stage', async (t) => {
  const { service } = fixture(t);
  assert.deepEqual(service.listPresentedRequestIds(), []);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.presentInteraction('s', askRequest('presented-1'));
  assert.deepEqual(service.listPresentedRequestIds(), ['presented-1']);
  service.clearInteraction('s', 'presented-1');
  assert.deepEqual(service.listPresentedRequestIds(), [], 'cleared cards leave the mirror');
});

test('a pushed click resolves through the same validated path as the drain', async (t) => {
  const { service, responses } = fixture(t);
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.presentInteraction('s', askRequest('push-1'));
  const token = service.getState('s').interaction.token;
  assert.equal(service.acceptPushedInteraction({ requestId: 'push-1', token, behavior: 'allow', answers: { 'Which speed?': 'Fast' } }), true);
  assert.equal(responses[0].result.behavior, 'allow');
  assert.equal(service.getState('s').interaction, null, 'push dismisses the card');
  assert.equal(service.acceptPushedInteraction({ requestId: 'push-1', token, behavior: 'deny' }), false, 'single-use: the second delivery is rejected');
  assert.equal(service.acceptPushedInteraction({ requestId: 'push-1', token: 'wrong', behavior: 'deny' }), false);
  assert.equal(service.acceptPushedInteraction({ requestId: 'ghost', token: 'x', behavior: 'deny' }), false);
});

// ---------------------------------------------------------------------------
// Stage Tabs unit: resilient projection, draftClaim, showSession/idle, prepareDraft
// ---------------------------------------------------------------------------

test('projectStage retries a timed-out stage-tab lookup and patches the bound draft without projecting', async (t) => {
  let lookups = 0;
  const { service, projected, patches } = fixture(t, false, 7, null, {
    getStageTab: async () => {
      lookups += 1;
      if (lookups === 1) throw new Error('Bot Browser tab command timed out');
      const run = service.getRunInternals('s');
      return run ? { id: 9, uri: run.stageUri } : null;
    },
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Hello.'));
  const run = service.getRunInternals('s');
  await run.queue;
  // Give the enqueued projectStage + deliverPatch chain a beat to settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await run.queue;
  assert.equal(lookups >= 2, true, 'the lookup was retried after the timeout');
  assert.equal(projected.filter((input) => input.role === 'stage').length, 0, 'no projection once the bound tab resolves');
  assert.equal(patches.length >= 1, true, 'the current state was patched onto the bound tab');
  assert.equal(patches.at(-1).state.sessionId, 's');
});

test('projectStage retries a failed projection before falling back to patch delivery', async (t) => {
  let attempts = 0;
  const { service, patches } = fixture(t, false, 7, null, {
    getStageTab: async () => null,
    project: async (input) => {
      attempts += 1;
      if (attempts < 3) throw new Error('Bot Browser tab command timed out');
      return { uri: `preview-metaapp://localhost${input.localPath}`, tabId: 11, announced: true };
    },
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Hello.'));
  const run = service.getRunInternals('s');
  await run.queue;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await run.queue;
  assert.equal(attempts, 3, 'the projection was attempted three times');
  assert.equal(patches.length >= 1, true, 'delivery continued after the retried projection');
});

test('draftClaim reaches the stage-role projection for a brand-new session only', async (t) => {
  const { service, projected } = fixture(t);
  service.prepareSession('fresh', { draftClaim: true });
  let run = service.getRunInternals('fresh');
  await run.queue;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await run.queue;
  const stageProjection = projected.find((input) => input.sessionId === 'fresh' && input.role === 'stage');
  assert.equal(stageProjection?.draftClaim, true, 'session:start marks the first projection as a draft claim');

  // An old session (many user messages) never carries draftClaim.
  const oldSession = {
    cwd: '/tmp', sessionType: 'browser', assistantMode: true, metabotId: 1,
    metabotName: 'AI_Sunny', messages: [{ type: 'user' }, { type: 'user' }, { type: 'user' }],
  };
  const { service: service2, projected: projected2 } = fixture(t, false, 7, null, {
    getSession: (id) => id === 'old' ? oldSession : null,
  });
  service2.prepareSession('old');
  const oldRun = service2.getRunInternals('old');
  await oldRun.queue;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await oldRun.queue;
  const oldProjection = projected2.find((input) => input.sessionId === 'old' && input.role === 'stage');
  assert.equal(oldProjection?.draftClaim, false, 'an established session keeps the conservative adoption rule');
});

test('showSession redelivers an existing run and creates a resting idle run otherwise', async (t) => {
  const { service, patches, activations } = fixture(t);
  // Existing run: state is re-delivered through the projectStage fast path.
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }, 'Hello.'));
  const run = service.getRunInternals('s');
  await run.queue;
  const patchesBefore = patches.length;
  service.showSession('s');
  await run.queue;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await run.queue;
  assert.equal(patches.length > patchesBefore, true, 'the current state was re-delivered');
  assert.deepEqual(activations, ['s'], 'showSession itself never activates the tab');

  // No run: a resting idle run appears with the idle copy and no activation.
  service.showSession('opened-old');
  const idleRun = service.getRunInternals('opened-old');
  assert.ok(idleRun, 'an idle run was created for the opened session');
  assert.equal(idleRun.state.family, 'idle');
  assert.equal(idleRun.state.kicker, 'AI_Sunny', 'idle kicker is the bot name');
  assert.equal(idleRun.state.headline, "I'm here whenever you're ready");
  assert.equal(idleRun.state.caption, '');
  await idleRun.queue;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await idleRun.queue;
  const idlePatch = patches.find((input) => input.state?.family === 'idle');
  assert.ok(idlePatch, 'the idle state reached the stage tab');
  assert.deepEqual(activations, ['s'], 'the idle run never activates the tab');
});

test('a later human message replaces the idle run through the submissionId check', async (t) => {
  const { service } = fixture(t);
  service.showSession('opened-old');
  const idleRun = service.getRunInternals('opened-old');
  const idleTurnId = idleRun.state.turnId;
  await idleRun.queue;
  service.observeMessage('opened-old', message('u2', 'user', { origin: 'user', submissionId: 'sub-2' }, 'Now do the thing.'));
  const nextRun = service.getRunInternals('opened-old');
  assert.notEqual(nextRun.state.turnId, idleTurnId, 'the human turn replaced the idle run');
  assert.equal(nextRun.state.family === 'idle', false);
});

test('prepareDraft patches the tab frame with an unclaimed idle draft identity', async (t) => {
  const { service, patches } = fixture(t);
  const result = await service.prepareDraft({ tabId: 5, metabotId: 2 });
  assert.equal(result.ok, true);
  const draft = patches.at(-1);
  assert.equal(draft.state.draft, true);
  assert.equal(draft.state.family, 'idle');
  assert.equal(draft.state.botName, 'Builder阿码');
  assert.match(String(draft.state.botAvatar), /^avatars\/[0-9a-f]{16}\./, 'the avatar is a stage asset');
  assert.equal(draft.state.sessionId, '', 'the draft carries no session claim');

  const fallback = await service.prepareDraft({ tabId: 5, metabotId: null });
  assert.equal(fallback.ok, true);
  const fallbackDraft = patches.at(-1);
  assert.equal(fallbackDraft.state.botName, 'Twin', 'null metabotId falls back to the default Twin name');

  const invalid = await service.prepareDraft({ tabId: 'nope' });
  assert.equal(invalid.ok, false);
});
