// src/main/services/dailyReportCollector.ts — deterministic fact collection
// for the Daily Report.
//
// Contract under test:
//   a. window computation — since last successful windowEnd; first run =
//      yesterday 00:00 local; 7-day lookback cap; degenerate windows clamp;
//   b. text caps — whitespace collapse, UTF-16-safe ellipsis cut;
//   c. bucket shaping — top-N, age/overdue math, step percent, excerpts;
//   d. hasAnyActivity — the E10 skip bit (digests never count as activity);
//   e. facts JSON cap — digests shrink first, then excerpts, then counts;
//   f. collectDailyReportFacts with a fake db — every bucket fails soft to
//      empty when its query throws, and the whole call still returns facts.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_REPORT_MAX_FACTS_JSON_BYTES,
  DAILY_REPORT_MAX_HUMAN_SESSIONS,
  DAILY_REPORT_MAX_PENDING_FOLLOW_UPS,
  chainKindFromPath,
  computeDailyReportHasAnyActivity,
  computeDailyReportWindow,
  capDailyReportText,
  collectDailyReportFacts,
  collectPendingFollowUpLifecycle,
  enforceDailyReportFactsCap,
  shapeBotSessionsForBot,
  shapeChainInteractionFacts,
  shapeExternalChatFacts,
  shapeHourlyActivity,
  shapeHumanSessionRows,
  shapeOwnerOrchestrationRows,
  shapeOverdueRows,
  shapePendingFollowUpRows,
  shapeUpcomingFires,
  stripDailyReportSessionTitlePrefix,
  DAILY_REPORT_OVERDUE_REVIEW_STALLED_HOURS,
  DAILY_REPORT_OVERDUE_WAITING_OWNER_HOURS,
} from '../src/main/services/dailyReportCollector.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// local midnight helper (test machine timezone)
const localMidnightMs = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

test('computeDailyReportWindow: first run = yesterday 00:00 local → now', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const { windowStartMs, windowEndMs } = computeDailyReportWindow({ nowMs });
  assert.equal(windowEndMs, nowMs);
  assert.equal(windowStartMs, localMidnightMs(nowMs) - DAY_MS);
});

test('computeDailyReportWindow: since last successful windowEndMs', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const lastEnd = nowMs - 3 * 60 * 60 * 1000;
  const { windowStartMs } = computeDailyReportWindow({ nowMs, lastSuccessfulWindowEndMs: lastEnd });
  assert.equal(windowStartMs, lastEnd);
});

test('computeDailyReportWindow: lookback capped at 7 days', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const { windowStartMs } = computeDailyReportWindow({
    nowMs,
    lastSuccessfulWindowEndMs: nowMs - 30 * DAY_MS,
  });
  assert.equal(windowStartMs, nowMs - 7 * DAY_MS);
});

test('computeDailyReportWindow: degenerate window clamps to 1s', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const { windowStartMs } = computeDailyReportWindow({ nowMs, lastSuccessfulWindowEndMs: nowMs + 5000 });
  assert.equal(windowStartMs, nowMs - 1000);
});

test('capDailyReportText: collapses whitespace and cuts with ellipsis', () => {
  assert.equal(capDailyReportText('  a\n\t b   c ', 20), 'a b c');
  assert.equal(capDailyReportText('x'.repeat(10), 5), 'xxxx…');
  assert.equal(capDailyReportText('x'.repeat(10), 1), '…');
  assert.equal(capDailyReportText(null, 10), '');
  // lone-surrogate safety: cutting before a surrogate pair must not orphan it
  const withPair = `ab${'😀'}cd`;
  assert.equal(capDailyReportText(withPair, 3), 'ab…');
});

test('shapePendingFollowUpRows: caps, age and overdue from follow_up_at', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const rows = Array.from({ length: DAILY_REPORT_MAX_PENDING_FOLLOW_UPS + 3 }, (_, i) => ({
    id: `s${i}`,
    title: `session ${i}`,
    bot_name: i % 2 ? 'Twin' : null,
    follow_up_source: 'cerebellum',
    follow_up_at: new Date(nowMs - (i + 1) * DAY_MS).toISOString(),
  }));
  const shaped = shapePendingFollowUpRows(rows, nowMs);
  assert.equal(shaped.length, DAILY_REPORT_MAX_PENDING_FOLLOW_UPS);
  assert.equal(shaped[0].ageDays, 1);
  assert.equal(shaped[0].overdue, false);
  assert.equal(shaped[1].ageDays, 2);
  assert.equal(shaped[1].overdue, true, '>= 2 days is overdue');
  assert.equal(shaped[1].botName, 'Twin');
  const noStamp = shapePendingFollowUpRows([{ id: 'x', title: 't', follow_up_at: null }], nowMs);
  assert.equal(noStamp[0].ageDays, null);
  assert.equal(noStamp[0].overdue, false);
});

