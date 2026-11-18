import test from 'node:test';
import assert from 'node:assert/strict';

test('resolveCoworkModelLimits reads explicit provider model limits', async () => {
  const {
    resolveCoworkModelLimits,
  } = await import('../dist-electron/main/libs/coworkModelLimits.js');

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
    // Provider metadata did not declare supportsVision, so the known-model
    // capability (DeepSeek V4 family has no vision) applies.
    supportsVision: false,
    source: 'provider-model',
  });
});

test('resolveCoworkModelLimits falls back conservatively for unknown models', async () => {
  const {
    DEFAULT_COWORK_CONTEXT_WINDOW,
    DEFAULT_COWORK_MAX_OUTPUT_TOKENS,
    resolveCoworkModelLimits,
  } = await import('../dist-electron/main/libs/coworkModelLimits.js');

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
    // The 128K default output ceiling no longer survives resolution on the
    // 128K fallback window: the small-window tier caps it at 6% of the window
    // (7680) and the 8K floor takes over, so the kernel's compaction pressure
    // budget (window - reserved output - headroom) stays positive while the
    // 90% threshold tier remains reachable. The exported default is unchanged.
    maxOutputTokens: 8_192,
    // Fail-safe default: models we have not catalogued are treated as
    // text-only. The Read-image guard then denies with an explicit pointer
    // to describe_image instead of silently dropping pixels on a model that
    // cannot read them (2026-09-04 glm-5.3-flash regression).
    supportsVision: false,
    source: 'fallback',
  });
  assert.equal(DEFAULT_COWORK_CONTEXT_WINDOW, 128_000);
  assert.equal(DEFAULT_COWORK_MAX_OUTPUT_TOKENS, 128_000);
});

test('resolveCoworkModelLimits can use built-in DeepSeek V4 Pro defaults by model id', async () => {
  const {
    resolveCoworkModelLimits,
  } = await import('../dist-electron/main/libs/coworkModelLimits.js');

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
    maxOutputTokens: 256_000,
    supportsVision: false,
    source: 'known-model',
  });
});

test('deepseek-v4-flash declares the 256K harness-aligned output ceiling', async () => {
  const { resolveCoworkModelLimits } = await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'deepseek-v4-flash', availableModels: [] },
    providers: {},
  });

  assert.equal(limits.source, 'known-model');
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 256_000);
});

// ---------------------------------------------------------------------------
// Regression: context usage ring must reflect each model's real context window,
// not the flat 128K fallback. Every model id that ships as a preset must resolve
// to a real context window via KNOWN_MODEL_LIMITS even when the enabled provider
// or available-model metadata is absent (which is what cowork/A2A automation
// sessions hit, since they are driven by deepseek-v4-flash).
// ---------------------------------------------------------------------------

/**
 * The complete set of model ids that ship as presets in src/renderer/config.ts
 * (defaultConfig.providers + DeepSeek defaults) and src/renderer/services/config.ts
 * (provider model migration v1).
 */
const PRESET_MODEL_IDS = [
  // DeepSeek (default engine) — deepseek-flash drives cowork/A2A automation
  'deepseek-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  // OpenAI
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  // Gemini
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  // Anthropic
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  // Moonshot
  'kimi-k2.6',
  'kimi-k2.5',
  // Zhipu GLM-5.3 family presets + legacy presets still resolvable in
  // stored configs (migration v2 retires but keeps them catalogued).
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.2-fast',
  'glm-5.1',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'z-ai/glm-5.3-flash',
  'zai-org/GLM-5.3',
  'zai-org/GLM-5.2',
  'zai-org/GLM-5.2-Fast',
  'zai-org/GLM-5.1',
  'zai-org/GLM-5',
  // MiniMax
  'MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  // Qwen
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen3-coder-next',
  // Xiaomi MiMo
  'mimo-v2.5-pro',
  'mimo-v2.5',
  // OpenRouter aliases
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.7',
  'openai/gpt-5.5',
  'google/gemini-3.1-pro-preview',
];

