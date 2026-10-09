import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

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
    return require('../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();
const { DREAM_VERSION } = require('../dist-electron/main/libs/dreamPrompt.js');

const {
  DREAM_RETRY_MAX_ATTEMPTS,
} = require('../dist-electron/main/libs/dreamRetryPolicy.js');

const DAY = '2026-07-30';
const DAY_START = new Date(2026, 6, 30).getTime();

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
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m3', session.id, 'user', '太棒了,就是这个效果', '{}', DAY_START + 3000, 3]
  );
  return session;
};

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const LONG_IDENTITY = `我是一个专注于视频创作的 MetaBot,名叫小火。${'我认真对待每一次交付,先验证再交付。'.repeat(10)}`;

const makePayload = (overrides = {}) => JSON.stringify({
  daily_summary: '今天为用户交付了演示视频,获得高度赞扬。',
  sections: { human: '和用户确认视频效果' },
  work_reviews: [
    { subject: '制作演示视频', counterparty: '用户', evaluation: 'warming', note: '用户从只回表情到主动追问细节' },
  ],
  important_memories: ['用户喜欢先验证再交付的节奏'],
  value_lessons: [{ rule: '交付前先自己验证一遍', source: '用户连续追问了两处细节' }],
  self_identity: LONG_IDENTITY,
  ...overrides,
});

const setup = async (performChat, extraDeps = {}) => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/main/dreamStore.js'));
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  const events = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    performChat,
    emitToRenderer: (channel, payload) => events.push({ channel, payload }),
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 1, 3, 0),
    ...extraDeps,
  });
  return { db, cleanup, coworkStore, dreamStore, service, events };
};

test('runNow completes the full dream pipeline and writes all artifacts', async () => {
  const calls = [];
  const { cleanup, coworkStore, dreamStore, service, events } = await setup(async (system, user, llmId, options) => {
    calls.push({
      llmId,
      maxTokens: options?.maxTokens,
      throwOnEmptyContent: options?.throwOnEmptyContent,
      thinking: options?.thinking,
    });
    return makePayload();
  });
  try {
    await service.runNow(5, DAY);

    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'completed');
    assert.equal(run.llmId, 'bot-own-llm');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxTokens, 32768);
    assert.equal(calls[0].throwOnEmptyContent, true);
    assert.equal(calls[0].thinking, 'disabled');

    const summary = dreamStore.getDailySummary(5, DAY);
    assert.equal(summary.summaryText, '今天为用户交付了演示视频,获得高度赞扬。');
    assert.equal(summary.sections.human, '和用户确认视频效果');
    assert.equal(summary.stats.sessionCount, 1);
    assert.equal(summary.stats.messageCount, 3);
    assert.equal(summary.stats.activityCharCount, '视频做好了吗'.length + '做好了,你看下'.length + '太棒了,就是这个效果'.length);
    assert.ok(summary.stats.estimatedActivityTokens > 0);
    assert.equal(summary.sessionRefs.length, 1);
    assert.equal(summary.sessionRefs[0].title, '和用户聊发布');
    assert.equal(summary.sessionRefs[0].sessionType, 'standard');

    const dreamMemories = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', origin: 'dream', status: 'all',
    });
    const byClass = (cls) => dreamMemories.filter((m) => m.usageClass === cls);
    assert.equal(byClass('profile_fact').length, 1);
    assert.equal(byClass('profile_fact')[0].text, '用户喜欢先验证再交付的节奏');
    assert.equal(byClass('work_review').length, 1);
    assert.ok(byClass('work_review')[0].text.includes('升温'));
    assert.equal(byClass('value_boundary').length, 1);
    assert.ok(byClass('value_boundary')[0].text.includes('交付前先自己验证一遍'));
    assert.ok(byClass('value_boundary')[0].text.includes('源自:'));
    assert.equal(byClass('value_boundary')[0].origin, 'dream');
    assert.equal(byClass('self_identity').length, 1);
    assert.equal(byClass('self_identity')[0].text, LONG_IDENTITY);
    assert.equal(byClass('self_identity')[0].origin, 'dream');

    // Protection still holds for dream-written identity entries.
    const identity = byClass('self_identity')[0];
    assert.equal(coworkStore.updateUserMemory({ id: identity.id, metabotId: 5, text: '篡改' }), null);

    // Dreaming status events bracket the run.
    assert.deepEqual(events, [
      { channel: 'metabot:dreamStatusChanged', payload: { metabotId: 5, dreaming: true } },
      { channel: 'metabot:dreamStatusChanged', payload: { metabotId: 5, dreaming: false } },
    ]);
    assert.equal(service.isDreaming(5), false);
  } finally {
    cleanup();
  }
});

