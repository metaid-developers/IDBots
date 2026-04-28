import test from 'node:test';
import assert from 'node:assert/strict';

test('resolveCoworkModelLimits reads explicit provider model limits', async () => {
  const {
    resolveCoworkModelLimits,
  } = await import('../dist-electron/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: {
      defaultModel: 'deepseek-v4-pro',
      availableModels: [],
    },
    providers: {
      deepseek: {
        enabled: true,
        models: [
          {
            id: 'deepseek-v4-pro',
            contextWindow: 1_000_000,
            maxOutputTokens: 16_000,
          },
        ],
      },
    },
  });

  assert.deepEqual(limits, {
    modelId: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    source: 'provider-model',
  });
});

test('resolveCoworkModelLimits falls back conservatively for unknown models', async () => {
  const {
    DEFAULT_COWORK_CONTEXT_WINDOW,
    DEFAULT_COWORK_MAX_OUTPUT_TOKENS,
    resolveCoworkModelLimits,
  } = await import('../dist-electron/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: {
      defaultModel: 'custom-model',
      availableModels: [{ id: 'custom-model' }],
    },
    providers: {},
  });

  assert.deepEqual(limits, {
    modelId: 'custom-model',
    contextWindow: DEFAULT_COWORK_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_COWORK_MAX_OUTPUT_TOKENS,
    source: 'fallback',
  });
  assert.equal(DEFAULT_COWORK_CONTEXT_WINDOW, 128_000);
  assert.equal(DEFAULT_COWORK_MAX_OUTPUT_TOKENS, 8_192);
});

test('resolveCoworkModelLimits can use built-in DeepSeek V4 Pro defaults by model id', async () => {
  const {
    resolveCoworkModelLimits,
  } = await import('../dist-electron/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: {
      defaultModel: 'deepseek-v4-pro',
      availableModels: [],
    },
    providers: {},
  });

  assert.deepEqual(limits, {
    modelId: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    source: 'known-model',
  });
});
