/**
 * Dream-RSI exploration P0, commit 2 (design 2026-10-10 §3.4/§3.5/§6):
 * the practice-task approval + materialization pipeline, the practice
 * execution-mode tool policy, the dream-side outcome consumption, and the
 * practice telemetry fields.
 *
 * Covers:
 *   1. policy flags — practiceTasksEnabled defaults off, practiceAutoApprove
 *      ReadOnly defaults on, per-bot set/get round-trip,
 *   2. practiceInteractionGuard — read tools free, read_only denies every
 *      side effect, interact_local counts to its budget, the per-run
 *      iteration cap, chain_write degrades to the read_only posture,
 *   3. materialization — auto-approve is read_only-only, the ScheduledTask
 *      carries the report footer + night-window 'at' schedule,
 *   4. scheduler — practice runs start with the practice session marker +
 *      memoryReadOnly + wall-clock watchdog; run completion writes
 *      completed/failed back onto the proposal; ordinary tasks untouched,
 *   5. dream consumption — the prompt's practice-outcomes section renders
 *      and truncates, outcome_summary backfills from the session's final
 *      assistant message, telemetry fields land.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  PRACTICE_MAX_TOOL_CALLS_PER_RUN,
  PRACTICE_RUN_WATCHDOG_MS,
  PRACTICE_INTERACT_LOCAL_SIDE_EFFECT_BUDGET,
  PRACTICE_READ_ONLY_INLINE_TOOLS,
  PRACTICE_INTERACT_LOCAL_INLINE_TOOLS,
  createPracticeSessionState,
  evaluatePracticeToolCall,
  buildPracticeRunPrompt,
  computePracticeRunAtMs,
} = require('../dist-electron/main/libs/practiceInteractionGuard.js');
const { buildDreamPrompt } = require('../dist-electron/main/libs/dreamPrompt.js');

function loadModuleWithElectronStub(relative) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(relative);
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadModuleWithElectronStub('../dist-electron/main/services/dreamService.js');
const { DreamStore } = loadModuleWithElectronStub('../dist-electron/main/dreamStore.js');

const DAY = '2026-08-02';
const DAY_START = new Date(2026, 7, 2).getTime();
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const insertMetabot = (db, id) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `pk-${id}`, `chatpk-${id}`, `bot-${id}`, `metaid-${id}`],
  );
};

const seedActivity = (coworkStore, db) => {
  const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m1', session.id, 'user', '视频做好了吗', '{}', DAY_START + 1000, 1]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m2', session.id, 'assistant', '做好了,你看下', '{}', DAY_START + 2000, 2]
  );
  return session;
};

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const makePayload = (practiceProposals) => JSON.stringify({
  daily_summary: '今天复盘了自己的薄弱点。',
  sections: {},
  work_reviews: [],
  important_memories: [],
  value_lessons: [],
  self_identity: LONG_IDENTITY,
  ...(practiceProposals !== undefined ? { practice_proposals: practiceProposals } : {}),
});

// ---------------------------------------------------------------------------
// Policy flags
// ---------------------------------------------------------------------------

test('practice policy flags default off/auto-approve-on and round-trip per bot', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    insertMetabot(db, 5);
    // Defaults: feature off, auto-approve on (only effective with the feature).
    const globalPolicy = coworkStore.getEffectiveMemoryPolicyForMetabot(null);
    assert.equal(globalPolicy.practiceTasksEnabled, false);
    assert.equal(globalPolicy.practiceAutoApproveReadOnly, true);
    const botDefault = coworkStore.getEffectiveMemoryPolicyForMetabot(5);
    assert.equal(botDefault.practiceTasksEnabled, false);
    assert.equal(botDefault.practiceAutoApproveReadOnly, true);

    const updated = coworkStore.setMemoryPolicyForMetabot(5, { practiceTasksEnabled: true });
    assert.equal(updated.practiceTasksEnabled, true);
    assert.equal(updated.practiceAutoApproveReadOnly, true, 'auto-approve default survives an unrelated update');
    const readBack = coworkStore.getEffectiveMemoryPolicyForMetabot(5);
    assert.equal(readBack.practiceTasksEnabled, true);
    assert.equal(readBack.practiceAutoApproveReadOnly, true);

    coworkStore.setMemoryPolicyForMetabot(5, { practiceAutoApproveReadOnly: false });
    assert.equal(coworkStore.getEffectiveMemoryPolicyForMetabot(5).practiceAutoApproveReadOnly, false);
    assert.equal(coworkStore.getEffectiveMemoryPolicyForMetabot(5).practiceTasksEnabled, true, 'feature flag untouched');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// practiceInteractionGuard
// ---------------------------------------------------------------------------

test('guard: read_only practice denies every side effect, reads stay free', () => {
  const state = createPracticeSessionState('read_only');
  assert.equal(state.sideEffectBudget, 0);

  assert.deepEqual(evaluatePracticeToolCall(state, 'read', { kernelReadOnly: true }), { allow: true, countedSideEffect: false });
  assert.deepEqual(evaluatePracticeToolCall(state, 'search_metaweb', { kernelReadOnly: false }), { allow: true, countedSideEffect: false });
  assert.equal(state.sideEffectsUsed, 0);

  for (const tool of ['bash', 'write', 'edit', 'post_buzz', 'wallet_transfer']) {
    const verdict = evaluatePracticeToolCall(state, tool, { kernelReadOnly: false });
    assert.equal(verdict.allow, false, `${tool} denied`);
    assert.match(verdict.reason, /side effect/);
  }
  assert.equal(state.sideEffectsUsed, 0, 'denied calls never consume a budget that is 0');
});

test('guard: interact_local counts side effects up to its budget', () => {
  const state = createPracticeSessionState('interact_local');
  assert.equal(state.sideEffectBudget, PRACTICE_INTERACT_LOCAL_SIDE_EFFECT_BUDGET);

  for (let i = 0; i < PRACTICE_INTERACT_LOCAL_SIDE_EFFECT_BUDGET; i += 1) {
    const verdict = evaluatePracticeToolCall(state, 'write', { kernelReadOnly: false });
    assert.deepEqual(verdict, { allow: true, countedSideEffect: true }, `side effect ${i + 1} allowed`);
  }
  assert.equal(state.sideEffectsUsed, PRACTICE_INTERACT_LOCAL_SIDE_EFFECT_BUDGET);
  const over = evaluatePracticeToolCall(state, 'write', { kernelReadOnly: false });
  assert.equal(over.allow, false);
  assert.match(over.reason, /budget exhausted/);
  // Reads never touch the side-effect budget.
  const read = evaluatePracticeToolCall(state, 'omni_read', { kernelReadOnly: false });
  assert.equal(read.allow, true);
  assert.equal(state.sideEffectsUsed, PRACTICE_INTERACT_LOCAL_SIDE_EFFECT_BUDGET);
});

test('guard: the per-run iteration cap denies every call past it (even reads)', () => {
  const state = createPracticeSessionState('read_only');
  for (let i = 0; i < PRACTICE_MAX_TOOL_CALLS_PER_RUN; i += 1) {
    assert.equal(evaluatePracticeToolCall(state, 'read', { kernelReadOnly: true }).allow, true);
  }
  const over = evaluatePracticeToolCall(state, 'read', { kernelReadOnly: true });
  assert.equal(over.allow, false);
  assert.match(over.reason, /iteration budget exhausted/);
});

test('guard: chain_write never executes this iteration (read_only posture)', () => {
  const state = createPracticeSessionState('chain_write');
  assert.equal(state.sideEffectBudget, 0);
  assert.equal(evaluatePracticeToolCall(state, 'post_buzz', { kernelReadOnly: false }).allow, false);
});

test('allowlists: no wallet/chain-write/scheduled-task tools; interact_local adds local writes', () => {
  for (const banned of ['wallet_transfer', 'wallet_balance', 'post_buzz', 'post_simplenote', 'omni_cast', 'like_pin', 'comment_pin', 'create_scheduled_task', 'upload_file', 'send_private_chat', 'group_chat', 'metatask_claim']) {
    assert.equal(PRACTICE_READ_ONLY_INLINE_TOOLS.has(banned), false, `${banned} not in read_only`);
    assert.equal(PRACTICE_INTERACT_LOCAL_INLINE_TOOLS.has(banned), false, `${banned} not in interact_local`);
  }
  for (const allowed of ['search_metaweb', 'read_metaweb_pin', 'omni_read', 'chain_history_recall', 'experience_recall', 'knowledge_recall', 'procedure_recall', 'conversation_recall']) {
    assert.ok(PRACTICE_READ_ONLY_INLINE_TOOLS.has(allowed), `${allowed} in read_only`);
  }
  for (const write of ['knowledge_base_add_document', 'knowledge_base_learn', 'knowledge_upsert', 'procedure_save']) {
    assert.equal(PRACTICE_READ_ONLY_INLINE_TOOLS.has(write), false, `${write} not in read_only`);
    assert.ok(PRACTICE_INTERACT_LOCAL_INLINE_TOOLS.has(write), `${write} in interact_local`);
  }
});

test('buildPracticeRunPrompt appends the structured report footer with target refs', () => {
  const prompt = buildPracticeRunPrompt({
    prompt: '对比两种检索策略的漏检率。',
    targetRefs: ['draft:42', 'date:2026-08-01'],
  });
  assert.ok(prompt.startsWith('对比两种检索策略的漏检率。'));
  assert.match(prompt, /Practice run contract \(host-injected\)/);
  assert.match(prompt, /"outcome": "success \| partial \| failed"/);
  assert.match(prompt, /"evidence_observed"/);
  assert.ok(prompt.includes('"draft:42", "date:2026-08-01"'), 'the cited refs become the report keys');
});

test('computePracticeRunAtMs lands inside the 00:00-06:00 window with jitter', () => {
  // 02:00 local: fires later the same night.
  const earlyNight = new Date(2026, 7, 3, 2, 0, 0).getTime();
  const sameNight = computePracticeRunAtMs({ nowMs: earlyNight, metabotId: 5, proposalId: 7 });
  assert.ok(sameNight >= earlyNight + 5 * 60_000, 'at least the pipeline settle delay');
  assert.ok(sameNight < new Date(2026, 7, 3, 6, 0, 0).getTime(), 'inside tonight\'s window');

  // 05:58 local: the window is over, so it moves to the next window's start + jitter.
  const lateNight = new Date(2026, 7, 3, 5, 58, 0).getTime();
  const nextNight = computePracticeRunAtMs({ nowMs: lateNight, metabotId: 5, proposalId: 7 });
  const nextWindowStart = new Date(2026, 7, 4, 0, 0, 0).getTime();
  assert.ok(nextNight >= nextWindowStart, 'next window');
  assert.ok(nextNight < nextWindowStart + 30 * 60_000, 'only the jitter past midnight');

  // 23:00 local (outside any window): also lands in the next window.
  const evening = new Date(2026, 7, 3, 23, 0, 0).getTime();
  const fromEvening = computePracticeRunAtMs({ nowMs: evening, metabotId: 5, proposalId: 7 });
  assert.ok(fromEvening >= nextWindowStart);
  assert.ok(fromEvening < nextWindowStart + 30 * 60_000);

  // Deterministic per (bot, proposal).
  assert.equal(
    computePracticeRunAtMs({ nowMs: earlyNight, metabotId: 5, proposalId: 7 }),
    sameNight,
  );
});

// ---------------------------------------------------------------------------
// Dream prompt: practice-outcomes section
// ---------------------------------------------------------------------------

test('buildDreamPrompt renders the practice-outcomes section with truncation', () => {
  const baseActivity = { sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] };
  const without = buildDreamPrompt({ botName: '小火', date: DAY, activity: baseActivity });
  assert.ok(!without.user.includes('针对性练习结果'), 'no outcomes → no section');

  const longSummary = '练习报告正文。' + '细'.repeat(3000);
  const withOutcomes = buildDreamPrompt({
    botName: '小火',
    date: DAY,
    activity: baseActivity,
    practiceOutcomes: [
      {
        title: '对比实验:两种检索策略',
        status: 'completed',
        expectedEvidence: '两种策略的召回差异',
        outcomeSummary: longSummary,
      },
      { title: '压力变体:弱网交付', status: 'failed', expectedEvidence: null, outcomeSummary: null },
    ],
  });
  assert.ok(withOutcomes.user.includes('## 当天执行的针对性练习结果'));
  assert.ok(withOutcomes.user.includes('【已完成】对比实验:两种检索策略'));
  assert.ok(withOutcomes.user.includes('期望证据:两种策略的召回差异'));
  assert.ok(withOutcomes.user.includes('【失败】压力变体:弱网交付'));
  assert.ok(withOutcomes.user.includes('(练习会话没有留下可读报告)'));
  const resultLine = withOutcomes.user.split('\n').find((line) => line.startsWith('  结果:练习报告正文'));
  assert.ok(resultLine, 'outcome line rendered');
  assert.ok(resultLine.length <= 1510, 'outcome summary capped at ~1500 chars');

  // Fragment mode never carries the section.
  const fragment = buildDreamPrompt({
    botName: '小火',
    date: DAY,
    activity: baseActivity,
    sourceMode: 'fragment',
    practiceOutcomes: [{ title: 't', status: 'completed', expectedEvidence: null, outcomeSummary: 'x' }],
  });
  assert.ok(!fragment.user.includes('针对性练习结果'), 'fragment prompt stays lean');
});

// ---------------------------------------------------------------------------
// Dream pipeline: materialization (policy-gated)
// ---------------------------------------------------------------------------

test('feature OFF (default): proposals are dropped (never persisted), prompt omits the ask, telemetry zeroed', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  insertMetabot(db, 5);
  const createdTasks = [];
  const prompts = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    createPracticeScheduledTask: (input) => {
      createdTasks.push(input);
      return { id: `task-${createdTasks.length}` };
    },
    performChat: async (system, user) => {
      prompts.push(user);
      return makePayload([
        { title: '只读练习', prompt: 'p', target_refs: ['draft:1'], risk_class: 'read_only' },
        { title: '本地练习', prompt: 'p', target_refs: ['draft:2'], risk_class: 'interact_local' },
      ]);
    },
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(createdTasks.length, 0, 'feature off: nothing materializes');
    assert.equal(coworkStore.listDreamPracticeProposals(5).length, 0, 'feature off: proposals are not persisted');
    assert.ok(
      !prompts.some((user) => user.includes('"practice_proposals"')),
      'feature off: the dream prompt does not ask for practice_proposals',
    );
    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.deepEqual(telemetry.practiceRuns, { completed: 0, failed: 0 });
    assert.equal(telemetry.practiceProposals.proposed, 2, 'funnel still counts what the model returned');
    assert.equal(telemetry.practiceProposals.autoApproved, 0);
    assert.equal(telemetry.practiceProposals.pendingOwner, 0, 'nothing lands in the pending backlog');
    assert.equal(telemetry.practiceProposals.rejected, 0);
    assert.equal(telemetry.practiceProposals.expired, 0);
  } finally {
    cleanup();
  }
});

test('feature ON: read_only auto-approves and materializes; interact_local/chain_write wait for the owner', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  insertMetabot(db, 5);
  coworkStore.setMemoryPolicyForMetabot(5, { practiceTasksEnabled: true });
  // A chain_write proposal from an earlier night sits in the pending backlog;
  // it must never be auto-approved (owner decision §8.4).
  coworkStore.insertDreamPracticeProposals(5, '2026-08-01', [
    { title: '写链练习', prompt: 'p', targetRefs: ['draft:8'], riskClass: 'chain_write' },
  ]);

  const createdTasks = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    createPracticeScheduledTask: (input) => {
      createdTasks.push(input);
      return { id: `task-${createdTasks.length}` };
    },
    performChat: async () => makePayload([
      {
        title: '对比实验:发布前自检清单',
        prompt: '用两种自检清单各交付一次。',
        rationale: 'draft:42 记录过漏检',
        target_refs: ['draft:42'],
        expected_evidence: '漏检条目数差异',
        risk_class: 'read_only',
      },
      { title: '本地写练习', prompt: 'p', target_refs: ['draft:7'], risk_class: 'interact_local' },
    ]),
  });
  try {
    await service.runNow(5, DAY);

    assert.equal(createdTasks.length, 1, 'only the read_only proposal materializes');
    const created = createdTasks[0];
    assert.equal(created.metabotId, 5);
    assert.equal(created.name, '[Practice] 对比实验:发布前自检清单');
    assert.equal(created.description, 'draft:42 记录过漏检');
    assert.ok(created.prompt.includes('用两种自检清单各交付一次。'));
    assert.ok(created.prompt.includes('Practice run contract (host-injected)'), 'the report footer rides along');
    assert.ok(created.prompt.includes('"draft:42"'), 'footer keys name the target refs');
    assert.ok(Number.isFinite(created.scheduleAtMs) && created.scheduleAtMs > Date.now() - 60_000);

    const byTitle = (title) => coworkStore.listDreamPracticeProposals(5).find((row) => row.title === title);
    const materialized = byTitle('对比实验:发布前自检清单');
    assert.equal(materialized.status, 'scheduled');
    assert.equal(materialized.scheduledTaskId, 'task-1');
    assert.equal(byTitle('本地写练习').status, 'pending', 'interact_local waits for the owner');
    assert.equal(byTitle('写链练习').status, 'pending', 'chain_write never auto-executes');

    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.equal(telemetry.practiceProposals.proposed, 2);
    assert.equal(telemetry.practiceProposals.autoApproved, 1);
    assert.equal(telemetry.practiceProposals.pendingOwner, 2);
  } finally {
    cleanup();
  }
});

test('auto-approve disabled: the pipeline counts as disabled, proposals are dropped and the prompt omits the ask', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  insertMetabot(db, 5);
  coworkStore.setMemoryPolicyForMetabot(5, { practiceTasksEnabled: true, practiceAutoApproveReadOnly: false });

  const createdTasks = [];
  const prompts = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    createPracticeScheduledTask: (input) => {
      createdTasks.push(input);
      return { id: `task-${createdTasks.length}` };
    },
    performChat: async (system, user) => {
      prompts.push(user);
      return makePayload([
        { title: '只读练习', prompt: 'p', target_refs: ['draft:1'], risk_class: 'read_only' },
      ]);
    },
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(createdTasks.length, 0);
    assert.equal(coworkStore.listDreamPracticeProposals(5).length, 0, 'pipeline disabled: nothing persists');
    assert.ok(
      !prompts.some((user) => user.includes('"practice_proposals"')),
      'pipeline disabled: the dream prompt does not ask for practice_proposals',
    );
    assert.equal(dreamStore.getRun(5, DAY).telemetry.practiceProposals.autoApproved, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Dream pipeline: outcome consumption + backfill
// ---------------------------------------------------------------------------

test('dream consumes the day\'s practice runs and backfills outcome_summary from the session report', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  insertMetabot(db, 5);

  // A completed practice run whose started_at falls inside the dreamed day.
  coworkStore.insertDreamPracticeProposals(5, '2026-08-01', [{
    title: '对比实验:两轮记忆检索',
    prompt: 'p',
    targetRefs: ['draft:12'],
    expectedEvidence: '两种检索策略的召回差异',
    riskClass: 'read_only',
  }]);
  const proposal = coworkStore.listDreamPracticeProposals(5)[0];
  coworkStore.approveDreamPracticeProposal({ id: proposal.id, metabotId: 5 });
  coworkStore.markDreamPracticeProposalScheduled({ id: proposal.id, metabotId: 5, scheduledTaskId: 'task-p1' });
  coworkStore.markDreamPracticeProposalCompleted({ id: proposal.id, metabotId: 5, runId: 'run-p1' });

  const practiceSession = coworkStore.createSession('[定时] [Practice] 对比实验', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['pm1', practiceSession.id, 'assistant', '{"outcome":"success","evidence_observed":"策略B漏检率更低"}', '{}', DAY_START + 80000, 1],
  );
  db.run(
    `INSERT INTO scheduled_tasks (id, name, description, enabled, schedule_json, prompt, working_directory, system_prompt, execution_mode, metabot_id, notify_platforms_json, consecutive_errors, created_at, updated_at)
     VALUES ('task-p1', '[Practice] 对比实验', '', 0, '{"type":"at"}', 'p', '/tmp/a', '', 'local', 5, '[]', 0, '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z')`,
  );
  db.run(
    `INSERT INTO scheduled_task_runs (id, task_id, session_id, status, started_at, finished_at, duration_ms, error, trigger_type)
     VALUES ('run-p1', 'task-p1', ?, 'success', ?, ?, 1000, NULL, 'scheduled')`,
    [practiceSession.id, new Date(DAY_START + 60000).toISOString(), new Date(DAY_START + 61000).toISOString()],
  );

  const prompts = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    performChat: async (system, user) => {
      prompts.push({ system, user });
      return makePayload(undefined);
    },
  });
  try {
    await service.runNow(5, DAY);

    // outcome_summary backfilled from the practice session's final assistant message.
    const after = coworkStore.listDreamPracticeProposals(5)[0];
    assert.equal(after.outcomeSummary, '{"outcome":"success","evidence_observed":"策略B漏检率更低"}');

    // The dream prompt carried the outcomes section.
    const dreamCall = prompts.find((call) => call.user.includes('针对性练习结果'));
    assert.ok(dreamCall, 'practice outcomes section rendered into the dream prompt');
    assert.ok(dreamCall.user.includes('【已完成】对比实验:两轮记忆检索'));
    assert.ok(dreamCall.user.includes('期望证据:两种检索策略的召回差异'));
    assert.ok(dreamCall.user.includes('策略B漏检率更低'));

    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.deepEqual(telemetry.practiceRuns, { completed: 1, failed: 0 });

    // The backfill is first-writer-wins: a second dream keeps the stored summary.
    db.run('UPDATE dream_practice_proposals SET outcome_summary = ? WHERE id = ?', ['手工修正的结论', proposal.id]);
    assert.equal(
      coworkStore.updateDreamPracticeProposalOutcome({ id: proposal.id, metabotId: 5, outcomeSummary: '覆盖?' }),
      false,
      'existing outcome_summary is never overwritten',
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scheduler: practice run session options + outcome writeback
// ---------------------------------------------------------------------------

function loadSchedulerWithElectronStub() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, ...rest) {
    if (request === 'electron') {
      return { BrowserWindow: { getAllWindows: () => [] } };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const schedulerPath = require.resolve('../dist-electron/main/libs/scheduler.js');
    delete require.cache[schedulerPath];
    return require(schedulerPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createSchedulerHarness({ proposal, practiceRunWatchdogMs, startSessionError } = {}) {
  const { Scheduler } = loadSchedulerWithElectronStub();
  const recording = {
    runnerCalls: [],
    stopCalls: [],
    completedRuns: [],
    completedProposals: [],
    failedProposals: [],
  };
  const runs = new Map();
  let runIndex = 0;
  // When set, startSession settles only when stopSession fires it (watchdog test).
  let settleStartSession = null;
  const task = {
    id: 'task-p1',
    name: '[Practice] 练习',
    description: '',
    enabled: true,
    schedule: { type: 'at', datetime: new Date(Date.now() + 60_000).toISOString() },
    prompt: '练习指令',
    workingDirectory: '/tmp',
    systemPrompt: '',
    executionMode: 'local',
    metabotId: 5,
    coworkSessionId: null,
    targetSessionId: null,
    expiresAt: null,
    notifyPlatforms: [],
    state: {
      nextRunAtMs: Date.now(),
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runningAtMs: null,
      consecutiveErrors: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const scheduler = new Scheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => null,
      getDueTasks: () => [],
      getRunningTasks: () => [],
      getTask: () => task,
      createRun: (taskId, trigger) => {
        const run = {
          id: `run-${++runIndex}`,
          taskId,
          sessionId: null,
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          durationMs: null,
          error: null,
          trigger,
        };
        runs.set(run.id, run);
        return run;
      },
      markTaskRunning: () => {},
      recordSkippedRun: (taskId, reason, trigger) => ({
        id: 'skip-1', taskId, sessionId: null, status: 'skipped',
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        durationMs: 0, error: null, trigger, skipReason: reason,
      }),
      releaseStuckRunningTask: () => {},
      completeRun: (runId, status, sessionId, durationMs, error) => {
        const completed = { ...runs.get(runId), status, sessionId, durationMs, error };
        runs.set(runId, completed);
        recording.completedRuns.push(completed);
        return completed;
      },
      markTaskCompleted: () => {},
      toggleTask: () => {},
      pruneRuns: () => {},
      getRun: (runId) => runs.get(runId) ?? null,
      getTaskSessionId: () => null,
      setTaskSessionId: () => {},
    },
    coworkStore: {
      getConfig: () => ({ workingDirectory: '/tmp', systemPrompt: '', executionMode: 'local' }),
      createSession: () => ({ id: 'session-p1' }),
      getSessionWithoutMessages: () => null,
      isSessionArchived: () => false,
      setSessionAutoOrigin: () => {},
      updateSession: () => {},
      addMessage: () => {},
      getDreamPracticeProposalByScheduledTaskId: () => proposal ?? null,
      markDreamPracticeProposalCompleted: (input) => {
        recording.completedProposals.push(input);
        return true;
      },
      markDreamPracticeProposalFailed: (input) => {
        recording.failedProposals.push(input);
        return true;
      },
    },
    getCoworkRunner: () => ({
      startSession: async (sessionId, prompt, options) => {
        recording.runnerCalls.push({ sessionId, prompt, options });
        if (startSessionError) throw startSessionError;
        if (practiceRunWatchdogMs !== undefined) {
          // Watchdog test: the session "runs" until the watchdog stops it.
          await new Promise((resolve) => {
            settleStartSession = resolve;
          });
        }
      },
      stopSession: (sessionId, options) => {
        recording.stopCalls.push({ sessionId, options });
        settleStartSession?.();
      },
    }),
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
    ...(practiceRunWatchdogMs !== undefined ? { practiceRunWatchdogMs } : {}),
  });
  return { scheduler, recording, task };
}

test('scheduler starts a practice run with the practice marker and writes back completion', async () => {
  const proposal = { id: 42, metabotId: 5, status: 'scheduled', riskClass: 'read_only' };
  const { scheduler, recording, task } = createSchedulerHarness({ proposal });
  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.runnerCalls.length, 1);
  const options = recording.runnerCalls[0].options;
  assert.equal(options.memoryReadOnly, true, 'practice runs read memory but never write it');
  assert.equal(options.autoApprove, true, 'unattended night run');
  assert.equal(options.disableMemoryUpdates, undefined, 'not the full blackout');
  assert.ok(options.practiceSession, 'practice session marker present');
  assert.equal(options.practiceSession.riskClass, 'read_only');
  assert.equal(options.practiceSession.sideEffectBudget, 0);
  assert.equal(options.confirmationMode, 'text');

  assert.deepEqual(
    recording.completedProposals,
    [{ id: 42, metabotId: 5, runId: 'run-1' }],
    'run completion writes back onto the proposal with the run id',
  );
  assert.equal(recording.failedProposals.length, 0);
  assert.equal(recording.completedRuns[0].status, 'success');
});

test('scheduler writes back failure (with the error) and never touches ordinary tasks', async () => {
  const proposal = { id: 42, metabotId: 5, status: 'scheduled', riskClass: 'interact_local' };
  const failing = createSchedulerHarness({ proposal, startSessionError: new Error('LLM exploded') });
  await failing.scheduler.executeTask(failing.task, 'manual');
  assert.equal(failing.recording.failedProposals.length, 1);
  assert.equal(failing.recording.failedProposals[0].id, 42);
  assert.equal(failing.recording.failedProposals[0].runId, 'run-1');
  assert.equal(failing.recording.failedProposals[0].outcomeSummary, 'LLM exploded');
  assert.equal(failing.recording.runnerCalls[0].options.practiceSession.sideEffectBudget, PRACTICE_INTERACT_LOCAL_SIDE_EFFECT_BUDGET);

  // Ordinary task: no proposal linkage → the legacy options, no writeback.
  const plain = createSchedulerHarness({ proposal: null });
  await plain.scheduler.executeTask(plain.task, 'manual');
  const plainOptions = plain.recording.runnerCalls[0].options;
  assert.equal(plainOptions.disableMemoryUpdates, true, 'legacy scheduled-run behavior preserved');
  assert.equal(plainOptions.practiceSession, undefined);
  assert.equal(plainOptions.autoApprove, undefined);
  assert.equal(plain.recording.completedProposals.length, 0);
});

test('scheduler wall-clock watchdog stops an overrunning practice run and marks it failed', async () => {
  const proposal = { id: 43, metabotId: 5, status: 'scheduled', riskClass: 'read_only' };
  const { scheduler, recording, task } = createSchedulerHarness({ proposal, practiceRunWatchdogMs: 30 });
  await scheduler.executeTask(task, 'manual');
  assert.equal(recording.stopCalls.length, 1, 'the watchdog stopped the session');
  assert.match(recording.stopCalls[0].options.reason, /wall-clock budget/);
  assert.equal(recording.completedRuns[0].status, 'error');
  assert.match(recording.completedRuns[0].error, /wall-clock budget/);
  assert.equal(recording.failedProposals.length, 1);
  assert.equal(recording.failedProposals[0].id, 43);
});