test('shapeOwnerOrchestrationRows: step percent and worker session links', () => {
  const tasks = [
    { id: 't1', owner_intent: 'Build the thing', status: 'running', updated_at: new Date().toISOString() },
    { id: 't2', owner_intent: 'Untouched', status: 'planning', updated_at: new Date().toISOString() },
  ];
  const steps = [
    { task_id: 't1', status: 'completed' },
    { task_id: 't1', status: 'completed' },
    { task_id: 't1', status: 'running' },
    { task_id: 't1', status: 'blocked' },
  ];
  const attempts = [
    { task_id: 't1', worker_session_id: 'ws1' },
    { task_id: 't1', worker_session_id: 'ws1' },
    { task_id: 't1', worker_session_id: 'ws2' },
  ];
  const shaped = shapeOwnerOrchestrationRows(tasks, steps, attempts);
  assert.equal(shaped.length, 2);
  assert.equal(shaped[0].stepsDone, 2);
  assert.equal(shaped[0].stepsTotal, 4);
  assert.equal(shaped[0].percentComplete, 50);
  assert.deepEqual(shaped[0].workerSessionIds, ['ws1', 'ws2'], 'deduped, capped at 5');
  assert.equal(shaped[1].percentComplete, null, 'no steps → no percent');
});

test('shapeHumanSessionRows: excerpts capped, assistant + user kept separate', () => {
  const rows = [{ id: 's1', title: 'Chat', bot_name: 'W', human_user_count: 3, assistant_count: 9 }];
  const excerpts = new Map([{ assistant: 'A'.repeat(2000), user: 'U'.repeat(800) }].map((e) => ['s1', e]));
  const shaped = shapeHumanSessionRows(rows, excerpts);
  assert.equal(shaped.length, 1);
  assert.equal(shaped[0].lastAssistantExcerpt.length, 600);
  assert.equal(shaped[0].lastUserExcerpt.length, 300);
  assert.equal(shaped[0].humanUserMessages, 3);
  assert.equal(shaped[0].assistantMessages, 9);
});

test('computeDailyReportHasAnyActivity: E10 skip bit, digests excluded', () => {
  const base = {
    pendingFollowUps: [],
    ownerOrchestrations: [],
    humanSessions: [],
    machineActivity: {
      scheduledRuns: [],
      groupTaskTransitions: [],
      longTermEvents: [],
      twinDelegateOrchestrationsInWindow: 0,
      overdueItems: [],
    },
    onlineActivity: [],
    newSessionCount: 0,
  };
  assert.equal(computeDailyReportHasAnyActivity(base), false);
  assert.equal(
    computeDailyReportHasAnyActivity({
      ...base,
      machineActivity: { ...base.machineActivity, overdueItems: [{ kind: 'orchestration_review_stalled' }] },
    }),
    true,
    'T-B: an overdue escalation alone justifies shipping the report',
  );
  assert.equal(computeDailyReportHasAnyActivity({ ...base, newSessionCount: 1 }), true, 'any new session counts');
  assert.equal(computeDailyReportHasAnyActivity({ ...base, pendingFollowUps: [1] }), true);
  assert.equal(
    computeDailyReportHasAnyActivity({
      ...base,
      machineActivity: { ...base.machineActivity, twinDelegateOrchestrationsInWindow: 2 },
    }),
    true,
  );
  assert.equal(
    computeDailyReportHasAnyActivity({ ...base, onlineActivity: [{ privateMessageCount: 0, groupMessageCount: 1 }] }),
    true,
  );
});

test('enforceDailyReportFactsCap: shrinks bot excerpts first; never drops bots while text still trims', () => {
  const nowMs = Date.now();
  const bigSession = () => ({
    sessionId: 's',
    title: 't',
    botName: null,
    sessionType: 'standard',
    humanUserMessages: 1,
    assistantMessages: 1,
    lastAssistantExcerpt: 'x'.repeat(3000),
    lastUserExcerpt: null,
  });
  const facts = {
    generatedAtMs: nowMs,
    windowStartMs: nowMs - DAY_MS,
    windowEndMs: nowMs,
    pendingFollowUps: [],
    ownerOrchestrations: [],
    humanSessions: [bigSession()],
    machineActivity: {
      scheduledRuns: [],
      groupTaskTransitions: [],
      longTermEvents: [],
      longTermProgress: [],
      twinDelegateOrchestrationsInWindow: 0,
    },
    onlineActivity: [],
    botActivity: Array.from({ length: 20 }, (_, i) => ({
      botName: `bot${i}`,
      isTwin: false,
      totalSessions: 3,
      totalMessages: 300,
      sessions: Array.from({ length: 3 }, (_, j) => ({
        sessionId: `s${i}-${j}`,
        title: 'Big work',
        sessionType: 'standard',
        messageCount: 100,
        lastAssistantExcerpt: 'y'.repeat(3000),
      })),
      scheduledRuns: [],
      scheduledRunCount: 0,
      externalChats: [{ peerName: 'peer', messageCount: 4, lastExcerpt: 'z'.repeat(2000) }],
      openTeam: [],
      chainInteractions: [{ kind: 'paylike', count: 3, lastSummary: 'w'.repeat(2000) }],
      groupMessages: 0,
    })),
    upcoming: { scheduledFires: [], scheduledFiresTotal: 0, openOrchestrations: [], openOrchestrationByStatus: {} },
    hourlyActivity: { local: new Array(12).fill(0), online: new Array(12).fill(0) },
    knownBotCount: 20,
    newSessionCount: 0,
    hasAnyActivity: true,
  };
  const capped = enforceDailyReportFactsCap(facts, DAILY_REPORT_MAX_FACTS_JSON_BYTES);
  assert.ok(
    Buffer.byteLength(JSON.stringify(capped), 'utf8') <= DAILY_REPORT_MAX_FACTS_JSON_BYTES,
    'fits the 80KB budget',
  );
  assert.equal(capped.botActivity.length, 20, 'all 20 bots survive — text trim suffices');
  assert.equal(capped.botActivity[0].sessions.length, 3, 'sessions per bot intact at rung 1');
  assert.ok(capped.botActivity[0].sessions[0].lastAssistantExcerpt.length <= 100, 'excerpts trimmed to 100');
});