/** Expected context window per model family (mirrors KNOWN_MODEL_LIMITS). */
const EXPECTED_CONTEXT_WINDOWS = {
  'deepseek-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-flash-vision-exp': 1_000_000,
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-5.4': 1_050_000,
  'gemini-3.1-pro-preview': 2_000_000,
  'gemini-3-flash-preview': 2_000_000,
  'gemini-3.1-flash-lite': 2_000_000,
  'claude-opus-4-7': 1_048_576,
  'claude-opus-4-6': 1_048_576,
  'claude-sonnet-4-6': 1_048_576,
  'kimi-k2.6': 262_144,
  'kimi-k2.5': 262_144,
  // GLM-5.3 family (Zhipu direct): 1048576 per the live catalog
  // GET /api/v1/models, 2026-09-18. Gateway ids keep the /v1-era 1M roundings.
  'glm-5.3-flash': 1_048_576,
  'glm-5.3-flashx': 1_048_576,
  'glm-5.3': 1_048_576,
  'glm-5.2': 1_000_000,
  'glm-5.2-fast': 1_000_000,
  'glm-5.1': 202_800,
  'glm-5': 202_800,
  'glm-4.7': 204_800,
  'glm-4.7-flash': 204_800,
  'z-ai/glm-5.3-flash': 1_048_576,
  'zai-org/GLM-5.3': 1_000_000,
  'zai-org/GLM-5.2': 1_000_000,
  'zai-org/GLM-5.2-Fast': 1_000_000,
  'zai-org/GLM-5.1': 202_800,
  'zai-org/GLM-5': 202_800,
  'MiniMax-M3': 1_000_000,
  'MiniMax-M2.7': 204_800,
  'MiniMax-M2.5': 204_800,
  'qwen3.6-plus': 1_000_000,
  'qwen3.5-plus': 1_000_000,
  'qwen3-coder-next': 1_000_000,
  'mimo-v2.5-pro': 1_000_000,
  'mimo-v2.5': 1_000_000,
  'anthropic/claude-sonnet-4.6': 1_048_576,
  'anthropic/claude-opus-4.7': 1_048_576,
  'openai/gpt-5.5': 1_050_000,
  'google/gemini-3.1-pro-preview': 2_000_000,
};

// No provider metadata and no available-model metadata, so resolution must rely
// entirely on KNOWN_MODEL_LIMITS — the same path automation sessions hit.
const APP_CONFIG_WITHOUT_PROVIDER_META = {
  model: { defaultModel: '', availableModels: [] },
  providers: {},
};

test('no preset model resolves to the 128K fallback — context window is dynamic per model', async () => {
  const { resolveCoworkModelLimits, DEFAULT_COWORK_CONTEXT_WINDOW } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const regressions = [];
  for (const modelId of PRESET_MODEL_IDS) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    if (limits.source === 'fallback' || limits.contextWindow === DEFAULT_COWORK_CONTEXT_WINDOW) {
      regressions.push({ modelId, source: limits.source, contextWindow: limits.contextWindow });
    }
  }
  assert.deepEqual(
    regressions,
    [],
    `These preset models fell back to the hardcoded 128K context window (add them to KNOWN_MODEL_LIMITS in src/main/libs/coworkModelLimits.ts): ${JSON.stringify(regressions, null, 2)}`,
  );
});

test('each preset model resolves to its expected real context window', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of PRESET_MODEL_IDS) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    const expected = EXPECTED_CONTEXT_WINDOWS[modelId];
    assert.equal(
      limits.contextWindow,
      expected,
      `${modelId}: expected context window ${expected}, got ${limits.contextWindow} (source=${limits.source})`,
    );
  }
});

test('deepseek-v4-flash — the automation model behind cowork/A2A — resolves to 1M, not 128K', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-v4-flash');
  assert.equal(limits.contextWindow, 1_000_000);
  assert.notEqual(limits.source, 'fallback');
});

