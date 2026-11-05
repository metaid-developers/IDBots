import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProviderModelsUrl,
  canonicalizeVolcengineModelList,
  mergeSyncedProviderModels,
  parseProviderModelListPayload,
  providerSupportsModelListSync,
} from '../src/renderer/services/providerModels.ts';

test('providerSupportsModelListSync gates the Fetch Models button to the known endpoints', () => {
  for (const key of ['deepseek', 'opencode', 'commandcode', 'zhipu', 'volcengine', 'DeepSeek', ' opencode ']) {
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
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1000000 },
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000 },
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
    { id: 'deepseek-flash', name: undefined, contextWindow: undefined },
    { id: 'deepseek-v4-pro', name: undefined, contextWindow: undefined },
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
    { id: 'glm-5.3', name: 'glm-5.3', supportsImage: false, contextWindow: 1048576 },
    { id: 'glm-5.3-flash', name: 'glm-5.3-flash', supportsImage: true, contextWindow: 1048576 },
    { id: 'glm-5-turbo', name: 'glm-5-turbo', contextWindow: 204800 },
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

test('buildProviderModelsUrl: volcengine resolves every base to the canonical /api/v3 catalog', () => {
  // Factory default base (ends with /api/v3).
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com/api/v3', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/v3/models',
  );
  // Legacy /v1-shaped base still lands on the live catalog.
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com/api/v1', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/v3/models',
  );
  // Bare host or other volces.com bases.
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/v3/models',
  );
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com/', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/v3/models',
  );
  // Trailing slashes on the default base.
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com/api/v3/', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/v3/models',
  );
});

test('parseProviderModelListPayload reads modalities nested behind the Ark shape too', () => {
  const payload = {
    object: 'list',
    data: [
      {
        id: 'kimi-k3-1-pro-261024',
        name: 'kimi-k3-1-pro',
        context_window: 1_048_576,
        modalities: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      },
      {
        id: 'deepseek-v4-pro-ga-260813',
        name: 'deepseek-v4-pro-ga',
        context_window: 1_048_576,
        modalities: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ],
  };
  const parsed = parseProviderModelListPayload(payload);
  assert.deepEqual(parsed, [
    { id: 'kimi-k3-1-pro-261024', name: 'kimi-k3-1-pro', supportsImage: true, contextWindow: 1_048_576 },
    { id: 'deepseek-v4-pro-ga-260813', name: 'deepseek-v4-pro-ga', supportsImage: false, contextWindow: 1_048_576 },
  ]);
});

test('canonicalizeVolcengineModelList keeps only chat-capable Published rows, addressed by stable aliases', () => {
  const payload = {
    object: 'list',
    data: [
      // Two snapshots of the same alias — only the newest survives.
      {
        id: 'deepseek-v4-1-flash-260910',
        name: 'deepseek-v4-1-flash',
        status: 'Published',
        created: 175_740,
        context_window: 262_144,
        api_supported: { 'chat/completions': true },
        modalities: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      {
        id: 'deepseek-v4-1-flash-261017',
        name: 'deepseek-v4-1-flash',
        status: 'Published',
        created: 175_900,
        context_window: 1_048_576,
        api_supported: { 'chat/completions': true },
        modalities: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      },
      // Retiring snapshot of a chat model — excluded from the picker.
      {
        id: 'deepseek-v4-pro-260425',
        name: 'deepseek-v4-pro',
        status: 'Retiring',
        created: 175_000,
        context_window: 1_048_576,
        api_supported: { 'chat/completions': true },
        modalities: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      // Chat-capable but a superseded codePreview snapshot (Retiring).
      {
        id: 'doubao-seed-2-0-code-preview-260215',
        name: 'doubao-seed-2-0-code-preview',
        status: 'Retiring',
        created: 174_000,
        context_window: 262_144,
        api_supported: { 'chat/completions': true },
        modalities: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      },
      // Published but NOT chat-capable — image generation keeps out of the
      // model picker even when a text alias shares its family name.
      {
        id: 'doubao-seedream-5-0-pro-260628',
        name: 'doubao-seedream-5-0-pro',
        status: 'Published',
        created: 175_700,
        api_supported: {},
      },
      // Missing api_supported entirely — skipped.
      {
        id: 'doubao-seed-translation-250915',
        name: 'doubao-seed-translation',
        status: 'Published',
        created: 175_100,
        context_window: 4_096,
      },
      // Live alias kept in catalog order: kimi appears last but its position
      // reflects the raw list order, not the dedupe pass order.
      {
        id: 'kimi-k3-1-pro-261024',
        name: 'kimi-k3-1-pro',
        status: 'Published',
        created: 175_950,
        context_window: 1_048_576,
        api_supported: { 'chat/completions': true },
        modalities: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] },
      },
    ],
  };
  assert.deepEqual(canonicalizeVolcengineModelList(payload), [
    { id: 'deepseek-v4-1-flash', name: 'deepseek-v4-1-flash', supportsImage: true, contextWindow: 1_048_576 },
    { id: 'kimi-k3-1-pro', name: 'kimi-k3-1-pro', supportsImage: true, contextWindow: 1_048_576 },
  ]);
});

test('canonicalizeVolcengineModelList returns an empty list for non-catalog payloads', () => {
  assert.deepEqual(canonicalizeVolcengineModelList({ error: { message: 'unauthorized' } }), []);
  assert.deepEqual(canonicalizeVolcengineModelList(null), []);
  assert.deepEqual(canonicalizeVolcengineModelList({ data: [] }), []);
});

test('mergeSyncedProviderModels applies the Volcengine canonical preset over bare aliases', () => {
  const merged = mergeSyncedProviderModels(
    'volcengine',
    [
      // Fetched bare alias rows (as canonicalizeVolcengineModelList outputs).
      { id: 'kimi-k3-1-pro', name: 'kimi-k3-1-pro', supportsImage: true, contextWindow: 1_048_576 },
      // An alias no preset tracks keeps its gateway name.
      { id: 'qwen3-32b', name: 'qwen3-32b', supportsImage: false, contextWindow: 131_072 },
    ],
    [],
  );
  assert.deepEqual(merged, [
    {
      id: 'kimi-k3-1-pro',
      name: 'Kimi K3.1 Pro',
      supportsImage: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 1_048_576,
      options: undefined,
    },
    {
      id: 'qwen3-32b',
      name: 'qwen3-32b',
      supportsImage: false,
      contextWindow: 131_072,
      maxOutputTokens: undefined,
      options: undefined,
    },
  ]);
});

test('buildProviderModelsUrl: volcengine picks the catalog mount that matches the billing channel', () => {
  // Coding Plan — Anthropic-form base → coding catalog.
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com/api/coding', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/coding/v3/models',
  );
  // Coding Plan — OpenAI-form base (…/coding/v3) → same coding catalog.
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com/api/coding/v3', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/coding/v3/models',
  );
  // Trailing slash on the coding base.
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com/api/coding/v3/', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/coding/v3/models',
  );
  // Agent Plan base — also a coding-channel mount? No: /api/plan is the OTHER
  // subscription; it has its own catalog, not covered here — falls to default
  // pay-as-you-go path and must NOT be silently rewritten to coding.
  assert.equal(
    buildProviderModelsUrl('https://ark.cn-beijing.volces.com/api/plan', 'volcengine'),
    'https://ark.cn-beijing.volces.com/api/v3/models',
  );
});
