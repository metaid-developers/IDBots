import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_SKILL_SHORTLIST_TIMEOUT_MS,
  CEREBELLUM_SKILL_SHORTLIST_TOP_K,
  CEREBELLUM_SKILL_SHORTLIST_MIN_POOL,
  CEREBELLUM_SKILL_MAX_OPTIONS,
  CEREBELLUM_SKILL_OPTION_MAX_DESCRIPTION_CHARS,
  CEREBELLUM_SKILL_OPTIONS_TOTAL_MAX_CHARS,
  CEREBELLUM_SKILL_RANK_QUESTION_ID,
  buildSkillChoiceQuestions,
  buildSkillOptionLabel,
  buildSkillShortlistRequest,
  buildSkillShortlistBlock,
  parseSkillShortlistAnswers,
  rankSkillsWithCerebellum,
} from '../src/main/cerebellum/skillShortlist.ts';

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

function probabilitiesPayload(probabilities, choice) {
  const answer = { type: 'choice', probabilities };
  if (choice !== undefined) answer.choice = choice;
  return {
    model: 'jev-latest',
    answers: { [CEREBELLUM_SKILL_RANK_QUESTION_ID]: answer },
    usage: { input_tokens: 900 },
  };
}

const SKILLS = [
  { id: 'web-search', name: 'web-search', description: 'Search the web and summarize results for the user.' },
  { id: 'ppt-maker', name: 'ppt-maker', description: '生成演示文稿幻灯片，支持主题大纲与图表。' },
  { id: 'cat-care', name: 'cat-care', description: 'Advise on cat diet, health, and daily care.' },
];

function buildPool(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `skill-${index}`,
    name: `skill-${index}`,
    description: `Capability number ${index}: handles task family ${index} end to end.`,
  }));
}

const RANK_INPUT = {
  config: TEST_CONFIG,
  currentUserText: '帮我做一份关于 MVC 链最新动态的演示文稿',
  skills: buildPool(CEREBELLUM_SKILL_SHORTLIST_MIN_POOL + 3),
};

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

test('buildSkillChoiceQuestions: an empty pool makes NO question (an empty criteria map is a 422)', () => {
  // The per-turn decision bundle spreads this builder unconditionally, so an
  // empty roster must contribute nothing — a { type:'choice', criteria:{} }
  // question fails the JEV schema ("Dictionary should have at least 1 item")
  // and used to fail the WHOLE merged request (2026-10-19 regression).
  assert.deepEqual(buildSkillChoiceQuestions([]), {});
});

test('buildSkillShortlistRequest: user message in state, skills as choice criteria keyed by id', () => {
  const request = buildSkillShortlistRequest({
    currentUserText: '帮我做一份演示文稿',
    skills: SKILLS,
    model: 'jev-fast',
  });
  assert.deepEqual(request.state, { current_message: '帮我做一份演示文稿' });
  assert.equal(request.model, 'jev-fast');
  assert.deepEqual(Object.keys(request.questions), [CEREBELLUM_SKILL_RANK_QUESTION_ID]);
  const question = request.questions[CEREBELLUM_SKILL_RANK_QUESTION_ID];
  assert.equal(question.type, 'choice');
  assert.match(question.instructions, /Which ONE skill/);
  assert.match(question.instructions, /`current_message`/);
  assert.match(question.instructions, /any language/);
  assert.deepEqual(Object.keys(question.criteria), ['web-search', 'ppt-maker', 'cat-care']);
  assert.match(question.criteria['ppt-maker'], /^ppt-maker: 生成演示文稿/);
});

test('buildSkillShortlistRequest: option labels collapse whitespace, cap descriptions, and survive blank ones', () => {
  const long = 'x'.repeat(CEREBELLUM_SKILL_OPTION_MAX_DESCRIPTION_CHARS + 50);
  assert.equal(
    buildSkillOptionLabel({ id: 'a', name: 'skill-a', description: `${long}` }).length,
    'skill-a: '.length + CEREBELLUM_SKILL_OPTION_MAX_DESCRIPTION_CHARS,
  );
  assert.equal(
    buildSkillOptionLabel({ id: 'a', name: 'skill-a', description: 'a \n\n b' }),
    'skill-a: a b',
  );
  assert.equal(buildSkillOptionLabel({ id: 'a', name: 'skill-a', description: '   ' }), 'skill-a');
});

test('buildSkillShortlistRequest: never carries more than the JEV choice option limit', () => {
  const request = buildSkillShortlistRequest({
    currentUserText: 'query',
    skills: buildPool(CEREBELLUM_SKILL_MAX_OPTIONS + 20),
    model: 'jev-latest',
  });
  const count = Object.keys(request.questions[CEREBELLUM_SKILL_RANK_QUESTION_ID].criteria).length;
  assert.equal(count, CEREBELLUM_SKILL_MAX_OPTIONS);
});

