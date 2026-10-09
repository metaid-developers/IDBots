import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig, normalizeDeepSeekAppConfig } from '../src/renderer/config.ts';
import { mergeProvidersConfig } from '../src/renderer/services/config.ts';

const legacyAvailableModels = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
];

const legacyProviderModels = [
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
];

test('defaultConfig uses DeepSeek V4.1 Flash and V4 Pro as the built-in DeepSeek defaults', () => {
  assert.deepEqual(
    defaultConfig.model.availableModels.map(({ id, name }) => ({ id, name })),
    [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  );
  assert.equal(defaultConfig.model.defaultModel, 'deepseek-flash');
  // V4.1 Flash is natively multimodal — the retired vision-exp SKU folded in.
  assert.equal(
    defaultConfig.model.availableModels.find(({ id }) => id === 'deepseek-flash')?.supportsImage,
    true,
  );
  assert.deepEqual(
    defaultConfig.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  );
  assert.equal(
    defaultConfig.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.contextWindow,
    1_000_000,
  );
  assert.equal(
    defaultConfig.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.maxOutputTokens,
    32_768,
  );
  assert.deepEqual(
    defaultConfig.providers?.deepseek.models?.map(({ id, name }) => ({ id, name })),
    [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  );
  assert.equal(
    defaultConfig.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-flash')?.supportsImage,
    true,
  );
  assert.deepEqual(
    defaultConfig.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  );
  assert.equal(
    defaultConfig.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.contextWindow,
    1_000_000,
  );
  assert.equal(
    defaultConfig.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.maxOutputTokens,
    32_768,
  );
});

test('normalizeDeepSeekAppConfig migrates legacy DeepSeek defaults in stored config', () => {
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: legacyAvailableModels,
      defaultModel: 'deepseek-chat',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        models: legacyProviderModels,
      },
    },
  });

  assert.equal(normalized.model.defaultModel, 'deepseek-flash');
  assert.deepEqual(
    normalized.model.availableModels.map(({ id }) => id),
    ['deepseek-flash', 'deepseek-v4-pro'],
  );
  assert.deepEqual(
    normalized.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  );
  assert.equal(
    normalized.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.contextWindow,
    1_000_000,
  );
  assert.equal(
    normalized.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.maxOutputTokens,
    32_768,
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.map(({ id }) => id),
    ['deepseek-flash', 'deepseek-v4-pro'],
  );
  assert.equal(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-flash')?.supportsImage,
    true,
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  );
  assert.equal(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.contextWindow,
    1_000_000,
  );
  assert.equal(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.maxOutputTokens,
    32_768,
  );
});

test('normalizeDeepSeekAppConfig upgrades legacy ids without dropping custom DeepSeek models', () => {
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: [
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
        { id: 'deepseek-r1-custom', name: 'DeepSeek R1 Custom', supportsImage: false },
      ],
      defaultModel: 'deepseek-reasoner',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
        ],
      },
    },
  });

  assert.equal(normalized.model.defaultModel, 'deepseek-v4-pro');
  assert.deepEqual(
    normalized.model.availableModels.map(({ id }) => id),
    ['deepseek-v4-pro', 'deepseek-r1-custom'],
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.map(({ id }) => id),
    ['deepseek-flash', 'deepseek-v4-pro'],
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  );
});

test('normalizeDeepSeekAppConfig migrates a stored V4-era Flash+Pro catalog to the renamed flash id', () => {
  // The 0.1.x default pair deepseek-v4-flash + deepseek-v4-pro predates the
  // 2026-09-10 V4.1 rename: normalization folds the retired v4-flash id into
  // deepseek-flash (which is natively multimodal) and appends nothing.
  const storedPair = [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false },
  ];
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: storedPair,
      defaultModel: 'deepseek-v4-flash',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        models: storedPair,
      },
    },
  });

  assert.deepEqual(
    normalized.model.availableModels.map(({ id }) => id),
    ['deepseek-flash', 'deepseek-v4-pro'],
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.map(({ id }) => id),
    ['deepseek-flash', 'deepseek-v4-pro'],
  );
  assert.equal(normalized.model.defaultModel, 'deepseek-flash');
  assert.equal(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-flash')?.supportsImage,
    true,
  );
});

