import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  createLiveStageState,
  reduceLiveStageMessage,
  completeLiveStage,
  reportReadyLiveStage,
  buildLiveStageInteraction,
  presentLiveStageInteraction,
  dismissLiveStageInteraction,
} = require('../dist-electron/main/services/studioLiveStageModel.js');

const message = (id, type, metadata = {}) => ({ id, type, content: '', timestamp: 1, metadata });
const initial = () => createLiveStageState({ sessionId: 's', turnId: 't', botName: 'AI_Sunny', language: 'zh' });

test('event reducer preserves presence until real structured work arrives', () => {
  let state = initial();
  state = reduceLiveStageMessage(state, message('a', 'assistant', { isThinking: true }));
  assert.equal(state.family, 'reasoning');
  assert.equal(state.topology.mode, 'presence');
  state = reduceLiveStageMessage(state, message('b', 'tool_use', { toolName: 'conversation_search', toolUseId: 'local' }));
  assert.equal(state.family, 'local-recall');
  assert.equal(state.topology.mode, 'presence');
  state = reduceLiveStageMessage(state, message('c', 'tool_use', { toolName: 'local_worker_delegate', toolUseId: 'worker' }));
  assert.equal(state.family, 'delegation');
  assert.equal(state.topology.mode, 'structured');
  assert.deepEqual(state.topology.edges[0], ['twin', 'worker']);
  state = reduceLiveStageMessage(state, message('d', 'user', { origin: 'cross_session' }));
  assert.equal(state.family, 'worker-report');
  state = reduceLiveStageMessage(state, message('e', 'tool_use', { toolName: 'bot_browser_screenshot', toolUseId: 'shot' }));
  assert.equal(state.family, 'verification');
  assert.equal(state.composition, 'converge');
});

test('projection readiness requires a successful matching tool result', () => {
  let state = initial();
  state = reduceLiveStageMessage(state, message('call', 'tool_use', { toolName: 'bot_browser_preview_local', toolInput: { projection: true }, toolUseId: 'project-1' }));
  assert.equal(state.family, 'browser-action');
  assert.deepEqual(state.pendingProjectionIds, ['project-1']);
  state = reduceLiveStageMessage(state, message('result', 'tool_result', { toolUseId: 'project-1', isError: false }));
  assert.equal(state.family, 'report-ready');
  assert.deepEqual(state.pendingProjectionIds, []);
  assert.equal(completeLiveStage(state).family, 'report-ready');
});

test('event window carries semantics only and Director cannot inherit raw arguments', () => {
  let state = initial();
  state = reduceLiveStageMessage(state, message('secret', 'tool_use', {
    toolName: 'local_worker_delegate',
    toolInput: { task: 'raw private task and access token', workerMetabotId: 9 },
    toolUseId: 'worker',
  }));
  const serialized = JSON.stringify(state.eventWindow);
  assert.doesNotMatch(serialized, /raw private task|access token|workerMetabotId/);
  assert.match(serialized, /local_worker_delegate/);
});

test('owner-visible updates are allowed to shape the headline', () => {
  let state = initial();
  state = reduceLiveStageMessage(state, message('update', 'tool_use', {
    toolName: 'owner_update',
    toolInput: { kind: 'milestone', message: '清单已核验完毕' },
  }));
  assert.equal(state.headline, '清单已核验完毕');
  assert.equal(state.family, 'speaking');
});

test('reportReadyLiveStage is idempotent in spirit and clears pending projection ids', () => {
  const state = reportReadyLiveStage({ ...initial(), pendingProjectionIds: ['p'] });
  assert.equal(state.family, 'report-ready');
  assert.equal(state.composition, 'ready');
  assert.deepEqual(state.pendingProjectionIds, []);
});


test('real cross-session metadata triggers a bounded return handoff, not a new owner turn', () => {
  let state = initial();
  state = reduceLiveStageMessage(state, message('delegate', 'tool_use', {
    toolName: 'local_worker_delegate',
    toolUseId: 'call-1',
    toolInput: { workerMetabotId: 2, objective: 'private task body' },
  }), { workerName: 'Builder阿码', workerAvatar: 'data:image/png;base64,BB==' });
  assert.deepEqual(state.handoff, { direction: 'dispatch', eventId: 'call-1' });
  assert.equal(state.topology.nodes.find((node) => node.kind === 'worker').avatar, 'data:image/png;base64,BB==');
  state = reduceLiveStageMessage(state, message('orch_notify:delivery-1', 'user', {
    sourceChannel: 'idbots_cross_session',
    sourceSessionId: 'worker-session',
    crossSessionDeliveryId: 'delivery-1',
  }), { workerName: 'Builder阿码', workerAvatar: 'data:image/png;base64,BB==' });
  assert.equal(state.family, 'worker-report');
  assert.deepEqual(state.handoff, { direction: 'return', eventId: 'delivery-1' });
  assert.equal(state.topology.nodes.find((node) => node.kind === 'worker').label, 'Builder阿码');
  assert.equal(state.topology.nodes.find((node) => node.kind === 'worker').avatar, 'data:image/png;base64,BB==');
  assert.doesNotMatch(JSON.stringify(state.eventWindow), /private task body|worker-session/);
  state = reduceLiveStageMessage(state, message('verify', 'tool_use', { toolName: 'twin_task_accept', toolUseId: 'accept-1' }));
  assert.equal(state.family, 'verification');
  assert.equal(state.handoff, null);
  assert.equal(state.topology.nodes.find((node) => node.kind === 'worker').label, 'Builder阿码');
  assert.equal(completeLiveStage(state).handoff, null);
});