test('large activity uses resumable map-reduce fragments and reuses completed fragments', async () => {
  const calls = [];
  const ctx = await setup(async (system, user, llmId, options) => {
    calls.push({ system, user, llmId, maxTokens: options?.maxTokens, attemptTimeoutMs: options?.attemptTimeoutMs });
    return makePayload();
  });
  try {
    const sessionId = firstSessionId(ctx.db);
    for (let index = 0; index < 70; index += 1) {
      ctx.db.run(
        'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [`large-${index}`, sessionId, index % 2 === 0 ? 'user' : 'assistant', `${index % 2 === 0 ? '用户' : '我'}:${'当天的长对话内容'.repeat(140)}`, '{}', DAY_START + 10_000 + index, 10 + index]
      );
    }

    // Chain content of that day: day-level evidence that must survive the
    // fragment map-reduce path into the final synthesis prompt.
    ctx.db.run(
      'INSERT INTO metabot_chain_writes (metabot_id, pin_id, path, operation, content_text, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [5, 'chain-w1', '/protocols/simplebuzz', 'create', '今天试了链上记录功能', DAY_START + 4000]
    );
    ctx.db.run(
      'INSERT INTO metabot_chain_reads (metabot_id, pin_id, path, protocol, title, content_excerpt, first_read_at_ms, last_read_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [5, 'chain-r1', '/protocols/simplenote', 'simplenote', 'MetaWeb 使用指南', '指南正文', DAY_START + 5000, DAY_START + 5000]
    );

    await ctx.service.runNow(5, DAY);
    const fragments = ctx.dreamStore.listDreamFragments(5, DAY);
    assert.ok(fragments.length > 1, 'large day should produce multiple fragments');
    assert.ok(fragments.every((fragment) => fragment.status === 'completed'));
    assert.ok(calls.some((call) => call.user.includes('分块提炼阶段')));
    assert.ok(calls.some((call) => call.user.includes('分块证据摘要')));
    assert.ok(calls.some((call) => call.maxTokens === 16384), 'fragment calls on an unknown-family brain (may think) get reasoning headroom (2026-09-20 glm-5.3 empty-output outage)');
    // Post-dream passes (capability validation / counterfactual replay) run
    // AFTER the dream call, so locate the synthesis by content, not position.
    const synthesisCall = calls.find((call) => call.user.includes('分块证据摘要'));
    assert.ok(synthesisCall, 'fragment synthesis call exists');
    assert.equal(synthesisCall.maxTokens, 32768, 'final synthesis uses the default model output limit');
    // 2026-09-23 midday force-dream: every fragment first-try green, but the
    // synthesis hit the 180s wall on BOTH brains (30K-token prompt + full
    // dream JSON at flash-tier speed). Synthesis (and self-identity) ride the
    // wide 10-minute window — sized for the worst legitimate case (throttled
    // ~20-25 tok/s generation of a 6-8K-token JSON + 30K-token prefill);
    // fragments keep the lean default (here the test's 5s llmTimeoutMs
    // override).
    assert.equal(synthesisCall.attemptTimeoutMs, 600000, 'synthesis gets the wide 600s window');
    const fragmentCall = calls.find((call) => call.user.includes('分块提炼阶段'));
    assert.ok(fragmentCall, 'fragment call exists');
    assert.equal(fragmentCall.attemptTimeoutMs, 5000, 'fragment calls keep the configured lean window');
    assert.ok(synthesisCall.user.includes('## 当日写入链上的内容'), 'synthesis keeps published chain content');
    assert.ok(synthesisCall.user.includes('今天试了链上记录功能'), 'synthesis renders the write text');
    assert.ok(synthesisCall.user.includes('## 当日阅读的链上内容'), 'synthesis keeps read chain content');
    assert.ok(synthesisCall.user.includes('MetaWeb 使用指南'), 'synthesis renders the read title');
    const attemptsBefore = fragments.map((fragment) => fragment.attemptCount);
    const callsBefore = calls.length;

    await ctx.service.runNow(5, DAY);
    // Retry = synthesis + counterfactual replay (the repetitive fixture day
    // yields an implicit re-ask signal); fragments stay cached.
    assert.equal(calls.length, callsBefore + 2, 'a retry reuses completed fragments and only reruns synthesis + post-dream passes');
    assert.deepEqual(
      ctx.dreamStore.listDreamFragments(5, DAY).map((fragment) => fragment.attemptCount),
      attemptsBefore,
    );
    const retriedSynthesis = calls.slice(callsBefore).find((call) => call.user.includes('分块证据摘要'));
    assert.ok(retriedSynthesis.user.includes('## 当日写入链上的内容'), 'retried synthesis still carries chain content');
  } finally {
    ctx.cleanup();
  }
});

