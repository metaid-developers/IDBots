/**
 * Traffic account service client (account-quota billing, Phase D).
 * Talks to the backend traffic APIs (/v1/traffic/*) with identity-signed
 * requests, manages the local account record and bot-address bindings, keeps
 * a ~30s in-memory balance cache (decremented locally on each sponsored
 * commit for instant UI feedback), and journals every locally-initiated
 * sponsored spend into SQLite.
 *
 * Signature canonical strings follow the backend deployment doc
 * (assist-base-service docs/traffic-deployment.md §4) exactly:
 * - POST /v1/traffic/accounts:          "traffic-account:<accountId>:<ts>"
 * - POST /v1/traffic/accounts/bindings: "traffic-bind:<botAddress>:<accountId>:<ts>"
 *   (identity signs via X-Signature header, bot key signs via body botSignature)
 * - sponsor pre trafficAccount:         "traffic-pre:<accountId>:<challengeId>"
 * Headers: X-Identity-Address / X-Timestamp (unix seconds, ±300s) / X-Signature
 * (Bitcoin Signed Message compact, base64).
 *
 * Defensive by design: the accountId is always taken from the server response
 * and persisted locally (never assumed to equal the locally-computed
 * GlobalMetaID), and every failure in the sponsor-flow resolver degrades to
 * "no trafficAccount" so the legacy quota path keeps working while the
 * backend feature is off (404) or the bot is unbound.
 */

import { signMvcAddressMessage, type MvcSponsorTrafficAccount } from './mvcSponsorClient';
import {
  getTrafficPinMode,
  getTrafficSettings,
  readRechargeGatewayOverride,
  readTrafficApiBase,
  setTrafficSettings,
  type TrafficPinMode,
  type TrafficSettingsReader,
  type TrafficSettingsSnapshot,
} from './trafficSettings';
import type { SqliteStore } from '../sqliteStore';
import type { MetabotStore } from '../metabotStore';
import type { UserIdentityStore } from '../userIdentityStore';

const DEFAULT_TRAFFIC_API_BASE_URL = 'https://www.metaso.network/assist-open-api';
const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const BALANCE_CACHE_TTL_MS = 30_000;
/** Backoff before the single ensure/bind retry inside the sponsor-pre resolver. */
const RESOLVER_RETRY_BACKOFF_MS = 300;

/** kvStore keys (traffic.apiBase lives in trafficSettings.ts). */
const TRAFFIC_ACCOUNT_KEY = 'traffic.account';
const TRAFFIC_BINDINGS_KEY = 'traffic.bindings';

// ---------------------------------------------------------------------------
// Types + typed errors
// ---------------------------------------------------------------------------

export type TrafficApiStage =
  | 'account'
  | 'bind'
  | 'balance'
  | 'ledger'
  | 'usage'
  | 'pricing'
  | 'recharge'
  | 'campaign'
  | 'redeem';

export class TrafficApiError extends Error {
  readonly code: string;
  readonly stage: TrafficApiStage;
  readonly status?: number;
  readonly serviceMessage: string;
  /** True when the backend returned 404 for /v1/traffic/* (feature disabled). */
  readonly featureUnavailable: boolean;
  /**
   * Backend error code delivered as data.errorCode (e.g. CAMPAIGN_DISABLED,
   * ALREADY_CLAIMED, CODE_USED), same envelope pattern as TRAFFIC_INSUFFICIENT
   * (backend-spec §12 errata 1). Empty when the backend sent none.
   */
  readonly errorCode: string;

  constructor(input: {
    stage: TrafficApiStage;
    message: string;
    status?: number;
    featureUnavailable?: boolean;
    errorCode?: string;
  }) {
    super(input.message);
    this.name = 'TrafficApiError';
    this.code = `traffic_${input.stage}_failed`;
    this.stage = input.stage;
    if (input.status !== undefined) this.status = input.status;
    this.serviceMessage = input.message;
    this.featureUnavailable = input.featureUnavailable === true;
    this.errorCode = normalizeText(input.errorCode);
  }
}

export interface TrafficAccountRecord {
  accountId: string;
  identityAddress: string;
  balanceBytes: number;
  reservedBytes: number;
  grantedBytesTotal: number;
  spentBytesTotal: number;
  status: number;
}

export interface TrafficBindResultItem {
  botAddress: string;
  status: 'bound' | 'conflict' | 'failed';
  error?: string;
}

export interface TrafficBindSummary {
  accountId: string;
  results: TrafficBindResultItem[];
  boundCount: number;
  conflictCount: number;
  failedCount: number;
}

export interface TrafficLedgerEntry {
  id: number;
  direction: number;
  amountBytes: number;
  balanceAfter: number;
  sourceType: string;
  sourceId: string;
  remark: string;
  timestamp: number;
  /**
   * Local-journal enrichment, present only when this device committed the
   * sponsor order referenced by sourceId (cross-device spends and expired
   * reservations stay empty).
   */
  txId?: string;
  botAddress?: string;
  /** Pin protocol path or purpose tag recorded locally (e.g. /protocols/simplemsg, /file). */
  kind?: string;
}

export interface TrafficDailyUsageRow {
  date: string;
  botAddress: string;
  bytes: number;
  txCount: number;
}

export interface TrafficUsageSummary {
  todayBytes: number;
  weekBytes: number;
  monthBytes: number;
}

