// src/main/cerebellum/sessionFollowUpGate.ts — the turn-end classifier behind
// the "Follow-Up Tasks" (待跟进任务) sidebar bucket.
//
// One Noul (needs_human_followup) reads the session title plus the turn's
// final assistant message and decides whether the completed turn leaves an
// auto-origin session waiting on the owner. true → the session lands in
// Follow-Up (pending / 'cerebellum'); false → a previous cerebellum verdict
// settles back into the Autonomous fold; null (disabled/timeout/quota/blank/
// malformed) → no change (fail-open).
//
// Contract under test:
//   a. request shape — one noul question, English instructions, hard caps on
//      every caller-authored state field, task_name only for scheduled runs;
//   b. answer parsing — clamps into 0..1, unusable shapes → null;
//   c. verdict semantics — noul >= threshold → true, below → false;
//      high-severity keyword markers short-circuit to true without a JEV call;
//   f. the bot-written `[FOLLOW_UP: owner|none]` end-of-run tag parses and
//      outranks the Noul (owner parks, none clears unless the severity net
//      fires) — see resolveFollowUpAction;
//   d. every failure mode returns null without throwing (fail-open);
//   e. a hanging endpoint is aborted at the deadline.
//
// The pure module is loaded straight from src/ (Node type stripping); there is
// no compiled-DI seam in this module (the caller injects fetch), so no
// dist-electron import is needed here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD,
  CEREBELLUM_SESSION_FOLLOW_UP_TIMEOUT_MS,
  CEREBELLUM_SESSION_FOLLOW_UP_QUESTION_ID,
  CEREBELLUM_SESSION_FOLLOW_UP_TITLE_MAX_CHARS,
  CEREBELLUM_SESSION_FOLLOW_UP_MESSAGE_MAX_CHARS,
  CEREBELLUM_SESSION_FOLLOW_UP_TASK_NAME_MAX_CHARS,
  buildSessionFollowUpRequest,
  parseSessionFollowUpAnswer,
  sessionFollowUpFromNoul,
  hasForceFollowUpSignal,
  parseFollowUpDeclaration,
  resolveFollowUpAction,
  classifySessionFollowUpWithCerebellum,
} from '../src/main/cerebellum/sessionFollowUpGate.ts';

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

function classifyPayload(noul) {
  return {
    model: 'jev-latest',
    answers: { [CEREBELLUM_SESSION_FOLLOW_UP_QUESTION_ID]: { noul } },
    usage: { input_tokens: 50 },
  };
}

function okFetch(payload, captured = []) {
  return async (url, init) => {
    captured.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  };
}

const GATE_INPUT = {
  config: TEST_CONFIG,
  sessionTitle: '[定时] 每日站点巡检',
  lastAssistantText: '巡检完成：发现 2 个异常，请确认是否立即处理？',
  taskName: '每日站点巡检',
};

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

test('buildSessionFollowUpRequest: state carries title + final reply, one noul question, task_name for scheduled runs', () => {
  const request = buildSessionFollowUpRequest({
    sessionTitle: GATE_INPUT.sessionTitle,
    lastAssistantText: GATE_INPUT.lastAssistantText,
    taskName: GATE_INPUT.taskName,
    model: 'jev-latest',
  });
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.state.session_title, GATE_INPUT.sessionTitle);
  assert.equal(request.state.last_assistant_message, GATE_INPUT.lastAssistantText);
  assert.equal(request.state.task_name, GATE_INPUT.taskName);
  assert.deepEqual(Object.keys(request.questions), [CEREBELLUM_SESSION_FOLLOW_UP_QUESTION_ID]);
  const question = request.questions[CEREBELLUM_SESSION_FOLLOW_UP_QUESTION_ID];
  assert.equal(question.type, 'noul');
  assert.match(question.instructions, /decide, approve, choose, provide, or reply/);
  assert.match(question.instructions, /ANY language/);
  assert.match(question.instructions, /THIRD PARTY/, 'waits owned by others are not the owner follow-up');
  assert.match(question.instructions, /not whether anything anywhere is unresolved/);
  assert.match(question.criteria.true, /question to the user/);
  assert.match(question.criteria.true, /owner-actionable failures/);
  assert.match(question.criteria.false, /final report or bot-to-bot handoff/);
  assert.match(question.criteria.false, /no OWNER action is needed/);
});

