import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { createLiveStageState, reduceLiveStageMessage } = require('../dist-electron/main/services/studioLiveStageModel.js');
const { validateLiveStageDirectorScene, directLiveStageScene } = require('../dist-electron/main/services/studioLiveStageDirector.js');

const state = () => createLiveStageState({ sessionId: 's', turnId: 't', botName: 'AI_Sunny', language: 'en' });
const valid = () => JSON.stringify({
  headline: 'Checking the evidence',
  caption: 'The returned claim is being compared with original records.',
  composition: 'converge',
  motif: 'proof-loop',
  motion: { preset: 'proof-loop', seed: 18427, durationMs: 760, easing: 'gentle-spring', energy: .55, density: .35 },
});

test('Director accepts a bounded creative patch and preserves topology requirements', () => {
  let current = state();
  current = reduceLiveStageMessage(current, { id: 'w', type: 'tool_use', content: '', timestamp: 1, metadata: { toolName: 'local_worker_delegate' } });
  const scene = validateLiveStageDirectorScene(valid(), current);
  assert.equal(scene.composition, 'converge');
  assert.equal(scene.motion.seed, 18427);
  assert.equal(current.headline, 'Delegating structured work', 'validation does not mutate the trusted state');
});

test('Director rejects invented topology, terminal readiness, and malformed motion', () => {
  const current = state();
  assert.throws(() => validateLiveStageDirectorScene(JSON.stringify({ ...JSON.parse(valid()), composition: 'topology' }), current), /invented topology/);
  assert.throws(() => validateLiveStageDirectorScene(JSON.stringify({ ...JSON.parse(valid()), composition: 'ready' }), current), /invented terminal readiness/);
  assert.throws(() => validateLiveStageDirectorScene(JSON.stringify({ ...JSON.parse(valid()), motion: { preset: 'bad space', seed: 1, durationMs: 20, easing: 'linear', energy: 4, density: -1 } }), current));
  assert.throws(() => validateLiveStageDirectorScene('not json', current));
});

test('Director uses bounded state and returns real provider token metadata', async () => {
  const current = state();
  let captured;
  const result = await directLiveStageScene(current, { llmId: 'brain', llmProvider: 'test' }, async (messages, options) => {
    captured = { messages, options };
    return {
      content: valid(),
      responseMetadata: { apiType: 'openai', inputTokens: 1200, outputTokens: 240, cacheReadTokens: 700, cacheCreationTokens: 500 },
    };
  }, (() => {
    const times = [1000, 1250];
    return () => times.shift() ?? 1250;
  })());
  assert.equal(captured.options.webSearch, false);
  assert.equal(captured.options.effort, 'off');
  assert.equal(captured.options.maxTokens, 700);
  assert.equal(result.usage.latencyMs, 250);
  assert.equal(result.usage.inputTokens, 1200);
  assert.equal(result.usage.cacheReadTokens, 700);
  assert.equal(result.usage.cacheCreationTokens, 500);
  assert.equal(captured.messages[0].role, 'system');
  assert.doesNotMatch(captured.messages[1].content, /raw reasoning|full transcript/);
});
