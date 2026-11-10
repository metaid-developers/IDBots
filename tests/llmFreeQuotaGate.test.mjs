import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LLM_FREE_PROVIDER_KEY,
  FREE_PROVIDER_DISPLAY_NAME,
  buildFreeProviderRelayModelRow,
  getFreeProviderModelCanonical,
  getFreeProviderModelDisplayName,
  getFreeProviderModelLegacyLimitRewrites,
  isFreeProviderConfigured,
  pickFreeProviderDefaultModelId,
  planFreeProviderCatalogSync,
  planFreeQuotaProvisioning,
} from '../src/renderer/services/llmFreeQuotaGate.js';
import { getDefaultOnboardingProvider } from '../src/renderer/components/onboarding/onboardingDefaults.js';

test('constants stay stable (backend contract)', () => {
  assert.equal(LLM_FREE_PROVIDER_KEY, 'metaid-free');
});

test('the display label is plan-neutral (never suggests a tier)', () => {
  // 2026-11-10: a paying ID.Scholar subscriber saw "IDBots-Free" in the model
  // picker and read it as "still on the free tier". The label must stay
  // plan-neutral ("ID.Bots") — no "-Free" suffix, ever.
  assert.equal(FREE_PROVIDER_DISPLAY_NAME, 'ID.Bots');
  assert.doesNotMatch(FREE_PROVIDER_DISPLAY_NAME, /free/i);
});

test('getFreeProviderModelDisplayName maps relay wire ids to product names', () => {
  assert.equal(getFreeProviderModelDisplayName('deepseek-chat'), 'deepseek-flash');
  // The 2026-10-16 catalog rename: the public id shows the same product name
  // as the legacy alias (the two never coexist in one catalog).
  assert.equal(getFreeProviderModelDisplayName('deepseek-4.1-flash'), 'deepseek-flash');
  assert.equal(getFreeProviderModelDisplayName('another-relay-model'), 'another-relay-model');
  assert.equal(getFreeProviderModelDisplayName(undefined), undefined);
});

test('pickFreeProviderDefaultModelId prefers the DeepSeek flash flagship over catalog order', () => {
  // Owner ruling 2026-11-10: new users start on deepseek-flash regardless of
  // where the relay directory places it (the order is server-owned).
  const reordered = [
    { id: 'glm-5.3-flash' },
    { id: 'deepseek-4.1-flash' },
    { id: 'deepseek-chat' },
  ];
  assert.equal(pickFreeProviderDefaultModelId(reordered), 'deepseek-4.1-flash');
  // Legacy catalog carrying only the hidden alias still resolves to a
  // deepseek-flash wire id.
  assert.equal(pickFreeProviderDefaultModelId([{ id: 'deepseek-chat' }]), 'deepseek-chat');
  // Unknown catalogs fall back to the first entry (unchanged legacy behavior).
  assert.equal(pickFreeProviderDefaultModelId([{ id: 'glm-5.3-flash' }, { id: 'other' }]), 'glm-5.3-flash');
  // Unusable catalogs yield '' so callers keep their existing default.
  assert.equal(pickFreeProviderDefaultModelId([]), '');
  assert.equal(pickFreeProviderDefaultModelId([{ id: '  ' }, undefined]), '');
  assert.equal(pickFreeProviderDefaultModelId(undefined), '');
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
    { contextWindow: false, maxOutputTokens: true, supportsImage: false },
  );
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 64_000, maxOutputTokens: 4_096,
    }),
    { contextWindow: true, maxOutputTokens: true, supportsImage: false },
  );
  // User-tuned values (manual 100K window edit, custom output ceiling) stay.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 100_000, maxOutputTokens: 100_000,
    }),
    { contextWindow: false, maxOutputTokens: false, supportsImage: false },
  );
  // Unknown relay ids have no legacy table.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'future-relay-model', contextWindow: 1_000_000 }),
    { contextWindow: false, maxOutputTokens: false, supportsImage: false },
  );
  // Degenerate rows never throw.
  assert.deepEqual(getFreeProviderModelLegacyLimitRewrites(undefined), {
    contextWindow: false,
    maxOutputTokens: false,
    supportsImage: false,
  });
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'deepseek-chat' }),
    { contextWindow: false, maxOutputTokens: false, supportsImage: false },
  );
});

