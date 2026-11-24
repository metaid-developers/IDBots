/**
 * PayReadFulfillDaemon (REQ-5-03 / Contract C6.2)
 *
 * Zero-LLM deterministic private-chat fast-path daemon for `/protocols/paybuzz`:
 * - Author Track A (`PAYREAD_VIP_REQ_V1`): verifies ±300s timestamp + ECDSA signature
 *   + live MRC-721 collection ownership (rejects immediately if VIP card was sold)
 *   -> replies with ECDH-encrypted `PAYREAD_KEY_GRANT_V1`.
 * - Author Track B (`PAYREAD_TOKEN_REQ_V1`): checks `paybuzz_used_payments` replay lock
 *   (with idempotent retry whitelist for same reader + same article), enforces strict
 *   full-`assetKey` match (S-01), verifies authoritative on-chain FT delivery on BTC MRC-20
 *   (`man-p2p` / `metalet-service`, blocking S-02 `sendAllAmountToFirstOutput` fraud) or
 *   MVC FT (`higun` / `metalet`), records royalty, and replies with `PAYREAD_KEY_GRANT_V1`.
 * - Reader side (`PAYREAD_KEY_GRANT_V1` / `PAYREAD_REJECTED_V1`): verifies AES-256-GCM
 *   decryption, stores in `paybuzz_unlocked_cache`, and broadcasts renderer updates.
 */

import Decimal from 'decimal.js';
import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { AgentNotificationInput } from '../../renderer/types/notification';
import { normalizeFtAssetKey } from './ftMandateGateService';
import { fetchMrc721AddressItems, getMetasoApiBase, type Mrc721ItemSummary } from './mrc721Service';
import { verifyPaybuzzVipChallengeSignature } from './paybuzzCryptoService';
import {
  decryptAndCachePaybuzzWithKey,
  fetchPaybuzzItem,
  recoverAuthorPaybuzzKey,
  type PaybuzzItemRecord,
  type PaybuzzServiceDeps,
  type PaybuzzTokenPriceRule,
} from './paybuzzService';
import {
  claimPaybuzzUsedPayment,
  ensurePaybuzzTables,
  getPaybuzzRoyaltySummary,
  getPaybuzzUsedPayment,
  recordPaybuzzRoyalty,
} from './paybuzzStore';
import {
  formatPayReadWireMessage,
  parsePayReadWireMessage,
  type PayReadWireMessageV1,
} from './payReadWireProtocol';

const METALET_HOST = 'https://www.metalet.space';
const APIMVC_HOST = 'https://api.microvisionchain.com/open-api-mvc';
const NET = 'livenet';

export interface VerifyPaybuzzTokenPaymentInput {
  rule: PaybuzzTokenPriceRule;
  paymentTxId: string;
}

export interface VerifyPaybuzzTokenPaymentResult {
  valid: boolean;
  reason: string;
  matchedAmountBase?: string;
}

export interface BtcMrc20RecipientUtxo {
  txId?: string;
  txid?: string;
  address?: string;
  toAddress?: string;
  status?: string | number;
  mrc20Id?: string;
  tickId?: string;
  amount?: string;
  amountBase?: string;
  mrc20s?: Array<{
    mrc20Id?: string;
    tickId?: string;
    tick?: string;
    ticker?: string;
    amount?: string;
    amountBase?: string;
    status?: string | number;
  }>;
}

export interface MvcFtVerifiedUtxo {
  txId?: string;
  txid?: string;
  codehash?: string;
  codeHash?: string;
  genesis?: string;
  address?: string;
  ownerAddress?: string;
  amount?: string;
  amountBase?: string;
  tokenAmount?: string;
  valueString?: string;
  value?: string;
  spent?: boolean;
  status?: string;
}

export interface PayReadFulfillDeps extends PaybuzzServiceDeps {
  getMetabotStore: () => MetabotStore;
  sendPayReadMessage?: (input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
  }) => Promise<{ txids?: string[]; pinId?: string } | void>;
  fetchMrc721ItemsForAddress?: (params: {
    address: string;
    collectionPinId: string;
  }) => Promise<Mrc721ItemSummary[]>;
  fetchBtcMrc20RecipientUtxos?: (params: {
    receiveAddress: string;
    mrc20Id: string;
    paymentTxId: string;
  }) => Promise<BtcMrc20RecipientUtxo[]>;
  fetchMvcFtVerifiedUtxos?: (params: {
    receiveAddress: string;
    codehash: string;
    genesis: string;
    paymentTxId: string;
  }) => Promise<MvcFtVerifiedUtxo[]>;
  verifyTokenPayment?: (
    input: VerifyPaybuzzTokenPaymentInput,
  ) => Promise<VerifyPaybuzzTokenPaymentResult>;
  recordNotification?: (input: AgentNotificationInput) => void;
  emitToRenderer?: (channel: string, payload: unknown) => void;
  emitLog?: (msg: string) => void;
  nowMs?: () => number;
}

