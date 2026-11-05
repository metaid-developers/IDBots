/**
 * Official model-list sync for built-in providers that expose a
 * model-listing GET endpoint (deepseek, opencode, commandcode, zhipu).
 *
 * Settings > Models shows a "Fetch Models" button for these providers: one
 * click pulls the provider's live catalog and replaces the stored list, so
 * users pick up renamed/added/retired official models without waiting for an
 * app release. Per-model local settings (thinking options, vision flag,
 * limits) survive the replace for ids that exist in both lists, and the
 * canonical presets (DeepSeek, Zhipu) re-supply names/limits for the ids they
 * know.
 *
 * The pure pieces (URL building, payload parsing, merge) are exported
 * separately so node:test can cover them without the Electron bridge.
 */

import type { ModelOptions } from '../config';
import { getDefaultDeepSeekModels, getDefaultVolcengineModels, getDefaultZhipuModels } from '../config';
import { buildOpenCodeGoSessionHeaders } from './opencodeGatewayHeaders';

/** One entry of a provider's model catalog after an official-list sync. */
export interface SyncedProviderModel {
  id: string;
  name: string;
  supportsImage?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  options?: ModelOptions;
}

export interface ExistingProviderModel {
  id: string;
  name?: string;
  supportsImage?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  options?: ModelOptions;
}

/**
 * Raw entry of the provider model list: the OpenAI-style `data` array the
 * gateways return, or Zhipu's Responses-catalog `models` array (which also
 * reports input modalities).
 */
export interface FetchedProviderModel {
  id: string;
  name?: string;
  supportsImage?: boolean;
  contextWindow?: number;
}

const MODEL_LIST_SYNC_PROVIDERS = ['deepseek', 'opencode', 'commandcode', 'zhipu', 'volcengine'] as const;

/** True when the provider exposes a known GET /models endpoint to sync from. */
export function providerSupportsModelListSync(providerKey: string): boolean {
  return (MODEL_LIST_SYNC_PROVIDERS as readonly string[]).includes(providerKey.trim().toLowerCase());
}

/**
 * Models-endpoint URL for a provider base URL. DeepSeek mounts /models at the
 * host root (https://api-docs.deepseek.com/zh-cn/api/list-models) — older
 * configs may carry the /anthropic or /v1 suffix from the Messages /
 * OpenAI-SDK base URL forms, so both are stripped. Zhipu serves the live
 * Responses catalog at https://open.bigmodel.cn/api/v1/models regardless of
 * which protocol base URL is configured (anthropic / coding/paas/v4 / v1), so
 * any bigmodel.cn base resolves back to the host origin. OpenAI-compatible
 * gateways (opencode, commandcode) mount /models next to /chat/completions.
 */
export function buildProviderModelsUrl(baseUrl: string, providerKey: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return '/v1/models';
  if (normalized.endsWith('/models')) return normalized;
  const isDeepSeekHost = providerKey.trim().toLowerCase() === 'deepseek'
    || normalized.toLowerCase().includes('api.deepseek.com');
  if (isDeepSeekHost) {
    const hostRoot = normalized.replace(/\/anthropic$/i, '').replace(/\/v1$/i, '');
    return hostRoot ? `${hostRoot}/models` : '/models';
  }
  const isZhipuHost = providerKey.trim().toLowerCase() === 'zhipu'
    || normalized.toLowerCase().includes('bigmodel.cn');
  if (isZhipuHost) {
    const originMatch = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(normalized);
    const origin = originMatch ? originMatch[1] : '';
    return origin ? `${origin}/api/v1/models` : '/api/v1/models';
  }
  // Volcengine Ark serves the live catalog on GET /api/v3/models at the host
  // root regardless of which version suffix the base URL carries (the default
  // config ships /api/v3; older configs may have /v1), so any volces.com base
  // resolves back to the canonical /api/v3 prefix.
  const isVolcengineHost = providerKey.trim().toLowerCase() === 'volcengine'
    || normalized.toLowerCase().includes('volces.com');
  if (isVolcengineHost) {
    const hostRoot = normalized.replace(/\/v[13]$/i, '').replace(/\/api$/i, '');
    return hostRoot ? `${hostRoot}/api/v3/models` : '/api/v3/models';
  }
  if (normalized.endsWith('/v1')) return `${normalized}/models`;
  return `${normalized}/v1/models`;
}