test('legacy rewrites flag the round-1 supportsImage:false era on deepseek-4.1-flash only', () => {
  // Round-1 catalog machinery pinned supportsImage:false on every
  // deepseek-4.1-flash row it wrote (the id did not exist before, and every
  // writer used the then-canonical false); the 2026-10-16 round-2 server
  // confirmation flipped the canonical to true, so explicit-false rows are
  // the machine era to rewrite. A true row (round-2+ or a user toggle) and
  // the legacy deepseek-chat alias (canonical stays false) are not flagged.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'deepseek-4.1-flash', supportsImage: false }),
    { contextWindow: false, maxOutputTokens: false, supportsImage: true },
  );
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'deepseek-4.1-flash', supportsImage: true }),
    { contextWindow: false, maxOutputTokens: false, supportsImage: false },
  );
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'deepseek-chat', supportsImage: false }),
    { contextWindow: false, maxOutputTokens: false, supportsImage: false },
  );
});

test('getFreeProviderModelCanonical returns null for unknown relay ids', () => {
  assert.equal(getFreeProviderModelCanonical('another-relay-model'), null);
  assert.equal(getFreeProviderModelCanonical(undefined), null);
});

test('getFreeProviderModelCanonical gives deepseek-4.1-flash the flagship profile with vision on', () => {
  // The 2026-10-16 relay catalog rename kept the wire family (same 1M window
  // and effort-max thinking as the legacy alias); the round-2 conf-only pass
  // (2026-10-16) confirmed the upstream V4.1 Flash reads image_url parts
  // through the relay, so the catalog id declares vision while the hidden
  // deepseek-chat alias entry keeps false. maxOutputTokens is the FALLBACK
  // default (relay-reported official ceilings win on every write path).
  const canonical = getFreeProviderModelCanonical('deepseek-4.1-flash');
  assert.ok(canonical);
  assert.equal(canonical.contextWindow, 1_000_000);
  assert.equal(canonical.maxOutputTokens, 100_000);
  assert.equal(canonical.supportsImage, true);
  assert.deepEqual(canonical.options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });
  // No mirror entries for the other relay models: their parameters come from
  // the (now accurate) server directory, not a second client-side table.
  for (const id of ['glm-5.3-flash', 'longcat-2.5-preview-free', 'step-5-preview-free', 'cat-jam-free', 'glyph-cluster-free', 'laguna-s-2.1-free', 'ling-3.0-flash-sante-free']) {
    assert.equal(getFreeProviderModelCanonical(id), null, id);
  }
});

test('relay-row merge: relay-reported limits win, canonical 100K output is only the fallback', () => {
  // Server reports the official ceiling → it wins, no matter the canonical.
  const flagship = buildFreeProviderRelayModelRow({ id: 'deepseek-4.1-flash', contextWindow: 1_000_000, maxOutputTokens: 393_216 });
  assert.equal(flagship.maxOutputTokens, 393_216);
  assert.equal(flagship.contextWindow, 1_000_000);
  assert.equal(flagship.supportsImage, true);
  assert.deepEqual(flagship.options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });

  // Directory omits the ceiling → the canonical 100K default fills in.
  const bare = buildFreeProviderRelayModelRow({ id: 'deepseek-4.1-flash', contextWindow: 1_000_000 });
  assert.equal(bare.maxOutputTokens, 100_000);

  // The hidden alias (never in the directory) fills its whole profile.
  const alias = buildFreeProviderRelayModelRow({ id: 'deepseek-chat' });
  assert.equal(alias.contextWindow, 1_000_000);
  assert.equal(alias.maxOutputTokens, 100_000);
  assert.equal(alias.supportsImage, false);

  // Unknown ids stay bare: relay values only, no canonical fields at all.
  const unknown = buildFreeProviderRelayModelRow({ id: 'glm-5.3-flash', contextWindow: 1_048_576, maxOutputTokens: 131_072 });
  assert.equal(unknown.name, 'glm-5.3-flash');
  assert.equal(unknown.maxOutputTokens, 131_072);
  assert.equal('supportsImage' in unknown, false);
  assert.equal('options' in unknown, false);
});

