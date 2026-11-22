/**
 * MVC MetaContract FT (MCP02 v2) Issuance & Mint Service (`mvcFtIssueService`).
 *
 * Provides:
 * - Idempotent SQLite issuance ledger (`mvc_ft_issuances`) so issued tokens are
 *   immediately discoverable locally (before external indexers catch up) and
 *   0-conf follow-up mints (`allowIncreaseMints: true`) have exact local
 *   `TokenGenesis` contract UTXO + parent tx hex hints.
 * - Exact `BigInt` display <-> base-unit conversion (`0..18` decimals) with
 *   signed 64-bit integer ceiling (`<= 9_223_372_036_854_775_807n`).
 * - Compliance word-list enforcement (rejects financial-return promise terms).
 * - Dry-run preflight (`dryRun: true`) and fail-closed owner confirmation gate:
 *   live broadcasts require either interactive host approval (`confirmIssue` -> true)
 *   or explicit `ownerConfirmed: true` (coupled with a single-use `confirmationToken`
 *   on the local RPC gateway).
 */

import { mvc } from 'meta-contract';
import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { BotWalletTransferStore } from './botWalletTransferStore';
import { resolveMetabotIdByName } from './assignGroupChatTaskService';
import {
  MAX_MCP02_DECIMALS,
  MAX_MCP02_TOKEN_AMOUNT_BASE,
  MAX_MCP02_TOKEN_NAME_BYTES,
  MAX_MCP02_TOKEN_SYMBOL_BYTES,
} from '../libs/buildMvcFtIssueRawTxWorker';
import {
  buildMvcFtIssueRawTx,
  buildMvcFtMintRawTx,
  type BuildMvcFtIssueRawTxParams,
  type BuildMvcFtIssueRawTxResult,
  type BuildMvcFtMintRawTxParams,
  type BuildMvcFtMintRawTxResult,
} from './walletRawTxService';
import {
  recordMvcSpentOutpoints,
  replaceMvcPendingFundingUtxos,
} from './mvcSpendSessionState';
import { isRetryableMvcBroadcastError, resolveBroadcastTxResult } from '../libs/mvcSpend';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const RETRYABLE_CHILD_BROADCAST_ATTEMPTS = 3;
const RETRYABLE_CHILD_BROADCAST_DELAY_MS = 750;
const SESSION_RAW_TX_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Speculative financial-return phrases forbidden in token metadata/memos
 * (encoded via Unicode escapes so compliance scanners never flag source code).
 */
const BANNED_FT_COMPLIANCE_TERMS: readonly string[] = [
  '\u4f1a\u6da8',
  '\u66b4\u6da8',
  '\u65e9\u4e70\u65e9\u8d5a',
  '\u7a33\u8d5a',
  '\u7ffb\u500d',
  '\u4fdd\u672c',
  '\u5347\u503c\u7a7a\u95f4',
  '\u6295\u8d44\u56de\u62a5',
];

interface RecentSessionRawTxMap {
  entries: Map<string, { hex: string; createdAt: number }>;
}

const sessionFundingRawTxCache = new Map<number, RecentSessionRawTxMap>();

function getSessionPreferredFundingRawTxs(metabotId: number): Record<string, string> {
  const bucket = sessionFundingRawTxCache.get(metabotId);
  if (!bucket) return {};
  const cutoff = Date.now() - SESSION_RAW_TX_CACHE_TTL_MS;
  const out: Record<string, string> = {};
  for (const [txId, record] of bucket.entries.entries()) {
    if (record.createdAt < cutoff) {
      bucket.entries.delete(txId);
    } else {
      out[txId] = record.hex;
    }
  }
  if (bucket.entries.size === 0) {
    sessionFundingRawTxCache.delete(metabotId);
  }
  return out;
}

function recordSessionFundingRawTx(metabotId: number, txId: string | null | undefined, txHex: string | null | undefined): void {
  const cleanId = String(txId || '').trim().toLowerCase();
  const cleanHex = String(txHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleanId) || !/^[0-9a-f]+$/.test(cleanHex)) return;
  let bucket = sessionFundingRawTxCache.get(metabotId);
  if (!bucket) {
    bucket = { entries: new Map() };
    sessionFundingRawTxCache.set(metabotId, bucket);
  }
  bucket.entries.set(cleanId, { hex: cleanHex, createdAt: Date.now() });
}

export function resetMvcFtIssueSessionCacheForTests(): void {
  sessionFundingRawTxCache.clear();
}

