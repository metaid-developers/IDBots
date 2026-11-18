import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  CEREBELLUM_MEMORY_WRITE_GATE_THRESHOLD,
  CEREBELLUM_MEMORY_WRITE_GATE_TIMEOUT_MS,
  CEREBELLUM_MEMORY_WRITE_GATE_QUESTION_ID,
  CEREBELLUM_MEMORY_WRITE_GATE_MAX_USER_CHARS,
  CEREBELLUM_MEMORY_WRITE_GATE_MAX_ASSISTANT_CHARS,
  buildMemoryWriteGateQuestion,
  buildMemoryWriteGateRequest,
  parseMemoryWriteGateAnswer,
  gateMemoryWriteWithCerebellum,
} from '../src/main/cerebellum/memoryWriteGate.ts';

const require = createRequire(import.meta.url);
const {
  judgeTurnMemoryExtraction,
  setCerebellumMemoryWriteGate,
  setTurnMemoryExtractionRunner,
} = require('../dist-electron/main/libs/coworkMemoryJudge.js');

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

function gatePayload(noul) {
  return {
    model: 'jev-latest',
    answers: { [CEREBELLUM_MEMORY_WRITE_GATE_QUESTION_ID]: { noul } },
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
  userText: '记住：我对花生过敏，点外卖要检查配料表',
  assistantText: '好的，记下来了。',
  explicitOnly: false,
};

// ---------------------------------------------------------------------------
// Question wording (one noul, English instructions, two modes)
// ---------------------------------------------------------------------------

test('buildMemoryWriteGateQuestion: implicit mode asks about durable facts, preferences, and explicit instructions', () => {
  const question = buildMemoryWriteGateQuestion({ explicitOnly: false });
  assert.equal(question.type, 'noul');
  assert.match(question.instructions, /stable personal fact/);
  assert.match(question.instructions, /stable preference or habit/);
  assert.match(question.instructions, /remember\/forget instruction/);
  assert.match(question.instructions, /ANY language/);
  assert.doesNotMatch(question.instructions, /explicit-only mode/i);
  assert.equal(question.criteria.true.length > 0, true);
  assert.equal(question.criteria.false.length > 0, true);
});

test('buildMemoryWriteGateQuestion: explicit-only mode narrows to explicit instructions only', () => {
  const question = buildMemoryWriteGateQuestion({ explicitOnly: true });
  assert.match(question.instructions, /explicit-only mode/);
  assert.match(question.instructions, /ONLY an explicit remember\/forget instruction/);
  assert.match(question.criteria.false, /explicit-only mode/);
});

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

test('buildMemoryWriteGateRequest: state carries the original-language turn, one noul question', () => {
  const request = buildMemoryWriteGateRequest({
    userText: '记住：我对花生过敏',
    assistantText: '好的',
    model: 'jev-latest',
    explicitOnly: false,
  });
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.state.user_message, '记住：我对花生过敏');
  assert.equal(request.state.assistant_message, '好的');
  assert.deepEqual(Object.keys(request.questions), [CEREBELLUM_MEMORY_WRITE_GATE_QUESTION_ID]);
  assert.equal(request.questions[CEREBELLUM_MEMORY_WRITE_GATE_QUESTION_ID].type, 'noul');
});

test('buildMemoryWriteGateRequest: excerpts are normalized and capped like the extraction pass', () => {
  const request = buildMemoryWriteGateRequest({
    userText: `记住：${'很'.repeat(2000)}`,
    assistantText: `${'好'.repeat(1000)}\n\n多行`,
    model: 'jev-latest',
    explicitOnly: false,
  });
  assert.equal(request.state.user_message.length, CEREBELLUM_MEMORY_WRITE_GATE_MAX_USER_CHARS);
  assert.equal(request.state.assistant_message.length, CEREBELLUM_MEMORY_WRITE_GATE_MAX_ASSISTANT_CHARS);
  assert.equal(request.state.assistant_message.includes('\n'), false, 'whitespace collapsed');
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

test('parseMemoryWriteGateAnswer: happy path, clamping, and unusable shapes', () => {
  assert.equal(parseMemoryWriteGateAnswer(gatePayload(0.8)), 0.8);
  assert.equal(parseMemoryWriteGateAnswer(gatePayload(1.7)), 1);
  assert.equal(parseMemoryWriteGateAnswer(gatePayload(-0.2)), 0);
  assert.equal(parseMemoryWriteGateAnswer({ answers: {} }), null);
  assert.equal(parseMemoryWriteGateAnswer({ answers: { other: { noul: 0.9 } } }), null);
  assert.equal(parseMemoryWriteGateAnswer({ answers: { worth_remembering: { noul: 'high' } } }), null);
  assert.equal(parseMemoryWriteGateAnswer({ answers: { worth_remembering: {} } }), null);
  assert.equal(parseMemoryWriteGateAnswer({ nope: 1 }), null);
  assert.equal(parseMemoryWriteGateAnswer(null), null);
  assert.equal(parseMemoryWriteGateAnswer('junk'), null);
});

// ---------------------------------------------------------------------------
// gateMemoryWriteWithCerebellum — verdict semantics and fail-open contract
// ---------------------------------------------------------------------------

test('gate: noul at/above threshold proceeds, below skips', async () => {
  assert.equal(
    await gateMemoryWriteWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(gatePayload(0.9)) }),
    true,
  );
  assert.equal(
    await gateMemoryWriteWithCerebellum({
      ...GATE_INPUT,
      fetchImpl: okFetch(gatePayload(CEREBELLUM_MEMORY_WRITE_GATE_THRESHOLD)),
    }),
    true,
    'threshold is inclusive (P >= 0.5 proceeds, cookbook gate)',
  );
  assert.equal(
    await gateMemoryWriteWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(gatePayload(0.49)) }),
    false,
  );
});