export interface HandleIncomingPayReadResult {
  handled: boolean;
  type?: PayReadWireMessageV1['type'];
  paybuzzPinId?: string;
  outcome?: 'granted' | 'granted_idempotent' | 'rejected' | 'unlocked_cached' | 'failed';
  reason?: string;
}

const INVALID_MRC20_STATUSES = new Set([
  'failed',
  'invalid',
  'reverted',
  'refunded',
  'returned',
  'error',
  'rejected',
]);

const VALID_MRC20_STATUSES = new Set([
  '',
  'available',
  'transferpendingin',
  'pendingin',
  'confirmed',
  'unconfirmed',
  '0',
  '1',
]);

function toExactBaseUnits(amountDisplayOrBase: unknown, decimals: number, isAlreadyBase = false): bigint {
  const raw = String(amountDisplayOrBase ?? '').trim();
  if (!raw) return 0n;
  if (isAlreadyBase) {
    if (!/^\d+$/.test(raw)) return 0n;
    return BigInt(raw);
  }
  try {
    const d = new Decimal(raw);
    if (!d.isFinite() || d.lte(0)) return 0n;
    const scaled = d.mul(new Decimal(10).pow(Math.max(0, decimals))).toFixed(0);
    return /^\d+$/.test(scaled) ? BigInt(scaled) : 0n;
  } catch {
    return 0n;
  }
}

function isAcceptableMrc20Status(status: unknown): boolean {
  if (status === undefined || status === null) return true;
  const norm = String(status).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (INVALID_MRC20_STATUSES.has(norm)) return false;
  return VALID_MRC20_STATUSES.has(norm);
}