test('collectDailyReportFacts: full pass over a fake db; broken buckets fail soft', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const windowStartMs = nowMs - DAY_MS;
  const calls = [];
  const fakeDb = {
    queryAll(sql, params = []) {
      calls.push(sql);
      if (sql.includes('FROM cowork_sessions s') && sql.includes('follow_up_state')) {
        return [{ id: 'fu1', title: 'Decide shipping', follow_up_source: 'cerebellum', follow_up_at: new Date(nowMs - 3 * DAY_MS).toISOString(), bot_name: 'Twin' }];
      }
      if (sql.includes('FROM orchestration_tasks t')) {
        return [{ id: 'ot1', owner_intent: 'Owner task', status: 'running', updated_at: new Date(nowMs - 1000).toISOString() }];
      }
      if (sql.includes('twin_delegate')) return [{ cnt: 1 }];
      if (sql.includes('FROM orchestration_steps')) {
        return [{ task_id: 'ot1', status: 'completed' }, { task_id: 'ot1', status: 'running' }];
      }
      if (sql.includes('FROM orchestration_attempts')) {
        return [{ task_id: 'ot1', worker_session_id: 'ws9' }];
      }
      if (sql.includes('human_user_count')) {
        return [{ id: 'hs1', title: 'Human chat', session_type: 'standard', updated_at: nowMs, bot_name: 'W', human_user_count: 2, assistant_count: 4 }];
      }
      if (sql.includes("m.type = 'assistant'")) return [{ content: 'assistant says hi' }];
      if (sql.includes("m.type = 'user'")) return [{ content: 'user asked' }];
      // v2 botActivity: per-bot sessions (all types) with in-window counts.
      if (sql.includes('s.metabot_id IS NOT NULL')) {
        return [
          { metabot_id: 7, bot_name: 'W', session_id: 'bs1', session_title: '[编排任务] Deep work', session_type: 'standard', message_count: 10 },
          { metabot_id: 7, bot_name: 'W', session_id: 'bs2', session_title: 'Chit chat', session_type: 'a2a', message_count: 2 },
        ];
      }
      // v2 external DM peers (matched BEFORE the generic private-chat query).
      if (sql.includes('peer_global')) {
        return [{ metabot_id: 7, bot_name: 'W', bot_global: 'g-w', peer_global: 'g-peer', peer_name: 'BOT-007', message_count: 6 }];
      }
      if (sql.includes('m.to_global_metaid = ?')) return [{ content: 'peer chat excerpt' }];
      // v2 OpenTeam participation.
      if (sql.includes('FROM openteam_memberships')) {
        return [{ metabot_id: 7, bot_name: 'W', task_title: 'Remote jam', member_status: 'active', group_id: 'grp-1', joined_in_window: 1, status_in_window: 0 }];
      }
      if (sql.includes('g.group_id = ?')) return [{ cnt: 2 }];
      // v2 chain interactions.
      if (sql.includes('w.metabot_id = ? AND w.path')) return [{ summary: 'liked a pin' }];
      if (sql.includes('FROM metabot_chain_writes')) {
        return [{ metabot_id: 7, bot_name: 'W', path: '/protocols/paylike', cnt: 9 }];
      }
      // v2 hourly buckets.
      if (sql.includes('Datetime(m.created_at/1000')) return [{ h: 9, cnt: 4 }];
      if (sql.includes("strftime('%H', m.created_at, 'localtime')")) return [{ h: 1, cnt: 3 }];
      if (sql.includes('SELECT s.id FROM cowork_sessions s')) return [{ id: 'bs1' }];
      // v2 upcoming.
      if (sql.includes('next_run_at_ms')) {
        return [
          { next_run_at_ms: nowMs + 3600e3, name: 'Server patrol', bot_name: 'W' },
          { next_run_at_ms: nowMs + 7200e3, name: 'Digest', bot_name: null },
        ];
      }
      if (sql.includes('GROUP BY o.status')) return [{ status: 'review', cnt: 2 }];
      if (sql.includes("o.status IN ('planning','running','review')")) {
        return [{ owner_intent: 'Fix mobile login', status: 'review' }];
      }
      if (sql.includes('COUNT(*) AS cnt FROM metabots')) return [{ cnt: 4 }];
      if (sql.includes('FROM scheduled_task_runs')) {
        return [{ task_name: 'Nightly inspect', bot_name: 'W', status: 'success', skip_reason: null, started_at: new Date(nowMs - 3600e3).toISOString(), error: null }];
      }
      // Pending follow-up lifecycle lanes (2026-10-28): no done/stopped
      // signals in this fixture → the 'fu1' row stays listed with no
      // exclusions, exactly what the assertions below expect.
      if (sql.includes('FROM scheduled_tasks st')) return [];
      if (sql.includes('FROM long_term_subtasks l')) return [];
      if (sql.includes('FROM group_task_transitions')) return [];
      if (sql.includes('FROM long_term_events')) return [];
      if (sql.includes('FROM long_term_tasks t')) return [];
      if (sql.includes('FROM private_chat_messages')) return [{ metabot_id: 7, bot_name: 'W', message_count: 5 }];
      if (sql.includes('FROM group_chat_messages')) return [{ metabot_id: 7, bot_name: 'W', message_count: 2 }];
      if (sql.includes('COUNT(*) AS cnt FROM cowork_sessions')) return [{ cnt: 3 }];
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
  const facts = collectDailyReportFacts({ db: fakeDb, windowStartMs, windowEndMs: nowMs, twinId: 7 });
  assert.equal(facts.pendingFollowUps.length, 1);
  assert.equal(facts.pendingFollowUps[0].overdue, true);
  assert.equal(facts.ownerOrchestrations.length, 1);
  assert.equal(facts.ownerOrchestrations[0].percentComplete, 50);
  assert.equal(facts.humanSessions.length, 1);
  assert.equal(facts.humanSessions[0].lastAssistantExcerpt, 'assistant says hi');
  assert.equal(facts.humanSessions[0].lastUserExcerpt, 'user asked');
  assert.equal(facts.machineActivity.scheduledRuns.length, 1);
  assert.equal(facts.onlineActivity.length, 1);
  assert.equal(facts.onlineActivity[0].privateMessageCount, 5);
  assert.equal(facts.newSessionCount, 3);
  // v2 buckets.
  assert.equal(facts.botActivity.length, 1);
  const bot = facts.botActivity[0];
  assert.equal(bot.botName, 'W');
  assert.equal(bot.isTwin, true, 'twinId 7 → isTwin');
  assert.equal(bot.totalSessions, 2);
  assert.equal(bot.totalMessages, 12);
  assert.equal(bot.sessions.length, 2);
  assert.equal(bot.sessions[0].title, '[编排任务] Deep work', 'sessions sorted by volume');
  assert.equal(bot.sessions[0].lastAssistantExcerpt, 'assistant says hi');
  assert.equal(bot.scheduledRunCount, 1);
  assert.deepEqual(bot.scheduledRuns, [{ taskName: 'Nightly inspect', status: 'success' }]);
  assert.equal(bot.externalChats.length, 1);
  assert.equal(bot.externalChats[0].peerName, 'BOT-007');
  assert.equal(bot.externalChats[0].lastExcerpt, 'peer chat excerpt');
  assert.deepEqual(bot.openTeam, [{ taskTitle: 'Remote jam', memberStatus: 'active', windowMessageCount: 2 }]);
  assert.deepEqual(bot.chainInteractions, [{ kind: 'paylike', count: 9, lastSummary: 'liked a pin' }]);
  assert.equal(bot.groupMessages, 2, 'merged from onlineActivity');
  assert.equal(facts.upcoming.scheduledFiresTotal, 2);
  assert.equal(facts.upcoming.scheduledFires[0].taskName, 'Server patrol');
  assert.match(facts.upcoming.scheduledFires[0].fireAtLocal, /^\d{2}:\d{2}$/);
  assert.deepEqual(facts.upcoming.openOrchestrationByStatus, { review: 2 });
  assert.equal(facts.upcoming.openOrchestrations.length, 1);
  assert.equal(facts.knownBotCount, 4);
  assert.equal(facts.hourlyActivity.local.reduce((sum, n) => sum + n, 0), 4);
  assert.equal(facts.hourlyActivity.online.reduce((sum, n) => sum + n, 0), 6, 'private + group online tables');
  assert.equal(facts.hasAnyActivity, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(facts), 'utf8') <= DAILY_REPORT_MAX_FACTS_JSON_BYTES,
    'facts fit the ledger budget',
  );

  // Broken db: every bucket throws → facts still returned, all empty, skip bit false.
  const brokenDb = { queryAll: () => { throw new Error('db gone'); } };
  const empty = collectDailyReportFacts({ db: brokenDb, windowStartMs, windowEndMs: nowMs, twinId: 7 });
  assert.equal(empty.pendingFollowUps.length, 0);
  assert.equal(empty.humanSessions.length, 0);
  assert.equal(empty.hasAnyActivity, false, 'zero activity → skippable day');
});