test('ordinary ask prompts are shaped into a bounded stage interaction', () => {
  const interaction = buildLiveStageInteraction({
    requestId: 'ask-1',
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [
        { question: 'Which language?', header: 'Language', options: [{ label: '中文', description: 'Simplified' }, { label: 'English' }], multiSelect: false },
        { question: 'Any extra note?', options: [] },
      ],
    },
    expiresAt: null,
    timeoutDefault: null,
  }, 'tok-1');
  assert.ok(interaction);
  assert.equal(interaction.kind, 'ask');
  assert.equal(interaction.token, 'tok-1');
  assert.equal(interaction.title, 'Which language?');
  assert.equal(interaction.questions.length, 2);
  assert.deepEqual(interaction.questions[0].options[0], { label: '中文', description: 'Simplified' });
  assert.equal(interaction.questions[1].options.length, 0);
  const state = presentLiveStageInteraction(initial(), interaction);
  assert.equal(state.interaction?.requestId, 'ask-1');
  assert.equal(state.revision, initial().revision + 1);
  const cleared = dismissLiveStageInteraction(state, 'ask-1');
  assert.equal(cleared.interaction, null);
  assert.equal(dismissLiveStageInteraction(state, 'other').interaction?.requestId, 'ask-1', 'mismatched ids keep the card');
});

test('A2A and delete-safety prompts stay off the stage', () => {
  assert.equal(buildLiveStageInteraction({
    requestId: 'a2a-1',
    toolName: 'AskUserQuestion',
    toolInput: { context: { a2aApproval: true, category: 'payment' }, questions: [{ question: 'Approve?', options: [{ label: 'Yes' }] }] },
  }, 'tok'), null, 'A2A approvals keep their desktop seat');
  assert.equal(buildLiveStageInteraction({
    requestId: 'friend-1',
    toolName: 'AskUserQuestion',
    toolInput: { context: { action: 'invite' }, questions: [{ question: 'Add friend?', options: [{ label: 'Yes' }] }] },
  }, 'tok'), null);
  assert.equal(buildLiveStageInteraction({
    requestId: 'safety-1',
    toolName: 'AskUserQuestion',
    toolInput: { context: { requestedToolName: 'bash', requestedToolInput: { command: 'rm -rf x' } }, questions: [{ question: 'Allow delete?', options: [{ label: 'Allow' }] }] },
  }, 'tok'), null, 'delete-safety confirmations are Phase 2');
});

test('plain tool approvals become allow/deny cards carrying the watchdog deadline', () => {
  const interaction = buildLiveStageInteraction({
    requestId: 'perm-1',
    toolName: 'Bash',
    toolInput: { reason: 'run the build script' },
    expiresAt: 1234,
    timeoutDefault: 'deny',
  }, 'tok-2');
  assert.ok(interaction);
  assert.equal(interaction.kind, 'approval');
  assert.equal(interaction.title, 'Bash');
  assert.equal(interaction.detail, 'run the build script');
  assert.deepEqual(interaction.questions, []);
  assert.equal(interaction.expiresAt, 1234);
  assert.equal(interaction.timeoutDefault, 'deny');
});

test('malformed candidates never reach the stage', () => {
  assert.equal(buildLiveStageInteraction({ requestId: '', toolName: 'Bash' }, 'tok'), null);
  assert.equal(buildLiveStageInteraction({ requestId: 'x', toolName: '   ' }, 'tok'), null);
  assert.equal(buildLiveStageInteraction({ requestId: 'x', toolName: 'AskUserQuestion', toolInput: { questions: [] } }, 'tok'), null);
  const interaction = buildLiveStageInteraction({
    requestId: 'x',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Q', options: [{ label: '' }, 'junk', { label: 'Keep', description: 42 }] }] },
  }, 'tok');
  assert.ok(interaction);
  assert.deepEqual(interaction.questions[0].options, [{ label: 'Keep' }], 'unlabeled and junk options are dropped');
  assert.equal(interaction.questions[0].options[0].description, undefined);
});
