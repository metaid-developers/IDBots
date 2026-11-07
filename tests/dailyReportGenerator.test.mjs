// src/main/services/dailyReportGenerator.ts — briefing + HTML report builder.
//
// Contract under test (no LLM in tests), v2 owner rework 2026-10-26:
//   a. follow-up list — `[title](idbots://session/<id>)` links + overdue
//      badges; the section is OMITTED ENTIRELY when pendingFollowUps is
//      empty (markdown + HTML), never an empty-state line;
//   b. owner-task table — step counts / percent, never the LLM's job;
//   c. machine rollups — one scheduled-runs summary line (total; "all
//      succeeded" when true; only failed/skipped NAMED, max 3, with bot),
//      one group-task count line, twin-delegate count; long-term journal
//      events never appear;
//   d. per-bot one-liners — deterministic text (title prefix folded, volume,
//      top external peer, OpenTeam, chain interactions) replacing the v1
//      counts table; the counts table is GONE from markdown and HTML;
//   e. agenda — next-24h scheduled fires (named, total, +N more), open
//      orchestrations by status, long-term one-liners; deterministic;
//   f. brain prompt — locale-native with THREE FIXED section headings
//      (昨日总览 / 各 Bot 一句话 / 需要你拍板) that fold in external chats,
//      OpenTeam and on-chain interactions;
//   g. prose parser — tolerant lift of bot lines + 🔴/🟡 needs bullets for
//      the HTML cards; anything unexpected degrades to empty;
//   h. HTML — self-contained visuals (KPI row, chart svg, bot cards, needs
//      cards, progress, agenda), data escaped, deep links preserved; the
//      brain prose is NOT embedded (headline line only);
//   i. generateDailyReport — no brain / failing brain → deterministic
//      fallback ships; brain path markdown = prose + follow-up links + agenda.
//
// The pure module is loaded straight from src/ (Node type stripping); there
// are no runtime relative imports in this test file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDailyReportAgendaMarkdown,
  buildDailyReportBotLineText,
  buildDailyReportBrainSystemPrompt,
  buildDailyReportFollowUpListMarkdown,
  buildDailyReportHtml,
  buildDailyReportMachineRollupMarkdown,
  buildDailyReportOwnerTasksMarkdown,
  buildDeterministicBotLines,
  buildDeterministicBriefing,
  DAILY_REPORT_BRAIN_MAX_TOKENS,
  extractDailyReportHeadlineLine,
  generateDailyReport,
  parseDailyReportBrainProse,
  resolveDailyReportStrings,
  sanitizeDailyReportBrainProse,
  DAILY_REPORT_STRINGS_EN,
  DAILY_REPORT_STRINGS_ZH,
} from '../src/main/services/dailyReportGenerator.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const sampleFacts = (overrides = {}) => ({
  generatedAtMs: Date.now(),
  windowStartMs: Date.now() - DAY_MS,
  windowEndMs: Date.now(),
  pendingFollowUps: [
    { sessionId: 'sess-1', title: 'Approve deploy plan', botName: 'Twin', source: 'cerebellum', ageDays: 3, overdue: true },
    { sessionId: 'sess-2', title: 'Pick a color <script>', botName: null, source: 'ask_user', ageDays: 0, overdue: false },
  ],
  ownerOrchestrations: [
    { taskId: 'ot1', title: 'Build landing | page', status: 'running', stepsDone: 2, stepsTotal: 4, percentComplete: 50, workerSessionIds: ['ws1'], updatedAt: null },
  ],
  humanSessions: [
    { sessionId: 'hs1', title: 'Landing copy', botName: 'Writer', sessionType: 'standard', humanUserMessages: 3, assistantMessages: 5, lastAssistantExcerpt: 'Draft ready', lastUserExcerpt: 'go' },
  ],
  machineActivity: {
    scheduledRuns: [{ taskName: 'Nightly inspect', botName: 'Ops', status: 'success', skipReason: null, startedAt: null, error: null }],
    groupTaskTransitions: [{ taskId: 9, title: 'Group push', fromStatus: 'executing', toStatus: 'review', actor: 'chair', reason: null, createdAt: null }],
    longTermEvents: [{ taskId: 'lt1', taskTitle: 'Q4 roadmap', subtaskId: null, kind: 'stage_changed', actor: 'twin', detail: 'active', createdAt: null }],
    longTermProgress: [{ taskId: 'lt1', title: 'Q4 roadmap', stage: 'active', subtasksAccepted: 1, subtasksTotal: 4, percentComplete: 25 }],
    twinDelegateOrchestrationsInWindow: 2,
  },
  onlineActivity: [{ botName: 'Ops', privateMessageCount: 4, groupMessageCount: 1 }],
  botActivity: [
    {
      botName: 'Twin',
      isTwin: true,
      totalSessions: 2,
      totalMessages: 120,
      sessions: [
        { sessionId: 'bs1', title: '[编排任务] MetaWeb Surf 2026-10-25', sessionType: 'standard', messageCount: 100, lastAssistantExcerpt: '{"summary":"surf report"}' },
        { sessionId: 'bs2', title: '移动化跟进', sessionType: 'standard', messageCount: 20, lastAssistantExcerpt: null },
      ],
      scheduledRuns: [{ taskName: 'Morning brief', status: 'success' }],
      scheduledRunCount: 2,
      externalChats: [{ peerName: 'BOT-007', messageCount: 12, lastExcerpt: 'judgement criteria settled' }],
      openTeam: [],
      chainInteractions: [{ kind: 'paylike', count: 9, lastSummary: 'liked a pin' }, { kind: 'paycomment', count: 3, lastSummary: null }],
      groupMessages: 3,
    },
    {
      botName: 'Ops',
      isTwin: false,
      totalSessions: 0,
      totalMessages: 0,
      sessions: [],
      scheduledRuns: [{ taskName: 'Nightly inspect', status: 'success' }],
      scheduledRunCount: 1,
      externalChats: [],
      openTeam: [{ taskTitle: 'Remote jam session', memberStatus: 'active', windowMessageCount: 4 }],
      chainInteractions: [],
      groupMessages: 1,
    },
  ],
  upcoming: {
    scheduledFires: [
      { fireAtLocal: '06:00', taskName: 'Server patrol', botName: 'Ops' },
      { fireAtLocal: '09:00', taskName: 'Topic digest', botName: 'Scout' },
    ],
    scheduledFiresTotal: 7,
    openOrchestrations: [{ taskName: 'Fix mobile login', status: 'review' }],
    openOrchestrationByStatus: { review: 12, planning: 1 },
  },
  hourlyActivity: {
    local: [10, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 3],
    online: [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  knownBotCount: 21,
  newSessionCount: 5,
  hasAnyActivity: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

test('resolveDailyReportStrings: zh prefix → Chinese, default English', () => {
  assert.equal(resolveDailyReportStrings('zh').language, 'zh');
  assert.equal(resolveDailyReportStrings('zh-CN').language, 'zh');
  assert.equal(resolveDailyReportStrings('en').language, 'en');
  assert.equal(resolveDailyReportStrings(null).language, 'en');
  assert.equal(resolveDailyReportStrings('fr').language, 'en');
  assert.notEqual(DAILY_REPORT_STRINGS_ZH.reportTitle, DAILY_REPORT_STRINGS_EN.reportTitle);
});

// ---------------------------------------------------------------------------
// Deterministic assembler
// ---------------------------------------------------------------------------

test('follow-up list: deep links + overdue badges, never LLM output', () => {
  const markdown = buildDailyReportFollowUpListMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_EN);
  assert.match(markdown, /\[Approve deploy plan\]\(idbots:\/\/session\/sess-1\)/);
  assert.match(markdown, /\[Pick a color <script>\]\(idbots:\/\/session\/sess-2\)/, 'raw title kept as link text data');
  assert.match(markdown, /overdue/);
  assert.match(markdown, /3d waiting/);
});

test('follow-up list: empty pending set → section omitted entirely (no empty-state line)', () => {
  const markdown = buildDailyReportFollowUpListMarkdown(
    sampleFacts({ pendingFollowUps: [] }),
    DAILY_REPORT_STRINGS_EN,
  );
  assert.equal(markdown, '');
  const zh = buildDailyReportFollowUpListMarkdown(
    sampleFacts({ pendingFollowUps: [] }),
    DAILY_REPORT_STRINGS_ZH,
  );
  assert.equal(zh, '');
});

test('owner-task table: steps + percent + pipe escaping', () => {
  const markdown = buildDailyReportOwnerTasksMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_EN);
  assert.match(markdown, /\| Task \| Status \| Steps \| Progress \|/);
  assert.match(markdown, /Build landing \\| page \| running \| 2\/4 \| 50% \|/);
});

