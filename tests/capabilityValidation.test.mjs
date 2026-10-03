import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getColumns } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  buildCapabilityValidationPrompt,
  parseCapabilityValidationOutput,
  CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE,
} = require('../dist-electron/main/libs/capabilityValidationPrompt.js');
const {
  buildProvenTechniquesBlock,
  buildExperiencePromptBlocksXml,
} = require('../dist-electron/main/libs/experiencePromptBlocks.js');

function loadDreamServiceModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');

const DAY = '2026-08-02';
const DAY_START = new Date(2026, 7, 2).getTime();
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

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

test('parser accepts fenced JSON, aliases, clamps scores and drops unknown ids', () => {
  const validIds = new Set([1, 2, 3]);
  const fenced = '```json\n{"verdicts":[{"id":1,"verdict":"validate","score":1.7,"rationale":"ok"},{"id":2,"verdict":"keep","score":-2,"rationale":"unknown"},{"id":99,"verdict":"validated","score":1,"rationale":"ghost"},{"id":3,"verdict":"nonsense","score":0.5,"rationale":"bad"}]}\n```';
  const parsed = parseCapabilityValidationOutput(fenced, validIds);
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.verdicts.map((v) => ({ id: v.id, verdict: v.verdict, score: v.score })),
    [
      { id: 1, verdict: 'validated', score: 1 },
      { id: 2, verdict: 'keep_draft', score: 0 },
    ],
  );
});

test('parser rejects empty, non-JSON, and verdict-less output', () => {
  assert.equal(parseCapabilityValidationOutput('', new Set([1])).ok, false);
  assert.equal(parseCapabilityValidationOutput('no json here', new Set([1])).ok, false);
  assert.equal(parseCapabilityValidationOutput('{"foo":1}', new Set([1])).ok, false);
  assert.equal(parseCapabilityValidationOutput('{"verdicts":[{"id":42,"verdict":"validated","score":1}]}', new Set([1])).ok, false);
});

test('prompt lists drafts with ids and embeds the replayable history', () => {
  const prompt = buildCapabilityValidationPrompt({
    botName: '小火',
    date: DAY,
    drafts: [
      { id: 7, dreamDate: '2026-08-01', title: '先验证再交付', description: '交付前自检', capabilityType: 'workflow' },
    ],
    recentSummaries: [{ summaryDate: '2026-08-01', summaryText: '交付视频获赞' }],
    todayDigest: '1 个会话',
  });
  assert.ok(prompt.system.includes('能力验证'));
  assert.ok(prompt.user.includes('草案 #7'));
  assert.ok(prompt.user.includes('[2026-08-01] 交付视频获赞'));
  assert.ok(prompt.user.includes('1 个会话'));
});

test('schema migration adds validation columns idempotently', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    for (const column of ['validation_score', 'validation_notes', 'validated_at']) {
      assert.ok(getColumns(db, 'capability_drafts').includes(column), `missing column ${column}`);
    }
  } finally {
    cleanup();
  }
});

test('schema migration adds utilization columns; pre-existing rows default to zero/NULL', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    for (const column of ['times_injected', 'last_injected_at', 'promoted_at', 'promoted_procedure_id']) {
      assert.ok(getColumns(db, 'capability_drafts').includes(column), `missing column ${column}`);
    }
    db.run(
      `INSERT INTO capability_drafts (metabot_id, dream_date, title, description, capability_type, status, created_at)
       VALUES (5, '2026-08-01', '技巧', '描述', 'skill', 'validated', 1)`,
    );
    const row = db.exec('SELECT times_injected, last_injected_at, promoted_at, promoted_procedure_id FROM capability_drafts')[0].values[0];
    assert.equal(row[0], 0, 'times_injected defaults to 0');
    assert.equal(row[1], null, 'last_injected_at defaults to NULL');
    assert.equal(row[2], null, 'promoted_at defaults to NULL (never promoted)');
    assert.equal(row[3], null, 'promoted_procedure_id defaults to NULL');
  } finally {
    cleanup();
  }
});

