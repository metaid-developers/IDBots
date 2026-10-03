import test from 'node:test';
import assert from 'node:assert/strict';

let buildSelfIdentityBlock;
let buildValueBoundariesBlock;
let buildWorkReviewsBlock;
let buildRecentDailySummariesBlock;
let buildExperiencePromptBlocksXml;
let buildMinimalSelfCognitionBlocks;
let resolveExperienceRecallQuery;
let formatExperienceRecallResults;
let RECENT_SUMMARIES_MAX_CHARS;
let RECALL_WARM_DAYS;
let MINIMAL_SELF_COGNITION_MAX_CHARS;
let MINIMAL_SELF_COGNITION_SUMMARIES_MAX_CHARS;
try {
  ({
    buildSelfIdentityBlock,
    buildValueBoundariesBlock,
    buildWorkReviewsBlock,
    buildRecentDailySummariesBlock,
    buildExperiencePromptBlocksXml,
    buildMinimalSelfCognitionBlocks,
    resolveExperienceRecallQuery,
    formatExperienceRecallResults,
    RECENT_SUMMARIES_MAX_CHARS,
    RECALL_WARM_DAYS,
    MINIMAL_SELF_COGNITION_MAX_CHARS,
    MINIMAL_SELF_COGNITION_SUMMARIES_MAX_CHARS,
  } = await import('../dist-electron/main/libs/experiencePromptBlocks.js'));
} catch {
  ({
    buildSelfIdentityBlock,
    buildValueBoundariesBlock,
    buildWorkReviewsBlock,
    buildRecentDailySummariesBlock,
    buildExperiencePromptBlocksXml,
    buildMinimalSelfCognitionBlocks,
    resolveExperienceRecallQuery,
    formatExperienceRecallResults,
    RECENT_SUMMARIES_MAX_CHARS,
    RECALL_WARM_DAYS,
    MINIMAL_SELF_COGNITION_MAX_CHARS,
    MINIMAL_SELF_COGNITION_SUMMARIES_MAX_CHARS,
  } = await import('../dist-electron/main/libs/experiencePromptBlocks.js'));
}

test('buildSelfIdentityBlock renders the identity block with behavior-alignment guidance', () => {
  const block = buildSelfIdentityBlock('我是一个 <专注> 视频创作的 MetaBot & 喜欢先验证');
  assert.ok(block.includes('<metabot_self_identity>'));
  assert.ok(block.includes('&lt;专注&gt;'));
  assert.ok(block.includes('&amp;'));
  assert.ok(!block.includes('<专注>'), 'raw XML must be escaped');
  assert.ok(block.includes('ALIGN your behavior with it'), 'alignment wording present');
  assert.ok(!block.includes('casually'), 'old rigid wording removed');

  assert.equal(buildSelfIdentityBlock(''), '');
  assert.equal(buildSelfIdentityBlock('   '), '');
});

test('buildValueBoundariesBlock renders the rules block capped by maxItems', () => {
  const block = buildValueBoundariesBlock([
    { text: '在涉及个人痛苦的话题上要更谨慎' },
    { text: '面对不确定的问题,不要不懂装懂' },
    { text: '  ' },
  ]);
  assert.ok(block.includes('<value_boundaries>'));
  assert.equal((block.match(/<rule>/g) || []).length, 2, 'blank entries skipped');
  assert.ok(block.includes('boundaries, not scripts'));

  const capped = buildValueBoundariesBlock(
    Array.from({ length: 8 }, (_, i) => ({ text: `准则${i}` })),
    3
  );
  assert.equal((capped.match(/<rule>/g) || []).length, 3);
  assert.equal(buildValueBoundariesBlock([]), '');
});