test('collectDailyReportFacts: zero activity window sets hasAnyActivity false', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const emptyDb = { queryAll: () => [] };
  const facts = collectDailyReportFacts({ db: emptyDb, windowStartMs: nowMs - DAY_MS, windowEndMs: nowMs, twinId: 1 });
  assert.equal(facts.hasAnyActivity, false);
  assert.equal(facts.newSessionCount, 0);
});

// ---------------------------------------------------------------------------
// v2 shaping: per-bot activity / upcoming / hourly
// ---------------------------------------------------------------------------

test('stripDailyReportSessionTitlePrefix: folds host-generated prefixes only', () => {
  assert.equal(stripDailyReportSessionTitlePrefix('[编排任务] MetaWeb Surf'), 'MetaWeb Surf');
  assert.equal(stripDailyReportSessionTitlePrefix('[定时] Patrol'), 'Patrol');
  assert.equal(stripDailyReportSessionTitlePrefix('[Orchestration Task] Build'), 'Build');
  assert.equal(stripDailyReportSessionTitlePrefix('[私聊] keep'), '[私聊] keep', 'non-generated prefixes stay');
});

test('shapeBotSessionsForBot: totals over all rows, top-N narrated with capped excerpts', () => {
  const rows = [
    { session_id: 'a', session_title: 'Big', session_type: 'standard', message_count: 10 },
    { session_id: 'b', session_title: 'Small', session_type: 'a2a', message_count: 2 },
    { session_id: 'c', session_title: 'Mid', session_type: 'browser', message_count: 5 },
  ];
  const shaped = shapeBotSessionsForBot(rows, new Map([['a', 'x'.repeat(300)]]), 2);
  assert.equal(shaped.totalSessions, 3);
  assert.equal(shaped.totalMessages, 17);
  assert.equal(shaped.sessions.length, 2);
  assert.deepEqual(shaped.sessions.map((s) => s.title), ['Big', 'Mid'], 'sorted by volume');
  assert.equal(shaped.sessions[0].lastAssistantExcerpt.length, 160, 'excerpt capped');
});