test('markCapabilityDraftsInjected bumps counters and stamps last_injected_at', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '技巧甲', description: '描述甲', capabilityType: 'skill' },
      { title: '技巧乙', description: '描述乙', capabilityType: 'workflow' },
    ]);
    const drafts = coworkStore.listCapabilityDrafts(5);
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every((draft) => draft.timesInjected === 0 && draft.lastInjectedAt === null));

    const ids = drafts.map((draft) => draft.id);
    assert.equal(coworkStore.markCapabilityDraftsInjected(ids), 2);
    assert.equal(coworkStore.markCapabilityDraftsInjected([ids[0]]), 1);
    assert.equal(coworkStore.markCapabilityDraftsInjected([]), 0);
    assert.equal(coworkStore.markCapabilityDraftsInjected([99999]), 0, 'unknown ids bump nothing');

    const after = coworkStore.listCapabilityDrafts(5);
    const first = after.find((draft) => draft.id === ids[0]);
    const second = after.find((draft) => draft.id === ids[1]);
    assert.equal(first.timesInjected, 2);
    assert.equal(second.timesInjected, 1);
    assert.ok(first.lastInjectedAt > 0);
    assert.ok(second.lastInjectedAt > 0);
  } finally {
    cleanup();
  }
});

test('getCapabilityDraftUtilization rolls up validated drafts, injections and the 24h-active set', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '活跃甲', description: 'd', capabilityType: 'skill' },
      { title: '活跃乙', description: 'd', capabilityType: 'skill' },
      { title: '沉睡丙', description: 'd', capabilityType: 'skill' },
      { title: '未验证丁', description: 'd', capabilityType: 'skill' },
    ]);
    const drafts = coworkStore.listCapabilityDrafts(5);
    // listCapabilityDrafts is newest-first — locate by title, not by index.
    const byTitle = (title) => drafts.find((draft) => draft.title === title);
    for (const title of ['活跃甲', '活跃乙', '沉睡丙']) {
      coworkStore.updateCapabilityDraftValidation({ id: byTitle(title).id, metabotId: 5, status: 'validated', validationScore: 0.9 });
    }
    const activeA = byTitle('活跃甲');
    const activeB = byTitle('活跃乙');
    const sleeping = byTitle('沉睡丙');
    coworkStore.markCapabilityDraftsInjected([activeA.id, activeB.id]);
    coworkStore.markCapabilityDraftsInjected([activeA.id]);
    // 沉睡丙 was injected once, but long before the 24h window.
    const stale = Date.now() - 48 * 60 * 60 * 1000;
    db.run('UPDATE capability_drafts SET times_injected = 1, last_injected_at = ? WHERE id = ?', [stale, sleeping.id]);

    const rollup = coworkStore.getCapabilityDraftUtilization(5, Date.now() - 24 * 60 * 60 * 1000);
    assert.deepEqual(rollup, { validatedDrafts: 3, totalInjections: 4, activeDraftsLast24h: 2 });

    const noneActive = coworkStore.getCapabilityDraftUtilization(5, Date.now() + 1000);
    assert.equal(noneActive.activeDraftsLast24h, 0, 'future cutoff empties the active set');

    // Drafts of other bots never leak into the rollup.
    assert.deepEqual(
      coworkStore.getCapabilityDraftUtilization(7, Date.now() - 24 * 60 * 60 * 1000),
      { validatedDrafts: 0, totalInjections: 0, activeDraftsLast24h: 0 },
    );
  } finally {
    cleanup();
  }
});

