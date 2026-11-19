import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProviderModelsUrl,
  mergeSyncedProviderModels,
  parseProviderModelListPayload,
  providerSupportsModelListSync,
} from '../src/renderer/services/providerModels.ts';

test('providerSupportsModelListSync gates the Fetch Models button to the known endpoints', () => {
  for (const key of ['deepseek', 'opencode', 'commandcode', 'zhipu', 'DeepSeek', ' opencode ']) {
    assert.equal(providerSupportsModelListSync(key), true, key);
  }
  for (const key of ['metaid-free', 'openai', 'anthropic', 'ollama', 'custom-my-relay', '']) {
    assert.equal(providerSupportsModelListSync(key), false, key);
  }
});

test('buildProviderModelsUrl: deepseek mounts /models at the host root', () => {
  assert.equal(
    buildProviderModelsUrl('https://api.deepseek.com', 'deepseek'),
    'https://api.deepseek.com/models',
  );
  // Legacy Messages-format base URL drops the /anthropic suffix.
  assert.equal(
    buildProviderModelsUrl('https://api.deepseek.com/anthropic', 'deepseek'),
    'https://api.deepseek.com/models',
  );
  // OpenAI-SDK-style /v1 base drops the version prefix too.
  assert.equal(
    buildProviderModelsUrl('https://api.deepseek.com/v1', 'deepseek'),
    'https://api.deepseek.com/models',
  );
  assert.equal(
    buildProviderModelsUrl('https://api.deepseek.com/', 'deepseek'),
    'https://api.deepseek.com/models',
  );
});

test('buildProviderModelsUrl: OpenAI-compatible gateways mount /models next to /v1', () => {
  assert.equal(
    buildProviderModelsUrl('https://opencode.ai/zen/go/v1', 'opencode'),
    'https://opencode.ai/zen/go/v1/models',
  );
  assert.equal(
    buildProviderModelsUrl('https://api.commandcode.ai/provider/v1', 'commandcode'),
    'https://api.commandcode.ai/provider/v1/models',
  );
  // A base URL without a version prefix gets the standard /v1/models join.
  assert.equal(
    buildProviderModelsUrl('https://gateway.example.com', 'commandcode'),
    'https://gateway.example.com/v1/models',
  );
  assert.equal(
    buildProviderModelsUrl('https://gateway.example.com/v1/models', 'commandcode'),
    'https://gateway.example.com/v1/models',
  );
});

test('buildProviderModelsUrl: zhipu resolves every protocol base to the Responses catalog', () => {
  // Default responses base.
  assert.equal(
    buildProviderModelsUrl('https://open.bigmodel.cn/api/v1', 'zhipu'),
    'https://open.bigmodel.cn/api/v1/models',
  );
  // Legacy anthropic default from older configs.
  assert.equal(
    buildProviderModelsUrl('https://open.bigmodel.cn/api/anthropic', 'zhipu'),
    'https://open.bigmodel.cn/api/v1/models',
  );
  // Chat-completions coding endpoint.
  assert.equal(
    buildProviderModelsUrl('https://open.bigmodel.cn/api/coding/paas/v4', 'zhipu'),
    'https://open.bigmodel.cn/api/v1/models',
  );
  // Provider key alone also pins the host when the base URL is bare.
  assert.equal(
    buildProviderModelsUrl('https://open.bigmodel.cn', 'zhipu'),
    'https://open.bigmodel.cn/api/v1/models',
  );
});

test('parseProviderModelListPayload reads the OpenAI-style list and keeps gateway extras', () => {
  // commandcode shape: display name + context_length per model.
  const commandCode = parseProviderModelListPayload({
    object: 'list',
    data: [
      { id: 'claude-sonnet-5', object: 'model', name: 'Claude Sonnet 5', context_length: 1000000 },
      { id: 'deepseek/deepseek-v4.1-flash', object: 'model', name: 'DeepSeek V4.1 Flash', context_length: 1000000 },
    ],
  });
  assert.deepEqual(commandCode, [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1000000, maxOutputTokens: undefined },
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxOutputTokens: undefined },
  ]);

  // deepseek/opencode shape: bare ids, no name/context.
  const deepseek = parseProviderModelListPayload({
    object: 'list',
    data: [
      { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
      { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
    ],
  });
  assert.deepEqual(deepseek, [
    { id: 'deepseek-flash', name: undefined, contextWindow: undefined, maxOutputTokens: undefined },
    { id: 'deepseek-v4-pro', name: undefined, contextWindow: undefined, maxOutputTokens: undefined },
  ]);

  // Blank ids and duplicates drop out; unknown payload shapes yield [].
  const messy = parseProviderModelListPayload({
    data: [{ id: '' }, { id: 'a' }, { id: 'a' }, { noId: true }, { id: '  b  ' }],
  });
  assert.deepEqual(messy.map((model) => model.id), ['a', 'b']);
  assert.deepEqual(parseProviderModelListPayload({}), []);
  assert.deepEqual(parseProviderModelListPayload(null), []);
  assert.deepEqual(parseProviderModelListPayload('not json'), []);
});

