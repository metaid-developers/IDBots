import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  extractNegativeDecisionPoints,
  hasExplicitHumanFeedback,
  buildCounterfactualReplayPrompt,
  parseCounterfactualReplayOutput,
  pickCounterfactualLesson,
  COUNTERFACTUAL_MAX_POINTS,
} = require('../dist-electron/main/libs/counterfactualReplayPrompt.js');

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

const DAY = '2026-08-04';
const DAY_START = new Date(2026, 7, 4).getTime();
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

test('extract picks thumbs-down replies with context, comment first, capped', () => {
  const messages = [
    { type: 'user', content: '帮我剪个视频', createdAt: 1 },
    { type: 'assistant', content: '好的马上', createdAt: 2, feedbackRating: 'down' },
    { type: 'user', content: '太慢了', createdAt: 3 },
    { type: 'assistant', content: '已经完成了', createdAt: 4, feedbackRating: 'down', feedbackComment: '根本没做完' },
    { type: 'assistant', content: '这条被赞了', createdAt: 5, feedbackRating: 'up' },
  ];
  const activity = {
    sessions: [{ sessionId: 's1', title: '剪视频', sessionType: 'standard', peerName: null, isOrder: false, messages }],
    taskRuns: [],
    orderCount: 0,
    groupTasks: [],
  };
  const points = extractNegativeDecisionPoints(activity);
  assert.equal(points.length, 2);
  // Commented thumbs-down sorts first.
  assert.equal(points[0].id, 'msg:s1:3');
  assert.ok(points[0].outcome.includes('根本没做完'));
  assert.ok(points[0].situation.includes('太慢了'));
  assert.equal(points[1].id, 'msg:s1:1');
  assert.ok(points.every((point) => point.kind === 'thumbs_down'));
});

test('extract picks low-rated accepted group tasks and ignores active ones', () => {
  const activity = {
    sessions: [],
    taskRuns: [],
    orderCount: 0,
    groupTasks: [
      { taskId: 7, title: '官网海报', goal: '做一张海报', memberRole: 'worker', rating: 2, ratingComment: '风格不对', phase: 'accepted' },
      { taskId: 8, title: '进行中的任务', goal: '还没验收', memberRole: 'chair', rating: null, ratingComment: null, phase: 'active' },
      { taskId: 9, title: '高分任务', goal: '做得好', memberRole: 'worker', rating: 5, ratingComment: null, phase: 'accepted' },
    ],
  };
  const points = extractNegativeDecisionPoints(activity);
  assert.equal(points.length, 1);
  assert.equal(points[0].id, 'task:7');
  assert.ok(points[0].outcome.includes('2/5'));
  assert.ok(points[0].outcome.includes('风格不对'));
});

test('extract caps the number of points', () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: `消息${index}`,
    createdAt: index,
    ...(index % 2 === 1 ? { feedbackRating: 'down' } : {}),
  }));
  const activity = {
    sessions: [{ sessionId: 's1', title: 't', sessionType: 'standard', peerName: null, isOrder: false, messages }],
    taskRuns: [],
    orderCount: 0,
    groupTasks: [],
  };
  assert.equal(extractNegativeDecisionPoints(activity).length, COUNTERFACTUAL_MAX_POINTS);
});

test('parser tolerates fences, clamps scores, drops unknown ids, caps alternatives', () => {
  const validIds = new Set(['msg:s1:1', 'task:7']);
  const raw = '```json\n{"results":[{"id":"msg:s1:1","original_score":0.2,"alternatives":[{"action":"a","score":1.4},{"action":"b","score":0.5},{"action":"c","score":0.1}],"lesson":"规则一"},{"id":"ghost","original_score":0,"alternatives":[],"lesson":"x"},{"id":"task:7","original_score":0.6,"alternatives":[],"lesson":""}]}\n```';
  const parsed = parseCounterfactualReplayOutput(raw, validIds);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0].alternatives.length, 2);
  assert.equal(parsed.results[0].alternatives[0].score, 1);
  assert.equal(parsed.results[1].lesson, '');
  assert.equal(parseCounterfactualReplayOutput('', validIds).ok, false);
  assert.equal(parseCounterfactualReplayOutput('{"nope":1}', validIds).ok, false);
});

test('pickCounterfactualLesson enforces margin and absolute score', () => {
  const base = { id: 'p1', lesson: '先验证再交付' };
  assert.equal(
    pickCounterfactualLesson({ ...base, originalScore: 0.3, alternatives: [{ action: 'a', score: 0.85 }] }),
    '先验证再交付',
  );
  // Margin too small.
  assert.equal(
    pickCounterfactualLesson({ ...base, originalScore: 0.7, alternatives: [{ action: 'a', score: 0.85 }] }),
    null,
  );
  // Best alternative too weak in absolute terms.
  assert.equal(
    pickCounterfactualLesson({ ...base, originalScore: 0.1, alternatives: [{ action: 'a', score: 0.5 }] }),
    null,
  );
  // No lesson proposed.
  assert.equal(
    pickCounterfactualLesson({ id: 'p1', lesson: '', originalScore: 0.2, alternatives: [{ action: 'a', score: 0.9 }] }),
    null,
  );
});

test('prompt embeds situation, action and outcome per point', () => {
  const prompt = buildCounterfactualReplayPrompt({
    botName: '小火',
    date: DAY,
    points: [{
      id: 'msg:s1:3',
      kind: 'thumbs_down',
      situation: '会话「剪视频」:\n对方: 太慢了',
      botAction: '已经完成了',
      outcome: '人类对这条回复点了踩,并留言:「根本没做完」',
    }],
  });
  assert.ok(prompt.system.includes('反事实重放'));
  assert.ok(prompt.user.includes('决策点 msg:s1:3'));
  assert.ok(prompt.user.includes('太慢了'));
  assert.ok(prompt.user.includes('根本没做完'));
});

