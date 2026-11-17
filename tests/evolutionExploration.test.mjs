import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../dist-electron/main/libs/evolutionExploration.js');
const { shiftDateKey } = require('../dist-electron/main/libs/predictionLedger.js');

// ---------------------------------------------------------------------------
// Pure vectors (RRSI P4 Task 1)
// ---------------------------------------------------------------------------

const D = '2026-09-01';

/**
 * One ExplorationNight per calendar day from fromDate through toDate
 * (inclusive). `emptyEvery` (when > 0) keeps only every Nth night non-empty
 * (1-based); `validatedOn` maps a date key to that night's validated count.
 */
function nights(fromDate, toDate, options = {}) {
  const { emptyEvery = 0, validatedOn = {} } = options;
  const out = [];
  for (let date = fromDate; date <= toDate; date = shiftDateKey(date, 1)) {
    const index = out.length;
    out.push({
      dreamDate: date,
      emptyDay: emptyEvery > 0 ? (index + 1) % emptyEvery !== 1 : false,
      validated: validatedOn[date] ?? 0,
      promoted: 0,
    });
  }
  return out;
}

const proposals = (entries) => entries.map(([dreamDate, component]) => ({ dreamDate, component }));

test('practice component vocabulary and normalization', () => {
  assert.deepEqual(R.PRACTICE_COMPONENTS, [
    'memory', 'procedure', 'skill', 'remote_service', 'collaboration', 'metaweb', 'metaapp',
  ]);
  assert.deepEqual(R.STRUCTURAL_PRACTICE_COMPONENTS, ['skill', 'remote_service', 'collaboration', 'metaapp']);
  assert.equal(R.normalizePracticeComponent('Remote-Service'), 'remote_service');
  assert.equal(R.normalizePracticeComponent(' metaapp '), 'metaapp');
  assert.equal(R.normalizePracticeComponent('wallet'), null);
  assert.equal(R.normalizePracticeComponent(7), null);
});

test('stall: three active windows with zero acceptance', () => {
  const activeNights = nights('2026-08-11', '2026-08-31');
  assert.equal(activeNights.length, 21);
  assert.deepEqual(
    R.detectEvolutionStall({ date: D, nights: activeNights, proposals: [] }),
    { stalled: true, reason: 'no_acceptance', dominantComponent: null },
  );
});

test('stall: one acceptance in the windows breaks it', () => {
  const withAcceptance = nights('2026-08-11', '2026-08-31', { validatedOn: { '2026-08-20': 1 } });
  assert.equal(
    R.detectEvolutionStall({ date: D, nights: withAcceptance, proposals: [] }).stalled,
    false,
  );
});

test('stall: a window with fewer than three non-empty nights is not active enough', () => {
  // W3 (2026-08-11..2026-08-17) keeps only every 4th night non-empty → 2 of 7.
  const thinW3 = [
    ...nights('2026-08-11', '2026-08-17', { emptyEvery: 4 }),
    ...nights('2026-08-18', '2026-08-31'),
  ];
  assert.equal(thinW3.filter((night) => !night.emptyDay && night.dreamDate <= '2026-08-17').length, 2);
  assert.equal(R.detectEvolutionStall({ date: D, nights: thinW3, proposals: [] }).stalled, false);
  // Exactly 3 non-empty nights in W3 → active again → stalled.
  const activeW3 = [
    ...nights('2026-08-11', '2026-08-17', { emptyEvery: 3 }),
    ...nights('2026-08-18', '2026-08-31'),
  ];
  assert.equal(activeW3.filter((night) => !night.emptyDay && night.dreamDate <= '2026-08-17').length, 3);
  assert.deepEqual(
    R.detectEvolutionStall({ date: D, nights: activeW3, proposals: [] }),
    { stalled: true, reason: 'no_acceptance', dominantComponent: null },
  );
});

test('stall: nights on the dreamed date itself are ignored', () => {
  const withToday = [
    ...nights('2026-08-11', '2026-08-31'),
    { dreamDate: '2026-09-01', emptyDay: false, validated: 1, promoted: 0 },
  ];
  assert.deepEqual(
    R.detectEvolutionStall({ date: D, nights: withToday, proposals: [] }),
    { stalled: true, reason: 'no_acceptance', dominantComponent: null },
  );
});

