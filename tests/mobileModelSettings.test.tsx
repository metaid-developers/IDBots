import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import { ModelPage } from '../src/mobile/app/screens/me/ModelPage.tsx';
import {
  MOBILE_PROVIDER_PRESETS,
  buildMobileModelPatch,
  customProviderKey,
  defaultModelSummary,
  saveMobileModelSelection,
  validateMobileModelSelection,
  type MobileModelConfig,
  type MobileModelSelection,
} from '../src/mobile/app/services/modelSettings.ts';

const baseConfig: MobileModelConfig = {
  providers: {
    idbots: {
      enabled: true,
      apiKey: '__redacted__',
      baseUrl: 'https://relay.example',
      apiFormat: 'openai',
      name: 'ID.Bots',
      models: [{ id: 'official-model', name: 'Official model' }],
    },
    deepseek: {
      enabled: false,
      apiKey: '__redacted__',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
    },
  },
  model: { defaultProvider: 'idbots', defaultModel: 'official-model' },
};

const customSelection = (overrides: Partial<MobileModelSelection> = {}): MobileModelSelection => ({
  providerKey: 'custom-test',
  providerName: 'Test provider',
  apiKey: 'test-key',
  baseUrl: 'https://models.example/v1',
  apiFormat: 'openai',
  modelId: 'test-model',
  models: [{ id: 'test-model', name: 'Test model' }],
  ...overrides,
});

test('mobile model presets cover mainstream providers and custom keys are stable and unique', () => {
  const templateIds = MOBILE_PROVIDER_PRESETS.map((template) => template.templateId);
  for (const expected of ['deepseek', 'moonshot-kimi', 'openai', 'anthropic', 'openrouter']) {
    assert.ok(templateIds.includes(expected), expected);
  }
  assert.equal(customProviderKey('My Test Provider!', baseConfig), 'custom-my-test-provider');
  assert.equal(
    customProviderKey('Test', { providers: { 'custom-test': baseConfig.providers!.deepseek } }),
    'custom-test-2',
  );
});

test('custom provider save preserves existing providers and changes only the global default route', () => {
  const patch = buildMobileModelPatch(baseConfig, customSelection());
  assert.equal(patch.model.defaultProvider, 'custom-test');
  assert.equal(patch.model.defaultModel, 'test-model');
  assert.equal(patch.providers?.['custom-test']?.apiKey, 'test-key');
  assert.equal(patch.providers?.['custom-test']?.enabled, true);
  assert.equal(patch.providers?.idbots?.apiKey, '__redacted__');
  assert.equal(patch.providers?.idbots?.baseUrl, 'https://relay.example');
  assert.equal(patch.providers?.deepseek?.enabled, false);
  assert.deepEqual(defaultModelSummary({ ...baseConfig, ...patch }, 'en'), {
    providerName: 'Test provider',
    modelName: 'Test model',
    providerKey: 'custom-test',
  });
});

test('existing provider edits preserve a redacted key when blank and replace it only with a new key', () => {
  const kept = buildMobileModelPatch(baseConfig, customSelection({
    providerKey: 'deepseek',
    providerName: 'DeepSeek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiFormat: 'anthropic',
    modelId: 'deepseek-flash',
    models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
  }));
  assert.equal(kept.providers?.deepseek?.apiKey, '__redacted__');
  assert.equal(kept.providers?.deepseek?.apiFormat, 'anthropic');

  const replaced = buildMobileModelPatch(baseConfig, customSelection({
    providerKey: 'deepseek',
    apiKey: 'replacement-test-key',
  }));
  assert.equal(replaced.providers?.deepseek?.apiKey, 'replacement-test-key');
});

test('official model selection never rewrites relay connection fields', () => {
  const patch = buildMobileModelPatch(baseConfig, customSelection({
    providerKey: 'idbots',
    providerName: 'ID.Bots',
    apiKey: 'must-not-be-written',
    baseUrl: 'https://evil.example',
    apiFormat: 'anthropic',
    modelId: 'official-model',
    models: [{ id: 'official-model', name: 'Official model' }],
  }));
  assert.equal(patch.providers?.idbots?.apiKey, '__redacted__');
  assert.equal(patch.providers?.idbots?.baseUrl, 'https://relay.example');
  assert.equal(patch.providers?.idbots?.apiFormat, 'openai');
  assert.equal(patch.model.defaultProvider, 'idbots');
});

test('validation gives specific form errors without exposing credential values', () => {
  assert.equal(validateMobileModelSelection(baseConfig, customSelection()), null, 'new custom key is present');
  assert.equal(validateMobileModelSelection(baseConfig, customSelection({ providerKey: 'custom-new', apiKey: '' })), 'apiKeyRequired');
  assert.equal(validateMobileModelSelection(baseConfig, customSelection({ providerKey: 'custom-new', providerName: '' })), 'nameRequired');
  assert.equal(validateMobileModelSelection(baseConfig, customSelection({ baseUrl: 'file:///tmp/key' })), 'baseUrlInvalid');
  assert.equal(validateMobileModelSelection(baseConfig, customSelection({ modelId: '' })), 'modelRequired');
  assert.equal(validateMobileModelSelection(baseConfig, customSelection({ providerKey: 'deepseek', apiKey: '' })), null);
});

test('saveMobileModelSelection round-trips through the mobile bridge and confirms the default', async (t) => {
  const bridge = createMobileMockBridge({ systemLocale: 'en-US' });
  Object.assign(globalThis, { window: { electron: bridge.electron } });
  t.after(() => bridge.destroy());

  const result = await saveMobileModelSelection(customSelection());
  assert.equal(result.providerKey, 'custom-test');
  assert.equal(result.modelId, 'test-model');
  const stored = await bridge.electron.store.get('app_config');
  assert.equal(stored.model.defaultProvider, 'custom-test');
  assert.equal(stored.providers['custom-test'].apiKey, 'test-key');
  assert.equal(stored.providers.idbots.baseUrl, 'https://mock.invalid/relay');
});

test('ModelPage SSR starts with a localized loading shell and never embeds a saved key', () => {
  const html = renderToStaticMarkup(React.createElement(ModelPage, { onBack: () => undefined }));
  assert.match(html, /data-testid="me-page-model"/);
  assert.match(html, /data-testid="model-loading"/);
  assert.doesNotMatch(html, /__redacted__|test-key|fixture-relay-key/);
});
