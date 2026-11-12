/**
 * Free-quota first-run provisioning gates (pure logic, node-test friendly).
 *
 * The built-in `idbots` provider is provisioned silently on fresh
 * installs so new users can chat with the Twin Bot they create during the
 * welcome flow without configuring an LLM API key. Existing installs (already
 * have MetaBots) are never touched.
 */

export const LLM_FREE_PROVIDER_KEY = 'idbots';
/**
 * Provider key written by installs provisioned before the ID.Bots rename.
 * Stored configs, bot brain hints and relay caches may still carry it, so
 * every read/compare path must canonicalize through canonicalFreeProviderKey.
 */
export const LLM_FREE_PROVIDER_LEGACY_KEY = 'metaid-free';

/**
 * Map a stored provider key onto the canonical free-provider key: the legacy
 * 'metaid-free' (any casing) collapses to LLM_FREE_PROVIDER_KEY; every other
 * value passes through lowercased+trimmed. Returns '' for empty input.
 */
export function canonicalFreeProviderKey(key) {
  const normalized = typeof key === 'string' ? key.trim().toLowerCase() : '';
  return normalized === LLM_FREE_PROVIDER_LEGACY_KEY ? LLM_FREE_PROVIDER_KEY : normalized;
}
/**
 * Canonical user-facing label for the built-in relay provider. Every surface
 * (Settings providerMeta, onboarding labels, model picker groups, provisioning
 * writes, config normalization) must derive the label from here so installs
 * provisioned before a rename never show a legacy name ("MetaID Free", then
 * "IDBots-Free").
 *
 * The label is deliberately plan-neutral: the same provider serves every
 * subscription tier (ID.Free through ID.Scholar), so a "-Free" suffix read as
 * "you are still on the free tier" to paying subscribers (2026-11-10).
 */
export const FREE_PROVIDER_DISPLAY_NAME = 'ID.Bots';

/**
 * User-facing display names for free-relay model ids. Relay ids are internal
 * wire names sent to the API; the UI should show these product names instead.
 */
const FREE_PROVIDER_MODEL_DISPLAY_NAMES = {
  'deepseek-chat': 'deepseek-flash',
  // The 2026-10-16 relay catalog rename: `deepseek-chat` became the public
  // `deepseek-4.1-flash` (chat still routes the old alias server-side, but the
  // models list no longer shows it). Same display name as the legacy id — the
  // two never coexist in one catalog, so no ambiguity in the picker.
  'deepseek-4.1-flash': 'deepseek-flash',
};

