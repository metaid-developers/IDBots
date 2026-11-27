/**
 * Unit tests for modelThinking — the single source of truth mapping model ids
 * onto thinking/reasoning wire controls and output budgets. Born from the
 * 2026-09-20 dream-fragment outage: every layer guessed "thinking off means
 * the model won't think"; GLM-5.x always thinks and the zhipu responses
 * conversion dropped the toggle, so hidden reasoning burned the whole 4096
 * token fragment budget (stop_reason=max_tokens, blocks=none).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  thinkingWireFamily,
  modelAlwaysThinks,
  modelCannotExpressOff,
  responsesEffortForThinkingOff,
  budgetAssumesThinking,
} = await import('../dist-electron/main/libs/modelThinking.js');

test('thinkingWireFamily resolves by model id, gateway prefixes tolerated', () => {
  assert.equal(thinkingWireFamily('deepseek-flash'), 'deepseek');
  assert.equal(thinkingWireFamily('deepseek/deepseek-v4.1-flash'), 'deepseek');
  assert.equal(thinkingWireFamily('glm-5.3-flash'), 'glm');
  assert.equal(thinkingWireFamily('z-ai/glm-5.3-flash'), 'glm');
  assert.equal(thinkingWireFamily('zai-org/GLM-5.3'), 'glm');
  assert.equal(thinkingWireFamily('glm-4.7'), 'glm');
  assert.equal(thinkingWireFamily('kimi-k2.6'), 'unknown');
  assert.equal(thinkingWireFamily('some-brand-new-model'), 'unknown');
  assert.equal(thinkingWireFamily(''), 'unknown');
  assert.equal(thinkingWireFamily(null), 'unknown');
});

test('modelAlwaysThinks marks GLM-5+ and nothing else', () => {
  // Official docs (2026-09): GLM-5.x rejects every off control with 400 code
  // 1210 「该模型始终思考，不支持关闭思考」.
  assert.equal(modelAlwaysThinks('glm-5.3-flash'), true);
  assert.equal(modelAlwaysThinks('glm-5.3'), true);
  assert.equal(modelAlwaysThinks('glm-5.2-fast'), true);
  assert.equal(modelAlwaysThinks('zai-org/GLM-5.3'), true);
  assert.equal(modelAlwaysThinks('glm-4.7'), false);
  assert.equal(modelAlwaysThinks('glm-4.5-air'), false);
  assert.equal(modelAlwaysThinks('deepseek-flash'), false);
  assert.equal(modelAlwaysThinks('brand-new-model'), false);
});

test('responsesEffortForThinkingOff maps off per family dialect', () => {
  // DeepSeek: explicit none disables thinking.
  assert.equal(responsesEffortForThinkingOff('deepseek-flash'), 'none');
  // GLM-4.x honors none; GLM-5+ cannot disable — lowest tier instead.
  assert.equal(responsesEffortForThinkingOff('glm-4.7'), 'none');
  assert.equal(responsesEffortForThinkingOff('glm-5.3-flash'), 'low');
  assert.equal(responsesEffortForThinkingOff('z-ai/glm-5.2'), 'low');
  // Unknown family: null → omit the field (no dialect to express off).
  assert.equal(responsesEffortForThinkingOff('kimi-k2.6'), null);
  assert.equal(responsesEffortForThinkingOff(''), null);
});

test('budgetAssumesThinking is conservative: only proven-off brains get the lean budget', () => {
  // Disable-capable families with an explicit disabled toggle → thinking off.
  assert.equal(budgetAssumesThinking('deepseek-flash', 'disabled'), false);
  assert.equal(budgetAssumesThinking('glm-4.7', 'disabled'), false);
  // Always-thinking models think no matter what was requested.
  assert.equal(budgetAssumesThinking('glm-5.3-flash', 'disabled'), true);
  // Unknown families: off cannot be expressed → assume thinking.
  assert.equal(budgetAssumesThinking('brand-new-model', 'disabled'), true);
  assert.equal(budgetAssumesThinking(null, 'disabled'), true);
  // Enabled or model-default (undefined) → assume thinking everywhere.
  assert.equal(budgetAssumesThinking('deepseek-flash', 'enabled'), true);
  assert.equal(budgetAssumesThinking('deepseek-flash', undefined), true);
  assert.equal(budgetAssumesThinking('glm-4.7', undefined), true);
});

test('modelCannotExpressOff floors unknown and always-thinking families', () => {
  // Unknown families: no dialect declared → dsh-llm materializes reasoning:false
  // and its capability gate rejects 'off' before provider I/O (2026-11-26
  // gemini-4-hydrogen custom-route auto-effort failure). Must floor to 'low'.
  assert.equal(modelCannotExpressOff('gemini-4-hydrogen'), true);
  assert.equal(modelCannotExpressOff('vendor/gemini-4-hydrogen'), true);
  assert.equal(modelCannotExpressOff('kimi-k2.6'), true);
  assert.equal(modelCannotExpressOff('brand-new-model'), true);
  // Always-thinking GLM-5+: every off control is rejected upstream.
  assert.equal(modelCannotExpressOff('glm-5.3-flash'), true);
  assert.equal(modelCannotExpressOff('z-ai/glm-5.2'), true);
  // Disable-capable families express 'off' honestly.
  assert.equal(modelCannotExpressOff('deepseek-flash'), false);
  assert.equal(modelCannotExpressOff('deepseek/deepseek-v4.1-flash'), false);
  assert.equal(modelCannotExpressOff('glm-4.7'), false);
  assert.equal(modelCannotExpressOff(null), true); // unknown by default
});
