import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  createLiveStageState,
  reduceLiveStageMessage,
  completeLiveStage,
  reportReadyLiveStage,
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
  }), { workerName: 'Builder阿码' });
  assert.deepEqual(state.handoff, { direction: 'dispatch', eventId: 'call-1' });
  state = reduceLiveStageMessage(state, message('orch_notify:delivery-1', 'user', {
    sourceChannel: 'idbots_cross_session',
    sourceSessionId: 'worker-session',
    crossSessionDeliveryId: 'delivery-1',
  }), { workerName: 'Builder阿码' });
  assert.equal(state.family, 'worker-report');
  assert.deepEqual(state.handoff, { direction: 'return', eventId: 'delivery-1' });
  assert.equal(state.topology.nodes.find((node) => node.kind === 'worker').label, 'Builder阿码');
  assert.doesNotMatch(JSON.stringify(state.eventWindow), /private task body|worker-session/);
  state = reduceLiveStageMessage(state, message('verify', 'tool_use', { toolName: 'twin_task_accept', toolUseId: 'accept-1' }));
  assert.equal(state.family, 'verification');
  assert.equal(state.handoff, null);
  assert.equal(state.topology.nodes.find((node) => node.kind === 'worker').label, 'Builder阿码');
  assert.equal(completeLiveStage(state).handoff, null);
});