test('parseProviderModelListPayload reads the Zhipu Responses catalog shape', () => {
  // Live shape of GET https://open.bigmodel.cn/api/v1/models (2026-09-18):
  // {models: [...]} with slug/display_name/context_window/input_modalities.
  const zhipu = parseProviderModelListPayload({
    models: [
      {
        slug: 'glm-5.3',
        display_name: 'glm-5.3',
        context_window: 1048576,
        input_modalities: ['text'],
      },
      {
        slug: 'glm-5.3-flash',
        display_name: 'glm-5.3-flash',
        context_window: 1048576,
        input_modalities: ['text', 'image'],
      },
      { slug: 'glm-5-turbo', display_name: 'glm-5-turbo', context_window: 204800 },
    ],
  });
  assert.deepEqual(zhipu, [
    { id: 'glm-5.3', name: 'glm-5.3', supportsImage: false, contextWindow: 1048576, maxOutputTokens: undefined },
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash', supportsImage: true, contextWindow: 1048576, maxOutputTokens: undefined },
    { id: 'glm-5-turbo', name: 'glm-5-turbo', contextWindow: 204800, maxOutputTokens: undefined },
  ]);
});

test('parseProviderModelListPayload reads the opencode limit/modalities metadata', () => {
  // Live shape of GET https://opencode.ai/zen/go/v1/models (2026-11-19,
  // session cw-636ddce2): each entry carries a nested limit record
  // {context, output} and modalities either as an {input, output} record
  // (deepseek SKUs) or a flat MIME array (gemini SKUs). Before this parser
  // learned the shape, gemini-4-argon (1M real) synced with NO window and
  // resolved to the 128K fallback, overflowed mid-turn and died silently.
  const opencode = parseProviderModelListPayload({
    object: 'list',
    data: [
      {
        id: 'gemini-4-argon',
        object: 'model',
        name: 'Gemini 4 Argon',
        family: 'gemini',
        limit: { context: 1048576, output: 65536 },
        modalities: ['text', 'image/png', 'image/jpeg', 'video/mp4'],
      },
      {
        id: 'deepseek-v4.1-flash',
        object: 'model',
        limit: { context: 1000000, output: 384000 },
        modalities: { input: ['text', 'image/png'], output: ['text'] },
      },
      {
        id: 'muse-spark-7',
        object: 'model',
        // No limit record: window/output stay undefined so resolution falls
        // through to the catalog / family / fallback layers.
        modalities: { input: ['text'], output: ['text'] },
      },
    ],
  });
  assert.deepEqual(opencode, [
    {
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      supportsImage: true,
      contextWindow: 1048576,
      maxOutputTokens: 65536,
    },
    {
      id: 'deepseek-v4.1-flash',
      name: undefined,
      supportsImage: true,
      contextWindow: 1000000,
      maxOutputTokens: 384000,
    },
    {
      id: 'muse-spark-7',
      name: undefined,
      supportsImage: false,
      contextWindow: undefined,
      maxOutputTokens: undefined,
    },
  ]);
});

