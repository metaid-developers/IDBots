import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyProviderApiFormatMigrations,
  applyProviderModelMigrations,
  PROVIDER_MODEL_MIGRATION_VERSION,
} from '../src/renderer/services/config.ts';

type MigrationInput = Parameters<typeof applyProviderModelMigrations>[0];

const asConfig = (value: unknown): MigrationInput => value as MigrationInput;

// The zhipu store shape before the GLM-5.3 coding-plan line: preset catalog
// glm-5.1/5/4.7 on the factory-default anthropic endpoint.
function legacyZhipuConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: { defaultModel: 'glm-5.1' },
    providerModelMigrationVersion: 1,
    providerApiFormatMigrationVersion: 2,
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiFormat: 'anthropic',
        models: [
          { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, contextWindow: 202_800 },
          { id: 'glm-5', name: 'GLM 5', supportsImage: false, contextWindow: 202_800 },
          { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false, contextWindow: 204_800 },
          // A user-added custom model — migrations must never touch it.
          { id: 'glm-4.5-air', name: 'GLM 4.5 Air (custom)', supportsImage: false },
        ],
      },
    },
    ...overrides,
  };
}

test('model migration v2 retires the pre-5.3 zhipu presets and injects the GLM-5.3 family', () => {
  const migrated = applyProviderModelMigrations(asConfig(legacyZhipuConfig()));

  const zhipu = migrated.providers.zhipu!;
  assert.deepEqual(
    zhipu.models!.map((model) => model.id),
    ['glm-5.3', 'glm-5.3-flash', 'glm-4.5-air'],
    'new presets prepend, retired presets drop, custom models survive',
  );
  assert.equal(zhipu.models![0].contextWindow, 1_048_576);
  assert.equal(zhipu.models![1].supportsImage, true);
  // The retired default remaps to the new flagship.
  assert.equal(migrated.model.defaultModel, 'glm-5.3');
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});

test('model migration v2 is idempotent and leaves deepseek untouched', () => {
  const base = asConfig(legacyZhipuConfig({
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai',
        models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      },
      zhipu: (legacyZhipuConfig() as { providers: { zhipu: object } }).providers.zhipu,
    },
  }));
  const once = applyProviderModelMigrations(base);
  const twice = applyProviderModelMigrations(once);

  assert.deepEqual(twice.providers.zhipu, once.providers.zhipu);
  assert.deepEqual(twice.providers.deepseek, base.providers.deepseek, 'deepseek never participates');
});

test('model migrations from version 0 chain v1 then v2: v1-injected glm-5.1 is retired again', () => {
  // A pre-2026-07 store: v1 injects glm-5.1 for zhipu, v2 immediately retires
  // it — the final catalog is the GLM-5.3 family regardless of entry version.
  const migrated = applyProviderModelMigrations(asConfig(legacyZhipuConfig({
    model: { defaultModel: 'glm-4.7' },
    providerModelMigrationVersion: 0,
    providers: {
      zhipu: {
        enabled: false,
        apiKey: '',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false, contextWindow: 204_800 }],
      },
    },
  })));

  assert.deepEqual(
    migrated.providers.zhipu!.models!.map((model) => model.id),
    ['glm-5.3', 'glm-5.3-flash'],
  );
  assert.equal(migrated.model.defaultModel, 'glm-5.3');
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});

test('api-format migrations carry the factory-default anthropic zhipu config to chat completions', () => {
  // v3 anthropic → responses, then v4 responses → openai chat completions:
  // the factory default is now the wire where GLM thinking can be disabled.
  const migrated = applyProviderApiFormatMigrations(asConfig(legacyZhipuConfig()));

  const zhipu = migrated.providers.zhipu!;
  assert.equal(zhipu.apiFormat, 'openai');
  assert.equal(zhipu.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
  assert.equal(migrated.providerApiFormatMigrationVersion, 4);
  // Already-migrated configs stay put on a second pass.
  const twice = applyProviderApiFormatMigrations(migrated);
  assert.deepEqual(twice.providers.zhipu, zhipu);
});

test('api-format migration v4 moves the v3 factory-default responses zhipu config to chat completions', () => {
  const migrated = applyProviderApiFormatMigrations(asConfig({
    providerApiFormatMigrationVersion: 3,
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/v1',
        apiFormat: 'responses',
        models: [],
      },
    },
  }));

  const zhipu = migrated.providers.zhipu!;
  assert.equal(zhipu.apiFormat, 'openai');
  assert.equal(zhipu.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
  assert.equal(migrated.providerApiFormatMigrationVersion, 4);
});