test('machine rollups: all-succeeded line, count lines, no journal events', () => {
  const lines = buildDailyReportMachineRollupMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_EN);
  assert.deepEqual(lines, [
    'Scheduled runs 1 · all succeeded',
    'Group task updates 1',
    'Twin-delegated orchestrations touched: 2',
  ]);
  const joined = lines.join('\n');
  assert.doesNotMatch(joined, /stage_changed/, 'long-term journal events never reach the briefing');
  assert.doesNotMatch(joined, /Nightly inspect/, 'successful runs are not named one by one');
});

test('machine rollups: failed/skipped runs named (max 3) with bot; success still counted', () => {
  const facts = sampleFacts({
    machineActivity: {
      ...sampleFacts().machineActivity,
      scheduledRuns: [
        { taskName: 'Nightly inspect', botName: 'Ops', status: 'success', skipReason: null, startedAt: null, error: null },
        { taskName: 'Backup check', botName: 'Ops', status: 'failed', skipReason: null, startedAt: null, error: 'disk full' },
        { taskName: 'Site patrol', botName: 'Guard', status: 'skipped', skipReason: 'already_running', startedAt: null, error: null },
        { taskName: 'Feed fetch', botName: 'Scout', status: 'error', skipReason: null, startedAt: null, error: 'timeout' },
        { taskName: 'Fifth failure', botName: 'Ops', status: 'failed', skipReason: null, startedAt: null, error: 'x' },
        { taskName: 'Sixth failure', botName: 'Ops', status: 'failed', skipReason: null, startedAt: null, error: 'x' },
      ],
    },
  });
  const lines = buildDailyReportMachineRollupMarkdown(facts, DAILY_REPORT_STRINGS_EN);
  assert.match(lines[0], /^Scheduled runs 6 · failed\/skipped 3:/);
  const named = lines.slice(1).filter((l) => l.startsWith('- '));
  assert.equal(named.length, 3, 'at most 3 failed/skipped runs are named');
  assert.match(named.join('\n'), /Backup check · Ops — failed/);
  assert.match(named.join('\n'), /Site patrol · Guard — skipped \(already_running\)/);
  assert.doesNotMatch(named.join('\n'), /Sixth failure/, 'failures beyond the cap are not named');
});

