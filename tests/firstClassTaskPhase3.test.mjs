import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { LongTermAdvanceService } = require('../dist-electron/main/services/longTermAdvanceService.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const {
  computeActiveTaskWatermark,
  formatActiveTasksRadarPromptBlock,
  WorkerLivenessPulseTracker,
} = require('../dist-electron/main/services/taskHeartbeatRadar.js');

async function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-task-p3-'));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const saveDb = sqliteStore.getSaveFunction();
  const taskStore = new LongTermTaskStore(db, saveDb, {
    resolveParticipants: (ids) =>
      ids.map((id) => ({ id, name: id === 15 ? 'Builder阿码' : `Bot-${id}`, avatar: null })),
  });
  const queueStore = new StudioDecisionQueueStore(db, saveDb);
  const dispose = () => {
    try { sqliteStore.close?.(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { dir, sqliteStore, taskStore, queueStore, dispose };
}

test('Phase 3 cross-channel radar + zero-token Worker liveness pulse + 5s SQLite watermark sync', async () => {
  const world = await makeTempStore();
  try {
    let clockMs = Date.parse('2026-11-17T10:00:00.000Z');
    const created = world.taskStore.createUnifiedTask(
      {
        title: 'Multisig Security Audit',
        goal: 'Audit broadcast gates and add regression tests',
        originSessionId: 'studio-sess-1',
        originMessageId: 'msg-1',
        originChannel: 'studio',
      },
      'twin',
    );
    const taskId = created.value.id;
    const subId = created.value.subtasks[0].id;
    world.taskStore.claimSubtaskLease(
      subId,
      { assigneeMetabotId: 15, attemptId: 'att-1', workerSessionId: 'worker-sess-15' },
      'twin',
    );

    // 1. WorkerLivenessPulseTracker throttles zero-token pulses and refreshes lastActivityAt
    const broadcasts = [];
    const tracker = new WorkerLivenessPulseTracker({
      resolveSubtaskIdsForSession: (sid) => (sid === 'worker-sess-15' ? [subId] : []),
      touchSubtask: (id, iso) => world.taskStore.touchSubtaskActivity(id, iso),
      onBroadcast: (ids) => broadcasts.push({ at: clockMs, ids }),
      throttleMs: 5_000,
      now: () => clockMs,
    });

    assert.equal(tracker.observeActivity('worker-sess-15', { toolName: 'read' }), true);
    assert.equal(broadcasts.length, 1);
    clockMs += 1_500;
    assert.equal(
      tracker.observeActivity('worker-sess-15', { toolName: 'read' }),
      false,
      'same tool within 5s throttle emits no redundant write',
    );
    assert.equal(
      tracker.observeActivity('worker-sess-15', { toolName: 'bash' }),
      true,
      'new tool name bypasses throttle immediately',
    );
    assert.equal(broadcasts.length, 2);

    // 2. Chief-of-Staff 5s heartbeat tick detects Worker direct SQLite progress writes & includes checkpoint in reassurance
    const stateChanges = [];
    const studioMessages = [
      { id: 'u1', type: 'user', content: '查一下多签安全', timestamp: clockMs - 6 * 60_000 },
    ];
    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => world.queueStore,
      coworkStore: () => ({
        getSession: (sid) =>
          sid === 'studio-sess-1'
            ? { id: sid, sessionType: 'browser', assistantMode: true, metabotId: 1, messages: studioMessages }
            : null,
        listSessions: () => [
          { id: 'studio-sess-1', title: 'Studio', sessionType: 'browser', assistantMode: true, metabotId: 1, updatedAt: clockMs },
        ],
        createSession: () => ({ id: 'sup-1' }),
        updateSession: () => {},
        addMessage: (_sid, msg) => {
          const added = { id: `m-${studioMessages.length + 1}`, timestamp: clockMs, ...msg };
          studioMessages.push(added);
          return added;
        },
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async () => {},
      }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => world.dir,
      getAppLanguage: () => 'zh',
      listOpenSiblingDelegations: () => [
        {
          attemptId: 'att-1',
          workerMetabotId: 15,
          workerName: 'Builder阿码',
          workerSessionId: 'worker-sess-15',
          longtermTaskId: taskId,
          title: 'Multisig Security Audit',
          status: 'running',
          startedAt: clockMs - 6 * 60_000,
        },
      ],
      getTaskWatermark: () => computeActiveTaskWatermark(world.taskStore.listActiveTasksCompact(20)),
      getTaskProgressNote: (id) => world.taskStore.getTask(id)?.currentProgressNote ?? null,
      onStateChanged: (reason) => stateChanges.push(reason),
      now: () => clockMs,
    });

    // Baseline tick initializes watermark
    await cos.runHeartbeatTick(clockMs - 4 * 60_000);
    // Worker writes progress note directly into SQLite from background process
    world.taskStore.recordSubtaskProgress(
      subId,
      { note: '2/3: 已完成广播门禁排查，正在跑 29 条回归测试' },
      'worker:15',
    );
    // Next 5s tick detects SQLite watermark change AND injects the concrete checkpoint into waiting reassurance!
    const tickRes = await cos.runHeartbeatTick(clockMs);
    assert.equal(tickRes.taskWatermarkChanged, true);
    assert.ok(stateChanges.includes('task_db_updated'), 'HUD refreshed on Worker DB write');
    assert.ok(tickRes.reassuranceMessageId, '5-min waiting reassurance emitted');
    const lastReassurance = studioMessages[studioMessages.length - 1];
    assert.match(lastReassurance.content, /正在跑 29 条回归测试/, 'Reassurance includes Worker live progress checkpoint');

    // 3. Cross-channel radar block carries machine-wide tasks whether read from Studio, Mobile, or Telegram
    const radarFromMobile = formatActiveTasksRadarPromptBlock(
      world.taskStore.listActiveTasksCompact(10),
      { currentSessionId: 'mobile-sess-99' },
    );
    assert.match(radarFromMobile, /<active_tasks_radar count="1">/);
    assert.match(radarFromMobile, /Multisig Security Audit/);
    assert.match(radarFromMobile, /bot=Builder阿码/);
    assert.match(radarFromMobile, /正在跑 29 条回归测试/);
  } finally {
    world.dispose();
  }
});

test('Phase 3 adaptive stall watchdog: dead Worker lease after restart escalates in 15m while live pulsing Worker is not interrupted', async () => {
  const world = await makeTempStore();
  try {
    const startMs = Date.parse('2026-11-17T10:00:00.000Z');
    const created = world.taskStore.createUnifiedTask(
      {
        title: 'Build CLI parser',
        goal: 'Implement and test CLI parser',
        originSessionId: 'botworks-sess-1',
      },
      'twin',
    );
    const taskId = created.value.id;
    const subId = created.value.subtasks[0].id;
    world.taskStore.claimSubtaskLease(
      subId,
      { assigneeMetabotId: 15, attemptId: 'att-crashed', workerSessionId: 'w-dead' },
      'twin',
    );
    // Simulate lease pulse from 20 minutes ago before an app restart
    const twentyMinAgoIso = new Date(startMs - 20 * 60_000).toISOString();
    world.taskStore.touchSubtaskActivity(subId, twentyMinAgoIso);

    let leaseAlive = true;
    const startedPrompts = [];
    const sessions = new Map([
      ['botworks-sess-1', { id: 'botworks-sess-1', metabotId: 1 }],
    ]);

    const advance = new LongTermAdvanceService({
      store: () => world.taskStore,
      coworkStore: () => ({
        createSession: (title) => {
          const id = `lt-sup-${sessions.size + 1}`;
          sessions.set(id, { id, title, metabotId: 1 });
          return { id };
        },
        updateSession: () => {},
        setSessionAutoOrigin: () => {},
        addMessage: () => ({}),
        getSession: (id) => sessions.get(id) ?? null,
      }),
      coworkRunner: () => ({
        startSession: async (_sid, prompt) => {
          startedPrompts.push(prompt);
        },
        isSessionActive: () => false,
      }),
      resolveTwinMetabotId: () => 1,
      resolveWorkingDirectory: () => world.dir,
      getBaseSystemPrompt: () => '',
      deadLeaseStallMinutes: 15,
      isSubtaskLeaseAlive: () => leaseAlive,
      emitLog: () => {},
    });

    // While Worker session is alive (`leaseAlive === true`), 20m is below the 45m standard budget -> no premature nag!
    const resAlive = await advance.run(startMs);
    assert.equal(resAlive.escalated.length, 0);

    // Worker session died / orphaned after restart (`leaseAlive === false`) with 20m silent >= 15m -> immediate supervision!
    leaseAlive = false;
    const resDead = await advance.run(startMs + 1_000);
    assert.equal(resDead.escalated.length, 1);
    assert.match(resDead.escalated[0].reasons[0], /subtask lease att-crashed.*no longer running/);
  } finally {
    world.dispose();
  }
});
