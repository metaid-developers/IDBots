// Model catalog for model+effort pickers: dynamic provider listing
// (built-in AND custom-*) and brain-value resolution.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelGroupsFromConfig,
  resolveBrainModelInGroups,
  convertLegacyEffortLevel,
  LLM_EFFORT_DEFAULT_SENTINEL,
  effortDisplayForPick,
  effortForSessionStart,
} from '../src/renderer/services/modelCatalog';

const configWithCustomProvider = {
  providers: {
    deepseek: {
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    'custom-my-relay': {
      enabled: true,
      apiKey: 'rk-test',
      baseUrl: 'https://relay.example.com/v1',
      apiFormat: 'openai' as const,
      name: 'My Relay',
      models: [{ id: 'claude-sonnet-4-6' }],
    },
    openai: {
      enabled: true,
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-5.2' }],
    },
    ollama: {
      enabled: true,
      apiKey: '',
      baseUrl: 'http://localhost:11434',
      models: [{ id: 'llama3' }],
    },
    anthropic: {
      enabled: false,
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
      models: [{ id: 'claude-opus-4-6' }],
    },
  },
};

test('buildModelGroupsFromConfig lists custom providers and skips unusable ones', () => {
  const groups = buildModelGroupsFromConfig(configWithCustomProvider);
  assert.deepEqual(
    groups.map((g) => g.id),
    ['deepseek', 'custom-my-relay', 'ollama'],
  );
  const custom = groups.find((g) => g.id === 'custom-my-relay')!;
  assert.equal(custom.name, 'My Relay');
  assert.deepEqual(custom.models, [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' }]);
});

test('buildModelGroupsFromConfig falls back to a capitalized key without a provider name', () => {
  const groups = buildModelGroupsFromConfig(configWithCustomProvider);
  assert.equal(groups.find((g) => g.id === 'deepseek')!.name, 'Deepseek');
});

test('buildModelGroupsFromConfig shows the canonical free-provider label over the stored legacy name', () => {
  // Installs provisioned before the renames still store "MetaID Free" or
  // "IDBots-Free"; the picker group must render the canonical ID.Bots label
  // either way (the label is plan-neutral: the same provider serves every
  // subscription tier).
  const legacy = buildModelGroupsFromConfig({
    providers: {
      'metaid-free': {
        enabled: true,
        apiKey: 'mrk-test',
        baseUrl: 'https://relay.example/v1',
        apiFormat: 'openai' as const,
        name: 'MetaID Free',
        models: [{ id: 'deepseek-chat', name: 'deepseek-v4-flash' }],
      },
    },
  });
  assert.equal(legacy[0].name, 'ID.Bots');

  const prior = buildModelGroupsFromConfig({
    providers: {
      'metaid-free': {
        enabled: true,
        apiKey: 'mrk-test',
        baseUrl: 'https://relay.example/v1',
        apiFormat: 'openai' as const,
        name: 'IDBots-Free',
        models: [{ id: 'deepseek-chat', name: 'deepseek-v4-flash' }],
      },
    },
  });
  assert.equal(prior[0].name, 'ID.Bots');

  const fresh = buildModelGroupsFromConfig({
    providers: {
      'metaid-free': {
        enabled: true,
        apiKey: 'mrk-test',
        baseUrl: 'https://relay.example/v1',
        apiFormat: 'openai' as const,
        name: 'ID.Bots',
        models: [{ id: 'deepseek-chat', name: 'deepseek-v4-flash' }],
      },
    },
  });
  assert.equal(fresh[0].name, 'ID.Bots');
});

test('buildModelGroupsFromConfig skips providers without models', () => {
  const groups = buildModelGroupsFromConfig({
    providers: { deepseek: { enabled: true, apiKey: 'k', baseUrl: 'u', models: [] } },
  });
  assert.equal(groups.length, 0);
});

test('resolveBrainModelInGroups prefers the provider hint when OpenCode and DeepSeek share a model id', () => {
  const groups = buildModelGroupsFromConfig({
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      },
      opencode: {
        enabled: true,
        apiKey: 'sk-oc',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        name: 'OpenCode',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      },
    },
  });

  const byOrder = resolveBrainModelInGroups(groups, 'deepseek-v4-flash');
  assert.equal(byOrder!.providerKey, 'deepseek', 'without a hint, catalog order wins');

  const hinted = resolveBrainModelInGroups(groups, 'deepseek-v4-flash', 'opencode');
  assert.equal(hinted!.providerKey, 'opencode');
  assert.equal(hinted!.model.id, 'deepseek-v4-flash');
});

test('resolveBrainModelInGroups matches exact model ids and prefers the provider hint', () => {
  const groups = buildModelGroupsFromConfig(configWithCustomProvider);
  const hit = resolveBrainModelInGroups(groups, 'deepseek-v4-pro');
  assert.deepEqual(hit, { providerKey: 'deepseek', model: { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' } });

  // Same model id could exist under multiple providers; the hint disambiguates.
  const hinted = resolveBrainModelInGroups(
    [{ id: 'a', name: 'A', models: [{ id: 'x', name: 'X' }] }, { id: 'b', name: 'B', models: [{ id: 'x', name: 'X' }] }],
    'x',
    'b',
  );
  assert.equal(hinted!.providerKey, 'b');
});

test('resolveBrainModelInGroups resolves legacy provider-key brains to the default model', () => {
  const groups = buildModelGroupsFromConfig(configWithCustomProvider);
  // Global default model served by the provider wins.
  const viaGlobal = resolveBrainModelInGroups(groups, 'deepseek', null, 'deepseek-v4-pro');
  assert.equal(viaGlobal!.model.id, 'deepseek-v4-pro');
  // Otherwise the provider's first model.
  const viaFirst = resolveBrainModelInGroups(groups, 'deepseek', null, 'gpt-5.2');
  assert.equal(viaFirst!.model.id, 'deepseek-v4-flash');
});

test('resolveBrainModelInGroups returns null for unknown values', () => {
  const groups = buildModelGroupsFromConfig(configWithCustomProvider);
  assert.equal(resolveBrainModelInGroups(groups, 'nope'), null);
  assert.equal(resolveBrainModelInGroups(groups, null), null);
  assert.equal(resolveBrainModelInGroups(groups, '  '), null);
});

test('convertLegacyEffortLevel mirrors the main-process ladder', () => {
  assert.equal(convertLegacyEffortLevel(null), null);
  assert.equal(convertLegacyEffortLevel('off'), 'off');
  assert.equal(convertLegacyEffortLevel('low'), 'low');
  assert.equal(convertLegacyEffortLevel('medium'), 'low');
  assert.equal(convertLegacyEffortLevel('high'), 'high');
  assert.equal(convertLegacyEffortLevel('max'), 'max');
  assert.equal(convertLegacyEffortLevel('minimal'), 'off');
  assert.equal(convertLegacyEffortLevel('xhigh'), 'max');
  // The explicit-Default sentinel converts to null (model default) for display.
  assert.equal(convertLegacyEffortLevel(LLM_EFFORT_DEFAULT_SENTINEL), null);
  assert.equal(convertLegacyEffortLevel('default'), null);
});

test('effortDisplayForPick keeps an explicit pick and resolves fallbacks only when unpicked', () => {
  // Explicit Default pick sticks — it must not snap to the brain/global rung.
  assert.equal(effortDisplayForPick({ modelId: 'm', effort: null }, ['max', 'high']), null);
  // Explicit rung pick sticks.
  assert.equal(effortDisplayForPick({ modelId: 'm', effort: 'low' }, ['max']), 'low');
  // No pick at all: first valid fallback rung wins (brain, then global).
  assert.equal(effortDisplayForPick(null, ['max', 'high']), 'max');
  assert.equal(effortDisplayForPick(null, [null, 'high']), 'high');
  assert.equal(effortDisplayForPick(null, [null, null]), null);
  assert.equal(effortDisplayForPick(null, []), null);
  // Legacy brain tokens convert at the boundary.
  assert.equal(effortDisplayForPick(null, ['medium', null]), 'low');
});

test('effortForSessionStart carries an explicit Default pick as the sentinel', () => {
  // No pick: undefined keeps the main-process tiered defaults.
  assert.equal(effortForSessionStart(null), undefined);
  assert.equal(effortForSessionStart(undefined), undefined);
  // Explicit rung picks pass through.
  assert.equal(effortForSessionStart({ modelId: 'm', effort: 'low' }), 'low');
  assert.equal(effortForSessionStart({ modelId: null, effort: 'max' }), 'max');
  // Explicit Default pick becomes the 'default' sentinel.
  assert.equal(effortForSessionStart({ modelId: 'm', effort: null }), LLM_EFFORT_DEFAULT_SENTINEL);
  assert.equal(effortForSessionStart({ modelId: 'm', effort: null }), 'default');
});