test('bot one-liner text: prefix folded, volume + peer + OpenTeam + chain folded in', () => {
  const [twin] = sampleFacts().botActivity;
  const zh = buildDailyReportBotLineText(twin, DAILY_REPORT_STRINGS_ZH);
  assert.match(zh, /MetaWeb Surf 2026-10-25、移动化跟进/, 'delegation prefix folded, top-2 titles joined');
  assert.match(zh, /2 会话 · 120 消息 · 2 次定时/);
  assert.match(zh, /与 BOT-007 12 私信/);
  assert.match(zh, /链上 9 赞 \/ 3 评论/);
  assert.match(zh, /3 群消息/);
  const [ops] = sampleFacts().botActivity.slice(1);
  const enOps = buildDailyReportBotLineText(ops, DAILY_REPORT_STRINGS_EN);
  assert.match(enOps, /OpenTeam: Remote jam session/);
});

test('deterministic bot lines: one bullet per bot under the section title', () => {
  const markdown = buildDeterministicBotLines(sampleFacts(), DAILY_REPORT_STRINGS_ZH);
  assert.match(markdown, /\*\*各 Bot 一句话\*\*/);
  assert.match(markdown, /- \*\*Twin\*\*：/);
  assert.match(markdown, /- \*\*Ops\*\*：/);
  assert.equal(buildDeterministicBotLines(sampleFacts({ botActivity: [] }), DAILY_REPORT_STRINGS_ZH), '');
});

test('agenda: fires named with total, +N more, orchestration statuses, long-term', () => {
  const markdown = buildDailyReportAgendaMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_ZH);
  assert.match(markdown, /\*\*今日预告\*\*/);
  assert.match(markdown, /定时任务 7：06:00 Server patrol（Ops）、09:00 Topic digest（Scout） 等 5 项/);
  assert.match(markdown, /编排待办：review 12 · planning 1/);
  assert.match(markdown, /长期项目：Q4 roadmap 25%（active）/);
  assert.equal(
    buildDailyReportAgendaMarkdown(
      sampleFacts({ upcoming: { scheduledFires: [], scheduledFiresTotal: 0, openOrchestrations: [], openOrchestrationByStatus: {} }, machineActivity: { ...sampleFacts().machineActivity, longTermProgress: [] } }),
      DAILY_REPORT_STRINGS_ZH,
    ),
    '',
    'empty upcoming → section omitted',
  );
});

