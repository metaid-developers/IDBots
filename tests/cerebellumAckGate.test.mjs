// src/main/cerebellum/ackGate.ts — the turn-entry classifier behind the
// first-sentence bubble gate.
//
// One Noul (turn_ack_needed) reads the just-arrived user message and decides
// whether the turn keeps its LLM first-sentence bubble: true → the ack is
// written and emitted as before; false → the turn is conversational enough
// that the main reply arrives as the SINGLE bubble (owner decision
// 2026-11-03, session 3ecd2a2f — simple and complex messages alike used to
// get two bubbles); null (disabled/timeout/quota/blank/malformed) → fail-open,
// the ack is emitted exactly as before the gate existed.
//
// Contract under test:
//   a. request shape — one noul question, English instructions, the user
//      message whitespace-collapsed and hard-capped, judge-intent-not-keywords
//      pinned in the instructions (owner requirement: no hardcoded text rules);
//   b. answer parsing — clamps into 0..1, unusable shapes → null;
//   c. verdict semantics — noul >= threshold → true (keep the ack);
//   d. every failure mode returns null without throwing (fail-open);
//   e. a hanging endpoint is aborted at the deadline;
//   f. the eval script builds its request through this module (no drift).
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
  CEREBELLUM_TURN_ACK_GATE_THRESHOLD,
  CEREBELLUM_TURN_ACK_GATE_TIMEOUT_MS,
  CEREBELLUM_TURN_ACK_GATE_QUESTION_ID,
  CEREBELLUM_TURN_ACK_GATE_MESSAGE_MAX_CHARS,
  buildTurnAckGateRequest,
  parseTurnAckGateAnswer,
  turnAckNeededFromNoul,
  classifyTurnAckNeedWithCerebellum,
} from '../src/main/cerebellum/ackGate.ts';

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

function classifyPayload(noul) {
  return {
    model: 'jev-latest',
    answers: { [CEREBELLUM_TURN_ACK_GATE_QUESTION_ID]: { noul } },
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
  currentUserText: '帮我把这个构建失败的 bug 修一下',
};

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

test('buildTurnAckGateRequest: state carries the user message, one noul question', () => {
  const request = buildTurnAckGateRequest({
    currentUserText: GATE_INPUT.currentUserText,
    model: 'jev-latest',
  });
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.state.user_message, GATE_INPUT.currentUserText);
  assert.deepEqual(Object.keys(request.questions), [CEREBELLUM_TURN_ACK_GATE_QUESTION_ID]);
  const question = request.questions[CEREBELLUM_TURN_ACK_GATE_QUESTION_ID];
  assert.equal(question.type, 'noul');
  // The aligned boundary (owner 2026-11-03): needing tools — local machine,
  // web2, or the on-chain AI internet — is what makes a message "complex".
  assert.match(question.instructions, /local machine/);
  assert.match(question.instructions, /web search/);
  assert.match(question.instructions, /AI internet\/MetaWeb/);
  assert.match(question.instructions, /recalling past conversations/);
  assert.match(question.instructions, /greetings, check-ins, small talk/);
  // Owner requirement: judgment by intent, never hardcoded wording rules.
  assert.match(question.instructions, /ANY language/);
  assert.match(question.instructions, /judge the work the message implies, never surface keywords/);
  assert.match(question.criteria.true, /interim acknowledgment/);
  assert.match(question.criteria.false, /one short conversational reply/);
});

