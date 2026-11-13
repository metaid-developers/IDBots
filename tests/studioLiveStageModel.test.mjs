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
  liveStageSpeechCopy,
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
  state = reduceLiveStageMessage(state, message('next', 'assistant', { isThinking: true }));
  assert.equal(state.family, 'reasoning', 'a projected draft does not freeze later live-stage activity');
  state = reduceLiveStageMessage(state, message('write', 'tool_use', { toolName: 'write', toolUseId: 'write-1' }));
  assert.equal(state.family, 'making');
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

test('owner_update tool calls do not move the scene; the narration bubble does', () => {
  let state = initial();
  const before = state;
  state = reduceLiveStageMessage(state, message('update', 'tool_use', {
    toolName: 'owner_update',
    toolInput: { kind: 'milestone', message: '清单已核验完毕' },
  }));
  assert.equal(state, before, 'the owner_update tool_use itself is host plumbing');
  state = reduceLiveStageMessage(state, {
    id: 'narration', type: 'assistant', content: '清单已核验完毕。接下来我会整理结果。', timestamp: 1,
    metadata: {},
  });
  assert.equal(state.family, 'speaking');
  assert.equal(state.headline, '清单已核验完毕。');
  assert.equal(state.caption, '接下来我会整理结果。');
});

test('speech copy keeps a fitting first sentence whole and flows the rest to the caption', () => {
  const copy = liveStageSpeechCopy('清单已核验完毕。接下来我会整理结果。还有第三句。');
  assert.equal(copy.headline, '清单已核验完毕。');
  assert.equal(copy.caption, '接下来我会整理结果。还有第三句。');
  const latin = liveStageSpeechCopy('Done. The report is attached and verified.');
  assert.equal(latin.headline, 'Done.');
  assert.equal(latin.caption, 'The report is attached and verified.');
});

test('speech copy cuts an over-cap CJK headline at the last clause mark, no ellipsis', () => {
  // 30 CJK chars before the clause mark would overflow the 28 cap; the mark
  // at position 20 wins, and everything after it becomes caption.
  const copy = liveStageSpeechCopy('我已经把方案、预算和排期都核对了一遍，接下来把结果整理好发给你。');
  assert.equal(copy.headline, '我已经把方案、预算和排期都核对了一遍，');
  assert.ok(copy.headline.length <= 28);
  assert.equal(copy.caption, '接下来把结果整理好发给你。');
  assert.doesNotMatch(copy.headline, /…|\.\.\./);
});

test('speech copy hard-cuts an over-cap CJK headline with no clause mark', () => {
  const long = '这是一段没有任何标点超过二十八个字符的长句子用来测试硬切断行为是否正确';
  const copy = liveStageSpeechCopy(`${long}后面的内容进摘要。`);
  assert.equal(copy.headline.length, 28);
  assert.equal(copy.headline, long.slice(0, 28));
  assert.equal(copy.caption, `${long.slice(28)}后面的内容进摘要。`);
});

test('speech copy cuts an over-cap Latin headline at a clause mark or word boundary', () => {
  const withClause = liveStageSpeechCopy('I checked the plan, the budget and the schedule; next I will package the results for you.');
  assert.equal(withClause.headline, 'I checked the plan, the budget and the schedule;');
  assert.ok(withClause.headline.length <= 60);
  assert.equal(withClause.caption, 'next I will package the results for you.');
  // No clause mark inside 60 chars: back off to the last word boundary so
  // no word is split across headline and caption.
  const noClause = liveStageSpeechCopy('supercalifragilisticexpialidocious antidisestablishmentarianism floccinaucinihilipilification pneumonoultramicroscopicsilicovolcanoconiosis trailing');
  assert.equal(noClause.headline, 'supercalifragilisticexpialidocious');
  assert.equal(noClause.caption, 'antidisestablishmentarianism floccinaucinihilipilification pneumonoultramicroscopicsilicovolcanoconiosis trailing');
});

test('speech copy never ellipsizes the headline and keeps the caption cap', () => {
  const long = 'word '.repeat(80).trim();
  const copy = liveStageSpeechCopy(long);
  assert.doesNotMatch(copy.headline, /…|\.\.\./);
  assert.ok(copy.headline.length <= 60);
  const cjk = '字'.repeat(120);
  const copyZh = liveStageSpeechCopy(cjk);
  assert.equal(copyZh.headline.length, 28);
  assert.ok(copyZh.caption.length <= 200);
});

test('reportReadyLiveStage is idempotent in spirit and clears pending projection ids', () => {
  const state = reportReadyLiveStage({ ...initial(), pendingProjectionIds: ['p'] }, null);
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
  assert.equal(state.family, 'owner-needed');
  assert.equal(state.headline, '需要你做个决定');
  assert.equal(state.motion.energy, .12);
  assert.equal(state.revision, initial().revision + 1);
  const lateUpdate = reduceLiveStageMessage(state, message('late', 'assistant', { isFinal: true }));
  assert.equal(lateUpdate.family, 'owner-needed', 'late transcript events cannot disguise a pending ask as active work');
  assert.equal(lateUpdate.headline, '需要你做个决定');
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

test('conversation_recall classifies as local-recall with this-conversation wording', () => {
  let state = initial();
  state = reduceLiveStageMessage(state, message('recall', 'tool_use', {
    toolName: 'conversation_recall',
    toolUseId: 'recall-1',
    toolInput: { query: 'launch date' },
  }));
  assert.equal(state.family, 'local-recall');
  assert.equal(state.headline, '正在翻看我们之前聊过的内容');
  const english = { ...initial(), language: 'en' };
  const enState = reduceLiveStageMessage(english, message('recall-en', 'tool_use', {
    toolName: 'conversation_recall',
    toolUseId: 'recall-2',
    toolInput: { query: 'launch date' },
  }));
  assert.equal(enState.headline, 'Looking back through this conversation');
});

test('a compaction system row leaves the Live Stage state untouched', () => {
  let state = initial();
  state = reduceLiveStageMessage(state, {
    id: 'speak', type: 'assistant', content: '正在整理结果。', timestamp: 1, metadata: {},
  });
  assert.equal(state.family, 'speaking');
  const before = state;
  // DSH compacts silently in-session; the bookkeeping row must not move the
  // scene — the owner never sees summarization on the stage.
  const next = reduceLiveStageMessage(state, message('compact', 'system', { compaction: true }));
  assert.equal(next, before, 'compaction rows return the same state object');
  assert.equal(next.family, 'speaking');
  assert.equal(next.headline, before.headline);
  assert.equal(next.caption, before.caption);
});