test('store filters drafts by status and records validation verdicts', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, DAY, [
      { title: '先验证再交付', description: '交付前自己验证一遍', capabilityType: 'workflow' },
      { title: '深夜少发消息', description: '23 点后不主动打扰', capabilityType: 'skill' },
    ]);
    const pending = coworkStore.listCapabilityDrafts(5, { status: 'draft' });
    assert.equal(pending.length, 2);
    // listCapabilityDrafts is newest-first — locate by title, not by index.
    const target = pending.find((draft) => draft.title === '先验证再交付');

    const updated = coworkStore.updateCapabilityDraftValidation({
      id: target.id,
      metabotId: 5,
      status: 'validated',
      validationScore: 0.9,
      validationNotes: '多次交付获赞',
    });
    assert.equal(updated, true);

    const validated = coworkStore.listCapabilityDrafts(5, { status: 'validated' });
    assert.equal(validated.length, 1);
    assert.equal(validated[0].title, '先验证再交付');
    assert.equal(validated[0].validationScore, 0.9);
    assert.equal(validated[0].validationNotes, '多次交付获赞');
    assert.ok(validated[0].validatedAt > 0);
    assert.equal(coworkStore.listCapabilityDrafts(5, { status: 'draft' }).length, 1);

    // Wrong metabot id never touches the row.
    assert.equal(
      coworkStore.updateCapabilityDraftValidation({ id: validated[0].id, metabotId: 999, status: 'rejected' }),
      false,
    );
    assert.equal(coworkStore.listCapabilityDrafts(5, { status: 'validated' }).length, 1);
  } finally {
    cleanup();
  }
});

test('proven techniques block renders validated drafts inside the composed xml', () => {
  const block = buildProvenTechniquesBlock([
    { title: '先验证再交付', description: '交付前自己验证一遍' },
    { title: '', description: '跳过无标题' },
  ]);
  assert.ok(block.includes('<proven_techniques>'));
  assert.ok(block.includes('name="先验证再交付"'));
  assert.ok(!block.includes('跳过无标题'));

  const xml = buildExperiencePromptBlocksXml({
    summaries: [],
    provenTechniques: [{ title: '先验证再交付', description: '交付前自己验证一遍' }],
  });
  assert.ok(xml.includes('<proven_techniques>'));
});

test('dream run validates pending capability drafts against recorded history', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  const calls = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    performChat: async (system, user) => {
      calls.push({ system, user });
      if (system.includes('能力验证')) {
        const verdicts = [...user.matchAll(/### 草案 #(\d+)[\s\S]*?标题:([^\n]+)/g)].map((match) => ({
          id: Number(match[1]),
          verdict: match[2].includes('先验证') ? 'validated' : 'rejected',
          score: match[2].includes('先验证') ? 0.9 : 0.8,
          rationale: match[2].includes('先验证') ? '日记显示该做法屡获好评' : '照做后被差评',
        }));
        return JSON.stringify({ verdicts });
      }
      return JSON.stringify({
        daily_summary: '今天交付了视频。',
        sections: {},
        work_reviews: [],
        important_memories: [],
        value_lessons: [],
        self_identity: LONG_IDENTITY,
        capability_learnings: [
          { title: '先验证再交付', description: '交付前自己验证一遍', capability_type: 'workflow' },
          { title: '深夜连环追问', description: '深夜连续追问进度', capability_type: 'skill' },
        ],
      });
    },
  });
  try {
    await service.runNow(5, DAY);

    // Dream call + validation call.
    assert.equal(calls.length, 2);
    assert.ok(calls[1].system.includes('能力验证'));
    // The validation prompt embeds tonight's freshly written diary as history.
    assert.ok(calls[1].user.includes('今天交付了视频。'));

    const validated = coworkStore.listCapabilityDrafts(5, { status: 'validated' });
    assert.equal(validated.length, 1);
    assert.equal(validated[0].title, '先验证再交付');
    assert.equal(validated[0].validationScore, 0.9);
    const rejected = coworkStore.listCapabilityDrafts(5, { status: 'rejected' });
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].title, '深夜连环追问');
    assert.equal(coworkStore.listCapabilityDrafts(5, { status: 'draft' }).length, 0);
  } finally {
    cleanup();
  }
});