test('dream run replays negative points and writes only simulation-validated lessons', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('剪视频', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['u1', session.id, 'user', '视频做完了吗', '{}', DAY_START + 1000, 1]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '做完了,完美', '{}', DAY_START + 2000, 2]
  );
  db.run(
    'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'down', '根本没做完', DAY_START + 3000, DAY_START + 3000]
  );

  const calls = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 5, 3, 0),
    performChat: async (system, user) => {
      calls.push({ system, user });
      if (system.includes('反事实重放')) {
        const ids = [...user.matchAll(/### 决策点 (\S+?)\(/g)].map((match) => match[1]);
        return JSON.stringify({
          results: ids.map((id) => ({
            id,
            original_score: 0.3,
            alternatives: [{ action: '先自查再回复', score: 0.85 }],
            lesson: '回复交付类问题前先自己验证一遍',
          })),
        });
      }
      return JSON.stringify({
        daily_summary: '今天回复太快被踩了。',
        sections: {},
        work_reviews: [],
        important_memories: [],
        value_lessons: [
          { rule: '有来源的规则', source: '用户踩了那条回复' },
          { rule: '没有来源的规则不该入库' },
        ],
        self_identity: LONG_IDENTITY,
        capability_learnings: [],
      });
    },
  });
  try {
    await service.runNow(5, DAY);

    // Dream call + counterfactual replay call (no capability drafts → no validation call).
    assert.equal(calls.length, 2);
    assert.ok(calls[1].system.includes('反事实重放'));
    assert.ok(calls[1].user.includes('根本没做完'));

    const boundaries = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'value_boundary', status: 'all',
    });
    const texts = boundaries.map((memory) => memory.text);
    // P1b evidence gate: the unsourced lesson is dropped, the sourced one kept.
    assert.ok(texts.some((text) => text.includes('有来源的规则')));
    assert.ok(!texts.some((text) => text.includes('没有来源的规则')));
    // P1a: the counterfactual lesson cleared the margin gate and was written.
    assert.ok(texts.some((text) => text.includes('回复交付类问题前先自己验证一遍') && text.includes('反事实重放')));
  } finally {
    cleanup();
  }
});

test('replay writes nothing when the alternative does not clearly beat the original', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('剪视频', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '做完了', '{}', DAY_START + 1000, 1]
  );
  db.run(
    'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'down', null, DAY_START + 2000, DAY_START + 2000]
  );

  let replayCalls = 0;
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 5, 3, 0),
    performChat: async (system, user) => {
      if (system.includes('反事实重放')) {
        replayCalls += 1;
        const ids = [...user.matchAll(/### 决策点 (\S+?)\(/g)].map((match) => match[1]);
        return JSON.stringify({
          results: ids.map((id) => ({
            id,
            original_score: 0.6,
            alternatives: [{ action: '换个说法', score: 0.7 }],
            lesson: '这条不该被写入,优势不明显',
          })),
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
    assert.equal(replayCalls, 1);
    const boundaries = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'value_boundary', status: 'all',
    });
    assert.ok(!boundaries.some((memory) => memory.text.includes('反事实重放')));
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
  } finally {
    cleanup();
  }
});

test('a clean day (no negative points) skips the replay LLM call entirely', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('聊天', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '你好呀', '{}', DAY_START + 1000, 1]
  );

  const systems = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 5, 3, 0),
    performChat: async (system) => {
      systems.push(system);
      return JSON.stringify({
        daily_summary: '平静的一天。',
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
    assert.equal(systems.length, 1);
    assert.ok(!systems[0].includes('反事实重放'));
  } finally {
    cleanup();
  }
});

test('hasExplicitHumanFeedback flags thumbs and acceptance ratings, not implicit-only days', () => {
  const base = { sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] };
  assert.equal(hasExplicitHumanFeedback(base), false, 'empty day has none');
  assert.equal(
    hasExplicitHumanFeedback({
      ...base,
      implicitSignals: [{ kind: 'reask', sessionId: 's1', messageIndex: 2, text: '对方又问了一遍同样的问题' }],
    }),
    false,
    'implicit signals alone are not explicit feedback',
  );
  assert.equal(
    hasExplicitHumanFeedback({
      ...base,
      sessions: [{
        sessionId: 's1', title: 't', sessionType: 'standard', peerName: null, isOrder: false,
        messages: [{ type: 'assistant', content: '好', createdAt: 1, feedbackRating: 'up' }],
      }],
    }),
    true,
    'a thumbs-up counts (the feedback channel was exercised)',
  );
  assert.equal(
    hasExplicitHumanFeedback({
      ...base,
      sessions: [{
        sessionId: 's1', title: 't', sessionType: 'standard', peerName: null, isOrder: false,
        messages: [{ type: 'assistant', content: '好', createdAt: 1, feedbackRating: 'down' }],
      }],
    }),
    true,
    'a thumbs-down counts',
  );
  assert.equal(
    hasExplicitHumanFeedback({
      ...base,
      groupTasks: [{ taskId: 7, title: '官网海报', goal: 'g', memberRole: 'worker', rating: 5, ratingComment: null, phase: 'accepted' }],
    }),
    true,
    'an acceptance rating counts',
  );
  assert.equal(
    hasExplicitHumanFeedback({
      ...base,
      groupTasks: [{ taskId: 8, title: '未评分任务', goal: 'g', memberRole: 'chair', rating: null, ratingComment: null, phase: 'accepted' }],
    }),
    false,
    'an unrated closure is not explicit feedback',
  );
});