test('shapeExternalChatFacts: named peer, volume sort, metaid fallback, excerpt cap', () => {
  const rows = [
    { peer_global: 'p1', peer_name: 'BOT-007', message_count: 3 },
    { peer_global: 'p2', peer_name: null, message_count: 9 },
  ];
  const shaped = shapeExternalChatFacts(rows, new Map([['p2', 'y'.repeat(300)]]));
  assert.equal(shaped.length, 2);
  assert.equal(shaped[0].peerName, 'p2', 'unnamed peer falls back to the metaid prefix');
  assert.equal(shaped[0].messageCount, 9);
  assert.equal(shaped[0].lastExcerpt.length, 120);
  assert.equal(shaped[1].peerName, 'BOT-007');
});

test('chainKindFromPath + shapeChainInteractionFacts: last path segment, top-N', () => {
  assert.equal(chainKindFromPath('/protocols/paylike'), 'paylike');
  assert.equal(chainKindFromPath(''), 'write');
  const shaped = shapeChainInteractionFacts(
    [{ path: '/protocols/paylike', cnt: 2 }, { path: '/protocols/paycomment', cnt: 7 }],
    new Map([['/protocols/paycomment', 'replied']]),
  );
  assert.equal(shaped[0].kind, 'paycomment');
  assert.equal(shaped[0].lastSummary, 'replied');
});

test('shapeUpcomingFires: local HH:MM, sorted, total kept beyond the display cap', () => {
  const base = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const shaped = shapeUpcomingFires([
    { next_run_at_ms: base + 7200e3, name: 'Later', bot_name: 'B' },
    { next_run_at_ms: base + 3600e3, name: 'Sooner', bot_name: null },
    { next_run_at_ms: 0, name: 'broken' },
  ], 1);
  assert.equal(shaped.scheduledFiresTotal, 2);
  assert.equal(shaped.scheduledFires.length, 1);
  assert.equal(shaped.scheduledFires[0].taskName, 'Sooner');
  assert.equal(shaped.scheduledFires[0].fireAtLocal, '10:00');
});

test('shapeHourlyActivity: 12 buckets, out-of-range hours dropped', () => {
  const shaped = shapeHourlyActivity(
    [{ h: 9, cnt: 4 }, { h: 25, cnt: 10 }, { bucket: 3, cnt: 2 }],
    [{ h: 1, cnt: 3 }],
  );
  assert.equal(shaped.local.length, 12);
  assert.equal(shaped.online.length, 12);
  assert.equal(shaped.local[4], 4, 'hour 9 lands in the 8-10 bucket');
  assert.equal(shaped.local[1], 2, 'bucket-style rows still feed in');
  assert.equal(shaped.online[0], 3);
  assert.equal(shaped.local.reduce((sum, n) => sum + n, 0), 6, 'hour 25 dropped');
});

// ── Pending follow-up lifecycle cross-check (2026-10-28) ───────────────────
//
// Contract: rows whose underlying work is verifiably done or stopped are
// excluded from the pending list (before the cap slice); rows waiting on an
// external condition are flagged waitingExternal instead of overdue; manual
// pins are never lifecycle-excluded; every lane fails soft.

