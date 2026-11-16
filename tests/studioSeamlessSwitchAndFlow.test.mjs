import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { LongTermAdvanceService } = require('../dist-electron/main/services/longTermAdvanceService.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { resolveCoworkModelLimits } = require('../dist-electron/main/libs/coworkModelLimits.js');
const { buildOwnerTurnInputPrompt } = require('../dist-electron/main/libs/coworkPromptStrategy.js');
const {
  createVolatileDedupState,
  applyVolatileDedup,
} = require('../dist-electron/main/libs/coworkVolatileDedup.js');
const { describeStudioTurnError } = require('../dist-electron/main/shared/studioTurnErrorCopy.js');
Module._load = originalLoad;

function disposeTempStore(sqliteStore, dir) {
  try { sqliteStore?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function createSqliteHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-seamless-switch-'));
  const sqliteStore = await SqliteStore.create(dir);
  return { dir, sqliteStore, db: sqliteStore.getDatabase(), saveDb: sqliteStore.getSaveFunction() };
}

test('deepseek-4.1-flash resolves 1M multimodal limits and model-switch error copy stays human-friendly', () => {
  const limits = resolveCoworkModelLimits({}, 'deepseek-4.1-flash', null);
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.supportsVision, true);

  const zhCopy = describeStudioTurnError(
    'DSH turn failed: Cannot switch to idbots/deepseek-4.1-flash: context compaction failed: summary is not smaller than the shadowed content',
    'zh',
  );
  assert.match(zhCopy.reason, /切换的新模型/);
  assert.match(zhCopy.hint, /继续/);

  const ownerPrompt = buildOwnerTurnInputPrompt('继续');
  assert.match(ownerPrompt, /NEVER treat a bare "继续" as selecting Option A or authorizing irreversible on-chain/);
});

test('Back-office [督办] re-delegations route back to StudioChiefOfStaffService (zero ORCH-NOTIFY leak) and remain visible to Studio open-worker lookups', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const queue = new StudioDecisionQueueStore(db, saveDb);
    const orchStore = new OrchestrationStore(db, saveDb);
    const kvMap = new Map();
    const sessions = new Map([
      ['studio-main', {
        id: 'studio-main',
        title: 'IDBots贡献者徽章NFT专辑设计',
        sessionType: 'browser',
        assistantMode: true,
        metabotId: 1,
        status: 'idle',
        messages: [],
      }],
    ]);
    const startedSessions = [];

    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queue,
      coworkStore: () => ({
        getSession: (id) => sessions.get(id) ?? null,
        listSessions: () => [...sessions.values()],
        createSession: (title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId, sessionType) => {
          const created = {
            id: `sup-${sessions.size}`,
            title,
            cwd,
            systemPrompt,
            executionMode,
            activeSkillIds,
            metabotId,
            sessionType,
            status: 'idle',
            messages: [],
          };
          sessions.set(created.id, created);
          return created;
        },
        setSessionAutoOrigin: (id, origin) => {
          const s = sessions.get(id);
          if (s) s.autoOrigin = origin;
        },
        updateSession: (id, patch) => {
          const s = sessions.get(id);
          if (s) Object.assign(s, patch);
        },
        addMessage: (id, m) => {
          const full = { id: `m-${Date.now()}`, timestamp: Date.now(), ...m };
          sessions.get(id)?.messages.push(full);
          return full;
        },
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async (sid, prompt) => {
          startedSessions.push({ sid, prompt });
        },
      }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      getPreferredStudioSessionId: () => 'studio-main',
      kv: {
        get: (k) => kvMap.get(k),
        set: (k, v) => { kvMap.set(k, v); },
      },
      supervisionCoalesceMs: 0,
      idleDebounceMs: 0,
    });

    // Step 1: initial Studio delegation settles -> creates hidden [督办] session
    const task1 = orchStore.createTask({
      ownerIntent: '三方向主视觉初稿',
      enrichedGoal: '三方向主视觉初稿',
      acceptanceCriteria: ['1024x1024 PNG'],
      sourceSessionId: 'studio-main',
      twinMetabotId: 1,
      ownerGlobalMetaId: 'idq1owner',
      longtermTaskId: 'ltt_badge',
      longtermSubtaskId: 'lts_badge_1',
      longtermReportSessionId: 'studio-main',
    });
    const step1 = orchStore.createStep({
      taskId: task1.id,
      ordinal: 1,
      title: '出图',
      objective: '出图',
      acceptanceCriteria: ['1024'],
      assigneeMetabotId: 22,
    });
    const att1 = orchStore.createAttempt({ stepId: step1.id, idempotencyKey: 'k1', workerMetabotId: 22, prompt: 'go' });
    orchStore.updateAttempt(att1.id, 'running', { workerSessionId: 'worker-1' });
    orchStore.updateAttempt(att1.id, 'completed');

    assert.equal(
      cos.onStudioWorkerTerminalState({
        task: task1,
        attempt: orchStore.getAttempt(att1.id),
        workerName: 'Eleven',
        outcome: 'completed',
        notifySummaryText: 'v3 done',
      }),
      true,
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(startedSessions.length, 1);
    const supSid = startedSessions[0].sid;
    assert.equal(sessions.get(supSid).hiddenFromSessionList, true, '[督办] session is hidden from recentSessionPulse');

    // Step 2: [督办] session bounces C-draft back to Eleven (`sourceSessionId = supSid`, `longtermReportSessionId = studio-main`)
    const reworkTask = orchStore.createTask({
      ownerIntent: 'C 稿单稿返修',
      enrichedGoal: 'C 稿单稿返修',
      acceptanceCriteria: ['补齐 CONTRIBUTOR'],
      sourceSessionId: supSid,
      twinMetabotId: 1,
      ownerGlobalMetaId: 'idq1owner',
      longtermTaskId: 'ltt_badge',
      longtermSubtaskId: 'lts_badge_1',
      longtermReportSessionId: 'studio-main',
    });
    const reworkStep = orchStore.createStep({
      taskId: reworkTask.id,
      ordinal: 1,
      title: '返修 C',
      objective: '返修 C',
      acceptanceCriteria: ['CONTRIBUTOR'],
      assigneeMetabotId: 22,
    });
    const reworkAtt = orchStore.createAttempt({ stepId: reworkStep.id, idempotencyKey: 'k2', workerMetabotId: 22, prompt: 'fix C' });
    orchStore.updateAttempt(reworkAtt.id, 'running', { workerSessionId: 'worker-c' });

    // Studio open-worker lookup MUST see the [督办]-dispatched running attempt!
    const studioAttempts = orchStore.listAttemptsForStudioSessions(['studio-main', ...cos.getSupervisionSessionIdsForStudio('studio-main')]);
    assert.ok(studioAttempts.some((a) => a.id === reworkAtt.id), 're-delegation from [督办] stays visible to Studio waiting/badge gates');

    // When rework finishes, onStudioWorkerTerminalState MUST intercept it too (never leak [ORCH-NOTIFY] into studio-main)!
    orchStore.updateAttempt(reworkAtt.id, 'completed');
    const interceptedRework = cos.onStudioWorkerTerminalState({
      task: reworkTask,
      attempt: orchStore.getAttempt(reworkAtt.id),
      workerName: 'Eleven',
      outcome: 'completed',
      notifySummaryText: 'C-r2 done',
    });
    assert.equal(interceptedRework, true, '[督办] rework settlement intercepted silently without [ORCH-NOTIFY] leak');
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('LongTermAdvanceService never injects 6-section 待拍板重申 heartbeat prompts into persistent Studio owner sessions', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const ltStore = new LongTermTaskStore(db, saveDb);
    const sessions = new Map([
      ['studio-main', {
        id: 'studio-main',
        title: 'Studio Main',
        sessionType: 'browser',
        assistantMode: true,
        metabotId: 1,
        status: 'idle',
        messages: [],
      }],
    ]);
    const escalatedInto = [];

    const created = ltStore.createQuickTask({
      title: 'NFT 专辑主视觉设计（本地出图，不上链）',
      goal: 'NFT 专辑主视觉设计（本地出图，不上链）',
      acceptanceCriteria: ['1024x1024 PNG'],
      definitionSessionId: 'studio-main',
      preferredChannel: 'delegate_bot',
    }, 'twin');
    assert.equal(created.ok, true);
    const subId = created.value.subtasks[0].id;
    ltStore.bindSession(subId, 'studio-main', 'system');
    ltStore.waitSubtask(subId, { kind: 'owner', note: '选定一稿' }, 'system');

    const advance = new LongTermAdvanceService({
      store: () => ltStore,
      coworkStore: () => ({
        getSession: (id) => sessions.get(id) ?? null,
        createSession: (title) => {
          const s = { id: `lt-${sessions.size}`, title, sessionType: 'longterm', autoOrigin: 'longterm', messages: [] };
          sessions.set(s.id, s);
          return s;
        },
        setSessionAutoOrigin: () => {},
        updateSession: () => {},
        addMessage: () => ({ id: 'm1' }),
        countSessionMessages: () => 2,
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async (sid) => { escalatedInto.push(sid); },
        continueSession: async (sid) => { escalatedInto.push(sid); },
      }),
      resolveTwinMetabotId: () => 1,
      resolveWorkingDirectory: () => dir,
      getBaseSystemPrompt: () => '',
      isStudioOwnerSession: (sid) => sid === 'studio-main',
      waitingOwnerReminderMs: 0,
      nudgeThrottleMs: 0,
      ownerEngagementWindowMs: 0,
    });

    const report = await advance.run(Date.now() + 7_200_000);
    assert.equal(escalatedInto.length, 0, 'zero heartbeat turns injected into Studio session');
    assert.ok(
      report.skipped.some((s) => s.taskId === created.value.id && /StudioChiefOfStaffService/.test(s.reason)),
      'quick Studio task explicitly deferred to StudioChiefOfStaffService',
    );
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('coworkVolatileDedup suppresses recent-sessions clock jitter, splits experience sub-blocks, and cools down remote-services P2P flicker', () => {
  const state = createVolatileDedupState('dsh:cw-1');

  const pulseT1 = '<recent_sessions>\nheader\n- (2m ago) IDBots://s1 "Task" owner: hi | you: ok\n</recent_sessions>';
  const pulseT2 = '<recent_sessions>\nheader\n- (14m ago) IDBots://s1 "Task" owner: hi | you: ok\n</recent_sessions>';

  const expT1 = [
    '<metabot_self_identity>\nI am Sunny\n</metabot_self_identity>\n<instruction>id</instruction>',
    '<work_reviews>\nreview-1\n</work_reviews>\n<instruction>rev</instruction>',
    '<procedures>\nproc-1\n</procedures>',
  ].join('\n\n');
  const expT2 = [
    '<metabot_self_identity>\nI am Sunny\n</metabot_self_identity>\n<instruction>id</instruction>',
    '<work_reviews>\nreview-1 + review-2\n</work_reviews>\n<instruction>rev</instruction>',
    '<procedures>\nproc-1\n</procedures>',
  ].join('\n\n');

  const firstTurn = applyVolatileDedup(
    [
      { key: 'recent-sessions', text: pulseT1 },
      { key: 'experience', text: expT1 },
      { key: 'remote-services', text: '<available_remote_services>botA</available_remote_services>', minChangeCooldownTurns: 6 },
    ],
    state,
  );
  assert.equal(firstTurn.length, 3);

  const secondTurn = applyVolatileDedup(
    [
      { key: 'recent-sessions', text: pulseT2 },
      { key: 'experience', text: expT2 },
      { key: 'remote-services', text: '<available_remote_services>botA+botB</available_remote_services>', minChangeCooldownTurns: 6 },
    ],
    state,
  );
  assert.equal(secondTurn.length, 1, 'recent-sessions age tick and remote-services P2P flicker both suppressed');
  assert.match(secondTurn[0], /<work_reviews>/, 'changed work_reviews sub-block re-injected');
  assert.doesNotMatch(secondTurn[0], /<metabot_self_identity>|<procedures>/, 'unchanged identity and procedures NOT re-injected');
});
