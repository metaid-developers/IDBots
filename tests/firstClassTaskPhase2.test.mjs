import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const { buildLongTermTaskAgentTools } = require('../dist-electron/main/libs/longTermTaskAgentTools.js');

function makeToolHarness(control, sessionId) {
  const tools = new Map();
  const factory = (name, description, schema, handler) => {
    const entry = { name, description, schema, handler };
    tools.set(name, entry);
    return entry;
  };
  buildLongTermTaskAgentTools({ tool: factory, control, sessionId });
  const call = async (name, args = {}) => {
    const entry = tools.get(name);
    assert.ok(entry, `tool ${name} not registered`);
    const res = await entry.handler(args);
    const text = res?.content?.[0]?.text ?? '';
    return {
      isError: Boolean(res?.isError),
      text,
      json: (() => {
        try { return JSON.parse(text); } catch { return null; }
      })(),
    };
  };
  return { tools, call };
}

async function createTestWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-task-p2-'));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const saveDb = sqliteStore.getSaveFunction();
  const coworkStore = new CoworkStore(db, saveDb);
  const orchestrationStore = new OrchestrationStore(db, saveDb);
  const bots = [
    { id: 1, name: 'AI_Sunny', enabled: true, metabot_type: 'twin', boss_global_metaid: 'owner-gmid', skills: [] },
    { id: 15, name: 'Builder阿码', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-gmid', skills: [] },
    { id: 22, name: 'Eleven', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-gmid', skills: [] },
  ];
  const taskStore = new LongTermTaskStore(db, saveDb, {
    resolveParticipants: (ids) =>
      ids.map((id) => {
        const bot = bots.find((b) => b.id === id);
        return { id, name: bot?.name ?? `#${id}`, avatar: null };
      }),
  });
  const dispose = () => {
    try { sqliteStore.close?.(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { dir, sqliteStore, coworkStore, orchestrationStore, taskStore, bots, dispose };
}

test('Phase 2 toolset: task_create captures origin anchors, Worker reads verbatim context & self-submits, Twin unlocks serial DAG & respects owner-ruling gate', async () => {
  const world = await createTestWorld();
  try {
    const studioSession = world.coworkStore.createSession(
      'Studio Daily Conversation',
      world.dir,
      '',
      'local',
      [],
      1,
      'browser',
    );
    world.coworkStore.addMessage(studioSession.id, {
      type: 'user',
      content: '以前无关的闲聊：今天深圳天气真不错。',
    });
    world.coworkStore.addMessage(studioSession.id, {
      type: 'assistant',
      content: '是呀，挺适合出门走走。',
    });
    // Add 6 spacer messages so the old chat is well outside windowTurns=1
    for (let i = 0; i < 6; i += 1) {
      world.coworkStore.addMessage(studioSession.id, {
        type: i % 2 === 0 ? 'user' : 'assistant',
        content: `中间穿插话题 #${i + 1}`,
      });
    }
    const taskWishMsg = world.coworkStore.addMessage(studioSession.id, {
      type: 'user',
      content: '我们要创建一个任务 A：先让阿码审查多签安全代码并补测试，完成后再让 Eleven 根据审查结论出一张信息图。',
    });
    // Synthetic proactive briefing after the human message must NOT hijack originMessageId!
    world.coworkStore.addMessage(studioSession.id, {
      type: 'user',
      content: '<studio_proactive_briefing>\nsynthetic system prompt\n</studio_proactive_briefing>',
    });

    const focusedCalls = [];
    const buildControl = () => ({
      store: () => world.taskStore,
      getAppLanguage: () => 'zh',
      resolveSessionIdentity: (sid) => {
        const s = world.coworkStore.getSession(sid);
        const bot = world.bots.find((b) => b.id === s?.metabotId) ?? world.bots[0];
        const isTwin = bot.metabot_type === 'twin';
        return {
          actor: isTwin ? 'twin' : `worker:${bot.id}`,
          metabotId: bot.id,
          isTwin,
          originChannel: s?.sessionType === 'browser' ? 'studio' : 'botworks',
        };
      },
      resolveLatestUserMessageId: (sid) => world.coworkStore.getLatestHumanMessageId(sid),
      readOriginContextSlice: (params) =>
        world.coworkStore.getMessageContextSlice(params.sessionId, params),
      onTaskCreatedOrFocused: (sid, taskId) => focusedCalls.push({ sid, taskId }),
    });

    const twinTools = makeToolHarness(buildControl(), studioSession.id);

    // 1. Twin creates Task A with 2 serial subtasks (#1 -> #2)
    const createRes = await twinTools.call('task_create', {
      title: '多签安全审查与信息图',
      goal: '完成多签代码资金安全审查修复，并产出配套可视化信息图',
      subtasks: [
        {
          title: '多签代码安全审查与回归测试',
          acceptanceCriteria: ['无未确认广播绕过', '单测全绿'],
          assigneeMetabotId: 15,
        },
        {
          title: '根据审查结论制作信息图',
          dependsOnOrdinals: [1],
          acceptanceCriteria: ['包含全部安全门禁要点'],
          assigneeMetabotId: 22,
        },
      ],
    });
    assert.equal(createRes.isError, false, createRes.text);
    const createdTask = createRes.json;
    assert.equal(createdTask.originSessionId, studioSession.id);
    assert.equal(createdTask.originMessageId, taskWishMsg.id, 'must skip synthetic <studio_proactive_briefing> row');
    assert.equal(focusedCalls.length, 1);
    assert.equal(createdTask.readySubtasks.length, 1);
    assert.equal(createdTask.readySubtasks[0].ordinal, 1);

    const sub1Id = createdTask.subtasks[0].id;
    const sub2Id = createdTask.subtasks[1].id;

    // 2. Worker 阿码 (id=15) mounts tools in its own execution session
    const workerSession = world.coworkStore.createSession(
      'Worker Ama Session',
      world.dir,
      '',
      'local',
      [],
      15,
      'standard',
    );
    const workerTools = makeToolHarness(buildControl(), workerSession.id);

    // Worker cannot create top-level tasks
    const forbiddenCreate = await workerTools.call('task_create', { title: 'rogue' });
    assert.equal(forbiddenCreate.isError, true);
    assert.match(forbiddenCreate.text, /FORBIDDEN/);

    // Worker pulls exact origin conversation context via task_context_read (windowTurns=1)
    const ctxRes = await workerTools.call('task_context_read', {
      taskId: createdTask.id,
      subtaskId: sub1Id,
      windowTurns: 1,
    });
    assert.equal(ctxRes.isError, false);
    assert.ok(
      ctxRes.json.messages.some((m) => m.id === taskWishMsg.id && m.content.includes('创建一个任务 A')),
      'Worker receives verbatim origin user message',
    );
    assert.ok(
      !ctxRes.json.messages.some((m) => m.content.includes('深圳天气')),
      'Unrelated earlier chat stays outside the bounded context window',
    );
    assert.ok(
      !ctxRes.json.messages.some((m) => m.content.includes('studio_proactive_briefing')),
      'Synthetic internal triggers are stripped',
    );

    // Worker records live milestone progress & submits structured artifacts/evidence onto Task blackboard
    const progRes = await workerTools.call('task_subtask_progress', {
      subtaskId: sub1Id,
      note: '已完成广播门禁审计，正在跑 29 条测试',
    });
    assert.equal(progRes.isError, false);

    const submitRes = await workerTools.call('task_subtask_submit', {
      subtaskId: sub1Id,
      outcome: 'ready_for_review',
      summary: '修复 2 处门禁绕过，29/29 测试通过',
      artifacts: [
        { kind: 'dir', uri: '/Users/tusm/idbots/.worktrees/sec-multisig', label: 'fix branch' },
      ],
      evidence: [
        { kind: 'dir', uri: '/Users/tusm/idbots/.worktrees/sec-multisig', note: '29/29 tests green' },
      ],
    });
    assert.equal(submitRes.isError, false, submitRes.text);

    // 3. Twin checks active radar + accepts intermediate Subtask #1 -> automatically unlocks & begins serial Subtask #2!
    const radar = await twinTools.call('task_list_active', {});
    assert.equal(radar.json.count, 1);
    assert.match(radar.json.tasks[0].progressNote, /29\/29/);

    const acceptSub1 = await twinTools.call('task_subtask_accept', {
      subtaskId: sub1Id,
      note: 'Verified 29/29 tests first-hand',
    });
    assert.equal(acceptSub1.isError, false, acceptSub1.text);
    assert.equal(acceptSub1.json.unlockedSubtasks.length, 1);
    assert.equal(acceptSub1.json.unlockedSubtasks[0].subtaskId, sub2Id);
    assert.equal(acceptSub1.json.unlockedSubtasks[0].assigneeMetabotId, 22);
    assert.equal(world.taskStore.getSubtask(sub2Id).status, 'in_progress');

    // 4. Owner Ruling #3 Gate: Twin CANNOT silently close the FINAL subtask (#2) without owner sign-off!
    const prematureClose = await twinTools.call('task_subtask_accept', {
      subtaskId: sub2Id,
      note: 'trying to close behind owner back',
    });
    assert.equal(prematureClose.isError, true);
    assert.match(prematureClose.text, /OWNER_RULING_REQUIRED/);
    assert.equal(world.taskStore.getTask(createdTask.id).stage, 'active', 'task must NOT close prematurely');

    // Twin proposes #2 to owner -> moves task to waiting_owner (等你拍板)
    const propSub2 = await twinTools.call('task_subtask_propose', {
      subtaskId: sub2Id,
      evidence: [{ kind: 'dir', uri: '/Users/tusm/idbots/project/multisig-infographic', note: '3 PNGs ready' }],
      summary: '信息图已生成，请审阅验收',
    });
    assert.equal(propSub2.isError, false, propSub2.text);
    assert.equal(world.taskStore.getTask(createdTask.id).column, 'waiting_owner');

    // Once owner approves in chat, Twin passes ownerApprovedInChat: true -> closes cleanly to done!
    const finalClose = await twinTools.call('task_subtask_accept', {
      subtaskId: sub2Id,
      note: 'Owner approved in Studio chat',
      ownerApprovedInChat: true,
    });
    assert.equal(finalClose.isError, false, finalClose.text);
    assert.equal(world.taskStore.getTask(createdTask.id).stage, 'done');

    // 5. task_search finds the archived task immediately by keyword
    const searchRes = await twinTools.call('task_search', { query: '多签 信息图' });
    assert.equal(searchRes.json.count, 1);
    assert.equal(searchRes.json.tasks[0].id, createdTask.id);
  } finally {
    world.dispose();
  }
});

test('Phase 2 orchestration guards: blocks cross-session G1 duplicate-subtask lease collision AND prevents Studio second-Worker quick-card hijack', async () => {
  const world = await createTestWorld();
  try {
    let releaseFirstWorker;
    const firstWorkerGate = new Promise((resolve) => {
      releaseFirstWorker = resolve;
    });

    const directory = {
      getSession: (id) => ({ id, metabotId: 1 }),
      listMetabots: () => world.bots,
      getOwnerGlobalMetaId: () => 'owner-gmid',
    };

    const service = new TwinOrchestrationService({
      orchestrationStore: world.orchestrationStore,
      coworkStore: world.coworkStore,
      coworkRunner: { stopSession: () => {} },
      directory,
      getMetabotById: (id) => world.bots.find((b) => b.id === id) ?? null,
      getWorkerWorkspace: (id) => path.join(world.dir, `worker-${id}`),
      longTermTaskStore: () => world.taskStore,
      isStudioSourceSession: (sid) => sid.startsWith('studio-'),
      runWorkerTurn: async (params) => {
        params.onSessionCreated?.(`w-sess-${params.metabotId}`);
        await firstWorkerGate;
        return 'Completed.\n<worker_handoff>{"state":"ready","summary":"all green","deliverables":["/tmp/out.md"],"verificationEvidence":["checked"],"blockers":[],"humanAction":null}</worker_handoff>';
      },
    });

    // A) Cross-session G1 collision test: mainline session dispatches subtask S-G1 to Worker #15
    const project = world.taskStore.createUnifiedTask(
      {
        title: 'Commercialization Mainline',
        goal: 'Ship G1',
        subtasks: [{ title: 'G1 Payment Card Emitter' }],
      },
      'twin',
    );
    const g1TaskId = project.value.id;
    const g1SubId = project.value.subtasks[0].id;

    await service.delegateLocalWorker('mainline-lt-sess', {
      workerMetabotId: 15,
      objective: 'Implement G1 on mainline',
      longtermTaskId: g1TaskId,
      longtermSubtaskId: g1SubId,
    });

    // Now a SECOND session ('studio-sess-1') tries to dispatch the SAME subtask S-G1 concurrently -> REFUSED!
    await assert.rejects(
      () =>
        service.delegateLocalWorker('studio-sess-1', {
          workerMetabotId: 15,
          objective: 'Duplicate G1 dispatch from Studio',
          longtermTaskId: g1TaskId,
          longtermSubtaskId: g1SubId,
        }),
      /SUBTASK_ALREADY_LEASED/,
    );

    // B) Studio quick-card hijack protection: Worker #15 gets auto-quick-card Q1;
    // then Twin accidentally passes Q1's longtermTaskId while delegating to Eleven (#22)!
    const d1 = await service.delegateLocalWorker('studio-sess-1', {
      workerMetabotId: 15,
      taskIntent: 'Publish multisig skill',
      objective: 'Publish skill and tutorial',
    });
    const q1TaskId = d1.task.longtermTaskId;
    assert.ok(q1TaskId);

    const d2 = await service.delegateLocalWorker('studio-sess-1', {
      workerMetabotId: 22,
      taskIntent: 'Generate 3 multisig cover images',
      objective: 'Create 3 cover candidates',
      longtermTaskId: q1TaskId, // accidental reuse of Worker #15's quick card!
    });
    assert.notEqual(
      d2.task.longtermTaskId,
      q1TaskId,
      'Eleven delegation must get its own independent parallel task card instead of hijacking Ama quick card',
    );

    // Release workers and verify auto-backfill onto Subtask blackboard
    releaseFirstWorker();
    await new Promise((r) => setTimeout(r, 40));
    const settledSub = world.taskStore.getSubtask(g1SubId);
    assert.equal(settledSub.leaseAttemptId, null, 'lease released after settlement');
    assert.equal(settledSub.submission?.outcome, 'ready_for_review');
    assert.equal(settledSub.submission?.artifacts[0]?.uri, '/tmp/out.md');
  } finally {
    world.dispose();
  }
});
