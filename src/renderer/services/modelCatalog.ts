/**
 * Shared model catalog for model+effort pickers.
 *
 * Lists every usable provider from app_config — built-in AND custom-*
 * providers added on the Settings > Models page — together with that
 * provider's models. This replaces the static ALL_PROVIDER_KEYS iteration the
 * MetaBot brain selectors used, which silently hid custom providers.
 *
 * The effort vocabulary mirrors src/main/libs/llmEffort.ts (off/low/high/max,
 * null = model default) plus the LLM_EFFORT_DEFAULT_SENTINEL marker for an
 * explicit "Default" pick. Keep the two in sync.
 */

import type { AppConfig } from '../config';
import { providerRequiresApiKey } from './llmConnection';
import { canonicalFreeProviderKey, FREE_PROVIDER_DISPLAY_NAME, LLM_FREE_PROVIDER_KEY } from './llmFreeQuotaGate.js';

export type LlmEffortLevel = 'off' | 'low' | 'high' | 'max';

export const LLM_EFFORT_LEVELS: readonly LlmEffortLevel[] = ['off', 'low', 'high', 'max'];

/**
 * Wire marker for the picker's top "Auto" rung (historically the explicit
 * "Default" pick). Persisted as the cowork session's effort; the runner's
 * auto path resolves it per message via the cerebellum selector, and the
 * no-verdict fallback degrades to the model's own default — never the bot
 * brain / global rungs (compat with the old "Default" promise; see
 * llmEffort.LLM_EFFORT_DEFAULT_SENTINEL). Keep the two identical.
 */
export const LLM_EFFORT_DEFAULT_SENTINEL = 'default';

