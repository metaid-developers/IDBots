/**
 * Cerebellum (小脑) config accessor for the main process.
 *
 * The cerebellum is an optional fast decision model (first provider:
 * TypeSafe JEV, POST {baseUrl}/v1/systemone) layered next to the generative
 * "brain" LLM. This resolver is the single seam future decision call sites
 * (memory ranking, intent routing, ...) read; it returns null whenever the
 * feature is off or unusable, so callers need no shape checks of their own.
 * The second provider keeps its legacy idbots-jev-free storage key and rides
 * the official ME-billed relay with the same wire shape — its identity-bound
 * relay key is injected at call time (see services/jevRelayService.ts), so an
 * empty apiKey resolves fine here. Direct TypeSafe calls never enter the
 * IDBots relay and therefore do not consume IDBots ME credits.
 */

export type CerebellumProvider = 'typesafe-jev' | 'idbots-jev-free';

export interface ResolvedCerebellumConfig {
  provider: CerebellumProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const CEREBELLUM_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const CEREBELLUM_DEFAULT_MODEL = 'jev-latest';

/**
 * Official IDBots-JEV provider: assist-base-service proxies the TypeSafe JEV
 * upstream and holds the real upstream key server-side, so users need no
 * TypeSafe key of their own. The wire shape is identical to `typesafe-jev`
 * (POST {baseUrl}/v1/systemone), but the identity-bound relay key lets the
 * service meter usage to the user's ME balance. The exported constant names
 * retain FREE only for backward compatibility with the persisted provider id.
 */
export const CEREBELLUM_FREE_PROVIDER = 'idbots-jev-free' as const;
/** Hardcoded JEV relay base (backend doc《JEV 小脑模型中转接口.md》§3). */
export const CEREBELLUM_FREE_RELAY_BASE_URL = 'https://www.metaso.network/assist-open-api/v2/assist/llm/jev';
export const CEREBELLUM_FREE_MODEL = 'jev-latest';

const CEREBELLUM_PROVIDERS: readonly string[] = ['typesafe-jev', 'idbots-jev-free'];

/**
 * Resolve the stored app_config into a ready-to-use cerebellum config, or
 * null when the feature is disabled, missing, malformed, or has no API key.
 * Never throws: every shape anomaly maps to null.
 */
export function resolveCerebellumConfig(appConfig: unknown): ResolvedCerebellumConfig | null {
  if (!appConfig || typeof appConfig !== 'object') {
    return null;
  }
  const raw = (appConfig as { cerebellum?: unknown }).cerebellum;
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.enabled !== true) {
    return null;
  }
  if (typeof candidate.provider !== 'string' || !CEREBELLUM_PROVIDERS.includes(candidate.provider)) {
    return null;
  }
  const isIdbotsProvider = candidate.provider === CEREBELLUM_FREE_PROVIDER;
  // IDBots-JEV: the apiKey comes from the relay credential chain at call time,
  // so an empty stored key is valid here (the runtime resolver injects it or
  // disables the feature); baseUrl/model are fixed to the relay values
  // regardless of what is stored. Direct TypeSafe keeps requiring a key.
  const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey.trim() : '';
  if (!apiKey && !isIdbotsProvider) {
    return null;
  }

  let baseUrl: string;
  let model: string;
  if (isIdbotsProvider) {
    baseUrl = CEREBELLUM_FREE_RELAY_BASE_URL;
    model = CEREBELLUM_FREE_MODEL;
  } else {
    const rawBaseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl.trim() : '';
    baseUrl = (rawBaseUrl || CEREBELLUM_DEFAULT_BASE_URL).replace(/\/+$/, '');
    model = typeof candidate.model === 'string' && candidate.model.trim()
      ? candidate.model.trim()
      : CEREBELLUM_DEFAULT_MODEL;
  }

  if (!baseUrl) {
    return null;
  }

  return {
    provider: candidate.provider as CerebellumProvider,
    apiKey,
    baseUrl,
    model,
  };
}