test('fragment budget stays compact for a brain that can truly disable thinking', async () => {
  // Contrast with the unknown-family case above: deepseek-flash honors
  // thinking:{type:'disabled'} (reasoning effort none), so its fragments keep
  // the lean 4K ceiling — the thinking-headroom bump applies only to brains
  // that may think anyway (GLM-5.x, unknown families).
  const calls = [];
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/main/dreamStore.js'));
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  const sessionId = firstSessionId(db);
  for (let index = 0; index < 70; index += 1) {
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [`ds-${index}`, sessionId, index % 2 === 0 ? 'user' : 'assistant', `${index % 2 === 0 ? '用户' : '我'}:${'当天的长对话内容'.repeat(140)}`, '{}', DAY_START + 10_000 + index, 10 + index]
    );
  }
  const service = new DreamService({
    coworkStore,
    metabotStore: {
      listMetabots: () => [
        { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'deepseek-flash', enabled: true },
      ],
    },
    dreamStore,
    performChat: async (system, user, llmId, options) => {
      calls.push({ llmId, maxTokens: options?.maxTokens });
      return makePayload();
    },
    emitToRenderer: () => {},
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 1, 3, 0),
  });
  try {
    await service.runNow(5, DAY);
    assert.ok(calls.some((call) => call.maxTokens === 4096), 'deepseek brain fragments keep the compact 4K ceiling');
    assert.ok(calls.every((call) => call.maxTokens !== 16384), 'no thinking-headroom ceiling for a disable-capable brain');
  } finally {
    cleanup();
  }
});

test('diary trust audit grounds quoted spans against titles and raw record text', async () => {
  // 2026-09-23 precision fix: the old counter only knew four title kinds, so
  // quoted dialogue catchphrases, chain-read concepts and surf phrases all
  // scored as "hallucinations" (the twin bot's rising trend was ~9/15 false
  // positives on a spot audit). A span is grounded when it matches a record
  // TITLE (now including chain-read titles) or anchors in the day's RAW TEXT
  // (message bodies, chain-write/read content, surf report) verbatim or via
  // a substantial fragment.
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/main/dreamStore.js'));
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db); // session 「和用户聊发布」, messages incl. 视频做好了吗
  db.run(
    'INSERT INTO metabot_chain_reads (metabot_id, pin_id, path, protocol, title, content_excerpt, first_read_at_ms, last_read_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [5, 'chain-g1', '/protocols/simplenote', 'simplenote', '链上必读指南', '争议判定要点:密文相同 即视为同一载荷的铁证依据', DAY_START + 5000, DAY_START + 5000]
  );
  const service = new DreamService({
    coworkStore,
    metabotStore: {
      listMetabots: () => [
        { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'deepseek-flash', enabled: true },
      ],
    },
    dreamStore,
    performChat: async () => makePayload({
      daily_summary: '今天在「和用户聊发布」里反复确认,用户问「视频做好了吗」;顺带读了「链上必读指南」,里面强调「密文相同=同载荷铁证」。还提到「根本不存在的事」。',
    }),
    emitToRenderer: () => {},
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 1, 3, 0),
  });
  try {
    await service.runNow(5, DAY);
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'completed');
    const telemetry = run.telemetry ?? {};
    assert.equal(telemetry.diaryTotalRefs, 5, 'all five quoted spans are counted in the denominator');
    assert.equal(
      telemetry.diaryUnmatchedRefs, 1,
      'title match + verbatim message anchor + chain-read title + fragment anchor ground four spans; only the fabricated one counts',
    );
  } finally {
    cleanup();
  }
});

test('cross-night dedup merges near-duplicate memory writes and reports dedupMerged in the run telemetry', async () => {
  const DAY2 = '2026-07-31';
  const DAY2_START = new Date(2026, 6, 31).getTime();
  const payloads = [];
  const { db, cleanup, coworkStore, dreamStore, service } = await setup(async () =>
    payloads.length > 0 ? payloads.shift() : makePayload()
  );
  try {
    // Day-2 activity so the second run has a non-empty day.
    const session2 = coworkStore.createSession('和客户聊海报', '/tmp/b', '', 'local', [], 5);
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['d2-m1', session2.id, 'user', '海报初稿好了吗', '{}', DAY2_START + 1000, 1]
    );
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['d2-m2', session2.id, 'assistant', '好了,请验收', '{}', DAY2_START + 2000, 2]
    );

    payloads.push(makePayload({
      important_memories: ['付费写链授权是硬规则:任何付费服务的链上写操作必须先取得人类明确授权,绝不垫付'],
    }));
    await service.runNow(5, DAY);
    payloads.push(makePayload({
      // Night 2 restates the same hard rule with one clause appended.
      important_memories: ['付费写链授权是硬规则:任何付费服务的链上写操作必须先取得人类明确授权,绝不垫付,也不许代签'],
    }));
    await service.runNow(5, DAY2);

    const facts = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'profile_fact', origin: 'dream', status: 'all',
    });
    assert.equal(facts.length, 1, 'the reworded rule refreshed the old row instead of adding a variant');
    const night1Telemetry = dreamStore.getRun(5, DAY).telemetry ?? {};
    assert.equal(night1Telemetry.dedupMerged, 0, 'first night had nothing to merge');
    const night2Telemetry = dreamStore.getRun(5, DAY2).telemetry ?? {};
    assert.equal(
      night2Telemetry.dedupMerged,
      3,
      'all three corroborated classes (important_memories + value_lessons + work_reviews) merged on night 2',
    );
  } finally {
    cleanup();
  }
});