test('buildRecentDailySummariesBlock keeps newest days and drops oldest over budget', () => {
  const summaries = [
    { summaryDate: '2026-08-03', summaryText: '第三天做了很多事' },
    { summaryDate: '2026-08-02', summaryText: '第二天和用户聊了很久' },
    { summaryDate: '2026-08-01', summaryText: '第一天起步' },
  ];

  const full = buildRecentDailySummariesBlock(summaries);
  assert.ok(full.includes('2026-08-03'));
  assert.ok(full.includes('2026-08-01'));
  assert.ok(full.includes('<recent_daily_summaries>'));
  assert.ok(full.includes('experience_recall'));
  assert.ok(full.includes('做梦'), 'summaries are framed as the bot\'s dreams');

  const tight = buildRecentDailySummariesBlock(summaries, 60);
  assert.ok(tight.includes('2026-08-03'), 'newest survives');
  assert.ok(!tight.includes('2026-08-02'), 'later days dropped over budget');
  assert.ok(!tight.includes('2026-08-01'), 'oldest dropped first');

  assert.equal(buildRecentDailySummariesBlock([]), '');
  assert.equal(buildRecentDailySummariesBlock([{ summaryDate: '2026-08-01', summaryText: '  ' }]), '');

  const totalBudgeted = buildRecentDailySummariesBlock(summaries, RECENT_SUMMARIES_MAX_CHARS);
  assert.ok(totalBudgeted.length < RECENT_SUMMARIES_MAX_CHARS + 400);
});

test('buildExperiencePromptBlocksXml joins non-empty blocks', () => {
  const both = buildExperiencePromptBlocksXml({
    identityText: '我是谁……',
    summaries: [{ summaryDate: '2026-08-03', summaryText: '概要' }],
    valueBoundaries: [{ text: '在涉及个人痛苦的话题上要更谨慎' }],
  });
  assert.ok(both.includes('<metabot_self_identity>'));
  assert.ok(both.includes('<recent_daily_summaries>'));
  assert.ok(both.includes('<value_boundaries>'));

  const identityOnly = buildExperiencePromptBlocksXml({ identityText: '我是谁……', summaries: [] });
  assert.ok(identityOnly.includes('<metabot_self_identity>'));
  assert.ok(!identityOnly.includes('<recent_daily_summaries>'));
  assert.ok(!identityOnly.includes('<value_boundaries>'));

  assert.equal(buildExperiencePromptBlocksXml({ summaries: [] }), '');
});

test('buildWorkReviewsBlock renders past reviews and joins the composed xml', () => {
  const block = buildWorkReviewsBlock([
    { text: '工作:海报设计;对象:Boss;评价:warming;依据:5 星好评,设计风格被点名表扬' },
    { text: '  ' },
    { text: '工作:数据整理;对象:Boss;评价:cooling;依据:2 星,跑题了' },
  ]);
  assert.ok(block.includes('<work_reviews>'));
  assert.equal((block.match(/<review>/g) || []).length, 2, 'blank entries skipped');
  assert.ok(block.includes('5 星好评'));
  assert.ok(block.includes('acceptance ratings'), 'review block names the human rating signal');
  assert.ok(block.includes('rated highly'), 'reuse guidance present');

  const capped = buildWorkReviewsBlock(Array.from({ length: 8 }, (_, i) => ({ text: `复盘${i}` })), 3);
  assert.equal((capped.match(/<review>/g) || []).length, 3);
  assert.equal(buildWorkReviewsBlock([]), '');

  const xml = buildExperiencePromptBlocksXml({
    summaries: [],
    workReviews: [{ text: '工作:海报设计;对象:Boss;评价:warming;依据:5 星' }],
  });
  assert.ok(xml.includes('<work_reviews>'));
  assert.ok(xml.includes('工作:海报设计'));
});

test('resolveExperienceRecallQuery: bare call is warm, keyword goes cold, dates pass through', () => {
  const today = new Date(2026, 7, 15, 12, 0);

  const warm = resolveExperienceRecallQuery({}, today);
  assert.equal(warm.query, undefined);
  assert.equal(warm.dateFrom, '2026-07-16', `${RECALL_WARM_DAYS} days back`);
  assert.equal(warm.limit, 10);

  const cold = resolveExperienceRecallQuery({ query: '发布计划' }, today);
  assert.equal(cold.query, '发布计划');
  assert.equal(cold.dateFrom, undefined, 'keyword search has no date bound by default');

  const pinned = resolveExperienceRecallQuery({ date_from: '2026-01-01', date_to: '2026-01-31', limit: 99 }, today);
  assert.equal(pinned.dateFrom, '2026-01-01');
  assert.equal(pinned.dateTo, '2026-01-31');
  assert.equal(pinned.limit, 30, 'limit clamped');

  const invalidDate = resolveExperienceRecallQuery({ date_from: 'last week' }, today);
  assert.equal(invalidDate.dateFrom, '2026-07-16', 'invalid date falls back to warm default');
});

