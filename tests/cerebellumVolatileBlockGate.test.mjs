import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_VOLATILE_GATE_TIMEOUT_MS,
  CEREBELLUM_VOLATILE_GATE_SECTION_KEYS,
  CEREBELLUM_VOLATILE_GATE_THRESHOLDS,
  CEREBELLUM_VOLATILE_GATE_MAX_MESSAGE_CHARS,
  buildVolatileGateQuestions,
  buildVolatileGateRequest,
  parseVolatileGateAnswers,
  gateVolatileBlocksWithCerebellum,
} from '../src/main/cerebellum/volatileBlockGate.ts';

const { CoworkRunner } = await import('../dist-electron/main/libs/coworkRunner.js');

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

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

function verdictPayload(noulByKey) {
  const answers = {};
  for (const [key, noul] of Object.entries(noulByKey)) {
    answers[key] = { noul };
  }
  return { model: 'jev-latest', answers, usage: { input_tokens: 220 } };
}

const GATE_INPUT = {
  config: TEST_CONFIG,
  currentUserText: '帮我重构一下这个函数，命名改成驼峰',
};

// ---------------------------------------------------------------------------
// Question building
// ---------------------------------------------------------------------------

test('buildVolatileGateQuestions: one English noul per gateable block', () => {
  const questions = buildVolatileGateQuestions();
  assert.deepEqual(
    Object.keys(questions).sort(),
    [...CEREBELLUM_VOLATILE_GATE_SECTION_KEYS].sort(),
  );
  for (const key of CEREBELLUM_VOLATILE_GATE_SECTION_KEYS) {
    const question = questions[key];
    assert.equal(question.type, 'noul');
    assert.match(question.instructions, /`current_message`/);
    assert.match(question.instructions, /Needed only when/i);
    assert.equal(typeof question.criteria.true, 'string');
  }
  assert.match(questions.experience.instructions, /self-identity|dream/i);
  assert.match(questions['twin-impression'].instructions, /worker bots/i);
  assert.match(questions['knowledge-bases'].instructions, /knowledge base/i);
  assert.match(questions['remote-services'].instructions, /remote/i);
});

test('buildVolatileGateRequest: state carries only the collapsed user message', () => {
  const request = buildVolatileGateRequest({
    currentUserText: '帮我\n\n查一下知识库',
    model: 'jev-fast',
  });
  assert.deepEqual(request.state, { current_message: '帮我 查一下知识库' });
  assert.equal(request.model, 'jev-fast');
  assert.equal(Object.keys(request.questions).length, CEREBELLUM_VOLATILE_GATE_SECTION_KEYS.length);
});

test('buildVolatileGateRequest: caps a huge pasted message before it rides the payload', () => {
  const request = buildVolatileGateRequest({
    currentUserText: 'a'.repeat(CEREBELLUM_VOLATILE_GATE_MAX_MESSAGE_CHARS + 999),
    model: 'jev-fast',
  });
  assert.equal(request.state.current_message.length, CEREBELLUM_VOLATILE_GATE_MAX_MESSAGE_CHARS);
});

// ---------------------------------------------------------------------------
// Answer parsing (fail-open per block)
// ---------------------------------------------------------------------------

test('parseVolatileGateAnswers: noul at/above the block threshold injects, below skips', () => {
  const verdicts = parseVolatileGateAnswers(verdictPayload({
    experience: 0.9,
    'twin-impression': 0.34,
    'knowledge-bases': CEREBELLUM_VOLATILE_GATE_THRESHOLDS['knowledge-bases'],
    'remote-services': 0.05,
  }));
  assert.deepEqual(verdicts, {
    experience: true,
    'twin-impression': false,
    'knowledge-bases': true,
    'remote-services': false,
    'team-culture': true, // no answer → fail-open (dream review P1 key)
  });
});

test('parseVolatileGateAnswers: missing or unusable answers inject that block', () => {
  const verdicts = parseVolatileGateAnswers(verdictPayload({ experience: 0.01 }));
  assert.equal(verdicts.experience, false);
  assert.equal(verdicts['twin-impression'], true, 'missing answer fails open');
  assert.equal(verdicts['knowledge-bases'], true);
  assert.equal(verdicts['remote-services'], true);
  const junkAnswers = parseVolatileGateAnswers({
    answers: { experience: 'weird', 'twin-impression': { noul: null } },
  });
  assert.equal(junkAnswers.experience, true);
  assert.equal(junkAnswers['twin-impression'], true);
});

test('parseVolatileGateAnswers: clamps out-of-range nouls', () => {
  const verdicts = parseVolatileGateAnswers(verdictPayload({ experience: 1.7, 'twin-impression': -0.2 }));
  assert.equal(verdicts.experience, true);
  assert.equal(verdicts['twin-impression'], false);
});

