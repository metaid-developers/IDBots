import test from 'node:test';
import assert from 'node:assert/strict';

let claudeSettings;
try {
  claudeSettings = await import('../dist-electron/main/libs/claudeSettings.js');
} catch {
  claudeSettings = await import('../dist-electron/libs/claudeSettings.js');
}

const { resolveApiConfigForModel, setStoreGetter } = claudeSettings;

function withAppConfig(appConfig, fn) {
  setStoreGetter(() => ({
    get(key) {
      return key === 'app_config' ? appConfig : null;
    },
  }));
  try {
    return fn();
  } finally {
    setStoreGetter(() => null);
  }
}

test('DeepSeek provider key resolves to V4 Flash for MetaBot automation', () => {
  const result = withAppConfig({
    model: {
      defaultModel: 'deepseek-v4-pro',
      availableModels: [],
    },
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: [
          { id: 'deepseek-v4-flash' },
          { id: 'deepseek-v4-pro' },
        ],
      },
    },
  }, () => resolveApiConfigForModel('deepseek'));

  assert.equal(result.error, undefined);
  assert.equal(result.config?.model, 'deepseek-v4-flash');
});

test('non-DeepSeek provider key keeps existing provider-default resolution', () => {
  const result = withAppConfig({
    model: {
      defaultModel: 'qwen3-coder-plus',
      availableModels: [],
    },
    providers: {
      qwen: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        apiFormat: 'anthropic',
        models: [
          { id: 'qwen3.5-plus' },
          { id: 'qwen3-coder-plus' },
        ],
      },
    },
  }, () => resolveApiConfigForModel('qwen'));

  assert.equal(result.error, undefined);
  assert.equal(result.config?.model, 'qwen3-coder-plus');
});
