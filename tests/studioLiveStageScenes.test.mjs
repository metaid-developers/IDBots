import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  createLiveStageState,
  reduceLiveStageMessage,
  resolveLiveStagePlace,
  familyForTool,
  describeLiveStageActivity,
  LIVE_STAGE_FAMILIES,
  waitingLiveStage,
  reportReadyLiveStage,
} = require('../dist-electron/main/services/studioLiveStageModel.js');
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');
const {
  derivePrivateChatStatus,
  deriveGroupThreadStatus,
  privateChatPreview,
} = require('../dist-electron/main/services/studioLiveStageCompanions.js');

const message = (id, type, metadata = {}, content = '') => ({ id, type, content, timestamp: 1, metadata });
const toolUse = (id, toolName, toolInput = {}) => message(id, 'tool_use', { toolName, toolUseId: id, toolInput });
const toolResult = (id, toolUseId, isError = false, content = '', extra = {}) =>
  message(id, 'tool_result', { toolUseId, isError, ...extra }, content);
const initial = () => createLiveStageState({ sessionId: 's', turnId: 't', botName: 'AI_Sunny', language: 'zh' });

test('LIVE_STAGE_FAMILIES exports exactly the 26 family ids', () => {
  assert.equal(LIVE_STAGE_FAMILIES.length, 26);
  for (const family of [
    'local-run', 'local-read', 'desktop-control', 'projecting', 'web-read',
    'chain-write', 'chain-transfer', 'private-chat', 'group-task',
  ]) {
    assert.ok(LIVE_STAGE_FAMILIES.includes(family), family);
  }
});

test('owner session f589ea9e replays through the new tool→family classification', () => {
  const sequence = [
    ['mrc721_balance', 'metaweb-research'],
    ['wallet_nft_balance', 'metaweb-research'],
    ['projection_begin', 'projecting'],
    ['write', 'making'],
    ['bot_browser_preview_local', 'projecting', { projection: true }],
    ['mrc721_item_info', 'metaweb-research'],
    ['check_metafile_route', 'metaweb-research'],
    ['bash', 'local-run'],
    ['read_image', 'local-read'],
    ['bot_browser_screenshot', 'verification'],
    ['web_search', 'web2-research'],
    ['web_fetch', 'web-read'],
    ['list_latest_questions', 'metaweb-research'],
    ['read_metaweb_pin', 'metaweb-research'],
    ['get_question_answers', 'metaweb-research'],
    ['post_simpleanswer', 'chain-write'],
    ['like_pin', 'chain-write'],
    ['send_private_chat', 'private-chat', { to: 'metaid:peer-1' }],
  ];
  let state = initial();
  for (const [toolName, expected, input] of sequence) {
    state = reduceLiveStageMessage(state, toolUse(`tu-${toolName}`, toolName, input ?? {}), { nowMs: 1000 });
    assert.equal(state.family, expected, toolName);
  }
});

test('tool→family classification table', () => {
  const cases = [
    ['wallet_transfer', 'chain-transfer'],
    ['wallet_token_buy', 'chain-transfer'],
    ['mrc721_take_offer', 'chain-transfer'],
    ['escrow_order_create', 'chain-transfer'],
    ['me_charge', 'chain-transfer'],
    ['cua_screenshot', 'desktop-control'],
    ['computer_click', 'desktop-control'],
    ['cua_driver_snapshot', 'desktop-control'],
    ['browser_click', 'desktop-control'],
    ['screenshot', 'desktop-control'],
    ['browser_open', 'browser-action'],
    ['open_metaapp', 'browser-action'],
    ['bot_browser_preview_local', 'browser-action'],
    ['agentpedia_rev', 'chain-write'],
    ['mrc721_mint', 'chain-write'],
    ['twin_stamp_publish', 'chain-write'],
    ['group_chat', 'group-task'],
    ['terminal_run', 'local-run'],
    ['pwsh', 'local-run'],
    ['glob', 'local-read'],
    ['project_query', 'local-read'],
    ['apply_patch', 'making'],
    ['convert_media', 'making'],
    ['intuition', 'local-recall'],
    ['task_recall', 'local-recall'],
    ['metaweb_surf_status', 'metaweb-research'],
    ['metaid_profile', 'metaweb-research'],
    ['escrow_order_list', 'metaweb-research'],
    ['mrc721_offers', 'metaweb-research'],
    ['check_peer_relationship', 'metaweb-research'],
  ];
  for (const [toolName, expected] of cases) {
    assert.equal(familyForTool(toolName), expected, toolName);
  }
});

