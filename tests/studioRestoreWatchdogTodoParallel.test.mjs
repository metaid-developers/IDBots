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

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const { TwinTodoStore } = require('../dist-electron/main/twinTodoStore.js');
const {
  buildTwinTodoAgentTools,
  formatCompactTwinTodosPromptBlock,
  inferProjectKeyFromWorkspace,
} = require('../dist-electron/main/libs/twinTodoAgentTools.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');
const { reduceLiveStageMessage, createLiveStageState } = require('../dist-electron/main/services/studioLiveStageModel.js');
Module._load = originalLoad;

function disposeTempStore(sqliteStore, dir) {
  try { sqliteStore?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const STAGE_ASSET_ROOT = path.resolve('public/live-stage');
const FALLBACK_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Issue 1: StudioLiveStageService persists pre-exit stage state across app restarts and reconstructs pre-existing report sessions without wiping to blank idle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stage-restore-'));
  const stageRoot = path.join(dir, 'live-stage');
  try {
    const patches = [];
    const sessions = new Map([
      [
        'sess-persisted',
        {
          id: 'sess-persisted',
          sessionType: 'browser',
          assistantMode: true,
          metabotId: 1,
          browserUri: 'preview-metaapp://localhost/Users/tusm/reports/2026-11-17-multisig-security-final.html',
          browserTitle: '多签安全终审汇报',
          messages: [],
        },
      ],
      [
        'sess-legacy',
        {
          id: 'sess-legacy',
          sessionType: 'browser',
          assistantMode: true,
          metabotId: 1,
          browserUri: 'preview-metaapp://localhost/Users/tusm/reports/legacy-report.html',
          browserTitle: 'Legacy Report',
          messages: [
            { id: 'u1', type: 'user', content: '审查结果怎么样？', timestamp: 1000 },
            { id: 'a1', type: 'assistant', content: '多签工具安全审查已完成，34/34 测试全绿并合入主干。详细逐项证据见右侧终审汇报。', timestamp: 2000, metadata: { isFinal: true } },
            { id: 'a2', type: 'assistant', content: '📽️ [终审汇报 已投影到右侧投影屏](preview-metaapp://localhost/Users/tusm/reports/legacy-report.html)', timestamp: 2100, metadata: { projectorReport: { uri: 'preview-metaapp://localhost/Users/tusm/reports/legacy-report.html', announced: true } } },
          ],
        },
      ],
    ]);

    const makeStageService = () => createStudioLiveStageService({
      getSession: (id) => sessions.get(id) ?? null,
      getMetabotById: () => ({ name: 'AI_Sunny' }),
      getSettings: () => ({ enabled: true, directorEnabled: false }),
      getLanguage: () => 'zh',
      stageRoot,
      assetRoot: STAGE_ASSET_ROOT,
      fallbackAvatarDataUri: FALLBACK_AVATAR,
      projectionRetryBackoffMs: [5],
      project: async () => ({ uri: 'preview-metaapp://localhost/stage.html', tabId: 10, announced: true }),
      getStageTab: async () => ({ id: 10, uri: null }),
      applyPatch: async ({ state }) => {
        patches.push(JSON.parse(JSON.stringify(state)));
      },
      getLiveTaskHud: () => ({
        queuedDecisions: 0,
        tasks: [{ id: 'ltt_1', title: 'AI 互联网商业化主线', state: 'in_progress', accepted: 5, total: 11, isCurrent: true }],
      }),
    });

    // Run 1 before quitting App: user turn speaks, projects a report, completes, then disposes.
    const svcBeforeQuit = makeStageService();
    svcBeforeQuit.observeMessage('sess-persisted', {
      id: 'm-user',
      type: 'user',
      content: '查看多签审查报告',
      timestamp: 1000,
    });
    svcBeforeQuit.observeMessage('sess-persisted', {
      id: 'm-reply',
      type: 'assistant',
      content: '安全审查已全部办完，34 项测试全绿，完整矩阵已投在右侧终版页。',
      timestamp: 1500,
      metadata: { isFinal: true },
    });
    await svcBeforeQuit.projectReport(
      {
        sessionId: 'sess-persisted',
        localPath: '/Users/tusm/reports/2026-11-17-multisig-security-final.html',
        title: '多签安全终审汇报',
      },
      async () => ({
        uri: 'preview-metaapp://localhost/Users/tusm/reports/2026-11-17-multisig-security-final.html',
        tabId: 11,
        announced: true,
      }),
    );
    svcBeforeQuit.observeComplete('sess-persisted');
    await new Promise((r) => setTimeout(r, 30));
    const stateBeforeQuit = svcBeforeQuit.getState('sess-persisted');
    assert.ok(stateBeforeQuit);
    assert.equal(stateBeforeQuit.reportUri, 'preview-metaapp://localhost/Users/tusm/reports/2026-11-17-multisig-security-final.html');
    svcBeforeQuit.dispose();

    // Run 2 after reopening App: brand-new service instance calls `showSession`.
    patches.length = 0;
    const svcAfterRelaunch = makeStageService();
    svcAfterRelaunch.showSession('sess-persisted');
    await new Promise((r) => setTimeout(r, 40));

    const restored = svcAfterRelaunch.getState('sess-persisted');
    assert.ok(restored, 'restored stage state exists immediately on relaunch');
    assert.notEqual(restored.family, 'idle', 'does NOT wipe Live Stage back to blank idle on relaunch');
    assert.equal(
      restored.reportUri,
      'preview-metaapp://localhost/Users/tusm/reports/2026-11-17-multisig-security-final.html',
      'preserves reportUri so the Live Stage "打开汇报" button works after relaunch',
    );
    assert.equal(restored.headline, stateBeforeQuit.headline, 'preserves pre-exit headline');
    assert.equal(restored.taskHud?.tasks.length, 1, 'hydrates live Task Progress HUD on relaunch');
    assert.ok(patches.some((p) => p.sessionId === 'sess-persisted' && p.reportUri === restored.reportUri));

    // Legacy pre-upgrade session (no snapshot file yet) reconstructs from browserUri + transcript!
    svcAfterRelaunch.showSession('sess-legacy');
    await new Promise((r) => setTimeout(r, 40));
    const legacyRestored = svcAfterRelaunch.getState('sess-legacy');
    assert.equal(legacyRestored.family, 'report-ready');
    assert.equal(legacyRestored.reportUri, 'preview-metaapp://localhost/Users/tusm/reports/legacy-report.html');
    assert.match(legacyRestored.headline, /多签工具安全审查已完成/);

    svcAfterRelaunch.dispose();
  } finally {
    disposeTempStore(null, dir);
  }
});