test('mergeSyncedProviderModels stores endpoint-reported maxOutputTokens (opencode limits)', () => {
  // opencode reports limit.output; the synced row must carry it so the
  // route's maxTokens matches the SKU's real output ceiling instead of the
  // generic 128K default (or the small-window 8192 clamp it used to get).
  const merged = mergeSyncedProviderModels(
    'opencode',
    [{ id: 'gemini-4-argon', contextWindow: 1048576, maxOutputTokens: 65536, supportsImage: true }],
    [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon (manual)' }],
  );
  assert.deepEqual(merged, [
    {
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon (manual)',
      supportsImage: true,
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      options: undefined,
    },
  ]);
});

test('mergeSyncedProviderModels applies the DeepSeek canonical preset over bare fetched ids', () => {
  const merged = mergeSyncedProviderModels(
    'deepseek',
    [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    [],
  );
  assert.deepEqual(merged, [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek V4.1 Flash',
      supportsImage: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 256_000,
      options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      supportsImage: false,
      contextWindow: 1_000_000,
      maxOutputTokens: 256_000,
      options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
    },
  ]);
});

test('mergeSyncedProviderModels keeps per-model local options for surviving ids', () => {
  // The user downgraded flash thinking to 'low'; a sync must not resurrect
  // the canonical 'max'.
  const merged = mergeSyncedProviderModels(
    'deepseek',
    [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek V4 Flash',
        supportsImage: false,
        options: { reasoningEffort: 'low', thinking: { type: 'enabled' } },
      },
    ],
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].options, { reasoningEffort: 'low', thinking: { type: 'enabled' } });
  // ...while the canonical preset still wins the display name and the
  // new-to-V4.1 vision flag.
  assert.equal(merged[0].name, 'DeepSeek V4.1 Flash');
  assert.equal(merged[0].supportsImage, true);
});

test('mergeSyncedProviderModels replaces the catalog with the official list', () => {
  // commandcode drops minimax free ids and adds claude-fable-5-1: the synced
  // catalog mirrors the official list exactly (dropped ids disappear), keeps
  // the local vision flag on the survivor, and fails safe on the new id.
  const merged = mergeSyncedProviderModels(
    'commandcode',
    [
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000 },
    ],
    [
      { id: 'minimax/minimax-m3-free', name: 'MiniMax M3 (Free)', supportsImage: true },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', supportsImage: true, contextWindow: 1_000_000 },
    ],
  );
  assert.deepEqual(merged.map((model) => model.id), ['claude-fable-5-1', 'claude-sonnet-5']);
  assert.equal(merged[0].supportsImage, false, 'new ids default to text-only (fail-safe)');
  assert.equal(merged[0].contextWindow, 1_000_000, 'endpoint-reported context wins');
  assert.equal(merged[1].supportsImage, true, 'surviving ids keep the local vision flag');
  assert.equal(merged[1].name, 'Claude Sonnet 5');
});

test('mergeSyncedProviderModels prefers gateway names and falls back to the id', () => {
  // opencode returns bare ids: a previously stored display name survives,
  // and a brand-new id displays as itself.
  const merged = mergeSyncedProviderModels(
    'opencode',
    [{ id: 'deepseek-flash' }, { id: 'kimi-k3' }],
    [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', supportsImage: true, contextWindow: 1_000_000 }],
  );
  assert.equal(merged[0].name, 'DeepSeek V4.1 Flash');
  assert.equal(merged[0].supportsImage, true);
  assert.equal(merged[0].contextWindow, 1_000_000);
  assert.equal(merged[1].name, 'kimi-k3');
  assert.equal(merged[1].supportsImage, false);
});

test('mergeSyncedProviderModels applies the Zhipu canonical preset and honors catalog modalities', () => {
  // Zhipu sync: the catalog's input_modalities win over both the canonical
  // preset and stale local flags (flips either way), while the preset
  // re-supplies names/limits for the GLM-5.3 ids it knows.
  const merged = mergeSyncedProviderModels(
    'zhipu',
    [
      { id: 'glm-5.3', name: 'glm-5.3', supportsImage: false, contextWindow: 1048576 },
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash', supportsImage: true, contextWindow: 1048576 },
      { id: 'glm-5-turbo', name: 'glm-5-turbo', supportsImage: false, contextWindow: 204800 },
    ],
    [
      // A stale local flag (vision shipped later on flash) must be corrected.
      { id: 'glm-5.3-flash', name: 'GLM Flash (old)', supportsImage: false, contextWindow: 128_000 },
    ],
  );
  assert.deepEqual(merged, [
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      supportsImage: false,
      contextWindow: 1_048_576,
      maxOutputTokens: 128_000,
      options: undefined,
    },
    {
      id: 'glm-5.3-flash',
      name: 'GLM-5.3 Flash',
      supportsImage: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 128_000,
      options: undefined,
    },
    {
      id: 'glm-5-turbo',
      name: 'glm-5-turbo',
      supportsImage: false,
      contextWindow: 204_800,
      maxOutputTokens: undefined,
      options: undefined,
    },
  ]);
});