test('dream run telemetry carries the capability utilization rollup', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  // One pre-existing validated draft that was injected during the day.
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '既有技巧', description: '已经在用', capabilityType: 'skill' },
  ]);
  const existing = coworkStore.listCapabilityDrafts(5)[0];
  coworkStore.updateCapabilityDraftValidation({ id: existing.id, metabotId: 5, status: 'validated', validationScore: 0.9 });
  coworkStore.markCapabilityDraftsInjected([existing.id]);

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    performChat: async () => JSON.stringify({
      daily_summary: '普通的一天。',
      sections: {},
      work_reviews: [],
      important_memories: [],
      value_lessons: [],
      self_identity: LONG_IDENTITY,
      capability_learnings: [],
    }),
  });
  try {
    await service.runNow(5, DAY);
    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.deepEqual(
      telemetry.capabilityUtilization,
      { validatedDrafts: 1, totalInjections: 1, activeDraftsLast24h: 1 },
      'utilization section rides the run telemetry',
    );
  } finally {
    cleanup();
  }
});

test('nightly pass promotes top validated drafts into procedure memory — guarded, capped, idempotent', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1000);
  seedActivity(coworkStore, db);

  const YESTERDAY = DAY_START - 86_400_000;
  const seeds = [
    { title: '技巧A', score: 0.95, validatedAt: YESTERDAY, promotable: true },
    { title: '技巧B', score: 0.9, validatedAt: YESTERDAY, promotable: true },
    { title: '技巧C', score: 0.88, validatedAt: YESTERDAY, promotable: true },
    // Fourth in score order — over the per-night cap of 3.
    { title: '技巧D', score: 0.86, validatedAt: YESTERDAY, promotable: false },
    // Highest score but verdict stamped inside the dream date — the fresh
    // verdict must wait one night of calendar distance.
    { title: '技巧E', score: 0.99, validatedAt: DAY_START + 1000, promotable: false },
    // Below the promotion threshold.
    { title: '技巧F', score: 0.7, validatedAt: YESTERDAY, promotable: false },
  ];
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', seeds.map((seed) => ({
    title: seed.title,
    description: `${seed.title}的行动描述`,
    capabilityType: 'workflow',
  })));
  for (const seed of seeds) {
    const draft = coworkStore.listCapabilityDrafts(5).find((entry) => entry.title === seed.title);
    coworkStore.updateCapabilityDraftValidation({
      id: draft.id, metabotId: 5, status: 'validated', validationScore: seed.score,
    });
    db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [seed.validatedAt, draft.id]);
  }

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    metaidKnowledgeStore: knowledgeStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    performChat: async () => JSON.stringify({
      daily_summary: '普通的一天。',
      sections: {},
      work_reviews: [],
      important_memories: [],
      value_lessons: [],
      self_identity: LONG_IDENTITY,
      capability_learnings: [],
    }),
  });
  try {
    await service.runNow(5, DAY);

    const procedures = knowledgeStore.listProcedures({ metabotId: 5, status: 'active' });
    assert.deepEqual(
      procedures.map((entry) => entry.title).sort(),
      ['技巧A', '技巧B', '技巧C'],
      'top-3 old-verdict drafts become procedures; cap/fresh/low-score stay behind',
    );
    const procedureA = procedures.find((entry) => entry.title === '技巧A');
    assert.equal(procedureA.triggerText, '技巧A', 'trigger mirrors the draft title');
    assert.deepEqual(procedureA.steps, ['技巧A的行动描述'], 'the actionable description becomes the ordered step');
    assert.ok(procedureA.tags.includes('capability-draft'), 'provenance tag present');
    assert.equal(procedureA.origin, 'dream');

    for (const seed of seeds) {
      const draft = coworkStore.listCapabilityDrafts(5).find((entry) => entry.title === seed.title);
      if (seed.promotable) {
        assert.ok(draft.promotedAt > 0, `${seed.title} back-filled promoted_at`);
        const linked = knowledgeStore.getProcedure(draft.promotedProcedureId);
        assert.equal(linked?.title, seed.title, 'promoted_procedure_id points at the new procedure');
      } else {
        assert.equal(draft.promotedAt, null, `${seed.title} stays unpromoted`);
        assert.equal(draft.promotedProcedureId, null);
      }
    }
    assert.equal(dreamStore.getRun(5, DAY).telemetry.promotedCount, 3, 'telemetry counts the promotions');

    const promotedAtBefore = Object.fromEntries(
      coworkStore.listCapabilityDrafts(5).map((entry) => [entry.title, entry.promotedAt]),
    );
    const procedureIdsBefore = new Set(procedures.map((entry) => entry.id));
    // Second pass: the promoted_at guard makes already-promoted drafts a
    // no-op — A/B/C and their procedures stay byte-identical. The per-night
    // cap only rate-limits throughput, so the one eligible backlog draft (D)
    // drains now; E (fresh verdict) and F (low score) still never promote.
    await service.runNow(5, DAY);
    const after = knowledgeStore.listProcedures({ metabotId: 5, status: 'active' });
    assert.equal(after.length, 4, 'only the capped backlog draft drains on the later pass');
    const newProcedures = after.filter((entry) => !procedureIdsBefore.has(entry.id));
    assert.deepEqual(newProcedures.map((entry) => entry.title), ['技巧D']);
    for (const seed of seeds.filter((entry) => entry.promotable)) {
      const draft = coworkStore.listCapabilityDrafts(5).find((entry) => entry.title === seed.title);
      assert.equal(draft.promotedAt, promotedAtBefore[seed.title], `${seed.title} is never re-promoted`);
    }
    const versionA = after.find((entry) => entry.title === '技巧A').version;
    assert.equal(versionA, 1, 'existing procedures are not rewritten by the guard');
    for (const title of ['技巧E', '技巧F']) {
      const draft = coworkStore.listCapabilityDrafts(5).find((entry) => entry.title === title);
      assert.equal(draft.promotedAt, null, `${title} stays unpromoted across passes`);
    }
    assert.equal(dreamStore.getRun(5, DAY).telemetry.promotedCount, 1, 'second pass reports only the drained backlog');
  } finally {
    cleanup();
  }
});