test('buildSessionFollowUpRequest: omits task_name for non-scheduled turns and blank names', () => {
  const withoutTask = buildSessionFollowUpRequest({
    sessionTitle: 'Report',
    lastAssistantText: 'Done.',
    model: 'jev-latest',
  });
  assert.equal('task_name' in withoutTask.state, false);

  const blankTask = buildSessionFollowUpRequest({
    sessionTitle: 'Report',
    lastAssistantText: 'Done.',
    taskName: '   ',
    model: 'jev-latest',
  });
  assert.equal('task_name' in blankTask.state, false);
});

test('buildSessionFollowUpRequest: caller-authored fields are whitespace-collapsed and hard-capped', () => {
  const request = buildSessionFollowUpRequest({
    sessionTitle: `  [定时]\n${'标'.repeat(500)}  `,
    lastAssistantText: `${'文'.repeat(3000)}\n\n多行`,
    taskName: `  ${'任务'.repeat(200)} `,
    model: 'jev-latest',
  });
  assert.equal(request.state.session_title.length, CEREBELLUM_SESSION_FOLLOW_UP_TITLE_MAX_CHARS);
  assert.equal(request.state.session_title.includes('\n'), false, 'whitespace collapsed');
  assert.equal(
    request.state.last_assistant_message.length,
    CEREBELLUM_SESSION_FOLLOW_UP_MESSAGE_MAX_CHARS,
  );
  assert.equal(
    request.state.task_name.length,
    CEREBELLUM_SESSION_FOLLOW_UP_TASK_NAME_MAX_CHARS,
  );
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

test('parseSessionFollowUpAnswer: happy path, clamping, and unusable shapes', () => {
  assert.equal(parseSessionFollowUpAnswer(classifyPayload(0.8)), 0.8);
  assert.equal(parseSessionFollowUpAnswer(classifyPayload(1.7)), 1);
  assert.equal(parseSessionFollowUpAnswer(classifyPayload(-0.2)), 0);
  assert.equal(parseSessionFollowUpAnswer({ answers: {} }), null);
  assert.equal(parseSessionFollowUpAnswer({ answers: { other: { noul: 0.9 } } }), null);
  assert.equal(parseSessionFollowUpAnswer({ answers: { needs_human_followup: { noul: 'high' } } }), null);
  assert.equal(parseSessionFollowUpAnswer({ answers: { needs_human_followup: {} } }), null);
  assert.equal(parseSessionFollowUpAnswer({ nope: 1 }), null);
  assert.equal(parseSessionFollowUpAnswer(null), null);
  assert.equal(parseSessionFollowUpAnswer('junk'), null);
});

test('sessionFollowUpFromNoul: precision-biased threshold is inclusive at 0.5', () => {
  assert.equal(sessionFollowUpFromNoul(0.5), true);
  assert.equal(sessionFollowUpFromNoul(0.49), false);
  assert.equal(sessionFollowUpFromNoul(0), false);
  assert.equal(sessionFollowUpFromNoul(1), true);
  assert.equal(CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD, 0.5);
});

// ---------------------------------------------------------------------------
// classifySessionFollowUpWithCerebellum — verdict semantics and fail-open
// ---------------------------------------------------------------------------

test('classify: noul at/above threshold → true, below → false', async () => {
  assert.equal(
    await classifySessionFollowUpWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(classifyPayload(0.9)) }),
    true,
  );
  assert.equal(
    await classifySessionFollowUpWithCerebellum({
      ...GATE_INPUT,
      fetchImpl: okFetch(classifyPayload(CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD)),
    }),
    true,
    'threshold is inclusive (P >= 0.5 → follow-up)',
  );
  assert.equal(
    await classifySessionFollowUpWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(classifyPayload(0.34)) }),
    false,
  );
  assert.equal(
    await classifySessionFollowUpWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(classifyPayload(0.49)) }),
    false,
    'the old recall-biased band 0.35–0.49 no longer parks the session',
  );
});