// ---------------------------------------------------------------------------
// GT#12 N1: supportsVision capability — DeepSeek V4 Flash / Pro and the GLM
// text-only ids have no vision; catalogued vision presets do. Unknown models
// default to FALSE (fail-safe): the Read-image guard then denies loudly and
// points at describe_image instead of silently dropping image pixels on a
// model that cannot read them (2026-09-04 glm-5.3-flash regression).
// glm-5.3-flash (Zhipu direct) flipped to vision-capable on 2026-09-19: the
// GLM-5.3 launch made Flash natively multimodal — image input verified live
// through BOTH the Responses (/api/v1/responses) and Anthropic
// (/api/anthropic/v1/messages) endpoints. On 2026-09-28 the gateway spellings
// (z-ai/glm-5.3-flash, case variants, uncatalogued vendor prefixes) flipped
// too: every gateway proxies the same multimodal upstream SKU, and the
// fail-safe false kept gateway-served GLM-5.3 Flash from reading images.
// ---------------------------------------------------------------------------

const NON_VISION_MODELS = [
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  // GLM text-only ids — the flagship glm-5.3 and the legacy text families.
  'glm-5.3',
  'glm-5.2',
  'glm-5.2-fast',
  'glm-5.1',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'zai-org/GLM-5.3',
  'zai-org/GLM-5.2',
  'zai-org/GLM-5.2-Fast',
  'zai-org/GLM-5.1',
  'zai-org/GLM-5',
];

test('non-vision models resolve supportsVision=false via known-model limits', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of NON_VISION_MODELS) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    assert.equal(limits.supportsVision, false, `${modelId} must be marked non-vision`);
    assert.equal(limits.source, 'known-model', `${modelId} must resolve via KNOWN_MODEL_LIMITS`);
  }
});

test('glm-5.3-flash — multimodal since the GLM-5.3 launch — resolves vision=true even with a flagless catalog entry', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The incident shape: a bot brain pointing at glm-5.3-flash while the
  // provider catalog entry (relay-provisioned or a stale preset) carries no
  // capability flags — resolution must fall through to KNOWN_MODEL_LIMITS,
  // never to the fallback default. Since 2026-09-19 that catalog entry is
  // vision=true (live-verified on both protocol endpoints), so read_image
  // serves pixels instead of denying.
  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'glm-5.3-flash', availableModels: [] },
    providers: {
      'metaid-free': {
        enabled: true,
        models: [{ id: 'glm-5.3-flash', contextWindow: 1_048_576 }],
      },
    },
  });
  assert.equal(limits.supportsVision, true);
  assert.notEqual(limits.source, 'fallback');

  // The 2026-09-04 incident spelling — the commandcode gateway id — serves the
  // same multimodal upstream SKU, so it resolves vision=true since 2026-09-28.
  const gateway = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'z-ai/glm-5.3-flash');
  assert.equal(gateway.supportsVision, true);
  assert.equal(gateway.source, 'known-model');

  // glm-5.3-flashx shares the multimodal flash spec (not in coding plans, but
  // catalogued for pay-as-you-go users).
  const flashx = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'glm-5.3-flashx');
  assert.equal(flashx.supportsVision, true);
  assert.equal(flashx.contextWindow, 1_048_576);
  assert.equal(flashx.source, 'known-model');
});

// 2026-09-14 silent-stall: glm-5.3-flash (commandcode catalog entries carry
// contextWindow but no maxOutputTokens) inherited the old DEFAULT 8192.
// Thinking at effort-max burned that ceiling. Catalog + family fallback now
// pin the family's 128K ceiling, matching the raised default.
test('glm-5.3-flash thinking models get the 128K output ceiling', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of ['glm-5.3-flash', 'glm-5.3-flashx', 'z-ai/glm-5.3-flash', 'glm-5.3', 'zai-org/GLM-5.3']) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    assert.equal(limits.maxOutputTokens, 128_000, `${modelId} must resolve to the 128K output ceiling`);
  }

  // Commandcode-shaped catalog: contextWindow only, no maxOutputTokens.
  const gatewayLimits = resolveCoworkModelLimits({
    model: { defaultModel: 'z-ai/glm-5.3-flash', availableModels: [] },
    providers: {
      commandcode: {
        enabled: true,
        models: [{ id: 'z-ai/glm-5.3-flash', contextWindow: 1_048_576 }],
      },
    },
  });
  assert.equal(gatewayLimits.maxOutputTokens, 128_000);
  assert.equal(gatewayLimits.contextWindow, 1_048_576);
});