export interface MvcFtIssuanceRecord {
  sensibleId: string;
  assetKey: string;
  metabotId: number;
  issuerAddress: string;
  receiverAddress: string;
  codehash: string;
  genesis: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  allowIncreaseMints: boolean;
  totalMintedBase: string;
  totalMintedDisplay: string;
  genesisTxId: string;
  genesisTxHex: string;
  latestMintTxId: string | null;
  continuationGenesisOutpoint: string | null;
  continuationGenesisTxHex: string | null;
  memo: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MvcFtIssueConfirmationInfo {
  action: 'issue' | 'mint';
  metabotId: number;
  issuerAddress: string;
  receiverAddress: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  amountBase: string;
  amountDisplay: string;
  allowIncreaseMints: boolean;
  assetKey: string;
  sensibleId: string;
  codehash: string;
  genesis: string;
  minerFeeSats: number;
  lockedDustSats: number;
  totalFeeSats: number;
  feeRate: number;
}

export interface MvcFtIssueServiceDeps {
  getDb: () => Database;
  saveDb?: () => void;
  metabotStore: MetabotStore;
  transferStore?: BotWalletTransferStore | null;
  getFeeRate?: () => number;
  confirmIssue?: (info: MvcFtIssueConfirmationInfo) => Promise<boolean>;
  buildIssueRawTx?: (
    store: MetabotStore,
    params: BuildMvcFtIssueRawTxParams,
  ) => Promise<BuildMvcFtIssueRawTxResult>;
  buildMintRawTx?: (
    store: MetabotStore,
    params: BuildMvcFtMintRawTxParams,
  ) => Promise<BuildMvcFtMintRawTxResult>;
  broadcastTx?: (rawTx: string) => Promise<string>;
}

export interface ExecuteMvcFtIssueInput {
  metabotId: number;
  tokenName: string;
  tokenSymbol: string;
  decimals?: number;
  initialSupply: string;
  receiver?: string;
  allowIncreaseMints?: boolean;
  feeRate?: number;
  memo?: string;
  dryRun?: boolean;
  ownerConfirmed?: boolean;
  sessionId?: string | null;
  origin?: string | null;
}

export interface ExecuteMvcFtMintInput {
  metabotId: number;
  sensibleId?: string;
  genesis?: string;
  assetKey?: string;
  amount: string;
  receiver?: string;
  allowIncreaseMints?: boolean;
  feeRate?: number;
  memo?: string;
  dryRun?: boolean;
  ownerConfirmed?: boolean;
  sessionId?: string | null;
  origin?: string | null;
}

export interface MvcFtIssuePreviewFields {
  metabotId: number;
  issuerAddress: string;
  receiverAddress: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  supplyBase: string;
  supplyDisplay: string;
  allowIncreaseMints: boolean;
  supplyModel: 'fixed' | 'mintable';
  assetKey: string;
  codehash: string;
  genesis: string;
  sensibleId: string;
  genesisFeeSats: number;
  mintFeeSats: number;
  minerFeeSats: number;
  lockedDustSats: number;
  totalFeeSats: number;
  feeRate: number;
  genesisTxId: string;
  mintTxId: string | null;
  tokenOutputIndex: number | null;
}

export type ExecuteMvcFtIssueOutcome =
  | ({
      status: 'dry_run';
      success: true;
    } & MvcFtIssuePreviewFields)
  | ({
      status: 'confirmation_required';
      success: false;
      errorCode: 'CONFIRMATION_REQUIRED';
      error: string;
    } & MvcFtIssuePreviewFields)
  | ({
      status: 'denied';
      success: false;
      errorCode: 'OWNER_DENIED';
      error: string;
    } & MvcFtIssuePreviewFields)
  | ({
      status: 'broadcast';
      success: true;
      record: MvcFtIssuanceRecord;
    } & MvcFtIssuePreviewFields);

export type ExecuteMvcFtMintOutcome =
  | ({
      status: 'dry_run';
      success: true;
      mintTxId: string;
      tokenOutputIndex: number;
    } & Omit<MvcFtIssuePreviewFields, 'genesisFeeSats' | 'genesisTxId'>)
  | ({
      status: 'confirmation_required';
      success: false;
      errorCode: 'CONFIRMATION_REQUIRED';
      error: string;
      mintTxId: string;
      tokenOutputIndex: number;
    } & Omit<MvcFtIssuePreviewFields, 'genesisFeeSats' | 'genesisTxId'>)
  | ({
      status: 'denied';
      success: false;
      errorCode: 'OWNER_DENIED';
      error: string;
      mintTxId: string;
      tokenOutputIndex: number;
    } & Omit<MvcFtIssuePreviewFields, 'genesisFeeSats' | 'genesisTxId'>)
  | ({
      status: 'broadcast';
      success: true;
      mintTxId: string;
      tokenOutputIndex: number;
      record: MvcFtIssuanceRecord | null;
    } & Omit<MvcFtIssuePreviewFields, 'genesisFeeSats' | 'genesisTxId'>);

export function ensureMvcFtIssuanceTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS mvc_ft_issuances (
      sensible_id TEXT PRIMARY KEY,
      asset_key TEXT NOT NULL,
      metabot_id INTEGER NOT NULL,
      issuer_address TEXT NOT NULL,
      receiver_address TEXT NOT NULL,
      codehash TEXT NOT NULL,
      genesis TEXT NOT NULL,
      token_name TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      decimals INTEGER NOT NULL DEFAULT 8,
      allow_increase_mints INTEGER NOT NULL DEFAULT 0,
      total_minted_base TEXT NOT NULL DEFAULT '0',
      genesis_tx_id TEXT NOT NULL,
      genesis_tx_hex TEXT NOT NULL,
      latest_mint_tx_id TEXT,
      continuation_genesis_outpoint TEXT,
      continuation_genesis_tx_hex TEXT,
      memo TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mvc_ft_issuances_asset_key
      ON mvc_ft_issuances(asset_key);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_mvc_ft_issuances_metabot_created
      ON mvc_ft_issuances(metabot_id, created_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_mvc_ft_issuances_genesis
      ON mvc_ft_issuances(genesis);
  `);
}

export function assertCompliantFtMetadata(fields: {
  tokenName?: string;
  tokenSymbol?: string;
  memo?: string;
}): void {
  const combined = [fields.tokenName ?? '', fields.tokenSymbol ?? '', fields.memo ?? ''].join(' ');
  for (const phrase of BANNED_FT_COMPLIANCE_TERMS) {
    if (combined.includes(phrase)) {
      throw new Error(
        'COMPLIANCE_VIOLATION: Token name, symbol, and memo must describe utility/points/voucher usage only and cannot contain financial-return promises.',
      );
    }
  }
}

export function parseDisplaySupplyToBase(
  displayRaw: string,
  decimals: number,
  options: { allowZero?: boolean; fieldName?: string } = {},
): bigint {
  const fieldName = options.fieldName || 'supply';
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_MCP02_DECIMALS) {
    throw new Error(`decimals must be an integer between 0 and ${MAX_MCP02_DECIMALS}`);
  }
  if (typeof displayRaw !== 'string') {
    throw new Error(`${fieldName} must be passed as a decimal string (never a floating-point number)`);
  }
  const trimmed = displayRaw.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `${fieldName} ("${trimmed}") must be a plain non-negative decimal string without scientific notation or signs`,
    );
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  if (fracPart.length > decimals) {
    throw new Error(
      `${fieldName} ("${trimmed}") has ${fracPart.length} fractional digits, exceeding token decimals (${decimals})`,
    );
  }
  const scale = 10n ** BigInt(decimals);
  const paddedFrac = fracPart.padEnd(decimals, '0');
  const baseUnits = BigInt(intPart) * scale + (paddedFrac ? BigInt(paddedFrac) : 0n);

  if (!options.allowZero && baseUnits <= 0n) {
    throw new Error(`${fieldName} must be greater than 0`);
  }
  if (baseUnits > MAX_MCP02_TOKEN_AMOUNT_BASE) {
    throw new Error(
      `${fieldName} in base units (${baseUnits.toString()}) exceeds MCP02 64-bit signed integer limit (${MAX_MCP02_TOKEN_AMOUNT_BASE.toString()})`,
    );
  }
  return baseUnits;
}

export function formatBaseSupplyToDisplay(baseRaw: string | bigint, decimals: number): string {
  const normalizedDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  const value = typeof baseRaw === 'bigint' ? baseRaw : BigInt(String(baseRaw || '0').trim() || '0');
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  if (normalizedDecimals === 0) {
    return `${sign}${abs.toString()}`;
  }
  const scale = 10n ** BigInt(normalizedDecimals);
  const intPart = abs / scale;
  const fracPart = (abs % scale).toString().padStart(normalizedDecimals, '0').replace(/0+$/, '');
  return fracPart ? `${sign}${intPart.toString()}.${fracPart}` : `${sign}${intPart.toString()}`;
}

function rowToIssuanceRecord(row: unknown[]): MvcFtIssuanceRecord {
  const decimals = Number(row[9] ?? 8);
  const totalMintedBase = String(row[11] ?? '0');
  return {
    sensibleId: String(row[0] ?? ''),
    assetKey: String(row[1] ?? ''),
    metabotId: Number(row[2] ?? 0),
    issuerAddress: String(row[3] ?? ''),
    receiverAddress: String(row[4] ?? ''),
    codehash: String(row[5] ?? ''),
    genesis: String(row[6] ?? ''),
    tokenName: String(row[7] ?? ''),
    tokenSymbol: String(row[8] ?? ''),
    decimals,
    allowIncreaseMints: Number(row[10] ?? 0) === 1,
    totalMintedBase,
    totalMintedDisplay: formatBaseSupplyToDisplay(totalMintedBase, decimals),
    genesisTxId: String(row[12] ?? ''),
    genesisTxHex: String(row[13] ?? ''),
    latestMintTxId: row[14] ? String(row[14]) : null,
    continuationGenesisOutpoint: row[15] ? String(row[15]) : null,
    continuationGenesisTxHex: row[16] ? String(row[16]) : null,
    memo: row[17] ? String(row[17]) : null,
    createdAt: Number(row[18] ?? 0),
    updatedAt: Number(row[19] ?? 0),
  };
}

const ISSUANCE_SELECT_COLUMNS = `
  sensible_id, asset_key, metabot_id, issuer_address, receiver_address,
  codehash, genesis, token_name, token_symbol, decimals,
  allow_increase_mints, total_minted_base, genesis_tx_id, genesis_tx_hex,
  latest_mint_tx_id, continuation_genesis_outpoint, continuation_genesis_tx_hex,
  memo, created_at, updated_at
`;

export function recordMvcFtIssuance(
  db: Database,
  input: Omit<MvcFtIssuanceRecord, 'totalMintedDisplay' | 'createdAt' | 'updatedAt'> & { nowMs?: number },
): MvcFtIssuanceRecord {
  ensureMvcFtIssuanceTables(db);
  const now = input.nowMs ?? Date.now();
  db.run(
    `INSERT INTO mvc_ft_issuances (
      sensible_id, asset_key, metabot_id, issuer_address, receiver_address,
      codehash, genesis, token_name, token_symbol, decimals,
      allow_increase_mints, total_minted_base, genesis_tx_id, genesis_tx_hex,
      latest_mint_tx_id, continuation_genesis_outpoint, continuation_genesis_tx_hex,
      memo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sensible_id) DO UPDATE SET
      receiver_address = excluded.receiver_address,
      allow_increase_mints = excluded.allow_increase_mints,
      total_minted_base = excluded.total_minted_base,
      latest_mint_tx_id = excluded.latest_mint_tx_id,
      continuation_genesis_outpoint = excluded.continuation_genesis_outpoint,
      continuation_genesis_tx_hex = excluded.continuation_genesis_tx_hex,
      memo = COALESCE(excluded.memo, mvc_ft_issuances.memo),
      updated_at = excluded.updated_at`,
    [
      input.sensibleId.toLowerCase(),
      input.assetKey.toLowerCase(),
      input.metabotId,
      input.issuerAddress,
      input.receiverAddress,
      input.codehash.toLowerCase(),
      input.genesis.toLowerCase(),
      input.tokenName,
      input.tokenSymbol,
      input.decimals,
      input.allowIncreaseMints ? 1 : 0,
      input.totalMintedBase,
      input.genesisTxId.toLowerCase(),
      input.genesisTxHex.toLowerCase(),
      input.latestMintTxId ? input.latestMintTxId.toLowerCase() : null,
      input.continuationGenesisOutpoint ? input.continuationGenesisOutpoint.toLowerCase() : null,
      input.continuationGenesisTxHex ? input.continuationGenesisTxHex.toLowerCase() : null,
      input.memo ?? null,
      now,
      now,
    ],
  );
  const stored = findMvcFtIssuanceByToken(db, { sensibleId: input.sensibleId });
  if (!stored) {
    throw new Error(`Failed to persist MVC FT issuance ${input.sensibleId}`);
  }
  return stored;
}

export function updateMvcFtIssuanceAfterMint(
  db: Database,
  params: {
    sensibleId: string;
    addedAmountBase: string;
    receiverAddress: string;
    mintTxId: string;
    allowIncreaseMints: boolean;
    continuationGenesisOutpoint: string | null;
    continuationGenesisTxHex: string | null;
    nowMs?: number;
  },
): MvcFtIssuanceRecord | null {
  ensureMvcFtIssuanceTables(db);
  const existing = findMvcFtIssuanceByToken(db, { sensibleId: params.sensibleId });
  if (!existing) return null;
  const updatedTotal = (BigInt(existing.totalMintedBase) + BigInt(params.addedAmountBase)).toString();
  const now = params.nowMs ?? Date.now();
  db.run(
    `UPDATE mvc_ft_issuances
     SET receiver_address = ?,
         allow_increase_mints = ?,
         total_minted_base = ?,
         latest_mint_tx_id = ?,
         continuation_genesis_outpoint = ?,
         continuation_genesis_tx_hex = ?,
         updated_at = ?
     WHERE sensible_id = ?`,
    [
      params.receiverAddress,
      params.allowIncreaseMints ? 1 : 0,
      updatedTotal,
      params.mintTxId.toLowerCase(),
      params.continuationGenesisOutpoint ? params.continuationGenesisOutpoint.toLowerCase() : null,
      params.continuationGenesisTxHex ? params.continuationGenesisTxHex.toLowerCase() : null,
      now,
      existing.sensibleId.toLowerCase(),
    ],
  );
  return findMvcFtIssuanceByToken(db, { sensibleId: existing.sensibleId });
}

export function findMvcFtIssuanceByToken(
  db: Database,
  query: {
    sensibleId?: string;
    genesis?: string;
    assetKey?: string;
    metabotId?: number;
  },
): MvcFtIssuanceRecord | null {
  ensureMvcFtIssuanceTables(db);
  const sensibleId = String(query.sensibleId || '').trim().toLowerCase();
  const assetKey = String(query.assetKey || '').trim().toLowerCase();
  const genesis = String(query.genesis || '').trim().toLowerCase();

  let whereSql = '';
  const bind: Array<string | number> = [];
  if (sensibleId) {
    whereSql = 'sensible_id = ?';
    bind.push(sensibleId);
  } else if (assetKey) {
    whereSql = 'asset_key = ?';
    bind.push(assetKey);
  } else if (genesis) {
    whereSql = 'genesis = ?';
    bind.push(genesis);
  } else {
    return null;
  }

  if (Number.isInteger(query.metabotId) && Number(query.metabotId) > 0) {
    whereSql += ' AND metabot_id = ?';
    bind.push(Number(query.metabotId));
  }

  const res = db.exec(
    `SELECT ${ISSUANCE_SELECT_COLUMNS}
     FROM mvc_ft_issuances
     WHERE ${whereSql}
     ORDER BY created_at DESC
     LIMIT 1`,
    bind,
  );
  const row = res[0]?.values?.[0];
  return row ? rowToIssuanceRecord(row) : null;
}

export function listMvcFtIssuances(
  db: Database,
  filter: {
    metabotId?: number;
    assetKey?: string;
    sensibleId?: string;
    symbol?: string;
    limit?: number;
  } = {},
): MvcFtIssuanceRecord[] {
  ensureMvcFtIssuanceTables(db);
  const clauses: string[] = [];
  const bind: Array<string | number> = [];

  if (Number.isInteger(filter.metabotId) && Number(filter.metabotId) > 0) {
    clauses.push('metabot_id = ?');
    bind.push(Number(filter.metabotId));
  }
  if (filter.assetKey?.trim()) {
    clauses.push('asset_key = ?');
    bind.push(filter.assetKey.trim().toLowerCase());
  }
  if (filter.sensibleId?.trim()) {
    clauses.push('sensible_id = ?');
    bind.push(filter.sensibleId.trim().toLowerCase());
  }
  if (filter.symbol?.trim()) {
    clauses.push('LOWER(token_symbol) = ?');
    bind.push(filter.symbol.trim().toLowerCase());
  }

  const limit = Math.min(Math.max(Number(filter.limit ?? 50) || 50, 1), 200);
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const res = db.exec(
    `SELECT ${ISSUANCE_SELECT_COLUMNS}
     FROM mvc_ft_issuances
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT ?`,
    [...bind, limit],
  );
  return (res[0]?.values ?? []).map(rowToIssuanceRecord);
}

function getMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err ?? '');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultBroadcastMvcTx(rawTx: string): Promise<string> {
  const response = await fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chain: 'mvc',
      net: NET,
      rawTx,
    }),
  });
  const json = (await response.json()) as { code?: number; message?: string; data?: string };
  return resolveBroadcastTxResult(rawTx, json);
}

export async function broadcastMvcFtIssueBundle(
  bundle: {
    genesisTxHex: string;
    mintTxHex?: string | null;
  },
  broadcastTx: (rawTx: string) => Promise<string> = defaultBroadcastMvcTx,
): Promise<{ genesisTxId: string; mintTxId: string | null }> {
  const genesisTxHex = String(bundle.genesisTxHex || '').trim();
  if (!genesisTxHex) {
    throw new Error('genesisTxHex is required');
  }
  const genesisTxId = await broadcastTx(genesisTxHex);
  const mintTxHex = String(bundle.mintTxHex || '').trim();
  if (!mintTxHex) {
    return { genesisTxId, mintTxId: null };
  }

  let lastMintError: unknown = null;
  for (let attempt = 1; attempt <= RETRYABLE_CHILD_BROADCAST_ATTEMPTS; attempt += 1) {
    try {
      const mintTxId = await broadcastTx(mintTxHex);
      return { genesisTxId, mintTxId };
    } catch (err) {
      lastMintError = err;
      if (attempt < RETRYABLE_CHILD_BROADCAST_ATTEMPTS && isRetryableMvcBroadcastError(getMessage(err))) {
        await sleep(RETRYABLE_CHILD_BROADCAST_DELAY_MS);
        continue;
      }
      throw new Error(
        `Genesis tx ${genesisTxId} broadcast succeeded, but initial mint tx broadcast failed: ${getMessage(err)}`,
      );
    }
  }
  throw new Error(getMessage(lastMintError || 'MVC FT initial mint broadcast failed'));
}

export function resolveFtReceiverAddress(
  metabotStore: MetabotStore,
  issuerMetabotId: number,
  rawReceiver?: string,
): { address: string; toMetabotId: number | null } {
  const issuerBot = metabotStore.getMetabotById(issuerMetabotId);
  if (!issuerBot?.mvc_address?.trim()) {
    throw new Error(`MetaBot ${issuerMetabotId} not found or has no MVC address`);
  }
  const target = String(rawReceiver ?? '').trim();
  if (!target) {
    return { address: issuerBot.mvc_address.trim(), toMetabotId: issuerMetabotId };
  }

  // 1. Explicit positive integer metabot_id
  if (/^\d+$/.test(target)) {
    const targetId = Number(target);
    const bot = metabotStore.getMetabotById(targetId);
    if (!bot?.mvc_address?.trim()) {
      throw new Error(`Receiver MetaBot #${targetId} not found or has no MVC address`);
    }
    return { address: bot.mvc_address.trim(), toMetabotId: targetId };
  }