export interface TrafficSpendJournalEntry {
  id: number;
  txId: string;
  botAddress: string;
  orderId: string;
  txSize: number;
  sponsoredMinerFee: number;
  savedFee: number;
  /** 'traffic' = billed to the traffic account; 'quota' = legacy sponsor quota. */
  billedBy: 'traffic' | 'quota';
  /** Pin protocol path or purpose tag (e.g. /protocols/simplemsg, /file); '' for legacy rows. */
  kind: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Module state + init
// ---------------------------------------------------------------------------

export interface TrafficAccountServiceDeps {
  getStore: () => SqliteStore | null;
  getMetabotStore: () => MetabotStore;
  getUserIdentityStore: () => UserIdentityStore;
  fetchImpl?: typeof fetch;
  /** Overrides the kvStore traffic.apiBase setting (mainly tests). */
  baseUrl?: string;
}

let depsRef: TrafficAccountServiceDeps | null = null;
let balanceCache: (TrafficAccountRecord & { fetchedAt: number }) | null = null;
/** Coalesces concurrent first-run POSTs so a fresh install does not race-create. */
let ensureAccountInFlight: Promise<TrafficAccountRecord> | null = null;

export function initTrafficAccountService(deps: TrafficAccountServiceDeps): void {
  depsRef = deps;
}

export function resetTrafficAccountServiceForTests(): void {
  depsRef = null;
  balanceCache = null;
  ensureAccountInFlight = null;
}

function getDeps(): TrafficAccountServiceDeps {
  if (!depsRef) {
    throw new TrafficApiError({ stage: 'account', message: 'traffic account service not initialized' });
  }
  return depsRef;
}

type TrafficKvStore = TrafficSettingsReader & { set(key: string, value: unknown): void };

function getKvStore(): TrafficKvStore | null {
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

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return /^(true|1|yes)$/i.test(normalizeText(value));
  return false;
}

function pickErrorCode(data: unknown): string {
  const record = readObject(data);
  return record ? normalizeText(record.errorCode ?? record.error_code) : '';
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The configured assist-service base URL override (kvStore traffic.apiBase),
 * or undefined when unset — callers then fall back to their own production
 * default. Electron-free: reads through the same injected store accessor the
 * rest of the service uses, so plain-node tests work unchanged.
 */
export function getConfiguredTrafficApiBase(): string | undefined {
  const configured = readTrafficApiBase(getKvStore());
  return configured || undefined;
}

/**
 * The global traffic.mode setting ('traffic' account quota | 'selfpay'
 * MetaBot wallet; default 'traffic'), read through the same injected store.
 * Every on-chain write path that can choose between the sponsor
 * (account-quota) flow and the bot-wallet flow must gate on this so the
 * settings-panel toggle governs all of them uniformly. Never throws.
 */
export function getConfiguredTrafficPinMode(): TrafficPinMode {
  try {
    return getTrafficPinMode(getKvStore());
  } catch {
    return 'traffic';
  }
}

function resolveApiBaseUrl(): string {
  if (depsRef?.baseUrl && normalizeText(depsRef.baseUrl)) {
    return normalizeText(depsRef.baseUrl).replace(/\/+$/, '');
  }
  const configured = getConfiguredTrafficApiBase();
  if (configured) return configured;
  return DEFAULT_TRAFFIC_API_BASE_URL;
}

// Canonical request strings (backend traffic_service/message.go — do not change).
function buildTrafficAccountMessage(accountId: string, timestamp: number): string {
  return `traffic-account:${accountId}:${timestamp}`;
}

function buildTrafficBindMessage(botAddress: string, accountId: string, timestamp: number): string {
  return `traffic-bind:${botAddress}:${accountId}:${timestamp}`;
}

function buildTrafficPreMessage(accountId: string, challengeId: string): string {
  return `traffic-pre:${accountId}:${challengeId}`;
}

function buildTrafficRechargeMessage(accountId: string, planId: string, timestamp: number): string {
  return `traffic-recharge:${accountId}:${planId}:${timestamp}`;
}

function buildTrafficRechargeConfirmMessage(orderId: string, gatewayTxnId: string, timestamp: number): string {
  return `traffic-recharge-confirm:${orderId}:${gatewayTxnId}:${timestamp}`;
}

// Phase 3b canonical strings (free-grant campaign + recharge codes). The
// backend message.go file does not ship these yet, so the client follows the
// existing traffic-<purpose>:<accountId>:<ts> convention; confirm against the
// backend deployment doc once it lands.
function buildTrafficFreeGrantStatusMessage(accountId: string, timestamp: number): string {
  return `traffic-free-grant-status:${accountId}:${timestamp}`;
}

function buildTrafficFreeGrantClaimMessage(accountId: string, timestamp: number): string {
  return `traffic-free-grant-claim:${accountId}:${timestamp}`;
}

function buildTrafficRedeemCodeMessage(accountId: string, timestamp: number): string {
  return `traffic-redeem-code:${accountId}:${timestamp}`;
}

const TRAFFIC_CLIENT_APP_ID = 'idbots';
const TRAFFIC_CLIENT_VERSION_FALLBACK = 'dev';

/**
 * App version reported to the free-grant claim endpoint. Electron is loaded
 * lazily (same pattern as metaidCore.appendMetaidLog) so this service module
 * stays Electron-free for plain-node tests, where require('electron') resolves
 * to the binary path string and the optional-chain yields undefined.
 */
function getTrafficClientVersion(): string {
  try {
    const { app } = require('electron');
    const version = normalizeText(app?.getVersion?.());
    if (version) return version;
  } catch {
    // electron unavailable — fall through to the dev marker
  }
  return TRAFFIC_CLIENT_VERSION_FALLBACK;
}

// ---------------------------------------------------------------------------
// HTTP layer (same {code, message, data} envelope as the sponsor v2 API)
// ---------------------------------------------------------------------------

async function trafficRequestJson(input: {
  stage: TrafficApiStage;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  identity?: { address: string; timestamp: number; signature: string };
}): Promise<Record<string, unknown> | unknown[]> {
  const deps = getDeps();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = new URL(`${resolveApiBaseUrl()}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && normalizeText(value) !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.body) {
    headers['content-type'] = 'application/json';
  }
  if (input.identity) {
    headers['X-Identity-Address'] = input.identity.address;
    headers['X-Timestamp'] = String(input.identity.timestamp);
    headers['X-Signature'] = input.identity.signature;
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url.toString(), {
      method: input.method,
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TrafficApiError({
        stage: input.stage,
        message: `Traffic service returned invalid JSON (HTTP ${response.status}).`,
        status: response.status,
      });
    }
    if (!response.ok) {
      const bodyRecord = readObject(body);
      throw new TrafficApiError({
        stage: input.stage,
        message: pickText(bodyRecord ?? {}, 'message', 'msg', 'error')
          || `Traffic service request failed with HTTP ${response.status}.`,
        status: response.status,
        featureUnavailable: response.status === 404,
        errorCode: pickErrorCode(bodyRecord?.data),
      });
    }
    const record = readObject(body);
    if (!record) {
      throw new TrafficApiError({ stage: input.stage, message: 'Traffic service returned a non-object response.' });
    }
    const code = Number(record.code);
    if (Number.isFinite(code) && code === 0) {
      if (Array.isArray(record.data)) return record.data;
      const data = readObject(record.data);
      if (!data) {
        throw new TrafficApiError({ stage: input.stage, message: 'Traffic service returned an empty data payload.' });
      }
      return data;
    }
    throw new TrafficApiError({
      stage: input.stage,
      message: pickText(record, 'message', 'msg', 'error')
        || `Traffic service returned code ${normalizeText(record.code) || 'unknown'}.`,
      errorCode: pickErrorCode(record.data),
    });
  } catch (error) {
    if (error instanceof TrafficApiError) throw error;
    if (controller.signal.aborted) {
      throw new TrafficApiError({
        stage: input.stage,
        message: `Traffic service request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`,
      });
    }
    throw new TrafficApiError({
      stage: input.stage,
      message: error instanceof Error && error.message ? error.message : 'Traffic service request failed.',
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Local persistence (kvStore)
// ---------------------------------------------------------------------------

function readLocalAccount(): TrafficAccountRecord | null {
  const kv = getKvStore();
  if (!kv) return null;
  try {
    const record = readObject(kv.get(TRAFFIC_ACCOUNT_KEY));
    const accountId = normalizeText(record?.accountId);
    if (!record || !accountId) return null;
    return {
      accountId,
      identityAddress: normalizeText(record.identityAddress),
      balanceBytes: toNumber(record.balanceBytes),
      reservedBytes: toNumber(record.reservedBytes),
      grantedBytesTotal: toNumber(record.grantedBytesTotal),
      spentBytesTotal: toNumber(record.spentBytesTotal),
      status: toNumber(record.status),
    };
  } catch {
    return null;
  }
}

function persistLocalAccount(account: TrafficAccountRecord): void {
  try {
    getKvStore()?.set(TRAFFIC_ACCOUNT_KEY, { ...account });
  } catch {
    // local cache loss is non-fatal
  }
}

function readLocalBindings(): Record<string, { accountId: string; boundAt: number }> {
  const kv = getKvStore();
  if (!kv) return {};
  try {
    const record = readObject(kv.get(TRAFFIC_BINDINGS_KEY));
    if (!record) return {};
    const result: Record<string, { accountId: string; boundAt: number }> = {};
    for (const [address, value] of Object.entries(record)) {
      const entry = readObject(value);
      const accountId = normalizeText(entry?.accountId);
      if (accountId) {
        result[address] = { accountId, boundAt: toNumber(entry?.boundAt) };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistLocalBinding(botAddress: string, accountId: string): void {
  try {
    const bindings = readLocalBindings();
    bindings[botAddress] = { accountId, boundAt: Date.now() };
    getKvStore()?.set(TRAFFIC_BINDINGS_KEY, bindings);
  } catch {
    // local cache loss is non-fatal
  }
}

function isBotBoundLocally(botAddress: string, accountId: string): boolean {
  return readLocalBindings()[botAddress]?.accountId === accountId;
}

/** Local account record for UI/IPC; null when never ensured. */
export function getLocalTrafficAccount(): TrafficAccountRecord | null {
  return readLocalAccount();
}

// ---------------------------------------------------------------------------
// Identity + bot signing
// ---------------------------------------------------------------------------

function requireIdentity(): { mnemonic: string; path: string; mvcAddress: string; globalMetaId: string } {
  const identity = getDeps().getUserIdentityStore().get();
  if (!identity) {
    throw new TrafficApiError({ stage: 'account', message: 'local user identity is missing' });
  }
  const globalMetaId = normalizeText(identity.globalmetaid);
  const mvcAddress = normalizeText(identity.mvc_address);
  if (!identity.mnemonic?.trim() || !globalMetaId || !mvcAddress) {
    throw new TrafficApiError({
      stage: 'account',
      message: 'local user identity is incomplete (mnemonic/mvc address/globalmetaid required)',
    });
  }
  return {
    mnemonic: identity.mnemonic.trim(),
    path: identity.path || DEFAULT_WALLET_PATH,
    mvcAddress,
    globalMetaId,
  };
}

function signWithKey(input: { mnemonic: string; path: string; message: string }) {
  // Never log mnemonic/message signatures; the message itself is non-sensitive.
  return signMvcAddressMessage({ mnemonic: input.mnemonic, path: input.path, message: input.message });
}

// ---------------------------------------------------------------------------
// Account + bindings
// ---------------------------------------------------------------------------

function normalizeAccountRecord(data: Record<string, unknown>, stage: TrafficApiStage): TrafficAccountRecord {
  const accountId = pickText(data, 'accountId', 'account_id');
  if (!accountId) {
    throw new TrafficApiError({ stage, message: 'Traffic account response is missing accountId.' });
  }
  return {
    accountId,
    identityAddress: pickText(data, 'identityAddress', 'identity_address'),
    balanceBytes: toNumber(data.balanceBytes ?? data.balance_bytes),
    reservedBytes: toNumber(data.reservedBytes ?? data.reserved_bytes),
    grantedBytesTotal: toNumber(data.grantedBytesTotal ?? data.granted_bytes_total),
    spentBytesTotal: toNumber(data.spentBytesTotal ?? data.spent_bytes_total),
    status: toNumber(data.status),
  };
}

/**
 * Get-or-create the traffic account for the local user identity. The accountId
 * in the response is authoritative (the backend derives it from the identity
 * address) and is persisted locally. Concurrent callers share one in-flight
 * POST so a fresh install (balance + campaign + usage + ledger all calling
 * requireAccount at once) cannot lose the campaign status request to a
 * create-conflict on the backend.
 */
export async function ensureTrafficAccount(): Promise<TrafficAccountRecord> {
  if (ensureAccountInFlight) return ensureAccountInFlight;
  ensureAccountInFlight = createTrafficAccount().finally(() => {
    ensureAccountInFlight = null;
  });
  return ensureAccountInFlight;
}

async function createTrafficAccount(): Promise<TrafficAccountRecord> {
  const identity = requireIdentity();
  const timestamp = nowSeconds();
  const message = buildTrafficAccountMessage(identity.globalMetaId, timestamp);
  const { signature } = await signWithKey({ mnemonic: identity.mnemonic, path: identity.path, message });
  const data = await trafficRequestJson({
    stage: 'account',
    method: 'POST',
    path: '/v1/traffic/accounts',
    body: { accountId: identity.globalMetaId },
    identity: { address: identity.mvcAddress, timestamp, signature },
  });
  const account = normalizeAccountRecord(data as Record<string, unknown>, 'account');
  persistLocalAccount(account);
  balanceCache = { ...account, fetchedAt: Date.now() };
  return account;
}

/**
 * ensureTrafficAccount with one retry (2026-09-12): the POST is get-or-create
 * on the backend (idempotent), so a single transient timeout/5xx deserves a
 * second shot before the sponsor-pre resolver degrades a pin to legacy quota
 * billing. A 404 (feature off) is deterministic and is not retried.
 */
async function ensureTrafficAccountWithRetry(): Promise<TrafficAccountRecord> {
  try {
    return await ensureTrafficAccount();
  } catch (error) {
    if (error instanceof TrafficApiError && error.featureUnavailable) {
      throw error;
    }
    console.warn('[TrafficAccount] ensure traffic account failed; retrying once:', error instanceof Error ? error.message : error);
    await delayMs(RESOLVER_RETRY_BACKOFF_MS);
    return ensureTrafficAccount();
  }
}

async function bindOneBot(
  account: TrafficAccountRecord,
  identity: ReturnType<typeof requireIdentity>,
  target: { botAddress: string; mnemonic: string; path: string },
): Promise<TrafficBindResultItem> {
  try {
    const timestamp = nowSeconds();
    const bindMessage = buildTrafficBindMessage(target.botAddress, account.accountId, timestamp);
    const identitySignature = await signWithKey({ mnemonic: identity.mnemonic, path: identity.path, message: bindMessage });
    const botSignature = await signWithKey({ mnemonic: target.mnemonic, path: target.path, message: bindMessage });
    await trafficRequestJson({
      stage: 'bind',
      method: 'POST',
      path: '/v1/traffic/accounts/bindings',
      body: {
        botAddress: target.botAddress,
        botSignature: botSignature.signature,
        bindMessage,
      },
      identity: { address: identity.mvcAddress, timestamp, signature: identitySignature.signature },
    });
    persistLocalBinding(target.botAddress, account.accountId);
    return { botAddress: target.botAddress, status: 'bound' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already bound to another account/i.test(message)) {
      return { botAddress: target.botAddress, status: 'conflict', error: message };
    }
    return { botAddress: target.botAddress, status: 'failed', error: message };
  }
}

/**
 * Bind every local MetaBot wallet address plus the identity address to the
 * traffic account. Idempotent: the backend returns the existing binding when
 * the address is already bound to this account; an address bound to a
 * different account is reported as 'conflict' without failing the batch.
 */
export async function bindAllLocalBots(): Promise<TrafficBindSummary> {
  const identity = requireIdentity();
  const account = await ensureTrafficAccount();

  const targets: Array<{ botAddress: string; mnemonic: string; path: string }> = [];
  const seen = new Set<string>();
  for (const metabot of getDeps().getMetabotStore().listMetabots()) {
    const botAddress = normalizeText(metabot.mvc_address);
    if (!botAddress || seen.has(botAddress.toLowerCase())) continue;
    const wallet = getDeps().getMetabotStore().getMetabotWalletById(metabot.wallet_id);
    if (!wallet?.mnemonic?.trim()) continue;
    seen.add(botAddress.toLowerCase());
    targets.push({ botAddress, mnemonic: wallet.mnemonic.trim(), path: wallet.path || DEFAULT_WALLET_PATH });
  }
  if (!seen.has(identity.mvcAddress.toLowerCase())) {
    targets.push({ botAddress: identity.mvcAddress, mnemonic: identity.mnemonic, path: identity.path });
  }

  const results: TrafficBindResultItem[] = [];
  for (const target of targets) {
    results.push(await bindOneBot(account, identity, target));
  }
  return {
    accountId: account.accountId,
    results,
    boundCount: results.filter((item) => item.status === 'bound').length,
    conflictCount: results.filter((item) => item.status === 'conflict').length,
    failedCount: results.filter((item) => item.status === 'failed').length,
  };
}

// ---------------------------------------------------------------------------
// Balance / ledger / usage (read APIs)
// ---------------------------------------------------------------------------

async function requireAccount(): Promise<TrafficAccountRecord> {
  const local = readLocalAccount();
  if (local) return local;
  return ensureTrafficAccount();
}

export async function getTrafficBalance(options: { forceRefresh?: boolean } = {}): Promise<TrafficAccountRecord> {
  const account = await requireAccount();
  if (
    !options.forceRefresh
    && balanceCache
    && balanceCache.accountId === account.accountId
    && Date.now() - balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS
  ) {
    const { fetchedAt: _fetchedAt, ...cached } = balanceCache;
    return cached;
  }
  const data = await trafficRequestJson({
    stage: 'balance',
    method: 'GET',
    path: `/v1/traffic/accounts/${encodeURIComponent(account.accountId)}/balance`,
  });
  const fresh = normalizeAccountRecord(data as Record<string, unknown>, 'balance');
  balanceCache = { ...fresh, fetchedAt: Date.now() };
  persistLocalAccount(fresh);
  return fresh;
}

export async function getTrafficLedger(input: {
  cursor?: number;
  limit?: number;
  direction?: number;
} = {}): Promise<{ entries: TrafficLedgerEntry[]; nextCursor: number }> {
  const account = await requireAccount();
  const data = await trafficRequestJson({
    stage: 'ledger',
    method: 'GET',
    path: `/v1/traffic/accounts/${encodeURIComponent(account.accountId)}/ledger`,
    query: { direction: input.direction, cursor: input.cursor, limit: input.limit },
  });
  const record = data as Record<string, unknown>;
  const entries = Array.isArray(record.entries) ? record.entries : [];
  return {
    entries: enrichLedgerEntriesFromLocalJournal(entries.flatMap((item) => {
      const entry = readObject(item);
      if (!entry) return [];
      return [{
        id: toNumber(entry.id),
        direction: toNumber(entry.direction),
        amountBytes: toNumber(entry.amountBytes ?? entry.amount_bytes),
        balanceAfter: toNumber(entry.balanceAfter ?? entry.balance_after),
        sourceType: pickText(entry, 'sourceType', 'source_type'),
        sourceId: pickText(entry, 'sourceId', 'source_id'),
        remark: pickText(entry, 'remark'),
        timestamp: toNumber(entry.timestamp),
      }];
    })),
    nextCursor: toNumber(record.nextCursor ?? record.next_cursor),
  };
}

/**
 * Best-effort local enrichment: sponsor ledger entries carry the sponsor
 * orderId as sourceId, which the local spend journal also records at commit
 * time — so entries for commits made on this device get their txId, bot
 * address, and pin kind attached. Entries from other devices, recharge
 * credits, and expired reservations have no local match and stay untouched.
 * Never throws: the raw ledger must keep rendering without the journal.
 */
function enrichLedgerEntriesFromLocalJournal(entries: TrafficLedgerEntry[]): TrafficLedgerEntry[] {
  try {
    if (!depsRef || entries.length === 0) return entries;
    const byOrderId = new Map<string, TrafficSpendJournalEntry>();
    for (const journalEntry of listLocalTrafficJournal({ limit: 1000 })) {
      // listLocalTrafficJournal is id-DESC: the first row per orderId is the latest.
      if (journalEntry.orderId && !byOrderId.has(journalEntry.orderId)) {
        byOrderId.set(journalEntry.orderId, journalEntry);
      }
    }
    if (byOrderId.size === 0) return entries;
    return entries.map((entry) => {
      const match = entry.sourceId ? byOrderId.get(entry.sourceId) : undefined;
      if (!match) return entry;
      const enriched: TrafficLedgerEntry = { ...entry, txId: match.txId, botAddress: match.botAddress };
      if (match.kind) enriched.kind = match.kind;
      return enriched;
    });
  } catch {
    return entries;
  }
}

export async function getTrafficDailyUsage(input: {
  from?: number;
  to?: number;
  botAddress?: string;
} = {}): Promise<TrafficDailyUsageRow[]> {
  const account = await requireAccount();
  const data = await trafficRequestJson({
    stage: 'usage',
    method: 'GET',
    path: `/v1/traffic/accounts/${encodeURIComponent(account.accountId)}/usage/daily`,
    query: { from: input.from, to: input.to, botAddress: input.botAddress },
  });
  const rows = Array.isArray(data) ? data : [];
  return rows.flatMap((item) => {
    const row = readObject(item);
    if (!row) return [];
    return [{
      date: pickText(row, 'date'),
      botAddress: pickText(row, 'botAddress', 'bot_address'),
      bytes: toNumber(row.bytes),
      txCount: toNumber(row.txCount ?? row.tx_count),
    }];
  });
}

export async function getTrafficUsageSummary(): Promise<TrafficUsageSummary> {
  const account = await requireAccount();
  const data = await trafficRequestJson({
    stage: 'usage',
    method: 'GET',
    path: `/v1/traffic/accounts/${encodeURIComponent(account.accountId)}/usage/summary`,
  });
  const record = data as Record<string, unknown>;
  return {
    todayBytes: toNumber(record.todayBytes ?? record.today_bytes),
    weekBytes: toNumber(record.weekBytes ?? record.week_bytes),
    monthBytes: toNumber(record.monthBytes ?? record.month_bytes),
  };
}

// ---------------------------------------------------------------------------
// Pricing + recharge (PayPal live since Phase 4; Alipay QR since Phase 5;
// mock payment for development)
// ---------------------------------------------------------------------------

export interface TrafficPricingPlan {
  planId: string;
  chain: string;
  payCurrency: string;
  payAmount: number;
  trafficBytes: number;
  status: number;
  remark: string;
}

/** Recharge order status values delivered by the backend (int64 in JSON). */
export const TRAFFIC_RECHARGE_STATUS = {
  CREATED: 1,
  PAID: 2,
  CREDITED: 3,
  CLOSED: 4,
} as const;

export interface TrafficRechargeOrder {
  orderId: string;
  payAmount: number;
  payCurrency: string;
  trafficBytes: number;
  gatewayParams: unknown;
}

export interface TrafficRechargeOrderStatus {
  orderId: string;
  status: number;
  paidAt?: number;
  creditedAt?: number;
}

/** Recharge gateways the backend payment-gateway seam can accept. */
export const RECHARGE_GATEWAYS = ['paypal', 'mock', 'alipay'] as const;
export type RechargeGateway = (typeof RECHARGE_GATEWAYS)[number];

/**
 * Default gateway for a pricing-plan currency (Phase 5): CNY plans go to
 * Alipay (当面付 QR, no ICP-filed domain required); every other currency goes
 * to PayPal. The renderer mirrors this mapping when it builds the payment
 * method tabs — keep the two in sync.
 */
export function gatewayForPlanCurrency(payCurrency: string): RechargeGateway {
  return normalizeText(payCurrency).toUpperCase() === 'CNY' ? 'alipay' : 'paypal';
}

/**
 * Whether this process is a packaged Electron app. Electron is loaded lazily
 * here, same pattern as getTrafficClientVersion: outside Electron
 * require('electron') yields no app, so plain-node tests read as unpackaged.
 */
export function isPackagedApp(): boolean {
  try {
    const { app } = require('electron');
    return Boolean(app?.isPackaged);
  } catch {
    return false;
  }
}

/**
 * Gateway used for new recharge orders. Resolution order:
 * 1. Non-packaged builds honor the kvStore `traffic.rechargeGateway` override
 *    (Advanced settings / test harnesses) — the mock gateway must never be
 *    reachable in production (Phase 4 requirement).
 * 2. An explicit `preferred` gateway (renderer picks it from the selected
 *    plan's currency, see gatewayForPlanCurrency) — validated against
 *    RECHARGE_GATEWAYS, anything else throws before any HTTP call.
 * 3. Default 'paypal' so legacy callers (no preference) behave as before.
 */
export function resolveRechargeGateway(preferred?: string): RechargeGateway {
  if (!isPackagedApp()) {
    try {
      const override = readRechargeGatewayOverride(getKvStore());
      if (override) return override;
    } catch {
      // store unavailable — fall through to the default
    }
  }
  const normalized = normalizeText(preferred).toLowerCase();
  if (normalized) {
    if ((RECHARGE_GATEWAYS as readonly string[]).includes(normalized)) {
      return normalized as RechargeGateway;
    }
    throw new TrafficApiError({ stage: 'recharge', message: `Unsupported recharge gateway: ${normalized}` });
  }
  return 'paypal';
}

/** Public rate table; no identity signature required. */
export async function getTrafficPricing(): Promise<TrafficPricingPlan[]> {
  const data = await trafficRequestJson({
    stage: 'pricing',
    method: 'GET',
    path: '/v1/traffic/pricing',
  });
  const rows = Array.isArray(data) ? data : [];
  return rows.flatMap((item) => {
    const row = readObject(item);
    if (!row) return [];
    const planId = pickText(row, 'planId', 'plan_id');
    if (!planId) return [];
    return [{
      planId,
      chain: pickText(row, 'chain'),
      payCurrency: pickText(row, 'payCurrency', 'pay_currency'),
      payAmount: toNumber(row.payAmount ?? row.pay_amount),
      trafficBytes: toNumber(row.trafficBytes ?? row.traffic_bytes),
      status: toNumber(row.status),
      remark: pickText(row, 'remark'),
    }];
  });
}

/**
 * Create a recharge order for the local identity's account. The gateway comes
 * from resolveRechargeGateway(gateway): an explicit caller preference (the
 * renderer derives it from the plan currency) wins in packaged builds, while
 * non-packaged builds let the kvStore override (mock) take precedence. The
 * result is validated against RECHARGE_GATEWAYS before hitting the backend.
 */
export async function createRechargeOrder(
  planId: string,
  gateway?: string,
): Promise<TrafficRechargeOrder> {
  const resolvedGateway = resolveRechargeGateway(gateway);
  const normalizedPlanId = normalizeText(planId);
  if (!normalizedPlanId) {
    throw new TrafficApiError({ stage: 'recharge', message: 'planId is required' });
  }
  const identity = requireIdentity();
  const account = await requireAccount();
  const timestamp = nowSeconds();
  const message = buildTrafficRechargeMessage(account.accountId, normalizedPlanId, timestamp);
  const { signature } = await signWithKey({ mnemonic: identity.mnemonic, path: identity.path, message });
  const data = await trafficRequestJson({
    stage: 'recharge',
    method: 'POST',
    path: '/v1/traffic/recharge/orders',
    body: { planId: normalizedPlanId, gateway: resolvedGateway },
    identity: { address: identity.mvcAddress, timestamp, signature },
  });
  const record = data as Record<string, unknown>;
  const orderId = pickText(record, 'orderId', 'order_id');
  if (!orderId) {
    throw new TrafficApiError({ stage: 'recharge', message: 'Traffic recharge order response is missing orderId.' });
  }
  return {
    orderId,
    payAmount: toNumber(record.payAmount ?? record.pay_amount),
    payCurrency: pickText(record, 'payCurrency', 'pay_currency'),
    trafficBytes: toNumber(record.trafficBytes ?? record.traffic_bytes),
    gatewayParams: record.gatewayParams ?? record.gateway_params ?? null,
  };
}

function normalizeRechargeOrderStatus(data: Record<string, unknown>): TrafficRechargeOrderStatus {
  const orderId = pickText(data, 'orderId', 'order_id');
  if (!orderId) {
    throw new TrafficApiError({ stage: 'recharge', message: 'Traffic recharge order status response is missing orderId.' });
  }
  const result: TrafficRechargeOrderStatus = {
    orderId,
    status: toNumber(data.status),
  };
  const paidAt = toNumber(data.paidAt ?? data.paid_at);
  const creditedAt = toNumber(data.creditedAt ?? data.credited_at);
  if (paidAt > 0) result.paidAt = paidAt;
  if (creditedAt > 0) result.creditedAt = creditedAt;
  return result;
}

/** Poll the recharge order status (created/paid/credited/closed). */
export async function getRechargeOrder(orderId: string): Promise<TrafficRechargeOrderStatus> {
  const normalizedOrderId = normalizeText(orderId);
  if (!normalizedOrderId) {
    throw new TrafficApiError({ stage: 'recharge', message: 'orderId is required' });
  }
  const data = await trafficRequestJson({
    stage: 'recharge',
    method: 'GET',
    path: `/v1/traffic/recharge/orders/${encodeURIComponent(normalizedOrderId)}`,
  });
  return normalizeRechargeOrderStatus(data as Record<string, unknown>);
}

/**
 * Dev/staging only: simulate gateway success for a mock recharge order
 * (backend gates this on traffic.mock_payment_enabled). On credit the local
 * balance cache is invalidated so the next read refetches.
 */
export async function mockConfirmRechargeOrder(orderId: string): Promise<TrafficRechargeOrderStatus> {
  const normalizedOrderId = normalizeText(orderId);
  if (!normalizedOrderId) {
    throw new TrafficApiError({ stage: 'recharge', message: 'orderId is required' });
  }
  const identity = requireIdentity();
  const gatewayTxnId = `mock-${normalizedOrderId}`;
  const timestamp = nowSeconds();
  const message = buildTrafficRechargeConfirmMessage(normalizedOrderId, gatewayTxnId, timestamp);
  const { signature } = await signWithKey({ mnemonic: identity.mnemonic, path: identity.path, message });
  const data = await trafficRequestJson({
    stage: 'recharge',
    method: 'POST',
    path: `/v1/traffic/recharge/orders/${encodeURIComponent(normalizedOrderId)}/mock-confirm`,
    body: { gatewayTxnId },
    identity: { address: identity.mvcAddress, timestamp, signature },
  });
  const status = normalizeRechargeOrderStatus(data as Record<string, unknown>);
  if (status.status === TRAFFIC_RECHARGE_STATUS.CREDITED) {
    balanceCache = null;
  }
  return status;
}

// ---------------------------------------------------------------------------
// Phase 3b: free-grant campaign + recharge codes
// ---------------------------------------------------------------------------

export interface TrafficFreeGrantCampaignStatus {
  enabled: boolean;
  grantBytes: number;
  claimed: boolean;
  claimable: boolean;
}

export interface TrafficFreeGrantClaimResult {
  grantId: number;
  grantBytes: number;
  balanceAfter: number;
}

export interface TrafficRedeemCodeResult {
  codeId: number;
  trafficBytes: number;
  balanceAfter: number;
}

/** Free-grant campaign state for the local account (signed GET). */
export async function getFreeGrantCampaignStatus(): Promise<TrafficFreeGrantCampaignStatus> {
  const identity = requireIdentity();
  const account = await requireAccount();
  const timestamp = nowSeconds();
  const message = buildTrafficFreeGrantStatusMessage(account.accountId, timestamp);
  const { signature } = await signWithKey({ mnemonic: identity.mnemonic, path: identity.path, message });
  const data = await trafficRequestJson({
    stage: 'campaign',
    method: 'GET',
    path: '/v1/traffic/campaign/free-grant/status',
    identity: { address: identity.mvcAddress, timestamp, signature },
  });
  const record = data as Record<string, unknown>;
  return {
    enabled: normalizeBoolean(record.enabled),
    grantBytes: toNumber(record.grantBytes ?? record.grant_bytes),
    claimed: normalizeBoolean(record.claimed),
    claimable: normalizeBoolean(record.claimable),
  };
}

/**
 * Claim the one-time free traffic grant for the local account. On success the
 * balance cache is invalidated so the next read refetches from the backend
 * (same contract as mockConfirmRechargeOrder).
 */
export async function claimFreeGrant(): Promise<TrafficFreeGrantClaimResult> {
  const identity = requireIdentity();
  const account = await requireAccount();
  const timestamp = nowSeconds();
  const message = buildTrafficFreeGrantClaimMessage(account.accountId, timestamp);
  const { signature } = await signWithKey({ mnemonic: identity.mnemonic, path: identity.path, message });
  const data = await trafficRequestJson({
    stage: 'campaign',
    method: 'POST',
    path: '/v1/traffic/campaign/free-grant/claim',
    body: { clientApp: TRAFFIC_CLIENT_APP_ID, clientVersion: getTrafficClientVersion() },
    identity: { address: identity.mvcAddress, timestamp, signature },
  });
  const record = data as Record<string, unknown>;
  balanceCache = null;
  return {
    grantId: toNumber(record.grantId ?? record.grant_id),
    grantBytes: toNumber(record.grantBytes ?? record.grant_bytes),
    balanceAfter: toNumber(record.balanceAfter ?? record.balance_after),
  };
}

/**
 * Redeem a one-time recharge code for the local account. The server trims and
 * uppercases the code itself; the client normalizes too so the request always
 * carries the canonical IDB-XXXX-XXXX-XXXX shape. On success the balance cache
 * is invalidated like the other credit paths.
 */
export async function redeemTrafficCode(code: string): Promise<TrafficRedeemCodeResult> {
  const normalizedCode = normalizeText(code).toUpperCase();
  if (!normalizedCode) {
    throw new TrafficApiError({ stage: 'redeem', message: 'code is required' });
  }
  const identity = requireIdentity();
  const account = await requireAccount();
  const timestamp = nowSeconds();
  const message = buildTrafficRedeemCodeMessage(account.accountId, timestamp);
  const { signature } = await signWithKey({ mnemonic: identity.mnemonic, path: identity.path, message });
  const data = await trafficRequestJson({
    stage: 'redeem',
    method: 'POST',
    path: '/v1/traffic/redeem-code',
    body: { code: normalizedCode },
    identity: { address: identity.mvcAddress, timestamp, signature },
  });
  const record = data as Record<string, unknown>;
  balanceCache = null;
  return {
    codeId: toNumber(record.codeId ?? record.code_id),
    trafficBytes: toNumber(record.trafficBytes ?? record.traffic_bytes),
    balanceAfter: toNumber(record.balanceAfter ?? record.balance_after),
  };
}

/** Renderer-facing traffic settings (mode + fallback policy). */
export function getTrafficSettingsSnapshot(): TrafficSettingsSnapshot {
  return getTrafficSettings(getKvStore());
}

export function setTrafficSettingsSnapshot(input: {
  mode?: unknown;
  fallbackPolicy?: unknown;
  apiBase?: unknown;
  rechargeGateway?: unknown;
}): TrafficSettingsSnapshot {
  return setTrafficSettings(getKvStore(), input);
}

// ---------------------------------------------------------------------------
// Local spend journal (SQLite) + balance cache deduction
// ---------------------------------------------------------------------------

function ensureJournalTable(): void {
  const store = getDeps().getStore();
  if (!store) return;
  const db = store.getDatabase();
  db.run(`
    CREATE TABLE IF NOT EXISTS traffic_spend_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_id TEXT NOT NULL,
      bot_address TEXT NOT NULL,
      order_id TEXT NOT NULL DEFAULT '',
      tx_size INTEGER NOT NULL DEFAULT 0,
      sponsored_miner_fee INTEGER NOT NULL DEFAULT 0,
      saved_fee INTEGER NOT NULL DEFAULT 0,
      billed_by TEXT NOT NULL DEFAULT 'quota',
      kind TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  // Idempotent migration for databases created before the kind column existed:
  // CREATE TABLE IF NOT EXISTS is a no-op there, so ALTER the old shape in place.
  const tableInfo = db.exec('PRAGMA table_info(traffic_spend_journal)');
  const columns = new Set(
    (tableInfo[0]?.values ?? []).map((row) => normalizeText(row[1])),
  );
  if (!columns.has('kind')) {
    db.run(`ALTER TABLE traffic_spend_journal ADD COLUMN kind TEXT NOT NULL DEFAULT ''`);
  }
}

/**
 * Record one locally-initiated sponsored commit. Traffic-billed spends also
 * decrement the in-memory balance cache by the known txSize so the UI reflects
 * the deduction immediately; quota-billed spends never touch the traffic
 * balance. Best-effort by design: never throws into the pin flow.
 */
export function recordLocalTrafficSpend(entry: {
  txId: string;
  botAddress: string;
  orderId?: string;
  txSize?: number;
  sponsoredMinerFee?: number;
  savedFee?: number;
  billedBy?: 'traffic' | 'quota';
  /** Pin protocol path or purpose tag (e.g. /protocols/simplemsg, /file). */
  kind?: string;
}): void {
  try {
    if (!depsRef) return;
    const txId = normalizeText(entry.txId);
    const botAddress = normalizeText(entry.botAddress);
    if (!txId || !botAddress) return;
    const txSize = Math.max(0, Math.trunc(toNumber(entry.txSize)));
    ensureJournalTable();
    const store = getDeps().getStore();
    if (!store) return;
    store.getDatabase().run(
      `INSERT INTO traffic_spend_journal
        (tx_id, bot_address, order_id, tx_size, sponsored_miner_fee, saved_fee, billed_by, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        txId,
        botAddress,
        normalizeText(entry.orderId),
        txSize,
        Math.max(0, Math.trunc(toNumber(entry.sponsoredMinerFee))),
        Math.max(0, Math.trunc(toNumber(entry.savedFee))),
        entry.billedBy === 'traffic' ? 'traffic' : 'quota',
        normalizeText(entry.kind),
        Date.now(),
      ],
    );
    store.getSaveFunction()();

    if (entry.billedBy === 'traffic' && balanceCache && txSize > 0) {
      balanceCache = {
        ...balanceCache,
        balanceBytes: Math.max(0, balanceCache.balanceBytes - txSize),
        spentBytesTotal: balanceCache.spentBytesTotal + txSize,
      };
    }
  } catch (error) {
    console.warn('[TrafficAccount] failed to record local spend:', error instanceof Error ? error.message : error);
  }
}

export function listLocalTrafficJournal(input: {
  limit?: number;
  botAddress?: string;
} = {}): TrafficSpendJournalEntry[] {
  try {
    if (!depsRef) return [];
    ensureJournalTable();
    const store = getDeps().getStore();
    if (!store) return [];
    const limit = Number.isFinite(input.limit) && (input.limit ?? 0) > 0 ? Math.trunc(input.limit as number) : 100;
    const botAddress = normalizeText(input.botAddress);
    const result = botAddress
      ? store.getDatabase().exec(
        'SELECT * FROM traffic_spend_journal WHERE bot_address = ? ORDER BY id DESC LIMIT ?',
        [botAddress, limit],
      )
      : store.getDatabase().exec(
        'SELECT * FROM traffic_spend_journal ORDER BY id DESC LIMIT ?',
        [limit],
      );
    const rows = result[0];
    if (!rows) return [];
    const columnIndex = new Map(rows.columns.map((column, index) => [column, index]));
    return rows.values.map((values) => ({
      id: toNumber(values[columnIndex.get('id') as number]),
      txId: normalizeText(values[columnIndex.get('tx_id') as number]),
      botAddress: normalizeText(values[columnIndex.get('bot_address') as number]),
      orderId: normalizeText(values[columnIndex.get('order_id') as number]),
      txSize: toNumber(values[columnIndex.get('tx_size') as number]),
      sponsoredMinerFee: toNumber(values[columnIndex.get('sponsored_miner_fee') as number]),
      savedFee: toNumber(values[columnIndex.get('saved_fee') as number]),
      billedBy: normalizeText(values[columnIndex.get('billed_by') as number]) === 'traffic' ? 'traffic' : 'quota',
      kind: columnIndex.has('kind') ? normalizeText(values[columnIndex.get('kind') as number]) : '',
      createdAt: toNumber(values[columnIndex.get('created_at') as number]),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sponsor pre integration (trafficAccount resolver)
// ---------------------------------------------------------------------------

/**
 * Build the trafficAccount block for a sponsor pre call, or return undefined
 * to keep the legacy quota path. Never throws: traffic mode off, no identity,
 * no account (backend 404 / offline), or an unbindable bot all degrade to
 * undefined. Lazily ensures the account and binds the bot on first use.
 * Degradation is never silent (2026-09-12): while traffic mode is ON, every
 * drop to the legacy quota path is WARN-logged with its cause, and the
 * idempotent ensure/bind steps retry once after a short backoff so a single
 * transient network blip no longer flips a pin to legacy quota billing.
 */
export async function resolveSponsorTrafficAccount(input: {
  botAddress: string;
  challengeId: string;
  botMnemonic?: string;
  botWalletPath?: string;
}): Promise<MvcSponsorTrafficAccount | undefined> {
  const botAddress = normalizeText(input.botAddress);
  try {
    if (!depsRef) return undefined;
    if (getTrafficPinMode(getKvStore()) !== 'traffic') return undefined;
    if (!botAddress || !normalizeText(input.challengeId)) return undefined;

    const identity = requireIdentity();
    let account = readLocalAccount();
    if (!account) {
      account = await ensureTrafficAccountWithRetry();
    }
    if (!isBotBoundLocally(botAddress, account.accountId)) {
      const botMnemonic = normalizeText(input.botMnemonic);
      if (!botMnemonic) return undefined;
      const target = {
        botAddress,
        mnemonic: botMnemonic,
        path: normalizeText(input.botWalletPath) || DEFAULT_WALLET_PATH,
      };
      let bindResult = await bindOneBot(account, identity, target);
      if (bindResult.status === 'failed') {
        await delayMs(RESOLVER_RETRY_BACKOFF_MS);
        bindResult = await bindOneBot(account, identity, target);
      }
      if (bindResult.status !== 'bound') {
        console.warn(`[TrafficAccount] bot ${botAddress} could not be bound to the traffic account (${bindResult.status}${bindResult.error ? `: ${bindResult.error}` : ''}); this pin bills the legacy sponsor quota`);
        return undefined;
      }
    }

    const timestamp = nowSeconds();
    const message = buildTrafficPreMessage(account.accountId, normalizeText(input.challengeId));
    const { signature } = await signWithKey({ mnemonic: identity.mnemonic, path: identity.path, message });
    return { accountId: account.accountId, authSignature: signature, timestamp };
  } catch (error) {
    console.warn(`[TrafficAccount] traffic-account resolution failed for bot ${botAddress || 'unknown'}; this pin bills the legacy sponsor quota:`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

interface IpcMainLike {
  handle: (channel: string, listener: (_event: unknown, input: any) => unknown) => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** IPC failure payload; carries the backend data.errorCode when present. */
function getErrorPayload(error: unknown): { error: string; errorCode?: string } {
  const errorCode = error instanceof TrafficApiError ? error.errorCode : '';
  return { error: getErrorMessage(error), ...(errorCode ? { errorCode } : {}) };
}

export function registerTrafficAccountIpcHandlers(deps: { ipcMain: IpcMainLike }): void {
  const { ipcMain } = deps;
  ipcMain.handle('traffic:ensureAccount', async () => {
    try {
      return { success: true, account: await ensureTrafficAccount() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getAccount', async () => {
    try {
      return { success: true, account: getLocalTrafficAccount() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getBalance', async (_event, input: { forceRefresh?: boolean }) => {
    try {
      return { success: true, balance: await getTrafficBalance(input ?? {}) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getLedger', async (_event, input: { cursor?: number; limit?: number; direction?: number }) => {
    try {
      return { success: true, ...(await getTrafficLedger(input ?? {})) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getDailyUsage', async (_event, input: { from?: number; to?: number; botAddress?: string }) => {
    try {
      return { success: true, rows: await getTrafficDailyUsage(input ?? {}) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getUsageSummary', async () => {
    try {
      return { success: true, summary: await getTrafficUsageSummary() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:bindAllBots', async () => {
    try {
      return { success: true, summary: await bindAllLocalBots() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getLocalJournal', async (_event, input: { limit?: number; botAddress?: string }) => {
    try {
      return { success: true, entries: listLocalTrafficJournal(input ?? {}) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getPricing', async () => {
    try {
      return { success: true, plans: await getTrafficPricing() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getRechargeGateway', async () => {
    try {
      return { success: true, gateway: resolveRechargeGateway(), packaged: isPackagedApp() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:createRechargeOrder', async (_event, input: { planId?: string; gateway?: unknown }) => {
    try {
      const requested = normalizeText(input?.gateway);
      return {
        success: true,
        order: await createRechargeOrder(String(input?.planId ?? ''), requested || undefined),
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getRechargeOrder', async (_event, input: { orderId?: string }) => {
    try {
      return { success: true, order: await getRechargeOrder(String(input?.orderId ?? '')) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:mockConfirmRechargeOrder', async (_event, input: { orderId?: string }) => {
    try {
      return { success: true, order: await mockConfirmRechargeOrder(String(input?.orderId ?? '')) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:getFreeGrantCampaignStatus', async () => {
    try {
      return { success: true, campaign: await getFreeGrantCampaignStatus() };
    } catch (error) {
      return { success: false, ...getErrorPayload(error) };
    }
  });
  ipcMain.handle('traffic:claimFreeGrant', async () => {
    try {
      return { success: true, claim: await claimFreeGrant() };
    } catch (error) {
      return { success: false, ...getErrorPayload(error) };
    }
  });
  ipcMain.handle('traffic:redeemCode', async (_event, input: { code?: string }) => {
    try {
      return { success: true, result: await redeemTrafficCode(String(input?.code ?? '')) };
    } catch (error) {
      return { success: false, ...getErrorPayload(error) };
    }
  });
  ipcMain.handle('traffic:getSettings', async () => {
    try {
      return { success: true, settings: getTrafficSettingsSnapshot() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  ipcMain.handle('traffic:setSettings', async (_event, input: { mode?: unknown; fallbackPolicy?: unknown; apiBase?: unknown; rechargeGateway?: unknown }) => {
    try {
      return { success: true, settings: setTrafficSettingsSnapshot(input ?? {}) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