test('stall: component collapse over the trailing 14 days', () => {
  const collapse = R.detectEvolutionStall({
    date: D,
    nights: [],
    proposals: proposals([
      ['2026-08-18', 'memory'],
      ['2026-08-21', 'memory'],
      ['2026-08-25', 'memory'],
      ['2026-08-31', 'memory'],
    ]),
  });
  assert.deepEqual(collapse, { stalled: true, reason: 'component_collapse', dominantComponent: 'memory' });
  // Three proposals stay below the threshold.
  assert.equal(R.detectEvolutionStall({
    date: D,
    nights: [],
    proposals: proposals([
      ['2026-08-18', 'memory'],
      ['2026-08-21', 'memory'],
      ['2026-08-25', 'memory'],
    ]),
  }).stalled, false);
  // Four proposals but two distinct components → no collapse.
  assert.equal(R.detectEvolutionStall({
    date: D,
    nights: [],
    proposals: proposals([
      ['2026-08-18', 'memory'],
      ['2026-08-21', 'memory'],
      ['2026-08-25', 'memory'],
      ['2026-08-31', 'skill'],
    ]),
  }).stalled, false);
  // Null components are ignored: 4 memory + 2 null still collapses.
  assert.deepEqual(R.detectEvolutionStall({
    date: D,
    nights: [],
    proposals: proposals([
      ['2026-08-18', 'memory'],
      ['2026-08-21', 'memory'],
      ['2026-08-25', 'memory'],
      ['2026-08-31', 'memory'],
      ['2026-08-22', null],
      ['2026-08-28', null],
    ]),
  }), { stalled: true, reason: 'component_collapse', dominantComponent: 'memory' });
});

test('stall: no_acceptance outranks component_collapse but still reports the dominant component', () => {
  const result = R.detectEvolutionStall({
    date: D,
    nights: nights('2026-08-11', '2026-08-31'),
    proposals: proposals([
      ['2026-08-18', 'memory'],
      ['2026-08-21', 'memory'],
      ['2026-08-25', 'memory'],
      ['2026-08-31', 'memory'],
    ]),
  });
  assert.deepEqual(result, { stalled: true, reason: 'no_acceptance', dominantComponent: 'memory' });
});

test('under-explored components exclude the recently practiced and the dominant one', () => {
  const recent = proposals([
    ['2026-08-10', 'memory'],
    ['2026-08-15', 'skill'],
  ]);
  assert.deepEqual(
    R.listUnderExploredComponents({ date: D, proposals: recent }),
    ['procedure', 'remote_service', 'collaboration', 'metaweb', 'metaapp'],
  );
  assert.deepEqual(
    R.listUnderExploredComponents({ date: D, proposals: recent, dominantComponent: 'memory' }),
    ['procedure', 'remote_service', 'collaboration', 'metaweb', 'metaapp'],
  );
  // 31 days before D — outside the 30-day lookback.
  assert.deepEqual(
    R.listUnderExploredComponents({ date: D, proposals: [...recent, ...proposals([['2026-08-01', 'metaapp']])] }),
    ['procedure', 'remote_service', 'collaboration', 'metaweb', 'metaapp'],
  );
  // All seven used in-window → fall back to the structural list.
  const allSeven = proposals([
    ['2026-08-05', 'memory'],
    ['2026-08-08', 'procedure'],
    ['2026-08-11', 'skill'],
    ['2026-08-14', 'remote_service'],
    ['2026-08-17', 'collaboration'],
    ['2026-08-20', 'metaweb'],
    ['2026-08-23', 'metaapp'],
  ]);
  assert.deepEqual(
    R.listUnderExploredComponents({ date: D, proposals: allSeven }),
    ['skill', 'remote_service', 'collaboration', 'metaapp'],
  );
});

test('exploration directive renders the exact no_acceptance text', () => {
  const directive = R.renderExplorationDirective({
    reason: 'no_acceptance',
    underExplored: ['skill', 'metaapp'],
  });
  assert.equal(directive, [
    '## 探索提示(你的自我进化最近停滞了:连续三周有活动,但没有新的能力通过验证或固化)',
    '最近 30 天里你还没有在这些方向上出过练习:skill(调用或组合技能)、metaapp(使用或发布 MetaApp)…',
    '今晚的 practice_proposals 里,至少一条的 component 要从上面这些方向里选;另一条照常针对记录在案的薄弱点。',
    '出处规则不变:每条提案仍然必须有 target_refs,risk_class 照实填写;找不到有出处的目标时,宁可少出一条,也不要编造。',
  ].join('\n'));
});

