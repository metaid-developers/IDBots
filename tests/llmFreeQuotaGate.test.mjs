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

test('getFreeProviderModelCanonical pins the server-enforced window and the 100K declared output ceiling', () => {
  // context_window: server-confirmed 2026-10-04 — the metaid-free upstream
  // rejects requests beyond ~64K tokens with 400 "maximum context length" no
  // matter what the client believes, so the canonical must stay at 64000 or
  // auto-compaction re-arms at an unreachable trigger (the 413 wedge).
  // max_output_tokens: 100K declared ceiling (owner decision 2026-10-09) —
  // thinking shares the output budget and the old 4096 pin truncated
  // effort-max turns after a couple of sentences. The resolved per-turn
  // budget is window-clamped downstream (clampCoworkMaxOutputTokens → 8192
  // at 64K), so compaction still triggers at
  // min(0.9*64000, 64000-8192-2560) ≈ 53K tokens.
  const canonical = getFreeProviderModelCanonical('deepseek-chat');
  assert.ok(canonical);
  assert.equal(canonical.contextWindow, 64_000);
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
  // also what the relay payload reports). Those exact values are rewritten
  // to the current canonical at load time; anything else on the row (user
  // edits included) must survive untouched.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 1_000_000, maxOutputTokens: 32_768,
    }),
    { contextWindow: true, maxOutputTokens: true },
  );
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 64_000, maxOutputTokens: 4_096,
    }),
    { contextWindow: false, maxOutputTokens: true },
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