test('chain read tools never get trading/transfer headlines', () => {
  for (const toolName of ['mrc721_offers', 'mrc721_sell_orders', 'mrc721_market_intents', 'escrow_order_info', 'escrow_order_list']) {
    const activity = describeLiveStageActivity(toolName, {}, 'zh');
    assert.equal(familyForTool(toolName), 'metaweb-research', toolName);
    assert.doesNotMatch(activity?.headline ?? '', /交易|转账|托管/, `${toolName} headline must not claim trading`);
  }
  assert.match(describeLiveStageActivity('escrow_order_act', {}, 'zh')?.headline ?? '', /托管/);
  assert.match(describeLiveStageActivity('wallet_transfer', {}, 'zh')?.headline ?? '', /转账/);
});

test('null tools keep the current family; background metaweb enqueues stay neutral', () => {
  let state = reduceLiveStageMessage(initial(), toolUse('w', 'web_search'));
  assert.equal(state.family, 'web2-research');
  for (const toolName of ['twin_todo', 'todo_write', 'metaweb_surf_start', 'metaweb_study_enqueue', 'some_unknown_tool']) {
    const next = reduceLiveStageMessage(state, toolUse(`n-${toolName}`, toolName));
    assert.equal(next.family, 'web2-research', toolName);
  }
});

test('place resolution: inherit families keep place; waiting picks by companions', () => {
  let state = reduceLiveStageMessage(initial(), toolUse('w', 'web_search'));
  const webPlace = resolveLiveStagePlace(state, 'mind');
  assert.equal(webPlace, 'web');
  const speaking = reduceLiveStageMessage(state, message('a', 'assistant', {}, 'Here is the answer.'));
  assert.equal(resolveLiveStagePlace(speaking, webPlace), 'web', 'speaking inherits the web place');
  assert.equal(resolveLiveStagePlace({ ...state, family: 'waiting', activeWorkers: [{ id: 'w1' }] }, 'mind'), 'machine');
  assert.equal(resolveLiveStagePlace({ ...state, family: 'waiting', activeWorkers: [], activePeers: [{ id: 'p1' }] }, 'mind'), 'chain');
  assert.equal(resolveLiveStagePlace({ ...state, family: 'waiting', activeWorkers: [], activePeers: [], activeGroups: [] }, 'web'), 'web');
  assert.equal(resolveLiveStagePlace({ ...state, family: 'problem' }, 'chain'), 'chain');
  assert.equal(resolveLiveStagePlace({ ...state, family: 'problem' }), 'mind');
  assert.equal(createLiveStageState({ sessionId: 's', turnId: 't', botName: 'B', language: 'en', family: 'local-run' }).place, 'machine');
});

test('model reducers stamp place: demo fixture sequence matches the place map', () => {
  const NOW = 1_760_000_000_000;
  let state = createLiveStageState({ sessionId: 'demo-live-stage', turnId: 'demo-turn-1', botName: 'Nova', language: 'en', directorEnabled: false, nowMs: NOW });
  assert.equal(state.place, 'mind', 'received → mind');
  const expected = [
    ['web_search', 'web'],
    ['omni_reader', 'chain'],
  ];
  for (const [toolName, place] of expected) {
    state = reduceLiveStageMessage(state, toolUse(`tu-${toolName}`, toolName), { nowMs: NOW });
    assert.equal(state.place, place, `${toolName} → ${place}`);
  }
  state = reduceLiveStageMessage(state, toolUse('tu-delegate', 'local_worker_delegate', { workerMetabotId: 7 }), { workerName: 'Pixel', nowMs: NOW });
  assert.equal(state.place, 'machine', 'delegation → machine');
  state = reduceLiveStageMessage(state, {
    id: 'demo-delivery-1', type: 'user', content: '', timestamp: 1,
    metadata: { origin: 'cross_session', sourceChannel: 'idbots_cross_session', sourceSessionId: 'demo-worker-session', crossSessionDeliveryId: 'demo-delivery-1' },
  }, { workerName: 'Pixel', nowMs: NOW });
  assert.equal(state.place, 'machine', 'worker-report → machine');
  state = reduceLiveStageMessage(state, toolUse('tu-shot', 'bot_browser_screenshot'), { nowMs: NOW });
  assert.equal(state.place, 'machine', 'verification → machine');
  state = reportReadyLiveStage(state, null, NOW);
  assert.equal(state.place, 'mind', 'report-ready → mind');
});

