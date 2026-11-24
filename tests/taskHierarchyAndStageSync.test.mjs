import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { sortColumnCards } from '../src/renderer/utils/taskBoardOrganization.ts';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.apply(this, [request, parent, isMain]);
};

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const { applyStudioLiveStagePatch } = require('../dist-electron/main/services/studioLiveStageFrame.js');
const {
  createLiveStageState,
  buildStudioLiveTaskHud,
} = require('../dist-electron/main/services/studioLiveStageModel.js');
const { buildAssistantModePrompt } = require('../dist-electron/main/libs/assistantModePrompt.js');
Module._load = originalLoad;

const repoRoot = path.resolve(import.meta.dirname, '..');

test('Issue 1: studioLiveStageFrame matches shared per-Bot stage frame via botKey (fixing 19d9aafd session-mismatch freeze) and stage.js clears stale reportUri/report-ready on New Chat', async () => {
  // Simulate Tab #1 claimed by earlier session `76e10171` (`botKey: "bot:1"`) in `report-ready`
  let pageState = {
    protocol: 'idbots.live-stage.v1',
    sessionId: '76e10171-0c39-4c2a-82aa-658d725e0954',
    botKey: 'bot:1',
    turnId: 'turn-old-1',
    turnStartedAt: 1000,
    revision: 5,
    family: 'report-ready',
    headline: '汇报已投到大屏',
    reportUri: 'preview-metaapp://localhost/old/report.html',
  };

  const fakeFrame = {
    url: 'http://127.0.0.1:45123/stage.html',
    frames: [],
    executeJavaScript: async (script) => {
      if (script.includes('bridge.getState')) {
        return {
          bridge: true,
          sessionId: pageState.sessionId,
          botKey: pageState.botKey,
          turnId: pageState.turnId,
          turnStartedAt: pageState.turnStartedAt,
        };
      }
      if (script.includes('bridge.applyPatch')) {
        const match = script.match(/bridge\.applyPatch\((\{[\s\S]*\})\);/);
        assert.ok(match, 'patch JSON extracted');
        const incoming = JSON.parse(match[1]);
        assert.equal(incoming.botKey, 'bot:1');
        pageState = { ...incoming, reportUri: incoming.reportUri ?? null };
        return { ok: true };
      }
      throw new Error(`unexpected script: ${script}`);
    },
  };

  const deps = {
    getWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          mainFrame: fakeFrame,
        },
      },
    ],
    executeTabCommand: async () => ({
      action: 'get-tab-info',
      tabs: [],
      activeTab: null,
      info: {
        current: {
          renderer: { type: 'html-iframe', url: 'http://127.0.0.1:45123/stage.html' },
        },
      },
    }),
  };

  // New Studio conversation `19d9aafd` for the SAME Bot (`bot:1`) patches Tab #1:
  // previously threw LiveStageFrameError('session-mismatch') 150+ times; now succeeds seamlessly!
  const newTurnState = createLiveStageState({
    sessionId: '19d9aafd-adc0-449b-9023-b03c1bbc8099',
    botKey: 'bot:1',
    turnId: 'turn-new-2',
    botName: 'AI_Sunny',
    language: 'zh',
    nowMs: 2000,
    family: 'making',
  });
  await applyStudioLiveStagePatch(deps, { tabId: 1, state: newTurnState });
  assert.equal(pageState.sessionId, '19d9aafd-adc0-449b-9023-b03c1bbc8099');
  assert.equal(pageState.family, 'making');
  assert.equal(pageState.reportUri, null, 'stale previous-session reportUri is cleared');

  // A different Bot (`bot:2`) still gets `session-mismatch` so Bot #2 never hijacks Bot #1's stage
  const bot2State = createLiveStageState({
    sessionId: 'bot2-sess',
    botKey: 'bot:2',
    turnId: 'turn-bot2-1',
    botName: 'OtherBot',
    language: 'zh',
    nowMs: 3000,
  });
  await assert.rejects(
    () => applyStudioLiveStagePatch(deps, { tabId: 1, state: bot2State }),
    (err) => err?.reason === 'session-mismatch',
  );

  // Verify stage.js hides dead disabled reportOpen button and resets resting stage on same-bot draft
  const stageJs = fs.readFileSync(path.join(repoRoot, 'public/live-stage/stage.js'), 'utf8');
  assert.match(stageJs, /reportOpen\.hidden = !canOpenReport && !projectionInFlight/);
  assert.match(stageJs, /restingFamilies\.has\(state\.family\)/);
});