test('formatExperienceRecallResults renders entries, session refs and the reuse hint', () => {
  const text = formatExperienceRecallResults([
    {
      summaryDate: '2026-08-03',
      summaryText: '第三天\n做了很多事\n按行分开',
      sessionRefs: [
        { sessionId: 'abc-123', title: '发布 MetaApp' },
        { sessionId: 'def-456', title: '' },
      ],
    },
  ]);
  assert.ok(text.startsWith('2026-08-03: 第三天 做了很多事 按行分开'));
  assert.ok(text.includes('IDBots://abc-123 发布 MetaApp'), 'session ref with title');
  assert.ok(text.includes('IDBots://def-456'), 'session ref without title');
  assert.ok(text.includes('idbots_session_read_all'), 'reuse hint points at reading sessions');
  assert.ok(text.includes('avoid the pitfalls'));

  const empty = formatExperienceRecallResults([]);
  assert.ok(empty.includes('No experience summaries found'));

  // Truncation still kicks in past the raised per-entry cap (1500 chars).
  const longText = '长'.repeat(2000);
  const truncated = formatExperienceRecallResults([{ summaryDate: '2026-08-03', summaryText: longText }]);
  assert.ok(truncated.includes('…'));
});

test('buildMinimalSelfCognitionBlocks renders identity + dream summaries and stays under the cap', () => {
  const pack = buildMinimalSelfCognitionBlocks({
    identityText: '我是一个 <专注> 视频创作的 MetaBot',
    summaries: [
      { summaryDate: '2026-10-02', summaryText: '第二天帮主人发了三个 buzz' },
      { summaryDate: '2026-10-01', summaryText: '第一天起步' },
    ],
  });
  assert.ok(pack.includes('<metabot_self_identity>'), 'identity block present');
  assert.ok(pack.includes('&lt;专注&gt;'), 'identity still xml-escaped');
  assert.ok(pack.includes('<recent_daily_summaries>'), 'dream summaries present');
  assert.ok(pack.includes('2026-10-02'));
  assert.ok(pack.length <= MINIMAL_SELF_COGNITION_MAX_CHARS, 'within the overall cap');
  // No value boundaries / work reviews / techniques — the minimal pack is identity + dreams only.
  assert.ok(!pack.includes('<value_boundaries>'));
  assert.ok(!pack.includes('<work_reviews>'));
  assert.ok(!pack.includes('<proven_techniques>'));

  assert.equal(buildMinimalSelfCognitionBlocks({ summaries: [] }), '', 'nothing to inject renders empty');
  assert.equal(buildMinimalSelfCognitionBlocks({ identityText: '  ', summaries: [] }), '');
});

test('buildMinimalSelfCognitionBlocks keeps the newest dream days within the summaries budget', () => {
  const longDay = (n) => `第${n}天 `.repeat(1) + '梦'.repeat(900);
  const pack = buildMinimalSelfCognitionBlocks({
    identityText: '我是谁',
    summaries: [
      { summaryDate: '2026-10-03', summaryText: longDay(3) },
      { summaryDate: '2026-10-02', summaryText: longDay(2) },
      { summaryDate: '2026-10-01', summaryText: longDay(1) },
    ],
  });
  assert.ok(pack.includes('2026-10-03'), 'newest day survives the summaries cap');
  assert.ok(!pack.includes('2026-10-01'), 'oldest day dropped first');
  const summariesSection = pack.slice(pack.indexOf('<recent_daily_summaries>'));
  assert.ok(
    summariesSection.length <= MINIMAL_SELF_COGNITION_SUMMARIES_MAX_CHARS + 500,
    'summaries section respects its own char budget',
  );
});

test('buildMinimalSelfCognitionBlocks never truncates the identity, even past the overall cap', () => {
  const longIdentity = `我是${'一个很长的自我认知'.repeat(400)}的 MetaBot`;
  const pack = buildMinimalSelfCognitionBlocks({
    identityText: longIdentity,
    summaries: [{ summaryDate: '2026-10-03', summaryText: '今天的梦' }],
  });
  assert.ok(pack.includes('<metabot_self_identity>'), 'identity survives');
  assert.ok(pack.includes(longIdentity), 'identity text is never cut');
  assert.ok(!pack.includes('<recent_daily_summaries>'), 'summaries drop entirely before identity is touched');
  assert.ok(pack.length > MINIMAL_SELF_COGNITION_MAX_CHARS, 'cap yields to identity integrity');
});