test('exploration directive names the dominant component for a collapse', () => {
  const directive = R.renderExplorationDirective({
    reason: 'component_collapse',
    underExplored: ['skill', 'metaapp'],
    dominantComponent: 'memory',
  });
  assert.ok(
    directive.startsWith('## 探索提示(你的自我进化最近停滞了:最近两周的练习都集中在 memory(整理与运用记忆))'),
    directive,
  );
});

test('compliance is null when not directed, else follows the proposals', () => {
  const directed = { directed: true, underExplored: ['skill'] };
  assert.equal(R.judgeExplorationCompliance({ ...directed, directed: false, proposals: [{ component: 'skill' }] }), null);
  assert.equal(R.judgeExplorationCompliance({ ...directed, proposals: [{ component: 'skill' }] }), true);
  assert.equal(R.judgeExplorationCompliance({ ...directed, proposals: [{ component: 'memory' }] }), false);
  assert.equal(R.judgeExplorationCompliance({ ...directed, proposals: [] }), false);
});

test('approval ordering partitions under-explored first only while stalled', () => {
  const m1 = { id: 'm1', component: 'memory' };
  const s1 = { id: 's1', component: 'skill' };
  const m2 = { id: 'm2', component: 'memory' };
  const r1 = { id: 'r1', component: 'remote_service' };
  const input = [m1, s1, m2, r1];
  assert.deepEqual(
    R.orderPracticeProposalsForApproval(input, { stalled: true, underExplored: ['skill', 'remote_service'] })
      .map((item) => item.id),
    ['s1', 'r1', 'm1', 'm2'],
  );
  assert.deepEqual(
    R.orderPracticeProposalsForApproval(input, { stalled: false, underExplored: ['skill', 'remote_service'] })
      .map((item) => item.id),
    ['m1', 's1', 'm2', 'r1'],
  );
});

// ---------------------------------------------------------------------------
// component on practice proposals: parse, prompt schema, store (RRSI P4 Task 2)
// ---------------------------------------------------------------------------

const DREAM_VERSION_BEFORE = 18;
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const proposalPayload = (component) => JSON.stringify({
  daily_summary: '今天复盘了自己的薄弱点。',
  sections: {},
  work_reviews: [],
  important_memories: [],
  value_lessons: [],
  self_identity: LONG_IDENTITY,
  practice_proposals: [
    {
      title: '对比实验:技能组合练习',
      prompt: '完整且自包含的练习指令',
      rationale: '上周组合调用失败',
      target_refs: ['draft:1'],
      expected_evidence: '两种组合方式的结果差异',
      risk_class: 'read_only',
      ...(component !== undefined ? { component } : {}),
    },
  ],
});

test('parseDreamOutput normalizes the proposal component', () => {
  const { parseDreamOutput } = require('../dist-electron/main/libs/dreamPrompt.js');
  const componentOf = (payload) => {
    const result = parseDreamOutput(payload);
    assert.equal(result.ok, true);
    return result.output.practiceProposals[0].component;
  };
  assert.equal(componentOf(proposalPayload('Skill')), 'skill');
  assert.equal(componentOf(proposalPayload('wallet')), null);
  assert.equal(componentOf(proposalPayload(undefined)), null);
});

test('buildDreamPrompt carries the component field and the guidance sentence', () => {
  const { buildDreamPrompt } = require('../dist-electron/main/libs/dreamPrompt.js');
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: { sessions: [], taskRuns: [], orderCount: 0 },
  });
  assert.ok(user.includes('"component": "这条练习锻炼的方向'), user);
  assert.ok(user.includes('每条提案都要填写 component(七选一),写出它实际锻炼的方向;'), user);
});

test('DREAM_VERSION bumped exactly once for P4', () => {
  const { DREAM_VERSION } = require('../dist-electron/main/libs/dreamPrompt.js');
  assert.equal(DREAM_VERSION, DREAM_VERSION_BEFORE + 1);
});