test('normalizeDeepSeekAppConfig folds the retired vision-exp alias into deepseek-flash', () => {
  // The 0.1.1 default trio carried deepseek-v4-flash-vision-exp as a separate
  // vision SKU; V4.1 Flash absorbs it, so the trio dedupes to the new pair.
  const storedTrio = [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', supportsImage: true },
  ];
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: storedTrio,
      defaultModel: 'deepseek-v4-flash-vision-exp',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        models: storedTrio,
      },
    },
  });

  assert.deepEqual(
    normalized.providers?.deepseek.models?.map(({ id }) => id),
    ['deepseek-flash', 'deepseek-v4-pro'],
  );
  assert.equal(normalized.model.defaultModel, 'deepseek-flash');
});

test('normalizeDeepSeekAppConfig migrates retired ids in a custom DeepSeek catalog without adding models', () => {
  // A one-entry custom catalog predating the V4.1 rename keeps its shape —
  // nothing is injected — but the retired id folds into deepseek-flash.
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false },
      ],
      defaultModel: 'deepseek-v4-flash',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false },
        ],
      },
    },
  });

  assert.deepEqual(
    normalized.model.availableModels.map(({ id }) => id),
    ['deepseek-flash'],
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.map(({ id }) => id),
    ['deepseek-flash'],
  );
  assert.equal(normalized.model.defaultModel, 'deepseek-flash');
});

test('normalizeDeepSeekAppConfig backfills legacy DeepSeek api config into provider config', () => {
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    api: {
      key: 'legacy-deepseek-key',
      baseUrl: 'https://api.deepseek.com/anthropic',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        enabled: false,
        apiKey: '',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai',
      },
    },
  });

  assert.equal(normalized.providers?.deepseek.enabled, true);
  assert.equal(normalized.providers?.deepseek.apiKey, 'legacy-deepseek-key');
  assert.equal(normalized.providers?.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(normalized.providers?.deepseek.apiFormat, 'anthropic');
});

test('mergeProvidersConfig preserves existing provider credentials when incoming config is only the default empty template', () => {
  const currentProviders = {
    ...defaultConfig.providers!,
    deepseek: {
      ...defaultConfig.providers!.deepseek,
      enabled: true,
      apiKey: 'deepseek-existing-key',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic' as const,
    },
    anthropic: {
      ...defaultConfig.providers!.anthropic,
      enabled: true,
      apiKey: 'anthropic-existing-key',
      baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic' as const,
    },
  };

  const merged = mergeProvidersConfig(currentProviders, {
    ...defaultConfig.providers!,
    deepseek: {
      ...defaultConfig.providers!.deepseek,
    },
    anthropic: {
      ...defaultConfig.providers!.anthropic,
    },
  });

  assert.equal(merged?.deepseek.apiKey, 'deepseek-existing-key');
  assert.equal(merged?.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(merged?.deepseek.enabled, true);
  assert.equal(merged?.anthropic.apiKey, 'anthropic-existing-key');
  assert.equal(merged?.anthropic.enabled, true);
});

test('mergeProvidersConfig applies explicit provider credential updates', () => {
  const merged = mergeProvidersConfig(
    {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        enabled: true,
        apiKey: 'old-key',
      },
    },
    {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        enabled: true,
        apiKey: 'new-key',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic' as const,
      },
    },
  );

  assert.equal(merged?.deepseek.apiKey, 'new-key');
  assert.equal(merged?.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(merged?.deepseek.apiFormat, 'anthropic');
});