test('isFreeProviderConfigured requires credentials and models', () => {
  assert.equal(isFreeProviderConfigured(undefined), false);
  assert.equal(isFreeProviderConfigured({ enabled: false, apiKey: 'k', baseUrl: 'u', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: '', baseUrl: 'u', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: '', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: 'u', models: [] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: 'u', models: [{ id: 'm' }] }), true);
});

test('plan: an already provisioned provider needs nothing', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, providerConfigured: true }),
    'none',
  );
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 5, providerConfigured: true }),
    'none',
  );
});

test('plan: existing installs are never touched', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 3, providerConfigured: false }),
    'none',
  );
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 1, providerConfigured: false }),
    'none',
  );
});

test('plan: only a fresh install with no free provider bootstraps', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, providerConfigured: false }),
    'bootstrap',
  );
});

test('plan: degenerate inputs fall back safely', () => {
  assert.equal(planFreeQuotaProvisioning({}), 'bootstrap');
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: Number.NaN }),
    'bootstrap',
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

// The 2026-10-16 production relay directory every quota/bootstrap response
// now reports (assist-base-service, live 2026-10-16): round-2 recalibrated
// context windows, the two flagship models accept vision input, and — after
// the same-day server fix — per-model max_output_tokens matching the upstream
// official ceilings (previously a 4096 global placeholder; that placeholder
// never persisted client-side, the fix landed first). Values below verified
// against the live quota endpoint 2026-10-16.
const RELAY_CATALOG_2026_10_16 = [
  { id: 'deepseek-4.1-flash', contextWindow: 1_000_000, maxOutputTokens: 393_216 },
  { id: 'glm-5.3-flash', contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  { id: 'longcat-2.5-preview-free', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
  { id: 'step-5-preview-free', contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'cat-jam-free', contextWindow: 1_000_000, maxOutputTokens: 8_192 },
  { id: 'glyph-cluster-free', contextWindow: 256_000, maxOutputTokens: 8_192 },
  { id: 'laguna-s-2.1-free', contextWindow: 256_000, maxOutputTokens: 8_192 },
  { id: 'ling-3.0-flash-sante-free', contextWindow: 262_144, maxOutputTokens: 8_192 },
];

const storedLegacyProvider = () => ({
  enabled: true,
  apiKey: 'mrk_legacy-install',
  baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1',
  apiFormat: 'openai',
  name: 'IDBots-Free',
  models: [
    {
      id: 'deepseek-chat',
      name: 'deepseek-flash',
      contextWindow: 1_000_000,
      maxOutputTokens: 100_000,
      supportsImage: false,
      options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
    },
  ],
});

test('catalog sync: quota directory change refreshes provider.models', () => {
  const provider = storedLegacyProvider();
  const next = planFreeProviderCatalogSync(provider, RELAY_CATALOG_2026_10_16);

  assert.ok(next, 'the frozen single-model catalog must be rewritten');
  // The relay list IS the directory: legacy alias dropped, new ids in relay order.
  assert.deepEqual(next.map((model) => model.id), RELAY_CATALOG_2026_10_16.map((model) => model.id));
  // Known id keeps the canonical vision flag + thinking options, but the
  // RELAY-REPORTED limits now win (per-model official ceilings, 2026-10-16
  // server fix) — the canonical 100K output value is only the fallback for
  // rows where neither the directory nor a stored/user value provides one.
  const flagship = next[0];
  assert.equal(flagship.name, 'deepseek-flash');
  assert.equal(flagship.contextWindow, 1_000_000);
  assert.equal(flagship.maxOutputTokens, 393_216);
  assert.equal(flagship.supportsImage, true);
  assert.deepEqual(flagship.options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });
  // Unknown ids keep the relay-reported values bare (id is the display name,
  // no client-side pin to drift from the server directory).
  const glm = next[1];
  assert.equal(glm.name, 'glm-5.3-flash');
  assert.equal(glm.contextWindow, 1_048_576);
  assert.equal(glm.maxOutputTokens, 131_072);
  assert.equal('options' in glm, false);
  assert.equal('supportsImage' in glm, false);
  // The stored provider object itself is never mutated.
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].id, 'deepseek-chat');
});

