import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultOnboardingProvider } from '../src/renderer/components/onboarding/onboardingDefaults.js';

test('onboarding defaults to DeepSeek for Chinese UI', () => {
  assert.equal(getDefaultOnboardingProvider('zh'), 'deepseek');
});

test('onboarding defaults to OpenAI for English UI', () => {
  assert.equal(getDefaultOnboardingProvider('en'), 'openai');
});