const lifecycleDb = (lanes) => ({
  queryAll(sql, params = []) {
    if (sql.includes('FROM scheduled_tasks st')) return lanes.tasks ?? [];
    if (sql.includes('FROM scheduled_task_runs r')) return lanes.runs ?? [];
    if (sql.includes('FROM orchestration_attempts a')) return lanes.orchestration ?? [];
    if (sql.includes('FROM long_term_subtasks l')) return lanes.subtasks ?? [];
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  },
});

const pendingRow = (id, overrides = {}) => ({
  id,
  title: `Session ${id}`,
  follow_up_source: 'cerebellum',
  follow_up_at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
  auto_origin: 'schedule',
  ...overrides,
});

test('lifecycle: scheduled lane — all-linked-disabled / expired excluded, any-enabled kept', () => {
  const rows = [pendingRow('s-disabled'), pendingRow('s-enabled'), pendingRow('s-expired'), pendingRow('s-mixed')];
  const db = lifecycleDb({
    tasks: [
      { session_id: 's-disabled', target_session_id: null, enabled: 0, expires_at: null },
      // Secondary linkage column counts too: same session, still all-disabled.
      { session_id: null, target_session_id: 's-disabled', enabled: 0, expires_at: null },
      { session_id: 's-enabled', target_session_id: null, enabled: 1, expires_at: null },
      // Scheduler skips expired tasks but never disables them — treated as stopped.
      { session_id: 's-expired', target_session_id: null, enabled: 1, expires_at: '2020-01-01' },
      // One live task + one stopped task → live wins, session kept.
      { session_id: 's-mixed', target_session_id: null, enabled: 0, expires_at: null },
      { session_id: null, target_session_id: 's-mixed', enabled: 1, expires_at: null },
    ],
  });
  const lifecycle = collectPendingFollowUpLifecycle(db, rows);
  assert.deepEqual([...lifecycle.excluded].sort(), ['s-disabled', 's-expired']);
  assert.equal(lifecycle.excluded.has('s-enabled'), false);
  assert.equal(lifecycle.excluded.has('s-mixed'), false);
  assert.equal(lifecycle.waitingExternal.size, 0);
});

test('lifecycle: orphan schedule sessions — latest successful run excluded, failures kept', () => {
  const rows = [
    pendingRow('s-ok'),
    pendingRow('s-ok2'),
    pendingRow('s-fail'),
    pendingRow('s-multi'),
    pendingRow('s-notschedule', { auto_origin: 'longterm' }),
  ];
  const db = lifecycleDb({
    // Rows arrive started_at ASC; the LAST status per session wins.
    runs: [
      { session_id: 's-ok', status: 'success' },
      { session_id: 's-ok2', status: 'error' },
      { session_id: 's-ok2', status: 'success' },
      { session_id: 's-fail', status: 'error' },
      { session_id: 's-multi', status: 'success' },
      { session_id: 's-multi', status: 'error' },
      { session_id: 's-notschedule', status: 'success' },
    ],
  });
  const lifecycle = collectPendingFollowUpLifecycle(db, rows);
  assert.deepEqual([...lifecycle.excluded].sort(), ['s-ok', 's-ok2']);
  // A failed one-shot may still deserve attention; a non-schedule-origin
  // session with a successful run is not a scheduled-work orphan.
  assert.equal(lifecycle.excluded.has('s-fail'), false);
  assert.equal(lifecycle.excluded.has('s-multi'), false);
  assert.equal(lifecycle.excluded.has('s-notschedule'), false);
});

test('lifecycle: orchestration lane — closed tasks excluded, live/mixed kept', () => {
  const rows = [pendingRow('s-cancelled'), pendingRow('s-review'), pendingRow('s-mixed'), pendingRow('s-unlinked')];
  const db = lifecycleDb({
    orchestration: [
      { session_id: 's-cancelled', status: 'cancelled' },
      { session_id: 's-review', status: 'review' },
      // A session carrying attempts of several tasks is excluded only when
      // EVERY task is terminal.
      { session_id: 's-mixed', status: 'cancelled' },
      { session_id: 's-mixed', status: 'running' },
      // Rows without a resolvable session/status are ignored.
      { worker_session_id: 'shape-mismatch' },
    ],
  });
  const lifecycle = collectPendingFollowUpLifecycle(db, rows);
  assert.deepEqual([...lifecycle.excluded], ['s-cancelled']);
  assert.equal(lifecycle.excluded.has('s-review'), false);
  assert.equal(lifecycle.excluded.has('s-mixed'), false);
});