test('deterministic briefing: needs-you + bot lines + owner tasks + fleet + agenda; counts table gone', () => {
  const markdown = buildDeterministicBriefing(sampleFacts(), DAILY_REPORT_STRINGS_ZH);
  assert.match(markdown, /需要你处理/);
  assert.match(markdown, /idbots:\/\/session\/sess-1/);
  assert.match(markdown, /各 Bot 一句话/);
  assert.match(markdown, /- \*\*Twin\*\*：/);
  assert.match(markdown, /你发起的任务：/);
  assert.match(markdown, /长期项目：/);
  assert.match(markdown, /Bot 与自动化/);
  assert.match(markdown, /定时任务 1 · 全部成功/);
  assert.match(markdown, /今日预告/);
  assert.doesNotMatch(markdown, /\| Bot \| 会话 \|/, 'v1 per-bot counts table is gone');
  assert.doesNotMatch(markdown, /Landing copy/, 'humanSessions listing removed (brain input only)');
  assert.doesNotMatch(markdown, /stage_changed/, 'long-term journal events removed');
});

test('deterministic briefing: empty follow-ups → no needs-you section, rest intact', () => {
  const markdown = buildDeterministicBriefing(
    sampleFacts({ pendingFollowUps: [] }),
    DAILY_REPORT_STRINGS_EN,
  );
  assert.doesNotMatch(markdown, /Needs you/);
  assert.match(markdown, /Bot one-liners/, 'bot lines still ship');
  assert.match(markdown, /Owner-sourced tasks:/, 'other sections still ship');
  assert.match(markdown, /Scheduled runs 1 · all succeeded/);
});

// ---------------------------------------------------------------------------
// Brain prompt (locale-native, three FIXED section headings)
// ---------------------------------------------------------------------------