/**
 * Parse the provider list payload. OpenAI-style gateways answer
 * `{object: 'list', data: [...]}`; commandcode also reports a display `name`
 * and `context_length` per model. Zhipu's Responses catalog answers
 * `{models: [...]}` with `slug` / `display_name` / `context_window` /
 * `input_modalities` per entry. Unknown shapes yield an empty list (the caller
 * treats that as a failed sync, never an empty replace).
 */
export function parseProviderModelListPayload(payload: unknown): FetchedProviderModel[] {
  const container = payload as { data?: unknown; models?: unknown } | null;
  const rawList = Array.isArray(container?.data) ? container?.data : container?.models;
  if (!Array.isArray(rawList)) return [];
  const seen = new Set<string>();
  const models: FetchedProviderModel[] = [];
  for (const entry of rawList) {
    const record = entry as Record<string, unknown>;
    const rawId = typeof record?.id === 'string' ? record.id : record?.slug;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawName = record.name ?? record.display_name;
    const rawContext = record.contextWindow ?? record.context_window ?? record.context_length;
    // Modalities may sit at the entry root (Zhipu's catalog) or behind a
    // nested `modalities` object (Ark's /api/v3/models catalog reports
    // `modalities: { input_modalities: [...] }`).
    const rawModalities = record.input_modalities
      ?? (record.modalities as { input_modalities?: unknown } | undefined)?.input_modalities;
    models.push({
      id,
      name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined,
      // Only the Zhipu catalog reports modalities; leave the key absent for
      // the OpenAI-style gateways so merge falls back to preset/local flags.
      ...(Array.isArray(rawModalities) ? { supportsImage: rawModalities.includes('image') } : {}),
      contextWindow: typeof rawContext === 'number' && Number.isFinite(rawContext) && rawContext > 0
        ? Math.floor(rawContext)
        : undefined,
    });
  }
  return models;
}

/**
 * Canonicalize the Ark (Volcengine) /api/v3/models catalog into the chat UI's
 * stable-id list. The raw catalog is usused directly: it mixes every
 * capability domain (image / video / 3D / embedding / translation), lifecycle
 * states (`Published` vs `Retiring`), and reports snapshot-dated ids
 * (`doubao-seed-2-1-pro-260915`) whose official stable callable alias lives in
 * the `name` field (`doubao-seed-2-1-pro`). Keeping everything would expose
 * non-chat SKUs and dead snapshots in the model picker.
 *
 * Canonicalization rule: keep only entries that can actually serve chat
 * (`api_supported['chat/completions']` true) AND are still `Published`;
 * address them by their `name` alias; when an alias has several snapshots,
 * keep the newest one (max `created`, ties resolved by later catalog
 * position). Nested `modalities.input_modalities` becomes the vision flag.
 * Entries missing any of these markers are skipped.
 */
export function canonicalizeVolcengineModelList(payload: unknown): FetchedProviderModel[] {
  const container = payload as { data?: unknown } | null;
  const rawList = Array.isArray(container?.data) ? container?.data : [];
  const byAlias = new Map<string, { model: FetchedProviderModel; created: number }>();
  for (const entry of rawList) {
    const record = entry as Record<string, unknown>;
    const alias = typeof record?.name === 'string' ? record.name.trim() : '';
    if (!alias) continue;
    if (record?.status !== 'Published') continue;
    const apiSupported = record?.api_supported as Record<string, boolean> | undefined;
    if (!apiSupported || apiSupported['chat/completions'] !== true) continue;
    const rawContext = typeof record?.context_window === 'number' && record?.context_window > 0
      ? record.context_window
      : undefined;
    const nestedModalities = (record?.modalities as { input_modalities?: unknown } | undefined)
      ?.input_modalities;
    const model: FetchedProviderModel = {
      // The snapshot id stays unused; the alias IS the callable model name.
      id: alias,
      name: alias,
      ...(Array.isArray(nestedModalities) ? { supportsImage: nestedModalities.includes('image') } : {}),
      ...(rawContext !== undefined ? { contextWindow: rawContext } : {}),
    };
    const created = typeof record?.created === 'number' ? record.created : 0;
    const previous = byAlias.get(alias);
    // Later catalog position wins ties — the official list lists the current
    // default snapshot first, so a tie means both are equally valid.
    if (!previous || created > previous.created) {
      byAlias.set(alias, { model, created });
    }
  }
  // Preserve official catalog order: walk the raw list once more and emit
  // each alias at the position of its FIRST appearance.
  const emitted = new Set<string>();
  const models: FetchedProviderModel[] = [];
  for (const entry of rawList) {
    const record = entry as Record<string, unknown>;
    const alias = typeof record?.name === 'string' ? record.name.trim() : '';
    if (!alias || emitted.has(alias) || !byAlias.has(alias)) continue;
    emitted.add(alias);
    models.push(byAlias.get(alias)!.model);
  }
  return models;
}