test('buildSkillShortlistRequest: total label budget backstop cuts a pathological catalog', () => {
  const skills = Array.from({ length: 100 }, (_, index) => ({
    id: `big-${index}`,
    name: `big-${index}`,
    description: 'd'.repeat(CEREBELLUM_SKILL_OPTION_MAX_DESCRIPTION_CHARS),
  }));
  const request = buildSkillShortlistRequest({
    currentUserText: 'query',
    skills,
    model: 'jev-latest',
  });
  const criteria = request.questions[CEREBELLUM_SKILL_RANK_QUESTION_ID].criteria;
  const labels = Object.values(criteria);
  const totalChars = labels.reduce((sum, label) => sum + label.length, 0);
  assert.ok(labels.length < skills.length, 'the budget must actually cut the catalog');
  assert.ok(labels.length > 1, 'at least the first option always rides');
  assert.ok(totalChars <= CEREBELLUM_SKILL_OPTIONS_TOTAL_MAX_CHARS, `total ${totalChars} stays within budget`);
  assert.equal(labels[0], criteria['big-0'], 'catalog order is preserved, tail options drop');
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

test('parseSkillShortlistAnswers: sorts the probabilities map, skipping unknown keys and junk values', () => {
  const ranking = parseSkillShortlistAnswers(
    probabilitiesPayload({ 'skill-0': 0.2, 'skill-3': 0.71, 'skill-1': 0.5, ghost: 0.9, 'skill-2': 'high' }),
    buildPool(4),
  );
  assert.deepEqual(ranking, [
    { id: 'skill-3', probability: 0.71 },
    { id: 'skill-1', probability: 0.5 },
    { id: 'skill-0', probability: 0.2 },
  ]);
});

test('parseSkillShortlistAnswers: clamps out-of-range probabilities', () => {
  const ranking = parseSkillShortlistAnswers(
    probabilitiesPayload({ 'skill-0': 1.7, 'skill-1': -0.4 }),
    buildPool(2),
  );
  assert.deepEqual(ranking, [
    { id: 'skill-0', probability: 1 },
    { id: 'skill-1', probability: 0 },
  ]);
});

test('parseSkillShortlistAnswers: falls back to the top-level choice when probabilities are unusable', () => {
  assert.deepEqual(
    parseSkillShortlistAnswers(probabilitiesPayload({}, 'skill-2'), buildPool(4)),
    [{ id: 'skill-2', probability: 1 }],
  );
  assert.deepEqual(
    parseSkillShortlistAnswers(probabilitiesPayload(undefined, 'skill-1'), buildPool(4)),
    [{ id: 'skill-1', probability: 1 }],
  );
  // Unknown choice name or absent everything → null.
  assert.equal(parseSkillShortlistAnswers(probabilitiesPayload({}, 'ghost'), buildPool(4)), null);
  assert.equal(parseSkillShortlistAnswers(probabilitiesPayload({}), buildPool(4)), null);
});

test('parseSkillShortlistAnswers: unusable payload shapes return null', () => {
  assert.equal(parseSkillShortlistAnswers(null, buildPool(2)), null);
  assert.equal(parseSkillShortlistAnswers('junk', buildPool(2)), null);
  assert.equal(parseSkillShortlistAnswers({ nope: 1 }, buildPool(2)), null);
  assert.equal(parseSkillShortlistAnswers({ answers: {} }, buildPool(2)), null);
  assert.equal(
    parseSkillShortlistAnswers({ answers: { [CEREBELLUM_SKILL_RANK_QUESTION_ID]: 'weird' } }, buildPool(2)),
    null,
  );
});

// ---------------------------------------------------------------------------
// rankSkillsWithCerebellum — verdict semantics and fail-open contract
// ---------------------------------------------------------------------------

test('rank: returns the sorted full ranking on success', async () => {
  const ranking = await rankSkillsWithCerebellum({
    ...RANK_INPUT,
    fetchImpl: okFetch(probabilitiesPayload({ 'skill-4': 0.9, 'skill-0': 0.1, 'skill-2': 0.5 })),
  });
  assert.deepEqual(ranking?.map((entry) => entry.id), ['skill-4', 'skill-2', 'skill-0']);
});

test('rank: request shape hits /v1/systemone with bearer auth, state and criteria', async () => {
  const captured = [];
  const skills = [
    ...SKILLS,
    ...buildPool(CEREBELLUM_SKILL_SHORTLIST_MIN_POOL).slice(3),
  ];
  await rankSkillsWithCerebellum({
    ...RANK_INPUT,
    skills,
    fetchImpl: okFetch(probabilitiesPayload({ 'ppt-maker': 1 }), captured),
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.state.current_message, RANK_INPUT.currentUserText);
  const question = captured[0].body.questions[CEREBELLUM_SKILL_RANK_QUESTION_ID];
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria), skills.map((skill) => skill.id));
  assert.match(question.criteria['ppt-maker'], /^ppt-maker: /);
});

test('rank: pools below CEREBELLUM_SKILL_SHORTLIST_MIN_POOL never leave the machine', async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => probabilitiesPayload({}) };
  };
  const ranking = await rankSkillsWithCerebellum({
    ...RANK_INPUT,
    skills: buildPool(CEREBELLUM_SKILL_SHORTLIST_MIN_POOL - 1),
    fetchImpl: counting,
  });
  assert.equal(ranking, null);
  assert.equal(calls, 0, 'small catalogs stay fully model-scannable (no cerebellum round-trip)');
});