test('buildTurnAckGateRequest: the user message is whitespace-collapsed and hard-capped', () => {
  const request = buildTurnAckGateRequest({
    currentUserText: `  在吗\n\n${'聊'.repeat(3000)}  `,
    model: 'jev-latest',
  });
  assert.equal(request.state.user_message.length, CEREBELLUM_TURN_ACK_GATE_MESSAGE_MAX_CHARS);
  assert.equal(request.state.user_message.includes('\n'), false, 'whitespace collapsed');
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

test('parseTurnAckGateAnswer: happy path, clamping, and unusable shapes', () => {
  assert.equal(parseTurnAckGateAnswer(classifyPayload(0.8)), 0.8);
  assert.equal(parseTurnAckGateAnswer(classifyPayload(1.7)), 1);
  assert.equal(parseTurnAckGateAnswer(classifyPayload(-0.2)), 0);
  assert.equal(parseTurnAckGateAnswer({ answers: {} }), null);
  assert.equal(parseTurnAckGateAnswer({ answers: { other: { noul: 0.9 } } }), null);
  assert.equal(parseTurnAckGateAnswer({ answers: { turn_ack_needed: { noul: 'high' } } }), null);
  assert.equal(parseTurnAckGateAnswer({ answers: { turn_ack_needed: {} } }), null);
  assert.equal(parseTurnAckGateAnswer({ nope: 1 }), null);
  assert.equal(parseTurnAckGateAnswer(null), null);
  assert.equal(parseTurnAckGateAnswer('junk'), null);
});

test('turnAckNeededFromNoul: threshold is inclusive at 0.5', () => {
  assert.equal(turnAckNeededFromNoul(0.5), true);
  assert.equal(turnAckNeededFromNoul(0.49), false);
  assert.equal(turnAckNeededFromNoul(0), false);
  assert.equal(turnAckNeededFromNoul(1), true);
  assert.equal(CEREBELLUM_TURN_ACK_GATE_THRESHOLD, 0.5);
});

// ---------------------------------------------------------------------------
// classifyTurnAckNeedWithCerebellum — verdict semantics and fail-open
// ---------------------------------------------------------------------------

test('classify: noul at/above threshold → keep the ack, below → skip it', async () => {
  assert.equal(
    await classifyTurnAckNeedWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(classifyPayload(0.9)) }),
    true,
  );
  assert.equal(
    await classifyTurnAckNeedWithCerebellum({
      ...GATE_INPUT,
      fetchImpl: okFetch(classifyPayload(CEREBELLUM_TURN_ACK_GATE_THRESHOLD)),
    }),
    true,
    'threshold is inclusive (P >= 0.5 → keep the ack)',
  );
  assert.equal(
    await classifyTurnAckNeedWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(classifyPayload(0.34)) }),
    false,
  );
});

test('classify: request hits /v1/systemone with bearer auth and the user message', async () => {
  const captured = [];
  await classifyTurnAckNeedWithCerebellum({
    ...GATE_INPUT,
    fetchImpl: okFetch(classifyPayload(0.9), captured),
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.model, 'jev-latest');
  assert.equal(captured[0].body.state.user_message, GATE_INPUT.currentUserText);
  assert.deepEqual(Object.keys(captured[0].body.questions), [CEREBELLUM_TURN_ACK_GATE_QUESTION_ID]);
});

test('classify: every failure mode returns null (fail-open) without throwing', async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await classifyTurnAckNeedWithCerebellum({ ...GATE_INPUT, fetchImpl: http500 }), null);

  const throwing = async () => {
    throw new Error('network down');
  };
  assert.equal(await classifyTurnAckNeedWithCerebellum({ ...GATE_INPUT, fetchImpl: throwing }), null);

  const malformedJson = async () => ({ ok: true, status: 200, json: async () => 'not-json' });
  assert.equal(await classifyTurnAckNeedWithCerebellum({ ...GATE_INPUT, fetchImpl: malformedJson }), null);
});

test('classify: blank user text never leaves the machine', async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => classifyPayload(0.9) };
  };
  assert.equal(
    await classifyTurnAckNeedWithCerebellum({ ...GATE_INPUT, currentUserText: '   ', fetchImpl: counting }),
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
    await classifyTurnAckNeedWithCerebellum({ ...GATE_INPUT, fetchImpl: hanging, timeoutMs: 25 }),
    null,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `abort deadline honored (took ${elapsed}ms)`);
  assert.equal(CEREBELLUM_TURN_ACK_GATE_TIMEOUT_MS, 1500, 'default deadline stays at 1.5s');
});

// ---------------------------------------------------------------------------
// Offline eval script (threshold calibration, same pattern as the other gates)
// ---------------------------------------------------------------------------

test('eval script builds the request through the module', () => {
  const source = readFileSync(new URL('../scripts/cerebellum-ack-gate-eval.mjs', import.meta.url), 'utf8');
  assert.match(source, /buildTurnAckGateRequest/);
  assert.match(source, /parseTurnAckGateAnswer/);
  assert.match(source, /turnAckNeededFromNoul/);
  assert.match(source, /CEREBELLUM_TURN_ACK_GATE_THRESHOLD/);
  assert.match(source, /threshold sweep/i);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{10,}/, 'no hardcoded API keys in the script');
});

test('eval script --dry-run self-checks without credentials', () => {
  const output = execFileSync(process.execPath, ['scripts/cerebellum-ack-gate-eval.mjs', 'eval', '--dry-run'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.match(output, /dry-run: \d+ cases — no API calls made\./);
  assert.match(output, /first request body that would be sent:/);
  assert.match(output, /turn_ack_needed/, 'the dry-run preview shows the real request body');
});

test('eval script refuses a live run without credentials', () => {
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/cerebellum-ack-gate-eval.mjs', 'eval'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, TYPESAFE_API_KEY: '', JEV_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    /missing API key/,
  );
});