test('mergeProvidersConfig rewrites the stale metaid-free 1M-context entry to the 1M window / 100K declared ceiling', () => {
  // The 2026-10-04 metaid-free 413 incident: installs provisioned while the
  // canonical table mirrored the deepseek-flash preset (1M window / 32K
  // output) carry that wrong-for-the-time output pin in their stored config.
  // The window value itself is again the canonical 1M (upstream upgraded
  // past 64K, owner-confirmed 2026-10-09), so only the machine-written 32K
  // output pin is rewritten — to the 2026-10-09 100K declared ceiling.
  const staleProvisioned = {
    'metaid-free': {
      enabled: true,
      apiKey: 'mrk_stale-install',
      baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1',
      apiFormat: 'openai' as const,
      name: 'IDBots-Free',
      models: [
        {
          id: 'deepseek-chat',
          name: 'deepseek-flash',
          contextWindow: 1_000_000,
          maxOutputTokens: 32_768,
          supportsImage: false,
          options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
        },
      ],
    },
  };

  const merged = mergeProvidersConfig(staleProvisioned, undefined);

  const model = merged?.['metaid-free']?.models?.find(({ id }) => id === 'deepseek-chat');
  assert.ok(model);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxOutputTokens, 100_000);
  // Everything the canonical table does not own stays untouched.
  assert.equal(model.name, 'deepseek-flash');
  assert.deepEqual(model.options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });
  assert.equal(merged?.['metaid-free']?.apiKey, 'mrk_stale-install');
});

test('mergeProvidersConfig bumps the 2026-10-04 64000/4096 pin to 1M/100K but keeps user-tuned free-model limits', () => {
  // Rows written by the 2026-10-04 build store the machine-pinned 64000/4096
  // (also what the relay payload reported); both move to the current
  // canonical — the 1M window (upstream upgraded past 64K) and the 100K
  // declared output ceiling. A user-tuned row (manual Settings edits — the
  // 2026-10-09 incident where normalization reverted every manual change on
  // load) keeps its stored numbers.
  const stored = {
    'metaid-free': {
      enabled: true,
      apiKey: 'mrk_x',
      baseUrl: 'https://relay.example',
      apiFormat: 'openai' as const,
      name: 'IDBots-Free',
      models: [
        {
          id: 'deepseek-chat',
          name: 'deepseek-flash',
          contextWindow: 64_000,
          maxOutputTokens: 4_096,
          supportsImage: false,
        },
        {
          id: 'deepseek-chat-user-tuned',
          name: 'deepseek-flash',
          contextWindow: 100_000,
          maxOutputTokens: 20_000,
          supportsImage: false,
          options: { reasoningEffort: 'high', thinking: { type: 'disabled' } },
        },
      ],
    },
  };

  const merged = mergeProvidersConfig(undefined, stored);

  const models = merged?.['metaid-free']?.models ?? [];
  const pinned = models.find(({ id }) => id === 'deepseek-chat');
  assert.ok(pinned);
  assert.equal(pinned.contextWindow, 1_000_000);
  assert.equal(pinned.maxOutputTokens, 100_000);
  // Canonical options fill in only where the row stores none.
  assert.deepEqual(pinned.options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });

  // A differently-named row never matches the known-id table, and even the
  // known id keeps values that are not machine-pinned legacy numbers.
  const unknown = models.find(({ id }) => id === 'deepseek-chat-user-tuned');
  assert.ok(unknown);
  assert.equal(unknown.contextWindow, 100_000);
  assert.equal(unknown.maxOutputTokens, 20_000);
  assert.deepEqual(unknown.options, { reasoningEffort: 'high', thinking: { type: 'disabled' } });
});

test('mergeProvidersConfig keeps user-tuned limits on the known free-relay id untouched', () => {
  // The known id with NON-legacy stored values: normalization fills nothing
  // and rewrites nothing — manual edits must survive load/save cycles (the
  // 2026-10-09 regression where the canonical spread reverted them).
  const stored = {
    'metaid-free': {
      enabled: true,
      apiKey: 'mrk_x',
      baseUrl: 'https://relay.example',
      apiFormat: 'openai' as const,
      name: 'IDBots-Free',
      models: [
        {
          id: 'deepseek-chat',
          name: 'deepseek-flash',
          contextWindow: 100_000,
          maxOutputTokens: 50_000,
          supportsImage: true,
          options: { reasoningEffort: 'low', thinking: { type: 'disabled' } },
        },
      ],
    },
  };

  const merged = mergeProvidersConfig(undefined, stored);

  const model = merged?.['metaid-free']?.models?.find(({ id }) => id === 'deepseek-chat');
  assert.ok(model);
  assert.equal(model.contextWindow, 100_000);
  assert.equal(model.maxOutputTokens, 50_000);
  assert.equal(model.supportsImage, true);
  assert.deepEqual(model.options, { reasoningEffort: 'low', thinking: { type: 'disabled' } });
});