test('gate: request shape hits /v1/systemone with bearer auth and the turn state', async () => {
  const captured = [];
  await gateMemoryWriteWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(gatePayload(0.9), captured) });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.model, 'jev-latest');
  assert.equal(captured[0].body.state.user_message, GATE_INPUT.userText);
  assert.equal(captured[0].body.state.assistant_message, GATE_INPUT.assistantText);
  assert.deepEqual(Object.keys(captured[0].body.questions), [CEREBELLUM_MEMORY_WRITE_GATE_QUESTION_ID]);
});

test('gate: every failure mode returns null (fail-open) without throwing', async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await gateMemoryWriteWithCerebellum({ ...GATE_INPUT, fetchImpl: http500 }), null);

  const throwing = async () => {
    throw new Error('network down');
  };
  assert.equal(await gateMemoryWriteWithCerebellum({ ...GATE_INPUT, fetchImpl: throwing }), null);

  const malformedJson = async () => ({ ok: true, status: 200, json: async () => 'not-json' });
  assert.equal(await gateMemoryWriteWithCerebellum({ ...GATE_INPUT, fetchImpl: malformedJson }), null);
});

test('gate: blank user text never leaves the machine', async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => gatePayload(0.9) };
  };
  assert.equal(
    await gateMemoryWriteWithCerebellum({ ...GATE_INPUT, userText: '   ', fetchImpl: counting }),
    null,
  );
  assert.equal(calls, 0);
});

test('gate: a hanging endpoint is aborted at the deadline', async () => {
  const hanging = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const startedAt = Date.now();
  assert.equal(
    await gateMemoryWriteWithCerebellum({ ...GATE_INPUT, fetchImpl: hanging, timeoutMs: 25 }),
    null,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `abort deadline honored (took ${elapsed}ms)`);
  assert.equal(CEREBELLUM_MEMORY_WRITE_GATE_TIMEOUT_MS, 2500, 'default deadline aligned to 2.5s');
});

// ---------------------------------------------------------------------------
// judgeTurnMemoryExtraction integration (compiled) — the gate seam
// ---------------------------------------------------------------------------

const TURN_INPUT = {
  userText: 'Recuerda que me llamo Carlos',
  assistantText: '¡Hola Carlos!',
  guardLevel: 'standard',
  implicitEnabled: true,
};

test('judgeTurnMemoryExtraction: gate=false skips the brain extraction entirely', async () => {
  setCerebellumMemoryWriteGate(async () => false);
  try {
    // Without the gate the default path returns null here (no brain
    // resolvable in the bare-Node test env), so [] proves the short-circuit.
    const result = await judgeTurnMemoryExtraction(TURN_INPUT);
    assert.deepEqual(result, []);
  } finally {
    setCerebellumMemoryWriteGate(null);
  }
});

test('judgeTurnMemoryExtraction: null and true verdicts fall through to the ungated path', async () => {
  for (const verdict of [null, true]) {
    setCerebellumMemoryWriteGate(async () => verdict);
    const result = await judgeTurnMemoryExtraction(TURN_INPUT);
    assert.equal(result, null, `verdict ${String(verdict)} must proceed to the brain path`);
  }
  setCerebellumMemoryWriteGate(null);
});

test('judgeTurnMemoryExtraction: a throwing gate degrades to no gate', async () => {
  setCerebellumMemoryWriteGate(async () => {
    throw new Error('jev unreachable');
  });
  try {
    const result = await judgeTurnMemoryExtraction(TURN_INPUT);
    assert.equal(result, null, 'gate failure falls through like a missing gate');
  } finally {
    setCerebellumMemoryWriteGate(null);
  }
});

test('judgeTurnMemoryExtraction: the skip verdict is not cached', async () => {
  let gateCalls = 0;
  setCerebellumMemoryWriteGate(async () => {
    gateCalls += 1;
    return false;
  });
  try {
    await judgeTurnMemoryExtraction(TURN_INPUT);
    await judgeTurnMemoryExtraction(TURN_INPUT);
    assert.equal(gateCalls, 2, 'identical turns re-evaluate the gate (Settings changes apply fast)');
  } finally {
    setCerebellumMemoryWriteGate(null);
  }
});

test('judgeTurnMemoryExtraction: the gate receives the full turn input', async () => {
  let captured = null;
  setCerebellumMemoryWriteGate(async (input) => {
    captured = input;
    return false;
  });
  try {
    await judgeTurnMemoryExtraction(TURN_INPUT);
    assert.deepEqual(captured, TURN_INPUT);
  } finally {
    setCerebellumMemoryWriteGate(null);
  }
});

test('judgeTurnMemoryExtraction: the injected runner stays the executor itself (seam ordering lock)', async () => {
  setCerebellumMemoryWriteGate(async () => false);
  let runnerCalls = 0;
  setTurnMemoryExtractionRunner(async () => {
    runnerCalls += 1;
    return [{ action: 'add', text: 'Me llamo Carlos', isExplicit: true }];
  });
  try {
    const result = await judgeTurnMemoryExtraction(TURN_INPUT);
    assert.equal(runnerCalls, 1, 'the runner IS the brain-call seam and bypasses the gate');
    assert.equal(result.length, 1);
  } finally {
    setTurnMemoryExtractionRunner(null);
    setCerebellumMemoryWriteGate(null);
  }
});
