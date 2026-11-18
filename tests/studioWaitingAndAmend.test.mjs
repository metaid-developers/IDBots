import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Module from 'node:module';

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
  return originalLoad.apply(this, arguments);
};
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const { createLiveStageState, waitingLiveStage } = require('../dist-electron/main/services/studioLiveStageModel.js');
Module._load = originalLoad;

function disposeTempStore(sqliteStore, dir) {
  try { sqliteStore?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function createSqliteHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-waiting-amend-'));
  const sqliteStore = await SqliteStore.create(dir);
  return { dir, sqliteStore, db: sqliteStore.getDatabase(), saveDb: sqliteStore.getSaveFunction() };
}

test('Issues 1, 2 & 4: Liquid-Orb has dedicated waiting activity, scene engine draws connectors only for laid-out rail items, dashed low-frequency link renders in waiting/verifying, and HUD only highlights explicit isCurrent===true', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.resolve('public/live-stage/liquid-orb.js'), 'utf8'), { window });
  assert.equal(window.liquidOrbActivityForFamily('waiting'), 'waiting');
  const waitingParams = window.liquidOrbParamsForFamily('waiting');
  assert.ok(waitingParams.contourDeform > 0.1 && waitingParams.contourDeform < 0.3, 'gentle waiting deformation');

  const stageJs = fs.readFileSync(path.resolve('public/live-stage/stage.js'), 'utf8');
  const scenesJs = fs.readFileSync(path.resolve('public/live-stage/stage-scenes.js'), 'utf8');
  // The scene engine replaced layoutHandoff: connectors draw only for laid-out
  // rail items (hidden/zero-size items never enter M.items), and verifying
  // workers get the dashed low-frequency link.
  assert.doesNotMatch(stageJs, /layoutHandoff|handoff-flow|worker-constellation/);
  assert.match(scenesJs, /M\.items\.get\(`\$\{M\.hero\.type\}:\$\{id\}`\) \|\| null/, 'hero connector resolves only a visible rail item');
  assert.match(scenesJs, /status === 'verifying'\) g\.setLineDash\(\[4, 5\]\)/, 'dashed low-frequency verifying link');
  assert.match(stageJs, /const currentIdx = tasks\.findIndex\(\(t\) => t\?\.isCurrent === true\)/, 'never highlights non-current tasks');

  const base = createLiveStageState({
    sessionId: 's1',
    turnId: 't1',
    botName: 'AI_Sunny',
    language: 'zh',
    directorEnabled: false,
    nowMs: 1000,
  });
  const verifyingScene = waitingLiveStage(base, {
    workerName: 'Eleven',
    title: 'NFT 贡献者徽章',
    phase: 'back_office_verifying',
    startedAt: 500,
    nowMs: 2000,
  });
  assert.equal(verifyingScene.family, 'waiting');
  assert.equal(verifyingScene.kicker, '后台核验中');
  assert.match(verifyingScene.headline, /Eleven 已交回，正在核验结果/);
});