test('store: component persists normalized; unknown and legacy rows read null', async () => {
  const { createCoworkStore, createSqliteStore } = await import('./memoryTestUtils.mjs');
  const { db, store, userDataPath, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertDreamPracticeProposals(5, '2026-08-02', [
      { title: '练习远程服务', prompt: '指令', targetRefs: ['draft:1'], component: 'remote_service' },
      { title: '练习未知方向', prompt: '指令', targetRefs: ['draft:2'], component: 'nope' },
      { title: '缺省方向', prompt: '指令', targetRefs: ['draft:3'] },
    ]);
    // A row written by an older build (raw SQL, no component value).
    db.run(
      `INSERT INTO dream_practice_proposals (metabot_id, dream_date, title, prompt, created_at, updated_at)
       VALUES (5, '2026-08-01', '旧行', '指令', 1, 1)`,
    );

    const rows = coworkStore.listDreamPracticeProposals(5);
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    assert.equal(byTitle.get('练习远程服务').component, 'remote_service');
    assert.equal(byTitle.get('练习未知方向').component, null);
    assert.equal(byTitle.get('缺省方向').component, null);
    assert.equal(byTitle.get('旧行').component, null, 'rows written before the column existed read null');

    // Re-running the whole schema pass keeps the column exactly once.
    store.initializeTables(userDataPath);
    store.initializeTables(userDataPath);
    const after = coworkStore.listDreamPracticeProposals(5);
    assert.equal(after.length, 4);
    assert.equal(after.find((row) => row.title === '练习远程服务').component, 'remote_service');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Flow: exploration directive in the dream + compliance telemetry (RRSI P4 Task 3)
// ---------------------------------------------------------------------------

const {
  createDreamHarness,
  dayStartMs,
  dreamJson,
  seedSession,
  BOT_ID,
} = await import('./fixtures/rrsiDreamHarness.mjs');
const { DreamStore: DreamStoreCtor } = require('../dist-electron/main/dreamStore.js');

/** 21 non-empty zero-acceptance telemetry rows for the 21 nights before D. */
function seedStalledTelemetry(db, dateKey) {
  for (let offset = 21; offset >= 1; offset -= 1) {
    const dreamDate = shiftDateKey(dateKey, -offset);
    db.run(
      `INSERT INTO metabot_dream_telemetry_daily (
         metabot_id, dream_date, empty_day, validation_validated, promoted_count,
         extra_json, created_at, updated_at
       ) VALUES (?, ?, 0, 0, 0, '{}', ?, ?)`,
      [BOT_ID, dreamDate, dayStartMs(dreamDate), dayStartMs(dreamDate)],
    );
  }
}

const skillProposal = (component) => [{
  title: '对比实验:技能组合练习',
  prompt: '完整且自包含的练习指令',
  rationale: '组合调用失败过',
  target_refs: ['draft:1'],
  expected_evidence: '两种组合的结果差异',
  risk_class: 'read_only',
  component,
}];

test('flow: not stalled — no directive section, exploration telemetry zeros out', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D, [
      { type: 'user', content: '视频做好了吗' },
      { type: 'assistant', content: '做好了' },
    ]);
    h.router.setFallback(() => dreamJson({}));
    await h.runNight(D);
    const lastCall = h.router.calls[h.router.calls.length - 1];
    assert.ok(!`${lastCall.system}\n${lastCall.user}`.includes('## 探索提示'));
    assert.deepEqual(h.telemetry(D).exploration, {
      stalled: false,
      reason: null,
      underExplored: [],
      directed: false,
      complied: null,
    });
  } finally {
    h.cleanup();
  }
});

test('flow: stalled — directive rides the prompt and a directed proposal complies', async () => {
  const h = await createDreamHarness();
  try {
    seedStalledTelemetry(h.db, D);
    insertMetabotRow(h.db, BOT_ID);
    seedSession(h.coworkStore, h.db, D, [
      { type: 'user', content: '视频做好了吗' },
      { type: 'assistant', content: '做好了' },
    ]);
    h.coworkStore.setMemoryPolicyForMetabot(BOT_ID, { practiceTasksEnabled: true, practiceAutoApproveReadOnly: true });
    h.router.setFallback(() => dreamJson({ practice_proposals: skillProposal('skill') }));
    await h.runNight(D);
    const lastCall = h.router.calls[h.router.calls.length - 1];
    assert.ok(lastCall.user.includes('## 探索提示'), lastCall.user.slice(0, 200));
    assert.ok(lastCall.user.includes('连续三周有活动'));
    const exploration = h.telemetry(D).exploration;
    assert.equal(exploration.directed, true);
    assert.equal(exploration.complied, true);
    assert.equal(exploration.reason, 'no_acceptance');
    assert.equal(exploration.stalled, true);
    const stored = h.coworkStore.listDreamPracticeProposals(BOT_ID);
    assert.equal(stored.find((row) => row.title === '对比实验:技能组合练习').component, 'skill');
  } finally {
    h.cleanup();
  }
});