export function isLlmEffortLevel(value: unknown): value is LlmEffortLevel {
  return typeof value === 'string' && (LLM_EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface CatalogModelEntry {
  /** Model id (wire value). */
  id: string;
  /** Display name. */
  name: string;
}

export interface CatalogProviderGroup {
  /** Provider key (e.g. 'deepseek', 'custom-my-relay'). */
  id: string;
  /** Display label. */
  name: string;
  models: CatalogModelEntry[];
}

interface ProviderModelLike {
  id?: string;
  name?: string;
}

interface ProviderLikeConfig {
  enabled?: boolean;
  apiKey?: string;
  name?: string;
  models?: ProviderModelLike[];
}

const capitalizeKey = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

/**
 * Build the picker catalog from an app config: providers that are enabled,
 * have a usable credential, and expose at least one model. Pure so it can be
 * unit-tested without the config service.
 */
export function buildModelGroupsFromConfig(config: Pick<AppConfig, 'providers'>): CatalogProviderGroup[] {
  const providers = (config.providers ?? {}) as Record<string, ProviderLikeConfig>;
  const groups: CatalogProviderGroup[] = [];
  for (const [key, provider] of Object.entries(providers)) {
    if (!provider?.enabled) continue;
    if (providerRequiresApiKey(key) && !(provider.apiKey ?? '').trim()) continue;
    const models = (provider.models ?? [])
      .filter((model) => typeof model?.id === 'string' && model.id.trim())
      .map((model) => ({ id: model.id, name: (model.name ?? '').trim() || model.id }));
    if (models.length === 0) continue;
    groups.push({
      id: key,
      // Built-in free provider always shows the canonical label; installs
      // provisioned before the rename still carry "MetaID Free" in storage.
      name: canonicalFreeProviderKey(key) === LLM_FREE_PROVIDER_KEY
        ? FREE_PROVIDER_DISPLAY_NAME
        : ((provider.name ?? '').trim() || capitalizeKey(key)),
      models,
    });
  }
  return groups;
}

/**
 * Resolve the concrete provider+model backing a stored MetaBot brain value.
 *
 * A brain may hold a model id (new semantic) or a legacy provider key. For a
 * legacy provider key the provider's current default model (global default
 * when that provider serves it, else its first model) is reported so the edit
 * UI can display what the bot actually runs. Returns null when the value
 * matches nothing in the catalog (e.g. provider removed).
 */
export function resolveBrainModelInGroups(
  groups: CatalogProviderGroup[],
  modelId: string | null | undefined,
  providerHint?: string | null,
  globalDefaultModel?: string | null,
): { providerKey: string; model: CatalogModelEntry } | null {
  const requested = modelId?.trim();
  if (!requested) return null;

  // Exact model-id match, preferring the stored provider hint.
  const findExact = (groupFilter?: string) => {
    for (const group of groups) {
      if (groupFilter && group.id !== groupFilter) continue;
      const model = group.models.find((m) => m.id === requested);
      if (model) return { providerKey: group.id, model };
    }
    return null;
  };
  const exact = findExact(providerHint?.trim() || undefined) ?? findExact();
  if (exact) return exact;

  // Legacy provider-key value: that provider's default model.
  const key = requested.toLowerCase();
  const byProviderKey = groups.find((group) => group.id.toLowerCase() === key);
  if (byProviderKey) {
    const model = globalDefaultModel && byProviderKey.models.some((m) => m.id === globalDefaultModel)
      ? byProviderKey.models.find((m) => m.id === globalDefaultModel)!
      : byProviderKey.models[0];
    return { providerKey: byProviderKey.id, model };
  }
  return null;
}

/**
 * Map a leftover five-step effort token onto the current four-step ladder.
 * Canonical off/low/high/max pass through; `low` is the current "light
 * thinking" rung and must not be rewritten to `off`. The 'default' sentinel
 * (explicit Default pick) maps to null = model default.
 */
export function convertLegacyEffortLevel(value: unknown): LlmEffortLevel | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (isLlmEffortLevel(normalized)) return normalized;
  if (normalized === LLM_EFFORT_DEFAULT_SENTINEL) return null;
  if (normalized === 'minimal' || normalized === 'none' || normalized === 'disabled') return 'off';
  if (normalized === 'medium') return 'low';
  if (normalized === 'xhigh') return 'max';
  return null;
}

/** A composer's pending model+effort pick (ModelEffortPicker output shape). */
export interface ComposerModelEffortPick {
  modelId: string | null;
  providerKey?: string | null;
  effort: LlmEffortLevel | null;
}

/**
 * Effort the picker chip should display. An explicit pick sticks as chosen —
 * including null ("Default") — while no pick at all resolves the fallback
 * chain (bot brain effort, then the global default), first valid rung wins.
 * The old `pick?.effort ?? fallbacks` chain conflated "picked Default" with
 * "never picked", so Default snapped back to the highest fallback rung.
 * In assistant chat-experience mode a missing pick displays the "Auto" rung
 * (null): the turn resolves its effort through the cerebellum auto selector
 * when configured (casual chat stays off, correctness-risk work escalates)
 * and falls back to the old default chain — off in assistant mode — when it
 * is not, so "Auto" is the honest label either way.
 */
export function effortDisplayForPick(
  pick: ComposerModelEffortPick | null | undefined,
  fallbacks: ReadonlyArray<unknown>,
  options?: { assistantMode?: boolean },
): LlmEffortLevel | null {
  if (pick != null) return pick.effort ?? null;
  if (options?.assistantMode) return null;
  for (const fallback of fallbacks) {
    const level = convertLegacyEffortLevel(fallback);
    if (level != null) return level;
  }
  return null;
}

/**
 * Effort to send when starting a session from a composer. An explicit pick
 * always yields a value — a null effort becomes the 'default' sentinel (the
 * "Auto" rung: cerebellum picks per message, degrading to the model default
 * when no verdict lands). No pick at all yields undefined so the main
 * process keeps the tiered defaults (brain ?? global ?? model).
 */
export function effortForSessionStart(
  pick: ComposerModelEffortPick | null | undefined,
): LlmEffortLevel | typeof LLM_EFFORT_DEFAULT_SENTINEL | undefined {
  if (pick == null) return undefined;
  return pick.effort ?? LLM_EFFORT_DEFAULT_SENTINEL;
}