test('rank: blank user text never leaves the machine', async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => probabilitiesPayload({}) };
  };
  assert.equal(
    await rankSkillsWithCerebellum({ ...RANK_INPUT, currentUserText: '   ', fetchImpl: counting }),
    null,
  );
  assert.equal(calls, 0);
});

test('rank: every failure mode returns null (fail-open) without throwing', async () => {
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await rankSkillsWithCerebellum({ ...RANK_INPUT, fetchImpl: http500 }), null);

  const throwing = async () => {
    throw new Error('network down');
  };
  assert.equal(await rankSkillsWithCerebellum({ ...RANK_INPUT, fetchImpl: throwing }), null);

  const malformedJson = async () => ({ ok: true, status: 200, json: async () => 'not-json' });
  assert.equal(await rankSkillsWithCerebellum({ ...RANK_INPUT, fetchImpl: malformedJson }), null);
});

test('rank: a hanging endpoint is aborted at the deadline', async () => {
  const hanging = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const startedAt = Date.now();
  assert.equal(
    await rankSkillsWithCerebellum({ ...RANK_INPUT, fetchImpl: hanging, timeoutMs: 25 }),
    null,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `abort deadline honored (took ${elapsed}ms)`);
  assert.equal(CEREBELLUM_SKILL_SHORTLIST_TIMEOUT_MS, 2500, 'default deadline aligned to 2.5s');
});

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

test('buildSkillShortlistBlock: renders only the top-K with a suggestion line and no probabilities', () => {
  const entries = buildPool(6).map((skill, index) => ({ ...skill, probability: 1 - index * 0.1 }));
  const block = buildSkillShortlistBlock(entries);
  assert.match(block, /^<skill_shortlist>\n/);
  assert.match(block, /\n<\/skill_shortlist>$/);
  const lines = block.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, CEREBELLUM_SKILL_SHORTLIST_TOP_K, 'only the top-K entries render');
  assert.match(lines[0], /^- `skill-0`: Capability number 0/);
  assert.match(block, /Suggested skill: `skill-0`\./);
  assert.doesNotMatch(block, /0\.9|probabilit/i, 'calibrated numbers never anchor the model');
  assert.match(block, /skill_tool read_skill/);
});

test('buildSkillShortlistBlock: collapses description whitespace in rendered lines', () => {
  const block = buildSkillShortlistBlock([
    { id: 'a', name: 'skill-a', description: 'line one\n\nline two', probability: 1 },
  ]);
  assert.match(block, /- `skill-a`: line one line two/);
});

// ---------------------------------------------------------------------------
// CoworkRunner integration (compiled dist; lightweight DI harness)
// ---------------------------------------------------------------------------

const CATALOG_TEXT = ['<available_skills>',
  '- `skill-a`: handles family A',
  '- `skill-b`: handles family B',
  '</available_skills>'].join('\n');

