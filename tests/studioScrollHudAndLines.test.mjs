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
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const {
  buildBotBrowserAgentTools,
  buildBotBrowserScreenshotTool,
} = require('../dist-electron/main/libs/botBrowserAgentTools.js');
Module._load = originalLoad;

function disposeTempStore(sqliteStore, dir) {
  try { sqliteStore?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('Issues 1, 2 & 3: Studio browser sessions get a 400-row view window, panel wires auto-load on top scroll + 280px scroll-to-bottom button, and the scene engine draws worker connectors in place of the retired handoff arc', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scroll-page-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const coworkStore = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
    const browserSess = coworkStore.createSession('Studio Long Chat', dir, '', 'local', [], 1, 'browser');
    const standardSess = coworkStore.createSession('Standard Chat', dir, '', 'local', [], 1, 'standard');

    for (let i = 0; i < 250; i += 1) {
      coworkStore.addMessage(browserSess.id, { type: i % 5 === 0 ? 'assistant' : 'tool_use', content: `msg-${i}` });
      coworkStore.addMessage(standardSess.id, { type: 'assistant', content: `std-${i}` });
    }

    const browserView = coworkStore.getSessionView(browserSess.id);
    const standardView = coworkStore.getSessionView(standardSess.id);
    assert.equal(browserView.messages.length, 250, 'Studio browser session loads all 250 rows in one 400-row page without premature pagination');
    assert.equal(browserView.messageHistory.hasMoreBefore, false);
    assert.equal(browserView.messageHistory.pageSize, 400);
    assert.equal(standardView.messages.length, 100, 'Standard session keeps its 100-row window');
    assert.equal(standardView.messageHistory.hasMoreBefore, true);

    const panelSrc = fs.readFileSync(path.resolve('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx'), 'utf8');
    assert.match(panelSrc, /scroller\.scrollTop <= 96 && currentSession\?\.messageHistory\?\.hasMoreBefore/, 'auto-loads earlier messages near top');
    assert.match(panelSrc, /distanceToBottom > 280/, 'uses generous 280px threshold before showing scroll-to-bottom button');
    assert.match(panelSrc, /data-slot="panel-scroll-to-bottom"/, 'renders floating scroll-to-bottom button');

    const stageJs = fs.readFileSync(path.resolve('public/live-stage/stage.js'), 'utf8');
    // The scene engine replaced the handoff arc + worker constellation: workers
    // render once, as companion-rail items with canvas connectors — there is
    // no second dashed-arc path to suppress anymore.
    assert.doesNotMatch(stageJs, /constellationEl|layoutHandoff|handoff-flow/, 'no duplicate handoff arc path remains');
    const scenesJs = fs.readFileSync(path.resolve('public/live-stage/stage-scenes.js'), 'utf8');
    assert.match(scenesJs, /function drawWorker\(g, item, status, hero, fx, t\)/, 'worker connectors render via the scene engine');
    assert.match(
      stageJs,
      /const currentTasks = tasks\.filter\(\(t\) => t\?\.isCurrent === true\)\.slice\(0, 7\)/,
      'renders all parallel active tasks of the Studio session directly in the HUD',
    );
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('Issue 4: Parallel Studio delegations after a finished quick card each create their own active quick task card instead of gluing onto a done card or another Worker\'s card', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-parallel-hud-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    const ltStore = new LongTermTaskStore(db, saveDb);
    const orchStore = new OrchestrationStore(db, saveDb);

    const metabots = [
      { id: 1, name: 'AI_Sunny', metabot_type: 'twin', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
      { id: 15, name: 'Builder阿码', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
      { id: 22, name: 'Eleven', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
    ];
    const sessions = new Map([
      ['studio-7d40', { id: 'studio-7d40', sessionType: 'browser', assistantMode: true, metabotId: 1, status: 'idle' }],
    ]);

    // Step 1: an earlier quick card in studio-7d40 finished (`stage === 'done'`), just like `ltt_edb45cf8` in 7d40556e:
    const finishedQuick = ltStore.createQuickTask({
      title: 'metabot-multisign 技能上链发布 + 以阿码名义写教程',
      goal: '发布并写教程',
      definitionSessionId: 'studio-7d40',
    }, 'twin');
    assert.equal(finishedQuick.ok, true);
    ltStore.bindSession(finishedQuick.value.subtasks[0].id, 'studio-7d40', 'system');
    ltStore.acceptSubtask(finishedQuick.value.subtasks[0].id, 'owner', 'done');
    assert.equal(ltStore.getTask(finishedQuick.value.id).stage, 'done');

    const pendingWorkerPromises = [];
    const orchService = new TwinOrchestrationService({
      orchestrationStore: orchStore,
      coworkStore: { getSession: (id) => sessions.get(id) ?? null, updateSession: () => {} },
      coworkRunner: { stopSession: () => {}, insertCrossSessionMessageAndQueue: () => ({ insert: { ok: true, message: {} }, runQueued: true }) },
      longTermTaskStore: () => ltStore,
      isStudioSourceSession: (sid) => sid === 'studio-7d40',
      getFocusedTaskForSession: () => finishedQuick.value.id,
      onStudioWorkerTerminalState: () => true,
      directory: {
        getSession: (id) => sessions.get(id) ?? null,
        listMetabots: () => metabots,
        getOwnerGlobalMetaId: () => 'idq1owner',
      },
      getMetabotById: (id) => metabots.find((b) => b.id === id) ?? null,
      getWorkerWorkspace: () => dir,
      runWorkerTurn: async (params) => {
        await params.onSessionCreated(`ws-${params.metabotId}`);
        return await new Promise((resolve) => {
          pendingWorkerPromises.push(resolve);
        });
      },
    });

    // Step 2: Dispatch Builder阿码 on multisig security review -> MUST create a fresh active quick card (NOT reuse finishedQuick!)
    const amaRun = await orchService.delegateLocalWorker('studio-7d40', {
      workerMetabotId: 15,
      taskIntent: '多签工具安全审查与修复（资金路径专项）',
      objective: '逐项排查多签工具安全边界',
    });
    assert.notEqual(amaRun.task.longtermTaskId, finishedQuick.value.id, 'never binds new delegation onto a done quick card');
    assert.equal(ltStore.getTask(amaRun.task.longtermTaskId).stage, 'active');

    // Step 3: While Builder阿码 is running, dispatch Eleven on 3 multisig illustrations -> MUST create a SECOND parallel active quick card!
    const elevenRun = await orchService.delegateLocalWorker('studio-7d40', {
      workerMetabotId: 22,
      taskIntent: '多签教程配图三版（Eleven）',
      objective: '制作 3 个方向不同的多签介绍图',
    });
    assert.ok(elevenRun.task.longtermTaskId);
    assert.notEqual(elevenRun.task.longtermTaskId, finishedQuick.value.id);
    assert.notEqual(elevenRun.task.longtermTaskId, amaRun.task.longtermTaskId, 'parallel Studio Worker gets its own independent quick card');

    const activeStudioCards = ltStore.listBoard().cards.filter(
      (c) => c.stage === 'active' && ltStore.getTask(c.id)?.definitionSessionId === 'studio-7d40',
    );
    assert.equal(activeStudioCards.length, 2, 'both Builder阿码 and Eleven tasks are active in parallel on the board');

    for (const resolve of pendingWorkerPromises) {
      resolve('<worker_handoff>{"state":"ready","summary":"ok","deliverables":[],"verificationEvidence":[],"blockers":[],"humanAction":null}</worker_handoff>');
    }
    await new Promise((r) => setTimeout(r, 25));
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('Issue 5: Background / A2A sessions calling bot_browser_preview_local or bot_browser_screenshot never steal focus from the owner\'s active Studio tab', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-focus-guard-'));
  try {
    const htmlFile = path.join(dir, 'index-v4.html');
    fs.writeFileSync(htmlFile, '<!doctype html><title>Canary</title><h1>v4</h1>', 'utf8');

    const executed = [];
    const fakeTool = (name, _desc, _schema, handler) => ({ name, handler });
    const controlBotBrowser = {
      openUri: () => {},
      isBackgroundSession: (sid) => sid === 'a2a-atlas-session',
      execute: async (cmd) => {
        executed.push(cmd);
        if (cmd.action === 'get-active-tab') {
          return { action: 'get-active-tab', tabs: [{ id: 1, isActive: true }], activeTab: { id: 1, isActive: true } };
        }
        return { action: cmd.action, tabs: [{ id: 1, isActive: true }, { id: 5, isActive: false }], activeTab: { id: 1, isActive: true }, openedTabId: 5 };
      },
      screenshot: async () => ({ data: 'AA==', mimeType: 'image/jpeg', width: 100, height: 80 }),
    };
    const tools = [
      ...buildBotBrowserAgentTools({ tool: fakeTool, sessionId: 'a2a-atlas-session', controlBotBrowser }),
      ...buildBotBrowserScreenshotTool({ tool: fakeTool, sessionId: 'a2a-atlas-session', controlBotBrowser }),
    ];

    const previewTool = tools.find((t) => t.name === 'bot_browser_preview_local');
    await previewTool.handler({ path: htmlFile });
    const openCmd = executed.find((c) => c.action === 'open-tab');
    assert.equal(openCmd.activate, false, 'background/A2A preview opens with activate: false');

    executed.length = 0;
    const shotTool = tools.find((t) => t.name === 'bot_browser_screenshot');
    await shotTool.handler({ uri: `preview-metaapp://localhost${htmlFile}`, waitMs: 0, format: 'jpeg' });
    const lastSwitch = [...executed].reverse().find((c) => c.action === 'switch-tab');
    assert.deepEqual(lastSwitch, { action: 'switch-tab', tabId: 1 }, 'restores the owner\'s active Studio tab right after background screenshot');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