test('flow: stalled — an already-practiced component does not comply', async () => {
  const h = await createDreamHarness();
  try {
    seedStalledTelemetry(h.db, D);
    seedSession(h.coworkStore, h.db, D, [
      { type: 'user', content: '视频做好了吗' },
      { type: 'assistant', content: '做好了' },
    ]);
    // memory was used inside the trailing 30 days, so it is not under-explored.
    h.coworkStore.insertDreamPracticeProposals(BOT_ID, shiftDateKey(D, -10), [
      { title: '旧的 memory 练习', prompt: '指令', targetRefs: ['draft:9'], component: 'memory' },
    ]);
    insertMetabotRow(h.db, BOT_ID);
    h.coworkStore.setMemoryPolicyForMetabot(BOT_ID, { practiceTasksEnabled: true, practiceAutoApproveReadOnly: true });
    h.router.setFallback(() => dreamJson({ practice_proposals: skillProposal('memory') }));
    await h.runNight(D);
    const exploration = h.telemetry(D).exploration;
    assert.equal(exploration.stalled, true);
    assert.equal(exploration.directed, true);
    assert.equal(exploration.complied, false);
    assert.ok(!exploration.underExplored.includes('memory'));
  } finally {
    h.cleanup();
  }
});

test('flow: empty day while stalled — directed false, complied null', async () => {
  const h = await createDreamHarness();
  try {
    seedStalledTelemetry(h.db, D);
    await h.runNight(D);
    const exploration = h.telemetry(D).exploration;
    assert.equal(exploration.stalled, true);
    assert.equal(exploration.reason, 'no_acceptance');
    assert.equal(exploration.directed, false);
    assert.equal(exploration.complied, null);
  } finally {
    h.cleanup();
  }
});

test('listDreamTelemetryDailyRange is inclusive, ascending, per-bot', async () => {
  const { createSqliteStore } = await import('./memoryTestUtils.mjs');
  const { db, cleanup } = await createSqliteStore();
  try {
    const dreamStore = new DreamStoreCtor(db, () => {});
    dreamStore.beginRun(BOT_ID, '2026-08-10', null, 18);
    dreamStore.updateRunTelemetry(BOT_ID, '2026-08-10', { emptyDay: true });
    dreamStore.beginRun(BOT_ID, '2026-08-12', null, 18);
    dreamStore.updateRunTelemetry(BOT_ID, '2026-08-12', { emptyDay: false });
    dreamStore.beginRun(BOT_ID, '2026-08-14', null, 18);
    dreamStore.updateRunTelemetry(BOT_ID, '2026-08-14', { emptyDay: true });
    dreamStore.beginRun(99, '2026-08-13', null, 18);
    dreamStore.updateRunTelemetry(99, '2026-08-13', { emptyDay: true });
    const rows = dreamStore.listDreamTelemetryDailyRange(BOT_ID, '2026-08-10', '2026-08-14');
    assert.deepEqual(rows.map((row) => row.dreamDate), ['2026-08-10', '2026-08-12', '2026-08-14']);
    assert.ok(rows.every((row) => row.metabotId === BOT_ID), 'other bots are excluded');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Flow: under-explored read-only proposals approve first while stalled (P4 Task 4)
// ---------------------------------------------------------------------------

const {
  loadDreamServiceModule,
  metabotStoreStub,
} = await import('./fixtures/rrsiDreamHarness.mjs');
const { createCoworkStore, createSqliteStore } = await import('./memoryTestUtils.mjs');
const { DreamService: DreamServiceCtor } = loadDreamServiceModule();

const insertMetabotRow = (db, id) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `pub-${id}`, `chatpub-${id}`, `Bot ${id}`, `metaid-${id}`, null]
  );
};