test('uncatalogued glm-5.x gateway ids inherit the family output ceiling, clamped to the fallback window', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The family rule contributes only the 128K output ceiling (no window), so
  // resolution pairs it with the 128K fallback window and the small-window
  // clamp caps the effective ceiling at the 8K floor (6% of 128K = 7680 < 8K).
  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'acme/glm-5.4-flash');
  assert.equal(limits.maxOutputTokens, 8_192);
  assert.equal(limits.source, 'family-model');
});

test('every catalogued vision-capable preset resolves supportsVision=true', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const nonVision = new Set(NON_VISION_MODELS);
  const regressions = [];
  for (const modelId of PRESET_MODEL_IDS) {
    if (nonVision.has(modelId)) {
      continue;
    }
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    if (limits.supportsVision !== true) {
      regressions.push({ modelId, supportsVision: limits.supportsVision });
    }
  }
  assert.deepEqual(
    regressions,
    [],
    `Vision-capable presets must resolve supportsVision=true: ${JSON.stringify(regressions)}`,
  );
});

test('unknown models default to supportsVision=false (fail-safe, explicit denial over silent pixel loss)', async () => {
  const { resolveCoworkModelLimits, modelSupportsVision } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'totally-unknown-model', availableModels: [] },
    providers: {},
  });
  assert.equal(limits.supportsVision, false);
  assert.equal(limits.source, 'fallback');

  // Direct query API used by the proxy scheme-B fallback.
  assert.equal(modelSupportsVision('totally-unknown-model'), false);
  assert.equal(modelSupportsVision(''), false);
  assert.equal(modelSupportsVision(null), false);
  assert.equal(modelSupportsVision(undefined), false);
  // Catalogued vision models still answer true.
  assert.equal(modelSupportsVision('kimi-k2.6'), true);
});

test('provider metadata can explicitly override supportsVision', async () => {
  const { resolveCoworkModelLimits, modelSupportsVision } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // A gateway serving deepseek-v4-pro through a vision-capable front model:
  // explicit provider metadata wins over the known-model table.
  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'deepseek-v4-pro', availableModels: [] },
    providers: {
      custom: {
        enabled: true,
        models: [
          { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 32_768, supportsVision: true },
        ],
      },
    },
  });
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.source, 'provider-model');

  // modelSupportsVision stays authoritative for the proxy (request model id).
  assert.equal(modelSupportsVision('deepseek-v4-pro'), false);
});

test('deepseek-v4-flash-vision-exp resolves supportsVision=true', async () => {
  const { resolveCoworkModelLimits, modelSupportsVision } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-v4-flash-vision-exp');
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 256_000);
  assert.equal(limits.source, 'known-model');
  assert.equal(modelSupportsVision('deepseek-v4-flash-vision-exp'), true);
});

test('catalog supportsImage maps onto supportsVision', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: {
      defaultModel: 'custom-vision',
      availableModels: [{ id: 'custom-vision', supportsImage: true, contextWindow: 128_000 }],
    },
    providers: {},
  }, 'custom-vision');
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.source, 'available-model');
});

// ---------------------------------------------------------------------------
// DeepSeek V4 family fallback (2026-09-09 cw-86812c4f stall): ephemeral SKU
// suffixes (deepseek-v4.1-flash-expires-on-0910) escape the exact catalog and
// fell to the old DEFAULT_COWORK_MAX_OUTPUT_TOKENS (8192); with reasoning effort
// 'max' the thinking alone burned that ceiling and the turn ended as a
// hollow-completed reasoning-only truncation. Any id whose last path segment
// starts with 'deepseek-v4' now inherits the family limits.
// ---------------------------------------------------------------------------