test('lifecycle: long-term lane — primary done excluded, history all-done excluded, waiting flagged', () => {
  const rows = [
    pendingRow('s-primary-done'),
    pendingRow('s-primary-live'),
    pendingRow('s-parent-done'),
    pendingRow('s-hist-done'),
    pendingRow('s-hist-wait'),
    pendingRow('s-hist-mixed'),
    pendingRow('s-prod-precedence'),
    pendingRow('s-badjson'),
    pendingRow('s-unlinked'),
  ];
  const db = lifecycleDb({
    subtasks: [
      // Primary seat accepted → the session's own sub-project is finished.
      { session_id: 's-primary-done', session_history_json: '[]', status: 'accepted', wait_until: null, parent_stage: 'active', parent_done_at: null },
      { session_id: 's-primary-live', session_history_json: '[]', status: 'in_progress', wait_until: null, parent_stage: 'active', parent_done_at: null },
      // Parent task done closes every live sub-project under it.
      { session_id: 's-parent-done', session_history_json: '[]', status: 'in_progress', wait_until: null, parent_stage: 'done', parent_done_at: '2026-10-27T00:00:00Z' },
      // History-only participation: all linked sub-projects done → excluded.
      { session_id: 'other-a', session_history_json: '["s-hist-done"]', status: 'accepted', wait_until: null, parent_stage: 'active', parent_done_at: null },
      // History-only with a live waiting_external sub-project → waiting flag.
      { session_id: 'other-b', session_history_json: '["s-hist-wait"]', status: 'waiting_external', wait_until: '2026-11-01T00:00:00+08:00', parent_stage: 'active', parent_done_at: null },
      // History with one done + one live → kept, not waiting.
      { session_id: 'other-c', session_history_json: '["s-hist-mixed"]', status: 'accepted', wait_until: null, parent_stage: 'active', parent_done_at: null },
      { session_id: 'other-d', session_history_json: '["s-hist-mixed"]', status: 'in_progress', wait_until: null, parent_stage: 'active', parent_done_at: null },
      // Prod precedence case (session 688c44f7 shape): primary seat accepted
      // AND participation history in a waiting sub-project — done beats waiting.
      { session_id: 's-prod-precedence', session_history_json: '[]', status: 'accepted', wait_until: null, parent_stage: 'active', parent_done_at: null },
      { session_id: 'other-e', session_history_json: '["s-prod-precedence"]', status: 'waiting_external', wait_until: '2026-11-02T00:00:00+08:00', parent_stage: 'active', parent_done_at: null },
      // Malformed history JSON must not crash the lane.
      { session_id: 'other-f', session_history_json: 'not-json', status: 'accepted', wait_until: null, parent_stage: 'active', parent_done_at: null },
      // Non-array history JSON is ignored too.
      { session_id: 's-badjson', session_history_json: '{"oops":1}', status: 'waiting_external', wait_until: null, parent_stage: 'active', parent_done_at: null },
    ],
  });
  const lifecycle = collectPendingFollowUpLifecycle(db, rows);
  assert.deepEqual(
    [...lifecycle.excluded].sort(),
    ['s-hist-done', 's-parent-done', 's-primary-done', 's-prod-precedence'],
  );
  assert.equal(lifecycle.excluded.has('s-primary-live'), false);
  assert.equal(lifecycle.excluded.has('s-hist-mixed'), false);
  assert.equal(lifecycle.excluded.has('s-unlinked'), false);
  assert.equal(lifecycle.excluded.has('s-badjson'), false, 'non-array history is not a link');
  assert.deepEqual([...lifecycle.waitingExternal].sort(), ['s-hist-wait']);
});

test('lifecycle: manual pins are never lifecycle-excluded', () => {
  const rows = [pendingRow('s-manual', { follow_up_source: 'manual' }), pendingRow('s-auto')];
  const db = lifecycleDb({
    tasks: [
      { session_id: 's-manual', target_session_id: null, enabled: 0, expires_at: null },
      { session_id: 's-auto', target_session_id: null, enabled: 0, expires_at: null },
    ],
  });
  const lifecycle = collectPendingFollowUpLifecycle(db, rows);
  assert.deepEqual([...lifecycle.excluded], ['s-auto']);
});

test('lifecycle: every lane broken → no exclusions, no throw (fail soft)', () => {
  const rows = [pendingRow('s-1'), pendingRow('s-2')];
  const db = { queryAll: () => { throw new Error('db gone'); } };
  const lifecycle = collectPendingFollowUpLifecycle(db, rows);
  assert.equal(lifecycle.excluded.size, 0);
  assert.equal(lifecycle.waitingExternal.size, 0);
});

test('lifecycle: no pending rows → no queries issued', () => {
  let calls = 0;
  const db = { queryAll: () => { calls += 1; return []; } };
  const lifecycle = collectPendingFollowUpLifecycle(db, []);
  assert.equal(lifecycle.excluded.size, 0);
  assert.equal(calls, 0);
});

test('shapePendingFollowUpRows: waitingOnExternal suppresses overdue', () => {
  const nowMs = Date.now();
  const old = new Date(nowMs - 5 * DAY_MS).toISOString();
  const rows = [
    { id: 'w1', title: 'Wait on upstream', follow_up_source: 'cerebellum', follow_up_at: old },
    { id: 'o1', title: 'Old plain', follow_up_source: 'cerebellum', follow_up_at: old },
  ];
  const shaped = shapePendingFollowUpRows(rows, nowMs, 10, new Set(['w1']));
  assert.equal(shaped[0].ageDays, 5);
  assert.equal(shaped[0].waitingOnExternal, true);
  assert.equal(shaped[0].overdue, false, 'waiting items never carry the overdue badge');
  assert.equal(shaped[1].waitingOnExternal, false);
  assert.equal(shaped[1].overdue, true);
});

