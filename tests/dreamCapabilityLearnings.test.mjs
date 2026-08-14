/**
 * Phase 4 (SDD R4.2/R4.3) dream capability_learnings tests.
 *
 * Covers:
 *   1. parseDreamOutput — capability_learnings parsing (snake_case and
 *      camelCase), missing -> [], 5-item cap, invalid entries skipped,
 *      capabilityType normalization, sourceSessionIds extraction,
 *   2. buildDreamPrompt — the user JSON template and the system line both
 *      mention capability_learnings,
 *   3. draft persistence — `insertCapabilityDrafts` + `listCapabilityDrafts`
 *      on a real CoworkStore over an in-memory sql.js database, including the
 *      R4.3 no-pollution guarantee (no rows land in `user_memories`),
 *   4. end-to-end dream run — `runNow` with a stubbed LLM returning
 *      capability_learnings writes draft rows (dreamService.test.mjs pattern).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);

function loadCompiledModule(relative) {
  const candidates = [`../dist-electron/main/${relative}`, `../dist-electron/${relative}`];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try next compile output layout.
    }
  }
  return require(candidates[0]);
}

const { parseDreamOutput, buildDreamPrompt, DREAM_VERSION } = loadCompiledModule('libs/dreamPrompt.js');

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
    const compiledRoot = require.resolve('../dist-electron/main/services/dreamService.js');
    return require(compiledRoot);
  } catch {
    return require('../dist-electron/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();

const LONG_IDENTITY = `我是一个专注于视频创作的 MetaBot,名叫小火。${'我认真对待每一次交付,先验证再交付。'.repeat(10)}`;

const makePayload = (capabilityLearnings, overrides = {}) => JSON.stringify({
  daily_summary: '今天为用户交付了演示视频,并沉淀了可复用的视频制作流程。',
  sections: { human: '和用户确认视频效果' },
  work_reviews: [],
  important_memories: ['用户喜欢先验证再交付的节奏'],
  value_lessons: [],
  self_identity: LONG_IDENTITY,
  ...(capabilityLearnings !== undefined ? { capability_learnings: capabilityLearnings } : {}),
  ...overrides,
});

test('parseDreamOutput parses capability_learnings (snake_case)', () => {
  const result = parseDreamOutput(makePayload([
    {
      title: '快速制作演示视频',
      description: '先收集素材,再剪辑,最后让用户确认效果。',
      capabilityType: 'workflow',
      sourceSessionIds: ['sess-1', 'sess-2'],
    },
    {
      title: '批量文件重命名',
      description: '用工具按规则批量重命名文件。',
      capabilityType: 'tool_pattern',
    },
  ]));
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.deepEqual(output.capabilityLearnings, [
    {
      title: '快速制作演示视频',
      description: '先收集素材,再剪辑,最后让用户确认效果。',
      capabilityType: 'workflow',
      sourceSessionIds: ['sess-1', 'sess-2'],
    },
    {
      title: '批量文件重命名',
      description: '用工具按规则批量重命名文件。',
      capabilityType: 'tool_pattern',
      sourceSessionIds: [],
    },
  ]);
});

test('parseDreamOutput parses camelCase capabilityLearnings and normalizes capabilityType', () => {
  const result = parseDreamOutput(makePayload([
    {
      title: ' 一条技能 ',
      description: ' 描述 ',
      capabilityType: 'SKILL',
    },
    {
      title: '未知类型',
      description: '描述',
      capabilityType: 'whatever',
    },
  ], {}).replace('"capability_learnings"', '"capabilityLearnings"'));
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.deepEqual(output.capabilityLearnings, [
    { title: '一条技能', description: '描述', capabilityType: 'skill', sourceSessionIds: [] },
    { title: '未知类型', description: '描述', capabilityType: 'skill', sourceSessionIds: [] },
  ]);
});

test('parseDreamOutput tolerates missing capability_learnings as an empty array', () => {
  const result = parseDreamOutput(makePayload(undefined));
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.deepEqual(output.capabilityLearnings, []);
});

test('parseDreamOutput caps capability_learnings at 5 and skips invalid entries', () => {
  const learnings = [];
  for (let index = 1; index <= 8; index += 1) {
    learnings.push({ title: `能力 ${index}`, description: `描述 ${index}`, capabilityType: 'skill' });
  }
  // Two invalid entries (missing description / missing title) are skipped.
  learnings.push({ title: '没有描述', capabilityType: 'skill' });
  learnings.push({ description: '没有标题', capabilityType: 'skill' });

  const result = parseDreamOutput(makePayload(learnings));
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.equal(output.capabilityLearnings.length, 5);
  assert.deepEqual(output.capabilityLearnings.map((entry) => entry.title), [
    '能力 1', '能力 2', '能力 3', '能力 4', '能力 5',
  ]);
});

test('buildDreamPrompt instructs the model to output capability_learnings', () => {
  const prompt = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: [],
      taskRuns: [],
      orderCount: 0,
      groupTasks: [],
    },
  });
  assert.match(prompt.system, /capability_learnings/);
  assert.match(prompt.user, /"capability_learnings"/);
  assert.match(prompt.user, /capabilityType/);
  assert.match(prompt.system, /reusable skills\/workflows/);
});

test('draft persistence: insertCapabilityDrafts + listCapabilityDrafts, no user_memories pollution', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);

    const beforeMemories = coworkStore.listUserMemories({ metabotId: 5, status: 'all', includeDeleted: true });
    assert.equal(beforeMemories.length, 0, 'user_memories starts empty');

    const inserted = coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '演示视频工作流', description: '先素材后剪辑再确认。', capabilityType: 'workflow' },
      { title: '   ', description: '空标题条目被跳过,不应该插入', capabilityType: 'skill' },
      { title: '批处理工具模式', description: '按规则批量重命名。', capabilityType: 'tool_pattern' },
      { title: '默认类型', description: '不传类型默认 skill。' },
    ]);
    assert.equal(inserted, 3, 'only valid entries are inserted');

    const drafts = coworkStore.listCapabilityDrafts(5);
    assert.equal(drafts.length, 3);
    const byTitle = new Map(drafts.map((draft) => [draft.title, draft]));
    const workflow = byTitle.get('演示视频工作流');
    assert.equal(workflow.metabotId, 5);
    assert.equal(workflow.dreamDate, '2026-08-01');
    assert.equal(workflow.capabilityType, 'workflow');
    assert.equal(workflow.status, 'draft');
    assert.equal(typeof workflow.createdAt, 'number');
    assert.equal(byTitle.get('批处理工具模式').capabilityType, 'tool_pattern');
    assert.equal(byTitle.get('默认类型').capabilityType, 'skill');

    // R4.3: the memory tables stay untouched by draft writes.
    const afterMemories = coworkStore.listUserMemories({ metabotId: 5, status: 'all', includeDeleted: true });
    assert.equal(afterMemories.length, 0, 'capability drafts must not create user_memories rows');

    // listCapabilityDrafts() without a bot id returns everything.
    const allDrafts = coworkStore.listCapabilityDrafts();
    assert.equal(allDrafts.length, 3);

    // Another bot's drafts are isolated.
    assert.equal(coworkStore.listCapabilityDrafts(99).length, 0);
  } finally {
    cleanup();
  }
});

test('end-to-end: runNow persists capability_learnings as drafts (R4.2)', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const { DreamStore } = loadCompiledModule('dreamStore.js');
    const dreamStore = new DreamStore(db, () => {});
    const DAY = '2026-07-30';
    const DAY_START = new Date(2026, 6, 30).getTime();

    const session = coworkStore.createSession('视频交付', '/tmp/a', '', 'local', [], 5);
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['m1', session.id, 'user', '视频做好了吗', '{}', DAY_START + 1000, 1],
    );
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['m2', session.id, 'assistant', '做好了,你看下', '{}', DAY_START + 2000, 2],
    );

    const service = new DreamService({
      coworkStore,
      metabotStore: {
        listMetabots: () => [
          { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
        ],
      },
      dreamStore,
      performChat: async () => makePayload([
        { title: '演示视频交付流程', description: '先确认需求,再制作,最后请用户验收。', capabilityType: 'workflow' },
      ]),
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 1, 3, 0),
    });

    await service.runNow(5, DAY);

    const drafts = coworkStore.listCapabilityDrafts(5);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].title, '演示视频交付流程');
    assert.equal(drafts[0].dreamDate, DAY);
    assert.equal(drafts[0].capabilityType, 'workflow');
    assert.equal(drafts[0].status, 'draft');
    assert.equal(DREAM_VERSION, 8, 'dream version should be bumped for the new output channel');
  } finally {
    cleanup();
  }
});
