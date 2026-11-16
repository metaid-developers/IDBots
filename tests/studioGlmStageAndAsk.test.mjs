import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { DshEventMapper } = require('../dist-electron/main/libs/dshKernel/dshEventMapper.js');
const {
  createLiveStageState,
  reduceLiveStageMessage,
  describeLiveStageActivity,
} = require('../dist-electron/main/services/studioLiveStageModel.js');
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');
const { listStudioOpenDelegations } = require('../dist-electron/main/services/studioOpenDelegations.js');
const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { buildAssistantModePrompt, buildProjectorModePrompt } = require('../dist-electron/main/libs/assistantModePrompt.js');
Module._load = originalLoad;

function disposeTempStore(sqliteStore, dir) {
  try { sqliteStore?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('Issue 1: GLM reasoning + short pre-tool transitional text in Studio (assistantMode) stays held and never pops/retracts a ghost bubble', () => {
  const mapper = new DshEventMapper({ assistantMode: () => true });
  mapper.consume({
    type: 'request/header',
    data: { header: { config: { provider: 'idbots', model: 'glm-5.3-flash' } } },
  });
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  });
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: 'The output was truncated. Parse with jq.' } },
  });
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The output was truncated. Parse with jq.' } } },
  });

  // Short transitional sentence streamed after reasoning block-end before tool-call:
  const delta1 = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: '单行' } },
  });
  const delta2 = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: '太长，我用 jq 把 9 个子项目的状态读出来。' } },
  });
  assert.equal(delta1.some((a) => a.slot === 'text'), false, 'never opens a 2-char bubble');
  assert.equal(delta2.some((a) => a.slot === 'text'), false, 'never opens a visible bubble before tool-call');

  const atTool = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } },
  });
  assert.equal(atTool.some((a) => a.slot === 'text'), false, 'no text-slot retraction needed because none leaked');
});

test('Issue 2 & 4: Mid-turn projection guard error never flashes "这一轮没能完成", and Chinese Live Stage suppresses pure-English bash descriptions', () => {
  let state = createLiveStageState({
    sessionId: 's1',
    turnId: 't1',
    botName: 'AI_Sunny',
    language: 'zh',
    directorEnabled: false,
  });

  // Issue 4: English bash description is suppressed in zh UI, while Chinese description renders:
  const enBash = describeLiveStageActivity(
    'bash',
    { description: 'Show vault-poll and verify-claim CLI usage' },
    'zh',
  );
  assert.equal(enBash.headline, '正在电脑上处理');
  assert.equal(enBash.caption, undefined, 'pure-English developer description must not leak onto zh Live Stage');

  const zhBash = describeLiveStageActivity(
    'bash',
    { description: '检查金库巡检与认领命令参数' },
    'zh',
  );
  assert.equal(zhBash.caption, '检查金库巡检与认领命令参数');

  // Issue 2: Guard-rejected mid-turn projection (`isError: true`) keeps working scene, never `problem` ("这一轮没能完成")!
  state = reduceLiveStageMessage(state, {
    id: 'p-call',
    type: 'tool_use',
    content: '',
    timestamp: 1,
    metadata: { toolName: 'bot_browser_preview_local', toolInput: { projection: true }, toolUseId: 'proj-err-1' },
  });
  assert.equal(state.family, 'browser-action');

  state = reduceLiveStageMessage(state, {
    id: 'p-res',
    type: 'tool_result',
    content: 'Error: Not projected: Builder阿码 is still working',
    timestamp: 2,
    metadata: { toolUseId: 'proj-err-1', isError: true },
  });
  assert.notEqual(state.family, 'problem', 'mid-turn rejected projection never flashes 这一轮没能完成');
  assert.doesNotMatch(state.headline, /这一轮没能完成/);

  // Prompt rules enforce Chinese tool descriptions & interactive ask_user_question card:
  assert.match(buildAssistantModePrompt(true), /tool description\/title/);
  assert.match(buildProjectorModePrompt(), /ask_user_question/);
});