test('catalog sync: conf-only recalibration refreshes stored windows without id changes', () => {
  // The round-2 server passes corrected contextWindow values and (same day)
  // replaced the 4096 global maxOutputTokens placeholder with per-model
  // official ceilings — both while keeping the id set identical. An install
  // that synced the older numbers must pick the recalibrated values up on
  // the next quota fetch: drift in relay-reported limits alone is a rewrite.
  const syncedRound1 = RELAY_CATALOG_2026_10_16.map((entry) => ({
    id: entry.id,
    name: entry.id,
    ...entry,
  }));
  syncedRound1[2].maxOutputTokens = 4_096; // longcat: the pre-fix server placeholder
  syncedRound1[4].contextWindow = 131_072; // cat-jam-free stale round-1 value
  syncedRound1[5].contextWindow = 131_072; // glyph-cluster-free stale round-1 value
  const provider = { ...storedLegacyProvider(), models: syncedRound1 };

  const next = planFreeProviderCatalogSync(provider, RELAY_CATALOG_2026_10_16);
  assert.ok(next, 'value drift alone must trigger the rewrite');
  assert.deepEqual(next.map((model) => model.id), RELAY_CATALOG_2026_10_16.map((model) => model.id));
  assert.equal(next[2].maxOutputTokens, 131_072, 'longcat adopts the per-model official ceiling');
  assert.equal(next[4].contextWindow, 1_000_000, 'cat-jam-free adopts the recalibrated window');
  assert.equal(next[5].contextWindow, 256_000, 'glyph-cluster-free adopts the recalibrated window');
  // Options and other row fields survive the limit refresh.
  assert.equal(next[4].name, 'cat-jam-free');

  // Once stored values match the directory, the sync is a no-op again.
  assert.equal(planFreeProviderCatalogSync({ ...storedLegacyProvider(), models: next }, RELAY_CATALOG_2026_10_16), null);
});

test('catalog sync: matching directory is a no-op, unusable inputs never empty-replace', () => {
  const synced = RELAY_CATALOG_2026_10_16.map((entry) => ({
    id: entry.id,
    name: entry.id,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
  }));
  const provider = { ...storedLegacyProvider(), models: synced };
  assert.equal(planFreeProviderCatalogSync(provider, RELAY_CATALOG_2026_10_16), null);

  // Empty/absent relay lists and unprovisioned providers never produce a write.
  assert.equal(planFreeProviderCatalogSync(storedLegacyProvider(), []), null);
  assert.equal(planFreeProviderCatalogSync(storedLegacyProvider(), undefined), null);
  assert.equal(planFreeProviderCatalogSync(undefined, RELAY_CATALOG_2026_10_16), null);
  assert.equal(planFreeProviderCatalogSync({ enabled: true, apiKey: 'k', baseUrl: 'u' }, RELAY_CATALOG_2026_10_16), null);

  // Blank ids and duplicates drop out; a surviving id keeps its stored row.
  const next = planFreeProviderCatalogSync(
    storedLegacyProvider(),
    [{ id: '  ' }, { id: 'deepseek-chat' }, { id: 'deepseek-chat' }, { id: 'glm-5.3-flash' }],
  );
  assert.deepEqual(next.map((model) => model.id), ['deepseek-chat', 'glm-5.3-flash']);
  assert.deepEqual(next[0].options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });
});

test('catalog sync: relay-reported limits win on surviving ids, options and vision flag survive', () => {
  const provider = storedLegacyProvider();
  // A user downgraded the stored row's thinking: options survive a sync, but
  // the relay directory owns the numeric limits (mergeSyncedProviderModels
  // convention — endpoint values win over stored rows).
  provider.models[0].options = { reasoningEffort: 'low', thinking: { type: 'enabled' } };
  provider.models[0].supportsImage = true; // user-enabled vision stays on
  const next = planFreeProviderCatalogSync(provider, [
    { id: 'deepseek-chat', contextWindow: 999, maxOutputTokens: 999 },
    { id: 'cat-jam-free' },
  ]);
  assert.deepEqual(next.map((model) => model.id), ['deepseek-chat', 'cat-jam-free']);
  assert.deepEqual(next[0].options, { reasoningEffort: 'low', thinking: { type: 'enabled' } });
  assert.equal(next[0].supportsImage, true);
  assert.equal(next[0].contextWindow, 999);
  assert.equal(next[0].maxOutputTokens, 999);
  // Relay entries without reported limits keep the stored numbers.
  assert.equal(next[1].contextWindow, undefined);
});