function createShortlistHarness({ ranker, catalogMode = 'volatile' }) {
  const rankerCalls = [];
  const store = {
    getMetabotIdForSession() {
      return 7;
    },
    // Recent-sessions pulse rides the same tail but has no bearing on the
    // skill shortlist under test — the stub keeps it empty.
    recentSessionPulse() {
      return [];
    },
    getSessionWithoutMessages() {
      return {};
    },
  };
  const runner = new CoworkRunner(store, {
    coworkSkillPromptsProvider: () => ({ catalog: CATALOG_TEXT, rules: null, sandboxSection: null }),
    // Merged turn-decision bundle (mock of the main.ts caller): the skill
    // ranking is consulted only when the session's catalog rides the tail,
    // exactly like the real caller honors skillsCatalogVolatile.
    cerebellumTurnDecisions: ranker
      ? async (input) => {
          let skillRanking = null;
          if (input.skillsCatalogVolatile) {
            rankerCalls.push(input);
            skillRanking = await ranker(input);
          }
          return {
            memoryScores: null,
            knowledgeScores: null,
            skillRanking,
            serviceRanking: null,
            gateVerdicts: null,
          };
        }
      : undefined,
  });
  runner.activeSessions.set('session-1', {
    skillsCatalogMode: catalogMode,
    claudeSessionId: 'sdk-gen-1',
  });
  const buildVolatile = (prompt) =>
    runner.buildVolatileContextPrompt('session-1', prompt, false, { includeMemoryPromptBlocks: false }, false);
  return { runner, rankerCalls, buildVolatile };
}

const SHORTLIST_QUERY = '帮我处理 A 类任务';

test('runner: the shortlist block rides next to the untouched catalog block', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    ranker: () => [
      { id: 'skill-a', name: 'skill-a', description: 'handles family A', probability: 0.9 },
      { id: 'skill-b', name: 'skill-b', description: 'handles family B', probability: 0.3 },
    ],
  });
  const output = await buildVolatile(SHORTLIST_QUERY);

  assert.equal(rankerCalls.length, 1, 'the ranker is consulted once per turn');
  assert.equal(rankerCalls[0].currentUserText, SHORTLIST_QUERY);
  assert.equal(rankerCalls[0].metabotId, 7);
  assert.ok(output.includes(CATALOG_TEXT), 'the byte-stable catalog block is untouched');
  assert.match(output, /<skill_shortlist>/);
  assert.match(output, /- `skill-a`: handles family A/);
  assert.match(output, /Suggested skill: `skill-a`\./);
});

test('runner: a null ranking reproduces the no-ranker output byte-for-byte', async () => {
  const withNull = createShortlistHarness({ ranker: () => null });
  const without = createShortlistHarness({ ranker: null });

  const outputNull = await withNull.buildVolatile(SHORTLIST_QUERY);
  const outputNone = await without.buildVolatile(SHORTLIST_QUERY);

  assert.equal(outputNull, outputNone, 'null ranking must reproduce the ungated baseline exactly');
  assert.ok(!outputNull.includes('<skill_shortlist>'));
});

test('runner: a throwing ranker falls back silently', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    ranker: () => {
      throw new Error('cerebellum exploded');
    },
  });
  const baseline = createShortlistHarness({ ranker: null });

  const output = await buildVolatile(SHORTLIST_QUERY);
  const outputBaseline = await baseline.buildVolatile(SHORTLIST_QUERY);

  assert.equal(rankerCalls.length, 1);
  assert.equal(output, outputBaseline, 'a throwing callback must never break the turn');
});

test('runner: a blank prompt never calls the ranker', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    ranker: () => [{ id: 'skill-a', name: 'skill-a', description: 'x', probability: 1 }],
  });
  await buildVolatile('   ');
  assert.equal(rankerCalls.length, 0);
});

test('runner: non-volatile catalog modes skip the ranker entirely', async () => {
  const { rankerCalls, buildVolatile } = createShortlistHarness({
    catalogMode: 'inline',
    ranker: () => [{ id: 'skill-a', name: 'skill-a', description: 'x', probability: 1 }],
  });
  const output = await buildVolatile(SHORTLIST_QUERY);
  assert.equal(rankerCalls.length, 0, 'inline/legacy sessions carry the catalog in the system prompt');
  assert.ok(!output.includes('<available_skills>'));
  assert.ok(!output.includes('<skill_shortlist>'));
});

test('runner: the rank call overlaps the memory rank (started before sections, awaited late)', async () => {
  // Ordering lock: the shortlist promise must START before the first section
  // builds (parallel with the memory re-ranker's own cerebellum round-trip)
  // and the turn must still render every block correctly.
  const events = [];
  const { buildVolatile } = createShortlistHarness({
    ranker: async () => {
      events.push('rank-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('rank-end');
      return [{ id: 'skill-a', name: 'skill-a', description: 'handles family A', probability: 0.9 }];
    },
  });
  events.push('volatile-start');
  await buildVolatile(SHORTLIST_QUERY);
  assert.equal(events[0], 'volatile-start');
  assert.equal(events[1], 'rank-start', 'the rank call fires immediately, not after the sections');
  assert.equal(events[events.length - 1], 'rank-end');
});