test('Issue 3 & 5: NFT worker avatars preserve fallback + async nft:// ref, and Live Stage AskUserQuestion syncs bidirectionally with left Studio chat', async (t) => {
  const open = listStudioOpenDelegations(
    {
      listAttemptsForSourceSessions: () => [{
        id: 'att-ama-1',
        stepId: 'step-1',
        workerMetabotId: 15,
        workerSessionId: 'ws-15',
        status: 'running',
        queuedAt: new Date(Date.now() - 5000).toISOString(),
        startedAt: new Date(Date.now() - 4000).toISOString(),
      }],
      getStep: () => ({ id: 'step-1', title: 'S6 转换引擎' }),
      getTaskForStep: () => ({ id: 'task-1', status: 'running', ownerIntent: 'S6 转换引擎' }),
      getSession: () => ({ id: 'ws-15', status: 'running' }),
      getMetabotById: () => ({
        name: 'Builder阿码',
        avatar: 'nft://mrc721/624df3e5f037629e13ad1895fce71c91f46e508d9ecb93d7e64cb3a9cc909b5ei0',
        avatar_fallback: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      }),
    },
    'studio-s1',
  );
  assert.equal(open.length, 1);
  assert.match(open[0].workerAvatar, /^data:image\/png;base64,/, 'PNG fallback available immediately without blank [B]');
  assert.match(open[0].workerAvatarRef, /^nft:\/\/mrc721\//, 'NFT ref preserved alongside fallback for hexagon frame & async upgrade');

  // Bidirectional AskUserQuestion Stage <-> Left Chat sync:
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ask-sync-'));
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ask-stage-'));
  const drainQueue = [];
  const stageMirroredToChat = [];
  const permissionResponses = [];

  const stageService = createStudioLiveStageService({
    getSession: () => ({
      id: 'studio-s1',
      cwd,
      sessionType: 'browser',
      assistantMode: true,
      metabotId: 1,
      metabotName: 'AI_Sunny',
      metabotAvatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      messages: [],
    }),
    getMetabotById: () => ({ name: 'AI_Sunny', avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }),
    getSettings: () => ({ enabled: true, directorEnabled: false }),
    getLanguage: () => 'zh',
    project: async (input) => ({ uri: `preview-metaapp://localhost${input.localPath}`, tabId: 9, announced: true }),
    getStageTab: async () => ({ id: 9, uri: null }),
    applyPatch: async () => {},
    drainInteractions: async () => drainQueue.splice(0, drainQueue.length),
    respondToPermission: (requestId, result) => { permissionResponses.push({ requestId, result }); },
    onStageAskAnswered: (sid, summaryText) => { stageMirroredToChat.push({ sid, summaryText }); },
    listCollaboratingWorkers: () => [{
      id: 'verify:att-ama-1',
      name: 'Builder阿码',
      avatar: open[0].workerAvatar,
      avatarRef: open[0].workerAvatarRef,
      direction: 'verifying',
      title: 'S6 转换引擎',
      startedAt: Date.now() - 15_000,
    }],
    resolveAvatarAsync: async () => 'https://example.com/ama-nft.png',
    interactionPollMs: 10,
    projectionRetryBackoffMs: [0, 0],
    stageRoot,
    assetRoot: path.resolve('public/live-stage'),
    fallbackAvatarDataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  });
  t.after(() => {
    stageService.dispose();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Proactive briefing trigger resets any finished projected run and opens a clean run for AskUserQuestion:
  stageService.observeMessage('studio-s1', {
    id: 'brief-1',
    type: 'user',
    content: '<studio_proactive_briefing>...</studio_proactive_briefing>',
    timestamp: Date.now(),
    metadata: { isDelegationInternal: true, origin: 'studio_briefing' },
  });
  const outcome = stageService.presentInteraction('studio-s1', {
    requestId: 'ask-s6',
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [{
        question: '真实转换什么时候开跑？',
        header: '开跑时机',
        options: [
          { label: 'A（推荐）· 现在开跑，分两段', description: '先转入金库巡检认领，确认后再铸造销毁' },
          { label: 'B · 先合入主干，另约时间', description: '今晚不碰链' },
        ],
      }],
    },
  });
  assert.equal(outcome, 'presented');
  const stageState = stageService.getState('studio-s1');
  assert.ok(stageState.activeWorkers?.[0]?.avatar, 'collaborating worker card carries valid avatar during verifying');

  // Direction A: Clicking Option A on Right Live Stage echoes user bubble to Left Studio Chat AND resolves permission!
  drainQueue.push({
    requestId: 'ask-s6',
    token: stageState.interaction.token,
    behavior: 'allow',
    answers: { '真实转换什么时候开跑？': 'A（推荐）· 现在开跑，分两段' },
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(permissionResponses.length, 1);
  assert.equal(stageMirroredToChat.length, 1);
  assert.equal(stageMirroredToChat[0].summaryText, 'A（推荐）· 现在开跑，分两段');

  // Direction B: Typing "A，gogo" in Left Studio Chat while AskUserQuestion is pending resolves the question without aborting!
  const fakeRunner = Object.create(CoworkRunner.prototype);
  let resolvedFromChat = null;
  const settledEvents = [];
  fakeRunner.activeSessions = new Map([[
    'studio-s1',
    {
      executionMode: 'local',
      pendingPermission: {
        requestId: 'ask-left-1',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [{
            question: '真实转换什么时候开跑？',
            options: [
              { label: 'A（推荐）· 现在开跑，分两段' },
              { label: 'B · 先合入主干，另约时间' },
            ],
          }],
        },
      },
    },
  ]]);
  fakeRunner.pendingPermissions = new Map([['ask-left-1', { sessionId: 'studio-s1', resolve: () => {} }]]);
  fakeRunner.respondToPermission = (reqId, res) => { resolvedFromChat = { reqId, res }; };
  fakeRunner.emit = (ev, sid, subId) => { settledEvents.push({ ev, sid, subId }); };

  const steerRes = fakeRunner.trySubmitSteer('studio-s1', 'sub-chat-1', 'A，gogo');
  assert.equal(steerRes.accepted, true);
  await steerRes.delivered;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(resolvedFromChat.reqId, 'ask-left-1');
  assert.equal(
    resolvedFromChat.res.updatedInput.answers['真实转换什么时候开跑？'],
    'A（推荐）· 现在开跑，分两段|||gogo',
  );
  assert.ok(settledEvents.some((e) => e.ev === 'steerSettled' && e.subId === 'sub-chat-1'));
});

test('Issue 6: Back-office supervision uses full-trust bypass without headless auto-review stalls and starts verification clock at supervision start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sup-clock-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    const queue = new StudioDecisionQueueStore(db, saveDb);
    let capturedStartOpts = null;
    let capturedActiveSup = null;
    const nowMs = 1_800_000_000_000;

    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queue,
      coworkStore: () => ({
        getSession: (id) => id === 'studio-main' ? { id, sessionType: 'browser', assistantMode: true, metabotId: 1, messages: [] } : null,
        listSessions: () => [],
        createSession: (title) => ({ id: 'sup-1', title, messages: [] }),
        setSessionAutoOrigin: () => {},
        updateSession: () => {},
        addMessage: () => ({ id: 'm1' }),
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async (_sid, _prompt, opts) => {
          capturedStartOpts = opts;
          capturedActiveSup = cos.getActiveSupervisionForSession('studio-main');
        },
      }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      getPreferredStudioSessionId: () => 'studio-main',
      now: () => nowMs,
      supervisionCoalesceMs: 0,
    });

    cos.onStudioWorkerTerminalState({
      task: {
        id: 't1',
        ownerIntent: 'S6 引擎开发',
        sourceSessionId: 'studio-main',
        longtermTaskId: null,
        longtermSubtaskId: null,
      },
      attempt: {
        id: 'att1',
        workerMetabotId: 15,
        workerSessionId: 'ws-15',
        queuedAt: new Date(nowMs - 16 * 60_000).toISOString(),
        startedAt: new Date(nowMs - 16 * 60_000).toISOString(),
        finishedAt: new Date(nowMs - 1000).toISOString(),
      },
      workerName: 'Builder阿码',
      outcome: 'completed',
      notifySummaryText: 'done',
    });

    await new Promise((r) => setTimeout(r, 25));
    assert.equal(capturedStartOpts.permissionMode, 'bypassPermissions');
    assert.equal(capturedStartOpts.autoApprove, false, 'avoids headless auto-review false rejections in [督办]');
    assert.equal(capturedActiveSup.startedAt, nowMs, 'verification timer starts at supervision start, not 16m-old worker start');
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});