test('api-format migration v4 never touches custom responses proxies or explicit other formats', () => {
  const custom = applyProviderApiFormatMigrations(asConfig({
    providerApiFormatMigrationVersion: 3,
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-zhipu',
        baseUrl: 'https://my-relay.example.com/api/v1',
        apiFormat: 'responses',
        models: [],
      },
    },
  }));
  assert.equal(custom.providers.zhipu!.apiFormat, 'responses');
  assert.equal(custom.providers.zhipu!.baseUrl, 'https://my-relay.example.com/api/v1');

  const explicit = applyProviderApiFormatMigrations(asConfig({
    providerApiFormatMigrationVersion: 3,
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/v1',
        apiFormat: 'responses',
        models: [],
      },
      deepseek: {
        enabled: true,
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai',
        models: [],
      },
    },
  }));
  assert.equal(explicit.providers.deepseek!.apiFormat, 'openai');
  assert.equal(explicit.providers.deepseek!.baseUrl, 'https://api.deepseek.com');
});

test('api-format migration v3 never touches custom base URLs or other formats', () => {
  const proxy = applyProviderApiFormatMigrations(asConfig(legacyZhipuConfig({
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://my-proxy.example.com/anthropic',
        apiFormat: 'anthropic',
        models: [],
      },
    },
  })));
  assert.equal(proxy.providers.zhipu!.apiFormat, 'anthropic');
  assert.equal(proxy.providers.zhipu!.baseUrl, 'https://my-proxy.example.com/anthropic');

  const openai = applyProviderApiFormatMigrations(asConfig(legacyZhipuConfig({
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiFormat: 'openai',
        models: [],
      },
    },
  })));
  assert.equal(openai.providers.zhipu!.apiFormat, 'openai');
  assert.equal(openai.providers.zhipu!.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
});

// ---------------------------------------------------------------------------
// Model migration v3 (2026-09-28): GLM-5.3-Flash vision flip across every
// provider. The SKU is natively multimodal and all gateways proxy the same
// upstream model, but rows created before the capability was known carry the
// fail-safe supportsImage:false default — which kept every gateway-served
// GLM-5.3 Flash from reading images. The flip is one-shot (version-stamped)
// and idempotent.
// ---------------------------------------------------------------------------