test('steer messages raise a transient without touching family or copy', () => {
  let state = reduceLiveStageMessage(initial(), toolUse('w', 'web_search'));
  const familyBefore = state.family;
  const headlineBefore = state.headline;
  const captionBefore = state.caption;
  state = reduceLiveStageMessage(state, {
    id: 'steer-1', type: 'user', content: '顺便看下价格', timestamp: 1,
    metadata: { interactionKind: 'steer' },
  });
  assert.equal(state.family, familyBefore);
  assert.equal(state.headline, headlineBefore);
  assert.equal(state.caption, captionBefore);
  assert.equal(state.transient?.kind, 'steer');
  assert.equal(state.transient.id, 'steer-1');
  assert.match(state.transient.label, /收到补充/);
});

test('dshRouteFallback raises a model-switch transient with family unchanged', () => {
  let state = reduceLiveStageMessage(initial(), toolUse('w', 'web_search'));
  state = reduceLiveStageMessage(state, message('fb', 'system', { dshRouteFallback: true }));
  assert.equal(state.family, 'web2-research');
  assert.equal(state.transient?.kind, 'model-switch');
});

test('tool errors raise retry on timeout, tool-error otherwise; projection ids are exempt', () => {
  let state = reduceLiveStageMessage(initial(), toolUse('w', 'web_search'));
  state = reduceLiveStageMessage(state, toolResult('r1', 'w', true, 'Request timed out'));
  assert.equal(state.transient?.kind, 'retry');
  assert.match(state.transient.label, /超时|timed out/i);
  state = reduceLiveStageMessage(state, toolResult('r2', 'w', true, 'boom'));
  assert.equal(state.transient?.kind, 'tool-error');
  // Projection-tracked ids never raise the error transient.
  state = reduceLiveStageMessage(initial(), toolUse('p', 'bot_browser_preview_local', { projection: true }));
  assert.deepEqual(state.pendingProjectionIds, ['p']);
  state = reduceLiveStageMessage(state, toolResult('pr', 'p', true, 'failed'));
  assert.equal(state.transient, undefined, 'a pending projection error stays quiet');
});

test('chain-confirmed transient fires on a successful chain result carrying a pin id', () => {
  let state = reduceLiveStageMessage(initial(), toolUse('cw', 'post_simpleanswer'));
  assert.equal(state.family, 'chain-write');
  assert.deepEqual(state.pendingChainToolIds, ['cw']);
  state = reduceLiveStageMessage(state, toolResult('cwr', 'cw', false, '{"pinId":"abc123"}'));
  assert.equal(state.transient?.kind, 'chain-confirmed');
  assert.deepEqual(state.pendingChainToolIds, []);
});

test('peerSend/groupPost lifecycle and companionFocus', () => {
  let state = reduceLiveStageMessage(initial(), toolUse('pc', 'send_private_chat', { to: 'metaid:peer-9' }));
  assert.equal(state.family, 'private-chat');
  assert.deepEqual(state.companionFocus, { type: 'peers', id: 'metaid:peer-9' });
  assert.equal(state.peerSend.status, 'sending');
  assert.equal(state.peerSend.peerId, 'metaid:peer-9');
  assert.ok(state.pendingChainToolIds.includes('pc'));
  state = reduceLiveStageMessage(state, toolResult('pcr', 'pc', false, 'delivered pinId=xyz'));
  assert.equal(state.peerSend.status, 'delivered');
  assert.equal(state.transient?.kind, 'chain-confirmed');

  state = reduceLiveStageMessage(state, toolUse('gc', 'group_chat', { action: 'send_group_message', groupId: 'group-7' }));
  assert.equal(state.family, 'group-task');
  assert.deepEqual(state.companionFocus, { type: 'groups', id: 'group-7' });
  assert.equal(state.groupPost.status, 'posting');
  state = reduceLiveStageMessage(state, toolResult('gcr', 'gc', true, 'boom'));
  assert.equal(state.groupPost.status, 'failed');
  assert.equal(state.transient?.kind, 'tool-error');
});