test('uncatalogued v4.1 promo SKU with partial provider metadata inherits the family output ceiling (cw-86812c4f regression)', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The exact production config of the stalled session: provider entry with
  // contextWindow but NO maxOutputTokens, and no catalog entry for the id.
  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'deepseek-v4.1-flash-expires-on-0910', availableModels: [] },
    providers: {
      deepseek: {
        enabled: true,
        models: [
          { id: 'deepseek-v4.1-flash-expires-on-0910', supportsImage: false, contextWindow: 1_000_000 },
        ],
      },
    },
  });

  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 256_000);
  assert.equal(limits.supportsVision, false);
  assert.equal(limits.source, 'provider-model');
});

test('uncatalogued v4 family id without any provider metadata resolves family-model limits', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-v4.2-ultra');
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 256_000);
  assert.equal(limits.supportsVision, false);
  assert.equal(limits.source, 'family-model');
});

test('gateway-prefixed v4.1 ids match on the last path segment', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek/deepseek-v4.1-flash');
  assert.equal(limits.maxOutputTokens, 256_000);
  assert.equal(limits.source, 'family-model');
});

test('gateway-prefixed deepseek-flash ids inherit the multimodal V4.1 family limits', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The renamed V4.1 line (deepseek-v4-flash → deepseek-flash, 2026-09-10) is
  // natively multimodal, so its family fallback marks vision true — unlike
  // the legacy v4-* line, which stays fail-safe false unless the SKU says so.
  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek/deepseek-flash');
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 256_000);
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.source, 'family-model');
});

test('family fallback marks vision SKUs and never overrides explicit provider values', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const vision = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-v4.1-flash-vision');
  assert.equal(vision.supportsVision, true);
  assert.equal(vision.maxOutputTokens, 256_000);

  const explicit = resolveCoworkModelLimits({
    model: { defaultModel: 'deepseek-v4.1-pro', availableModels: [] },
    providers: {
      deepseek: {
        enabled: true,
        models: [{ id: 'deepseek-v4.1-pro', maxOutputTokens: 16_000 }],
      },
    },
  });
  assert.equal(explicit.maxOutputTokens, 16_000);
  assert.equal(explicit.source, 'provider-model');
});

test('unknown models inherit the 128K default output ceiling, clamped to the fallback window', async () => {
  const { resolveCoworkModelLimits, DEFAULT_COWORK_MAX_OUTPUT_TOKENS } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'some-gw/deepseek-chat');
  assert.equal(DEFAULT_COWORK_MAX_OUTPUT_TOKENS, 128_000);
  // window 128K (fallback) → small-window tier: min(128K, max(8K, 128K×6%)) = 8192.
  assert.equal(limits.maxOutputTokens, 8_192);
  assert.equal(limits.source, 'fallback');
});

test('catalogued models without an explicit output ceiling inherit the 128K default', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of ['claude-sonnet-4-6', 'gpt-5.6-sol', 'MiniMax-M3', 'qwen3.6-plus']) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    assert.equal(limits.maxOutputTokens, 128_000, `${modelId} must inherit the 128K default`);
    assert.equal(limits.source, 'known-model', modelId);
  }

  // kimi-k2.6's 256K window is large enough to matter but small enough that
  // the inherited 128K ceiling exceeds 32% of it: the effective ceiling
  // clamps to floor(262144 × 0.32) = 83886.
  const kimi = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'kimi-k2.6');
  assert.equal(kimi.maxOutputTokens, 83_886);
  assert.equal(kimi.source, 'known-model');
});


