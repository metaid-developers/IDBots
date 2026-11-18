// src/main/cerebellum/dailyReportTriage.ts — batched JEV triage deciding
// which sessions deserve narration in the owner's daily briefing.
//
// Contract under test (the standard cerebellum recipe):
//   a. request shape — one shared state with capped candidate fields, one
//      noul question per candidate keyed reportworthy_<i>, English
//      instructions, 1500ms default deadline;
//   b. answer parsing — per-index aligned nouls, clamped into 0..1, missing
//      answers stay null;
//   c. coverage floor — below 80% usable answers the whole call is null;
//   d. verdict semantics — noul >= 0.5 enters the map, below drops out;
//   e. every failure mode returns null without throwing (fail-open), and a
//      hanging endpoint is aborted at the deadline;
//   f. selection policy — must-includes bypass triage, verdict order wins,
//      null verdicts degrade to recency order, hard cap respected.
//
// The pure module is loaded straight from src/ (Node type stripping); the
// caller injects fetch, so no dist-electron import is needed here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_DAILY_REPORT_TRIAGE_TIMEOUT_MS,
  CEREBELLUM_DAILY_REPORT_THRESHOLD,
  CEREBELLUM_DAILY_REPORT_MIN_ANSWER_COVERAGE,
  CEREBELLUM_DAILY_REPORT_TITLE_MAX_CHARS,
  CEREBELLUM_DAILY_REPORT_ASSISTANT_MAX_CHARS,
  CEREBELLUM_DAILY_REPORT_USER_MAX_CHARS,
  DAILY_REPORT_MAX_NARRATED_SESSIONS,
  buildDailyReportTriageRequest,
  parseDailyReportTriageAnswers,
  dailyReportTriageCoverageOk,
  dailyReportTriageQuestionId,
  classifyDailyReportTriagedSessions,
  selectDailyReportNarration,
} from '../src/main/cerebellum/dailyReportTriage.ts';

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

const CANDIDATES = [
  { sessionId: 's1', sessionTitle: 'Fix login bug', lastAssistantText: 'Fixed and verified.', lastUserText: 'Please fix the login bug' },
  { sessionId: 's2', sessionTitle: 'A2A plumbing', lastAssistantText: 'ping', lastUserText: '' },
  { sessionId: 's3', sessionTitle: 'Research report', lastAssistantText: 'Draft ready for review.', lastUserText: 'Draft the research report' },
];

function batchPayload(nouls) {
  const answers = {};
  nouls.forEach((noul, index) => {
    if (noul !== null && noul !== undefined) {
      answers[dailyReportTriageQuestionId(index)] = { noul };
    }
  });
  return { model: 'jev-latest', answers, usage: { input_tokens: 100 } };
}

function okFetch(payload, captured = []) {
  return async (url, init) => {
    captured.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => payload };
  };
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

test('buildDailyReportTriageRequest: one noul per candidate over a shared capped state', () => {
  const request = buildDailyReportTriageRequest({
    candidates: CANDIDATES,
    model: 'jev-latest',
  });
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.state.candidates.length, 3);
  assert.equal(request.state.candidates[0].session_title, 'Fix login bug');
  assert.deepEqual(
    Object.keys(request.questions).sort(),
    ['reportworthy_0', 'reportworthy_1', 'reportworthy_2'],
  );
  const question = request.questions.reportworthy_0;
  assert.equal(question.type, 'noul');
  assert.match(question.instructions, /daily briefing/);
  assert.match(question.instructions, /bot-to-bot plumbing/);
  assert.match(question.instructions, /ANY language/);
  assert.match(question.criteria.true, /owner-relevant/);
  assert.match(question.criteria.false, /plumbing/);
});

test('buildDailyReportTriageRequest: caller-authored fields whitespace-collapsed and hard-capped', () => {
  const request = buildDailyReportTriageRequest({
    candidates: [{
      sessionId: 's',
      sessionTitle: `  标\n${'题'.repeat(400)} `,
      lastAssistantText: '文'.repeat(3000),
      lastUserText: `  ${'用'.repeat(900)}\n\n多行 `,
    }],
    model: 'jev-latest',
  });
  assert.equal(request.state.candidates[0].session_title.length, CEREBELLUM_DAILY_REPORT_TITLE_MAX_CHARS);
  assert.equal(request.state.candidates[0].session_title.includes('\n'), false);
  assert.equal(request.state.candidates[0].last_assistant_message.length, CEREBELLUM_DAILY_REPORT_ASSISTANT_MAX_CHARS);
  assert.equal(request.state.candidates[0].last_user_message.length, CEREBELLUM_DAILY_REPORT_USER_MAX_CHARS);
});

// ---------------------------------------------------------------------------
// Answer parsing + coverage floor
// ---------------------------------------------------------------------------

test('parseDailyReportTriageAnswers: aligned, clamped, missing stays null', () => {
  assert.deepEqual(parseDailyReportTriageAnswers(batchPayload([0.9, 1.7, -0.3]), 3), [0.9, 1, 0]);
  assert.deepEqual(parseDailyReportTriageAnswers(batchPayload([0.9, null, 0.1]), 3), [0.9, null, 0.1]);
  assert.deepEqual(parseDailyReportTriageAnswers({ answers: {} }, 2), [null, null]);
  assert.deepEqual(parseDailyReportTriageAnswers('junk', 2), [null, null]);
  assert.deepEqual(parseDailyReportTriageAnswers(null, 0), []);
});

