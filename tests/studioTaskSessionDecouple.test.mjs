import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Module from 'node:module';

import { createSessionTabBinding } from '../src/renderer/services/sessionTabBinding.ts';

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
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
const { evaluateStudioTwinToolGuard } = require('../dist-electron/main/libs/studioToolGuard.js');
const { buildProjectorModePrompt } = require('../dist-electron/main/libs/assistantModePrompt.js');
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');
Module._load = originalLoad;

const repoRoot = path.resolve(import.meta.dirname, '..');

test('Issue 1: clearCurrentScreen does NOT archive Studio sessions, and CoworkStore startup migration restores auto-archived Studio sessions (e.g. 6a8a9157)', async () => {
  // 1a. Static guard: clearCurrentScreen in browserCowork.ts must never call archiveSession
  const browserCoworkSrc = fs.readFileSync(
    path.join(repoRoot, 'src/renderer/services/browserCowork.ts'),
    'utf8',
  );
  const clearFnSlice = browserCoworkSrc.slice(browserCoworkSrc.indexOf('async clearCurrentScreen'));
  assert.doesNotMatch(
    clearFnSlice,
    /archiveSession\(/,
    'clearCurrentScreen must NOT archive the previous Studio conversation',
  );

  // 1b. Startup SQLite migration restores human Studio sessions (`browser` + `assistant_mode=1` + `auto_origin IS NULL`)
  //     while keeping non-Studio or auto-origin archived sessions untouched!
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-unarchive-mig-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    const cowork = new CoworkStore(db, saveDb);

    const studioSess = cowork.createSession(
      '委派测试任务查看动画效果',
      dir,
      '',
      'local',
      [],
      1,
      'browser',
    );
    db.run('UPDATE cowork_sessions SET assistant_mode = 1 WHERE id = ?', [studioSess.id]);
    cowork.archiveSession(studioSess.id);

    const standardSess = cowork.createSession(
      'Manual archived standard chat',
      dir,
      '',
      'local',
      [],
      1,
      'standard',
    );
    cowork.archiveSession(standardSess.id);

    assert.equal(cowork.isSessionArchived(studioSess.id), true);
    assert.equal(cowork.isSessionArchived(standardSess.id), true);

    // Clear migration marker to simulate pre-upgrade DB launching for the first time
    db.run("DELETE FROM kv WHERE key = 'studio_clear_screen_unarchive_v1'");
    const upgradedCowork = new CoworkStore(db, saveDb);

    assert.equal(
      upgradedCowork.isSessionArchived(studioSess.id),
      false,
      'Auto-archived Studio session is restored so it reappears in Studio History',
    );
    assert.equal(
      upgradedCowork.isSessionArchived(standardSess.id),
      true,
      'Standard non-Studio archived session remains archived',
    );
  } finally {
    try { sqliteStore.close?.(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('Issue 2: Proactive briefings, projector prompt, and Studio tool guard forbid ask_user_question for task reporting/acceptance/plan selection', async () => {
  const projPrompt = buildProjectorModePrompt();
  assert.match(projPrompt, /ask_user_question/);
  assert.match(
    projPrompt,
    /严禁调用 `ask_user_question`|NEVER call `ask_user_question`/i,
    'Projector mode prompt explicitly bans ask_user_question for deliverable reporting/acceptance/selection',
  );

  // Tool guard denies AskUserQuestion during proactive briefing turns, while allowing it during pre-task surveys
  const blockedInBriefing = evaluateStudioTwinToolGuard({
    isStudioTwinFrontOffice: true,
    isProactiveBriefingTurn: true,
    toolName: 'ask_user_question',
    toolInput: { questions: [{ question: '选 A 还是 B？' }] },
    workspaceRoot: os.tmpdir(),
  });
  assert.equal(blockedInBriefing.action, 'deny');
  assert.match(blockedInBriefing.reason, /NEVER call ask_user_question/);

  const allowedInSurvey = evaluateStudioTwinToolGuard({
    isStudioTwinFrontOffice: true,
    isProactiveBriefingTurn: false,
    toolName: 'ask_user_question',
    toolInput: { questions: [{ question: '预算范围是多少？' }] },
    workspaceRoot: os.tmpdir(),
  });
  assert.equal(allowedInSurvey.action, 'allow');

  // Proactive briefing prompt generated by StudioChiefOfStaffService forbids ask_user_question and projects HTML onto right projector
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-briefing-noask-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const saveDb = sqliteStore.getSaveFunction();
    const queue = new StudioDecisionQueueStore(db, saveDb);
    queue.enqueue({
      twinMetabotId: 1,
      originStudioSessionId: 'studio-1',
      kind: 'acceptance',
      title: '多签文章终稿审阅',
      backgroundSummary: '已完成初稿与校验',
      progressSummary: '全文 2800 字',
      question: '是否按当前版本发布？',
      options: [
        { label: 'A：确认发布', recommended: true },
        { label: 'B：修改标题后再发' },
      ],
      recommendation: '推荐 A',
      nextStep: '广播上链',
    });

    let capturedBriefingPrompt = '';
    const projectedPaths = [];
    const studioMessages = [];
    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queue,
      coworkStore: () => ({
        getSession: () => ({
          id: 'studio-1',
          sessionType: 'browser',
          assistantMode: true,
          metabotId: 1,
          messages: studioMessages,
        }),
        listSessions: () => [
          { id: 'studio-1', title: 'Studio', sessionType: 'browser', assistantMode: true, metabotId: 1, updatedAt: 1000 },
        ],
        createSession: () => ({ id: 'sup-1' }),
        updateSession: () => {},
        addMessage: (_sid, msg) => {
          const m = { id: `m-${studioMessages.length + 1}`, timestamp: 1000, ...msg };
          studioMessages.push(m);
          return m;
        },
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async (_sid, prompt) => {
          capturedBriefingPrompt = prompt;
        },
      }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      getAppLanguage: () => 'zh',
      projectShowcaseHtml: async (input) => {
        projectedPaths.push(input.localPath);
      },
    });

    const tick = await cos.runHeartbeatTick(2000);
    assert.ok(tick.presentedItemId);
    assert.match(capturedBriefingPrompt, /绝对禁止调用 `ask_user_question`/);
    assert.equal(projectedPaths.length, 1, 'Right projector receives the full HTML briefing with options');
  } finally {
    try { sqliteStore.close?.(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('Issue 3: Single persistent Live Stage per Bot across Studio new/switched sessions (tab reuse + stage.js botKey handoff + HUD focus follow)', async () => {
  // 3a. sessionTabBinding reuses ONE Live Stage tab for all Studio conversations of Bot #1,
  //     even across New Chat (`prepareDraftTab` -> `bindNewSession`) and switching sessions,
  //     while opening a distinct stage tab if switched to Bot #2!
  const tabs = [{ id: 1, uri: null, title: null }];
  let activeTabId = 1;
  let nextTabId = 2;
  const stageEntry = 'preview-metaapp://localhost/live-stage/liquid-orb-abc/stage.html';
  const sessionBots = new Map([
    ['sess-1', 1],
    ['sess-2', 1],
    ['sess-bot2', 2],
  ]);
  let openSession = { id: 'sess-1', sessionType: 'browser', metabotId: 1 };

  const prevWindow = globalThis.window;
  globalThis.window = {
    electron: {
      studioLiveStage: {
        getStageEntry: async () => ({ uri: stageEntry }),
        showSession: async () => {},
        prepareDraft: async () => ({ ok: true }),
      },
    },
  };

  try {
    const binding = createSessionTabBinding();
    binding.attach({
      controlTabs: async (cmd) => {
        if (cmd.action === 'get-tabs' || cmd.action === 'get-active-tab') {
          return {
            action: cmd.action,
            tabs: tabs.map((t) => ({ ...t, isActive: t.id === activeTabId })),
            activeTab: { ...tabs.find((t) => t.id === activeTabId), isActive: true },
          };
        }
        if (cmd.action === 'open-tab') {
          const tab = { id: nextTabId++, uri: cmd.uri ?? null, title: cmd.label ?? null };
          tabs.push(tab);
          activeTabId = tab.id;
          return {
            action: 'open-tab',
            openedTabId: tab.id,
            tabs: tabs.map((t) => ({ ...t, isActive: t.id === activeTabId })),
            activeTab: { ...tab, isActive: true },
          };
        }
        if (cmd.action === 'navigate-tab') {
          const t = tabs.find((x) => x.id === cmd.tabId);
          t.uri = cmd.uri ?? null;
          if (cmd.activate) activeTabId = t.id;
          return {
            action: 'navigate-tab',
            tabs: tabs.map((x) => ({ ...x, isActive: x.id === activeTabId })),
            activeTab: { ...tabs.find((x) => x.id === activeTabId), isActive: true },
          };
        }
        if (cmd.action === 'switch-tab') {
          activeTabId = cmd.tabId;
          return {
            action: 'switch-tab',
            tabs: tabs.map((x) => ({ ...x, isActive: x.id === activeTabId })),
            activeTab: { ...tabs.find((x) => x.id === activeTabId), isActive: true },
          };
        }
        throw new Error(`unexpected ${cmd.action}`);
      },
      getOpenSession: () => openSession,
      getSessionBotId: (sid) => sessionBots.get(sid) ?? null,
      openSession: async (sid) => ({ id: sid, sessionType: 'browser', metabotId: sessionBots.get(sid) }),
      listBrowserSessions: async () => [],
    });

    // Session 1 binds Tab #1 as Bot #1's Live Stage
    await binding.bindNewSession('sess-1');
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].uri, stageEntry);

    // Owner clicks "New Chat" in Studio (`clearCurrentScreen` sets openSession=null, then `prepareDraftTab()`)
    openSession = null;
    const draftTabForNewChat = await binding.prepareDraftTab(1);
    assert.equal(draftTabForNewChat, 1, 'New Chat reuses Bot #1 existing Live Stage tab #1');
    assert.equal(tabs.length, 1, 'Zero extra Live Stage tabs spawned on New Chat');

    // Owner sends message in fresh Session 2 (still Bot #1)
    openSession = { id: 'sess-2', sessionType: 'browser', metabotId: 1 };
    await binding.bindNewSession('sess-2');
    assert.equal(tabs.length, 1, 'Session 2 of Bot #1 shares Live Stage tab #1');

    // Switching back to Session 1 keeps Live Stage tab #1
    openSession = { id: 'sess-1', sessionType: 'browser', metabotId: 1 };
    await binding.revealSessionTab('sess-1');
    assert.equal(tabs.length, 1);

    // Switching to a DIFFERENT Bot (Bot #2) opens Bot #2's own dedicated Live Stage tab #2!
    openSession = { id: 'sess-bot2', sessionType: 'browser', metabotId: 2 };
    await binding.bindNewSession('sess-bot2');
    assert.equal(tabs.length, 2, 'Different Bot gets its own dedicated Live Stage tab');
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }

  // 3b. StudioLiveStageService keeps active Bot #1 stage steady when switching sessions while updating HUD focus,
  //     and stage.js accepts same-botKey session handoffs without `session-mismatch`!
  const stageJs = fs.readFileSync(path.join(repoRoot, 'public/live-stage/stage.js'), 'utf8');
  assert.match(stageJs, /claimedBotKey/);
  assert.match(stageJs, /patch\.botKey === claimedBotKey/);

  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-shared-stage-'));
  try {
    const appliedPatches = [];
    const sessions = new Map([
      ['s1', { id: 's1', sessionType: 'browser', assistantMode: true, metabotId: 1, messages: [] }],
      ['s2', { id: 's2', sessionType: 'browser', assistantMode: true, metabotId: 1, messages: [] }],
    ]);
    const service = createStudioLiveStageService({
      getSession: (id) => sessions.get(id) ?? null,
      getMetabotById: () => ({ id: 1, name: 'AI_Sunny', avatar: null }),
      getSettings: () => ({ enabled: true, directorEnabled: false }),
      getLanguage: () => 'zh',
      listOpenDelegations: () => [
        { attemptId: 'att-1', workerMetabotId: 15, workerName: 'Builder阿码', title: 'Run audit', startedAt: 900 },
      ],
      getLiveTaskHud: (sid) => ({
        queuedDecisions: 0,
        tasks: [{ id: `task-for-${sid}`, title: `Focused ${sid}`, state: 'in_progress', accepted: 0, total: 1, isCurrent: true }],
      }),
      project: async (input) => ({ uri: `preview-metaapp://localhost${input.localPath}`, tabId: 1, announced: true }),
      getStageTab: async () => ({ id: 1, uri: stageEntry }),
      applyPatch: async (p) => { appliedPatches.push(p.state); },
      stageRoot,
      assetRoot: path.join(repoRoot, 'public/live-stage'),
      fallbackAvatarDataUri: 'data:image/png;base64,iVBORw0KGgo=',
    });

    // Start an active working turn on s1
    service.observeMessage('s1', { id: 'u1', type: 'user', content: 'Run audit', timestamp: 1000 });
    for (let i = 0; i < 30 && appliedPatches.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(appliedPatches.at(-1).botKey, 'bot:1');
    assert.equal(appliedPatches.at(-1).taskHud.tasks[0].id, 'task-for-s1');

    // Switch UI to s2 of the SAME Bot while s1 is still active: stage keeps active Bot run & refreshes HUD to s2!
    const beforeCount = appliedPatches.length;
    service.showSession('s2');
    for (let i = 0; i < 30 && appliedPatches.length <= beforeCount; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(appliedPatches.at(-1).taskHud.tasks[0].id, 'task-for-s2');
    assert.notEqual(appliedPatches.at(-1).family, 'idle', 'Active Bot stage is NOT wiped to idle when switching conversations');

    service.dispose();
  } finally {
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch {}
  }
});