export function getFreeProviderModelDisplayName(modelId) {
  if (typeof modelId !== 'string') {
    return modelId;
  }
  return FREE_PROVIDER_MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

/**
 * Relay wire ids preferred as the DEFAULT model, best first. Both render as
 * "deepseek-flash" (FREE_PROVIDER_MODEL_DISPLAY_NAMES) and never coexist in
 * one catalog.
 */
const FREE_PROVIDER_PREFERRED_DEFAULT_MODEL_IDS = ['deepseek-4.1-flash', 'deepseek-chat'];

/**
 * Pick the default model id out of the built-in provider's catalog: the
 * DeepSeek flash flagship when the catalog carries it, else the first entry;
 * '' for an empty/unusable catalog.
 *
 * New installs must start on deepseek-flash (owner decision 2026-11-10). The
 * relay directory order is server-owned, so "first entry" alone would let a
 * reordered directory silently change every new user's out-of-the-box brain.
 */
export function pickFreeProviderDefaultModelId(models) {
  const ids = Array.isArray(models)
    ? models
        .map((model) => (typeof model?.id === 'string' ? model.id.trim() : ''))
        .filter(Boolean)
    : [];
  if (ids.length === 0) {
    return '';
  }
  for (const preferred of FREE_PROVIDER_PREFERRED_DEFAULT_MODEL_IDS) {
    if (ids.includes(preferred)) {
      return preferred;
    }
  }
  return ids[0];
}

/**
 * Canonical client-side limits/options for known free-relay model ids.
 *
 * The relay upstream previously enforced the legacy DeepSeek V3 wire values
 * for `deepseek-chat` (context_window 64000 — server-confirmed 2026-10-04,
 * requests beyond ~64K tokens died with 400 "maximum context length"). The
 * owner confirmed on 2026-10-09 that the upstream has been upgraded past
 * that limit, so the window now mirrors the DeepSeek V4 flash family's 1M
 * (keep in sync with DEEPSEEK_V4_FLASH_CONTEXT_WINDOW in
 * src/main/libs/coworkModelLimits.ts). Auto-compaction re-arms accordingly
 * at min(0.8*1M, 1M-100K-40K) = 800K tokens.
 *
 * max_output_tokens: the canonical value is the FALLBACK default of 100K
 * (owner decision 2026-10-09; re-scoped 2026-10-16) — it applies only when
 * neither the relay directory nor a stored/user value provides a ceiling.
 * The relay's per-model official ceilings (reported since the 2026-10-16
 * server fix) are authoritative and WIN over the fallback on every write
 * path; thinking shares the output budget, so a generous default ceiling
 * costs nothing for short replies (billing is by actual tokens used).
 *
 * supportsImage is verified per id: the upstream DeepSeek V4.1 Flash family
 * is natively multimodal and the relay forwards standard OpenAI image_url
 * content arrays to the upstream verbatim (server-confirmed 2026-10-16), so
 * the catalog flagship id declares vision; the legacy `deepseek-chat` alias
 * entry keeps false (hidden alias with no catalog row to flip). Ids absent
 * from this table keep whatever the relay reported — the 2026-10-16
 * recalibrated directory (glm-5.3-flash included) reports accurate
 * parameters itself, so no mirror entries are maintained for them.
 */
const FREE_PROVIDER_MODEL_CANONICAL = {
  // The hidden wire alias: absent from the relay directory (server routes
  // chat to it), so its numbers only ever act as load-time fills.
  'deepseek-chat': {
    contextWindow: 1_000_000,
    maxOutputTokens: 100_000,
    supportsImage: false,
    options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
  },
  // The 2026-10-16 relay catalog flagship (rename of the deepseek-chat alias):
  // same wire family — 1M window, effort-max thinking, vision ON (the relay
  // transparently passes image_url parts through and the upstream V4.1 Flash
  // reads them natively). Its 100K output ceiling is the fallback default;
  // the directory's per-model official ceiling (393216) wins whenever
  // reported.
  'deepseek-4.1-flash': {
    contextWindow: 1_000_000,
    maxOutputTokens: 100_000,
    supportsImage: true,
    options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
  },
};

/**
 * Machine-written legacy limit values on stored free-relay model rows, keyed
 * by model id. Every value listed here was pinned by an earlier build's
 * provisioning or load-time normalization — the Settings model editor has no
 * output-ceiling field at all, and provisioning always writes canonical or
 * relay-reported numbers — so an EXACT stored match identifies the era that
 * wrote the row rather than a user choice:
 * - maxOutputTokens 32_768: the pre-2026-10-04 canonical that mirrored the
 *   deepseek-flash preset.
 * - maxOutputTokens 4_096: the 2026-10-04 pin (also what the relay payload
 *   reported); raised to the 2026-10-09 100K declared ceiling.
 * - contextWindow 64_000: the 2026-10-04 server-enforced pin; superseded on
 *   2026-10-09 when the owner confirmed the upstream upgrade past 64K, so
 *   those rows bump to the canonical 1M window.
 * - supportsImage false on 'deepseek-4.1-flash': written by the round-1
 *   catalog machinery (bootstrap provision, quota-driven sync, or the
 *   load-time canonical fill) before the 2026-10-16 round-2 vision
 *   confirmation flipped the canonical to true. The id did not exist before
 *   round 1 and every writer pinned false, so an explicit false identifies
 *   that era — those rows flip to the canonical true at load time.
 * Anything else a row stores (user-tuned values included) is kept untouched.
 */
const FREE_PROVIDER_MODEL_LEGACY_STORED_LIMITS = {
  'deepseek-chat': {
    contextWindow: new Set([64_000]),
    maxOutputTokens: new Set([32_768, 4_096]),
  },
  'deepseek-4.1-flash': {
    supportsImage: new Set([false]),
  },
};

/**
 * Which of the given stored model row's fields hold a machine-pinned legacy
 * value and must be rewritten to the current canonical value at load time.
 * Flags only — the caller resolves the replacement from
 * getFreeProviderModelCanonical so the two tables cannot drift apart.
 */
export function getFreeProviderModelLegacyLimitRewrites(model) {
  const table = model ? FREE_PROVIDER_MODEL_LEGACY_STORED_LIMITS[model.id] : undefined;
  return {
    contextWindow: table?.contextWindow ? table.contextWindow.has(model.contextWindow) : false,
    maxOutputTokens: table?.maxOutputTokens ? table.maxOutputTokens.has(model.maxOutputTokens) : false,
    supportsImage: table?.supportsImage ? table.supportsImage.has(model.supportsImage ?? false) : false,
  };
}

/**
 * Canonical config overrides for a free-relay model id, or null when the id
 * is unknown (callers then keep the relay-provided values). Returns a fresh
 * object per call so stored configs never share references with the table.
 */
export function getFreeProviderModelCanonical(modelId) {
  if (typeof modelId !== 'string') {
    return null;
  }
  const canonical = FREE_PROVIDER_MODEL_CANONICAL[modelId];
  if (!canonical) {
    return null;
  }
  return {
    contextWindow: canonical.contextWindow,
    maxOutputTokens: canonical.maxOutputTokens,
    supportsImage: canonical.supportsImage,
    options: canonical.options
      ? {
          ...canonical.options,
          thinking: canonical.options.thinking ? { ...canonical.options.thinking } : undefined,
        }
      : undefined,
  };
}

/**
 * Build a NEW stored row from one relay catalog entry (bootstrap provisioning
 * and catalog sync share this merge). Precedence for the numeric limits: the
 * relay-reported values win — the directory has carried per-model official
 * ceilings since the 2026-10-16 server fix — and the canonical table only
 * FILLS what the directory omits (the 100K output default included). The
 * canonical-only fields (verified vision flag, thinking options) apply to
 * known ids as before; unknown ids keep the bare relay-reported shape.
 */
export function buildFreeProviderRelayModelRow(entry) {
  const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
  const canonical = getFreeProviderModelCanonical(id);
  const row = {
    id,
    name: getFreeProviderModelDisplayName(id),
    contextWindow: entry?.contextWindow ?? canonical?.contextWindow,
    maxOutputTokens: entry?.maxOutputTokens ?? canonical?.maxOutputTokens,
  };
  if (canonical) {
    row.supportsImage = canonical.supportsImage;
    row.options = canonical.options;
  }
  return row;
}

/**
 * A provider entry counts as provisioned only when bootstrap has filled in
 * connection credentials AND at least one model.
 */
export function isFreeProviderConfigured(provider) {
  return !!(
    provider &&
    provider.enabled &&
    typeof provider.apiKey === 'string' && provider.apiKey.trim() !== '' &&
    typeof provider.baseUrl === 'string' && provider.baseUrl.trim() !== '' &&
    Array.isArray(provider.models) && provider.models.length > 0
  );
}

/**
 * Decide the first-run provisioning action.
 *
 * - 'none':      the free provider is already usable, or this is an existing
 *                install (has MetaBots) whose configuration must stay
 *                untouched.
 * - 'bootstrap': fresh install — claim the relay key and write it into the
 *                `idbots` provider before the Twin Bot is created, so the
 *                new bot has a brain to run on.
 *
 * No bot is ever created here: the user's Twin Bot comes from the welcome
 * flow's "Enter IDBots" click (see components/onboarding/WelcomeFlow.tsx).
 */
export function planFreeQuotaProvisioning(input) {
  const metabotCount = Number.isFinite(input?.metabotCount) ? Math.floor(input.metabotCount) : 0;
  if (input?.providerConfigured) return 'none';
  if (metabotCount > 0) return 'none';
  return 'bootstrap';
}

/**
 * Plan a catalog sync for an already-provisioned free provider from the relay
 * catalog a quota/bootstrap response reported (2026-10-16: the server grew
 * from the single `deepseek-chat` to a public multi-model directory, but
 * existing installs have provider.models frozen at their bootstrap-era list
 * and planFreeQuotaProvisioning says 'none' for them — only this sync moves
 * them forward, without a new bootstrap that would reissue the relay key).
 *
 * Returns the next `models` array, or null when nothing should be written:
 * - null when the id sets match AND every relay-reported limit matches the
 *   stored row, the relay list is empty/unusable (never an empty replace —
 *   same convention as mergeSyncedProviderModels), or the provider has no
 *   stored catalog to compare against.
 * - The relay list IS the directory: ids it dropped disappear, new ids appear
 *   in relay order. Surviving ids keep their stored row except that
 *   relay-reported contextWindow/maxOutputTokens win (the 2026-10-16 round-2
 *   conf-only recalibration changed window values without touching the id
 *   set; the server directory is the single source of truth for the
 *   non-canonical ids — same convention as mergeSyncedProviderModels, where
 *   the endpoint-reported context wins over the stored row). User-tuned
 *   `options` (thinking/effort picks) and the vision flag survive untouched.
 * - New ids get the shared relay-row merge (buildFreeProviderRelayModelRow):
 *   relay-reported limits first, canonical fills for what the directory
 *   omits (100K output default), canonical vision flag and thinking options
 *   for known ids.
 */
export function planFreeProviderCatalogSync(provider, relayModels) {
  if (!provider || !Array.isArray(provider.models)) {
    return null;
  }
  if (!Array.isArray(relayModels)) {
    return null;
  }
  const seen = new Set();
  const catalog = [];
  for (const entry of relayModels) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    catalog.push(entry);
  }
  if (catalog.length === 0) {
    return null;
  }
  const currentIds = new Set(
    provider.models
      .map((model) => (typeof model?.id === 'string' ? model.id.trim() : ''))
      .filter(Boolean),
  );
  const storedById = new Map(provider.models.map((model) => [model.id, model]));
  const changed = catalog.some((entry) => {
    const id = entry.id.trim();
    if (!currentIds.has(id) || !seen.has(id)) {
      return true;
    }
    const stored = storedById.get(id);
    return (entry.contextWindow !== undefined && entry.contextWindow !== stored?.contextWindow)
      || (entry.maxOutputTokens !== undefined && entry.maxOutputTokens !== stored?.maxOutputTokens);
  })
    || [...currentIds].some((id) => !seen.has(id));
  if (!changed) {
    return null;
  }
  return catalog.map((entry) => {
    const id = entry.id.trim();
    const stored = storedById.get(id);
    if (stored) {
      return {
        ...stored,
        contextWindow: entry.contextWindow ?? stored.contextWindow,
        maxOutputTokens: entry.maxOutputTokens ?? stored.maxOutputTokens,
      };
    }
    return buildFreeProviderRelayModelRow(entry);
  });
}