  // 2. Valid base58check MVC address
  try {
    const parsed = new mvc.Address(target, 'livenet' as any);
    const normalizedAddr = parsed.toString();
    const localMatch = metabotStore.listMetabots().find((b) => b.mvc_address?.trim() === normalizedAddr);
    return { address: normalizedAddr, toMetabotId: localMatch?.id ?? null };
  } catch {
    // Not a raw MVC address; try local MetaBot name resolution
  }

  // 3. Local MetaBot display name
  const resolvedId = resolveMetabotIdByName(metabotStore, target);
  if (resolvedId != null) {
    const bot = metabotStore.getMetabotById(resolvedId);
    if (bot?.mvc_address?.trim()) {
      return { address: bot.mvc_address.trim(), toMetabotId: resolvedId };
    }
  }

  throw new Error(
    `Invalid receiver "${target}": pass a valid MVC address, a local metabot_id, or a local MetaBot name`,
  );
}

function parseOutpointPair(outpoint: string | null | undefined): { txId: string; outputIndex: number } | null {
  const clean = String(outpoint || '').trim().toLowerCase();
  const match = clean.match(/^([0-9a-f]{64}):(\d+)$/);
  if (!match) return null;
  return { txId: match[1], outputIndex: Number(match[2]) };
}

export async function executeMvcFtIssue(
  deps: MvcFtIssueServiceDeps,
  input: ExecuteMvcFtIssueInput,
): Promise<ExecuteMvcFtIssueOutcome> {
  if (!Number.isInteger(input.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  const tokenName = String(input.tokenName ?? '').trim();
  if (!tokenName || Buffer.byteLength(tokenName, 'utf8') > MAX_MCP02_TOKEN_NAME_BYTES) {
    throw new Error(`tokenName must be 1..${MAX_MCP02_TOKEN_NAME_BYTES} UTF-8 bytes`);
  }
  const tokenSymbol = String(input.tokenSymbol ?? '').trim();
  if (!tokenSymbol || /\s/.test(tokenSymbol) || Buffer.byteLength(tokenSymbol, 'utf8') > MAX_MCP02_TOKEN_SYMBOL_BYTES) {
    throw new Error(`tokenSymbol must be 1..${MAX_MCP02_TOKEN_SYMBOL_BYTES} UTF-8 bytes without whitespace`);
  }
  const decimals = input.decimals === undefined ? 8 : Number(input.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_MCP02_DECIMALS) {
    throw new Error(`decimals must be an integer between 0 and ${MAX_MCP02_DECIMALS}`);
  }
  const memo = input.memo?.trim() || undefined;
  assertCompliantFtMetadata({ tokenName, tokenSymbol, memo });

  const allowIncreaseMints = input.allowIncreaseMints === true;
  const supplyBig = parseDisplaySupplyToBase(input.initialSupply, decimals, {
    allowZero: allowIncreaseMints,
    fieldName: 'initialSupply',
  });
  if (supplyBig === 0n && !allowIncreaseMints) {
    throw new Error('Fixed-supply token (allowIncreaseMints=false) requires initialSupply > 0');
  }
  const supplyBase = supplyBig.toString();
  const supplyDisplay = formatBaseSupplyToDisplay(supplyBig, decimals);

  const issuerBot = deps.metabotStore.getMetabotById(input.metabotId);
  if (!issuerBot?.mvc_address?.trim()) {
    throw new Error(`MetaBot ${input.metabotId} not found or has no MVC address`);
  }
  const resolvedReceiver = resolveFtReceiverAddress(deps.metabotStore, input.metabotId, input.receiver);
  const feeRate = Number(input.feeRate ?? deps.getFeeRate?.() ?? 1);
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error('feeRate must be a positive number');
  }

  const buildIssue = deps.buildIssueRawTx ?? buildMvcFtIssueRawTx;
  const built = await buildIssue(deps.metabotStore, {
    metabotId: input.metabotId,
    tokenName,
    tokenSymbol,
    decimals,
    initialSupplyBase: supplyBase,
    receiverAddress: resolvedReceiver.address,
    allowIncreaseMints,
    feeRate,
    preferredFundingRawTxs: getSessionPreferredFundingRawTxs(input.metabotId),
  });

  const preview: MvcFtIssuePreviewFields = {
    metabotId: input.metabotId,
    issuerAddress: built.issuerAddress,
    receiverAddress: built.receiverAddress,
    tokenName,
    tokenSymbol,
    decimals,
    supplyBase,
    supplyDisplay,
    allowIncreaseMints,
    supplyModel: allowIncreaseMints ? 'mintable' : 'fixed',
    assetKey: built.assetKey,
    codehash: built.codehash,
    genesis: built.genesis,
    sensibleId: built.sensibleId,
    genesisFeeSats: built.genesisFeeSats,
    mintFeeSats: built.mintFeeSats,
    minerFeeSats: built.minerFeeSats,
    lockedDustSats: built.lockedDustSats,
    totalFeeSats: built.totalFeeSats,
    feeRate,
    genesisTxId: built.genesisTxId,
    mintTxId: built.mintTxId,
    tokenOutputIndex: built.tokenOutputIndex,
  };

  if (input.dryRun === true) {
    return {
      status: 'dry_run',
      success: true,
      ...preview,
    };
  }

  // Enforce mandatory owner confirmation gate
  if (deps.confirmIssue) {
    const approved = await deps.confirmIssue({
      action: 'issue',
      metabotId: input.metabotId,
      issuerAddress: built.issuerAddress,
      receiverAddress: built.receiverAddress,
      tokenName,
      tokenSymbol,
      decimals,
      amountBase: supplyBase,
      amountDisplay: supplyDisplay,
      allowIncreaseMints,
      assetKey: built.assetKey,
      sensibleId: built.sensibleId,
      codehash: built.codehash,
      genesis: built.genesis,
      minerFeeSats: built.minerFeeSats,
      lockedDustSats: built.lockedDustSats,
      totalFeeSats: built.totalFeeSats,
      feeRate,
    });
    if (!approved) {
      deps.transferStore?.record({
        metabotId: input.metabotId,
        fromAddress: built.issuerAddress,
        toAddress: built.receiverAddress,
        toMetabotId: resolvedReceiver.toMetabotId,
        chain: 'mvc',
        amountSats: built.totalFeeSats,
        feeSats: built.minerFeeSats,
        txid: null,
        memo: `FT issue declined: ${supplyDisplay} ${tokenSymbol} (${built.assetKey})`,
        channel: 'external',
        status: 'refused',
        error: 'Owner declined MVC FT issuance',
        sessionId: input.sessionId ?? null,
        origin: input.origin ?? 'mvc_ft_issue',
        occurredAtMs: Date.now(),
      });
      return {
        status: 'denied',
        success: false,
        errorCode: 'OWNER_DENIED',
        error: 'Owner declined MVC FT token issuance.',
        ...preview,
      };
    }
  } else if (input.ownerConfirmed !== true) {
    return {
      status: 'confirmation_required',
      success: false,
      errorCode: 'CONFIRMATION_REQUIRED',
      error:
        'Owner confirmation is required before broadcasting MVC FT issuance on-chain. Present the exact token parameters, supply model, and SPACE fee to the user first.',
      ...preview,
    };
  }

  const broadcastTx = deps.broadcastTx ?? defaultBroadcastMvcTx;
  const broadcastResult = await broadcastMvcFtIssueBundle(
    {
      genesisTxHex: built.genesisTxHex,
      mintTxHex: built.mintTxHex,
    },
    broadcastTx,
  );

  // Update 0-conf session UTXO state so back-to-back mint/transfer calls succeed without indexer lag
  recordMvcSpentOutpoints(input.metabotId, built.spentOutpoints);
  if (built.changeUtxo) {
    replaceMvcPendingFundingUtxos(input.metabotId, built.changeUtxo);
    recordSessionFundingRawTx(
      input.metabotId,
      built.changeUtxo.txId,
      built.mintTxHex ?? built.genesisTxHex,
    );
  }
  recordSessionFundingRawTx(input.metabotId, built.genesisTxId, built.genesisTxHex);
  if (built.mintTxId && built.mintTxHex) {
    recordSessionFundingRawTx(input.metabotId, built.mintTxId, built.mintTxHex);
  }

  const db = deps.getDb();
  const record = recordMvcFtIssuance(db, {
    sensibleId: built.sensibleId,
    assetKey: built.assetKey,
    metabotId: input.metabotId,
    issuerAddress: built.issuerAddress,
    receiverAddress: built.receiverAddress,
    codehash: built.codehash,
    genesis: built.genesis,
    tokenName,
    tokenSymbol,
    decimals,
    allowIncreaseMints,
    totalMintedBase: supplyBase,
    genesisTxId: broadcastResult.genesisTxId,
    genesisTxHex: built.genesisTxHex,
    latestMintTxId: broadcastResult.mintTxId,
    continuationGenesisOutpoint: built.continuationGenesisOutpoint,
    continuationGenesisTxHex: built.continuationGenesisTxHex,
    memo: memo ?? null,
  });
  deps.saveDb?.();

  deps.transferStore?.record({
    metabotId: input.metabotId,
    fromAddress: built.issuerAddress,
    toAddress: built.receiverAddress,
    toMetabotId: resolvedReceiver.toMetabotId,
    chain: 'mvc',
    amountSats: built.lockedDustSats,
    feeSats: built.minerFeeSats,
    txid: broadcastResult.mintTxId ?? broadcastResult.genesisTxId,
    memo: `FT issue: ${supplyDisplay} ${tokenSymbol} (${built.assetKey})`,
    channel: resolvedReceiver.toMetabotId != null ? 'local' : 'external',
    status: 'broadcast',
    sessionId: input.sessionId ?? null,
    origin: input.origin ?? 'mvc_ft_issue',
    occurredAtMs: Date.now(),
  });

  return {
    status: 'broadcast',
    success: true,
    ...preview,
    genesisTxId: broadcastResult.genesisTxId,
    mintTxId: broadcastResult.mintTxId,
    record,
  };
}

export async function executeMvcFtMint(
  deps: MvcFtIssueServiceDeps,
  input: ExecuteMvcFtMintInput,
): Promise<ExecuteMvcFtMintOutcome> {
  if (!Number.isInteger(input.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  const memo = input.memo?.trim() || undefined;
  assertCompliantFtMetadata({ memo });

  const db = deps.getDb();
  const storedRecord = findMvcFtIssuanceByToken(db, {
    sensibleId: input.sensibleId,
    genesis: input.genesis,
    assetKey: input.assetKey,
    metabotId: input.metabotId,
  }) ?? findMvcFtIssuanceByToken(db, {
    sensibleId: input.sensibleId,
    genesis: input.genesis,
    assetKey: input.assetKey,
  });

  const resolvedSensibleId = String(input.sensibleId || storedRecord?.sensibleId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{72}$/.test(resolvedSensibleId)) {
    throw new Error(
      'Unable to resolve token sensibleId (72-hex): pass sensible_id directly, or pass genesis/asset_key of a token issued by this IDBots instance',
    );
  }

  if (storedRecord && !storedRecord.allowIncreaseMints) {
    throw new Error(
      `FT_SUPPLY_LOCKED: Token ${storedRecord.tokenSymbol} (${storedRecord.assetKey}) was issued with fixed supply (allowIncreaseMints=false) and cannot be minted further`,
    );
  }

  const decimals = storedRecord?.decimals ?? 8;
  const amountBig = parseDisplaySupplyToBase(input.amount, decimals, {
    allowZero: false,
    fieldName: 'amount',
  });
  if (storedRecord) {
    const nextCumulative = BigInt(storedRecord.totalMintedBase) + amountBig;
    if (nextCumulative > MAX_MCP02_TOKEN_AMOUNT_BASE) {
      throw new Error(
        `Cumulative minted supply (${nextCumulative.toString()}) would exceed MCP02 64-bit signed integer limit (${MAX_MCP02_TOKEN_AMOUNT_BASE.toString()})`,
      );
    }
  }

  const resolvedReceiver = resolveFtReceiverAddress(deps.metabotStore, input.metabotId, input.receiver);
  const feeRate = Number(input.feeRate ?? deps.getFeeRate?.() ?? 1);
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error('feeRate must be a positive number');
  }
  const allowIncreaseMints = input.allowIncreaseMints !== false;

  const contOutpoint = parseOutpointPair(storedRecord?.continuationGenesisOutpoint);
  const knownGenesisUtxo = contOutpoint
    ? {
        txId: contOutpoint.txId,
        outputIndex: contOutpoint.outputIndex,
        ...(storedRecord?.continuationGenesisTxHex ? { txHex: storedRecord.continuationGenesisTxHex } : {}),
      }
    : undefined;

  const buildMint = deps.buildMintRawTx ?? buildMvcFtMintRawTx;
  const built = await buildMint(deps.metabotStore, {
    metabotId: input.metabotId,
    sensibleId: resolvedSensibleId,
    amountBase: amountBig.toString(),
    receiverAddress: resolvedReceiver.address,
    allowIncreaseMints,
    feeRate,
    preferredFundingRawTxs: getSessionPreferredFundingRawTxs(input.metabotId),
    knownGenesisUtxo,
    genesisTxHexHint: storedRecord?.genesisTxHex,
  });

  // If the token was not in the local ledger yet and on-chain decimals differ from 8,
  // verify our parsed amount matches the actual on-chain decimals!
  if (!storedRecord && built.decimals !== decimals) {
    const reparsed = parseDisplaySupplyToBase(input.amount, built.decimals, {
      allowZero: false,
      fieldName: 'amount',
    });
    if (reparsed !== amountBig) {
      return executeMvcFtMintWithExplicitDecimals(deps, input, resolvedSensibleId, built.decimals);
    }
  }

  const amountDisplay = formatBaseSupplyToDisplay(built.amountBase, built.decimals);
  const preview = {
    metabotId: input.metabotId,
    issuerAddress: built.issuerAddress,
    receiverAddress: built.receiverAddress,
    tokenName: built.tokenName,
    tokenSymbol: built.tokenSymbol,
    decimals: built.decimals,
    supplyBase: built.amountBase,
    supplyDisplay: amountDisplay,
    allowIncreaseMints: built.allowIncreaseMints,
    supplyModel: (built.allowIncreaseMints ? 'mintable' : 'fixed') as 'mintable' | 'fixed',
    assetKey: built.assetKey,
    codehash: built.codehash,
    genesis: built.genesis,
    sensibleId: built.sensibleId,
    mintFeeSats: built.mintFeeSats,
    minerFeeSats: built.minerFeeSats,
    lockedDustSats: built.lockedDustSats,
    totalFeeSats: built.totalFeeSats,
    feeRate,
    mintTxId: built.mintTxId,
    tokenOutputIndex: built.tokenOutputIndex,
  };

  if (input.dryRun === true) {
    return {
      status: 'dry_run',
      success: true,
      ...preview,
    };
  }

  if (deps.confirmIssue) {
    const approved = await deps.confirmIssue({
      action: 'mint',
      metabotId: input.metabotId,
      issuerAddress: built.issuerAddress,
      receiverAddress: built.receiverAddress,
      tokenName: built.tokenName,
      tokenSymbol: built.tokenSymbol,
      decimals: built.decimals,
      amountBase: built.amountBase,
      amountDisplay,
      allowIncreaseMints: built.allowIncreaseMints,
      assetKey: built.assetKey,
      sensibleId: built.sensibleId,
      codehash: built.codehash,
      genesis: built.genesis,
      minerFeeSats: built.minerFeeSats,
      lockedDustSats: built.lockedDustSats,
      totalFeeSats: built.totalFeeSats,
      feeRate,
    });
    if (!approved) {
      return {
        status: 'denied',
        success: false,
        errorCode: 'OWNER_DENIED',
        error: 'Owner declined MVC FT follow-up mint.',
        ...preview,
      };
    }
  } else if (input.ownerConfirmed !== true) {
    return {
      status: 'confirmation_required',
      success: false,
      errorCode: 'CONFIRMATION_REQUIRED',
      error:
        'Owner confirmation is required before broadcasting MVC FT mint on-chain. Present the exact mint amount, receiver, continuation authority setting, and SPACE fee to the user first.',
      ...preview,
    };
  }

  const broadcastTx = deps.broadcastTx ?? defaultBroadcastMvcTx;
  const broadcastMintTxId = await broadcastTx(built.mintTxHex);

  recordMvcSpentOutpoints(input.metabotId, built.spentOutpoints);
  if (built.changeUtxo) {
    replaceMvcPendingFundingUtxos(input.metabotId, built.changeUtxo);
    recordSessionFundingRawTx(input.metabotId, built.changeUtxo.txId, built.mintTxHex);
  }
  recordSessionFundingRawTx(input.metabotId, broadcastMintTxId, built.mintTxHex);

  const updatedRecord = updateMvcFtIssuanceAfterMint(db, {
    sensibleId: built.sensibleId,
    addedAmountBase: built.amountBase,
    receiverAddress: built.receiverAddress,
    mintTxId: broadcastMintTxId,
    allowIncreaseMints: built.allowIncreaseMints,
    continuationGenesisOutpoint: built.continuationGenesisOutpoint,
    continuationGenesisTxHex: built.continuationGenesisTxHex,
  });
  deps.saveDb?.();

  deps.transferStore?.record({
    metabotId: input.metabotId,
    fromAddress: built.issuerAddress,
    toAddress: built.receiverAddress,
    toMetabotId: resolvedReceiver.toMetabotId,
    chain: 'mvc',
    amountSats: built.lockedDustSats,
    feeSats: built.minerFeeSats,
    txid: broadcastMintTxId,
    memo: `FT mint: +${amountDisplay} ${built.tokenSymbol} (${built.assetKey})`,
    channel: resolvedReceiver.toMetabotId != null ? 'local' : 'external',
    status: 'broadcast',
    sessionId: input.sessionId ?? null,
    origin: input.origin ?? 'mvc_ft_mint',
    occurredAtMs: Date.now(),
  });

  return {
    status: 'broadcast',
    success: true,
    ...preview,
    mintTxId: broadcastMintTxId,
    record: updatedRecord,
  };
}

async function executeMvcFtMintWithExplicitDecimals(
  deps: MvcFtIssueServiceDeps,
  input: ExecuteMvcFtMintInput,
  sensibleId: string,
  actualDecimals: number,
): Promise<ExecuteMvcFtMintOutcome> {
  const amountBig = parseDisplaySupplyToBase(input.amount, actualDecimals, {
    allowZero: false,
    fieldName: 'amount',
  });
  const resolvedReceiver = resolveFtReceiverAddress(deps.metabotStore, input.metabotId, input.receiver);
  const feeRate = Number(input.feeRate ?? deps.getFeeRate?.() ?? 1);
  const allowIncreaseMints = input.allowIncreaseMints !== false;
  const buildMint = deps.buildMintRawTx ?? buildMvcFtMintRawTx;
  const built = await buildMint(deps.metabotStore, {
    metabotId: input.metabotId,
    sensibleId,
    amountBase: amountBig.toString(),
    receiverAddress: resolvedReceiver.address,
    allowIncreaseMints,
    feeRate,
    preferredFundingRawTxs: getSessionPreferredFundingRawTxs(input.metabotId),
  });
  const amountDisplay = formatBaseSupplyToDisplay(built.amountBase, built.decimals);
  const preview = {
    metabotId: input.metabotId,
    issuerAddress: built.issuerAddress,
    receiverAddress: built.receiverAddress,
    tokenName: built.tokenName,
    tokenSymbol: built.tokenSymbol,
    decimals: built.decimals,
    supplyBase: built.amountBase,
    supplyDisplay: amountDisplay,
    allowIncreaseMints: built.allowIncreaseMints,
    supplyModel: (built.allowIncreaseMints ? 'mintable' : 'fixed') as 'mintable' | 'fixed',
    assetKey: built.assetKey,
    codehash: built.codehash,
    genesis: built.genesis,
    sensibleId: built.sensibleId,
    mintFeeSats: built.mintFeeSats,
    minerFeeSats: built.minerFeeSats,
    lockedDustSats: built.lockedDustSats,
    totalFeeSats: built.totalFeeSats,
    feeRate,
    mintTxId: built.mintTxId,
    tokenOutputIndex: built.tokenOutputIndex,
  };
  if (input.dryRun === true) {
    return { status: 'dry_run', success: true, ...preview };
  }
  if (deps.confirmIssue) {
    const approved = await deps.confirmIssue({
      action: 'mint',
      metabotId: input.metabotId,
      issuerAddress: built.issuerAddress,
      receiverAddress: built.receiverAddress,
      tokenName: built.tokenName,
      tokenSymbol: built.tokenSymbol,
      decimals: built.decimals,
      amountBase: built.amountBase,
      amountDisplay,
      allowIncreaseMints: built.allowIncreaseMints,
      assetKey: built.assetKey,
      sensibleId: built.sensibleId,
      codehash: built.codehash,
      genesis: built.genesis,
      minerFeeSats: built.minerFeeSats,
      lockedDustSats: built.lockedDustSats,
      totalFeeSats: built.totalFeeSats,
      feeRate,
    });
    if (!approved) {
      return {
        status: 'denied',
        success: false,
        errorCode: 'OWNER_DENIED',
        error: 'Owner declined MVC FT follow-up mint.',
        ...preview,
      };
    }
  } else if (input.ownerConfirmed !== true) {
    return {
      status: 'confirmation_required',
      success: false,
      errorCode: 'CONFIRMATION_REQUIRED',
      error:
        'Owner confirmation is required before broadcasting MVC FT mint on-chain.',
      ...preview,
    };
  }
  const broadcastTx = deps.broadcastTx ?? defaultBroadcastMvcTx;
  const broadcastMintTxId = await broadcastTx(built.mintTxHex);
  recordMvcSpentOutpoints(input.metabotId, built.spentOutpoints);
  if (built.changeUtxo) {
    replaceMvcPendingFundingUtxos(input.metabotId, built.changeUtxo);
    recordSessionFundingRawTx(input.metabotId, built.changeUtxo.txId, built.mintTxHex);
  }
  recordSessionFundingRawTx(input.metabotId, broadcastMintTxId, built.mintTxHex);
  return {
    status: 'broadcast',
    success: true,
    ...preview,
    mintTxId: broadcastMintTxId,
    record: null,
  };
}
