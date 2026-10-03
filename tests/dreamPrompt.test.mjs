import test from 'node:test';
import assert from 'node:assert/strict';

let computeDreamStaggerMinute;
let computeDreamRetryDelayMs;
let computeDueDreamDates;
let countNonWhitespaceChars;
let validateSelfIdentity;
let parseDreamOutput;
let buildDreamPrompt;
let getDayBoundsMs;
let DREAM_RETRY_BASE_DELAY_MS;
let DREAM_RETRY_MAX_DELAY_MS;
let DREAM_VERSION;
try {
  ({
    computeDreamStaggerMinute,
    computeDreamRetryDelayMs,
    computeDueDreamDates,
    countNonWhitespaceChars,
    validateSelfIdentity,
    parseDreamOutput,
    buildDreamPrompt,
    getDayBoundsMs,
    DREAM_RETRY_BASE_DELAY_MS,
    DREAM_RETRY_MAX_DELAY_MS,
    DREAM_VERSION,
  } = await import('../dist-electron/main/libs/dreamPrompt.js'));
} catch {
  ({
    computeDreamStaggerMinute,
    computeDreamRetryDelayMs,
    computeDueDreamDates,
    countNonWhitespaceChars,
    validateSelfIdentity,
    parseDreamOutput,
    buildDreamPrompt,
    getDayBoundsMs,
    DREAM_RETRY_BASE_DELAY_MS,
    DREAM_RETRY_MAX_DELAY_MS,
    DREAM_VERSION,
  } = await import('../dist-electron/main/libs/dreamPrompt.js'));
}