/**
 * Replace semantics with per-model preservation: the synced list IS the
 * official list (ids the provider dropped disappear, new ids appear in
 * official order), while ids present in the user's current catalog keep
 * their local `options` (thinking/effort picks) and — when neither the
 * endpoint nor a canonical preset says otherwise — their vision flag,
 * limits and display name. Zhipu's catalog reports input modalities, so a
 * synced `supportsImage` is authoritative there (it flips the flag both ways
 * when Zhipu ships or retires vision on a SKU).
 */
export function mergeSyncedProviderModels(
  providerKey: string,
  fetched: FetchedProviderModel[],
  existing: ExistingProviderModel[],
): SyncedProviderModel[] {
  type CanonicalModel = ReturnType<typeof getDefaultDeepSeekModels>[number];
  const normalizedProviderKey = providerKey.trim().toLowerCase();
  const canonicalModels: CanonicalModel[] = normalizedProviderKey === 'deepseek'
    ? getDefaultDeepSeekModels()
    : normalizedProviderKey === 'zhipu'
      ? getDefaultZhipuModels()
      : normalizedProviderKey === 'volcengine'
        ? getDefaultVolcengineModels()
        : [];
  const canonicalById = new Map<string, CanonicalModel>(
    canonicalModels.map((model) => [model.id, model]),
  );
  const existingById = new Map(existing.map((model) => [model.id, model]));
  return fetched.map((entry) => {
    const canonical = canonicalById.get(entry.id);
    const current = existingById.get(entry.id);
    return {
      id: entry.id,
      // Canonical preset names win over the fetched raw display names
      // (Zhipu's catalog reports the bare slug); gateway-provided display
      // names still apply for ids no preset tracks.
      name: canonical?.name ?? entry.name ?? current?.name ?? entry.id,
      supportsImage: entry.supportsImage ?? canonical?.supportsImage ?? current?.supportsImage ?? false,
      contextWindow: entry.contextWindow ?? canonical?.contextWindow ?? current?.contextWindow,
      maxOutputTokens: canonical?.maxOutputTokens ?? current?.maxOutputTokens,
      options: current?.options ?? canonical?.options,
    };
  });
}

/**
 * Fetch the provider's official model list through the main-process bridge
 * (same path as the connection test, so CORS never applies) and merge it
 * with the provider's current catalog. Throws with the upstream error
 * message on failure.
 */
export async function fetchProviderModelList(input: {
  providerKey: string;
  apiKey?: string;
  baseUrl?: string;
  existingModels?: ExistingProviderModel[];
}): Promise<SyncedProviderModel[]> {
  const baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const url = buildProviderModelsUrl(baseUrl, input.providerKey);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = (input.apiKey ?? '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  Object.assign(headers, buildOpenCodeGoSessionHeaders(input.providerKey, baseUrl));

  const response = await window.electron.api.fetch({ url, method: 'GET', headers });
  if (!response.ok) {
    const data = (response.data ?? {}) as { error?: { message?: string }; message?: string };
    const message = data.error?.message || data.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const fetched = input.providerKey.trim().toLowerCase() === 'volcengine'
    ? canonicalizeVolcengineModelList(response.data)
    : parseProviderModelListPayload(response.data);
  if (fetched.length === 0) {
    throw new Error('The provider returned an empty model list');
  }
  return mergeSyncedProviderModels(input.providerKey, fetched, input.existingModels ?? []);
}