test('isDeepSeekFamilyModelId matches the V4+/flash family across gateway and SKU forms', async () => {
  const { isDeepSeekFamilyModelId } = await import('../dist-electron/main/libs/coworkModelLimits.js');

  assert.equal(isDeepSeekFamilyModelId('deepseek-flash'), true);
  assert.equal(isDeepSeekFamilyModelId('deepseek/deepseek-flash'), true);
  assert.equal(isDeepSeekFamilyModelId('deepseek-v4.1-flash-expires-on-0910'), true);
  assert.equal(isDeepSeekFamilyModelId('deepseek-v4-pro'), true);
  assert.equal(isDeepSeekFamilyModelId('deepseek-chat'), false);
  assert.equal(isDeepSeekFamilyModelId('glm-5.3-flash'), false);
  assert.equal(isDeepSeekFamilyModelId(''), false);
  assert.equal(isDeepSeekFamilyModelId(null), false);
});

// ---------------------------------------------------------------------------
// 2026-09-28 glm-5.3-flash incident: provider-scoped capability resolution.
// Model ids are NOT unique across providers — the incident machine had
// glm-5.3-flash on zhipu (支持图像输入 checked) and on opencode (fail-safe
// false), and the legacy cross-provider scan answered with whichever enabled
// row came first in insertion order (opencode). Result: the Read-image guard
// denied pixels and the DSH route omitted inputModalities, so the kernel
// degraded every image block to a text placeholder — the bot reported
// "图像被宿主裁掉了（当前模型不吃图）" while DeepSeek (whose deepseek-flash id
// no earlier provider shadows) worked. When the caller names the session's
// provider, ONLY that provider's row may contribute explicit limits.
// ---------------------------------------------------------------------------

test('provider-scoped resolution: another provider\'s same-id row never shadows the session provider\'s checkbox', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The exact incident shape: opencode listed first (insertion order), its
  // fail-safe false row used to win over zhipu's checked row.
  const incidentConfig = {
    model: { defaultModel: 'glm-5.3-flash', availableModels: [] },
    providers: {
      opencode: {
        enabled: true,
        models: [{ id: 'glm-5.3-flash', supportsImage: false, contextWindow: 200_000 }],
      },
      zhipu: {
        enabled: true,
        models: [{ id: 'glm-5.3-flash', supportsImage: true, contextWindow: 1_048_576, maxOutputTokens: 128_000 }],
      },
    },
  };

  const zhipuScoped = resolveCoworkModelLimits(incidentConfig, 'glm-5.3-flash', 'zhipu');
  assert.equal(zhipuScoped.supportsVision, true, 'the zhipu checkbox must win for a zhipu session');
  assert.equal(zhipuScoped.source, 'provider-model');
  assert.equal(zhipuScoped.contextWindow, 1_048_576);

  // And symmetrically: an opencode session keeps its own (unchecked) row.
  const opencodeScoped = resolveCoworkModelLimits(incidentConfig, 'glm-5.3-flash', 'opencode');
  assert.equal(opencodeScoped.supportsVision, false, 'the session provider\'s own row decides, both ways');
  assert.equal(opencodeScoped.source, 'provider-model');

  // Without a provider key the legacy config-order scan still answers (the
  // default-model path has no provider identity to scope to).
  const unscoped = resolveCoworkModelLimits(incidentConfig, 'glm-5.3-flash');
  assert.equal(unscoped.source, 'provider-model');
});

test('provider-scoped resolution: named provider without a matching row falls to the catalog, never to another provider', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const config = {
    model: { defaultModel: 'glm-5.3-flash', availableModels: [] },
    providers: {
      opencode: {
        enabled: true,
        models: [{ id: 'glm-5.3-flash', supportsImage: false, contextWindow: 200_000 }],
      },
      'custom-relay': {
        enabled: true,
        models: [{ id: 'some-other-model' }],
      },
    },
  };

  // The session runs on custom-relay, which does not list glm-5.3-flash: the
  // opencode row must NOT answer for it; the known-model catalog does.
  const limits = resolveCoworkModelLimits(config, 'glm-5.3-flash', 'custom-relay');
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.source, 'known-model');
  assert.equal(limits.contextWindow, 1_048_576);
});