test('a low-score validated verdict stays a draft; validation failure never fails the dream', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '证据不足的技巧', description: '只有一次碰巧成功', capabilityType: 'skill' },
  ]);
  let validationCalls = 0;
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    performChat: async (system, user) => {
      if (system.includes('能力验证')) {
        validationCalls += 1;
        const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
        return JSON.stringify({
          verdicts: ids.map((id) => ({ id, verdict: 'validated', score: CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE - 0.2, rationale: '证据偏弱' })),
        });
      }
      return JSON.stringify({
        daily_summary: '普通的一天。',
        sections: {},
        work_reviews: [],
        important_memories: [],
        value_lessons: [],
        self_identity: LONG_IDENTITY,
        capability_learnings: [],
      });
    },
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(validationCalls, 1);
    // Below the promote threshold: still a draft, dream run unaffected.
    assert.equal(coworkStore.listCapabilityDrafts(5, { status: 'draft' }).length, 1);
    assert.equal(coworkStore.listCapabilityDrafts(5, { status: 'validated' }).length, 0);
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
  } finally {
    cleanup();
  }
});

test('validation runs even on an empty day when drafts are pending', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  // No activity seeded for DAY.
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '先验证再交付', description: '交付前自己验证一遍', capabilityType: 'workflow' },
  ]);
  let validationCalls = 0;
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    performChat: async (system, user) => {
      if (system.includes('能力验证')) {
        validationCalls += 1;
        const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
        return JSON.stringify({
          verdicts: ids.map((id) => ({ id, verdict: 'validated', score: 0.95, rationale: '铁证' })),
        });
      }
      throw new Error('empty day must not trigger the dream LLM call');
    },
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(validationCalls, 1);
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
    assert.equal(coworkStore.listCapabilityDrafts(5, { status: 'validated' }).length, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Dream-RSI P1: periodic re-review of validated drafts + retention cleanup
// ---------------------------------------------------------------------------

test('schema migration adds last_reviewed_at; pre-existing rows default to NULL', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    assert.ok(getColumns(db, 'capability_drafts').includes('last_reviewed_at'), 'missing column last_reviewed_at');
    db.run(
      `INSERT INTO capability_drafts (metabot_id, dream_date, title, description, capability_type, status, created_at)
       VALUES (5, '2026-08-01', '技巧', '描述', 'skill', 'validated', 1)`,
    );
    const row = db.exec('SELECT last_reviewed_at FROM capability_drafts')[0].values[0];
    assert.equal(row[0], null, 'pre-migration rows read as never-reviewed (selection falls back to validated_at)');
  } finally {
    cleanup();
  }
});

