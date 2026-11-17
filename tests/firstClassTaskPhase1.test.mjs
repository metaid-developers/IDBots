import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  LongTermTaskStore,
  deriveIsLongTerm,
} = require('../dist-electron/main/longTermTaskStore.js');
const {
  TASK_INTENT_SPEC_VERSION,
  evaluateTaskIntentScores,
  detectExplicitTaskIntentOverride,
  formatTaskIntentPromptHint,
  buildPortableTaskIntentRubricSpec,
} = require('../dist-electron/main/cerebellum/taskIntentRubric.js');
const {
  selectTurnDecisionCandidates,
  buildTurnDecisionRequest,
  parseTurnDecisionAnswers,
  runCerebellumTurnDecisions,
} = require('../dist-electron/main/cerebellum/turnDecisionBundle.js');

async function openTempTaskStore(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-task-p1-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(
    sqliteStore.getDatabase(),
    sqliteStore.getSaveFunction(),
    options,
  );
  const dispose = () => {
    try {
      sqliteStore.close?.();
    } catch {
      // ignore close errors
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows Defender / sql.js tolerant cleanup
    }
  };
  return { store, sqliteStore, dir, dispose };
}

test('Phase 1 migration: pre-existing long_term_tasks & long_term_subtasks rows survive intact and backfill originSessionId', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-task-p1-mig-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    db.run(`
      CREATE TABLE long_term_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'defining',
        acceptance_delegate INTEGER NOT NULL DEFAULT 1,
        current_subtask_id TEXT,
        definition_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        done_at TEXT
      );
      CREATE TABLE long_term_subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        preferred_channel TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        session_id TEXT,
        wait_note TEXT NOT NULL DEFAULT '',
        wait_until TEXT,
        notes TEXT NOT NULL DEFAULT '',
        accepted_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        UNIQUE(task_id, ordinal)
      );
    `);
    const oldIso = '2026-11-10T08:00:00.000Z';
    db.run(
      `INSERT INTO long_term_tasks (id, title, goal, stage, acceptance_delegate, current_subtask_id, definition_session_id, created_at, updated_at)
       VALUES ('ltt_legacy_1', 'Commercialization Mainline', 'Ship S1-S4', 'active', 1, 'lts_legacy_1', 'sess_origin_old', ?, ?)`,
      [oldIso, oldIso],
    );
    db.run(
      `INSERT INTO long_term_subtasks (id, task_id, ordinal, title, status, session_id, created_at, updated_at)
       VALUES ('lts_legacy_1', 'ltt_legacy_1', 1, 'MRC721 tools', 'in_progress', 'sess_work_old', ?, ?)`,
      [oldIso, oldIso],
    );

    const store = new LongTermTaskStore(db, sqliteStore.getSaveFunction());
    const task = store.getTask('ltt_legacy_1');
    assert.ok(task);
    assert.equal(task.originSessionId, 'sess_origin_old', 'originSessionId falls back to definition_session_id');
    assert.equal(task.isLongTerm, true, 'task open for >24h auto-derives isLongTerm badge');
    assert.ok(task.longTermReasons.includes('elapsed_span'));
    assert.ok(store.listRelatedSessionIds('ltt_legacy_1').includes('sess_origin_old'));
    assert.ok(store.listRelatedSessionIds('ltt_legacy_1').includes('sess_work_old'));
  } finally {
    try { sqliteStore.close?.(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('deriveIsLongTerm: 1-bot short task is standard; >=3 bots, >=1440m budget, >24h span, >=4 subtasks, or manual override marks [长期]', () => {
  const nowMs = Date.parse('2026-11-17T12:00:00.000Z');
  const recentIso = '2026-11-17T10:00:00.000Z';
  const makeSub = (ordinal, expectedMinutes = null) => ({
    id: `s${ordinal}`,
    taskId: 't1',
    ordinal,
    title: `Step ${ordinal}`,
    description: '',
    acceptanceCriteria: [],
    status: 'in_progress',
    dependsOn: [],
    preferredChannel: 'delegate_bot',
    evidence: [],
    sessionId: null,
    sessionHistory: [],
    waitNote: '',
    waitUntil: null,
    notes: '',
    expectedMinutes,
    metataskRoot: null,
    acceptedBy: null,
    createdAt: recentIso,
    updatedAt: recentIso,
    acceptedAt: null,
  });

  const shortStd = deriveIsLongTerm({
    override: null,
    participantCount: 2,
    subtasks: [makeSub(1, 30)],
    stage: 'active',
    createdAtIso: recentIso,
    nowMs,
  });
  assert.equal(shortStd.isLongTerm, false);
  assert.deepEqual(shortStd.reasons, []);

  const byBots = deriveIsLongTerm({
    override: null,
    participantCount: 3,
    subtasks: [makeSub(1, 45)],
    stage: 'active',
    createdAtIso: recentIso,
    nowMs,
  });
  assert.equal(byBots.isLongTerm, true);
  assert.deepEqual(byBots.reasons, ['participants']);

  const byDuration = deriveIsLongTerm({
    override: null,
    participantCount: 1,
    subtasks: [makeSub(1, 720), makeSub(2, 720)],
    stage: 'active',
    createdAtIso: recentIso,
    nowMs,
  });
  assert.equal(byDuration.isLongTerm, true);
  assert.deepEqual(byDuration.reasons, ['expected_duration']);

  const byStages = deriveIsLongTerm({
    override: null,
    participantCount: 2,
    subtasks: [makeSub(1), makeSub(2), makeSub(3), makeSub(4)],
    stage: 'active',
    createdAtIso: recentIso,
    nowMs,
  });
  assert.equal(byStages.isLongTerm, true);
  assert.deepEqual(byStages.reasons, ['multi_stage']);

  const forcedOff = deriveIsLongTerm({
    override: false,
    participantCount: 5,
    subtasks: [makeSub(1, 2000)],
    stage: 'active',
    createdAtIso: '2026-11-01T00:00:00.000Z',
    nowMs,
  });
  assert.equal(forcedOff.isLongTerm, false);

  const forcedOn = deriveIsLongTerm({
    override: true,
    participantCount: 1,
    subtasks: [makeSub(1, 10)],
    stage: 'active',
    createdAtIso: recentIso,
    nowMs,
  });
  assert.equal(forcedOn.isLongTerm, true);
  assert.deepEqual(forcedOn.reasons, ['manual']);
});

test('createUnifiedTask + task_session_links: parallel/serial DAG, origin anchors, and multi-channel session links', async () => {
  const { store, dispose } = await openTempTaskStore({
    resolveParticipants: (ids) => ids.map((id) => ({ id, name: `Bot-${id}`, avatar: null })),
  });
  try {
    // 2 parallel initial subtasks (#1, #2) followed by serial #3 depending on both [1, 2]
    const created = store.createUnifiedTask(
      {
        title: 'Multisig launch package',
        goal: 'Review security, generate cover art, then publish tutorial',
        originSessionId: 'studio-sess-1',
        originMessageId: 'msg-user-42',
        anchorMessageIds: ['msg-user-41', 'msg-user-42'],
        originChannel: 'studio',
        subtasks: [
          { title: 'Security review', assigneeMetabotId: 15 },
          { title: '3 cover designs', assigneeMetabotId: 22 },
          { title: 'Publish final note', dependsOnOrdinals: [1, 2], assigneeMetabotId: 1 },
        ],
      },
      'twin',
    );
    assert.ok(created.ok, JSON.stringify(created));
    const detail = created.value;
    assert.equal(detail.stage, 'active');
    assert.equal(detail.originSessionId, 'studio-sess-1');
    assert.equal(detail.originMessageId, 'msg-user-42');
    assert.deepEqual(detail.anchorMessageIds, ['msg-user-42', 'msg-user-41']);
    assert.equal(detail.originChannel, 'studio');
    // 3 distinct Bot assignees (1, 15, 22) -> automatically tagged [长期]
    assert.equal(detail.isLongTerm, true);
    assert.ok(detail.longTermReasons.includes('participants'));
    // #1 and #2 had zero dependencies -> both immediately in_progress; #3 stays pending!
    assert.equal(detail.subtasks[0].status, 'in_progress');
    assert.equal(detail.subtasks[1].status, 'in_progress');
    assert.equal(detail.subtasks[2].status, 'pending');

    // Link a mobile session and a telegram bridge session to the same task
    assert.ok(
      store.linkSession(detail.id, 'mobile-sess-9', {
        role: 'channel_bridge',
        channel: 'mobile',
        anchorMessageId: 'mob-msg-1',
      }).ok,
    );
    assert.ok(
      store.linkSession(detail.id, 'tg-sess-3', {
        role: 'channel_bridge',
        channel: 'telegram',
      }).ok,
    );
    assert.equal(store.listTasksForSession('mobile-sess-9')[0]?.id, detail.id);
    assert.equal(store.listTasksForSession('tg-sess-3')[0]?.id, detail.id);
    assert.equal(store.findBySessionId('mobile-sess-9')?.task.id, detail.id);
  } finally {
    dispose();
  }
});

test('Worker blackboard + Subtask lease lock: prevents G1-style parallel collision and records Worker direct submission', async () => {
  const { store, dispose } = await openTempTaskStore({
    resolveParticipants: (ids) => ids.map((id) => ({ id, name: id === 15 ? 'Builder阿码' : `Bot-${id}`, avatar: null })),
  });
  try {
    const created = store.createUnifiedTask(
      {
        title: 'G1 Payment Card Emitter',
        goal: 'Implement payment_card_emit with 100% unit tests',
        originSessionId: 'studio-sess-main',
        originMessageId: 'msg-g1',
      },
      'twin',
    );
    assert.ok(created.ok);
    const subId = created.value.subtasks[0].id;

    // Session A claims lease for Worker #15
    const claimA = store.claimSubtaskLease(
      subId,
      { assigneeMetabotId: 15, attemptId: 'att-line-a', workerSessionId: 'worker-sess-a' },
      'twin',
    );
    assert.ok(claimA.ok);
    assert.equal(claimA.value.leaseAttemptId, 'att-line-a');
    assert.equal(claimA.value.assigneeMetabotId, 15);

    // Parallel Session B tries to claim the SAME subtask without forceSupersede -> CONFLICT!
    const claimB = store.claimSubtaskLease(
      subId,
      { assigneeMetabotId: 31, attemptId: 'att-line-b', workerSessionId: 'worker-sess-b' },
      'twin',
    );
    assert.equal(claimB.ok, false);
    assert.equal(claimB.code, 'CONFLICT');

    // Worker #15 writes live progress checkpoint directly to SQLite
    const prog = store.recordSubtaskProgress(
      subId,
      { note: '2/3: tool wired, running 28 unit tests' },
      'worker:15',
    );
    assert.ok(prog.ok);
    assert.equal(store.listActiveTasksCompact()[0]?.progressNote, '2/3: tool wired, running 28 unit tests');
    assert.equal(store.listActiveTasksCompact()[0]?.assigneeName, 'Builder阿码');

    // Worker #15 registers structured submission + evidence directly onto the subtask
    const submitted = store.submitSubtaskWork(
      subId,
      {
        outcome: 'ready_for_review',
        workerMetabotId: 15,
        workerSessionId: 'worker-sess-a',
        attemptId: 'att-line-a',
        summary: 'Implemented payment_card_emit on feat/g1-payment-card-emitter; 28/28 green',
        artifacts: [
          { kind: 'dir', uri: '/Users/tusm/idbots/.worktrees/g1', label: 'feature branch worktree' },
        ],
        evidence: [
          { kind: 'dir', uri: '/Users/tusm/idbots/.worktrees/g1', note: '28/28 tests pass' },
        ],
      },
      'worker:15',
    );
    assert.ok(submitted.ok, JSON.stringify(submitted));
    assert.equal(submitted.value.leaseAttemptId, null, 'submission releases active attempt lease');
    assert.equal(submitted.value.submission?.outcome, 'ready_for_review');
    assert.equal(submitted.value.submission?.artifacts.length, 1);
    assert.equal(submitted.value.evidence.length, 1);

    // Fast search hits across subtask submission artifacts and summary
    const hits = store.searchTasks({ query: 'payment_card_emit 28/28' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, created.value.id);
  } finally {
    dispose();
  }
});

test('TaskIntentSpec v1 + Cerebellum turnDecisionBundle: reproducible 5-factor scoring, hard overrides, and configurable weights', async () => {
  // 1) Casual concept explanation -> 0 pts -> casual_dialogue
  const casual = evaluateTaskIntentScores(
    { f1: 0, f2: 0, f3: 0, f4: 0, f5: 0 },
    { userText: '好友系统是怎么回事啊？' },
  );
  assert.equal(casual.specVersion, TASK_INTENT_SPEC_VERSION);
  assert.equal(casual.totalScore, 0);
  assert.equal(casual.verdict, 'casual_dialogue');

  // 2) Read-only status check -> 2 pts -> casual_dialogue (no task card pollution)
  const statusCheck = evaluateTaskIntentScores(
    { f1: 1, f2: 0, f3: 0, f4: 0, f5: 1 },
    { userText: '顺便帮我查查好友系统按原计划做完没？' },
  );
  assert.equal(statusCheck.totalScore, 2);
  assert.equal(statusCheck.verdict, 'casual_dialogue');

  // 3) Small 1-2 turn proposal ("帮我出一个多签推广方案") -> F2=2 triggers create_task without nagging
  const smallPlan = evaluateTaskIntentScores(
    { f1: 1, f2: 2, f3: 0, f4: 1, f5: 0 },
    { userText: '帮我出一个多签技能的推广方案' },
  );
  assert.equal(smallPlan.totalScore, 4);
  assert.equal(smallPlan.verdict, 'create_task');
  assert.ok(smallPlan.hardTriggeredBy.includes('f2_deliverable'));

  // 4) Exploratory open discussion -> 3-4 pts without F2=2/F5=2 -> gray_explore
  const brainstorm = evaluateTaskIntentScores(
    { f1: 1, f2: 1, f3: 1, f4: 1, f5: 0 },
    { userText: '我们先讨论下未来要不要做海外版订阅路线？' },
  );
  assert.equal(brainstorm.totalScore, 4);
  assert.equal(brainstorm.verdict, 'gray_explore');

  // 5) Explicit user overrides ("先别立项，随便聊聊" vs "立个项")
  assert.equal(detectExplicitTaskIntentOverride('先别立项，我们随便聊聊'), 'force_dialogue');
  assert.equal(detectExplicitTaskIntentOverride('这件事帮我立个项推进'), 'force_task');
  const forcedChat = evaluateTaskIntentScores(
    { f1: 2, f2: 2, f3: 2, f4: 2, f5: 1 },
    { userText: '先别立项，随便聊聊做个多签市场的可能性' },
  );
  assert.equal(forcedChat.verdict, 'casual_dialogue');

  // 6) Bundled Cerebellum /v1/systemone request & response parsing
  const decisions = {
    currentUserText: '让 Eleven 做三个版本的多签文章配图供我挑选',
    memories: [],
    knowledge: [],
    skills: [],
    services: [],
    includeGate: false,
    includeTaskIntent: true,
  };
  const selection = selectTurnDecisionCandidates(decisions);
  assert.ok(selection, 'includeTaskIntent alone makes the turn bundle eligible');
  const req = buildTurnDecisionRequest({ selection, model: 'jev-latest' });
  assert.ok(req.questions.intent_f1);
  assert.ok(req.questions.intent_f2);
  assert.ok(req.questions.intent_f5);

  const res = await runCerebellumTurnDecisions({
    config: { provider: 'typesafe-jev', apiKey: 'k', baseUrl: 'https://jev.example.com', model: 'jev-latest' },
    decisions,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        model: 'jev-latest',
        answers: {
          intent_f1: { probabilities: { s0: 0.05, s1: 0.15, s2: 0.8 } },
          intent_f2: { probabilities: { s0: 0.01, s1: 0.04, s2: 0.95 } },
          intent_f3: { choice: 's1' },
          intent_f4: { choice: 's1' },
          intent_f5: { choice: 's1' },
        },
      }),
    }),
  });
  assert.ok(res?.taskIntentAssessment);
  assert.equal(res.taskIntentAssessment.totalScore, 7);
  assert.equal(res.taskIntentAssessment.verdict, 'create_task');
  const hint = formatTaskIntentPromptHint(res.taskIntentAssessment);
  assert.match(hint, /verdict="create_task"/);
  assert.match(buildPortableTaskIntentRubricSpec(), /idbots\.task-intent\.v1/);
});