test('collectDailyReportFacts: exclusions apply BEFORE the 10-item cap; waiting survives with flag', () => {
  const nowMs = new Date(2026, 9, 28, 8, 0, 0).getTime();
  const windowStartMs = nowMs - DAY_MS;
  const old = new Date(nowMs - 5 * DAY_MS).toISOString();
  const fresh = new Date(nowMs - 30 * 60 * 1000).toISOString();
  // 12 pending rows: 10 stale zombies first (oldest order), then 2 live ones.
  const pendingRows = [];
  for (let i = 1; i <= 10; i += 1) {
    pendingRows.push({ id: `zombie-${i}`, title: `Zombie ${i}`, follow_up_source: 'cerebellum', follow_up_at: old, auto_origin: 'schedule', bot_name: 'W' });
  }
  pendingRows.push({ id: 'live-plain', title: 'Live decision', follow_up_source: 'cerebellum', follow_up_at: fresh, auto_origin: 'schedule', bot_name: 'W' });
  pendingRows.push({ id: 'live-wait', title: 'Live wait', follow_up_source: 'cerebellum', follow_up_at: old, auto_origin: 'longterm', bot_name: 'W' });
  const fakeDb = {
    queryAll(sql, params = []) {
      if (sql.includes('FROM cowork_sessions s') && sql.includes('follow_up_state')) return pendingRows;
      if (sql.includes('FROM scheduled_tasks st')) {
        return pendingRows.slice(0, 10).map((row) => ({ session_id: row.id, target_session_id: null, enabled: 0, expires_at: null }));
      }
      if (sql.includes('FROM long_term_subtasks l')) {
        return [{ session_id: 'other', session_history_json: '["live-wait"]', status: 'waiting_external', wait_until: '2026-11-01T00:00:00+08:00', parent_stage: 'active', parent_done_at: null }];
      }
      return [];
    },
  };
  const facts = collectDailyReportFacts({ db: fakeDb, windowStartMs, windowEndMs: nowMs, twinId: 7 });
  // Zombies never occupy cap slots: both live items are listed.
  assert.deepEqual(facts.pendingFollowUps.map((item) => item.sessionId), ['live-plain', 'live-wait']);
  assert.equal(facts.pendingFollowUps[0].overdue, false);
  assert.equal(facts.pendingFollowUps[1].waitingOnExternal, true);
  assert.equal(facts.pendingFollowUps[1].overdue, false, 'waiting item keeps age but drops overdue');
  assert.equal(facts.pendingFollowUps[1].ageDays, 5);
});

// ── T-B: forced overdue section facts ──────────────────────────────────────

test('shapeOverdueRows T-B: waiting_owner and stalled review cross their thresholds; sorted longest-wait first', () => {
  const nowMs = Date.parse('2026-11-18T08:00:00Z');
  const rows = [
    { kind: 'longterm_waiting_owner', title: '等待拍板的 A', taskId: 'lt-1', status: 'waiting_owner', updated_at: '2026-11-17T07:00:00Z' }, // 25h
    { kind: 'orchestration_review_stalled', title: '复核停滞的 B', taskId: 'orch-1', status: 'review', updated_at: '2026-11-14T08:00:00Z' }, // 96h
    { kind: 'longterm_waiting_owner', title: '刚递交的 C', taskId: 'lt-2', status: 'waiting_owner', updated_at: '2026-11-18T02:00:00Z' }, // 6h — under threshold
    { kind: 'orchestration_review_stalled', title: '贴线的 D', taskId: 'orch-2', status: 'review', updated_at: '2026-11-15T08:00:00Z' }, // 72h — equal counts
  ];
  const shaped = shapeOverdueRows(rows, nowMs);
  assert.equal(shaped.length, 3);
  assert.deepEqual(shaped.map((item) => item.title), ['复核停滞的 B', '贴线的 D', '等待拍板的 A'], 'longest wait first (96h > 72h > 25h)');
  assert.equal(shaped[0].ageHours, 96);
  assert.equal(shaped[0].thresholdHours, DAILY_REPORT_OVERDUE_REVIEW_STALLED_HOURS);
  assert.equal(shaped[2].thresholdHours, DAILY_REPORT_OVERDUE_WAITING_OWNER_HOURS);
  assert.equal(shaped[1].ageHours, 72, 'a wait exactly at the threshold is overdue');
});

test('shapeOverdueRows T-B: unknown timestamps and empty input never become overdue (no false alarms)', () => {
  const nowMs = Date.parse('2026-11-18T08:00:00Z');
  assert.deepEqual(shapeOverdueRows([], nowMs), []);
  assert.deepEqual(
    shapeOverdueRows([
      { kind: 'longterm_waiting_owner', title: '没有时间戳', taskId: 'lt-9', status: 'waiting_owner', updated_at: null },
      { kind: 'longterm_waiting_owner', title: '坏时间戳', taskId: 'lt-8', status: 'waiting_owner', updated_at: 'not-a-date' },
    ], nowMs),
    [],
  );
  const title = shapeOverdueRows(
    [{ kind: 'orchestration_review_stalled', title: '', taskId: 'orch-9', status: 'review', updated_at: '2026-10-01T00:00:00Z' }],
    nowMs,
  );
  assert.equal(title[0].title, '(untitled)');
});

