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
import { getDefaultDeepSeekModels, getDefaultZhipuModels } from '../config';
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
  maxOutputTokens?: number;
}

const MODEL_LIST_SYNC_PROVIDERS = ['deepseek', 'opencode', 'commandcode', 'zhipu'] as const;

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
  if (normalized.endsWith('/v1')) return `${normalized}/models`;
  return `${normalized}/v1/models`;
}

/**
 * Parse the provider list payload. OpenAI-style gateways answer
 * `{object: 'list', data: [...]}`; commandcode also reports a display `name`
 * and `context_length` per model. Zhipu's Responses catalog answers
 * `{models: [...]}` with `slug` / `display_name` / `context_window` /
 * `input_modalities` per entry. opencode's gateway reports a nested
 * `limit: {context, output}` per model plus `modalities` (either a
 * `{input, output}` record or a flat MIME array depending on the SKU), so a
 * model fetched from it lands with its REAL context window and output
 * ceiling instead of falling through to the 128K fallback — session
 * cw-636ddce2 died because gemini-4-argon (1M real) resolved to the
 * fallback 128K and the request overflowed mid-turn. Unknown shapes yield
 * an empty list (the caller treats that as a failed sync, never an empty
 * replace).
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
    const limit = record.limit as Record<string, unknown> | undefined;
    const rawContext = record.contextWindow
      ?? record.context_window
      ?? record.context_length
      ?? limit?.context;
    const rawMaxOutput = record.maxOutputTokens ?? record.max_output_tokens ?? limit?.output;
    // Zhipu reports `input_modalities`; opencode reports `modalities` as
    // either an `{input, output}` record or a flat MIME array. A parsed list
    // is AUTHORITATIVE both ways (the gateway knows the SKU); any other
    // gateway leaves the key absent so merge falls back to preset/local
    // flags.
    const parsedModalities = parseModalitiesInputList(record.input_modalities)
      ?? parseModalitiesInputList(record.modalities);
    models.push({
      id,
      name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined,
      ...(parsedModalities !== undefined
        ? { supportsImage: parsedModalities.some((item) => typeof item === 'string' && item.toLowerCase().startsWith('image')) }
        : {}),
      contextWindow: toPositiveTokenCount(rawContext),
      maxOutputTokens: toPositiveTokenCount(rawMaxOutput),
    });
  }
  return models;
}

/** Coerce a fetched limit value into a positive integer token count. */
function toPositiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Normalize a gateway's modality declaration into its input list, whatever
 * shape it arrives in: Zhipu's flat `["text", "image"]`, opencode's flat
 * MIME array, or opencode's `{input: [...], output: [...]}` record.
 */
function parseModalitiesInputList(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  const input = (raw as Record<string, unknown> | undefined)?.input;
  return Array.isArray(input) ? input : undefined;
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
      maxOutputTokens: entry.maxOutputTokens ?? canonical?.maxOutputTokens ?? current?.maxOutputTokens,
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
  const fetched = parseProviderModelListPayload(response.data);
  if (fetched.length === 0) {
    throw new Error('The provider returned an empty model list');
  }
  return mergeSyncedProviderModels(input.providerKey, fetched, input.existingModels ?? []);
}
