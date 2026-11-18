/**
 * Cerebellum (小脑) per-turn decision bundle unit tests.
 *
 * Pins the P0 merge contract: ONE /v1/systemone request per turn carries all
 * five turn-scoped decisions (memory re-rank, skill shortlist, remote-service
 * shortlist, volatile block gate, knowledge hot rank) under their disjoint
 * question ids, one shared state, and per-decision degradation preserved from
 * the split-call era (floors, coverage, fail-to-null).
 *
 * The bundle module has runtime sibling imports (extension-less for tsc), so
 * this test loads the compiled dist-electron build — compile:electron first,
 * mirroring the knowledgePromptBlocks precedent in the eval scripts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

const {
  CEREBELLUM_TURN_DECISION_TIMEOUT_MS,
  selectTurnDecisionCandidates,
  buildTurnDecisionRequest,
  parseTurnDecisionAnswers,
  runCerebellumTurnDecisions,
} = require('../dist-electron/main/cerebellum/turnDecisionBundle.js');
const {
  CEREBELLUM_VOLATILE_GATE_SECTION_KEYS,
} = require('../dist-electron/main/cerebellum/volatileBlockGate.js');
const {
  CEREBELLUM_MEMORY_MIN_POOL,
} = require('../dist-electron/main/cerebellum/memoryRank.js');
const {
  CEREBELLUM_SKILL_SHORTLIST_MIN_POOL,
} = require('../dist-electron/main/cerebellum/skillShortlist.js');

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

function buildMemories(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `mem-${index}`,
    text: `durable owner fact number ${index} about daily preferences`,
  }));
}

function buildSkills(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `skill-${index}`,
    name: `skill-${index}`,
    description: `Capability ${index}: handles a distinct class of requests.`,
  }));
}

function buildServices(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `svc-${index}`,
    name: `svc-${index}`,
    description: `On-chain service ${index}: provides a distinct external capability.`,
  }));
}

function buildKnowledge(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `kn-${index}`,
    topic: `topic ${index}`,
    summary: `reusable know-how number ${index}`,
    kind: 'know_how',
  }));
}

const FULL_DECISIONS = {
  currentUserText: '帮我查一下知识库里关于 MVC 协议的笔记，可能要调用外部服务做审计',
  memories: buildMemories(CEREBELLUM_MEMORY_MIN_POOL + 3),
  knowledge: buildKnowledge(12),
  skills: buildSkills(CEREBELLUM_SKILL_SHORTLIST_MIN_POOL + 2),
  services: buildServices(15),
  includeGate: true,
};

function fullAnswerPayload(selection) {
  const answers = {};
  selection.memories.forEach((memory, index) => {
    answers[`mem_${index}`] = { noul: index === 0 ? 0.9 : 0.1 };
  });
  selection.knowledge.forEach((_, index) => {
    answers[`kn_${index}`] = { noul: index === 0 ? 0.8 : 0.05 };
  });
  answers.best_skill = {
    probabilities: {
      'skill-0': 0.7,
      'skill-1': 0.2,
      'skill-2': 0.1,
    },
  };
  answers.best_service = { choice: 'svc-3' };
  for (const key of CEREBELLUM_VOLATILE_GATE_SECTION_KEYS) {
    answers[key] = { noul: key === 'knowledge-bases' ? 0.9 : 0.05 };
  }
  return { model: 'jev-latest', answers, usage: { input_tokens: 900 } };
}

// ---------------------------------------------------------------------------
// Selection floors
// ---------------------------------------------------------------------------

test('selectTurnDecisionCandidates: blank text yields null (no request at all)', () => {
  assert.equal(selectTurnDecisionCandidates({ ...FULL_DECISIONS, currentUserText: '   ' }), null);
});

test('selectTurnDecisionCandidates: every pool below its floor with the gate off yields null', () => {
  const selection = selectTurnDecisionCandidates({
    ...FULL_DECISIONS,
    memories: buildMemories(CEREBELLUM_MEMORY_MIN_POOL - 1),
    knowledge: [],
    skills: buildSkills(CEREBELLUM_SKILL_SHORTLIST_MIN_POOL - 1),
    services: [],
    includeGate: false,
  });
  assert.equal(selection, null);
});

test('selectTurnDecisionCandidates: floors apply per decision, not to the whole turn', () => {
  const selection = selectTurnDecisionCandidates({
    ...FULL_DECISIONS,
    memories: buildMemories(CEREBELLUM_MEMORY_MIN_POOL - 1),
    knowledge: [],
    skills: buildSkills(CEREBELLUM_SKILL_SHORTLIST_MIN_POOL - 1),
    services: [],
    includeGate: true,
  });
  assert.ok(selection, 'the gate alone still makes the turn call eligible');
  assert.equal(selection.memories.length, 0);
  assert.equal(selection.knowledge.length, 0);
  assert.equal(selection.skills.length, 0);
  assert.equal(selection.services.length, 0);
  assert.equal(selection.includeGate, true);
});

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

test('buildTurnDecisionRequest: one state, disjoint question ids for all five decisions', () => {
  const selection = selectTurnDecisionCandidates(FULL_DECISIONS);
  const request = buildTurnDecisionRequest({ selection, model: 'jev-latest' });

  // One shared state: the message plus each scored pool exactly once.
  assert.equal(request.state.current_message, FULL_DECISIONS.currentUserText);
  assert.equal(request.state.memories.length, selection.memories.length);
  assert.equal(request.state.knowledge.length, selection.knowledge.length);
  assert.deepEqual(Object.keys(request.state).sort(), ['current_message', 'knowledge', 'memories']);

  const ids = Object.keys(request.questions);
  assert.ok(ids.includes('best_skill'), 'skill choice rides under its existing id');
  assert.ok(ids.includes('best_service'), 'service choice rides under its existing id');
  for (const key of CEREBELLUM_VOLATILE_GATE_SECTION_KEYS) {
    assert.ok(ids.includes(key), `gate question ${key} rides under its section key`);
  }
  assert.ok(ids.filter((id) => id.startsWith('mem_')).length === selection.memories.length);
  assert.ok(ids.filter((id) => id.startsWith('kn_')).length === selection.knowledge.length);
  // Disjoint by construction, but pin it: no id serves two decisions.
  assert.equal(new Set(ids).size, ids.length);
  // Instructions reference the shared state field, never a second message copy.
  assert.ok(request.questions.best_skill.instructions.includes('`current_message`'));
  assert.ok(request.questions.experience.instructions.includes('`current_message`'));
});

test('buildTurnDecisionRequest: gate-off turns carry no gate questions', () => {
  const selection = selectTurnDecisionCandidates({ ...FULL_DECISIONS, includeGate: false });
  const request = buildTurnDecisionRequest({ selection, model: 'jev-latest' });
  for (const key of CEREBELLUM_VOLATILE_GATE_SECTION_KEYS) {
    assert.ok(!Object.keys(request.questions).includes(key));
  }
});

test('buildTurnDecisionRequest: pools below their floor contribute no questions and no state', () => {
  const selection = selectTurnDecisionCandidates({
    ...FULL_DECISIONS,
    memories: [],
    knowledge: [],
    includeGate: true,
  });
  const request = buildTurnDecisionRequest({ selection, model: 'jev-latest' });
  const ids = Object.keys(request.questions);
  assert.ok(!ids.some((id) => id.startsWith('mem_')));
  assert.ok(!ids.some((id) => id.startsWith('kn_')));
  assert.equal(request.state.memories, undefined);
  assert.equal(request.state.knowledge, undefined);
});

// ---------------------------------------------------------------------------
// Empty-pool choice regression (2026-10-19): a below-floor roster made the
// builders emit { type:'choice', criteria:{} }, and the JEV schema rejected
// the WHOLE merged request with a 422 ("Dictionary should have at least 1
// item" on questions.best_service.choice.criteria). An empty pool must send
// NO question at all.
// ---------------------------------------------------------------------------

test('buildTurnDecisionRequest: an empty skill pool sends no best_skill question', () => {
  const selection = selectTurnDecisionCandidates({ ...FULL_DECISIONS, skills: [] });
  assert.equal(selection.skills.length, 0);
  const request = buildTurnDecisionRequest({ selection, model: 'jev-latest' });
  const ids = Object.keys(request.questions);
  assert.ok(!ids.includes('best_skill'), 'no skill choice question without candidates');
  assert.ok(ids.includes('best_service'), 'the service choice still rides its own pool');
});

test('buildTurnDecisionRequest: an empty service pool sends no best_service question', () => {
  const selection = selectTurnDecisionCandidates({ ...FULL_DECISIONS, services: [] });
  assert.equal(selection.services.length, 0);
  const request = buildTurnDecisionRequest({ selection, model: 'jev-latest' });
  const ids = Object.keys(request.questions);
  assert.ok(!ids.includes('best_service'), 'no service choice question without candidates');
  assert.ok(ids.includes('best_skill'), 'the skill choice still rides its own pool');
});

test('buildTurnDecisionRequest: both choice pools empty send neither question', () => {
  const selection = selectTurnDecisionCandidates({
    ...FULL_DECISIONS,
    skills: [],
    services: [],
    includeGate: true,
  });
  const request = buildTurnDecisionRequest({ selection, model: 'jev-latest' });
  const ids = Object.keys(request.questions);
  assert.ok(!ids.includes('best_skill'));
  assert.ok(!ids.includes('best_service'));
  for (const key of CEREBELLUM_VOLATILE_GATE_SECTION_KEYS) {
    assert.ok(ids.includes(key), `the gate keeps the turn eligible: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

test('parseTurnDecisionAnswers: one payload resolves all five decisions', () => {
  const selection = selectTurnDecisionCandidates(FULL_DECISIONS);
  const results = parseTurnDecisionAnswers(fullAnswerPayload(selection), selection);

  assert.equal(results.memoryScores.get('mem-0'), 0.9);
  assert.equal(results.memoryScores.size, selection.memories.length);
  assert.equal(results.knowledgeScores.get('kn-0'), 0.8);
  assert.equal(results.knowledgeScores.size, selection.knowledge.length);
  assert.deepEqual(results.skillRanking[0], { id: 'skill-0', probability: 0.7 });
  assert.deepEqual(results.serviceRanking, [{ id: 'svc-3', probability: 1 }]);
  assert.equal(results.gateVerdicts['knowledge-bases'], true, 'noul 0.9 >= 0.35 threshold');
  assert.equal(results.gateVerdicts['remote-services'], false, 'noul 0.05 < 0.35 threshold');
});

test('parseTurnDecisionAnswers: a missing section degrades that decision alone', () => {
  const selection = selectTurnDecisionCandidates(FULL_DECISIONS);
  const payload = fullAnswerPayload(selection);
  delete payload.answers.best_skill;
  delete payload.answers.best_service;
  const results = parseTurnDecisionAnswers(payload, selection);

  assert.equal(results.skillRanking, null);
  assert.equal(results.serviceRanking, null);
  assert.ok(results.memoryScores, 'memory scores survive a dead shortlist section');
  assert.ok(results.gateVerdicts, 'gate verdicts survive too');
});

test('parseTurnDecisionAnswers: empty pools degrade to null rankings even with no answer sent', () => {
  // Pinned alongside the empty-pool request fix: a turn whose skill and
  // service pools are below their floors sends no best_skill/best_service
  // QUESTION, so the answer payload has no such SECTION either — the parsers
  // must resolve both rankings to null without choking on the absence.
  const selection = selectTurnDecisionCandidates({
    ...FULL_DECISIONS,
    skills: [],
    services: [],
    includeGate: true,
  });
  const payload = fullAnswerPayload(selection);
  delete payload.answers.best_skill;
  delete payload.answers.best_service;
  const results = parseTurnDecisionAnswers(payload, selection);

  assert.equal(results.skillRanking, null);
  assert.equal(results.serviceRanking, null);
  assert.ok(results.memoryScores);
  assert.ok(results.knowledgeScores);
  assert.ok(results.gateVerdicts);
});

test('parseTurnDecisionAnswers: memory coverage floor still rejects partial maps', () => {
  const selection = selectTurnDecisionCandidates(FULL_DECISIONS);
  const payload = fullAnswerPayload(selection);
  // Keep only one memory answer — far below the 0.8 coverage floor.
  selection.memories.forEach((_, index) => {
    if (index > 0) delete payload.answers[`mem_${index}`];
  });
  const results = parseTurnDecisionAnswers(payload, selection);
  assert.equal(results.memoryScores, null, 'an incomplete score map must not mix with lexical ranks');
  assert.ok(results.knowledgeScores, 'the knowledge section is judged on its own coverage');
});

// ---------------------------------------------------------------------------
// Executor: ONE request per turn
// ---------------------------------------------------------------------------

test('runCerebellumTurnDecisions: one /v1/systemone call resolves every decision', async () => {
  const fetches = [];
  const results = await runCerebellumTurnDecisions({
    config: TEST_CONFIG,
    fetchImpl: async (url, init) => {
      fetches.push({ url, init, body: JSON.parse(init.body) });
      const selection = selectTurnDecisionCandidates(FULL_DECISIONS);
      return {
        ok: true,
        status: 200,
        json: async () => fullAnswerPayload(selection),
      };
    },
    decisions: FULL_DECISIONS,
  });

  assert.equal(fetches.length, 1, 'the whole turn rides ONE request');
  assert.ok(fetches[0].url.endsWith('/v1/systemone'));
  assert.equal(fetches[0].init.method, 'POST');
  assert.ok(results.memoryScores);
  assert.ok(results.knowledgeScores);
  assert.ok(results.skillRanking);
  assert.ok(results.serviceRanking);
  assert.ok(results.gateVerdicts);
});

test('runCerebellumTurnDecisions: uneligible input makes no request at all', async () => {
  const fetches = [];
  const results = await runCerebellumTurnDecisions({
    config: TEST_CONFIG,
    fetchImpl: async (url, init) => {
      fetches.push({ url });
      return { ok: true, status: 200, json: async () => ({}) };
    },
    decisions: { ...FULL_DECISIONS, currentUserText: '' },
  });
  assert.equal(results, null);
  assert.equal(fetches.length, 0);
});

test('runCerebellumTurnDecisions: a gate-only turn sends no choice question and still gets its 200', async () => {
  // The production 422 shape: every pool below its floor, only the volatile
  // gate eligible. The bundle must go out (gate questions only), the relay
  // must answer 200, and every pool decision degrades to null in ONE call.
  const fetches = [];
  const gateOnlyDecisions = {
    currentUserText: FULL_DECISIONS.currentUserText,
    memories: [],
    knowledge: [],
    skills: [],
    services: [],
    includeGate: true,
  };
  const results = await runCerebellumTurnDecisions({
    config: TEST_CONFIG,
    fetchImpl: async (url, init) => {
      fetches.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => {
          const answers = {};
          for (const key of CEREBELLUM_VOLATILE_GATE_SECTION_KEYS) {
            answers[key] = { noul: key === 'knowledge-bases' ? 0.9 : 0.05 };
          }
          return { model: 'jev-latest', answers, usage: { input_tokens: 120 } };
        },
      };
    },
    decisions: gateOnlyDecisions,
  });

  assert.equal(fetches.length, 1, 'one request for the eligible gate');
  const body = fetches[0].body;
  assert.ok(!('best_skill' in body.questions), 'no skill choice question without candidates');
  assert.ok(!('best_service' in body.questions), 'no service choice question without candidates');
  assert.deepEqual(
    Object.keys(body.questions).sort(),
    [...CEREBELLUM_VOLATILE_GATE_SECTION_KEYS].sort(),
    'the gate questions are the whole payload',
  );
  // An empty pool's score map is EMPTY, not null (0 >= 0 * coverage holds
  // vacuously) — the same shape every 200 turn with a below-floor pool has
  // always carried, and a no-op for the prompt-ordering consumers.
  assert.equal(results.memoryScores.size, 0);
  assert.equal(results.knowledgeScores.size, 0);
  assert.equal(results.skillRanking, null);
  assert.equal(results.serviceRanking, null);
  assert.equal(results.gateVerdicts['knowledge-bases'], true);
  assert.equal(results.gateVerdicts['remote-services'], false);
});

test('runCerebellumTurnDecisions: HTTP failure degrades the whole bundle to null', async () => {
  const results = await runCerebellumTurnDecisions({
    config: TEST_CONFIG,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    decisions: FULL_DECISIONS,
  });
  assert.equal(results, null);
});

test('runCerebellumTurnDecisions: abort/timeout degrades to null and keeps the 1.5s budget', async () => {
  const startedAt = Date.now();
  const results = await runCerebellumTurnDecisions({
    config: TEST_CONFIG,
    fetchImpl: (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    decisions: FULL_DECISIONS,
    timeoutMs: 30,
  });
  assert.equal(results, null);
  assert.ok(Date.now() - startedAt < 1000, 'abort deadline honored');
  assert.equal(CEREBELLUM_TURN_DECISION_TIMEOUT_MS, 2500, 'default deadline aligned to 2.5s');
});

test('runCerebellumTurnDecisions: payload accounting counts every decision once', async () => {
  const stats = [];
  await runCerebellumTurnDecisions({
    config: TEST_CONFIG,
    fetchImpl: async () => {
      const selection = selectTurnDecisionCandidates(FULL_DECISIONS);
      return { ok: true, status: 200, json: async () => fullAnswerPayload(selection) };
    },
    decisions: FULL_DECISIONS,
    onPayload: (value) => stats.push(value),
  });
  assert.equal(stats.length, 1);
  const [stat] = stats;
  const selection = selectTurnDecisionCandidates(FULL_DECISIONS);
  assert.equal(stat.memoriesSent, selection.memories.length);
  assert.equal(stat.knowledgeSent, selection.knowledge.length);
  assert.equal(stat.skillsSent, selection.skills.length);
  assert.equal(stat.servicesSent, selection.services.length);
  assert.equal(stat.gateQuestions, 5, 'team-culture joined the gateable blocks (review Minor 6)');
  // Choice decisions are ONE question each (options ride inside `criteria`).
  assert.equal(stat.totalQuestions,
    selection.memories.length + selection.knowledge.length + 5 + 2);
  assert.ok(stat.totalChars > 0);
});
