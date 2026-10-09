import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from '../config';
import {
  applyProviderApiFormatMigrations,
  mergeProvidersConfig,
  PROVIDER_API_FORMAT_MIGRATION_VERSION,
} from './config';
import { FREE_PROVIDER_DISPLAY_NAME } from './llmFreeQuotaGate.js';

/**
 * Build a minimal AppConfig with just enough shape for the api-format migration
 * (the migration only reads/writes `providers` + the version stamp).
 */
function makeConfig(
  providers: Record<string, unknown>,
  version?: number,
): AppConfig {
  return {
    api: { key: '', baseUrl: '' },
    model: { availableModels: [], defaultModel: '' },
    providers: providers as AppConfig['providers'],
    theme: 'system',
    language: 'zh',
    app: { port: 3000, isDevelopment: false },
    providerApiFormatMigrationVersion: version,
  } as unknown as AppConfig;
}

test('applyProviderApiFormatMigrations upgrades factory-default opencode to responses', () => {
  const config = makeConfig({
    opencode: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.opencode.apiFormat, 'responses');
  assert.equal(result.providerApiFormatMigrationVersion, PROVIDER_API_FORMAT_MIGRATION_VERSION);
});

test('applyProviderApiFormatMigrations migrates opencode even when an API key is configured', () => {
  // An actively-used opencode (filled-in key) still on the legacy 'openai'
  // default must be upgraded to 'responses', matching the product intent that
  // all opencode users move to the Responses endpoint.
  const config = makeConfig({
    opencode: {
      enabled: true,
      apiKey: 'sk-user-key',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.opencode.apiFormat, 'responses');
});

test('applyProviderApiFormatMigrations leaves manually-chosen responses untouched', () => {
  // User already switched to 'responses' — keep it.
  const config = makeConfig({
    opencode: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'responses',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.opencode.apiFormat, 'responses');
});

test('applyProviderApiFormatMigrations leaves manually-chosen anthropic untouched', () => {
  // A user who deliberately picked the Anthropic-compatible format keeps it.
  const config = makeConfig({
    opencode: {
      enabled: true,
      apiKey: 'sk-user-key',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'anthropic',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.opencode.apiFormat, 'anthropic');
});

test('applyProviderApiFormatMigrations is idempotent at the current version', () => {
  const config = makeConfig(
    {
      opencode: {
        enabled: false,
        apiKey: '',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiFormat: 'openai',
        models: [],
      },
    },
    PROVIDER_API_FORMAT_MIGRATION_VERSION,
  );

  const result = applyProviderApiFormatMigrations(config);
  // Already at target version — no change, not even the field values.
  assert.equal(result.providers!.opencode.apiFormat, 'openai');
});

test('applyProviderApiFormatMigrations does not touch deepseek or other providers', () => {
  const config = makeConfig({
    deepseek: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      models: [],
    },
    openai: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      apiFormat: 'openai',
      models: [],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.deepseek.apiFormat, 'openai');
  assert.equal(result.providers!.openai.apiFormat, 'openai');
});

test('applyProviderApiFormatMigrations v2 moves factory-default deepseek anthropic to openai', () => {
  // Official-harness alignment: configs still parked on the official anthropic
  // endpoint default are migrated to chat completions on the plain base URL.
  const config = makeConfig({
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic',
      models: [],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.deepseek.apiFormat, 'openai');
  assert.equal(result.providers!.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(result.providerApiFormatMigrationVersion, PROVIDER_API_FORMAT_MIGRATION_VERSION);
});

test('applyProviderApiFormatMigrations v2 leaves custom deepseek endpoints untouched', () => {
  // A user behind a self-hosted proxy keeps their format and base URL.
  const config = makeConfig({
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds',
      baseUrl: 'https://my-proxy.example/anthropic',
      apiFormat: 'anthropic',
      models: [],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.deepseek.apiFormat, 'anthropic');
  assert.equal(result.providers!.deepseek.baseUrl, 'https://my-proxy.example/anthropic');
});

test('mergeProvidersConfig rewrites free-provider model names to display names', () => {
  // Users provisioned before the rename have the raw relay id stored as the
  // model name; normalization must map it to the product display name while
  // keeping the wire id (sent to the relay API) untouched.
  const stored = makeConfig({
    'metaid-free': {
      enabled: true,
      apiKey: 'mrk_x',
      baseUrl: 'https://relay.example',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat', supportsImage: false }],
    },
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat', supportsImage: false }],
    },
  });

  const merged = mergeProvidersConfig(undefined, stored.providers);
  const freeModels = merged!['metaid-free']!.models!;
  assert.equal(freeModels[0].id, 'deepseek-chat');
  assert.equal(freeModels[0].name, 'deepseek-flash');
  // A user-configured provider with the same model id keeps its stored name.
  const deepseekModels = merged!.deepseek!.models!;
  assert.equal(deepseekModels[0].name, 'deepseek-chat');
});

test('mergeProvidersConfig bumps the machine-pinned free-model output ceiling but keeps user-tuned values', () => {
  // Relay-reported rows store contextWindow 64000 / maxOutputTokens 4096
  // (both machine-written: the 2026-10-04 pin and the payload's report).
  // Load-time normalization moves the output pin to the 100K declared
  // ceiling (thinking shares the output budget — 4096 truncated effort-max
  // turns after a couple of sentences) and keeps the server-enforced window.
  // User-tuned numbers are NOT canonical values, so they survive untouched —
  // normalization must never revert manual edits (the 2026-10-09 incident).
  const stored = makeConfig({
    'metaid-free': {
      enabled: true,
      apiKey: 'mrk_x',
      baseUrl: 'https://relay.example',
      apiFormat: 'openai',
      models: [
        { id: 'deepseek-chat', name: 'deepseek-chat', contextWindow: 64_000, maxOutputTokens: 4_096, supportsImage: false },
        {
          id: 'deepseek-chat',
          name: 'deepseek-chat',
          contextWindow: 100_000,
          maxOutputTokens: 50_000,
          supportsImage: false,
          options: { reasoningEffort: 'low', thinking: { type: 'disabled' } },
        },
        { id: 'future-relay-model', name: 'future-relay-model', contextWindow: 64_000, maxOutputTokens: 4_096 },
      ],
    },
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat', contextWindow: 64_000, supportsImage: false }],
    },
  });

  const merged = mergeProvidersConfig(undefined, stored.providers);
  const freeModels = merged!['metaid-free']!.models!;
  // Machine-pinned era values: window stays server-enforced, output ceiling
  // moves to the canonical 100K, canonical options fill the empty row.
  assert.equal(freeModels[0].contextWindow, 64_000);
  assert.equal(freeModels[0].maxOutputTokens, 100_000);
  assert.equal(freeModels[0].supportsImage, false);
  assert.equal(freeModels[0].options?.reasoningEffort, 'max');
  assert.deepEqual(freeModels[0].options?.thinking, { type: 'enabled' });
  // Non-legacy stored values (a manual 100K window edit + custom ceiling and
  // effort) stay exactly as stored — stored options win over canonical ones.
  assert.equal(freeModels[1].contextWindow, 100_000);
  assert.equal(freeModels[1].maxOutputTokens, 50_000);
  assert.deepEqual(freeModels[1].options, { reasoningEffort: 'low', thinking: { type: 'disabled' } });
  // Unknown relay ids keep the relay-reported values untouched.
  assert.equal(freeModels[2].contextWindow, 64_000);
  assert.equal(freeModels[2].maxOutputTokens, 4_096);
  assert.equal(freeModels[2].options, undefined);
  // A user-configured provider with the same model id keeps its stored values.
  const deepseekModels = merged!.deepseek!.models!;
  assert.equal(deepseekModels[0].contextWindow, 64_000);
  assert.equal(deepseekModels[0].options, undefined);
});

test('mergeProvidersConfig rewrites the legacy free-provider name to the canonical label', () => {
  // Installs provisioned before the IDBots-Free rename still store
  // "MetaID Free" as the provider name; normalization must force the
  // canonical label so every name-reading surface shows one name.
  const stored = makeConfig({
    'metaid-free': {
      enabled: true,
      apiKey: 'mrk_x',
      baseUrl: 'https://relay.example',
      apiFormat: 'openai',
      name: 'MetaID Free',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat', supportsImage: false }],
    },
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat', supportsImage: false }],
    },
  });

  const merged = mergeProvidersConfig(undefined, stored.providers);
  assert.equal(merged!['metaid-free']!.name, FREE_PROVIDER_DISPLAY_NAME);
  // User-configured providers keep their stored names untouched (named
  // built-in provider types don't declare name; read through the index view).
  const deepseekEntry = merged!['deepseek'] as { name?: string };
  assert.equal(deepseekEntry.name, 'DeepSeek');
});
