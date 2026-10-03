/**
 * Traffic billing settings (global, persisted in the SQLite kvStore).
 * Phase B wired read-only accessors into createPin; Phase C added the
 * renderer toggle, persistence helpers, and IPC surface following the
 * feeRateStore.ts pattern.
 *
 * - traffic.mode: 'traffic' (account quota, default) | 'selfpay' (MetaBot wallet).
 * - traffic.fallbackPolicy: always 'selfpay' — when account quota is
 *   unavailable or insufficient, writes fall back to the MetaBot wallet.
 *   The old 'strict' option is no longer exposed.
 * - traffic.apiBase: assist-service base URL override (integration testing);
 *   empty/unset means the production default baked into the clients.
 * - traffic.rechargeGateway: recharge payment-gateway override (dev-only E2E
 *   testing): 'paypal' | 'mock' | 'alipay'; empty/unset means automatic
 *   (packaged builds pick by plan currency: CNY → Alipay, other → PayPal).
 *   Packaged builds ignore this override.
 */

export const TRAFFIC_MODE_KEY = 'traffic.mode';
export const TRAFFIC_FALLBACK_POLICY_KEY = 'traffic.fallbackPolicy';
export const TRAFFIC_API_BASE_KEY = 'traffic.apiBase';
export const TRAFFIC_RECHARGE_GATEWAY_KEY = 'traffic.rechargeGateway';

export type TrafficPinMode = 'traffic' | 'selfpay';
export type TrafficFallbackPolicy = 'selfpay' | 'strict';
/** '' = auto (plan currency decides); 'paypal' | 'mock' | 'alipay' = explicit dev override. */
export type RechargeGatewayOverride = '' | 'paypal' | 'mock' | 'alipay';

export function normalizeTrafficPinMode(value: unknown): TrafficPinMode {
  return String(value ?? '').trim().toLowerCase() === 'selfpay' ? 'selfpay' : 'traffic';
}

/** Stored 'strict' is ignored; account-quota mode always falls back to self-pay. */
export function normalizeTrafficFallbackPolicy(_value?: unknown): TrafficFallbackPolicy {
  return 'selfpay';
}

/**
 * Normalize an apiBase override for persistence: trims, strips trailing
 * slashes, '' clears the override. Throws on anything that is not an
 * http(s) URL (callers surface the error and must not persist).
 */
export function normalizeTrafficApiBase(value: unknown): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('traffic.apiBase must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('traffic.apiBase must use http or https');
  }
  return text;
}

/** Configured apiBase override; never throws, '' when unset or invalid. */
export function readTrafficApiBase(reader: TrafficSettingsReader | null | undefined): string {
  try {
    return normalizeTrafficApiBase(readTrafficSetting(reader, TRAFFIC_API_BASE_KEY));
  } catch {
    return '';
  }
}

/**
 * Normalize the recharge-gateway override for persistence: '' (auto),
 * 'paypal', 'mock', or 'alipay'. Throws on anything else (callers surface the
 * error and must not persist).
 */
export function normalizeRechargeGatewayOverride(value: unknown): RechargeGatewayOverride {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'paypal' || text === 'mock' || text === 'alipay') return text;
  throw new Error("traffic.rechargeGateway must be 'paypal', 'mock', 'alipay', or empty");
}

/** Configured recharge-gateway override; never throws, '' (auto) when unset or invalid. */
export function readRechargeGatewayOverride(reader: TrafficSettingsReader | null | undefined): RechargeGatewayOverride {
  try {
    return normalizeRechargeGatewayOverride(readTrafficSetting(reader, TRAFFIC_RECHARGE_GATEWAY_KEY));
  } catch {
    return '';
  }
}

/** Minimal kv reader shape shared by SqliteStore and test doubles. */
export type TrafficSettingsReader = Pick<{ get<T = unknown>(key: string): T | undefined }, 'get'>;

function readTrafficSetting(reader: TrafficSettingsReader | null | undefined, key: string): unknown {
  if (!reader) return undefined;
  try {
    return reader.get(key);
  } catch {
    return undefined;
  }
}

export function getTrafficPinMode(reader: TrafficSettingsReader | null | undefined): TrafficPinMode {
  return normalizeTrafficPinMode(readTrafficSetting(reader, TRAFFIC_MODE_KEY));
}

export function getTrafficFallbackPolicy(
  _reader?: TrafficSettingsReader | null,
): TrafficFallbackPolicy {
  return 'selfpay';
}

/** Settings snapshot for the renderer toggle UI. */
export interface TrafficSettingsSnapshot {
  mode: TrafficPinMode;
  fallbackPolicy: TrafficFallbackPolicy;
  /** Configured assist-service base URL override; '' = production default. */
  apiBase: string;
  /** Recharge gateway override; '' = automatic (plan currency decides; dev-only override can force a gateway). */
  rechargeGateway: RechargeGatewayOverride;
}

export function getTrafficSettings(
  reader: TrafficSettingsReader | null | undefined,
): TrafficSettingsSnapshot {
  return {
    mode: getTrafficPinMode(reader),
    fallbackPolicy: getTrafficFallbackPolicy(reader),
    apiBase: readTrafficApiBase(reader),
    rechargeGateway: readRechargeGatewayOverride(reader),
  };
}

/** Minimal kv writer shape shared by SqliteStore and test doubles. */
export type TrafficSettingsStore = TrafficSettingsReader & { set(key: string, value: unknown): void };

/**
 * Persist traffic settings (partial update). Values are normalized on write;
 * omitted fields keep their current value. An invalid apiBase throws and is
 * never persisted. Returns the resulting snapshot.
 */
export function setTrafficSettings(
  store: TrafficSettingsStore | null | undefined,
  input: { mode?: unknown; fallbackPolicy?: unknown; apiBase?: unknown; rechargeGateway?: unknown },
): TrafficSettingsSnapshot {
  const current = getTrafficSettings(store);
  const nextMode = input.mode === undefined ? current.mode : normalizeTrafficPinMode(input.mode);
  const nextFallbackPolicy = 'selfpay';
  // Validate before touching the store: invalid values must not be persisted.
  const nextApiBase = input.apiBase === undefined ? current.apiBase : normalizeTrafficApiBase(input.apiBase);
  const nextGateway = input.rechargeGateway === undefined
    ? current.rechargeGateway
    : normalizeRechargeGatewayOverride(input.rechargeGateway);
  if (store) {
    try {
      if (input.mode !== undefined) store.set(TRAFFIC_MODE_KEY, nextMode);
      if (input.fallbackPolicy !== undefined) store.set(TRAFFIC_FALLBACK_POLICY_KEY, nextFallbackPolicy);
      if (input.apiBase !== undefined) store.set(TRAFFIC_API_BASE_KEY, nextApiBase);
      if (input.rechargeGateway !== undefined) store.set(TRAFFIC_RECHARGE_GATEWAY_KEY, nextGateway);
    } catch {
      // persistence loss is non-fatal; the returned snapshot still reflects intent
    }
  }
  return { mode: nextMode, fallbackPolicy: nextFallbackPolicy, apiBase: nextApiBase, rechargeGateway: nextGateway };
}
