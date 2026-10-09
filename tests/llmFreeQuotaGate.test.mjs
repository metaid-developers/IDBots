import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LLM_FREE_PROVIDER_KEY,
  LLM_RELAY_WELCOME_BOT_ID_KEY,
  getFreeProviderModelCanonical,
  getFreeProviderModelDisplayName,
  getFreeProviderModelLegacyLimitRewrites,
  isFreeProviderConfigured,
  planFreeQuotaProvisioning,
} from '../src/renderer/services/llmFreeQuotaGate.js';
import { getDefaultOnboardingProvider } from '../src/renderer/components/onboarding/onboardingDefaults.js';

test('constants stay stable (backend + kv contracts)', () => {
  assert.equal(LLM_FREE_PROVIDER_KEY, 'metaid-free');
  assert.equal(LLM_RELAY_WELCOME_BOT_ID_KEY, 'llmRelay.welcomeBotId');
});

test('getFreeProviderModelDisplayName maps relay wire ids to product names', () => {
  assert.equal(getFreeProviderModelDisplayName('deepseek-chat'), 'deepseek-flash');
  assert.equal(getFreeProviderModelDisplayName('another-relay-model'), 'another-relay-model');
  assert.equal(getFreeProviderModelDisplayName(undefined), undefined);
});

test('getFreeProviderModelCanonical pins the upgraded 1M window and the 100K declared output ceiling', () => {
  // context_window: the upstream relay previously enforced 64K (server-
  // confirmed 2026-10-04); the owner confirmed on 2026-10-09 that it has
  // been upgraded past that limit, so the canonical mirrors the DeepSeek V4
  // flash family's 1M and compaction re-arms at
  // min(0.8*1M, 1M-100K-40K) = 800K tokens.
  // max_output_tokens: 100K declared ceiling (owner decision 2026-10-09) —
  // thinking shares the output budget and the old 4096 pin truncated
  // effort-max turns after a couple of sentences. At the 1M window the
  // resolution-time clamp (32% tier) leaves the full 100K effective.
  const canonical = getFreeProviderModelCanonical('deepseek-chat');
  assert.ok(canonical);
  assert.equal(canonical.contextWindow, 1_000_000);
  assert.equal(canonical.maxOutputTokens, 100_000);
  assert.equal(canonical.supportsImage, false);
  assert.equal(canonical.options.reasoningEffort, 'max');
  assert.deepEqual(canonical.options.thinking, { type: 'enabled' });
  // Fresh object per call: mutating the result must not pollute the table.
  canonical.options.thinking.type = 'disabled';
  assert.equal(getFreeProviderModelCanonical('deepseek-chat').options.thinking.type, 'enabled');
});

test('getFreeProviderModelLegacyLimitRewrites flags only machine-pinned legacy stored values', () => {
  // Eras that wrote free-model rows machine-side: the pre-2026-10-04
  // deepseek-flash mirror (1M/32768) and the 2026-10-04 pin (64000/4096 —
  // also what the relay payload reported). The output pins move to the 100K
  // declared ceiling and the 64K window pin bumps to the upgraded 1M;
  // anything else on the row (user edits included) must survive untouched.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 1_000_000, maxOutputTokens: 32_768,
    }),
    { contextWindow: false, maxOutputTokens: true },
  );
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 64_000, maxOutputTokens: 4_096,
    }),
    { contextWindow: true, maxOutputTokens: true },
  );
  // User-tuned values (manual 100K window edit, custom output ceiling) stay.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 100_000, maxOutputTokens: 100_000,
    }),
    { contextWindow: false, maxOutputTokens: false },
  );
  // Unknown relay ids have no legacy table.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'future-relay-model', contextWindow: 1_000_000 }),
    { contextWindow: false, maxOutputTokens: false },
  );
  // Degenerate rows never throw.
  assert.deepEqual(getFreeProviderModelLegacyLimitRewrites(undefined), {
    contextWindow: false,
    maxOutputTokens: false,
  });
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'deepseek-chat' }),
    { contextWindow: false, maxOutputTokens: false },
  );
});

test('getFreeProviderModelCanonical returns null for unknown relay ids', () => {
  assert.equal(getFreeProviderModelCanonical('another-relay-model'), null);
  assert.equal(getFreeProviderModelCanonical(undefined), null);
});

test('isFreeProviderConfigured requires credentials and models', () => {
  assert.equal(isFreeProviderConfigured(undefined), false);
  assert.equal(isFreeProviderConfigured({ enabled: false, apiKey: 'k', baseUrl: 'u', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: '', baseUrl: 'u', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: '', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: 'u', models: [] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: 'u', models: [{ id: 'm' }] }), true);
});

test('plan: already provisioned => none (deletion-respecting)', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, welcomeBotId: 7, providerConfigured: true }),
    'none',
  );
  // Even if the user deleted the bot (count back to 0), the persisted id wins.
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, welcomeBotId: 7, providerConfigured: false }),
    'none',
  );
});

test('plan: existing installs are never touched', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 3, welcomeBotId: null, providerConfigured: false }),
    'none',
  );
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 1, welcomeBotId: null, providerConfigured: true }),
    'none',
  );
});

test('plan: fresh install bootstraps; partial state only creates the bot', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, welcomeBotId: null, providerConfigured: false }),
    'bootstrap-and-create-bot',
  );
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, welcomeBotId: null, providerConfigured: true }),
    'create-bot-only',
  );
});

test('plan: degenerate inputs fall back safely', () => {
  assert.equal(planFreeQuotaProvisioning({}), 'bootstrap-and-create-bot');
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: Number.NaN, welcomeBotId: Number.NaN }),
    'bootstrap-and-create-bot',
  );
});

test('onboarding default: provisioned free provider wins, else legacy defaults', () => {
  const provisioned = { 'metaid-free': { enabled: true, apiKey: 'mrk_x', baseUrl: 'https://relay' } };
  assert.equal(getDefaultOnboardingProvider('zh', provisioned), 'metaid-free');
  assert.equal(getDefaultOnboardingProvider('en', provisioned), 'metaid-free');
  const unprovisioned = { 'metaid-free': { enabled: false, apiKey: '', baseUrl: '' } };
  assert.equal(getDefaultOnboardingProvider('zh', unprovisioned), 'deepseek');
  assert.equal(getDefaultOnboardingProvider('en', unprovisioned), 'openai');
  assert.equal(getDefaultOnboardingProvider('zh'), 'deepseek');
  assert.equal(getDefaultOnboardingProvider('en'), 'openai');
});