test('parseVolatileGateAnswers: unusable payload shapes return null', () => {
  assert.equal(parseVolatileGateAnswers(null), null);
  assert.equal(parseVolatileGateAnswers('junk'), null);
  assert.equal(parseVolatileGateAnswers({ nope: 1 }), null);
  assert.equal(parseVolatileGateAnswers({ answers: 'nope' }), null);
});

// ---------------------------------------------------------------------------
// gateVolatileBlocksWithCerebellum — fail-open contract
// ---------------------------------------------------------------------------

test('gate: returns the verdict map on success', async () => {
  const verdicts = await gateVolatileBlocksWithCerebellum({
    ...GATE_INPUT,
    fetchImpl: okFetch(verdictPayload({ experience: 0.02, 'remote-services': 0.88 })),
  });
  assert.equal(verdicts.experience, false);
  assert.equal(verdicts['remote-services'], true);
});

test('gate: request shape hits /v1/systemone with one noul per block', async () => {
  const captured = [];
  await gateVolatileBlocksWithCerebellum({ ...GATE_INPUT, fetchImpl: okFetch(verdictPayload({}), captured) });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.state.current_message, GATE_INPUT.currentUserText);
  assert.deepEqual(
    Object.keys(captured[0].body.questions).sort(),
    [...CEREBELLUM_VOLATILE_GATE_SECTION_KEYS].sort(),
  );
});

test('gate: blank user text never leaves the machine', async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => verdictPayload({}) };
  };
  assert.equal(
    await gateVolatileBlocksWithCerebellum({ ...GATE_INPUT, currentUserText: '  ', fetchImpl: counting }),
    null,
  );
  assert.equal(calls, 0);
});

test('gate: every failure mode returns null (fail-open) without throwing', async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await gateVolatileBlocksWithCerebellum({ ...GATE_INPUT, fetchImpl: http500 }), null);

  const throwing = async () => {
    throw new Error('network down');
  };
  assert.equal(await gateVolatileBlocksWithCerebellum({ ...GATE_INPUT, fetchImpl: throwing }), null);

  const malformedJson = async () => ({ ok: true, status: 200, json: async () => 'not-json' });
  assert.equal(await gateVolatileBlocksWithCerebellum({ ...GATE_INPUT, fetchImpl: malformedJson }), null);
});

test('gate: a hanging endpoint is aborted at the deadline', async () => {
  const hanging = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const startedAt = Date.now();
  assert.equal(
    await gateVolatileBlocksWithCerebellum({ ...GATE_INPUT, fetchImpl: hanging, timeoutMs: 25 }),
    null,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `abort deadline honored (took ${elapsed}ms)`);
  assert.equal(CEREBELLUM_VOLATILE_GATE_TIMEOUT_MS, 2500, 'default deadline aligned to 2.5s');
});

// ---------------------------------------------------------------------------
// CoworkRunner integration (compiled dist; lightweight DI harness)
// ---------------------------------------------------------------------------

const REMOTE_BLOCK_TEXT = '<available_remote_services>\n  svc-x: on-chain demo service\n</available_remote_services>';
const BROWSER_BLOCK_TEXT = '<browserTabs>\n  tab-a: docs\n</browserTabs>';

function createGateHarness({ gate, includeMemoryPromptBlocks = true }) {
  const gateCalls = [];
  const store = {
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForSession() {
          return {
            memoryEnabled: true,
            memoryImplicitUpdateEnabled: true,
            memoryLlmJudgeEnabled: true,
            memoryGuardLevel: 'standard',
            memoryUserMemoriesMaxItems: 12,
            memoryPromptMaxChars: 12000,
          };
        },
        resolveMetabotIdForMemory() {
          return 7;
        },
        listUserMemories() {
          return [];
        },
        touchUserMemoriesLastUsed() {},
      };
    },
    listCapabilityDrafts() {
      return [];
    },
    listInjectableTechniques() {
      return [];
    },
    getSession() {
      return { id: 'session-1', sessionType: 'standard', metabotId: 7, messages: [] };
    },
    getSessionWithoutMessages() {
      return {};
    },
    getConversationSourceContextBySession() {
      return { sourceChannel: 'cowork_ui', externalConversationId: null };
    },
    getMetabotIdForSession() {
      return 7;
    },
    // Recent-sessions pulse rides the same tail but has no bearing on the
    // gate under test — the stub keeps it empty.
    recentSessionPulse() {
      return [];
    },
  };
  const runner = new CoworkRunner(store, {
    getRemoteServicesPrompt: () => REMOTE_BLOCK_TEXT,
    getBrowserContextPrompt: async () => BROWSER_BLOCK_TEXT,
    // Merged turn-decision bundle (mock of the main.ts caller): only the
    // gate verdicts matter here; every other decision degrades to null.
    cerebellumTurnDecisions: gate
      ? async (input) => {
          gateCalls.push(input);
          return {
            memoryScores: null,
            knowledgeScores: null,
            skillRanking: null,
            serviceRanking: null,
            gateVerdicts: await gate(input),
          };
        }
      : undefined,
  });
  const buildVolatile = (prompt) =>
    runner.buildVolatileContextPrompt(
      'session-1',
      prompt,
      true,
      { includeMemoryPromptBlocks },
      false,
    );
  return { gateCalls, buildVolatile };
}