test('Issue 2: DSH stall/hard-cap watchdog never kills an open ask_user_question / pendingPermission waiting on the human overnight, and emitTurnStatusGoal omits stale Studio Turn-1 titles', () => {
  const runnerSrc = fs.readFileSync(path.resolve('src/main/libs/coworkRunner.ts'), 'utf8');

  // 1) `ask_user_question` is tracked in `dshHumanWaitToolUseIds` rather than aged against `dshToolCallHardCapMs`
  assert.match(
    runnerSrc,
    /const isHumanWaitTool = lowerTool === 'ask_user_question' \|\| lowerTool === 'askuserquestion'/,
    'classifies ask_user_question as a human-wait tool exempt from subprocess hard-cap aging',
  );
  assert.match(
    runnerSrc,
    /if \(\s*activeSession\.pendingPermission\s*\|\|\s*dshHumanWaitToolUseIds\.size > 0\s*\|\|\s*dshAnonHumanWaitCount > 0\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*refreshDshInFlightToolTimestamps\(\);\s*armDshStallWatchdog\(\);\s*return;\s*\}/,
    're-arms watchdog without running collectExpiredToolCalls while waiting on a human choice/permission card',
  );

  // 2) Subagent lifecycle events keep the stall watchdog and in-flight clocks fresh
  assert.match(
    runnerSrc,
    /onSubagentEvent:\s*\(event\)\s*=>\s*\{\s*(?:\/\/[^\n]*\n\s*)*refreshDshInFlightToolTimestamps\(\);\s*armDshStallWatchdog\(\);/,
    'active background subagent events refresh stall and tool clocks',
  );

  // 3) `emitTurnStatusGoal` skips internal [DISPATCH-REPORT] / Studio briefing prompts and omits stale Studio Turn-1 titles
  assert.match(
    runnerSrc,
    /emitTurnStatusGoal[\s\S]{0,650}DISPATCH-REPORT[\s\S]{0,650}const omitStaleStudioTitle =/,
    'emitTurnStatusGoal omits stale Turn-1 Studio titles and skips internal cross-session dispatch reports',
  );
});

test('Issue 3: TwinTodoStore + twin_todo tool provide a lightweight, silent, persistent memory checklist with optional task/session/project linkage and compact prompt injection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-todo-memory-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    const todoStore = new TwinTodoStore(db, saveDb);

    assert.equal(inferProjectKeyFromWorkspace(null, '/Users/tusm/idbots/project/bots/1/2026-11-17'), null, 'ignores daily bot scratch dirs');
    assert.equal(
      inferProjectKeyFromWorkspace(null, '/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/btc-utxo'),
      'IDBots',
      'infers repo name cleanly from worktree cwd',
    );

    const fakeTool = (name, _desc, _schema, handler) => ({ name, handler });
    const tools = buildTwinTodoAgentTools({
      tool: fakeTool,
      sessionId: 'sup-session-1',
      control: {
        isEnabledForSession: () => true,
        resolveMetabotId: () => 1,
        // Supervision session resolves back to the owner's Studio demand conversation!
        resolveSessionDefaults: () => ({
          sessionId: '7d40556e-6067-4ec3-865b-8e80037b113a',
          projectKey: 'IDBots',
        }),
        store: () => todoStore,
      },
    });
    assert.equal(tools.length, 1);
    const twinTodo = tools[0];
    assert.equal(twinTodo.name, 'twin_todo');

    // Empty todo list injects ZERO prompt tokens!
    assert.equal(formatCompactTwinTodosPromptBlock(todoStore.list({ metabotId: 1 })), '');

    // Add standalone + task-linked todos in one call
    const addRes = await twinTodo.handler({
      action: 'add',
      items: [
        {
          title: '合入多签安全分支后补跑主干冒烟',
          taskId: 'ltt_edb45cf8',
          note: '等 owner 确认合入后执行',
        },
        {
          title: '跟进 AI U哥补齐三份跨链材料后转交桥方',
        },
      ],
    });
    assert.ok(!addRes.isError);
    const pending = todoStore.list({ metabotId: 1 });
    assert.equal(pending.length, 2);
    assert.equal(pending[0].taskId, 'ltt_edb45cf8');
    assert.equal(pending[0].sessionId, '7d40556e-6067-4ec3-865b-8e80037b113a');
    assert.equal(pending[0].projectKey, 'IDBots');
    assert.equal(pending[1].taskId, null, 'todo item can exist independently without belonging to any task');

    // Deduplicates identical pending title instead of piling up duplicates
    await twinTodo.handler({
      action: 'add',
      title: '跟进 AI U哥补齐三份跨链材料后转交桥方',
      note: '回执原样转发',
    });
    assert.equal(todoStore.list({ metabotId: 1 }).length, 2, 'deduplicates identical pending todo');

    // Compact volatile prompt block stays ultra-lean and rides StudioChiefOfStaffService
    const promptBlock = formatCompactTwinTodosPromptBlock(todoStore.list({ metabotId: 1 }));
    assert.match(promptBlock, /<twin_pending_todos count="2">/);
    assert.match(promptBlock, /task=ltt_edb45cf8, proj=IDBots, chat=7d40556e/);

    // Complete first todo -> only 1 pending remains
    const completeRes = await twinTodo.handler({
      action: 'complete',
      id: pending[0].id,
    });
    assert.ok(!completeRes.isError);
    assert.match(completeRes.content[0].text, /Remaining pending \(1\)/);
    assert.equal(todoStore.list({ metabotId: 1 }).length, 1);
    assert.equal(todoStore.list({ metabotId: 1, includeDone: true }).length, 2);

    // Silent on Live Stage: calling `twin_todo` never switches the orb scene
    const baseStage = createLiveStageState({
      sessionId: '7d40556e',
      turnId: 't1',
      botName: 'AI_Sunny',
      language: 'zh',
      family: 'speaking',
    });
    const afterTodoStage = reduceLiveStageMessage(baseStage, {
      id: 'tu-todo',
      type: 'tool_use',
      content: 'Using tool: twin_todo',
      timestamp: 3000,
      metadata: { toolName: 'twin_todo', toolInput: { action: 'list' } },
    });
    assert.equal(afterTodoStage, baseStage, 'twin_todo is invisible on Live Stage');
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('Issue 4 & Live-Conversation Fixes: Unlinked Studio delegation creates a parallel active quick card even when a project task is focused, HUD keeps multiple focused tasks active, and resolving one decision never cancels an unrelated sibling decision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-parallel-1019-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    const coworkStore = new CoworkStore(db, saveDb);
    const ltStore = new LongTermTaskStore(db, saveDb);
    const orchStore = new OrchestrationStore(db, saveDb);
    const decisionStore = new StudioDecisionQueueStore(db, saveDb);
    const todoStore = new TwinTodoStore(db, saveDb);

    const studioSess = coworkStore.createSession('IDBots NFT与MRC721功能梳理', dir, '', 'local', [], 1, 'browser');
    coworkStore.updateSession(studioSess.id, {});
    // Mark assistantMode on browser session (default for Studio sessions)
    db.run('UPDATE cowork_sessions SET assistant_mode = 1 WHERE id = ?', [studioSess.id]);

    const projectSess = coworkStore.createSession('AI 互联网商业化主线', dir, '', 'local', [], 1, 'longterm');

    // Create active Long-Term Project Task (`ltt_65a3247d` equivalent: "AI 互联网商业化主线")
    const createdProj = ltStore.createTask({
      title: 'AI 互联网商业化主线：服务支付基建跑通 + MRC721 数字产品主场景',
      goal: '跑通商业化主线',
      definitionSessionId: projectSess.id,
      subtasks: [
        { title: 'S4·对话式发行与购买（Agent 原生体验）', description: 'S4 E2E', acceptanceCriteria: ['成交闭环'], preferredChannel: 'delegate_bot' },
      ],
    }, 'twin');
    assert.equal(createdProj.ok, true);
    const projTaskId = createdProj.value.id;
    ltStore.activateTask(projTaskId, 'owner');
    ltStore.beginSubtask(createdProj.value.subtasks[0].id, 'twin');

    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => decisionStore,
      coworkStore: () => coworkStore,
      coworkRunner: () => ({ isSessionActive: () => false, startSession: async () => {} }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      getPreferredStudioSessionId: () => studioSess.id,
      listPendingTwinTodos: (twinId) => todoStore.list({ metabotId: twinId }),
    });

    // Simulate 10:16 S4 proactive briefing focusing `projTaskId` on `studioSess.id`
    cos.focusTask(studioSess.id, projTaskId);
    assert.equal(cos.getFocusedTaskId(studioSess.id), projTaskId);

    const metabots = [
      { id: 1, name: 'AI_Sunny', metabot_type: 'twin', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
      { id: 15, name: 'Builder阿码', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
    ];
    const pendingWorkerResolvers = [];
    const orchService = new TwinOrchestrationService({
      orchestrationStore: orchStore,
      coworkStore,
      coworkRunner: { stopSession: () => {}, insertCrossSessionMessageAndQueue: () => ({ insert: { ok: true, message: {} }, runQueued: true }) },
      longTermTaskStore: () => ltStore,
      isStudioSourceSession: (sid) => sid === studioSess.id,
      getFocusedTaskForSession: (sid) => cos.getFocusedTaskId(sid),
      onStudioWorkerTerminalState: () => true,
      directory: {
        getSession: (id) => coworkStore.getSession(id),
        listMetabots: () => metabots,
        getOwnerGlobalMetaId: () => 'idq1owner',
      },
      getMetabotById: (id) => metabots.find((b) => b.id === id) ?? null,
      getWorkerWorkspace: () => dir,
      runWorkerTurn: async (params) => {
        const ws = coworkStore.createSession('Worker Run', dir, '', 'local', [], params.metabotId, 'standard');
        await params.onSessionCreated(ws.id);
        return await new Promise((resolve) => {
          pendingWorkerResolvers.push(resolve);
        });
      },
    });

    // Simulate 10:19 owner request: Twin calls `local_worker_delegate` for Builder阿码 WITHOUT `longtermTaskId`!
    const utxoDelegation = await orchService.delegateLocalWorker(studioSess.id, {
      workerMetabotId: 15,
      taskIntent: 'BTC UTXO <1000 过滤与转账下限对齐 Metalet（S6 收尾）',
      objective: '参考 Metalet e266b9c / b31d645 / 1b3f93a 落地 <1000 sat 过滤与转账下限',
    });

    assert.ok(utxoDelegation.task.longtermTaskId, 'auto-creates a quick task card for the Studio delegation');
    assert.notEqual(
      utxoDelegation.task.longtermTaskId,
      projTaskId,
      'MUST NOT hijack the focused project card (AI 互联网商业化主线) when longtermTaskId was omitted!',
    );

    // Both `projTaskId` (focused project card) AND `utxoDelegation.task.longtermTaskId` (born in studioSess.id) are active simultaneously!
    const candidates = ltStore.listBoard().cards.filter((c) => c.stage !== 'done' && c.stage !== 'cancelled' && c.managedState != null);
    const currentIds = new Set();
    for (const fid of cos.getFocusedTaskIds(studioSess.id)) {
      if (candidates.some((c) => c.id === fid)) currentIds.add(fid);
    }
    for (const card of candidates) {
      if (ltStore.getTask(card.id)?.definitionSessionId === studioSess.id) {
        currentIds.add(card.id);
      }
    }
    assert.equal(currentIds.has(projTaskId), true, 'focused project task remains active in HUD');
    assert.equal(currentIds.has(utxoDelegation.task.longtermTaskId), true, 'new parallel UTXO task ALSO appears as a second active task in HUD');
    assert.equal(currentIds.size, 2, 'two active parallel tasks in Studio HUD');

    // Live-conversation bonus fix: resolving Eleven's cover decision (`sdq_cover`) must NOT cancel Builder阿码's security-review merge decision (`sdq_sec`) on the same task, while still cancelling `lt_status:` auto-fallbacks!
    const coverPick = decisionStore.enqueue({
      twinMetabotId: 1,
      originStudioSessionId: studioSess.id,
      longtermTaskId: 'ltt_multisig',
      kind: 'decision',
      title: '《MetaBot 多签》封面三版，你选哪一版？',
      backgroundSummary: 'Eleven 交了三版',
      progressSummary: '核验全过',
      question: '选哪一版作为封面？',
      recommendation: 'B',
      nextStep: '定稿封面',
    });
    const secMerge = decisionStore.enqueue({
      twinMetabotId: 1,
      originStudioSessionId: studioSess.id,
      longtermTaskId: 'ltt_multisig',
      kind: 'decision',
      title: '安全审查已过二次验证：是否批准多签修复合入 main？',
      backgroundSummary: '阿码交回 257 行安全报告',
      progressSummary: '34/34 测试全绿',
      question: '是否批准合入 main？',
      recommendation: '批准合入',
      nextStep: 'git merge --no-ff',
    });
    const autoFallback = decisionStore.enqueue({
      dedupeKey: 'lt_status:ltt_multisig:sub1:waiting_owner',
      twinMetabotId: 1,
      originStudioSessionId: studioSess.id,
      longtermTaskId: 'ltt_multisig',
      kind: 'decision',
      title: 'Auto fallback card',
      backgroundSummary: 'auto',
      progressSummary: 'auto',
      question: 'auto?',
      recommendation: 'A',
      nextStep: 'continue',
    });

    decisionStore.resolve(coverPick.item.id, 'owner 选 B');
    decisionStore.cancelSiblingQueuedForTask(1, 'ltt_multisig', coverPick.item.id);

    assert.equal(decisionStore.getById(secMerge.item.id).status, 'queued', 'independent sibling security-review decision survives intact!');
    assert.equal(decisionStore.getById(autoFallback.item.id).status, 'cancelled', 'redundant lt_status auto-fallback is still cleaned up');

    // Clean waiting reassurance title clipping (no dangling unclosed `（S6 `)
    todoStore.add({ metabotId: 1, title: '等阿码 UTXO 过滤跑完核验 diff', sessionId: studioSess.id });
    const volatile = cos.buildVolatileTurnContext(studioSess.id);
    assert.match(volatile, /<twin_pending_todos count="1">/);

    for (const resolve of pendingWorkerResolvers) {
      resolve('<worker_handoff>{"state":"ready","summary":"ok","deliverables":[],"verificationEvidence":[],"blockers":[],"humanAction":null}</worker_handoff>');
    }
    await new Promise((r) => setTimeout(r, 25));
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});