test('re-review selection picks the longest-unreviewed validated drafts past the interval', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    const DAYMS = 86_400_000;
    const now = Date.now();
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '最久未审', description: 'd', capabilityType: 'skill' },
      { title: '次久未审', description: 'd', capabilityType: 'skill' },
      { title: '刚审过', description: 'd', capabilityType: 'skill' },
      { title: '未验证', description: 'd', capabilityType: 'skill' },
      { title: '无评审时间戳', description: 'd', capabilityType: 'skill' },
    ]);
    const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
    for (const title of ['最久未审', '次久未审', '刚审过', '无评审时间戳']) {
      coworkStore.updateCapabilityDraftValidation({ id: byTitle(title).id, metabotId: 5, status: 'validated', validationScore: 0.9 });
    }
    db.run('UPDATE capability_drafts SET last_reviewed_at = ? WHERE id = ?', [now - 45 * DAYMS, byTitle('最久未审').id]);
    db.run('UPDATE capability_drafts SET last_reviewed_at = ? WHERE id = ?', [now - 35 * DAYMS, byTitle('次久未审').id]);
    db.run('UPDATE capability_drafts SET last_reviewed_at = ? WHERE id = ?', [now - 5 * DAYMS, byTitle('刚审过').id]);
    // Pre-migration shape: no last_reviewed_at — validated_at drives the schedule.
    db.run('UPDATE capability_drafts SET validated_at = ?, last_reviewed_at = NULL WHERE id = ?', [now - 60 * DAYMS, byTitle('无评审时间戳').id]);

    const due = coworkStore.listReReviewableCapabilityDrafts(5, { olderThanMs: now - 30 * DAYMS, limit: 5 });
    assert.deepEqual(
      due.map((draft) => draft.title),
      ['无评审时间戳', '最久未审', '次久未审'],
      'oldest panel contact first, validated only, COALESCE fallback to validated_at',
    );
    const capped = coworkStore.listReReviewableCapabilityDrafts(5, { olderThanMs: now - 30 * DAYMS, limit: 2 });
    assert.deepEqual(capped.map((draft) => draft.title), ['无评审时间戳', '最久未审'], 'limit caps the nightly batch');
    assert.equal(
      coworkStore.listReReviewableCapabilityDrafts(7, { olderThanMs: now, limit: 5 }).length,
      0,
      'other bots never leak into the selection',
    );
  } finally {
    cleanup();
  }
});

test('updateCapabilityDraftValidation stamps last_reviewed_at; markCapabilityDraftReviewed refreshes without touching status or validated_at', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [{ title: '技巧', description: 'd', capabilityType: 'skill' }]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    coworkStore.updateCapabilityDraftValidation({ id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9 });
    const after = coworkStore.listCapabilityDrafts(5)[0];
    assert.ok(after.lastReviewedAt > 0, 'verdict-panel contact stamps last_reviewed_at');

    const validatedAtBefore = after.validatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      coworkStore.markCapabilityDraftReviewed({ id: draft.id, metabotId: 5, validationScore: 0.77, validationNotes: '复审维持' }),
      true,
    );
    const refreshed = coworkStore.listCapabilityDrafts(5)[0];
    assert.ok(refreshed.lastReviewedAt > after.lastReviewedAt, 'review bookkeeping refreshes');
    assert.equal(refreshed.validationScore, 0.77, 'the panel fresh score is taken');
    assert.equal(refreshed.validationNotes, '复审维持');
    assert.equal(refreshed.validatedAt, validatedAtBefore, 'the first-verdict timestamp is untouched');
    assert.equal(refreshed.status, 'validated', 'status is untouched');
    assert.equal(coworkStore.markCapabilityDraftReviewed({ id: 99999, metabotId: 5 }), false, 'unknown id updates nothing');
  } finally {
    cleanup();
  }
});