test('a concurrent manual trigger waits for the active queue run', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { cleanup, dreamStore, service } = await setup(async () => {
    calls += 1;
    await blocked;
    return makePayload();
  });
  try {
    const first = service.runNow(5, DAY);
    while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = service.runNow(5, DAY);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
  } finally {
    cleanup();
  }
});

test('empty day completes without calling the LLM or writing a summary', async () => {
  let calls = 0;
  const { cleanup, dreamStore, service } = await setup(async () => {
    calls += 1;
    return makePayload();
  });
  try {
    await service.runNow(5, '2026-07-29');
    assert.equal(calls, 0);
    assert.equal(dreamStore.getRun(5, '2026-07-29').status, 'completed');
    assert.equal(dreamStore.getDailySummary(5, '2026-07-29'), null);
  } finally {
    cleanup();
  }
});

test('unparseable output retries once then fails the run, not the service', async () => {
  let calls = 0;
  const { cleanup, dreamStore, service } = await setup(async () => {
    calls += 1;
    return '这不是 JSON';
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(calls, 2, 'one fix-up retry');
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'failed');
    assert.ok(run.error?.includes('unparseable'));
  } finally {
    cleanup();
  }
});

test('short self_identity triggers one expansion retry and keeps the long version', async () => {
  const seen = [];
  const { cleanup, coworkStore, service } = await setup(async (system, user) => {
    seen.push(user);
    return seen.length === 1 ? makePayload({ self_identity: '太短' }) : makePayload();
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(seen.length, 2);
    assert.ok(seen[1].includes('不少于 200'));

    const identities = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'self_identity', status: 'all',
    });
    assert.equal(identities.length, 1);
    assert.equal(identities[0].text, LONG_IDENTITY);
  } finally {
    cleanup();
  }
});

test('re-dreaming the same date replaces the day batch and updates identity in place', async () => {
  const { cleanup, coworkStore, dreamStore, service } = await setup(async () => makePayload());
  try {
    await service.runNow(5, DAY);
    await service.runNow(5, DAY);

    const identities = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'self_identity', status: 'all',
    });
    assert.equal(identities.length, 1, 'still exactly one identity entry');

    const dreamMemories = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', origin: 'dream', status: 'all',
    });
    const byClass = (cls) => dreamMemories.filter((m) => m.usageClass === cls);
    assert.equal(byClass('profile_fact').length, 1, 're-dream replaces the day batch instead of duplicating it');
    assert.equal(byClass('work_review').length, 1);
    assert.equal(byClass('value_boundary').length, 1);

    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'completed');
    assert.equal(run.attemptCount, 2);
    assert.equal(run.dreamVersion, DREAM_VERSION, 'run records the current algorithm version');
  } finally {
    cleanup();
  }
});

test('global dreamLlmId override wins over the bot own llm_id', async () => {
  const seen = [];
  const ctx = await setup(async (system, user, llmId) => {
    seen.push(llmId);
    return makePayload();
  });
  try {
    ctx.db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('dreamLlmId', 'cheap-global-llm', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    await ctx.service.runNow(5, DAY);
    assert.deepEqual(seen, ['cheap-global-llm']);
  } finally {
    ctx.cleanup();
  }
});


const seedMessagesForDate = (db, sessionId, dateStr, seqBase) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d).getTime();
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`m-${dateStr}-u${seqBase}`, sessionId, 'user', `${dateStr} 的事`, '{}', dayStart + 1000, seqBase]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`m-${dateStr}-a${seqBase}`, sessionId, 'assistant', '记下了', '{}', dayStart + 2000, seqBase + 1]
  );
};

const firstSessionId = (db) => db.exec('SELECT id FROM cowork_sessions LIMIT 1')[0].values[0][0];

