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
    for (const column of ['times_injected', 'last_injected_at']) {
      assert.ok(getColumns(db, 'capability_drafts').includes(column), `missing column ${column}`);
    }
    db.run(
      `INSERT INTO capability_drafts (metabot_id, dream_date, title, description, capability_type, status, created_at)
       VALUES (5, '2026-08-01', '技巧', '描述', 'skill', 'validated', 1)`,
    );
    const row = db.exec('SELECT times_injected, last_injected_at FROM capability_drafts')[0].values[0];
    assert.equal(row[0], 0, 'times_injected defaults to 0');
    assert.equal(row[1], null, 'last_injected_at defaults to NULL');
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