test('Issue 2: Rework & companion tasks auto-bind parentTaskId (19d9aafd flow: parent -> illustrations + v2 -> v3 supersedes v2) and indent under parent in HUD & Board', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-task-hier-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    const ltStore = new LongTermTaskStore(db, saveDb, {
      resolveParticipants: (ids) =>
        ids.map((id) => ({
          id,
          name: id === 21 ? 'Lucy' : id === 22 ? 'Eleven' : `Bot-${id}`,
          avatar: null,
        })),
    });
    const orchStore = new OrchestrationStore(db, saveDb);
    const queueStore = new StudioDecisionQueueStore(db, saveDb);

    // 1. Parent task created earlier in 6a8a9157: "MetaContract→MRC-721 转换教程方案"
    const parentCreated = ltStore.createQuickTask(
      {
        title: 'MetaContract→MRC-721 转换教程方案',
        goal: '产出转换教程方案',
        assigneeMetabotId: 21,
        definitionSessionId: '6a8a9157',
        originSessionId: '6a8a9157',
        originChannel: 'studio',
      },
      'twin',
    );
    const parentId = parentCreated.value.id;

    let clockMs = Date.parse('2026-11-18T01:01:00.000Z');
    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queueStore,
      coworkStore: () => ({
        getSession: (sid) => ({ id: sid, sessionType: 'browser', assistantMode: true, metabotId: 1, messages: [] }),
        listSessions: () => [],
        createSession: () => ({ id: 'sup' }),
        updateSession: () => {},
        addMessage: () => ({ id: 'm1', timestamp: clockMs }),
      }),
      coworkRunner: () => ({ isSessionActive: () => false, startSession: async () => {} }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      now: () => clockMs,
    });

    // Owner rejects v1 in session 19d9aafd -> Twin calls studio_decision_resolve -> records recent decision parent!
    cos.recordRecentDecisionTask('19d9aafd', parentId);

    const orch = new TwinOrchestrationService({
      orchestrationStore: orchStore,
      coworkStore: {
        getSession: (id) => ({ id, metabotId: 1, sessionType: 'browser', assistantMode: true }),
        createSession: (title, cwd, _sp, _em, _sk, metabotId) => ({ id: `w-${metabotId}-${Math.random()}`, title, cwd, metabotId }),
        updateSession: () => {},
        setSessionAutoOrigin: () => {},
        addMessage: () => ({}),
        getLatestHumanMessageId: () => 'msg-rework-1',
      },
      coworkRunner: { isSessionActive: () => false },
      longTermTaskStore: () => ltStore,
      isStudioSourceSession: (sid) => sid === '19d9aafd',
      getFocusedTaskForSession: (sid) => cos.getFocusedTaskId(sid),
      getRecentDecisionTaskForSession: (sid) => cos.getRecentDecisionTask(sid),
      onStudioWorkerTerminalState: () => true,
      directory: {
        getSession: (id) => ({ id, metabotId: 1 }),
        listMetabots: () => [
          { id: 1, name: 'Twin', metabot_type: 'twin', enabled: true, boss_global_metaid: 'owner-gmid' },
          { id: 21, name: 'Lucy', metabot_type: 'worker', enabled: true, role: 'writer', boss_global_metaid: 'owner-gmid' },
          { id: 22, name: 'Eleven', metabot_type: 'worker', enabled: true, role: 'designer', boss_global_metaid: 'owner-gmid' },
        ],
        getOwnerGlobalMetaId: () => 'owner-gmid',
      },
      getMetabotById: (id) =>
        id === 1
          ? { id: 1, name: 'Twin', metabot_type: 'twin', enabled: true, boss_global_metaid: 'owner-gmid' }
          : id === 21
            ? { id: 21, name: 'Lucy', metabot_type: 'worker', enabled: true, boss_global_metaid: 'owner-gmid' }
            : { id: 22, name: 'Eleven', metabot_type: 'worker', enabled: true, boss_global_metaid: 'owner-gmid' },
      getWorkerWorkspace: () => dir,
      runWorkerTurn: async ({ objective }) =>
        `${objective}\n<worker_handoff>\n{"status":"completed","summary":"done","deliverables":["/tmp/out.md"],"evidence":["verified"]}\n</worker_handoff>`,
    });

    // 2. Twin delegates companion illustrations (Eleven #22) + v2 rewrite (Lucy #21) WITHOUT passing parentTaskId!
    const dImg = await orch.delegateLocalWorker('19d9aafd', {
      workerMetabotId: 22,
      taskIntent: '为面向人类读者的短教程生成两张简体中文插画并落盘',
      objective: '生成两张插画',
    });
    const dV2 = await orch.delegateLocalWorker('19d9aafd', {
      workerMetabotId: 21,
      taskIntent: '按 owner 退回意见把教程方案 v1 改写成面向人类用户的短教程 v2',
      objective: '改写成短教程 v2',
    });

    const imgTask = ltStore.getTask(dImg.task.longtermTaskId);
    const v2Task = ltStore.getTask(dV2.task.longtermTaskId);
    assert.equal(imgTask.parentTaskId, parentId, 'Illustrations companion task auto-linked to parent tutorial task');
    assert.equal(v2Task.parentTaskId, parentId, 'v2 rework task auto-linked to parent tutorial task');
    assert.equal(v2Task.parentTaskTitle, 'MetaContract→MRC-721 转换教程方案');

    // 3. HUD groups both active children indented directly under their parent task!
    const hud1 = buildStudioLiveTaskHud({
      cards: ltStore.listBoard().cards,
      sessionOwnedTaskIds: new Set([imgTask.id, v2Task.id]),
      studioBusy: false,
      rawQueuedDecisions: 0,
    });
    assert.equal(hud1.tasks[0].id, parentId, 'Parent task sits at the top as group header');
    assert.equal(hud1.tasks[0].isChild, undefined);
    assert.equal(hud1.tasks[1].isChild, true, 'First child task is marked isChild for indentation');
    assert.equal(hud1.tasks[2].isChild, true, 'Second child task is marked isChild for indentation');

    // Board column sorting also groups children immediately below their parent
    const inProgSorted = sortColumnCards('in_progress', ltStore.listBoard().cards.filter((c) => c.column === 'in_progress'));
    assert.equal(inProgSorted[0].id, parentId);
    assert.equal(inProgSorted[1].parentTaskId, parentId);
    assert.equal(inProgSorted[2].parentTaskId, parentId);

    // 4. Owner reviews v2 and asks Lucy (#21) for v3 (adding official MetaID):
    //    - v3 flattens to root `parentId` (never 2-level nested!)
    //    - completed v2 child for Lucy (#21) is automatically superseded (`done`) so it does not linger!
    cos.recordRecentDecisionTask('19d9aafd', v2Task.id);
    const dV3 = await orch.delegateLocalWorker('19d9aafd', {
      workerMetabotId: 21,
      taskIntent: '在教程 v2 中补写官方兑换站 MetaID 与防冒充核对说明，产出 v3',
      objective: '补写官方兑换站 MetaID 产出 v3',
    });
    const v3Task = ltStore.getTask(dV3.task.longtermTaskId);
    assert.equal(v3Task.parentTaskId, parentId, 'Grandchild v3 flattens cleanly to root parent task');
    assert.equal(ltStore.getTask(v2Task.id).stage, 'done', 'Superseded v2 child task for Lucy is auto-closed');
  } finally {
    try { sqliteStore.close?.(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('Issue 3 (19d9aafd Transcript Audit): <instant_ack> opening rule avoids rejected owner_update, and parallel Worker set change never spams 10s waiting reassurance', async () => {
  // 3a. Assistant prompt explicitly skips owner_update(kind: "opening") when <instant_ack> is present
  const assistantPrompt = buildAssistantModePrompt(true);
  assert.match(assistantPrompt, /do NOT call `owner_update` with `kind: "opening"`/);

  // 3b. Changing open-worker set mid-wait (2 parallel workers -> 1 finishes -> 1 still running) does NOT spam reassurance 10s later!
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-reassure-nospam-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    const queue = new StudioDecisionQueueStore(db, saveDb);
    let clockMs = Date.parse('2026-11-18T09:01:40.000Z');
    const studioMessages = [
      { id: 'u1', type: 'user', content: '重写一版并配图', timestamp: clockMs - 1000 },
      { id: 'a1', type: 'assistant', content: '两路已经派出去了', timestamp: clockMs },
    ];
    let openWorkers = [
      { attemptId: 'att-eleven', workerMetabotId: 22, workerName: 'Eleven', title: '插画', status: 'running', startedAt: clockMs - 2000 },
      { attemptId: 'att-lucy', workerMetabotId: 21, workerName: 'Lucy', title: '短教程 v2', status: 'running', startedAt: clockMs - 1000 },
    ];

    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queue,
      coworkStore: () => ({
        getSession: () => ({ id: '19d9aafd', sessionType: 'browser', assistantMode: true, metabotId: 1, messages: studioMessages }),
        listSessions: () => [{ id: '19d9aafd', title: 'Studio', sessionType: 'browser', assistantMode: true, metabotId: 1, updatedAt: clockMs }],
        createSession: () => ({ id: 'sup' }),
        updateSession: () => {},
        addMessage: (_sid, msg) => {
          const m = { id: `r-${studioMessages.length}`, timestamp: clockMs, ...msg };
          studioMessages.push(m);
          return m;
        },
      }),
      coworkRunner: () => ({ isSessionActive: () => false, startSession: async () => {} }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      listOpenSiblingDelegations: () => openWorkers,
      generateWaitingReassurance: async (input) =>
        `${input.workers.map((w) => w.workerName).join('、')}还在后台推进，已经约 ${input.waitedMinutes} 分钟，有结果我马上核验。`,
      now: () => clockMs,
    });

    // At +5m05s (09:06:45): first reassurance fires normally
    clockMs += 5 * 60_000 + 5_000;
    const r1 = await cos.runHeartbeatTick(clockMs);
    assert.ok(r1.reassuranceMessageId, 'First 5-min reassurance emitted');

    // 10 seconds later (09:06:55), Lucy finishes while Eleven is still running (signature changes!)
    clockMs += 10_000;
    openWorkers = [openWorkers[0]];
    const r2 = await cos.runHeartbeatTick(clockMs);
    assert.equal(r2.reassuranceMessageId ?? null, null, 'Changing worker set 10s later MUST NOT spam a second reassurance bubble');

    // 65 seconds later (09:08:00), still well inside the +10m rung -> still quiet!
    clockMs += 65_000;
    const r3 = await cos.runHeartbeatTick(clockMs);
    assert.equal(r3.reassuranceMessageId ?? null, null, 'Still quiet until the 10-minute next rung elapses');
  } finally {
    try { sqliteStore.close?.(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