test('Issue 3: Progressive waiting reassurance fires on 5m -> +10m (15m) -> +15m (30m) -> +20m (50m) schedule, never fixed 5-minute spam', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const queue = new StudioDecisionQueueStore(db, saveDb);
    let clock = 1_000_000;
    const messages = [
      { id: 'm0', type: 'assistant', content: '已经开工，等 Eleven 交图', timestamp: clock },
    ];
    let workers = [
      { attemptId: 'att-1', workerMetabotId: 22, workerName: 'Eleven', title: 'IDBots 贡献者徽章', status: 'running', startedAt: clock },
    ];

    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queue,
      coworkStore: () => ({
        getSession: () => ({
          id: 'studio-1',
          title: 'Badge',
          sessionType: 'browser',
          assistantMode: true,
          metabotId: 1,
          status: 'idle',
          messages,
        }),
        listSessions: () => [],
        createSession: () => ({ id: 'sup-1' }),
        updateSession: () => {},
        addMessage: (_sid, msg) => {
          const full = { id: `m-${messages.length}`, timestamp: clock, ...msg };
          messages.push(full);
          return full;
        },
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async () => {},
      }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      getPreferredStudioSessionId: () => 'studio-1',
      listOpenSiblingDelegations: () => workers,
      now: () => clock,
      idleDebounceMs: 0,
    });

    // At +4m: silent.
    clock += 4 * 60_000;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);

    // At +5m (T = 5m): 1st reassurance!
    clock += 1 * 60_000;
    const r1 = await cos.runHeartbeatTick(clock);
    assert.ok(r1.reassuranceMessageId, '1st reassurance fires at 5 minutes');
    assert.match(messages.at(-1).content, /Eleven 仍在后台处理/);
    assert.match(messages.at(-1).content, /5 分钟/);

    // At +10m total (5m after r1): MUST STAY SILENT (2nd rung requires +10m = 15m total)!
    clock += 5 * 60_000;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null, 'no fixed 5-min spam at T=10m');

    // At +15m total (10m after r1): 2nd reassurance!
    clock += 5 * 60_000;
    const r2 = await cos.runHeartbeatTick(clock);
    assert.ok(r2.reassuranceMessageId, '2nd reassurance fires at 15 minutes (+10m)');
    assert.match(messages.at(-1).content, /15 分钟/);

    // At +25m total (10m after r2): silent (3rd rung requires +15m = 30m total)!
    clock += 10 * 60_000;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);

    // At +30m total (15m after r2): 3rd reassurance!
    clock += 5 * 60_000;
    const r3 = await cos.runHeartbeatTick(clock);
    assert.ok(r3.reassuranceMessageId, '3rd reassurance fires at 30 minutes (+15m)');
    assert.match(messages.at(-1).content, /30 分钟/);

    // At +45m total (15m after r3): silent (4th rung requires +20m = 50m total)!
    clock += 15 * 60_000;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);

    // At +50m total (20m after r3): 4th reassurance!
    clock += 5 * 60_000;
    const r4 = await cos.runHeartbeatTick(clock);
    assert.ok(r4.reassuranceMessageId, '4th reassurance fires at 50 minutes (+20m)');
    assert.match(messages.at(-1).content, /50 分钟/);

    // Also verify queued decisions DO NOT pop mid-flight while workers are running:
    queue.enqueue({
      dedupeKey: 'midflight-hold',
      twinMetabotId: 1,
      originStudioSessionId: 'studio-1',
      kind: 'decision',
      title: 'Hold while Eleven runs',
      backgroundSummary: 'bg',
      progressSummary: 'prog',
      question: 'q',
      recommendation: 'r',
      nextStep: 'n',
    });
    clock += 60_000;
    const held = await cos.runHeartbeatTick(clock);
    assert.equal(held.presentedItemId, null, 'proactive briefing held while Eleven is still running');
    assert.equal(held.presence.mode, 'shaping');

    workers = [];
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('Issue 5: Mid-flight direction adjustment to the SAME Worker in Studio automatically stops & supersedes the obsolete in-flight run while keeping different Workers parallel', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const metabots = [
      { id: 1, name: 'AI_Sunny', metabot_type: 'twin', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
      { id: 22, name: 'Eleven', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
      { id: 3, name: 'loop', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
    ];
    const ltStore = new LongTermTaskStore(db, saveDb);
    const orchStore = new OrchestrationStore(db, saveDb);

    let focusedTaskId = null;
    const stoppedSessions = [];
    const pendingResolvers = new Map();
    const sessions = new Map([
      ['studio-main', { id: 'studio-main', sessionType: 'browser', assistantMode: true, metabotId: 1, status: 'idle' }],
    ]);

    let seq = 0;
    const orchService = new TwinOrchestrationService({
      orchestrationStore: orchStore,
      coworkStore: {
        getSession: (id) => sessions.get(id) ?? null,
        updateSession: (id, u) => {
          const s = sessions.get(id);
          if (s) Object.assign(s, u);
        },
      },
      coworkRunner: {
        stopSession: (sid) => {
          stoppedSessions.push(sid);
          const s = sessions.get(sid);
          if (s) s.status = 'idle';
          pendingResolvers.get(sid)?.('');
        },
        insertCrossSessionMessageAndQueue: () => ({ insert: { ok: true, message: {} }, runQueued: true }),
      },
      longTermTaskStore: () => ltStore,
      isStudioSourceSession: (sid) => sid === 'studio-main',
      getFocusedTaskForSession: () => focusedTaskId,
      onStudioWorkerTerminalState: () => true,
      directory: {
        getSession: (id) => sessions.get(id) ?? null,
        listMetabots: () => metabots,
        getOwnerGlobalMetaId: () => 'idq1owner',
      },
      getMetabotById: (id) => metabots.find((b) => b.id === id) ?? null,
      getWorkerWorkspace: () => dir,
      runWorkerTurn: async (params) => {
        seq += 1;
        const wsId = `ws-${params.metabotId}-${seq}`;
        sessions.set(wsId, { id: wsId, sessionType: 'standard', metabotId: params.metabotId, status: 'running' });
        await params.onSessionCreated(wsId);
        return await new Promise((resolve) => {
          pendingResolvers.set(wsId, resolve);
        });
      },
    });

    // 1. Dispatch Eleven to generate 2 badge candidates:
    const run1 = await orchService.delegateLocalWorker('studio-main', {
      workerMetabotId: 22,
      objective: 'Generate 2 badge candidates',
      idempotencyKey: 'eleven-2-badges',
    });
    focusedTaskId = run1.task.longtermTaskId;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(orchStore.getTask(run1.task.id).status, 'running');

    // 2. Dispatch a DIFFERENT Worker (loop) in parallel -> must NOT cancel Eleven!
    const parallelOtherWorker = await orchService.delegateLocalWorker('studio-main', {
      workerMetabotId: 3,
      objective: 'Draft album intro copy',
      idempotencyKey: 'loop-copy',
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(orchStore.getTask(run1.task.id).status, 'running', 'different Worker runs in parallel without cancelling Eleven');
    assert.equal(orchStore.getTask(parallelOtherWorker.task.id).status, 'running');

    // 3. Owner says "可以让他出三个版本，让我来挑选" -> Twin re-dispatches Eleven:
    const run2 = await orchService.delegateLocalWorker('studio-main', {
      workerMetabotId: 22,
      objective: 'Generate 3 distinct badge candidates instead',
      idempotencyKey: 'eleven-3-badges',
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(orchStore.getTask(run1.task.id).status, 'cancelled', 'Eleven run #1 auto-superseded and cancelled');
    assert.ok(stoppedSessions.includes('ws-22-1'), 'Eleven live session #1 stopped immediately');
    assert.equal(orchStore.getTask(run2.task.id).status, 'running', 'Eleven updated 3-badge run is now the sole active Eleven run');
    assert.equal(run2.task.longtermTaskId, run1.task.longtermTaskId, 'reused the same focused Managed Task card');
    assert.equal(orchStore.getTask(parallelOtherWorker.task.id).status, 'running', 'loop parallel task untouched');

    // Settle remaining promises cleanly before closing DB.
    for (const resolve of pendingResolvers.values()) {
      resolve('done\n<worker_handoff>{"state":"ready","summary":"ok","deliverables":[],"verificationEvidence":[],"blockers":[],"humanAction":null}</worker_handoff>');
    }
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});