test('purgeExpiredCapabilityDrafts deletes only expired rejected/draft rows (validated never purged)', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    const DAYMS = 86_400_000;
    const now = Date.now();
    const OLD = now - 100 * DAYMS;
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '过期否决稿', description: 'd', capabilityType: 'skill' },
      { title: '过期草案', description: 'd', capabilityType: 'skill' },
      { title: '近期否决稿', description: 'd', capabilityType: 'skill' },
      { title: '过期已验证', description: 'd', capabilityType: 'skill' },
    ]);
    coworkStore.insertCapabilityDrafts(7, '2026-08-01', [{ title: '别家过期草案', description: 'd', capabilityType: 'skill' }]);
    const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
    coworkStore.updateCapabilityDraftValidation({ id: byTitle('过期否决稿').id, metabotId: 5, status: 'rejected', validationScore: 0.3 });
    coworkStore.updateCapabilityDraftValidation({ id: byTitle('近期否决稿').id, metabotId: 5, status: 'rejected', validationScore: 0.3 });
    coworkStore.updateCapabilityDraftValidation({ id: byTitle('过期已验证').id, metabotId: 5, status: 'validated', validationScore: 0.9 });
    db.run('UPDATE capability_drafts SET created_at = ? WHERE metabot_id = 5 AND title IN (?, ?)', [OLD, '过期否决稿', '过期草案']);
    db.run('UPDATE capability_drafts SET created_at = ? WHERE title = ?', [OLD, '过期已验证']);
    db.run('UPDATE capability_drafts SET created_at = ? WHERE metabot_id = 7', [OLD]);

    const cutoff = now - 90 * DAYMS;
    assert.equal(
      coworkStore.purgeExpiredCapabilityDrafts({ cutoffMs: cutoff, excludeMetabotIds: new Set([7]) }),
      2,
      'only the expired rejected + draft rows of the included bots drain',
    );
    assert.deepEqual(
      coworkStore.listCapabilityDrafts().map((draft) => draft.title).sort(),
      ['别家过期草案', '近期否决稿', '过期已验证'].sort(),
      'recent rows, validated rows and excluded bots survive',
    );
    assert.equal(coworkStore.purgeExpiredCapabilityDrafts({ cutoffMs: cutoff }), 1, 'exclusion lifted: the other bot drains');
    assert.deepEqual(
      coworkStore.listCapabilityDrafts().map((draft) => draft.title).sort(),
      ['近期否决稿', '过期已验证'].sort(),
      'validated drafts are never purged, however old',
    );
  } finally {
    cleanup();
  }
});