test('classify: high-severity markers short-circuit to true without a JEV call', async () => {
  const fetchMustNotBeCalled = async () => {
    throw new Error('fetch must not be called for a forced verdict');
  };
  const incidentReport =
    'CRITICAL（需人工处置，无一条已自动恢复）\n\nMetaFS uploader 服务整体故障：容器健康检查 unhealthy，' +
    '端口 7282 未监听，公网入口 502。建议 SSH 登录两台机器 docker logs 查崩溃原因并手动重启容器。';
  assert.equal(
    await classifySessionFollowUpWithCerebellum({
      ...GATE_INPUT,
      lastAssistantText: incidentReport,
      fetchImpl: fetchMustNotBeCalled,
    }),
    true,
  );
});

test('hasForceFollowUpSignal: severity markers hit, negations and benign prose do not', () => {
  assert.equal(hasForceFollowUpSignal('CRITICAL: disk full on 47.76.58.120'), true);
  assert.equal(hasForceFollowUpSignal('以下事项需要你拍板后才能继续'), true);
  assert.equal(hasForceFollowUpSignal('Action required: approve the deployment.'), true);
  assert.equal(hasForceFollowUpSignal('This needs your approval before rollout.'), true);
  assert.equal(hasForceFollowUpSignal('巡检完成，全部正常，无需人工处理。'), false);
  assert.equal(hasForceFollowUpSignal('这个方案无需拍板，继续推进即可。'), false);
  assert.equal(hasForceFollowUpSignal('We discussed critical thinking in the design doc.'), false);
  assert.equal(hasForceFollowUpSignal('已自动恢复，无一条需要跟进。'), false);
});

// ---------------------------------------------------------------------------
// End-of-run follow-up declaration tag (scheduled-task contract)
// ---------------------------------------------------------------------------

test('parseFollowUpDeclaration: reads the tag kind, last occurrence wins', () => {
  assert.equal(parseFollowUpDeclaration('[FOLLOW_UP: none]'), 'none');
  assert.equal(parseFollowUpDeclaration('[follow_up: none]'), 'none', 'case-insensitive');
  assert.equal(parseFollowUpDeclaration('[FOLLOW_UP: owner — 需要主人审批预算]'), 'owner');
  assert.equal(
    parseFollowUpDeclaration('前期结论 [FOLLOW_UP: owner — 等主人选方案]，随后自行闭环\n[FOLLOW_UP: none]'),
    'none',
    'the LAST tag wins',
  );
  assert.equal(
    parseFollowUpDeclaration('起草时先标了 none，最终还是要主人拍板 [FOLLOW_UP: owner — 选 A 还是 B]'),
    'owner',
  );
});

test('parseFollowUpDeclaration: no tag, non-tag brackets, or malformed tags → null', () => {
  assert.equal(parseFollowUpDeclaration('任务已闭环，无需任何操作。'), null);
  assert.equal(parseFollowUpDeclaration(''), null);
  assert.equal(parseFollowUpDeclaration('[FOLLOW_UP: later]'), null, 'only owner|none are tags');
  assert.equal(parseFollowUpDeclaration('[FOLLOW_UP:]'), null);
  assert.equal(parseFollowUpDeclaration('[FOLLOW_UP: owners should know]'), null, 'word boundary: "owners" is not the owner tag');
  assert.equal(parseFollowUpDeclaration('参考 [DELIVERABLE] 与 [NO_REPLY] 的写法'), null, 'sibling protocol tags do not collide');
});