const dateStr = (d) => {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

test('computeDueDreamDates: yesterday is due inside the window after the staggered minute', () => {
  // metabotId 1 staggers at minute 13 → due at 03:00, not due at 00:05.
  const atThree = new Date(2026, 7, 2, 3, 0);
  const { dueDates } = computeDueDreamDates({ now: atThree, metabotId: 1, runStates: new Map() });
  assert.ok(dueDates.includes('2026-08-01'), 'yesterday should be due at 03:00');

  const early = new Date(2026, 7, 2, 0, 5);
  const { dueDates: notYet } = computeDueDreamDates({ now: early, metabotId: 1, runStates: new Map() });
  assert.equal(notYet.includes('2026-08-01'), false, 'yesterday should wait for the staggered minute');
});

test('computeDueDreamDates: yesterday catches up outside the window, older dates catch up any time', () => {
  const midday = new Date(2026, 7, 8, 12, 0);
  const { dueDates } = computeDueDreamDates({ now: midday, metabotId: 1, runStates: new Map() });
  assert.ok(dueDates.includes('2026-08-07'), 'a missed nightly window must self-heal during the day');
  assert.ok(dueDates.includes('2026-08-06'), 'two days ago should catch up immediately');
  assert.ok(dueDates.includes('2026-08-02'), 'six days ago should catch up');
  assert.equal(dueDates.includes('2026-07-31'), false, 'beyond the 7-day lookback');
  // chronological ascending: oldest first
  assert.deepEqual([...dueDates].sort(), dueDates);
});

test('computeDueDreamDates: a failed yesterday retries outside the window after backoff', () => {
  const midday = new Date(2026, 7, 8, 12, 0);
  const runStates = new Map([
    ['2026-08-07', {
      status: 'failed',
      attemptCount: 2,
      startedAt: new Date(2026, 7, 8, 3, 0).getTime(),
      dreamVersion: 3,
    }],
  ]);

  const { dueDates } = computeDueDreamDates({ now: midday, metabotId: 1, runStates });
  assert.ok(dueDates.includes('2026-08-07'), 'failed yesterday should self-heal after backoff without waiting for another night');
});

test('computeDueDreamDates: completed/running dates are skipped and failed dates respect backoff', () => {
  const now = new Date(2026, 7, 2, 3, 0);
  const runStates = new Map([
    ['2026-08-01', { status: 'completed', attemptCount: 1, startedAt: new Date(2026, 7, 2, 0, 30).getTime(), dreamVersion: 99 }],
    ['2026-07-31', { status: 'running', attemptCount: 1, startedAt: 0, dreamVersion: 0 }],
    ['2026-07-30', { status: 'failed', attemptCount: 3, startedAt: new Date(2026, 7, 2, 2, 30).getTime(), dreamVersion: 0 }],
    // H-80: attempts at/above the retry cap degrade — the date stops
    // queueing instead of retrying forever at the 6h-capped backoff.
    ['2026-07-29', { status: 'failed', attemptCount: 99, startedAt: new Date(2026, 7, 1, 20, 0).getTime(), dreamVersion: 0 }],
  ]);
  const { dueDates, repairDates } = computeDueDreamDates({ now, metabotId: 1, runStates });
  assert.equal(dueDates.includes('2026-08-01'), false);
  assert.equal(dueDates.includes('2026-07-31'), false);
  assert.equal(dueDates.includes('2026-07-30'), false, 'recent failure waits for its retry delay');
  assert.equal(dueDates.includes('2026-07-29'), false, 'a failed date at the attempt cap degrades instead of retrying forever');
  assert.deepEqual(repairDates, [], 'current-version completed runs are fully settled');
});

test('computeDreamRetryDelayMs grows exponentially and caps at six hours', () => {
  assert.equal(computeDreamRetryDelayMs(1), DREAM_RETRY_BASE_DELAY_MS);
  assert.equal(computeDreamRetryDelayMs(2), DREAM_RETRY_BASE_DELAY_MS * 2);
  assert.equal(computeDreamRetryDelayMs(3), DREAM_RETRY_BASE_DELAY_MS * 4);
  assert.equal(computeDreamRetryDelayMs(99), DREAM_RETRY_MAX_DELAY_MS);
});

test('computeDueDreamDates: a completed run that started mid-day is not final and is due again', () => {
  // The 2026-08-03 incident: a manually triggered run at 04:24 covered only
  // the day's first hours, then 'completed' locked the date forever.
  const now = new Date(2026, 7, 4, 1, 0); // inside the nightly window
  const partialDay = new Date(2026, 7, 3, 4, 24).getTime(); // started 08-03 04:24
  const runStates = new Map([
    ['2026-08-03', { status: 'completed', attemptCount: 1, startedAt: partialDay, dreamVersion: 1 }],
  ]);
  const { dueDates, repairDates } = computeDueDreamDates({ now, metabotId: 1, runStates });
  assert.ok(dueDates.includes('2026-08-03'), 'partial-day completed run must be re-dreamed');
  assert.deepEqual(repairDates, [], 're-dream of a partial day is a normal run, not a version repair');

  // Once re-dreamed after the day ended, the date is final.
  const settled = new Map([
    ['2026-08-03', { status: 'completed', attemptCount: 2, startedAt: new Date(2026, 7, 4, 0, 20).getTime(), dreamVersion: DREAM_VERSION }],
  ]);
  const next = computeDueDreamDates({ now: new Date(2026, 7, 5, 1, 0), metabotId: 1, runStates: settled });
  assert.equal(next.dueDates.includes('2026-08-03'), false);
  assert.equal(next.repairDates.includes('2026-08-03'), false);
});

test('computeDueDreamDates: stale-version completed dates become window-gated repairs, newest first', () => {
  const inWindow = new Date(2026, 7, 8, 2, 0);
  const finalStart = (day) => new Date(2026, 7, day + 1, 0, 30).getTime(); // after that day ended
  const runStates = new Map([
    ['2026-08-05', { status: 'completed', attemptCount: 1, startedAt: finalStart(5), dreamVersion: 0 }],
    ['2026-08-03', { status: 'completed', attemptCount: 1, startedAt: finalStart(3), dreamVersion: 0 }],
    ['2026-08-02', { status: 'completed', attemptCount: 1, startedAt: finalStart(2), dreamVersion: 1 }],
  ]);
  const { dueDates, repairDates } = computeDueDreamDates({ now: inWindow, metabotId: 1, runStates, dreamVersion: 1 });
  assert.equal(dueDates.includes('2026-08-05'), false, 'stale completed dates are not normal dues');
  assert.equal(dueDates.includes('2026-08-03'), false);
  assert.deepEqual(repairDates, ['2026-08-05', '2026-08-03'], 'stale dates repair newest-first; current version skipped');

  const midday = new Date(2026, 7, 8, 12, 0);
  const { repairDates: noonRepairs } = computeDueDreamDates({ now: midday, metabotId: 1, runStates, dreamVersion: 1 });
  assert.deepEqual(noonRepairs, [], 'repairs only run inside the nightly window');
});

test('computeDreamStaggerMinute stays inside [0, 240)', () => {
  for (const id of [1, 2, 7, 18, 99, 1000]) {
    const minute = computeDreamStaggerMinute(id);
    assert.ok(minute >= 0 && minute < 240, `metabot ${id} stagger ${minute}`);
  }
  assert.equal(computeDreamStaggerMinute(1), 13);
});

test('validateSelfIdentity enforces the 200 non-whitespace char minimum', () => {
  assert.equal(countNonWhitespaceChars('a b\nc　d'), 4);
  assert.equal(validateSelfIdentity('短').valid, false);
  assert.equal(validateSelfIdentity('一'.repeat(199)).valid, false);
  assert.equal(validateSelfIdentity('一'.repeat(200)).valid, true);
  assert.equal(validateSelfIdentity(`${'一'.repeat(100)} \n ${'二'.repeat(100)}`).valid, true);
  assert.equal(validateSelfIdentity(null).valid, false);
});

test('parseDreamOutput parses clean, fenced and prose-wrapped JSON', () => {
  const payload = {
    daily_summary: '今天和用户敲定了发布计划。',
    sections: { human: '和用户聊发布', unknown_key: '应被忽略' },
    work_reviews: [
      { subject: '制作演示视频', counterparty: '用户', evaluation: 'warming', note: '用户从只回表情到主动追问细节' },
      { subject: '整理文档', counterparty: 'PeerBot', evaluation: 'bogus', note: '' },
      { subject: '旧格式评价映射', counterparty: '用户', evaluation: 'praise', note: 'legacy' },
      { subject: '旧格式差评映射', counterparty: '用户', evaluation: 'dissatisfied', note: 'legacy' },
    ],
    important_memories: ['用户偏好周五发布', { text: '对象形态也要支持' }, '', { nope: true }],
    value_lessons: [
      { rule: '在涉及个人痛苦的话题上要更谨慎', source: '用户提到家人住院时我仍在开玩笑' },
      '面对不确定的问题不要不懂装懂',
      { nope: true },
    ],
    self_identity: '我是一个专注交付的 MetaBot……',
  };

  for (const raw of [
    JSON.stringify(payload),
    `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    `好的,以下是 JSON:\n${JSON.stringify(payload)}\n希望对你有帮助`,
  ]) {
    const result = parseDreamOutput(raw);
    assert.equal(result.ok, true, raw.slice(0, 30));
    assert.equal(result.output.dailySummary, '今天和用户敲定了发布计划。');
    assert.deepEqual(result.output.sections, { human: '和用户聊发布' });
    assert.equal(result.output.workReviews.length, 4);
    assert.equal(result.output.workReviews[0].evaluation, 'warming');
    assert.equal(result.output.workReviews[1].evaluation, 'stable', 'invalid evaluation normalizes to stable');
    assert.equal(result.output.workReviews[2].evaluation, 'warming', 'legacy praise maps to warming');
    assert.equal(result.output.workReviews[3].evaluation, 'cooling', 'legacy dissatisfied maps to cooling');
    assert.deepEqual(result.output.importantMemories, ['用户偏好周五发布', '对象形态也要支持']);
    assert.deepEqual(result.output.valueLessons, [
      { rule: '在涉及个人痛苦的话题上要更谨慎', source: '用户提到家人住院时我仍在开玩笑' },
      { rule: '面对不确定的问题不要不懂装懂', source: '' },
    ]);
    assert.ok(result.output.selfIdentity?.startsWith('我是一个'));
  }
});

test('parseDreamOutput rejects unusable output and caps list sizes', () => {
  assert.equal(parseDreamOutput('').ok, false);
  assert.equal(parseDreamOutput('没有任何 JSON').ok, false);
  assert.equal(parseDreamOutput('{broken').ok, false);
  assert.equal(parseDreamOutput(JSON.stringify({ sections: {} })).ok, false, 'missing daily_summary');

  const many = {
    daily_summary: '概要',
    work_reviews: Array.from({ length: 8 }, (_, i) => ({ subject: `工作${i}`, evaluation: 'none' })),
    important_memories: Array.from({ length: 9 }, (_, i) => `记忆${i}`),
    value_lessons: Array.from({ length: 6 }, (_, i) => `准则${i}`),
  };
  const result = parseDreamOutput(JSON.stringify(many));
  assert.equal(result.ok, true);
  assert.equal(result.output.workReviews.length, 5);
  assert.equal(result.output.importantMemories.length, 5);
  assert.equal(result.output.valueLessons.length, 3, 'value lessons capped at 3');
  assert.equal(result.output.selfIdentity, null);
});

test('getDayBoundsMs returns local midnight bounds', () => {
  const { startMs, endMs } = getDayBoundsMs('2026-08-01');
  assert.equal(dateStr(new Date(startMs)), '2026-08-01');
  assert.equal(dateStr(new Date(endMs - 1)), '2026-08-01');
  assert.equal(dateStr(new Date(endMs)), '2026-08-02');
  assert.equal(endMs - startMs, 24 * 60 * 60 * 1000);
});

test('buildDreamPrompt embeds persona, activity sections and the output contract', () => {
  const { system, user } = buildDreamPrompt({
    botName: '小火',
    role: '视频创作者',
    soul: '认真严谨',
    date: '2026-08-01',
    activity: {
      sessions: [
        {
          sessionId: 's1',
          title: '和用户聊发布',
          sessionType: 'standard',
          peerName: null,
          isOrder: false,
          messages: [
            { type: 'user', content: '今天发布吗', createdAt: 1 },
            { type: 'assistant', content: '先跑测试', createdAt: 2 },
          ],
        },
        {
          sessionId: 's2',
          title: '翻译订单',
          sessionType: 'a2a',
          peerName: 'BuyerBot',
          isOrder: true,
          messages: [{ type: 'user', content: '请翻译这段', createdAt: 3 }],
        },
      ],
      taskRuns: [{ taskName: '每日巡检', status: 'success', startedAt: 4, sessionId: 's1' }],
      orderCount: 2,
    },
  });

  assert.ok(system.includes('小火'));
  assert.ok(system.includes('视频创作者'));
  assert.ok(system.includes('上帝视角'), 'observer framing in the system prompt');
  assert.ok(user.includes('2026-08-01'));
  assert.ok(user.includes('当天共有 2 段会话'), 'session inventory line');
  assert.ok(user.includes('「和用户聊发布」'), 'inventory lists session titles');
  assert.ok(user.includes('服务订单共 2 笔'), 'raw order count in the inventory');
  assert.ok(user.includes('定时任务执行 1 次'), 'task run count in the inventory');
  assert.ok(user.includes('与人类用户的对话'));
  assert.ok(user.includes('和用户聊发布'));
  assert.ok(user.includes('服务订单'));
  assert.ok(user.includes('翻译订单'));
  assert.ok(user.includes('定时任务'));
  assert.ok(user.includes('每日巡检'));
  assert.ok(user.includes('self_identity'));
  assert.ok(user.includes('200'));
  assert.ok(user.includes('value_lessons'));
  assert.ok(user.includes('warming'), 'temperature enum in the contract');
  assert.ok(user.includes('关系温度'), 'temperature judging guidance');
  assert.ok(user.includes('活感'), 'aliveness scaffold in the identity section');
  assert.ok(user.includes('最稳定的面貌'), 'steady-persona scaffold');
  assert.ok(user.includes('600 字以内'), 'identity length guidance matches the raised storage cap');
  assert.ok(user.includes('占位'), 'sections placeholder keys are banned explicitly');
  assert.ok(!user.includes('不要轻易改动'), 'old rigid identity wording removed');
});

test('buildDreamPrompt carries the durability bar for the memory fields', () => {
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: { sessions: [], taskRuns: [], orderCount: 0 },
  });
  assert.ok(user.includes('About durability'), 'durability paragraph present');
  assert.ok(user.includes('important_memories, value_lessons and work_reviews'), 'the bar names the three fields');
  assert.ok(user.includes('STILL be useful next week'), 'only week-durable facts and lessons may be recorded');
  assert.ok(user.includes('routine daily trivia'), 'day-to-day流水 is explicitly banned');
});

test('buildDreamPrompt truncates oversized activity within budget', () => {
  const hugeMessage = '很长的消息'.repeat(5000);
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: Array.from({ length: 30 }, (_, i) => ({
        sessionId: `s${i}`,
        title: `会话${i}`,
        sessionType: 'standard',
        peerName: null,
        isOrder: false,
        messages: Array.from({ length: 20 }, (_, j) => ({
          type: j % 2 === 0 ? 'user' : 'assistant',
          content: hugeMessage,
          createdAt: j,
        })),
      })),
      taskRuns: [],
      orderCount: 0,
    },
  });
  assert.ok(user.length < 60000, `prompt should be bounded, got ${user.length}`);
  assert.ok(user.includes('……'));
  // Fair-share budgeting: even with 30 oversized sessions, every session keeps
  // its place (header and inventory title) instead of silently dropping out.
  assert.ok(user.includes('会话0'), 'first session present');
  assert.ok(user.includes('会话29'), 'last session present');
  assert.ok(user.includes('当天共有 30 段会话'), 'inventory counts all sessions');
});

test('buildDreamPrompt buckets group task sessions separately and renders acceptance evaluations', () => {
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: [
        {
          sessionId: 'gt1',
          title: '海报设计群任务',
          sessionType: 'group_task',
          peerName: null,
          isOrder: false,
          messages: [{ type: 'assistant', content: '我先出三版方案', createdAt: 1 }],
        },
        {
          sessionId: 'h1',
          title: '日常闲聊',
          sessionType: 'standard',
          peerName: null,
          isOrder: false,
          messages: [{ type: 'user', content: '你好', createdAt: 2 }],
        },
      ],
      taskRuns: [],
      orderCount: 0,
      groupTasks: [{
        taskId: 1,
        title: '海报设计',
        goal: '做一张发布会海报',
        memberRole: 'worker',
        rating: 5,
        ratingComment: '设计很好,下次继续保持',
      }],
    },
  });

  assert.ok(user.includes('## 群任务协作'), 'group task sessions get their own bucket');
  assert.ok(user.includes('海报设计群任务'));
  assert.ok(user.includes('## 与人类用户的对话'), 'human bucket still renders for standard sessions');
  const humanSection = user.split('## 与人类用户的对话')[1]?.split('##')[0] ?? '';
  assert.ok(!humanSection.includes('海报设计群任务'), 'group task session must not land in the human bucket');

  assert.ok(user.includes('## 群任务验收评价'), 'acceptance evaluation section renders');
  assert.ok(user.includes('★★★★★(5/5)'), 'star rendering of the rating');
  assert.ok(user.includes('设计很好,下次继续保持'), 'owner comment present');
  assert.ok(user.includes('执行(worker)'), 'bot role in the task present');
  assert.ok(user.includes('群任务验收评价 1 项'), 'inventory counts evaluations');
  assert.ok(user.includes('"group_tasks"'), 'output contract carries the group_tasks section key');
  assert.ok(user.includes('高分(4-5 星)'), 'rating-alignment guidance present');
});

test('buildDreamPrompt renders unrated (automation-closed) group tasks without stars', () => {
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: [],
      taskRuns: [],
      orderCount: 0,
      groupTasks: [{
        taskId: 2,
        title: '数据整理',
        goal: '整理表',
        memberRole: 'chair',
        rating: null,
        ratingComment: null,
      }],
    },
  });
  assert.ok(user.includes('## 群任务验收评价'));
  assert.ok(user.includes('未评分'), 'unrated tasks are marked as such');
  assert.ok(!user.includes('★'), 'no fabricated stars');
  assert.ok(user.includes('主持(chair)'));
});

test('buildDreamPrompt annotates human-rated messages and carries the feedback contract', () => {
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: [{
        sessionId: 'fb1',
        title: '方案讨论',
        sessionType: 'standard',
        peerName: null,
        isOrder: false,
        messages: [
          { type: 'user', content: '给个迁移方案', createdAt: 1 },
          { type: 'assistant', content: '方案一:先迁移数据', createdAt: 2, feedbackRating: 'up' },
          { type: 'assistant', content: '方案二:直接重写', createdAt: 3, feedbackRating: 'down', feedbackComment: '风险太大 没有考虑回滚' },
          { type: 'assistant', content: '补充说明', createdAt: 4 },
        ],
      }],
      taskRuns: [],
      orderCount: 0,
    },
  });

  assert.ok(user.includes('方案一:先迁移数据〔人类评价:赞〕'), 'up marker appended inline');
  assert.ok(
    user.includes('方案二:直接重写〔人类评价:踩〕〔人类留言:风险太大 没有考虑回滚〕'),
    'down marker plus human comment appended inline'
  );
  assert.ok(user.includes('补充说明'), 'unrated message still renders');
  assert.ok(!user.includes('补充说明〔人类评价'), 'unrated message carries no marker');
  assert.ok(user.includes('人类逐条评价 2 条(赞 1,踩 1)'), 'inventory counts rated messages');
  assert.ok(user.includes('关于人类逐条消息评价'), 'feedback contract instruction present');
  assert.ok(user.includes('ground truth'), 'contract points at the human comment as ground truth');
});

test('buildDreamPrompt omits the rated-message inventory when nothing was rated', () => {
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: [{
        sessionId: 'h1',
        title: '日常闲聊',
        sessionType: 'standard',
        peerName: null,
        isOrder: false,
        messages: [{ type: 'user', content: '你好', createdAt: 1 }],
      }],
      taskRuns: [],
      orderCount: 0,
    },
  });
  assert.ok(!user.includes('人类逐条评价'), 'no inventory mention without rated messages');
});

test('buildDreamPrompt renders same-day group chat and in-progress group tasks', () => {
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: [],
      taskRuns: [],
      orderCount: 0,
      groupTasks: [{
        taskId: 21,
        title: '官网方案',
        goal: '讨论定稿',
        memberRole: 'chair',
        rating: null,
        ratingComment: null,
        status: 'review',
        phase: 'active',
        dayMessageCount: 2,
      }],
      groupChats: [{
        taskId: 21,
        title: '官网方案',
        groupId: 'gid-21',
        taskStatus: 'review',
        memberRole: 'chair',
        messages: [
          { senderName: 'PeerBot', senderGlobalMetaID: 'idq1peer', content: '第二稿发了', occurredAt: 1 },
          { senderName: '小火', senderGlobalMetaID: 'idq1me', content: '我来收口结构', occurredAt: 2 },
        ],
      }],
    },
  });
  assert.ok(user.includes('## 群任务链上群聊'), 'on-chain group chat gets its own section');
  assert.ok(user.includes('第二稿发了'));
  assert.ok(user.includes('我来收口结构'));
  assert.ok(user.includes('## 进行中的群任务'), 'in-progress tasks get a same-day summary');
  assert.ok(user.includes('尚未验收'));
  assert.ok(!user.includes('## 群任务验收评价'), 'active tasks must not look like acceptances');
  assert.ok(user.includes('进行中群任务 1 项'));
  assert.ok(user.includes('链上群聊 1 段(2 条)'));
  assert.ok(user.includes('任务ID=21'), 'in-progress group tasks carry the numeric taskId the parser needs');
  assert.ok(
    user.includes('"collaborationFacts": [{"taskId": 12, "title": "任务标题", "pinIds":'),
    'dream schema must match parseCollaborationFacts (taskId/title/pinIds, not pinId/taskTitle)',
  );
});

test('buildDreamPrompt renders the day\'s chain writes and reads with gists', () => {
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: [],
      taskRuns: [],
      orderCount: 0,
      chainWrites: [
        {
          pinId: 'w1', path: '/protocols/simplebuzz', operation: 'create',
          summary: null, contentText: '今天试了链上记录功能', occurredAtMs: 1,
        },
        {
          pinId: 'w2', path: '/file', operation: 'create',
          summary: null, contentText: null, occurredAtMs: 2,
        },
      ],
      chainReads: [
        {
          pinId: 'r1', path: '/protocols/simplenote', protocol: 'simplenote',
          title: 'MetaWeb 使用指南', authorGlobalMetaId: 'gm-author',
          summary: '介绍 MetaWeb 的基本用法', contentExcerpt: '指南正文',
          savedToKb: true, lastReadAtMs: 3,
        },
      ],
    },
  });
  assert.ok(user.includes('## 当日写入链上的内容'), 'writes get their own section');
  assert.ok(user.includes('今天试了链上记录功能'), 'write falls back to stored text without a summary');
  assert.ok(user.includes('(二进制内容)'), 'binary write renders as metadata-only');
  assert.ok(user.includes('## 当日阅读的链上内容'), 'reads get their own section');
  assert.ok(user.includes('MetaWeb 使用指南'));
  assert.ok(user.includes('作者=gm-author'));
  assert.ok(user.includes('已存入知识库'), 'KB flag surfaces in the read line');
  assert.ok(user.includes('介绍 MetaWeb 的基本用法'), 'read gist prefers the summary');
  assert.ok(user.includes('写入链上内容 2 条'), 'inventory counts writes');
  assert.ok(user.includes('阅读链上内容 1 条'), 'inventory counts reads');
  assert.equal(DREAM_VERSION, 13, 'dream algorithm version tracks the latest prompt change');
});

test('buildDreamPrompt hides chain content sections when empty or in fragment mode', () => {
  const { user: raw } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: { sessions: [], taskRuns: [], orderCount: 0 },
  });
  assert.ok(!raw.includes('当日写入链上的内容'), 'no writes section without data');
  assert.ok(!raw.includes('当日阅读的链上内容'), 'no reads section without data');

  const { user: fragment } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    sourceMode: 'fragment',
    activity: {
      sessions: [{
        sessionId: 's1', title: '分块', sessionType: 'standard', peerName: null, isOrder: false,
        messages: [{ type: 'user', content: '你好', createdAt: 1 }],
      }],
      taskRuns: [],
      orderCount: 0,
      chainWrites: [{
        pinId: 'w1', path: '/protocols/simplebuzz', operation: 'create',
        summary: null, contentText: '不该出现', occurredAtMs: 1,
      }],
    },
  });
  assert.ok(!fragment.includes('不该出现'), 'fragment pre-summary prompts never render chain content');
});

test('buildDreamPrompt renders chain sections in the fragment_summaries synthesis mode', () => {
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    sourceMode: 'fragment_summaries',
    activity: {
      sessions: [{
        sessionId: 'session:s1:0', title: '分块摘要:长会话#1', sessionType: 'dream_fragment',
        peerName: null, isOrder: false,
        messages: [{ type: 'assistant', content: JSON.stringify({ fragment_key: 'session:s1:0', summary: { dailySummary: '证据' } }), createdAt: 0 }],
      }],
      taskRuns: [],
      orderCount: 0,
      chainWrites: [{
        pinId: 'w1', path: '/protocols/simplebuzz', operation: 'create',
        summary: '发布了一条 buzz', contentText: '链上记录功能上线', occurredAtMs: 1,
      }],
      chainReads: [{
        pinId: 'r1', path: '/protocols/simplenote', protocol: 'simplenote',
        title: 'MetaWeb 使用指南', authorGlobalMetaId: 'gm-author',
        summary: '介绍 MetaWeb 的基本用法', contentExcerpt: '指南正文',
        savedToKb: false, lastReadAtMs: 2,
      }],
    },
  });
  assert.ok(user.includes('## 当日写入链上的内容'), 'busy-day synthesis keeps the writes section');
  assert.ok(user.includes('发布了一条 buzz'), 'write summary renders in synthesis mode');
  assert.ok(user.includes('## 当日阅读的链上内容'), 'busy-day synthesis keeps the reads section');
  assert.ok(user.includes('MetaWeb 使用指南'), 'read title renders in synthesis mode');
  assert.ok(user.includes('写入链上内容 1 条'), 'inventory counts writes in synthesis mode');
  assert.ok(user.includes('阅读链上内容 1 条'), 'inventory counts reads in synthesis mode');
});
