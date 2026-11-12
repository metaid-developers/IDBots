/**
 * Free LLM quota relay client (IDBots bootstrap provider).
 *
 * Talks to the assist-base-service free-LLM relay: one identity-signed
 * bootstrap call provisions (or returns) the identity's free-quota account and
 * issues a relay key; the relay key then serves as a standard OpenAI Bearer
 * credential for the built-in `metaid-free` provider.
 *
 * Backend contract (assist-base-service "LLM 免费额度对接文档"):
 * - POST /v2/assist/llm/bootstrap — headers X-Identity-Address /
 *   X-Timestamp (unix seconds, ±300s) / X-Signature (Bitcoin Signed Message
 *   compact, base64) over "llm-relay-bootstrap:<identityAddress>:<timestamp>".
 *   Envelope {code:0, data:{apiKey, keyPrefix, baseUrl, models, quotaTotal,
 *   quotaUsed, quotaRemaining, quotaCycleResetAt, jevQuotaTotal, jevQuotaUsed,
 *   jevQuotaRemaining}}. quotaCycleResetAt (ms epoch) is the weekly cycle end
 *   when the chat and JEV pools refill together; absent/0 means weekly quotas
 *   are disabled (lifetime mode). The jevQuota* triple is the separate
 *   cerebellum (JEV) pool; absent/0 means the backend reports one shared pool.
 * - GET /v2/assist/llm/quota — Authorization: Bearer <relay key>; same data
 *   shape minus apiKey.
 * - Both responses may carry identityAddress/globalMetaId naming the identity
 *   that owns the account/key. When present, they are compared against the
 *   local user identity (relayIdentityMatchesLocalIdentity; identityAddress
 *   is authoritative, globalMetaId only fills in when no address is reported);
 *   a mismatch means the cached key belongs to a different identity and must
 *   be dropped — the backstop for any future "key vs identity" drift (the
 *   2026-10 identity-split incident: an imported identity kept consuming the
 *   silently provisioned previous identity's quota because every cache still
 *   held its key).
 *
 * The service is Electron-free (store/identity/fetch are injected) so plain
 * node:test coverage works, mirroring trafficAccountService.
 */

import { signMvcAddressMessage } from './mvcSponsorClient';
import { createUserIdentity } from './userIdentityService';
import type { SqliteStore } from '../sqliteStore';
import type { UserIdentityStore } from '../userIdentityStore';

const DEFAULT_LLM_RELAY_API_BASE_URL = 'https://www.metaso.network/assist-open-api';
const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const QUOTA_CACHE_TTL_MS = 30_000;
/** Default display name for the silently provisioned first-run identity. */
const DEFAULT_IDENTITY_NAME = 'User';

/** kvStore key: assist-service base URL override (integration testing). */
export const LLM_RELAY_API_BASE_KEY = 'llmRelay.apiBase';
/**
 * kvStore key: mvc address of the identity the most recently issued relay key
 * belongs to. Written on every successful bootstrap (the single issuance
 * funnel for the renderer provisioning, the JEV/vision resolvers and the
 * identity closeout alike) and compared against user_identity at startup by
 * relayIdentityCloseout — a missing or foreign stamp beside a cached key means
 * the key may belong to another identity and must be re-issued.
 */
export const LLM_RELAY_KEY_IDENTITY_KV = 'llmRelay.keyIdentity';

// ---------------------------------------------------------------------------
// Types + typed error
// ---------------------------------------------------------------------------

export type LlmRelayApiStage = 'bootstrap' | 'quota';

export class LlmRelayApiError extends Error {
  readonly stage: LlmRelayApiStage;
  readonly status?: number;

  constructor(input: { stage: LlmRelayApiStage; message: string; status?: number }) {
    super(input.message);
    this.name = 'LlmRelayApiError';
    this.stage = input.stage;
    this.status = input.status;
  }
}