test('companionFocus: workers for collaboration, kept for speaking/owner-needed/problem', () => {
  let state = reduceLiveStageMessage(initial(), toolUse('d', 'local_worker_delegate'));
  assert.deepEqual(state.companionFocus, { type: 'workers' });
  state = reduceLiveStageMessage(state, toolUse('w', 'longterm_subtask_wait'));
  assert.deepEqual(state.companionFocus, { type: 'workers' });
  state = reduceLiveStageMessage(state, message('a', 'assistant', {}, 'Working on it.'));
  assert.deepEqual(state.companionFocus, { type: 'workers' }, 'speaking keeps focus');
  state = waitingLiveStage(state, { workerName: 'Pixel' });
  assert.deepEqual(state.companionFocus, { type: 'workers' });
  state = reduceLiveStageMessage(state, toolUse('x', 'some_unknown_tool'));
  // An unmapped tool keeps the family (waiting) → workers focus stays.
  assert.deepEqual(state.companionFocus, { type: 'workers' });
  state = reduceLiveStageMessage(state, toolUse('ws', 'web_search'));
  assert.equal(state.companionFocus, null, 'unrelated work clears the focus');
});

function serviceFixture(t, depOverrides = {}) {
  const session = { cwd: '/tmp', sessionType: 'browser', assistantMode: true, metabotId: 1, metabotName: 'AI_Sunny', messages: [] };
  const patches = [];
  const service = createStudioLiveStageService({
    getSession: () => session,
    getMetabotById: () => ({ name: 'AI_Sunny' }),
    getSettings: () => ({ enabled: true, directorEnabled: false }),
    getLanguage: () => 'en',
    project: async () => ({ uri: 'stage://entry', tabId: 7, announced: true }),
    getStageTab: async () => ({ id: 7, uri: 'stage://entry' }),
    applyPatch: async (input) => { patches.push(input); },
    assetRoot: 'public/live-stage',
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    projectionRetryBackoffMs: [0, 0],
    ...depOverrides,
  });
  t.after(() => service.dispose());
  return { service, patches };
}

