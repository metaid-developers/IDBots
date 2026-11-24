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
const { buildStudioWaitReassuranceMessages } = require('../dist-electron/main/libs/turnAckReply.js');
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
  assert.match(scenesJs, /if \(lowFreqWait\) g\.setLineDash\(\[5, 7\]\)/, 'dashed low-frequency waiting/verifying link');
  assert.match(scenesJs, /dir === 'waiting' \|\| dir === 'verifying'/, 'waiting + verifying directions take the low-frequency dash');
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

    const reassuranceInputs = [];
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
      generateWaitingReassurance: async (input) => {
        reassuranceInputs.push(input);
        const name = input.workers[0]?.workerName ?? '同事';
        const parallelNote = input.includeParallelHint
          ? '你不用干等，有别的想法随时聊或让我并行派其他任务。'
          : '';
        const variants = [
          `${name}还在继续画图和自检，到现在大约 ${input.waitedMinutes} 分钟，整体推进正常。${parallelNote}`,
          `跟进一下，${name}那头已经运行约 ${input.waitedMinutes} 分钟，细节步骤比较多所以耗时长一点。${parallelNote}`,
          `${name}这边累计处理大约 ${input.waitedMinutes} 分钟了，后台一切正常，交回来我就立刻核验。${parallelNote}`,
          `同步一声，${name}已持续跑了约 ${input.waitedMinutes} 分钟，出图后我会先帮你核对完再呈报。${parallelNote}`,
        ];
        return variants[(reassuranceInputs.length - 1) % variants.length];
      },
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
    assert.match(messages.at(-1).content, /Eleven/);
    assert.match(messages.at(-1).content, /5 分钟/);
    assert.equal(reassuranceInputs[0].includeParallelHint, true, '1st check-in encourages parallel tasks/chat');
    assert.deepEqual(reassuranceInputs[0].priorMessages, []);

    // At +10m total (5m after r1): MUST STAY SILENT (2nd rung requires +10m = 15m total)!
    clock += 5 * 60_000;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null, 'no fixed 5-min spam at T=10m');

    // At +15m total (10m after r1): 2nd reassurance!
    clock += 5 * 60_000;
    const r2 = await cos.runHeartbeatTick(clock);
    assert.ok(r2.reassuranceMessageId, '2nd reassurance fires at 15 minutes (+10m)');
    assert.match(messages.at(-1).content, /15 分钟/);
    assert.equal(reassuranceInputs[1].includeParallelHint, false, 'parallel hint is occasional, not repeated back-to-back');
    assert.equal(reassuranceInputs[1].priorMessages.length, 1, 'prior reassurance passed to avoid repetition');

    // At +25m total (10m after r2): silent (3rd rung requires +15m = 30m total)!
    clock += 10 * 60_000;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);

    // At +30m total (15m after r2): 3rd reassurance!
    clock += 5 * 60_000;
    const r3 = await cos.runHeartbeatTick(clock);
    assert.ok(r3.reassuranceMessageId, '3rd reassurance fires at 30 minutes (+15m)');
    assert.match(messages.at(-1).content, /30 分钟/);
    assert.equal(reassuranceInputs[2].includeParallelHint, true, 'parallel hint returns occasionally at rung 2');
    assert.equal(reassuranceInputs[2].priorMessages.length, 2);

    // At +45m total (15m after r3): silent (4th rung requires +20m = 50m total)!
    clock += 15 * 60_000;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);

    // At +50m total (20m after r3): 4th reassurance!
    clock += 5 * 60_000;
    const r4 = await cos.runHeartbeatTick(clock);
    assert.ok(r4.reassuranceMessageId, '4th reassurance fires at 50 minutes (+20m)');
    assert.match(messages.at(-1).content, /50 分钟/);
    assert.equal(new Set(messages.filter((m) => m.metadata?.waitingReassurance).map((m) => m.content)).size, 4, 'all 4 reassurance messages are distinct');

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