test('provider-scoped resolution: disabled named provider still answers (route already resolved)', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'glm-5.3-flash', availableModels: [] },
    providers: {
      zhipu: {
        enabled: false,
        models: [{ id: 'glm-5.3-flash', supportsImage: true, contextWindow: 1_048_576 }],
      },
    },
  }, 'glm-5.3-flash', 'zhipu');
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.source, 'provider-model');
});

// ---------------------------------------------------------------------------
// GLM-5.3-flash family rule: uncatalogued spellings (case variants, unknown
// vendor prefixes) resolve vision=true because they all serve the same
// natively multimodal SKU; the flagship and older families stay text-only.
// ---------------------------------------------------------------------------

test('uncatalogued glm-5.3-flash spellings resolve vision via the family rule', async () => {
  const { resolveCoworkModelLimits, modelSupportsVision } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of ['acme/glm-5.3-flash', 'GLM-5.3-Flash', 'glm-5.3-flash-preview']) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    assert.equal(limits.supportsVision, true, `${modelId} must resolve vision=true`);
    // Family rule carries no window → 128K fallback window → small-window
    // tier: ceiling clamps to the 8K floor (6% of 128K = 7680 < 8K); the
    // family's 128K ceiling only survives on catalogued ids whose window is
    // known (1M).
    assert.equal(limits.maxOutputTokens, 8_192, `${modelId} output ceiling clamps to the fallback window`);
    assert.equal(modelSupportsVision(modelId), true);
  }

  // The flagship stays fail-safe text-only even uncatalogued.
  const flagship = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'acme/glm-5.3');
  assert.equal(flagship.supportsVision, false);
  assert.equal(flagship.source, 'family-model');

  // Older flash variants were text-only — the rule is scoped to 5.3-flash.
  const legacyFlash = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'glm-4.7-flash');
  assert.equal(legacyFlash.supportsVision, false);
});

// ---------------------------------------------------------------------------
// Output-ceiling clamp (2026-09-30 space-bunny-free incident): a stored
// output ceiling that consumes the whole context window made the DSH kernel's
// compaction pressure budget (window - reserved output - headroom) go
// non-positive, which silently disabled proactive compaction for the route —
// small-window models then overflowed, and the reactive summarize call
// overflowed again. Resolution now caps the effective ceiling per window
// tier — 6% of the window below 256K (so the 90% compaction threshold tier
// stays reachable) and 32% at/above 256K, with an 8K floor — for EVERY
// source, stored rows included.
// ---------------------------------------------------------------------------

test('explicit 128K window + 128K output ceiling clamps so proactive compaction stays viable', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The incident shape: a real-128K model stored with the new-model 128K
  // output default left messageBudget = 0 in the kernel.
  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'space-bunny-free', availableModels: [] },
    providers: {
      opencode: {
        enabled: true,
        models: [{ id: 'space-bunny-free', contextWindow: 128_000, maxOutputTokens: 128_000 }],
      },
    },
  }, 'space-bunny-free', 'opencode');
  assert.equal(limits.contextWindow, 128_000);
  // Small-window tier: min(128K, max(8K, floor(128K × 6%) = 7680)) = 8192.
  // Together with the 4% headroom (5120) this leaves a 114.7K pressure
  // budget, so the 90% threshold tier (115.2K) is effectively reached.
  assert.equal(limits.maxOutputTokens, 8_192);
  assert.equal(limits.source, 'provider-model');
});

test('the clamp floor keeps an 8K output budget on tiny windows', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'tiny-model', availableModels: [] },
    providers: {
      local: {
        enabled: true,
        models: [{ id: 'tiny-model', contextWindow: 16_000, maxOutputTokens: 128_000 }],
      },
    },
  }, 'tiny-model', 'local');
  // floor(16000 × 0.06) = 960 < 8192 → the 8K floor wins (thinking models
  // still get a viable reasoning budget; the window is degenerate anyway).
  assert.equal(limits.maxOutputTokens, 8_192);
});