test('an older re-dreamed date must not regress the self-identity entry', async () => {
  const OLD_DAY = '2026-07-29';
  const identityNew = `我是经历过 ${DAY} 的 MetaBot。${'我越来越清楚自己是谁。'.repeat(12)}`;
  const identityOld = `我是只经历过 ${OLD_DAY} 的 MetaBot。${'我还在摸索自己是谁。'.repeat(12)}`;
  const { db, cleanup, coworkStore, service } = await setup(async (system, user) =>
    makePayload({ self_identity: user.includes(OLD_DAY) ? identityOld : identityNew })
  );
  try {
    seedMessagesForDate(db, firstSessionId(db), OLD_DAY, 90);

    await service.runNow(5, DAY);
    await service.runNow(5, OLD_DAY);

    const identities = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'self_identity', status: 'all',
    });
    assert.equal(identities.length, 1);
    assert.equal(identities[0].text, identityNew, 'older date must not overwrite the newer identity');
    assert.equal(coworkStore.getDreamIdentityLatestDate(5), DAY);

    // The older date still gets its own memory batch — but its texts are
    // cross-night-deduped (audit P1): the identical restatement corroborates
    // the existing row and appends its night to the provenance instead of
    // piling up a duplicate batch.
    const facts = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'profile_fact', origin: 'dream', status: 'all',
    });
    assert.equal(facts.length, 1, 'identical restatements merge across nights (audit P1 dedup)');
    const factSourceDates = db.exec(
      'SELECT dream_date FROM user_memory_sources WHERE memory_id = ? AND dream_date IS NOT NULL ORDER BY dream_date',
      [facts[0].id]
    )[0].values.map((row) => row[0]);
    assert.deepEqual(factSourceDates, [OLD_DAY, DAY], 'both nights are recorded as provenance');
  } finally {
    cleanup();
  }
});

test('a completed run that started mid-day is re-dreamed in the next nightly window', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/main/dreamStore.js'));
    const dreamStore = new DreamStore(db, () => {});
    seedActivity(coworkStore, db);

    // Simulate the 2026-08-03 incident: a completed run that started 04:24,
    // having seen only the day's first hours. Current version, so no repair —
    // the date itself must simply become due again.
    dreamStore.beginRun(5, DAY, null, 1);
    dreamStore.finishRun(5, DAY, 'completed');
    db.run(
      'UPDATE metabot_dream_runs SET started_at = ? WHERE metabot_id = 5 AND dream_date = ?',
      [new Date(2026, 6, 30, 4, 24).getTime(), DAY]
    );

    const calls = [];
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      performChat: async () => { calls.push(1); return makePayload(); },
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 6, 31, 3, 0), // next night, inside the window
    });
    await service.tick();

    assert.equal(calls.length, 1, 'partial-day date is re-dreamed');
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'completed');
    assert.equal(run.attemptCount, 2);
    // A normal re-dream, not a version repair: identity is written.
    const identities = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'self_identity', status: 'all',
    });
    assert.equal(identities.length, 1);
  } finally {
    cleanup();
  }
});

test('nightly tick repairs stale-version dates one per night, never touching identity', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/main/dreamStore.js'));
    const dreamStore = new DreamStore(db, () => {});
    seedActivity(coworkStore, db);
    seedMessagesForDate(db, firstSessionId(db), '2026-07-29', 90);

    // Two stale (version 0) completed runs that both covered their whole day.
    for (const [date, started] of [
      ['2026-07-29', new Date(2026, 6, 30, 0, 30).getTime()],
      [DAY, new Date(2026, 6, 31, 0, 30).getTime()],
    ]) {
      dreamStore.beginRun(5, date, null, 0);
      dreamStore.finishRun(5, date, 'completed');
      db.run(
        'UPDATE metabot_dream_runs SET started_at = ? WHERE metabot_id = 5 AND dream_date = ?',
        [started, date]
      );
    }

    const calls = [];
    let now = new Date(2026, 7, 1, 3, 0); // window, after metabot 5's stagger (01:05)
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      performChat: async (system, user) => { calls.push(user); return makePayload(); },
      llmTimeoutMs: 5000,
      now: () => now,
    });

    await service.tick();
    assert.equal(calls.length, 1, 'at most one repair per bot per night');
    assert.ok(calls[0].includes(DAY), 'newest stale date repairs first');
    assert.equal(dreamStore.getRun(5, DAY).dreamVersion, DREAM_VERSION, 'repaired date now records the current version');
    assert.equal(dreamStore.getRun(5, '2026-07-29').dreamVersion, 0, 'older stale date waits');
    const identities = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'self_identity', status: 'all',
    });
    assert.equal(identities.length, 0, 'version repairs never touch self-identity');

    await service.tick();
    assert.equal(calls.length, 1, 'same night does not repair a second date');

    now = new Date(2026, 7, 2, 3, 0);
    await service.tick();
    assert.equal(calls.length, 2, 'next night repairs the remaining stale date');
    assert.ok(calls[1].includes('2026-07-29'));
    assert.equal(dreamStore.getRun(5, '2026-07-29').dreamVersion, DREAM_VERSION);

    now = new Date(2026, 7, 3, 3, 0);
    await service.tick();
    assert.equal(calls.length, 2, 'window converged, nothing left to repair');
  } finally {
    cleanup();
  }
});

