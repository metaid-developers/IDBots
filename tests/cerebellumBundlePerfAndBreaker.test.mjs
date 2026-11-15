import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  selectTurnDecisionCandidates,
  buildTurnDecisionRequest,
  parseTurnDecisionAnswers,
} = require('../dist-electron/main/cerebellum/turnDecisionBundle.js');
const {
  createJevRelayCallRecorder,
  isJevRelayTimeoutCircuitOpen,
  doesJevRelaySupportTemplates,
  resetJevRelayCallStatsForTests,
} = require('../dist-electron/main/services/jevRelayService.js');

test('turnDecisionBundle bounds heavy veteran pools to <= 20 KB, coalesces effort_level, and supports compact question_templates', () => {
  const bigDecisions = {
    currentUserText: '请帮我优化 SQLite 索引并检查 MetaBot 服务订单性能 ' + '细节补充 '.repeat(400),
    memories: Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`,
      text: `${i === 45 ? 'SQLite 索引优化经验 ' : '日常对话记录 '}${'长文本内容'.repeat(120)}`,
    })),
    knowledge: Array.from({ length: 60 }, (_, i) => ({
      id: `k-${i}`,
      topic: i === 50 ? 'SQLite WAL 性能' : `主题 ${i}`,
      summary: '知识摘要细节 '.repeat(100),
      kind: 'know_how',
    })),
    skills: Array.from({ length: 80 }, (_, i) => ({
      id: `skill-${i}`,
      name: i === 70 ? 'sqlite-perf-audit' : `skill-${i}`,
      description: 'Skill description text '.repeat(30),
    })),
    services: Array.from({ length: 50 }, (_, i) => ({
      id: `svc-${i}`,
      name: i === 42 ? 'MetaBot 服务订单审计' : `svc-${i}`,
      description: 'Remote service description '.repeat(30),
    })),
    includeGate: true,
    includeEffort: true,
  };

  const selection = selectTurnDecisionCandidates(bigDecisions);
  assert.ok(selection);
  assert.ok(selection.memories.length <= 16);
  assert.ok(selection.knowledge.length <= 16);
  assert.ok(selection.skills.length <= 24);
  assert.ok(selection.services.length <= 20);
  assert.ok(selection.knowledge.some((k) => k.id === 'k-50'), 'lexical pre-rank promotes matching older knowledge');
  assert.ok(selection.skills.some((s) => s.id === 'skill-70'), 'lexical pre-rank promotes matching skill');
  assert.ok(selection.services.some((s) => s.id === 'svc-42'), 'lexical pre-rank promotes matching service');

  const standardReq = buildTurnDecisionRequest({ selection, model: 'jev-latest' });
  const standardJson = JSON.stringify(standardReq);
  assert.ok(standardJson.length < 35_000, `expected bounded standard payload < 35 KB, got ${standardJson.length}`);
  assert.ok(standardReq.questions.effort_level, 'coalesced effort_level question included');

  const templatedReq = buildTurnDecisionRequest({
    selection,
    model: 'jev-latest',
    useQuestionTemplates: true,
  });
  const templatedJson = JSON.stringify(templatedReq);
  assert.ok(templatedReq.question_templates?.mem);
  assert.ok(templatedReq.question_templates?.kn);
  assert.deepEqual(templatedReq.questions.mem_0, { $tpl: 'mem', index: 0 });
  assert.ok(templatedJson.length < 22_000, `expected templated payload < 22 KB, got ${templatedJson.length}`);
  assert.ok(templatedJson.length < standardJson.length - 8_000, 'question_templates must shrink wire JSON substantially');

  const answers = { effort_level: { probabilities: { off: 0.05, low: 0.1, high: 0.8, max: 0.05 } } };
  const parsed = parseTurnDecisionAnswers({ answers }, selection);
  assert.equal(parsed.effortDistribution?.high, 0.8);
});

test('jevRelayService opens a 90s circuit breaker after 3 consecutive timeouts and detects templates-v1 capability', async () => {
  resetJevRelayCallStatsForTests();
  try {
    let nowMs = 1_000_000;
    const timeoutRecorder = createJevRelayCallRecorder(
      async () => {
        const err = new Error('timed out');
        err.name = 'AbortError';
        throw err;
      },
      { now: () => nowMs },
    );

    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(() => timeoutRecorder('https://relay.example/v1/systemone', {}));
      assert.equal(isJevRelayTimeoutCircuitOpen(nowMs), false);
    }
    await assert.rejects(() => timeoutRecorder('https://relay.example/v1/systemone', {}));
    assert.equal(isJevRelayTimeoutCircuitOpen(nowMs), true, '3rd consecutive timeout opens breaker');
    assert.equal(isJevRelayTimeoutCircuitOpen(nowMs + 91_000), false, 'breaker auto-recovers after 90s');

    assert.equal(doesJevRelaySupportTemplates(), false);
    const okRecorder = createJevRelayCallRecorder(
      async () => ({
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'x-jev-capabilities' ? 'templates-v1,deadline-v1' : null) },
        json: async () => ({ answers: {} }),
      }),
      { now: () => nowMs + 100_000 },
    );
    await okRecorder('https://relay.example/v1/systemone', {});
    assert.equal(doesJevRelaySupportTemplates(), true);
    assert.equal(isJevRelayTimeoutCircuitOpen(nowMs + 100_000), false);
  } finally {
    resetJevRelayCallStatsForTests();
  }
});