test('Session 0bf9184a regressions: continuous wait timing survives retries & verification, LLM output rejects duplicates/failures without canned templates, and cross-session stale presenting items auto-defer so new Studio decisions pop immediately', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    // 1. Prompt builder contract check
    const msgs = buildStudioWaitReassuranceMessages({
      language: 'zh',
      phase: 'verifying',
      waitedMinutes: 30,
      priorCount: 2,
      workers: [{ workerName: 'Builder阿码', title: '修复批读回执三处 bug', progressNote: '单测全部通过' }],
      priorMessages: ['阿码还在处理中，大约过了 5 分钟。', '阿码已经跑了 15 分钟了。'],
      includeParallelHint: true,
    });
    assert.equal(msgs.length, 2);
    assert.match(msgs[0].content, /NEVER use canned status templates/);
    assert.match(msgs[0].content, /~30 minute\(s\)/);
    assert.match(msgs[0].content, /chat with you about other topics or assign another parallel task/i);
    assert.match(msgs[1].content, /Builder阿码/);
    assert.match(msgs[1].content, /单测全部通过/);
    assert.match(msgs[1].content, /Earlier waiting check-ins/);

    // 2. Continuous wait timer across Attempt 1 -> fail/supervision -> Attempt 2 -> supervision verify + anti-duplicate + cross-session queue deadlock fix
    const queue = new StudioDecisionQueueStore(db, saveDb);

    // Older Studio session left an item stuck in `presenting`!
    const oldItem = queue.enqueue({
      dedupeKey: 'old-session-stale-item',
      twinMetabotId: 1,
      originStudioSessionId: 'old-studio-7131445e',
      kind: 'decision',
      priority: 50,
      title: '《Avatar 兑换站引擎停转问题报告》',
      backgroundSummary: 'old bg',
      progressSummary: 'old prog',
      question: 'old q',
      recommendation: 'old r',
      nextStep: 'old next',
    }).item;
    const claimedOld = queue.claimNextForPresentation(1, 'old-studio-7131445e', '2026-11-23T13:59:31.000Z');
    assert.equal(claimedOld?.id, oldItem.id);
    assert.equal(claimedOld?.status, 'presenting');

    let clock = Date.parse('2026-11-25T00:53:20.000Z');
    const studioMessages = [
      { id: 'u0', type: 'user', content: '批读回执有三个问题要修', timestamp: clock - 2000 },
      { id: 'a0', type: 'assistant', content: '我已经派 Builder阿码 开始处理了', timestamp: clock },
    ];
    let openWorkers = [
      {
        attemptId: 'att-1',
        workerMetabotId: 2,
        workerName: 'Builder阿码',
        title: '修复批读回执三个问题',
        status: 'running',
        startedAt: clock + 1000,
      },
    ];
    const startedBriefingPrompts = [];
    const seenInputs = [];
    let emitEmptyOnce = false;
    let emitDuplicateOnce = false;

    const sessions = new Map([
      ['old-studio-7131445e', { id: 'old-studio-7131445e', title: 'Old', sessionType: 'browser', assistantMode: true, metabotId: 1, status: 'idle', messages: [] }],
      ['new-studio-0bf9184a', { id: 'new-studio-0bf9184a', title: 'Batch Receipt', sessionType: 'browser', assistantMode: true, metabotId: 1, status: 'idle', messages: studioMessages }],
    ]);

    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queue,
      coworkStore: () => ({
        getSession: (id) => sessions.get(id) ?? null,
        listSessions: () => [...sessions.values()],
        createSession: () => ({ id: 'sup-3c9062f2' }),
        updateSession: () => {},
        addMessage: (sid, msg) => {
          const target = sessions.get(sid);
          const full = { id: `m-${(target?.messages?.length ?? 0) + 1}`, timestamp: clock, ...msg };
          target?.messages?.push(full);
          return full;
        },
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async (_sid, prompt) => {
          startedBriefingPrompts.push(prompt);
        },
      }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      getPreferredStudioSessionId: () => 'new-studio-0bf9184a',
      listOpenSiblingDelegations: () => openWorkers,
      generateWaitingReassurance: async (input) => {
        seenInputs.push(input);
        if (emitEmptyOnce) {
          emitEmptyOnce = false;
          return '';
        }
        if (emitDuplicateOnce) {
          emitDuplicateOnce = false;
          return input.priorMessages?.[0] ?? '';
        }
        return input.phase === 'verifying'
          ? `阿码刚把修复代码交回来了，我已经在后台逐项核验，整件事前前后后大约进行了 ${input.waitedMinutes} 分钟，验完立刻请你拍板。`
          : `阿码在后台推进这次修复大约有 ${input.waitedMinutes} 分钟了，你不用干等，有别的安排也可以先跟我并行聊。`;
      },
      now: () => clock,
      idleDebounceMs: 0,
    });

    // Even with old-studio item in 'presenting', volatile context & presence for new-studio MUST NOT show old-studio's briefing!
    assert.doesNotMatch(cos.buildVolatileTurnContext('new-studio-0bf9184a'), /<active_studio_briefing>/);

    // T + 5m: 1st reassurance fires for Attempt 1
    clock += 5 * 60_000 + 2_000;
    const t1 = await cos.runHeartbeatTick(clock);
    assert.ok(t1.reassuranceMessageId);
    assert.equal(seenInputs[0].waitedMinutes, 5);

    // T + 11m: Attempt 1 fails -> back-office [督办] starts with a newer startedAt!
    clock += 6 * 60_000;
    openWorkers = [];
    cos['activeSupervisionsBySession'].set('new-studio-0bf9184a', {
      attemptId: 'att-1',
      workerMetabotId: 2,
      workerName: 'Builder阿码',
      title: '修复批读回执三个问题',
      startedAt: clock,
    });
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);

    // T + 13m: [督办] re-delegates Attempt 2 with startedAt = T + 13m!
    clock += 2 * 60_000;
    cos['activeSupervisionsBySession'].delete('new-studio-0bf9184a');
    openWorkers = [
      {
        attemptId: 'att-2',
        workerMetabotId: 2,
        workerName: 'Builder阿码',
        title: '修复批读回执三个问题',
        status: 'running',
        startedAt: clock,
      },
    ];
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);

    // T + 15m02s (10m after 1st reassurance): MUST fire at ~15 minutes, NOT reset to 5 minutes!
    clock += 2 * 60_000 + 2_000;
    const t2 = await cos.runHeartbeatTick(clock);
    assert.ok(t2.reassuranceMessageId, '2nd reassurance fires on progressive schedule despite retry');
    assert.equal(seenInputs[1].waitedMinutes, 15, 'elapsed wait remains 15m across Attempt 1 -> [督办] -> Attempt 2');
    assert.equal(seenInputs[1].priorMessages.length, 1);

    // T + 25m: Attempt 2 finishes -> [督办] verification starts with startedAt = T + 25m!
    clock += 10 * 60_000;
    openWorkers = [];
    cos['activeSupervisionsBySession'].set('new-studio-0bf9184a', {
      attemptId: 'att-2',
      workerMetabotId: 2,
      workerName: 'Builder阿码',
      title: '修复批读回执三个问题',
      startedAt: clock,
    });

    // T + 30m02s (15m after 2nd reassurance): 3rd reassurance fires in 'verifying' phase with waitedMinutes === 30!
    clock += 5 * 60_000 + 2_000;
    const t3 = await cos.runHeartbeatTick(clock);
    assert.ok(t3.reassuranceMessageId, '3rd reassurance fires at 30m during verification');
    assert.equal(seenInputs[2].phase, 'verifying');
    assert.equal(seenInputs[2].waitedMinutes, 30, 'elapsed wait reports 30m instead of resetting to 5m on verification start');

    // Empty LLM response or exact duplicate MUST NOT fall back to canned templates!
    clock += 20 * 60_000;
    emitEmptyOnce = true;
    const beforeEmptyCount = studioMessages.length;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);
    assert.equal(studioMessages.length, beforeEmptyCount, 'empty LLM generation emits no canned bubble');

    clock += 20 * 60_000;
    emitDuplicateOnce = true;
    assert.equal((await cos.runHeartbeatTick(clock)).reassuranceMessageId ?? null, null);
    assert.equal(studioMessages.length, beforeEmptyCount, 'duplicate LLM output is dropped');

    // 3. [督办] finishes verification and enqueues decision for new-studio-0bf9184a!
    cos['activeSupervisionsBySession'].delete('new-studio-0bf9184a');
    const newItem = queue.enqueue({
      dedupeKey: 'batch-receipt-fix-acceptance',
      twinMetabotId: 1,
      originStudioSessionId: 'new-studio-0bf9184a',
      kind: 'acceptance',
      priority: 50,
      title: '批读回执三处修复已核验，请拍板合并发版',
      backgroundSummary: '三处修复已核验',
      progressSummary: '测试全绿',
      question: '是否合并发版？',
      recommendation: '合并到 main 并构建',
      nextStep: '合并并发布',
    }).item;

    clock += 1_000;
    const tickPop = await cos.runHeartbeatTick(clock);
    assert.equal(tickPop.presentedItemId, newItem.id, 'cross-session stale presenting item auto-deferred and current session decision popped immediately!');
    assert.equal(queue.getById(oldItem.id)?.status, 'queued', 'stale old-session item safely returned to queued');
    assert.equal(queue.getById(newItem.id)?.status, 'presenting', 'current-session item claimed into presenting');
    assert.equal(startedBriefingPrompts.length, 1);
    assert.match(startedBriefingPrompts[0], /批读回执三处修复已核验/);
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