async function defaultFetchBtcMrc20RecipientUtxos(params: {
  receiveAddress: string;
  mrc20Id: string;
}): Promise<BtcMrc20RecipientUtxo[]> {
  const localManBase = process.env.IDBOTS_MAN_P2P_LOCAL_BASE?.trim()?.replace(/\/+$/, '');
  if (localManBase) {
    try {
      const url = `${localManBase}/api/mrc20/address/utxo?address=${encodeURIComponent(params.receiveAddress)}&tickId=${encodeURIComponent(params.mrc20Id)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const json = (await res.json()) as { code?: number; data?: { list?: BtcMrc20RecipientUtxo[] } | BtcMrc20RecipientUtxo[] };
        if (json && (json.code === 0 || json.code === 1) && json.data) {
          const list = Array.isArray(json.data) ? json.data : json.data.list ?? [];
          if (list.length > 0) return list;
        }
      }
    } catch {
      // Fall back to metalet-service
    }
  }

  const url = `${METALET_HOST}/wallet-api/v3/mrc20/address/utxo?net=${NET}&address=${encodeURIComponent(params.receiveAddress)}&tickId=${encodeURIComponent(params.mrc20Id)}&source=mrc20-v2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`Metalet MRC-20 UTXO fetch failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { code?: number; message?: string; data?: { list?: BtcMrc20RecipientUtxo[] } };
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(json.message || `Metalet MRC-20 API code ${json.code}`);
  }
  return json.data?.list ?? [];
}

async function defaultFetchMvcFtVerifiedUtxos(params: {
  receiveAddress: string;
  codehash: string;
  genesis: string;
  paymentTxId: string;
}): Promise<MvcFtVerifiedUtxo[]> {
  const wantedTxId = params.paymentTxId.trim().toLowerCase();
  const filterMatchingTxId = (rows: MvcFtVerifiedUtxo[]): MvcFtVerifiedUtxo[] =>
    rows.filter((r) => String(r?.txId ?? r?.txid ?? '').trim().toLowerCase() === wantedTxId);

  const higunBase =
    process.env.IDBOTS_HIGUN_BASE?.trim()?.replace(/\/+$/, '') ||
    process.env.HIGUN_API_BASE?.trim()?.replace(/\/+$/, '');

  if (higunBase) {
    const candidates = [
      `${higunBase}/db/ft/utxo?txid=${encodeURIComponent(params.paymentTxId)}`,
      `${higunBase}/ft/mempool/utxos?address=${encodeURIComponent(params.receiveAddress)}&codehash=${encodeURIComponent(params.codehash)}&genesis=${encodeURIComponent(params.genesis)}`,
    ];
    for (const url of candidates) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const json = (await res.json()) as { data?: MvcFtVerifiedUtxo[] | { list?: MvcFtVerifiedUtxo[] } } | MvcFtVerifiedUtxo[];
        const list = Array.isArray(json)
          ? json
          : Array.isArray(json?.data)
            ? json.data
            : json?.data?.list ?? [];
        const matched = filterMatchingTxId(list);
        if (matched.length > 0) return matched;
      } catch {
        // Try next endpoint
      }
    }
  }

  // Authoritative MetaSo MVC FT UTXO lookup
  try {
    const metasoBase = getMetasoApiBase();
    const res = await fetch(
      `${metasoBase}/api/mvc/ft/utxo?txid=${encodeURIComponent(params.paymentTxId)}&address=${encodeURIComponent(params.receiveAddress)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.ok) {
      const json = (await res.json()) as { data?: MvcFtVerifiedUtxo[] | { list?: MvcFtVerifiedUtxo[] } };
      const list = Array.isArray(json?.data) ? json.data : json?.data?.list ?? [];
      const matched = filterMatchingTxId(list);
      if (matched.length > 0) return matched;
    }
  } catch {
    // Fall back to APIMVC / Metalet indexed FT UTXO endpoints
  }

  // Authoritative APIMVC indexed contract FT UTXO list
  try {
    const apimvcUrl = `${APIMVC_HOST}/contract/ft/address/${encodeURIComponent(params.receiveAddress)}/utxo?codeHash=${encodeURIComponent(params.codehash)}&genesis=${encodeURIComponent(params.genesis)}`;
    const res = await fetch(apimvcUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json();
      const rawList: MvcFtVerifiedUtxo[] = Array.isArray(json) ? json : [];
      const matched = filterMatchingTxId(rawList).map((r) => ({
        ...r,
        codehash: r.codehash ?? r.codeHash ?? params.codehash,
        genesis: r.genesis ?? params.genesis,
        ownerAddress: r.ownerAddress ?? r.address ?? params.receiveAddress,
      }));
      if (matched.length > 0) return matched;
    }
  } catch {
    // Fall back to Metalet
  }

  // Authoritative Metalet v4 indexed contract FT UTXO list (uses `codeHash` query param and `valueString` field)
  try {
    const query = new URLSearchParams({
      net: NET,
      address: params.receiveAddress,
      codeHash: params.codehash,
      codehash: params.codehash,
      genesis: params.genesis,
    });
    const metaletUrl = `${METALET_HOST}/wallet-api/v4/mvc/address/contract/ft/utxo-list?${query}`;
    const res = await fetch(metaletUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = (await res.json()) as { data?: MvcFtVerifiedUtxo[] | { list?: MvcFtVerifiedUtxo[] } };
      const rawList = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.data?.list)
          ? json.data.list
          : [];
      const matched = filterMatchingTxId(rawList).map((r) => ({
        ...r,
        codehash: r.codehash ?? r.codeHash ?? params.codehash,
        genesis: r.genesis ?? params.genesis,
        ownerAddress: r.ownerAddress ?? r.address ?? params.receiveAddress,
      }));
      if (matched.length > 0) return matched;
    }
  } catch {
    // Fail closed when all indexed FT sources fail or omit paymentTxId
  }

  // Security invariant (S-02): NEVER fall back to unindexed raw-tx `ftProto.parseDataPart`
  // inspection — `parseDataPart` slices trailing script bytes without verifying sCrypt
  // contract codehash or FT input lineage, which would allow a 1-sat fake OP_RETURN
  // output to spoof an FT payment.
  return [];
}