/** The stored-config shape of the 2026-09-28 incident machine. */
function glmFlashGatewayConfig(): unknown {
  return {
    model: { defaultModel: 'glm-5.3-flash' },
    providerModelMigrationVersion: 2,
    providers: {
      opencode: {
        enabled: true,
        apiKey: 'sk-oc',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: [
          { id: 'glm-5.3-flash', name: 'glm-5.3-flash', supportsImage: false },
          { id: 'glm-5.3', name: 'glm-5.3', supportsImage: false },
        ],
      },
      commandcode: {
        enabled: true,
        apiKey: 'sk-cc',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        models: [
          { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash', supportsImage: false, contextWindow: 1_048_576 },
        ],
      },
      'custom-scnet': {
        enabled: true,
        apiKey: 'sk-sc',
        baseUrl: 'https://api.scnet.cn/api/llm/v1',
        models: [
          { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', supportsImage: false },
        ],
      },
      zhipu: {
        enabled: true,
        apiKey: 'sk-zp',
        baseUrl: 'https://open.bigmodel.cn/api/v1',
        models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', supportsImage: true, contextWindow: 1_048_576 },
        ],
      },
      deepseek: {
        enabled: true,
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com',
        models: [
          { id: 'glm-5.3-flash', name: 'hypothetical deepseek-row copy', supportsImage: false },
        ],
      },
    },
  };
}

test('model migration v3 flips GLM-5.3-Flash rows to vision on every provider (gateway prefixes and case variants included)', () => {
  const migrated = applyProviderModelMigrations(asConfig(glmFlashGatewayConfig()));

  const byId = (provider: string, id: string) =>
    migrated.providers[provider]!.models!.find((model) => model.id === id)!;

  // Bare gateway id — the fail-safe false default becomes true.
  assert.equal(byId('opencode', 'glm-5.3-flash').supportsImage, true);
  // Vendor-prefixed id matches on the last path segment.
  assert.equal(byId('commandcode', 'z-ai/glm-5.3-flash').supportsImage, true);
  // Case variants match case-insensitively.
  assert.equal(byId('custom-scnet', 'GLM-5.3-Flash').supportsImage, true);
  // Already-checked rows are untouched (same value).
  assert.equal(byId('zhipu', 'glm-5.3-flash').supportsImage, true);
  // The text-only flagship never flips.
  assert.equal(byId('opencode', 'glm-5.3').supportsImage, false);
  // deepseek never participates in model migrations.
  assert.equal(byId('deepseek', 'glm-5.3-flash').supportsImage, false);
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});

test('model migration v3 is idempotent — a second pass changes nothing', () => {
  const once = applyProviderModelMigrations(asConfig(glmFlashGatewayConfig()));
  const twice = applyProviderModelMigrations(once);
  assert.deepEqual(twice.providers, once.providers);
  assert.equal(twice.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});

test('v3-stamped configs run no migrations at all', () => {
  const stamped = asConfig({
    ...glmFlashGatewayConfig(),
    providerModelMigrationVersion: PROVIDER_MODEL_MIGRATION_VERSION,
  });
  const migrated = applyProviderModelMigrations(stamped);
  assert.equal(migrated.providers.opencode!.models![0].supportsImage, false);
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});

test('model migration v4 replaces the retired Seed 1.6 volcengine preset with the current catalog', () => {
  const migrated = applyProviderModelMigrations(asConfig({
    model: { defaultModel: 'doubao-seed-1-6-250615' },
    providerModelMigrationVersion: 3,
    providerApiFormatMigrationVersion: 4,
    providers: {
      volcengine: {
        enabled: true,
        apiKey: 'ark-test',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiFormat: 'openai',
        models: [
          { id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6', supportsImage: false, contextWindow: 256_000 },
          { id: 'doubao-seed-1-6-flash-250717', name: 'Doubao Seed 1.6 Flash', supportsImage: false, contextWindow: 256_000 },
          { id: 'my-custom-relay-sku', name: 'Custom SKU', supportsImage: false },
        ],
      },
    },
  }));

  const models = migrated.providers.volcengine!.models!;
  const ids = models.map((model) => model.id);
  // Retired snapshot ids are gone; the current stable-alias chat set is here.
  assert.equal(ids.includes('doubao-seed-1-6-250615'), false);
  assert.equal(ids.includes('doubao-seed-1-6-flash-250717'), false);
  for (const expected of ['doubao-seed-evolving', 'doubao-seed-2-1-pro', 'kimi-k3-1-pro', 'deepseek-v4-1-flash', 'glm-5-3-flash']) {
    assert.equal(ids.includes(expected), true, expected);
  }
  // Custom rows outside the removed set survive.
  assert.equal(ids.includes('my-custom-relay-sku'), true);
  // A stale default selection remaps to the closest current SKU.
  assert.equal(migrated.model.defaultModel, 'doubao-seed-2-1-lite');
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});

test('model migration v4 is idempotent', () => {
  const once = applyProviderModelMigrations(asConfig({
    model: { defaultModel: 'doubao-seed-1-6-250615' },
    providerModelMigrationVersion: 3,
    providerApiFormatMigrationVersion: 4,
    providers: {
      volcengine: {
        enabled: true,
        apiKey: 'ark-test',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiFormat: 'openai',
        models: [
          { id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6', supportsImage: false, contextWindow: 256_000 },
        ],
      },
    },
  }));
  const twice = applyProviderModelMigrations(once);
  assert.deepEqual(twice.providers, once.providers);
  assert.equal(twice.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});