test('dailyReportTriageCoverageOk: 80% floor, empty pool never passes', () => {
  assert.equal(CEREBELLUM_DAILY_REPORT_MIN_ANSWER_COVERAGE, 0.8);
  assert.equal(dailyReportTriageCoverageOk([0.9, 0.9, 0.9, null]), false, '3/4 = 75% is below the floor');
  assert.equal(dailyReportTriageCoverageOk([0.9, 0.9, 0.9, 0.9, null]), true, '4/5 = 80% meets the floor');
  assert.equal(dailyReportTriageCoverageOk([0.9, null, null, null, null]), false);
  assert.equal(dailyReportTriageCoverageOk([]), false);
});

// ---------------------------------------------------------------------------
// classifyDailyReportTriagedSessions
// ---------------------------------------------------------------------------

test('classify: noul >= 0.5 enters the map, below drops out', async () => {
  const captured = [];
  const verdicts = await classifyDailyReportTriagedSessions({
    config: TEST_CONFIG,
    fetchImpl: okFetch(batchPayload([0.9, 0.2, CEREBELLUM_DAILY_REPORT_THRESHOLD]), captured),
    candidates: CANDIDATES,
  });
  assert.ok(verdicts instanceof Map);
  assert.deepEqual([...verdicts.keys()], ['s1', 's3']);
  assert.equal(verdicts.get('s1'), 0.9);
  assert.equal(captured.length, 1, 'ONE batched request');
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.state.candidates.length, 3);
});

test('classify: below the coverage floor the whole call is null', async () => {
  assert.equal(
    await classifyDailyReportTriagedSessions({
      config: TEST_CONFIG,
      fetchImpl: okFetch(batchPayload([0.9, null, null])),
      candidates: CANDIDATES,
    }),
    null,
  );
});

test('classify: every failure mode returns null without throwing (fail-open)', async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await classifyDailyReportTriagedSessions({ config: TEST_CONFIG, fetchImpl: http500, candidates: CANDIDATES }), null);
  const throwing = async () => { throw new Error('network down'); };
  assert.equal(await classifyDailyReportTriagedSessions({ config: TEST_CONFIG, fetchImpl: throwing, candidates: CANDIDATES }), null);
  const malformed = async () => ({ ok: true, status: 200, json: async () => 'not-json' });
  assert.equal(await classifyDailyReportTriagedSessions({ config: TEST_CONFIG, fetchImpl: malformed, candidates: CANDIDATES }), null);
  assert.equal(await classifyDailyReportTriagedSessions({ config: TEST_CONFIG, fetchImpl: okFetch(batchPayload([])), candidates: [] }), null);
});

test('classify: a hanging endpoint is aborted at the deadline', async () => {
  const hanging = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const startedAt = Date.now();
  assert.equal(
    await classifyDailyReportTriagedSessions({ config: TEST_CONFIG, fetchImpl: hanging, candidates: CANDIDATES, timeoutMs: 25 }),
    null,
  );
  assert.ok(Date.now() - startedAt < 1000, 'abort deadline honored');
  assert.equal(CEREBELLUM_DAILY_REPORT_TRIAGE_TIMEOUT_MS, 2500, 'default deadline stays at 2.5s');
});

// ---------------------------------------------------------------------------
// selectDailyReportNarration (pure selection policy)
// ---------------------------------------------------------------------------

test('selectDailyReportNarration: must-includes bypass triage, verdicts fill by noul', () => {
  const selected = selectDailyReportNarration({
    mustIncludeSessionIds: ['fu1'],
    candidates: [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }],
    verdicts: new Map([['s2', 0.95], ['s3', 0.6]]),
    maxNarrated: DAILY_REPORT_MAX_NARRATED_SESSIONS,
  });
  assert.deepEqual(selected, ['fu1', 's2', 's3'], 'must-include first, then verdict order');
});

test('selectDailyReportNarration: null verdicts degrade to recency order', () => {
  const selected = selectDailyReportNarration({
    mustIncludeSessionIds: ['fu1'],
    candidates: [{ sessionId: 's1' }, { sessionId: 's2' }],
    verdicts: null,
    maxNarrated: DAILY_REPORT_MAX_NARRATED_SESSIONS,
  });
  assert.deepEqual(selected, ['fu1', 's1', 's2']);
});

test('selectDailyReportNarration: cap respected, must-includes never trimmed, dedup', () => {
  const selected = selectDailyReportNarration({
    mustIncludeSessionIds: ['fu1', 'fu1', 'fu2'],
    candidates: [{ sessionId: 'fu2' }, { sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }],
    verdicts: new Map([['a', 0.9], ['b', 0.8], ['c', 0.7]]),
    maxNarrated: 4,
  });
  assert.deepEqual(selected, ['fu1', 'fu2', 'a', 'b']);
});