test('the 256K tier boundary switches the ratio from 6% to 32%', async () => {
  const { clampCoworkMaxOutputTokens } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The boundary is intentionally discontinuous: crossing into the ≥256K
  // tier drops the compaction threshold to 80%, which funds the larger
  // output reserve.
  assert.equal(clampCoworkMaxOutputTokens(128_000, 262_143), Math.floor(262_143 * 0.06));
  assert.equal(clampCoworkMaxOutputTokens(128_000, 262_144), Math.floor(262_144 * 0.32));
});

test('catalogued big-window ceilings are never clamped (DeepSeek 1M/256K, GLM 1M/128K)', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  assert.equal(
    resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-flash').maxOutputTokens,
    256_000,
  );
  assert.equal(
    resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'glm-5.3-flash').maxOutputTokens,
    128_000,
  );
});

test('clampCoworkMaxOutputTokens handles degenerate inputs without throwing', async () => {
  const { clampCoworkMaxOutputTokens } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  assert.equal(clampCoworkMaxOutputTokens(128_000, 128_000), 8_192);
  assert.equal(clampCoworkMaxOutputTokens(256_000, 1_000_000), 256_000);
  assert.equal(clampCoworkMaxOutputTokens(8_000, 1_000_000), 8_000);
  assert.equal(clampCoworkMaxOutputTokens(Number.NaN, 128_000), Number.NaN);
  assert.equal(clampCoworkMaxOutputTokens(128_000, 0), 128_000);
  assert.equal(clampCoworkMaxOutputTokens(0, 128_000), 0);
});

test('uncatalogued gemini-4 ids resolve the 1M family window, never the 128K fallback (cw-636ddce2 regression)', async () => {
  const { resolveCoworkModelLimits, modelSupportsVision } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // Session cw-636ddce2 (2026-11-19): gemini-4-argon fetched from the
  // opencode gateway carried NO window metadata, fell through every layer
  // to the 128K fallback, and the cowork baseline (~105K of system + tools)
  // plus one turn overflowed it mid-task — the turn died as a silent empty
  // length-stop. The gemini family rule pins the real 1M window / 64K
  // output ceiling for every uncatalogued gemini-* id.
  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'gemini-4-argon', availableModels: [{ id: 'gemini-4-argon' }] },
    providers: {},
  }, 'gemini-4-argon');
  assert.deepEqual(limits, {
    modelId: 'gemini-4-argon',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsVision: true,
    source: 'family-model',
  });
  // Every Gemini generation is natively multimodal — the vision helper must
  // agree with the family rule (Read-image guard otherwise denies).
  assert.equal(modelSupportsVision('gemini-4-argon'), true);
  assert.equal(modelSupportsVision('opencode/gemini-4-argon'), true);
});

test('gemini family matches on the last path segment across gateway prefixes', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const id of ['google/gemini-4-flash', 'opencode/gemini-4-argon', 'gemini-4-pro-preview-11-25']) {
    const limits = resolveCoworkModelLimits({
      model: { defaultModel: id, availableModels: [{ id }] },
      providers: {},
    }, id);
    assert.equal(limits.source, 'family-model', id);
    assert.equal(limits.contextWindow, 1_000_000, id);
    assert.equal(limits.maxOutputTokens, 65_536, id);
  }
});

test('gemini-3.x exact catalog ids stay at 2M — known-model beats the family rule', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'gemini-3.1-pro-preview');
  assert.equal(limits.contextWindow, 2_000_000);
  assert.equal(limits.source, 'known-model');
});

test('explicit provider metadata still wins over the gemini family rule', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'gemini-4-argon', availableModels: [] },
    providers: {
      opencode: {
        enabled: true,
        models: [{ id: 'gemini-4-argon', contextWindow: 1048576, maxOutputTokens: 65536 }],
      },
    },
  }, 'gemini-4-argon', 'opencode');
  assert.equal(limits.source, 'provider-model');
  assert.equal(limits.contextWindow, 1_048_576);
  assert.equal(limits.maxOutputTokens, 65_536);
});