test('resolveFollowUpAction: owner tag parks, force net outranks none, none clears, else ask the Noul', () => {
  assert.equal(resolveFollowUpAction({ declaration: 'owner', forceSignal: false }), 'park');
  assert.equal(resolveFollowUpAction({ declaration: 'owner', forceSignal: true }), 'park');
  assert.equal(resolveFollowUpAction({ declaration: 'none', forceSignal: true }), 'park', 'severity net wins over a none tag');
  assert.equal(resolveFollowUpAction({ declaration: 'none', forceSignal: false }), 'clear');
  assert.equal(resolveFollowUpAction({ declaration: null, forceSignal: true }), 'park');
  assert.equal(resolveFollowUpAction({ declaration: null, forceSignal: false }), 'noul');
});

test('classify: request hits /v1/systemone with bearer auth and the session state', async () => {
  const captured = [];
  await classifySessionFollowUpWithCerebellum({
    ...GATE_INPUT,
    fetchImpl: okFetch(classifyPayload(0.9), captured),
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.model, 'jev-latest');
  assert.equal(captured[0].body.state.session_title, GATE_INPUT.sessionTitle);
  assert.equal(captured[0].body.state.last_assistant_message, GATE_INPUT.lastAssistantText);
  assert.equal(captured[0].body.state.task_name, GATE_INPUT.taskName);
  assert.deepEqual(Object.keys(captured[0].body.questions), [CEREBELLUM_SESSION_FOLLOW_UP_QUESTION_ID]);
});

test('classify: every failure mode returns null (fail-open) without throwing', async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await classifySessionFollowUpWithCerebellum({ ...GATE_INPUT, fetchImpl: http500 }), null);

  const throwing = async () => {
    throw new Error('network down');
  };
  assert.equal(await classifySessionFollowUpWithCerebellum({ ...GATE_INPUT, fetchImpl: throwing }), null);

  const malformedJson = async () => ({ ok: true, status: 200, json: async () => 'not-json' });
  assert.equal(await classifySessionFollowUpWithCerebellum({ ...GATE_INPUT, fetchImpl: malformedJson }), null);
});

test('classify: blank assistant text never leaves the machine', async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => classifyPayload(0.9) };
  };
  assert.equal(
    await classifySessionFollowUpWithCerebellum({
      ...GATE_INPUT,
      lastAssistantText: '   ',
      fetchImpl: counting,
    }),
    null,
  );
  assert.equal(calls, 0);
});

test('classify: a hanging endpoint is aborted at the deadline', async () => {
  const hanging = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const startedAt = Date.now();
  assert.equal(
    await classifySessionFollowUpWithCerebellum({ ...GATE_INPUT, fetchImpl: hanging, timeoutMs: 25 }),
    null,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `abort deadline honored (took ${elapsed}ms)`);
  assert.equal(CEREBELLUM_SESSION_FOLLOW_UP_TIMEOUT_MS, 1500, 'default deadline stays at 1.5s');
});

// ── Dream review P2-3: the missing offline eval script ─────────────────────
// (handoff doc #19 / §2.20 — the production threshold is exercised by this
// script's sweep, which is how it gets measured.)

test('eval script builds the request through the module', () => {
  const source = readFileSync(new URL('../scripts/cerebellum-session-follow-up-eval.mjs', import.meta.url), 'utf8');
  assert.match(source, /buildSessionFollowUpRequest/);
  assert.match(source, /parseSessionFollowUpAnswer/);
  assert.match(source, /sessionFollowUpFromNoul/);
  assert.match(source, /CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD/);
  assert.match(source, /threshold sweep/i);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{10,}/, 'no hardcoded API keys in the script');
});

test('eval script --dry-run self-checks without credentials', () => {
  const output = execFileSync(process.execPath, ['scripts/cerebellum-session-follow-up-eval.mjs', 'eval', '--dry-run'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.match(output, /dry-run: \d+ cases — no API calls made\./);
  assert.match(output, /first request body that would be sent:/);
  assert.match(output, /needs_human_followup/, 'the dry-run preview shows the real request body');
});

test('eval script refuses a live run without credentials', () => {
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/cerebellum-session-follow-up-eval.mjs', 'eval'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, TYPESAFE_API_KEY: '', JEV_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    /missing API key/,
  );
});