/**
 * One approval-pipeline night on D: two pending read-only memory proposals in
 * the backlog (D−2 then D−1, so oldest-first is D−2, D−1), and tonight's dream
 * proposes skill (read_only) + metaapp (chain_write).
 */
async function approvalNight({ stalled }) {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStoreCtor(db, () => {});
  insertMetabotRow(db, BOT_ID);
  if (stalled) seedStalledTelemetry(db, D);
  coworkStore.setMemoryPolicyForMetabot(BOT_ID, {
    practiceTasksEnabled: true,
    practiceAutoApproveReadOnly: true,
  });
  coworkStore.insertDreamPracticeProposals(BOT_ID, shiftDateKey(D, -2), [
    { title: 'memory 练习(旧)', prompt: 'p', targetRefs: ['draft:3'], riskClass: 'read_only', component: 'memory' },
  ]);
  coworkStore.insertDreamPracticeProposals(BOT_ID, shiftDateKey(D, -1), [
    { title: 'memory 练习(新)', prompt: 'p', targetRefs: ['draft:4'], riskClass: 'read_only', component: 'memory' },
  ]);
  seedSession(coworkStore, db, D, [
    { type: 'user', content: '视频做好了吗' },
    { type: 'assistant', content: '做好了' },
  ]);
  const createdTasks = [];
  const service = new DreamServiceCtor({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    transientRetryDelaysMs: [],
    now: () => new Date(dayStartMs(D) + 27 * 60 * 60 * 1000),
    createPracticeScheduledTask: (input) => {
      createdTasks.push(input);
      return { id: `task-${createdTasks.length}` };
    },
    performChat: async () => dreamJson({
      practice_proposals: [
        {
          title: 'skill 练习',
          prompt: '完整指令',
          rationale: 'r',
          target_refs: ['draft:1'],
          expected_evidence: 'e',
          risk_class: 'read_only',
          component: 'skill',
        },
        {
          title: 'metaapp 练习',
          prompt: '完整指令',
          rationale: 'r',
          target_refs: ['draft:2'],
          expected_evidence: 'e',
          risk_class: 'chain_write',
          component: 'metaapp',
        },
      ],
    }),
  });
  await service.runNow(BOT_ID, D);
  return {
    createdTasks,
    statusOf: (title) => coworkStore.listDreamPracticeProposals(BOT_ID).find((row) => row.title === title)?.status,
    telemetry: dreamStore.getRun(BOT_ID, D)?.telemetry ?? null,
    cleanup,
  };
}

test('approval ordering: while stalled the under-explored read-only proposal approves first', async () => {
  const night = await approvalNight({ stalled: true });
  try {
    assert.deepEqual(night.createdTasks.map((task) => task.name), [
      '[Practice] skill 练习',
      '[Practice] memory 练习(旧)',
    ]);
    assert.equal(night.statusOf('memory 练习(新)'), 'pending');
    assert.equal(night.statusOf('metaapp 练习'), 'pending', 'chain_write never auto-approves');
    assert.equal(night.telemetry.exploration.stalled, true);
  } finally {
    night.cleanup();
  }
});

test('approval ordering: not stalled keeps today oldest-first behavior', async () => {
  const night = await approvalNight({ stalled: false });
  try {
    assert.deepEqual(night.createdTasks.map((task) => task.name), [
      '[Practice] memory 练习(旧)',
      '[Practice] memory 练习(新)',
    ]);
    assert.equal(night.statusOf('skill 练习'), 'pending');
    assert.equal(night.telemetry.exploration.stalled, false);
  } finally {
    night.cleanup();
  }
});

test('approval ordering: both cases cap at PRACTICE_PROPOSALS_MAX_PER_NIGHT and stub once per approval', async () => {
  const stalledNight = await approvalNight({ stalled: true });
  try {
    assert.equal(stalledNight.createdTasks.length, 2);
    assert.equal(stalledNight.telemetry.practiceProposals.autoApproved, 2);
  } finally {
    stalledNight.cleanup();
  }
  const calmNight = await approvalNight({ stalled: false });
  try {
    assert.equal(calmNight.createdTasks.length, 2);
    assert.equal(calmNight.telemetry.practiceProposals.autoApproved, 2);
  } finally {
    calmNight.cleanup();
  }
});
