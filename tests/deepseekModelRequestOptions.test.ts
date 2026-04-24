import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAICompatibleModelRequestOptions } from '../src/renderer/services/modelRequestOptions.ts';

test('buildOpenAICompatibleModelRequestOptions maps DeepSeek model options to official request fields', () => {
  assert.deepEqual(
    buildOpenAICompatibleModelRequestOptions('deepseek', {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    }),
    {
      reasoning_effort: 'max',
      thinking: { type: 'enabled' },
    },
  );
});

test('buildOpenAICompatibleModelRequestOptions ignores DeepSeek-only options for other providers', () => {
  assert.deepEqual(
    buildOpenAICompatibleModelRequestOptions('openai', {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    }),
    {},
  );
});