const GATE_QUERY = '帮我重构这个函数，把命名改成驼峰';

test('runner: a false verdict drops that block while ungated blocks stay', async () => {
  const { gateCalls, buildVolatile } = createGateHarness({
    gate: () => ({
      experience: true,
      'twin-impression': true,
      'knowledge-bases': true,
      'remote-services': false,
    }),
  });
  const output = await buildVolatile(GATE_QUERY);
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0].currentUserText, GATE_QUERY);
  assert.ok(!output.includes(REMOTE_BLOCK_TEXT), 'gated-out block must not ride the tail');
  assert.ok(output.includes(BROWSER_BLOCK_TEXT), 'browser is not gateable and always rides when present');
});

test('runner: a null gate reproduces the no-gate output byte-for-byte', async () => {
  const withNull = createGateHarness({ gate: () => null });
  const without = createGateHarness({ gate: null });

  const outputNull = await withNull.buildVolatile(GATE_QUERY);
  const outputNone = await without.buildVolatile(GATE_QUERY);

  assert.equal(outputNull, outputNone, 'null verdicts must reproduce the ungated baseline exactly');
  assert.ok(outputNull.includes(REMOTE_BLOCK_TEXT));
});

test('runner: a throwing gate falls back silently', async () => {
  const { gateCalls, buildVolatile } = createGateHarness({
    gate: () => {
      throw new Error('cerebellum exploded');
    },
  });
  const baseline = createGateHarness({ gate: null });

  const output = await buildVolatile(GATE_QUERY);
  const outputBaseline = await baseline.buildVolatile(GATE_QUERY);

  assert.equal(gateCalls.length, 1);
  assert.equal(output, outputBaseline, 'a throwing callback must never break the turn');
});

test('runner: verdicts for ungated keys are ignored (immunity lock)', async () => {
  const { buildVolatile } = createGateHarness({
    gate: () => ({ browser: false, memory: false, 'remote-services': false, goal: false }),
  });
  const output = await buildVolatile(GATE_QUERY);
  assert.ok(output.includes(BROWSER_BLOCK_TEXT), 'browser is not in the gateable set — false cannot drop it');
  assert.ok(!output.includes(REMOTE_BLOCK_TEXT));
});

test('runner: a partial verdict map fails open per block', async () => {
  const { buildVolatile } = createGateHarness({
    gate: () => ({}),
  });
  const output = await buildVolatile(GATE_QUERY);
  assert.ok(output.includes(REMOTE_BLOCK_TEXT), 'a missing key injects');
});

test('runner: a blank prompt never calls the gate', async () => {
  const { gateCalls, buildVolatile } = createGateHarness({
    gate: () => ({ 'remote-services': false }),
  });
  await buildVolatile('   ');
  assert.equal(gateCalls.length, 0);
});

test('runner: memory-disabled profiles still gate remote-services (second await site)', async () => {
  const { gateCalls, buildVolatile } = createGateHarness({
    includeMemoryPromptBlocks: false,
    gate: () => ({ experience: false, 'twin-impression': false, 'knowledge-bases': false, 'remote-services': false }),
  });
  const output = await buildVolatile(GATE_QUERY);
  assert.equal(gateCalls.length, 1);
  assert.ok(!output.includes(REMOTE_BLOCK_TEXT), 'the gate is awaited at the first consumer site');
});

test('runner: the gate call starts before the sections build (parallel with memory)', async () => {
  const events = [];
  const { buildVolatile } = createGateHarness({
    gate: async () => {
      events.push('gate-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('gate-end');
      return { 'remote-services': true };
    },
  });
  events.push('volatile-start');
  await buildVolatile(GATE_QUERY);
  assert.equal(events[0], 'volatile-start');
  assert.equal(events[1], 'gate-start', 'the gate fires immediately, not after the memory section');
});