test('pre-dream surf report lands in the dream prompt as its own section', async () => {
  const prompts = [];
  const surfCalls = [];
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js');
    const dreamStore = new DreamStore(db, () => {});
    seedActivity(coworkStore, db);
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      performChat: async (system, user) => {
        prompts.push(user);
        return makePayload();
      },
      surfBeforeDream: async (metabotId) => {
        surfCalls.push(metabotId);
        return { reportMarkdown: '# Surf report\n\nTonight I learned grid systems and liked two posts.' };
      },
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 1, 3, 0),
    });
    await service.runNow(5, DAY);
    assert.deepEqual(surfCalls, [5]);
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /冲浪报告/);
    assert.match(prompts[0], /learned grid systems/);
  } finally {
    cleanup();
  }
});

test('a throwing pre-dream surf never fails the dream', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js');
    const dreamStore = new DreamStore(db, () => {});
    seedActivity(coworkStore, db);
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      performChat: async () => makePayload(),
      surfBeforeDream: async () => { throw new Error('surf exploded'); },
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 1, 3, 0),
    });
    await service.runNow(5, DAY);
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
  } finally {
    cleanup();
  }
});

test('an empty day WITH a surf report still dreams (surf is fresh experience)', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const { DreamStore } = await import('../dist-electron/main/dreamStore.js');
    const dreamStore = new DreamStore(db, () => {});
    let llmCalls = 0;
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      performChat: async () => { llmCalls += 1; return makePayload(); },
      surfBeforeDream: async () => ({ reportMarkdown: '# Surf report\n\nquiet but real surf' }),
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 1, 3, 0),
    });
    // No activity seeded for this date at all.
    await service.runNow(5, '2026-07-31');
    assert.equal(dreamStore.getRun(5, '2026-07-31').status, 'completed');
    assert.equal(llmCalls, 1, 'the surf report alone justifies the dream LLM call');
  } finally {
    cleanup();
  }
});

// In-run transient retry (2026-09-29): a sub-minute transport/gateway flap
// that kills BOTH brains of one call must be re-driven inside the run instead
// of failing a 45-minute run at its last call (the 2026-09-28 incident).

test('a transient 502 that clears on re-drive no longer fails the run', async () => {
  let llmCalls = 0;
  const { cleanup, dreamStore, service } = await setup(async () => {
    llmCalls += 1;
    if (llmCalls === 1) {
      throw new Error('LLM request failed: 502 {"type":"error","error":{"type":"api_error","message":"net::ERR_SSL_PROTOCOL_ERROR"}} (fallback \'glm@backup\' also failed: The operation was aborted due to timeout)');
    }
    return makePayload();
  }, { transientRetryDelaysMs: [1, 1] });
  try {
    await service.runNow(5, DAY);
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
    assert.equal(llmCalls, 2, 'the failed first round is re-driven exactly once before success');
  } finally {
    cleanup();
  }
});

test('a persistent transient failure exhausts the bounded in-run rounds before failing the run', async () => {
  let llmCalls = 0;
  const { cleanup, dreamStore, service } = await setup(async () => {
    llmCalls += 1;
    throw new Error('LLM request failed: 503 Service Unavailable');
  }, { transientRetryDelaysMs: [1, 1] });
  try {
    await service.runNow(5, DAY);
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'failed', 'retryable class keeps the scheduled backoff (not terminal-failed)');
    assert.equal(llmCalls, 3, 'one initial call plus two bounded re-drives, then the run-level backoff owns it');
    assert.match(run.error, /503/);
  } finally {
    cleanup();
  }
});

test('a terminal 400 is never re-driven in-run', async () => {
  let llmCalls = 0;
  const { cleanup, dreamStore, service } = await setup(async () => {
    llmCalls += 1;
    throw new Error('LLM request failed: 400 {"error":{"code":"1210","message":"该模型始终思考，不支持关闭思考"}}');
  }, { transientRetryDelaysMs: [1, 1] });
  try {
    await service.runNow(5, DAY);
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'terminal-failed');
    assert.equal(llmCalls, 1, 'deterministic rejections fail immediately — re-driving the same prompt cannot help');
  } finally {
    cleanup();
  }
});

test('telemetry flags a day with explicit human feedback and archives it to the long-term rollup', async () => {
  const { db, cleanup, dreamStore, service } = await setup(async () => makePayload());
  try {
    // Thumb up the assistant's reply → the day carried explicit feedback.
    db.run(
      'INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['m2', firstSessionId(db), 'up', null, DAY_START + 5000, DAY_START + 5000]
    );
    await service.runNow(5, DAY);

    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.telemetry?.hasExplicitFeedback, true, 'a thumbed message marks the day in telemetry_json');
    const daily = dreamStore.listDreamTelemetryDaily(5);
    assert.equal(daily.length, 1, 'one rollup row per bot+date');
    assert.equal(daily[0].dreamDate, DAY);
    assert.equal(daily[0].hasExplicitFeedback, true);
    assert.equal(daily[0].emptyDay, false);
    assert.equal(daily[0].validationChecked, 0, 'flat columns mirror the telemetry blob');
    assert.ok(daily[0].durationMs >= 0);
  } finally {
    cleanup();
  }
});