export interface LlmRelayModelInfo {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface LlmRelayBootstrapInfo {
  /** Raw relay key; visible to the client exactly once (server stores only its hash). */
  apiKey: string;
  keyPrefix: string;
  baseUrl: string;
  models: LlmRelayModelInfo[];
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
  /** Weekly cycle end (ms epoch) when both pools refill; 0 = weekly quota disabled. */
  quotaCycleResetAt: number;
  /** JEV (cerebellum) pool snapshot; 0s = backend not reporting a separate pool. */
  jevQuotaTotal: number;
  jevQuotaUsed: number;
  jevQuotaRemaining: number;
  /** Identity address the relay says owns the account/key; '' when unreported. */
  identityAddress: string;
}

export interface LlmRelayQuotaInfo {
  keyPrefix: string;
  baseUrl: string;
  models: LlmRelayModelInfo[];
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
  /** Weekly cycle end (ms epoch) when both pools refill; 0 = weekly quota disabled. */
  quotaCycleResetAt: number;
  /** JEV (cerebellum) pool snapshot; 0s = backend not reporting a separate pool. */
  jevQuotaTotal: number;
  jevQuotaUsed: number;
  jevQuotaRemaining: number;
  /** Identity address the relay says owns the key; '' when unreported. */
  identityAddress: string;
}

// ---------------------------------------------------------------------------
// Module state + init
// ---------------------------------------------------------------------------

export interface LlmRelayServiceDeps {
  getStore: () => SqliteStore | null;
  getUserIdentityStore: () => UserIdentityStore;
  fetchImpl?: typeof fetch;
  /** Overrides the kvStore llmRelay.apiBase setting (mainly tests). */
  baseUrl?: string;
  /** Test seam for first-run identity provisioning. */
  createIdentityImpl?: typeof createUserIdentity;
}

let depsRef: LlmRelayServiceDeps | null = null;
let quotaCache: (LlmRelayQuotaInfo & { fetchedAt: number }) | null = null;

/**
 * Repair hook for a quota-response identity mismatch: the cached relay key
 * belongs to a different identity than the local user_identity row, so every
 * credential cache must be dropped and re-provisioned with a fresh
 * identity-signed bootstrap. Registered by relayIdentityCloseout at startup
 * (dependency inversion — this module never imports the orchestrator, so the
 * node:test harness stays free of production wiring).
 */
export type LlmRelayIdentityMismatchHandler = (context: {
  quota: LlmRelayQuotaInfo;
  localMvcAddress: string;
}) => Promise<void>;

let identityMismatchHandler: LlmRelayIdentityMismatchHandler | null = null;

export function setLlmRelayIdentityMismatchHandler(handler: LlmRelayIdentityMismatchHandler | null): void {
  identityMismatchHandler = handler;
}

export function initLlmRelayService(deps: LlmRelayServiceDeps): void {
  depsRef = deps;
}

export function resetLlmRelayServiceForTests(): void {
  depsRef = null;
  quotaCache = null;
  identityMismatchHandler = null;
}

/** Drop the cached quota snapshot (identity change / mismatch closeout). */
export function clearLlmRelayQuotaCache(): void {
  quotaCache = null;
}

function getDeps(): LlmRelayServiceDeps {
  if (!depsRef) {
    throw new LlmRelayApiError({ stage: 'bootstrap', message: 'llm relay service not initialized' });
  }
  return depsRef;
}

type LlmRelayKvStore = Pick<SqliteStore, 'get'> | null;

function getKvStore(): LlmRelayKvStore {
  try {
    return depsRef?.getStore() ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = normalizeText(record[key]);
    if (value) return value;
  }
  return '';
}

function toNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Normalize an apiBase override for persistence: trims, strips trailing
 * slashes, '' clears the override. Throws on anything that is not an
 * http(s) URL (callers surface the error and must not persist).
 */
export function normalizeLlmRelayApiBase(value: unknown): string {
  const text = normalizeText(value).replace(/\/+$/, '');
  if (!text) return '';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('llmRelay.apiBase must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('llmRelay.apiBase must use http or https');
  }
  return text;
}

/** Configured apiBase override; never throws, '' when unset or invalid. */
export function readLlmRelayApiBase(reader: LlmRelayKvStore | undefined): string {
  try {
    return normalizeLlmRelayApiBase(reader?.get(LLM_RELAY_API_BASE_KEY));
  } catch {
    return '';
  }
}

function resolveApiBaseUrl(): string {
  if (depsRef?.baseUrl && normalizeText(depsRef.baseUrl)) {
    return normalizeText(depsRef.baseUrl).replace(/\/+$/, '');
  }
  const configured = readLlmRelayApiBase(getKvStore());
  if (configured) return configured;
  return DEFAULT_LLM_RELAY_API_BASE_URL;
}

/** Persist an apiBase override (integration testing); '' clears it. */
export function setLlmRelayApiBase(value: unknown): string {
  const next = normalizeLlmRelayApiBase(value);
  const kv = getKvStore();
  if (kv && 'set' in kv && typeof (kv as { set?: unknown }).set === 'function') {
    try {
      (kv as Pick<SqliteStore, 'set'>).set(LLM_RELAY_API_BASE_KEY, next);
    } catch {
      // persistence loss is non-fatal
    }
  }
  return next;
}

/** Best-effort stamp of the identity a freshly issued relay key belongs to. */
function persistRelayKeyIdentity(identityAddress: string): void {
  const kv = getKvStore();
  if (kv && 'set' in kv && typeof (kv as { set?: unknown }).set === 'function') {
    try {
      (kv as Pick<SqliteStore, 'set'>).set(LLM_RELAY_KEY_IDENTITY_KV, identityAddress);
    } catch {
      // persistence loss is non-fatal: startup reconciliation treats a
      // missing stamp as drift and simply re-issues the key once
    }
  }
}

// Canonical request string (backend llm_relay_service/message.go — do not change).
export function buildLlmRelayBootstrapMessage(identityAddress: string, timestamp: number): string {
  return `llm-relay-bootstrap:${identityAddress}:${timestamp}`;
}

// ---------------------------------------------------------------------------
// HTTP layer (same {code, message, data} envelope as the traffic API)
// ---------------------------------------------------------------------------

async function llmRelayRequestJson(input: {
  stage: LlmRelayApiStage;
  method: 'GET' | 'POST';
  path: string;
  identity?: { address: string; timestamp: number; signature: string };
  bearer?: string;
}): Promise<Record<string, unknown>> {
  const deps = getDeps();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${resolveApiBaseUrl()}${input.path}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.identity) {
    headers['X-Identity-Address'] = input.identity.address;
    headers['X-Timestamp'] = String(input.identity.timestamp);
    headers['X-Signature'] = input.identity.signature;
  }
  if (input.bearer) {
    headers.Authorization = `Bearer ${input.bearer}`;
  }
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: input.method,
      headers,
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LlmRelayApiError({
        stage: input.stage,
        message: `LLM relay returned invalid JSON (HTTP ${response.status}).`,
        status: response.status,
      });
    }
    const record = readObject(body);
    if (!response.ok) {
      const errorRecord = readObject(record?.error);
      throw new LlmRelayApiError({
        stage: input.stage,
        message: pickText(errorRecord ?? record ?? {}, 'message', 'msg')
          || `LLM relay request failed with HTTP ${response.status}.`,
        status: response.status,
      });
    }
    if (!record) {
      throw new LlmRelayApiError({ stage: input.stage, message: 'LLM relay returned a non-object response.' });
    }
    const code = Number(record.code);
    if (Number.isFinite(code) && code === 0) {
      const data = readObject(record.data);
      if (!data) {
        throw new LlmRelayApiError({ stage: input.stage, message: 'LLM relay returned an empty data payload.' });
      }
      return data;
    }
    throw new LlmRelayApiError({
      stage: input.stage,
      message: pickText(record, 'message', 'msg', 'error')
        || `LLM relay returned code ${normalizeText(record.code) || 'unknown'}.`,
    });
  } catch (error) {
    if (error instanceof LlmRelayApiError) throw error;
    if (controller.signal.aborted) {
      throw new LlmRelayApiError({
        stage: input.stage,
        message: `LLM relay request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`,
      });
    }
    throw new LlmRelayApiError({
      stage: input.stage,
      message: error instanceof Error && error.message ? error.message : 'LLM relay request failed.',
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

function normalizeModels(value: unknown): LlmRelayModelInfo[] {
  if (!Array.isArray(value)) return [];
  const models: LlmRelayModelInfo[] = [];
  for (const item of value) {
    const record = readObject(item);
    const id = record ? pickText(record, 'id') : '';
    if (!id) continue;
    models.push({
      id,
      contextWindow: toNumber(record?.contextWindow) || undefined,
      maxOutputTokens: toNumber(record?.maxOutputTokens) || undefined,
    });
  }
  return models;
}

function normalizeQuotaPayload(data: Record<string, unknown>): Omit<LlmRelayBootstrapInfo, 'apiKey'> {
  return {
    keyPrefix: pickText(data, 'keyPrefix'),
    baseUrl: pickText(data, 'baseUrl').replace(/\/+$/, ''),
    models: normalizeModels(data.models),
    quotaTotal: toNumber(data.quotaTotal),
    quotaUsed: toNumber(data.quotaUsed),
    quotaRemaining: toNumber(data.quotaRemaining),
    quotaCycleResetAt: toNumber(data.quotaCycleResetAt),
    jevQuotaTotal: toNumber(data.jevQuotaTotal),
    jevQuotaUsed: toNumber(data.jevQuotaUsed),
    jevQuotaRemaining: toNumber(data.jevQuotaRemaining),
    identityAddress: pickText(data, 'identityAddress', 'identity_address'),
  };
}

// ---------------------------------------------------------------------------
// Identity guard (key-vs-identity mismatch backstop)
// ---------------------------------------------------------------------------

/**
 * Compare relay-reported identity fields against the local user identity.
 * Backends that do not report the fields yet (blank on either side) pass —
 * the guard is additive.
 *
 * identityAddress is authoritative: the backend echoes the exact
 * X-Identity-Address string the account was bound with, so it compares
 * byte-for-byte with user_identity.mvc_address. globalMetaId is consulted only
 * when no address was reported — its encoding is produced independently on
 * both sides, and a representation difference must never read as a foreign
 * identity (that would re-issue the key on every quota read).
 */
export function relayIdentityMatchesLocalIdentity(
  reported: { identityAddress?: unknown; globalMetaId?: unknown },
  local: { mvc_address?: unknown; globalmetaid?: unknown } | null | undefined,
): boolean {
  if (!local) {
    // No local identity to compare against (logged out / not yet created).
    return true;
  }
  const reportedAddress = normalizeText(reported.identityAddress);
  const localAddress = normalizeText(local.mvc_address);
  if (reportedAddress && localAddress) {
    return reportedAddress === localAddress;
  }
  const reportedGlobal = normalizeText(reported.globalMetaId);
  const localGlobal = normalizeText(local.globalmetaid);
  if (reportedGlobal && localGlobal && reportedGlobal !== localGlobal) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Identity (first-run silent provisioning) + signing
// ---------------------------------------------------------------------------

/**
 * Returns the local user identity, silently provisioning one on first run.
 * The identity wallet is generated locally (signing works offline), which is
 * all the relay bootstrap needs. The gas subsidy and the on-chain profile
 * pins are deferred (subsidy_state 'pending') until the user adopts the
 * identity — confirmDeferredUserIdentitySetup, driven by the adoption
 * signals in main.ts — so a returning user who imports their real identity
 * minutes later never burns a subsidy or leaves orphan pins behind.
 */
async function ensureUserIdentity(): Promise<{ mnemonic: string; path: string; mvcAddress: string }> {
  const deps = getDeps();
  const store = deps.getUserIdentityStore();
  let identity = store.get();
  if (!identity) {
    const createIdentity = deps.createIdentityImpl ?? createUserIdentity;
    const result = await createIdentity(
      store,
      { name: DEFAULT_IDENTITY_NAME, avatar: null },
      {},
      { deferChainSync: true, deferSubsidy: true },
    );
    if (!result.success) {
      throw new LlmRelayApiError({
        stage: 'bootstrap',
        message: `failed to provision local user identity: ${normalizeText(result.error) || 'unknown error'}`,
      });
    }
    identity = store.get();
  }
  const mvcAddress = normalizeText(identity?.mvc_address);
  if (!identity?.mnemonic?.trim() || !mvcAddress) {
    throw new LlmRelayApiError({
      stage: 'bootstrap',
      message: 'local user identity is incomplete (mnemonic/mvc address required)',
    });
  }
  return {
    mnemonic: identity.mnemonic.trim(),
    path: identity.path || DEFAULT_WALLET_PATH,
    mvcAddress,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bootstrap the free-quota account for the local identity and return a fresh
 * relay key plus the provider connection payload. Server-side this is
 * get-or-create for the account and issues a new key per call (older keys are
 * revoked past the server's per-identity cap), so callers should persist the
 * key and only re-bootstrap when it is lost or rejected.
 */
export async function bootstrapLlmRelay(): Promise<LlmRelayBootstrapInfo> {
  const identity = await ensureUserIdentity();
  const timestamp = nowSeconds();
  const { signature } = await signMvcAddressMessage({
    mnemonic: identity.mnemonic,
    path: identity.path,
    message: buildLlmRelayBootstrapMessage(identity.mvcAddress, timestamp),
  });
  const data = await llmRelayRequestJson({
    stage: 'bootstrap',
    method: 'POST',
    path: '/v2/assist/llm/bootstrap',
    identity: { address: identity.mvcAddress, timestamp, signature },
  });
  if (!relayIdentityMatchesLocalIdentity(data, { mvc_address: identity.mvcAddress })) {
    // The account the server returned is not the one this request signed as —
    // persisting its key would recreate the identity-split incident.
    throw new LlmRelayApiError({
      stage: 'bootstrap',
      message: `LLM relay bootstrap identity mismatch: signed as ${identity.mvcAddress} but the response belongs to ${normalizeText(data.identityAddress) || 'another identity'}.`,
    });
  }
  const quota = normalizeQuotaPayload(data);
  const apiKey = pickText(data, 'apiKey');
  if (!apiKey) {
    throw new LlmRelayApiError({ stage: 'bootstrap', message: 'LLM relay bootstrap returned no apiKey.' });
  }
  quotaCache = { ...quota, fetchedAt: Date.now() };
  persistRelayKeyIdentity(identity.mvcAddress);
  return { apiKey, ...quota };
}

/** Relay key currently stored in the metaid-free provider config ('' when absent). */
function readMetaIdFreeProviderApiKey(): string {
  try {
    const appConfig = getKvStore()?.get('app_config') as
      | { providers?: Record<string, { apiKey?: unknown } | undefined> }
      | null;
    const provider = appConfig?.providers?.['idbots'] ?? appConfig?.providers?.['metaid-free'];
    const apiKey = provider?.apiKey;
    return typeof apiKey === 'string' ? apiKey.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Query the quota snapshot behind a relay key. Results are cached for 30s
 * unless forceRefresh is set.
 *
 * When the response reports the key owner's identity and it disagrees with
 * the local user_identity row, the cached key is stale for this install
 * (imported identity, split account): the registered mismatch handler drops
 * every relay credential cache and re-bootstraps with the current identity,
 * then the quota is re-read behind the repaired provider key. The mismatched
 * snapshot is never cached.
 */
export async function getLlmRelayQuota(input: { apiKey?: unknown; forceRefresh?: boolean }): Promise<LlmRelayQuotaInfo> {
  const apiKey = normalizeText(input?.apiKey);
  if (!apiKey) {
    throw new LlmRelayApiError({ stage: 'quota', message: 'relay apiKey is required' });
  }
  if (!input?.forceRefresh && quotaCache && Date.now() - quotaCache.fetchedAt < QUOTA_CACHE_TTL_MS) {
    const { fetchedAt: _fetchedAt, ...snapshot } = quotaCache;
    return snapshot;
  }
  const fetchQuota = async (bearerKey: string): Promise<{ data: Record<string, unknown>; quota: LlmRelayQuotaInfo }> => {
    const data = await llmRelayRequestJson({
      stage: 'quota',
      method: 'GET',
      path: '/v2/assist/llm/quota',
      bearer: bearerKey,
    });
    return { data, quota: normalizeQuotaPayload(data) };
  };
  const { data } = await fetchQuota(apiKey);
  let quota = normalizeQuotaPayload(data);
  let localIdentity: { mvc_address?: unknown; globalmetaid?: unknown } | null = null;
  try {
    localIdentity = getDeps().getUserIdentityStore().get() ?? null;
  } catch {
    localIdentity = null;
  }
  if (!relayIdentityMatchesLocalIdentity(data, localIdentity)) {
    const localMvcAddress = normalizeText(localIdentity?.mvc_address);
    if (identityMismatchHandler) {
      await identityMismatchHandler({ quota, localMvcAddress });
      const repairedKey = readMetaIdFreeProviderApiKey();
      if (repairedKey && repairedKey !== apiKey) {
        ({ quota } = await fetchQuota(repairedKey));
        quotaCache = { ...quota, fetchedAt: Date.now() };
        return quota;
      }
    }
    throw new LlmRelayApiError({
      stage: 'quota',
      message: `LLM relay key identity mismatch: the key belongs to ${quota.identityAddress || 'another identity'} but the local identity is ${localMvcAddress || 'unknown'}.`,
    });
  }
  quotaCache = { ...quota, fetchedAt: Date.now() };
  return quota;
}

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

type RegisterIpcHandlerFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

export function registerLlmRelayIpcHandlers(deps: { registerIpcHandler: RegisterIpcHandlerFn }): void {
  const { registerIpcHandler } = deps;
  registerIpcHandler('llmRelay:bootstrap', async () => {
    try {
      return { success: true, result: await bootstrapLlmRelay() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  registerIpcHandler('llmRelay:getQuota', async (_event, input: { apiKey?: unknown; forceRefresh?: boolean }) => {
    try {
      return { success: true, quota: await getLlmRelayQuota(input ?? {}) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  registerIpcHandler('llmRelay:setApiBase', async (_event, input: { apiBase?: unknown }) => {
    try {
      return { success: true, apiBase: setLlmRelayApiBase(input?.apiBase) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