test('brain prompt: zh mandates the three fixed sections and the external dimensions', () => {
  const prompt = buildDailyReportBrainSystemPrompt(DAILY_REPORT_STRINGS_ZH);
  assert.match(prompt, /执行助理/);
  assert.match(prompt, /## 昨日总览/);
  assert.match(prompt, /## 各 Bot 一句话/);
  assert.match(prompt, /## 需要你拍板/);
  assert.match(prompt, /外部 bot/);
  assert.match(prompt, /OpenTeam/);
  assert.match(prompt, /链上/);
  assert.match(prompt, /🔴/);
});

test('brain prompt: en mirrors the fixed headings and external dimensions', () => {
  const prompt = buildDailyReportBrainSystemPrompt(DAILY_REPORT_STRINGS_EN);
  assert.match(prompt, /## Yesterday at a glance/);
  assert.match(prompt, /## Bot one-liners/);
  assert.match(prompt, /## Needs you/);
  assert.match(prompt, /external bot/i);
  assert.match(prompt, /OpenTeam/);
  assert.match(prompt, /on-chain/);
  assert.doesNotMatch(prompt, /昨日总览/, 'locale-native, no zh headings in the en prompt');
});

// ---------------------------------------------------------------------------
// Prose parser (tolerant lift for the HTML cards)
// ---------------------------------------------------------------------------

test('parseDailyReportBrainProse: lifts overview, bot lines and needs levels', () => {
  const sections = parseDailyReportBrainProse([
    '## 昨日总览',
    '主线 A 推进到 50%，无阻塞。',
    '## 各 Bot 一句话',
    '- **Twin**：移动端验收通过，挖出充值页故障。',
    '- **Ops**：巡检两次全部成功。',
    '## 需要你拍板',
    '- 🔴 充值页密钥失效——建议今天修。',
    '- 🟡 外包单转账被拒——放行或撤件。',
    '## 未知小节',
    'ignored',
  ].join('\n'));
  assert.equal(sections.overviewMarkdown, '主线 A 推进到 50%，无阻塞。');
  assert.deepEqual(sections.botLines, [
    { botName: 'Twin', text: '移动端验收通过，挖出充值页故障。' },
    { botName: 'Ops', text: '巡检两次全部成功。' },
  ]);
  assert.deepEqual(sections.needsYou.map((need) => need.level), ['red', 'amber']);
  assert.match(sections.needsYou[0].text, /充值页/);
});

test('parseDailyReportBrainProse: garbage degrades to empty, never throws', () => {
  assert.deepEqual(parseDailyReportBrainProse(''), { overviewMarkdown: null, botLines: [], needsYou: [] });
  assert.deepEqual(parseDailyReportBrainProse('random text\nno headings'), { overviewMarkdown: null, botLines: [], needsYou: [] });
});

test('extractDailyReportHeadlineLine: first non-heading non-empty line', () => {
  assert.equal(extractDailyReportHeadlineLine('## 昨日总览\n\n总览第一句。\n第二句。'), '总览第一句。');
  assert.equal(extractDailyReportHeadlineLine(''), null);
});

// ---------------------------------------------------------------------------
// HTML report (visuals; no prose duplication)
// ---------------------------------------------------------------------------

test('buildDailyReportHtml: KPI row, chart svg, bot cards, needs cards, agenda; prose not embedded', () => {
  const html = buildDailyReportHtml({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_ZH,
    dateLabel: '2026-10-22',
    headlineText: '总览首句。',
    proseMarkdown: [
      '## 昨日总览',
      '总览首句。只出现在标题带里的第二段句子 SECOND-PROSE-ONLY-LINE 不应出现在 HTML。',
      '## 各 Bot 一句话',
      '- **Twin**：LLM 写的一句话。',
      '## 需要你拍板',
      '- 🔴 充值页密钥失效。',
    ].join('\n'),
  });
  assert.match(html, /<title>每日汇报 2026-10-22<\/title>/);
  // KPI row.
  assert.match(html, /2<small>\/21<\/small>/);
  assert.match(html, /本地消息/);
  assert.match(html, /全部成功/);
  // Chart: svg + polyline present.
  assert.match(html, /<svg viewBox="0 0 880 150"/);
  assert.match(html, /<polyline fill="none" stroke="#fbbf24"/);
  // Bot cards: LLM line preferred, meter + chips rendered; bots without a
  // brain line fall back to the deterministic text (chain/OpenTeam words).
  assert.match(html, /LLM 写的一句话。/);
  assert.match(html, /class="bot"/);
  assert.match(html, /OpenTeam: Remote jam session/, 'deterministic fallback text on the Ops card');
  // Needs cards: 🔴 card + follow-up deep link.
  assert.match(html, /need red/);
  assert.match(html, /充值页密钥失效/);
  assert.match(html, /href="idbots:\/\/session\/sess-1"/);
  assert.match(html, /Pick a color &lt;script&gt;/, 'title escaped');
  assert.ok(!html.includes('<script>alert'));
  // Agenda.
  assert.match(html, /今日预告/);
  assert.match(html, /Server patrol/);
  // Prose duplication guard: only the headline line rides along.
  assert.doesNotMatch(html, /SECOND-PROSE-ONLY-LINE/);
  assert.match(html, /总览首句。/);
  // v1 counts table is gone.
  assert.doesNotMatch(html, /各 Bot 活动/);
  assert.doesNotMatch(html, /Landing copy/, 'human-session table removed from HTML');
  assert.match(html, /新建会话: 5/, 'session count kept in the meta line');
});

test('buildDailyReportHtml: empty follow-ups and no brain needs → no needs-you section at all', () => {
  const html = buildDailyReportHtml({
    facts: sampleFacts({ pendingFollowUps: [] }),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
  });
  assert.doesNotMatch(html, /Needs you/);
  assert.match(html, /Owner tasks/, 'other sections still render');
});

// ---------------------------------------------------------------------------
// generateDailyReport end-to-end (no real LLM)
// ---------------------------------------------------------------------------

test('generateDailyReport: no brain → deterministic fallback ships + HTML written', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  const result = await generateDailyReport({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    reportDir,
    brain: null,
    performChat: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.usedFallback, true);
  assert.match(result.briefingMarkdown, /Here is your daily briefing\./);
  assert.match(result.briefingMarkdown, /idbots:\/\/session\/sess-1/);
  assert.match(result.briefingMarkdown, /Bot one-liners/);
  assert.match(result.briefingMarkdown, /Today ahead/);
  assert.equal(path.basename(result.htmlFilePath), '2026-10-22.html');
  assert.ok(fs.existsSync(result.htmlFilePath), 'HTML file written');
  assert.match(result.htmlFileUrl, /^file:\/\//);
  fs.rmSync(reportDir, { recursive: true, force: true });
});

test('generateDailyReport: failing brain degrades to fallback (report never goes missing)', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  const result = await generateDailyReport({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    reportDir,
    brain: { llmId: 'glm-test' },
    performChat: async () => { throw new Error('LLM request failed: 429 slow down'); },
  });
  assert.equal(result.usedFallback, true);
  assert.match(result.briefingMarkdown, /idbots:\/\/session\/sess-1/);
  assert.ok(fs.existsSync(result.htmlFilePath));
  fs.rmSync(reportDir, { recursive: true, force: true });
});

test('generateDailyReport: brain prose spliced with links + agenda; HTML carries cards not prose', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  let seen = null;
  const result = await generateDailyReport({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    reportDir,
    brain: { llmId: 'glm-test', fallbackLlmId: 'glm-backup' },
    performChat: async (systemPrompt, userMessage, llmId, options) => {
      seen = { systemPrompt, userMessage, llmId, options };
      return [
        '## Yesterday at a glance',
        'A calm day overall: "Build landing page" is halfway there, nothing blocked.',
        '## Bot one-liners',
        '- **Twin**: pushed mobile acceptance through; surfaced a paywall key issue.',
        '## Needs you',
        '- 🔴 Approve the rollout window today.',
      ].join('\n');
    },
  });
  assert.equal(result.usedFallback, false);
  assert.equal(seen.llmId, 'glm-test');
  assert.equal(seen.options.fallbackLlmId, 'glm-backup', 'brain ladder rides primary→fallback');
  assert.equal(seen.options.maxTokens, DAILY_REPORT_BRAIN_MAX_TOKENS);
  assert.equal(seen.options.webSearch, false);
  assert.match(seen.systemPrompt, /## Bot one-liners/);
  assert.match(seen.userMessage, /"sessionId":"sess-1"/);
  // Markdown = prose, then follow-up links, then agenda.
  assert.match(result.briefingMarkdown, /A calm day overall/, 'prose first');
  assert.match(result.briefingMarkdown, /\[Approve deploy plan\]\(idbots:\/\/session\/sess-1\)/, 'deterministic links attached');
  assert.match(result.briefingMarkdown, /Today ahead/, 'agenda appended after prose');
  const html = fs.readFileSync(result.htmlFilePath, 'utf8');
  assert.match(html, /pushed mobile acceptance through/, 'bot line rendered as an HTML card');
  assert.doesNotMatch(html, /A calm day overall: "Build landing page"/, 'full prose paragraph not duplicated into HTML');
  fs.rmSync(reportDir, { recursive: true, force: true });
});

test('generateDailyReport: zh locale keeps the Chinese prompt and no needs-you when empty', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  let seen = null;
  const result = await generateDailyReport({
    facts: sampleFacts({ pendingFollowUps: [] }),
    strings: DAILY_REPORT_STRINGS_ZH,
    dateLabel: '2026-10-22',
    reportDir,
    brain: { llmId: 'glm-test' },
    performChat: async (systemPrompt) => {
      seen = systemPrompt;
      return '## 昨日总览\n今天整体平稳：主线推进 50%，没有阻塞。\n\n## 各 Bot 一句话\n- **Twin**：主线推进与验收。';
    },
  });
  assert.match(seen, /## 各 Bot 一句话/);
  assert.equal(result.usedFallback, false);
  assert.match(result.briefingMarkdown, /今天整体平稳/);
  assert.doesNotMatch(result.briefingMarkdown, /需要你处理/, 'needs-you header absent when no follow-ups');
  assert.doesNotMatch(result.briefingMarkdown, /待跟进入口/, 'links block omitted when nothing is pending');
  assert.match(result.briefingMarkdown, /今日预告/, 'agenda still ships');
  fs.rmSync(reportDir, { recursive: true, force: true });
});

// ── Brain prose CoT hygiene (2026-11-07 commandcode incident) ───────────────
//
// The relay serving glm-5.3-flash intermittently flattens the model's
// chain-of-thought INTO message.content; the briefing contract requires the
// prose to START with the verbatim overview heading, so the sanitize gate
// cuts everything before it and degrades to the deterministic briefing when
// nothing contract-valid remains.

test('sanitizeDailyReportBrainProse: cuts relay-flattened CoT prefix up to the overview heading', () => {
  // Real-world leak shape (2026-11-07): EN/CN mixed CoT with a plain-text
  // "昨日总览: …" notes line (no ## prefix — must NOT cut there), then
  // "Draft:", then the contract prose.
  const leaked = [
    'Let me digest the facts and write the daily brief in Chinese, GitHub markdown, no code blocks, no links/IDs, under 600 chars.',
    'Key items:',
    '昨日总览: Three long-term projects: NFT 80%, mobile 60%, commercial 22%.',
    '需要你拍板: two red items.',
    'Word budget: ~600 Chinese characters total. Need to be tight.',
    'Draft:',
    '## 昨日总览',
    '三大主线均卡在等您拍板。',
    '## 各 Bot 一句话',
    '- **Twin**：推进主线验收。',
  ].join('\n');
  const clean = sanitizeDailyReportBrainProse(leaked);
  assert.match(clean, /^## 昨日总览/, 'prose starts at the verbatim heading');
  assert.doesNotMatch(clean, /Let me digest/, 'CoT prefix gone');
  assert.doesNotMatch(clean, /Word budget/, 'mid-CoT notes gone');
  assert.doesNotMatch(clean, /Draft:/, 'draft marker gone');
  assert.match(clean, /三大主线均卡在等您拍板/, 'answer body kept');
  assert.match(clean, /- \*\*Twin\*\*：推进主线验收。/, 'later sections kept');
});

test('sanitizeDailyReportBrainProse: strips <think>/<thinking> blocks and honors the EN heading', () => {
  const tagged = '<think>Plan the sections first.</think>\nSome preamble the relay kept.\n## Yesterday at a glance\nA calm day.';
  const clean = sanitizeDailyReportBrainProse(tagged);
  assert.doesNotMatch(clean, /<think>/, 'think block stripped');
  assert.match(clean, /^## Yesterday at a glance/, 'EN overview heading recognized');
  assert.match(clean, /A calm day\./);
});

test('sanitizeDailyReportBrainProse: a drafted heading inside <think> never becomes the cut point', () => {
  const trapped = [
    '<think>Outline:',
    '## 昨日总览 (draft only, not the answer)',
    'Then compute the budget.</think>',
    '## 昨日总览',
    '正式内容。',
  ].join('\n');
  const clean = sanitizeDailyReportBrainProse(trapped);
  assert.equal(clean, '## 昨日总览\n正式内容。');
});

test('sanitizeDailyReportBrainProse: contract-violating prose degrades to empty', () => {
  assert.equal(sanitizeDailyReportBrainProse('Just some prose with no headings at all.'), '');
  assert.equal(sanitizeDailyReportBrainProse('## 各 Bot 一句话\n- **Twin**：missing the overview section'), '');
  assert.equal(sanitizeDailyReportBrainProse(''), '');
  assert.equal(sanitizeDailyReportBrainProse(null), '');
});

test('sanitizeDailyReportBrainProse: clean contract prose passes through untouched', () => {
  const clean = '## 昨日总览\n今天整体平稳。\n\n## 各 Bot 一句话\n- **Twin**：推进主线。';
  assert.equal(sanitizeDailyReportBrainProse(clean), clean);
});

test('generateDailyReport: relay-flattened CoT prefix is cut, prose still adopted', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  const result = await generateDailyReport({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    reportDir,
    brain: { llmId: 'glm-test' },
    performChat: async () =>
      'Let me plan the brief. Budget check: 600 chars.\nDraft:\n## Yesterday at a glance\nA calm day overall.\n## Bot one-liners\n- **Twin**: shipped the fix.',
  });
  assert.equal(result.usedFallback, false);
  assert.doesNotMatch(result.briefingMarkdown, /Let me plan the brief/, 'CoT never reaches the owner');
  assert.match(result.briefingMarkdown, /## Yesterday at a glance/, 'prose adopted after the cut');
  const html = fs.readFileSync(result.htmlFilePath, 'utf8');
  assert.doesNotMatch(html, /Let me plan the brief/, 'headline is no longer the leaked CoT');
  fs.rmSync(reportDir, { recursive: true, force: true });
});

test('generateDailyReport: no overview heading at all → deterministic fallback (contract failure)', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  const result = await generateDailyReport({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    reportDir,
    brain: { llmId: 'glm-test' },
    performChat: async () => 'Truncated mid-thinking: the fleet looks busy today, lots of surf activity and',
  });
  assert.equal(result.usedFallback, true, 'non-conforming prose degrades like a failing brain');
  assert.match(result.briefingMarkdown, /Here is your daily briefing\./);
  assert.doesNotMatch(result.briefingMarkdown, /Truncated mid-thinking/);
  fs.rmSync(reportDir, { recursive: true, force: true });
});

// ── Waiting-on-external follow-ups (2026-10-28) ─────────────────────────────
//
// Contract: a follow-up whose work waits on an external condition keeps its
// age suffix but shows the waiting badge INSTEAD of the overdue badge, in
// both markdown and HTML, in both locales.

test('follow-up list: waiting-on-external badge replaces overdue (markdown en/zh)', () => {
  const facts = sampleFacts({
    pendingFollowUps: [
      { sessionId: 'sess-w', title: 'Wait for upstream merge', botName: 'Twin', source: 'cerebellum', ageDays: 5, overdue: false, waitingOnExternal: true },
      { sessionId: 'sess-o', title: 'Approve deploy plan', botName: 'Twin', source: 'cerebellum', ageDays: 3, overdue: true, waitingOnExternal: false },
    ],
  });
  const en = buildDailyReportFollowUpListMarkdown(facts, DAILY_REPORT_STRINGS_EN);
  const waitingLineEn = en.split('\n').find((line) => line.includes('sess-w'));
  const overdueLineEn = en.split('\n').find((line) => line.includes('sess-o'));
  assert.ok(waitingLineEn.includes('waiting on external'), 'waiting badge present');
  assert.ok(!waitingLineEn.includes('overdue'), 'waiting line never says overdue');
  assert.ok(waitingLineEn.includes('5d waiting'), 'age suffix kept');
  assert.ok(overdueLineEn.includes('**overdue**'), 'plain overdue item unaffected');

  const zh = buildDailyReportFollowUpListMarkdown(facts, DAILY_REPORT_STRINGS_ZH);
  const waitingLineZh = zh.split('\n').find((line) => line.includes('sess-w'));
  const overdueLineZh = zh.split('\n').find((line) => line.includes('sess-o'));
  assert.ok(waitingLineZh.includes('等待外部'), 'zh waiting badge present');
  assert.ok(!waitingLineZh.includes('已逾期'), 'zh waiting line never says overdue');
  assert.ok(waitingLineZh.includes('5天待处理'), 'zh age suffix kept');
  assert.ok(overdueLineZh.includes('**已逾期**'), 'zh plain overdue item unaffected');
});

test('follow-up list: overdue forced false for waiting items even if facts disagree', () => {
  // Defensive: if an older facts shape ever stamped overdue=true on a
  // waiting item, the renderer still shows waiting, never both.
  const facts = sampleFacts({
    pendingFollowUps: [
      { sessionId: 'sess-x', title: 'Contradictory', botName: null, source: 'cerebellum', ageDays: 4, overdue: true, waitingOnExternal: true },
    ],
  });
  const en = buildDailyReportFollowUpListMarkdown(facts, DAILY_REPORT_STRINGS_EN);
  const line = en.split('\n').find((l) => l.includes('sess-x'));
  assert.ok(line.includes('waiting on external'));
  assert.ok(!line.includes('overdue**'), 'overdue loses to waiting');
});

test('HTML needs cards: waiting badge shown, overdue badge suppressed for waiting items', () => {
  const facts = sampleFacts({
    pendingFollowUps: [
      { sessionId: 'sess-w', title: 'Wait for upstream merge', botName: 'Twin', source: 'cerebellum', ageDays: 5, overdue: false, waitingOnExternal: true },
      { sessionId: 'sess-o', title: 'Approve deploy plan', botName: 'Twin', source: 'cerebellum', ageDays: 3, overdue: true, waitingOnExternal: false },
    ],
  });
  const html = buildDailyReportHtml({
    facts,
    strings: DAILY_REPORT_STRINGS_ZH,
    dateLabel: '2026-10-28',
  });
  const waitingCard = html.split('class="need link"').find((chunk) => chunk.includes('sess-w'));
  const overdueCard = html.split('class="need link"').find((chunk) => chunk.includes('sess-o'));
  assert.ok(waitingCard, 'waiting card rendered');
  assert.ok(waitingCard.includes('等待外部'), 'zh waiting badge in HTML');
  assert.ok(!waitingCard.includes('已逾期'), 'no overdue badge on the waiting card');
  assert.ok(waitingCard.includes('5天待处理'), 'age suffix kept in HTML');
  assert.ok(overdueCard.includes('已逾期'), 'plain overdue card unaffected');
});