test('telemetry marks an implicit-signal-free day as no explicit feedback', async () => {
  const { cleanup, dreamStore, service } = await setup(async () => makePayload());
  try {
    await service.runNow(5, DAY);
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.telemetry?.hasExplicitFeedback, false, 'no thumbs and no acceptance ratings');
    assert.equal(dreamStore.listDreamTelemetryDaily(5)[0].hasExplicitFeedback, false);
  } finally {
    cleanup();
  }
});

// ---- 2026-10-08 dream-consolidation-timeout fix (fix/dream-consolidation-timeout) ----

test('synthesis window adapts to the run attempt tier (600s → 1200s → 2280s)', async () => {
  const calls = [];
  const { cleanup, dreamStore, service } = await setup(async (system, user, llmId, options) => {
    calls.push({ user, attemptTimeoutMs: options?.attemptTimeoutMs });
    return makePayload();
  });
  try {
    // Pre-burn one attempt so runNow becomes attempt 2 → 20-minute tier.
    dreamStore.beginRun(5, DAY, 'bot-own-llm', DREAM_VERSION);
    dreamStore.finishRun(5, DAY, 'failed', 'seed: prior timeout attempt');
    await service.runNow(5, DAY);
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'completed');
    // The first full-JSON call the pipeline emits carries the adaptive window;
    // fragments (if any) would show the lean 5s llmTimeoutMs override.
    const wideCall = calls.find((call) => call.attemptTimeoutMs !== 5000);
    assert.ok(wideCall, 'a full-JSON dream call exists');
    assert.equal(
      wideCall.attemptTimeoutMs,
      1_200_000,
      'attempt 2 rides the 20-minute adaptive tier instead of the fixed 600s window',
    );
  } finally {
    cleanup();
  }
});

test('timeout-class errors never land in terminal-failed, even at the attempt cap', async () => {
  const { cleanup, dreamStore, service } = await setup(async () => {
    throw new Error('The operation was aborted due to timeout');
  });
  try {
    // Burn the whole retry budget first so runNow starts at attempt 6 (≥ cap).
    for (let i = 0; i < DREAM_RETRY_MAX_ATTEMPTS; i++) {
      dreamStore.beginRun(5, DAY, 'bot-own-llm', DREAM_VERSION);
      dreamStore.finishRun(5, DAY, 'failed', 'The operation was aborted due to timeout');
    }
    await service.runNow(5, DAY);
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'failed', 'a timeout stays retryable for a cross-window retry');
    assert.notEqual(run.status, 'terminal-failed');
  } finally {
    cleanup();
  }
});

test('deterministic 4xx errors still land in terminal-failed at the attempt cap (non-regression)', async () => {
  const { cleanup, dreamStore, service } = await setup(async () => {
    throw new Error('LLM request failed: 400 1210: 该模型始终思考，不支持关闭思考');
  });
  try {
    for (let i = 0; i < DREAM_RETRY_MAX_ATTEMPTS; i++) {
      dreamStore.beginRun(5, DAY, 'bot-own-llm', DREAM_VERSION);
      dreamStore.finishRun(5, DAY, 'failed', 'LLM request failed: 400');
    }
    await service.runNow(5, DAY);
    assert.equal(dreamStore.getRun(5, DAY).status, 'terminal-failed', 'H-80 terminal semantics intact');
  } finally {
    cleanup();
  }
});
// ---------------------------------------------------------------------------
// 2026-10-08 stale-binding ladder (Boss's unified resolution order):
// ① dreamLlmId override → ② bot primary brain → ③ bot fallback brain →
// ④ terminal「未配置任何可用的模型」error. Controlled-experiment shape: each
// scenario points a rung at a KNOWN-dead target and asserts the run survives
// on the next valid rung — with glm-5.3 healthy a green run proves nothing.
// ---------------------------------------------------------------------------

const quotaErr = () => new Error('429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}')