export async function verifyPaybuzzTokenPaymentOnChain(
  input: VerifyPaybuzzTokenPaymentInput,
  deps: Pick<PayReadFulfillDeps, 'fetchBtcMrc20RecipientUtxos' | 'fetchMvcFtVerifiedUtxos'> = {},
): Promise<VerifyPaybuzzTokenPaymentResult> {
  const paymentTxId = String(input.paymentTxId ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(paymentTxId)) {
    return { valid: false, reason: 'INVALID_PAYMENT_TXID' };
  }
  const { rule } = input;
  const expectedAmountBase = BigInt(rule.amountBase);

  if (rule.chain === 'btc') {
    const mrc20Id = String(rule.mrc20Id || '').trim().toLowerCase();
    if (!mrc20Id) {
      return { valid: false, reason: 'MISSING_MRC20_ID' };
    }
    const fetchUtxos = deps.fetchBtcMrc20RecipientUtxos ?? defaultFetchBtcMrc20RecipientUtxos;
    const utxos = await fetchUtxos({
      receiveAddress: rule.receiveAddress,
      mrc20Id,
      paymentTxId,
    });

    let matchedBase = 0n;
    for (const utxo of utxos) {
      const uTxId = String(utxo.txId ?? utxo.txid ?? '').trim().toLowerCase();
      if (uTxId !== paymentTxId) continue;

      // S-02 guard: reject failed/reverted/refunded outputs and wrong recipient address
      if (!isAcceptableMrc20Status(utxo.status)) continue;
      const uAddr = String(utxo.toAddress ?? utxo.address ?? '').trim();
      if (uAddr && uAddr !== rule.receiveAddress) continue;

      const entries = Array.isArray(utxo.mrc20s) ? utxo.mrc20s : [];
      if (entries.length === 0) {
        const utxoMrc20Id = String(utxo.mrc20Id ?? utxo.tickId ?? '').trim().toLowerCase();
        if (utxoMrc20Id && utxoMrc20Id !== mrc20Id) continue;
        if (utxo.amountBase) {
          matchedBase += toExactBaseUnits(utxo.amountBase, rule.decimals, true);
        } else {
          matchedBase += toExactBaseUnits(utxo.amount, rule.decimals, false);
        }
        continue;
      }

      for (const entry of entries) {
        if (!isAcceptableMrc20Status(entry.status)) continue;
        const entryId = String(entry.mrc20Id ?? entry.tickId ?? '').trim().toLowerCase();
        // S-01 guard: if entry carries an explicit mrc20Id/tickId it must strictly match
        if (entryId && entryId !== mrc20Id) continue;
        if (entry.amountBase) {
          matchedBase += toExactBaseUnits(entry.amountBase, rule.decimals, true);
        } else {
          matchedBase += toExactBaseUnits(entry.amount, rule.decimals, false);
        }
      }
    }

    if (matchedBase <= 0n) {
      return {
        valid: false,
        reason: 'BTC_MRC20_OUTPUT_NOT_FOUND_OR_REVERTED',
        matchedAmountBase: '0',
      };
    }
    if (matchedBase < expectedAmountBase) {
      return {
        valid: false,
        reason: `INSUFFICIENT_MRC20_AMOUNT:${matchedBase.toString()}:${expectedAmountBase.toString()}`,
        matchedAmountBase: matchedBase.toString(),
      };
    }
    return {
      valid: true,
      reason: 'VERIFIED_OK',
      matchedAmountBase: matchedBase.toString(),
    };
  }

  // MVC MetaContract FT verification
  const codehash = String(rule.codehash ?? '').trim().toLowerCase();
  const genesis = String(rule.genesis ?? '').trim().toLowerCase();
  if (!codehash || !genesis) {
    return { valid: false, reason: 'MISSING_MVC_FT_IDENTIFIERS' };
  }
  const fetchMvcUtxos = deps.fetchMvcFtVerifiedUtxos ?? defaultFetchMvcFtVerifiedUtxos;
  const utxos = await fetchMvcUtxos({
    receiveAddress: rule.receiveAddress,
    codehash,
    genesis,
    paymentTxId,
  });

  let matchedBase = 0n;
  for (const utxo of utxos) {
    const uTxId = String(utxo.txId ?? utxo.txid ?? '').trim().toLowerCase();
    // Fail closed if txId is missing or does not match paymentTxId
    if (!uTxId || uTxId !== paymentTxId) continue;
    if (utxo.status && INVALID_MRC20_STATUSES.has(utxo.status.trim().toLowerCase())) continue;

    const uCodehash = String(utxo.codehash ?? utxo.codeHash ?? '').trim().toLowerCase();
    const uGenesis = String(utxo.genesis ?? '').trim().toLowerCase();
    // S-01 guard: fail closed unless codehash + genesis strictly match
    if (!uCodehash || uCodehash !== codehash) continue;
    if (!uGenesis || uGenesis !== genesis) continue;

    const uOwner = String(utxo.ownerAddress ?? utxo.address ?? '').trim();
    if (uOwner && uOwner !== rule.receiveAddress) continue;

    const rawBase = utxo.amountBase ?? utxo.valueString ?? utxo.tokenAmount ?? utxo.value ?? utxo.amount;
    matchedBase += toExactBaseUnits(rawBase, rule.decimals, true);
  }

  if (matchedBase <= 0n) {
    return {
      valid: false,
      reason: 'MVC_FT_OUTPUT_NOT_FOUND',
      matchedAmountBase: '0',
    };
  }
  if (matchedBase < expectedAmountBase) {
    return {
      valid: false,
      reason: `INSUFFICIENT_MVC_FT_AMOUNT:${matchedBase.toString()}:${expectedAmountBase.toString()}`,
      matchedAmountBase: matchedBase.toString(),
    };
  }
  return {
    valid: true,
    reason: 'VERIFIED_OK',
    matchedAmountBase: matchedBase.toString(),
  };
}