test('nightly re-review demotes stale validated drafts (archiving promoted procedures) and refreshes survivors', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1000);
  seedActivity(coworkStore, db);

  const DAYMS = 86_400_000;
  const OLD = Date.now() - 31 * DAYMS;
  const RECENT = Date.now() - 5 * DAYMS;
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '过期硬技巧', description: '曾经有效的做法', capabilityType: 'skill' },
    { title: '长青技巧', description: '一直被验证的做法', capabilityType: 'workflow' },
    { title: '新晋技巧', description: '刚验证的做法', capabilityType: 'skill' },
  ]);
  const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
  for (const [title, score] of [['过期硬技巧', 0.95], ['长青技巧', 0.9], ['新晋技巧', 0.91]]) {
    coworkStore.updateCapabilityDraftValidation({ id: byTitle(title).id, metabotId: 5, status: 'validated', validationScore: score });
  }
  db.run('UPDATE capability_drafts SET validated_at = ?, last_reviewed_at = ? WHERE id = ?', [OLD, OLD, byTitle('过期硬技巧').id]);
  db.run('UPDATE capability_drafts SET validated_at = ?, last_reviewed_at = ? WHERE id = ?', [OLD, OLD, byTitle('长青技巧').id]);
  db.run('UPDATE capability_drafts SET validated_at = ?, last_reviewed_at = ? WHERE id = ?', [RECENT, RECENT, byTitle('新晋技巧').id]);
  // The stale draft was promoted into procedure memory earlier — demotion must
  // close the loop and retire the hardened lesson too.
  const promoted = knowledgeStore.upsertProcedure({
    metabotId: 5, title: '过期硬技巧', triggerText: '过期硬技巧', steps: ['曾经有效的做法'], origin: 'dream',
  });
  coworkStore.markCapabilityDraftPromoted({ id: byTitle('过期硬技巧').id, metabotId: 5, procedureId: promoted.entry.id });

  let panelCalls = 0;
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    metaidKnowledgeStore: knowledgeStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    performChat: async (system, user) => {
      if (system.includes('能力验证')) {
        panelCalls += 1;
        const verdicts = [...user.matchAll(/### 草案 #(\d+)[\s\S]*?标题:([^\n]+)/g)].map((match) => ({
          id: Number(match[1]),
          verdict: match[2].includes('过期') ? 'rejected' : 'validated',
          score: match[2].includes('过期') ? 0.5 : 0.92,
          rationale: `对照 ${DAY} 的日记裁决`,
        }));
        return JSON.stringify({ verdicts });
      }
      return JSON.stringify({
        daily_summary: '普通的一天。',
        sections: {},
        work_reviews: [],
        important_memories: [],
        value_lessons: [],
        self_identity: LONG_IDENTITY,
        capability_learnings: [],
      });
    },
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(panelCalls, 1, 'one panel covers the due re-review batch (no fresh drafts pending)');

    const demoted = byTitle('过期硬技巧');
    assert.equal(demoted.status, 'rejected', 'rejected below the promotion line demotes');
    assert.equal(demoted.validationScore, 0.5);
    assert.equal(
      knowledgeStore.getProcedure(promoted.entry.id)?.status,
      'archived',
      'the promoted procedure is archived alongside the demotion',
    );

    const maintained = byTitle('长青技巧');
    assert.equal(maintained.status, 'validated');
    assert.equal(maintained.validationScore, 0.92, 'maintained verdict takes the fresh score');
    assert.ok(maintained.lastReviewedAt > OLD, 'survivor refreshes last_reviewed_at');
    assert.equal(maintained.validatedAt, OLD, 'validated_at keeps the first-verdict timestamp');

    const notDue = byTitle('新晋技巧');
    assert.equal(notDue.status, 'validated');
    assert.equal(notDue.lastReviewedAt, RECENT, 'a recently-reviewed draft is not due');

    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.equal(telemetry.reReviewed, 2, 'the two due drafts faced the panel');
    assert.equal(telemetry.demoted, 1);
  } finally {
    cleanup();
  }
});

test('listCapabilityDrafts exposes the UI data shape consumed by dream:listCapabilityDrafts', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '形状校验', description: '字段齐全性', capabilityType: 'workflow' },
    ]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    coworkStore.updateCapabilityDraftValidation({ id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9 });
    coworkStore.markCapabilityDraftsInjected([draft.id]);
    coworkStore.markCapabilityDraftPromoted({ id: draft.id, metabotId: 5, procedureId: 'proc-1' });

    const row = coworkStore.listCapabilityDrafts(5)[0];
    // The exact field set the MemorySettings capability-drafts panel renders.
    for (const field of ['id', 'metabotId', 'dreamDate', 'title', 'description', 'capabilityType', 'status', 'createdAt', 'validationScore', 'validationNotes', 'validatedAt', 'timesInjected', 'lastInjectedAt', 'promotedAt', 'promotedProcedureId', 'lastReviewedAt']) {
      assert.ok(field in row, `draft row carries ${field}`);
    }
    assert.equal(row.status, 'validated');
    assert.equal(row.validationScore, 0.9);
    assert.equal(row.timesInjected, 1);
    assert.ok(row.validatedAt > 0);
    assert.ok(row.promotedAt > 0);
    assert.equal(row.promotedProcedureId, 'proc-1');
    assert.ok(row.lastReviewedAt > 0);
  } finally {
    cleanup();
  }
});