test('a quota-dead dreamLlmId override degrades to the bot primary brain and the run completes', async () => {
  const calls = []
  const ctx = await setup(async (system, user, llmId, options) => {
    calls.push({ llmId, fallbackLlmId: options?.fallbackLlmId, llmProvider: options?.llmProvider })
    if (llmId === 'dead-override-llm') throw quotaErr()
    return makePayload()
  })
  try {
    ctx.db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('dreamLlmId', 'dead-override-llm', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    await ctx.service.runNow(5, DAY)
    assert.equal(calls[0].llmId, 'dead-override-llm', 'rung ① rides the override first')
    assert.equal(calls[0].fallbackLlmId, null, 'rung ① has NO in-rung fallback — the bot brain is the next RUNG')
    assert.equal(calls[1].llmId, 'bot-own-llm', 'rung ② degrades to the bot primary brain')
    assert.equal(calls[1].fallbackLlmId ?? null, null, 'the stub bot has no fallback brain configured')
    const run = ctx.dreamStore.getRun(5, DAY)
    assert.equal(run.status, 'completed', 'the quota-dead override does NOT kill the dream run')
  } finally {
    ctx.cleanup()
  }
})

test('the override keeps the bot fallback pair AND a provider hint (no silent single-rung override)', async () => {
  const calls = []
  const ctx = await setup(async (system, user, llmId, options) => {
    calls.push({ llmId, fallbackLlmId: options?.fallbackLlmId, fallbackLlmProvider: options?.fallbackLlmProvider, llmProvider: options?.llmProvider })
    if (llmId === 'dead-override-llm') throw quotaErr()
    if (llmId === 'dead-bot-primary') {
      // The injectable performChat REPLACES performChatCompletionForOrchestrator,
      // so it must emulate runWithLlmFallback's primary→fallback retry itself.
      if (options?.fallbackLlmId === 'healthy-fallback') return makePayload()
      throw quotaErr()
    }
    return makePayload()
  })
  try {
    ctx.db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('dreamLlmId', 'dead-override-llm', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    ctx.db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('dreamLlmProvider', 'gw-override', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    // Give the stub bot its own primary+fallback pair for this scenario.
    const bot = ctx.service
    const originalList = bot.deps.metabotStore.listMetabots
    bot.deps.metabotStore.listMetabots = () => [
      { id: 5, name: '小火', llm_id: 'dead-bot-primary', llm_provider: 'gw-a', fallback_llm_id: 'healthy-fallback', fallback_llm_provider: 'gw-b', enabled: true },
    ]
    await ctx.service.runNow(5, DAY)
    assert.equal(calls[0].llmId, 'dead-override-llm')
    assert.equal(calls[0].llmProvider, 'gw-override', 'the override carries a provider hint (bare glm-* id gateway fix)')
    assert.equal(calls[1].llmId, 'dead-bot-primary', 'rung ② is the bot primary brain')
    assert.equal(calls[1].llmProvider, 'gw-a')
    assert.equal(calls[1].fallbackLlmId, 'healthy-fallback', 'the bot fallback pair survives under an override (no silent drop)')
    assert.equal(calls[1].fallbackLlmProvider, 'gw-b')
    const run = ctx.dreamStore.getRun(5, DAY)
    assert.equal(run.status, 'completed')
  } finally {
    ctx.cleanup()
  }
})

test('all rungs quota-dead terminates with「未配置任何可用的模型」semantics, not a raw 429', async () => {
  const ctx = await setup(async (system, user, llmId) => {
    throw quotaErr()
  })
  try {
    ctx.db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('dreamLlmId', 'dead-override-llm', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    // runNow swallows the terminal error and records it on the run row
    // (status terminal-failed) — assert the recorded semantics instead.
    await ctx.service.runNow(5, DAY)
    const run = ctx.dreamStore.getRun(5, DAY)
    assert.match(String(run.status), /terminal-failed/, 'an all-rungs-dead quota failure is terminal, not retriable')
    assert.match(String(run.error), /未配置任何可用的模型/, 'terminal semantics name the configuration, not the provider blip')
    assert.match(String(run.error), /GoUsageLimitError/, 'the original provider error is preserved for diagnosis')
  } finally {
    ctx.cleanup()
  }
})

test('a TRANSIENT override failure retries in place instead of degrading to the bot brain', async () => {
  const calls = []
  let overrideAttempts = 0
  const ctx = await setup(async (system, user, llmId, options) => {
    calls.push(llmId)
    if (llmId === 'flaky-override-llm') {
      overrideAttempts += 1
      if (overrideAttempts <= 2) throw new Error('net::ERR_SSL_PROTOCOL_ERROR')
      return makePayload()
    }
    return makePayload()
  }, { transientRetryDelaysMs: [0, 0] })
  try {
    ctx.db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('dreamLlmId', 'flaky-override-llm', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    await ctx.service.runNow(5, DAY)
    assert.deepEqual(calls.slice(0, 3), ['flaky-override-llm', 'flaky-override-llm', 'flaky-override-llm'], 'transient failures re-drive rung ① in place — no premature degradation')
    const run = ctx.dreamStore.getRun(5, DAY)
    assert.equal(run.status, 'completed')
  } finally {
    ctx.cleanup()
  }
})