export class PayReadFulfillDaemon {
  private readonly db: Database;
  private readonly saveDb: () => void;
  private readonly deps: PayReadFulfillDeps;
  private readonly inFlightKeys = new Set<string>();

  constructor(db: Database, saveDb: () => void, deps: PayReadFulfillDeps) {
    this.db = db;
    this.saveDb = saveDb;
    this.deps = deps;
    ensurePaybuzzTables(db);
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private log(msg: string): void {
    if (this.deps.emitLog) this.deps.emitLog(msg);
    else console.log(msg);
  }

  private async sendWireReply(
    fromMetabotId: number,
    toGlobalMetaId: string,
    payload: PayReadWireMessageV1,
    summaryLine: string,
  ): Promise<void> {
    const content = `${formatPayReadWireMessage(payload)}\n\n${summaryLine}`;
    if (this.deps.sendPayReadMessage) {
      await this.deps.sendPayReadMessage({
        metabotId: fromMetabotId,
        toGlobalMetaId,
        content,
      });
      return;
    }
    if (this.deps.sendEncryptedPrivateMessage) {
      await this.deps.sendEncryptedPrivateMessage(fromMetabotId, toGlobalMetaId, content);
    }
  }

  private async sendRejection(
    metabotId: number,
    toGlobalMetaId: string,
    paybuzzPinId: string,
    code: string,
    reason: string,
  ): Promise<void> {
    if (!toGlobalMetaId) return;
    try {
      await this.sendWireReply(
        metabotId,
        toGlobalMetaId,
        {
          type: 'PAYREAD_REJECTED_V1',
          paybuzzPinId,
          code,
          reason,
        },
        `[PayBuzz Unlock Rejected] ${code}: ${reason}`,
      );
    } catch (err) {
      this.log(`[PayReadFulfill] Failed to send rejection DM: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async handleIncomingPayReadMessage(input: {
    metabotId: number;
    fromGlobalMetaId: string;
    plaintext: string;
  }): Promise<HandleIncomingPayReadResult> {
    const parsed = parsePayReadWireMessage(input.plaintext);
    if (!parsed) {
      return { handled: false };
    }

    const fromGlobalMetaId = String(input.fromGlobalMetaId ?? '').trim();
    const serviceDeps: PaybuzzServiceDeps = {
      ...this.deps,
      getDb: () => this.db,
      saveDb: this.saveDb,
    };

    if (parsed.type === 'PAYREAD_KEY_GRANT_V1') {
      try {
        await decryptAndCachePaybuzzWithKey(serviceDeps, {
          paybuzzPinId: parsed.paybuzzPinId,
          contentKeyHex: parsed.contentKeyHex,
          grantedVia: parsed.grantedVia,
        });
        return {
          handled: true,
          type: parsed.type,
          paybuzzPinId: parsed.paybuzzPinId,
          outcome: 'unlocked_cached',
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.emitToRenderer?.('paybuzz:unlockRejected', {
          paybuzzPinId: parsed.paybuzzPinId,
          code: 'DECRYPT_FAILED',
          reason: msg,
        });
        return {
          handled: true,
          type: parsed.type,
          paybuzzPinId: parsed.paybuzzPinId,
          outcome: 'failed',
          reason: msg,
        };
      }
    }

    if (parsed.type === 'PAYREAD_REJECTED_V1') {
      this.deps.emitToRenderer?.('paybuzz:unlockRejected', {
        paybuzzPinId: parsed.paybuzzPinId,
        code: parsed.code,
        reason: parsed.reason,
      });
      return {
        handled: true,
        type: parsed.type,
        paybuzzPinId: parsed.paybuzzPinId,
        outcome: 'rejected',
        reason: parsed.code,
      };
    }

    if (parsed.type === 'PAYREAD_VIP_REQ_V1') {
      return this.handleVipUnlockRequest(serviceDeps, input.metabotId, fromGlobalMetaId, parsed);
    }

    if (parsed.type === 'PAYREAD_TOKEN_REQ_V1') {
      return this.handleTokenUnlockRequest(serviceDeps, input.metabotId, fromGlobalMetaId, parsed);
    }

    return { handled: false };
  }

  private async handleVipUnlockRequest(
    serviceDeps: PaybuzzServiceDeps,
    metabotId: number,
    fromGlobalMetaId: string,
    msg: Extract<PayReadWireMessageV1, { type: 'PAYREAD_VIP_REQ_V1' }>,
  ): Promise<HandleIncomingPayReadResult> {
    const readerGlobalMetaId = (msg.readerGlobalMetaId || fromGlobalMetaId).trim();
    const nowSec = Math.floor(this.nowMs() / 1000);

    // 1. Verify timestamp window (±300s) and ECDSA challenge signature
    const sigCheck = verifyPaybuzzVipChallengeSignature({
      paybuzzPinId: msg.paybuzzPinId,
      readerGlobalMetaId,
      timestamp: msg.timestamp,
      holderAddress: msg.holderAddress,
      signature: msg.signatureHex,
      nowSec,
    });
    if (!sigCheck.valid) {
      await this.sendRejection(
        metabotId,
        fromGlobalMetaId,
        msg.paybuzzPinId,
        sigCheck.reason || 'INVALID_SIGNATURE',
        'VIP challenge signature or timestamp window verification failed',
      );
      return {
        handled: true,
        type: msg.type,
        paybuzzPinId: msg.paybuzzPinId,
        outcome: 'rejected',
        reason: sigCheck.reason,
      };
    }

    // 2. Recover/load author content key & article unlock rules
    let contentKeyHex: string;
    let item: PaybuzzItemRecord;
    try {
      const recovered = await recoverAuthorPaybuzzKey(serviceDeps, {
        metabotId,
        paybuzzPinId: msg.paybuzzPinId,
      });
      contentKeyHex = recovered.contentKeyHex;
      item = recovered.item;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.sendRejection(metabotId, fromGlobalMetaId, msg.paybuzzPinId, 'ARTICLE_KEY_UNAVAILABLE', reason);
      return {
        handled: true,
        type: msg.type,
        paybuzzPinId: msg.paybuzzPinId,
        outcome: 'rejected',
        reason,
      };
    }

    // 3. Check collectionPinId is in the article's VIP whitelist
    const eligibleCol = item.unlockRules.vipMrc721Collections.find(
      (c) => c.collectionPinId.toLowerCase() === msg.collectionPinId.toLowerCase(),
    );
    if (!eligibleCol) {
      await this.sendRejection(
        metabotId,
        fromGlobalMetaId,
        msg.paybuzzPinId,
        'COLLECTION_NOT_ELIGIBLE',
        `Collection ${msg.collectionPinId} is not accepted for this article`,
      );
      return {
        handled: true,
        type: msg.type,
        paybuzzPinId: msg.paybuzzPinId,
        outcome: 'rejected',
        reason: 'COLLECTION_NOT_ELIGIBLE',
      };
    }

    // 4. Real-time on-chain check: verify holderAddress still owns >= 1 non-burned item
    let items: Mrc721ItemSummary[];
    try {
      items = this.deps.fetchMrc721ItemsForAddress
        ? await this.deps.fetchMrc721ItemsForAddress({
            address: msg.holderAddress,
            collectionPinId: msg.collectionPinId,
          })
        : await fetchMrc721AddressItems({
            address: msg.holderAddress,
            pinId: msg.collectionPinId,
          });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.sendRejection(metabotId, fromGlobalMetaId, msg.paybuzzPinId, 'MRC721_QUERY_FAILED', reason);
      return {
        handled: true,
        type: msg.type,
        paybuzzPinId: msg.paybuzzPinId,
        outcome: 'failed',
        reason,
      };
    }

    const validHoldings = items.filter((it) => {
      if (!it || it.burned === true) return false;
      const itemCol = String(it.collectionPinId ?? '').trim().toLowerCase();
      if (itemCol && itemCol !== msg.collectionPinId.toLowerCase()) return false;
      return Boolean(it.itemPinId || (it as unknown as { pinId?: string }).pinId);
    });

    if (validHoldings.length === 0) {
      await this.sendRejection(
        metabotId,
        fromGlobalMetaId,
        msg.paybuzzPinId,
        'VIP_CARD_NOT_HELD',
        'No active unburned VIP MRC-721 item found for holderAddress',
      );
      return {
        handled: true,
        type: msg.type,
        paybuzzPinId: msg.paybuzzPinId,
        outcome: 'rejected',
        reason: 'VIP_CARD_NOT_HELD',
      };
    }

    // 5. Grant content key via encrypted DM
    await this.sendWireReply(
      metabotId,
      fromGlobalMetaId,
      {
        type: 'PAYREAD_KEY_GRANT_V1',
        paybuzzPinId: msg.paybuzzPinId,
        contentKeyHex,
        grantedVia: 'vip-nft',
      },
      `[PayBuzz VIP Grant] Key granted for "${item.title}" via ${eligibleCol.collectionName}.`,
    );

    return {
      handled: true,
      type: msg.type,
      paybuzzPinId: msg.paybuzzPinId,
      outcome: 'granted',
    };
  }

  private async handleTokenUnlockRequest(
    serviceDeps: PaybuzzServiceDeps,
    metabotId: number,
    fromGlobalMetaId: string,
    msg: Extract<PayReadWireMessageV1, { type: 'PAYREAD_TOKEN_REQ_V1' }>,
  ): Promise<HandleIncomingPayReadResult> {
    const paymentTxId = msg.paymentTxId.trim().toLowerCase();
    const readerGlobalMetaId = (msg.readerGlobalMetaId || fromGlobalMetaId).trim();
    const flightKey = `tx:${paymentTxId}`;
    if (this.inFlightKeys.has(flightKey)) {
      return {
        handled: true,
        type: msg.type,
        paybuzzPinId: msg.paybuzzPinId,
        outcome: 'failed',
        reason: 'CONCURRENT_REQUEST_IN_FLIGHT',
      };
    }
    this.inFlightKeys.add(flightKey);

    try {
      let normalizedAssetKey: string;
      try {
        normalizedAssetKey = normalizeFtAssetKey(msg.assetKey);
      } catch {
        await this.sendRejection(
          metabotId,
          fromGlobalMetaId,
          msg.paybuzzPinId,
          'INVALID_ASSET_KEY',
          `Invalid assetKey: ${msg.assetKey}`,
        );
        return {
          handled: true,
          type: msg.type,
          paybuzzPinId: msg.paybuzzPinId,
          outcome: 'rejected',
          reason: 'INVALID_ASSET_KEY',
        };
      }

      // 1. Check replay ledger BEFORE doing any RPC calls
      const existingPayment = getPaybuzzUsedPayment(this.db, paymentTxId);
      if (existingPayment) {
        if (
          existingPayment.paybuzzPinId === msg.paybuzzPinId &&
          existingPayment.readerGlobalMetaId === readerGlobalMetaId
        ) {
          // Idempotent retry whitelist: same reader + same article -> re-grant key
          const recovered = await recoverAuthorPaybuzzKey(serviceDeps, {
            metabotId,
            paybuzzPinId: msg.paybuzzPinId,
          });
          await this.sendWireReply(
            metabotId,
            fromGlobalMetaId,
            {
              type: 'PAYREAD_KEY_GRANT_V1',
              paybuzzPinId: msg.paybuzzPinId,
              contentKeyHex: recovered.contentKeyHex,
              grantedVia: 'token',
            },
            `[PayBuzz Key Re-Grant] Idempotent key resend for "${recovered.item.title}".`,
          );
          return {
            handled: true,
            type: msg.type,
            paybuzzPinId: msg.paybuzzPinId,
            outcome: 'granted_idempotent',
          };
        }

        // S-06 hard block: txId already spent on another article or by another reader
        await this.sendRejection(
          metabotId,
          fromGlobalMetaId,
          msg.paybuzzPinId,
          'PAYMENT_TX_ALREADY_USED',
          `paymentTxId ${paymentTxId} was already consumed for ${existingPayment.paybuzzPinId}`,
        );
        return {
          handled: true,
          type: msg.type,
          paybuzzPinId: msg.paybuzzPinId,
          outcome: 'rejected',
          reason: 'PAYMENT_TX_ALREADY_USED',
        };
      }

      // 2. Recover article key & unlock rules
      let contentKeyHex: string;
      let item: PaybuzzItemRecord;
      try {
        const recovered = await recoverAuthorPaybuzzKey(serviceDeps, {
          metabotId,
          paybuzzPinId: msg.paybuzzPinId,
        });
        contentKeyHex = recovered.contentKeyHex;
        item = recovered.item;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.sendRejection(metabotId, fromGlobalMetaId, msg.paybuzzPinId, 'ARTICLE_KEY_UNAVAILABLE', reason);
        return {
          handled: true,
          type: msg.type,
          paybuzzPinId: msg.paybuzzPinId,
          outcome: 'rejected',
          reason,
        };
      }

      // 3. S-01 guard: exact full-assetKey match (never match by symbol alone)
      const rule = item.unlockRules.tokenPrices.find(
        (r) => r.assetKey.toLowerCase() === normalizedAssetKey,
      );
      if (!rule) {
        await this.sendRejection(
          metabotId,
          fromGlobalMetaId,
          msg.paybuzzPinId,
          'UNSUPPORTED_ASSET_KEY',
          `Asset ${normalizedAssetKey} is not accepted for this article`,
        );
        return {
          handled: true,
          type: msg.type,
          paybuzzPinId: msg.paybuzzPinId,
          outcome: 'rejected',
          reason: 'UNSUPPORTED_ASSET_KEY',
        };
      }

      // 4. Authoritative on-chain verification (BTC man-p2p / MVC higun)
      const verifyResult = this.deps.verifyTokenPayment
        ? await this.deps.verifyTokenPayment({ rule, paymentTxId })
        : await verifyPaybuzzTokenPaymentOnChain({ rule, paymentTxId }, this.deps);

      if (!verifyResult.valid) {
        await this.sendRejection(
          metabotId,
          fromGlobalMetaId,
          msg.paybuzzPinId,
          'PAYMENT_VERIFICATION_FAILED',
          verifyResult.reason,
        );
        return {
          handled: true,
          type: msg.type,
          paybuzzPinId: msg.paybuzzPinId,
          outcome: 'rejected',
          reason: verifyResult.reason,
        };
      }

      // 5. Claim unique payment lock atomically
      const now = this.nowMs();
      const claimRes = claimPaybuzzUsedPayment(
        this.db,
        {
          paymentTxId,
          paybuzzPinId: msg.paybuzzPinId,
          readerGlobalMetaId,
          assetKey: rule.assetKey,
          amountBase: rule.amountBase,
          createdAt: now,
        },
        this.saveDb,
      );

      if (claimRes.status === 'replay_conflict') {
        await this.sendRejection(
          metabotId,
          fromGlobalMetaId,
          msg.paybuzzPinId,
          'PAYMENT_TX_ALREADY_USED',
          `paymentTxId ${paymentTxId} was concurrently claimed by another unlock`,
        );
        return {
          handled: true,
          type: msg.type,
          paybuzzPinId: msg.paybuzzPinId,
          outcome: 'rejected',
          reason: 'PAYMENT_TX_ALREADY_USED',
        };
      }

      if (claimRes.status === 'claimed') {
        recordPaybuzzRoyalty(
          this.db,
          {
            metabotId,
            paybuzzPinId: msg.paybuzzPinId,
            readerGlobalMetaId,
            assetKey: rule.assetKey,
            symbol: rule.symbol,
            amountBase: rule.amountBase,
            amountDisplay: rule.amountDisplay,
            paymentTxId,
            createdAt: now,
          },
          this.saveDb,
        );
        const dayStart = now - 24 * 60 * 60 * 1000;
        const summary = getPaybuzzRoyaltySummary(this.db, metabotId, dayStart);
        this.deps.emitToRenderer?.('paybuzz:royaltyEarned', {
          metabotId,
          paybuzzPinId: msg.paybuzzPinId,
          title: item.title,
          symbol: rule.symbol,
          amountDisplay: rule.amountDisplay,
          assetKey: rule.assetKey,
          paymentTxId,
          dailyCount: summary.count,
        });
        this.deps.recordNotification?.({
          eventId: `paybuzz-royalty:${metabotId}:${paymentTxId}`,
          type: 'paybuzz_royalty',
          category: 'report',
          metabotId,
          sessionId: null,
          taskId: null,
          runId: null,
          title: 'PayBuzz Royalty Received',
          body: `+${rule.amountDisplay} ${rule.symbol} for "${item.title}" (${summary.count} unlock(s) in 24h)`,
          priority: 'normal',
          target: { kind: 'bot_automation', metabotId, section: 'daily_report' },
        });
      }

      // 6. Grant key via encrypted DM
      await this.sendWireReply(
        metabotId,
        fromGlobalMetaId,
        {
          type: 'PAYREAD_KEY_GRANT_V1',
          paybuzzPinId: msg.paybuzzPinId,
          contentKeyHex,
          grantedVia: 'token',
        },
        `[PayBuzz Token Grant] Key granted for "${item.title}" (${rule.amountDisplay} ${rule.symbol}).`,
      );

      return {
        handled: true,
        type: msg.type,
        paybuzzPinId: msg.paybuzzPinId,
        outcome: claimRes.status === 'idempotent_hit' ? 'granted_idempotent' : 'granted',
      };
    } finally {
      this.inFlightKeys.delete(flightKey);
    }
  }
}