test('service merges peerSend into the peers list with status windows', async (t) => {
  const peers = [
    { id: 'metaid:peer-9', name: 'Nova', status: 'open', updatedAt: 1 },
  ];
  const { service } = serviceFixture(t, {
    listActivePrivateChats: () => peers,
    resolvePeerIdentity: (id) => id === 'metaid:peer-new' ? { name: 'Kite', avatar: 'data:image/png;base64,QQ==' } : null,
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeMessage('s', toolUse('pc', 'send_private_chat', { to: 'metaid:peer-new' }));
  await run.queue;
  const state = service.getState('s');
  assert.equal(state.family, 'private-chat');
  // The send target is synthesized at the head even though the lister missed it.
  assert.equal(state.activePeers[0].id, 'metaid:peer-new');
  assert.equal(state.activePeers[0].name, 'Kite');
  assert.equal(state.activePeers[0].status, 'sending');
  assert.equal(state.activePeers[0].avatar, 'data:image/png;base64,QQ==');
  assert.equal(state.activePeers.length <= 4, true);
  // Delivered holds for the 15s window.
  service.observeMessage('s', toolResult('pcr', 'pc', false, 'ok'));
  await run.queue;
  const delivered = service.getState('s');
  assert.equal(delivered.activePeers[0].status, 'delivered');
});

test('service merges groupPost into the groups list with posting window + self sender', async (t) => {
  const groups = [{
    id: 'group-7', title: 'APEC brief', status: 'active',
    members: [{ id: 'bot:1', name: 'AI_Sunny', self: true }], memberCount: 1, openteam: false, updatedAt: 1,
  }];
  const { service } = serviceFixture(t, {
    listActiveGroupThreads: () => groups,
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeMessage('s', toolUse('gc', 'group_chat', { action: 'send_group_message', groupId: 'group-7' }));
  await run.queue;
  const state = service.getState('s');
  assert.equal(state.activeGroups[0].status, 'posting');
  assert.equal(state.activeGroups[0].senderId, 'bot:1', 'sender is the self member');
});

test('refreshChiefOfStaffHud patches only on companion changes and carries place', async (t) => {
  let peers = [];
  const { service, patches } = serviceFixture(t, {
    listActivePrivateChats: () => peers,
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeMessage('s', toolUse('w', 'web_search'));
  await run.queue;
  const baseRevision = service.getState('s').revision;
  const basePatches = patches.length;
  service.refreshChiefOfStaffHud();
  assert.equal(service.getState('s').revision, baseRevision, 'no companion change → no new revision');
  assert.equal(patches.length, basePatches, 'no companion change → no patch');
  // A new peer is picked up by the refresh and bumps the revision.
  peers = [{ id: 'metaid:p1', name: 'Nova', status: 'open', updatedAt: Date.now() }];
  service.refreshChiefOfStaffHud();
  const state = service.getState('s');
  assert.equal(state.revision, baseRevision + 1);
  assert.equal(state.activePeers.length, 1);
  assert.equal(state.place, 'web', 'the refresh preserves the resolved place');
  // While peers are present the 10s timer is armed; teardown clears it.
  assert.ok(run.companionsTimer, 'companion timer armed');
  service.forget('s');
  assert.equal(run.companionsTimer, null, 'teardown clears the timer');
});

test('service caches companion listers for 2.5s; refresh bypasses and refills', async (t) => {
  let nowMs = 1_000_000;
  let peerCalls = 0;
  let groupCalls = 0;
  const peers = [{ id: 'metaid:p1', name: 'Nova', status: 'open', updatedAt: nowMs }];
  const { service } = serviceFixture(t, {
    now: () => nowMs,
    listActivePrivateChats: () => { peerCalls += 1; return peers; },
    listActiveGroupThreads: () => { groupCalls += 1; return []; },
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  assert.equal(peerCalls, 1, 'first enrich reads the lister');
  assert.equal(groupCalls, 1);
  service.observeMessage('s', message('a1', 'assistant', {}, 'Working.'));
  await run.queue;
  service.observeMessage('s', message('a2', 'assistant', {}, 'Still working.'));
  await run.queue;
  assert.equal(peerCalls, 1, 'commits within 2.5s reuse the cached list');
  assert.equal(groupCalls, 1);
  nowMs += 3_000;
  service.observeMessage('s', message('a3', 'assistant', {}, 'More work.'));
  await run.queue;
  assert.equal(peerCalls, 2, 'the cache expires after 2.5s');
  service.refreshChiefOfStaffHud();
  assert.equal(peerCalls, 3, 'an explicit refresh bypasses and refills the cache');
});

test('a failed peerSend does not synthesize a peer row', async (t) => {
  const { service } = serviceFixture(t, {
    listActivePrivateChats: () => [],
    resolvePeerIdentity: () => ({ name: 'Kite' }),
  });
  service.observeMessage('s', message('u1', 'user', { origin: 'user', submissionId: 'sub-1' }));
  const run = service.getRunInternals('s');
  await run.queue;
  service.observeMessage('s', toolUse('pc', 'send_private_chat', { to: 'metaid:peer-new' }));
  await run.queue;
  assert.equal(service.getState('s').activePeers[0]?.id, 'metaid:peer-new', 'sending synthesizes');
  service.observeMessage('s', toolResult('pcr', 'pc', true, 'delivery failed'));
  await run.queue;
  const state = service.getState('s');
  assert.equal(state.activePeers?.length ?? 0, 0, 'a failed send synthesizes no peer');
});

test('private-chat status derivation', () => {
  const now = 100_000;
  assert.equal(derivePrivateChatStatus({ sessionRunning: true }, now), 'sending');
  assert.equal(derivePrivateChatStatus({ sessionRunning: false, latest: null }, now), 'open');
  assert.equal(derivePrivateChatStatus({ sessionRunning: false, latest: { direction: 'incoming', at: now - 20_000 } }, now), 'incoming');
  assert.equal(derivePrivateChatStatus({ sessionRunning: false, latest: { direction: 'incoming', at: now - 40_000 } }, now), 'open');
  assert.equal(derivePrivateChatStatus({ sessionRunning: false, latest: { direction: 'outgoing', at: now - 5_000 } }, now), 'delivered');
  assert.equal(derivePrivateChatStatus({ sessionRunning: false, latest: { direction: 'outgoing', at: now - 30_000 } }, now), 'awaiting');
  assert.equal(derivePrivateChatStatus({ sessionRunning: false, latest: { direction: null, at: now } }, now), 'open');
});

test('group thread status derivation', () => {
  const now = 100_000;
  assert.deepEqual(deriveGroupThreadStatus(null, now), { status: 'active' });
  assert.deepEqual(deriveGroupThreadStatus({ at: now - 10_000, senderIsSelf: true }, now), { status: 'posting' });
  assert.deepEqual(deriveGroupThreadStatus({ at: now - 10_000, senderIsSelf: false, senderId: 'm-1' }, now), { status: 'incoming', senderId: 'm-1' });
  assert.deepEqual(deriveGroupThreadStatus({ at: now - 60_000, senderIsSelf: false }, now), { status: 'active' });
  assert.equal(privateChatPreview('**hello** `code` [link](x)'), 'hello code link');
});
