/**
 * Free-quota first-run provisioning gates (pure logic, node-test friendly).
 *
 * The built-in `metaid-free` provider is provisioned silently on fresh
 * installs so new users can chat with the welcome bot without configuring an
 * LLM API key. Existing installs (already have MetaBots) are never touched.
 */

export const LLM_FREE_PROVIDER_KEY = 'metaid-free';
/**
 * Canonical user-facing label for the built-in free provider. Every surface
 * (Settings providerMeta, onboarding labels, model picker groups, provisioning
 * writes, config normalization) must derive the label from here so installs
 * provisioned before the rename never show the legacy "MetaID Free" name.
 */
export const FREE_PROVIDER_DISPLAY_NAME = 'IDBots-Free';
/** kvStore key holding the provisioned welcome bot's id (deletion-respecting). */
export const LLM_RELAY_WELCOME_BOT_ID_KEY = 'llmRelay.welcomeBotId';

/**
 * User-facing display names for free-relay model ids. Relay ids are internal
 * wire names sent to the API; the UI should show these product names instead.
 */
const FREE_PROVIDER_MODEL_DISPLAY_NAMES = {
  'deepseek-chat': 'deepseek-flash',
};

export function getFreeProviderModelDisplayName(modelId) {
  if (typeof modelId !== 'string') {
    return modelId;
  }
  return FREE_PROVIDER_MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

/**
 * Canonical client-side limits/options for known free-relay model ids. The
 * relay upstream enforces the legacy DeepSeek V3 wire values for
 * `deepseek-chat` — context_window 64000 / max_output_tokens 4096
 * (server-confirmed 2026-10-04: requests beyond ~64K tokens are rejected by
 * the upstream with 400 "maximum context length" no matter what the client
 * believes), so the known id mirrors those exact values (the relay's
 * bootstrap/models payload reports the same numbers; the table pins them so
 * a future relay-side drift cannot silently re-wedge compaction).
 * supportsImage stays false because the relay's image support is unverified.
 * Ids absent from this table keep whatever the relay reported.
 */
const FREE_PROVIDER_MODEL_CANONICAL = {
  'deepseek-chat': {
    contextWindow: 64_000,
    maxOutputTokens: 4_096,
    supportsImage: false,
    options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
  },
};

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
 * - 'none':                    already provisioned (welcomeBotId persisted) or
 *                              an existing install (has MetaBots). A deleted
 *                              welcome bot is never recreated: the persisted
 *                              id stays authoritative.
 * - 'create-bot-only':         a previous run provisioned the provider but
 *                              died before creating the welcome bot.
 * - 'bootstrap-and-create-bot': fresh install, nothing provisioned yet.
 */
export function planFreeQuotaProvisioning(input) {
  const metabotCount = Number.isFinite(input?.metabotCount) ? Math.floor(input.metabotCount) : 0;
  const welcomeBotId = Number.isFinite(input?.welcomeBotId) ? Math.floor(input.welcomeBotId) : null;
  if (welcomeBotId != null && welcomeBotId > 0) return 'none';
  if (metabotCount > 0) return 'none';
  return input?.providerConfigured ? 'create-bot-only' : 'bootstrap-and-create-bot';
}
