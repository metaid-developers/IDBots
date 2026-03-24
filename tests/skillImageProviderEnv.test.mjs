import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('prefers current metabot provider mapping before global fallback providers', () => {
  const { buildImageSkillEnvOverrides } = require('../dist-electron/libs/skillImageProviderEnv.js');

  const env = buildImageSkillEnvOverrides({
    activeSkillIds: ['baoyu-image-studio'],
    metabotLlmId: 'gemini',
    appConfig: {
      providers: {
        gemini: {
          enabled: true,
          apiKey: 'g-key',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          models: [],
        },
        openai: {
          enabled: true,
          apiKey: 'o-key',
          baseUrl: 'https://api.openai.com',
          models: [],
        },
      },
    },
    processEnv: {},
  });

  assert.equal(env.BAOYU_IMAGE_PROVIDER, 'google');
  assert.equal(env.GOOGLE_API_KEY, 'g-key');
  assert.equal(env.GEMINI_API_KEY, 'g-key');
  assert.equal(env.GOOGLE_IMAGE_MODEL, 'gemini-3-pro-image-preview');
});

test('returns empty overrides when explicit active skills do not include baoyu-image-studio', () => {
  const { buildImageSkillEnvOverrides } = require('../dist-electron/libs/skillImageProviderEnv.js');

  const env = buildImageSkillEnvOverrides({
    activeSkillIds: ['superpowers-writing-plans'],
    metabotLlmId: 'openai',
    appConfig: {
      providers: {
        openai: {
          enabled: true,
          apiKey: 'o-key',
          baseUrl: 'https://api.openai.com',
          models: [],
        },
      },
    },
    processEnv: {},
  });

  assert.deepEqual(env, {});
});

test('treats unfiltered sessions as skill-eligible and falls back to configured bridge providers', () => {
  const { buildImageSkillEnvOverrides } = require('../dist-electron/libs/skillImageProviderEnv.js');

  const env = buildImageSkillEnvOverrides({
    activeSkillIds: [],
    metabotLlmId: 'anthropic',
    appConfig: {
      providers: {
        openrouter: {
          enabled: true,
          apiKey: 'router-key',
          baseUrl: 'https://openrouter.ai/api',
          models: [],
        },
      },
    },
    processEnv: {},
  });

  assert.equal(env.BAOYU_IMAGE_PROVIDER, 'openrouter');
  assert.equal(env.OPENROUTER_API_KEY, 'router-key');
  assert.equal(env.OPENROUTER_IMAGE_MODEL, 'google/gemini-3.1-flash-image-preview');
});

test('falls back to env-only providers when no bridge provider is available', () => {
  const { buildImageSkillEnvOverrides } = require('../dist-electron/libs/skillImageProviderEnv.js');

  const env = buildImageSkillEnvOverrides({
    activeSkillIds: ['baoyu-image-studio'],
    metabotLlmId: 'anthropic',
    appConfig: { providers: {} },
    processEnv: {
      ARK_API_KEY: 'ark-key',
    },
  });

  assert.equal(env.BAOYU_IMAGE_PROVIDER, 'seedream');
  assert.equal(env.SEEDREAM_IMAGE_MODEL, 'doubao-seedream-5-0-260128');
});
