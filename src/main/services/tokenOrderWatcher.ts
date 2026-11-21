/**
 * TokenOrderWatcher (`REQ-1-03`)
 *
 * Background 45s poller for pure on-chain open FT listings (`btc-psbt` MRC-20
 * and `mvc-tokensell` MetaContract FT) stored in SQLite `ft_active_orders`:
 * - Distinguishes external buyer fills (`take` / market `sold`) from seller
 *   self-cancels (`cancel` returning tokens to seller's own address or already
 *   marked `canceled` locally).
 * - Updates lot status + batch progress (`filledLots / totalLots`), broadcasts
 *   `ftTrade:orderFilled` to live renderers, and records a durable notification
 *   via `NotificationService.record(...)` (desktop Notification Center +
 *   server/cloud mobile FCM push).
 */

import { mvc } from 'meta-contract';
import type { SqliteDatabase } from '../sqliteTypes';
import type { AgentNotificationInput } from '../../renderer/types/notification';
import {
  ensureFtOrderTables,
  getFtBatchOrderProgress,
  listFtActiveOrders,
  updateFtOrderStatus,
  type FtActiveOrderRecord,
} from './ftOrderStore';
import { parseRawTx } from '../libs/mvcTokenSellCore';

export const TOKEN_ORDER_WATCHER_INTERVAL_MS = 45_000;

const METALET_HOST = 'https://www.metalet.space';
const METAID_MARKET_HOST = 'https://api.metaid.market';
const MEMPOOL_HOST = 'https://mempool.space';

export type OutpointSpendResolution =
  | { state: 'unspent' }
  | { state: 'filled'; filledTxId: string }
  | { state: 'self_canceled'; cancelTxId?: string };

export interface FtOrderFilledEvent {
  listingKey: string;
  batchGroupId: string;
  metabotId: number;
  assetKey: string;
  symbol: string;
  rail: 'btc-psbt' | 'mvc-tokensell' | 'me-escrow';
  amountDisplay: string;
  priceSats?: number;
  priceMeMilli?: number;
  filledTxId: string;
  filledLots: number;
  totalLots: number;
  settledAt: number;
}

export interface TokenOrderWatcherDeps {
  emitToRenderer?: (channel: string, payload: unknown) => void;
  recordNotification?: (input: AgentNotificationInput) => void;
  checkMvcTokenSellOrder?: (order: FtActiveOrderRecord) => Promise<OutpointSpendResolution>;
  checkBtcPsbtOrder?: (order: FtActiveOrderRecord) => Promise<OutpointSpendResolution>;
  fetchImpl?: typeof fetch;
  emitLog?: (msg: string) => void;
  now?: () => number;
}

function parseOutpointTuple(outpoint: string): { txid: string; vout: number } | null {
  const match = /^([0-9a-fA-F]{64}):(\d+)$/.exec(String(outpoint || '').trim());
  if (!match) return null;
  return { txid: match[1].toLowerCase(), vout: Number(match[2]) };
}

function sellerHash160HexFromAddress(address?: string): string | null {
  const trimmed = String(address || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = new mvc.Address(trimmed);
    return parsed.hashBuffer ? parsed.hashBuffer.toString('hex').toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Inspect an MVC spending rawTx to determine whether a TokenSell contract UTXO
 * was taken by an external buyer (`filled`) or reclaimed by the seller (`self_canceled`).
 *
 * Rule:
 * - Every FT output in the spending tx carries a 20-byte receiver address hash160
 *   in its MCP02 token dataPart (`ftProto.parseDataPart(scriptPubKey).tokenAddress`).
 * - If all FT token outputs with positive `tokenAmount` return to `sellerAddress`'s
 *   hash160, the seller canceled their own order (`self_canceled`).
 * - If at least one FT token output goes to a non-seller hash160 (or seller
 *   received an explicit P2PKH payout output >= `priceSats` alongside a foreign
 *   FT receiver), it is an external buyer fill (`filled`).
 */
export function classifyMvcTokenSellSpendingTx(
  spendingRawHex: string,
  sellerAddress?: string,
  expectedPriceSats?: number,
): 'filled' | 'self_canceled' {
  const sellerHash160 = sellerHash160HexFromAddress(sellerAddress);
  if (!sellerHash160) return 'filled';

  try {
    const parsed = parseRawTx(spendingRawHex);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ftProto = require('meta-contract/dist/mcp02/contract-proto/token.proto.js');
    const tokenRecipientHashes: string[] = [];

    for (const out of parsed.outputs) {
      try {
        const dp = ftProto.parseDataPart(out.scriptPubKey);
        if (dp && BigInt(String(dp.tokenAmount ?? '0')) > 0n && dp.tokenAddress) {
          const addrHex = Buffer.isBuffer(dp.tokenAddress)
            ? dp.tokenAddress.toString('hex').toLowerCase()
            : String(dp.tokenAddress).toLowerCase();
          if (addrHex) tokenRecipientHashes.push(addrHex);
        }
      } catch {
        // Non-FT output (e.g. SPACE payment or change)
      }
    }

    if (tokenRecipientHashes.length > 0) {
      const hasExternalBuyer = tokenRecipientHashes.some((h) => h !== sellerHash160);
      return hasExternalBuyer ? 'filled' : 'self_canceled';
    }

    // Fallback if FT dataPart could not be decoded: check if seller received P2PKH payout >= priceSats
    // while another P2PKH/contract output exists.
    if (expectedPriceSats && expectedPriceSats > 0) {
      const sellerP2pkhScript = `76a914${sellerHash160}88ac`;
      const paidSeller = parsed.outputs.some(
        (o) =>
          (Buffer.isBuffer(o.scriptPubKey)
            ? o.scriptPubKey.toString('hex').toLowerCase()
            : String(o.scriptPubKey).toLowerCase()) === sellerP2pkhScript &&
          Number(o.satoshis) >= expectedPriceSats,
      );
      if (paidSeller) return 'filled';
    }
  } catch {
    // Fall through to conservative default
  }
  return 'filled';
}

async function defaultCheckMvcTokenSellOrder(
  order: FtActiveOrderRecord,
  fetchFn: typeof fetch,
): Promise<OutpointSpendResolution> {
  const tuple = parseOutpointTuple(order.utxoOutpoint);
  if (!tuple) return { state: 'unspent' };

  const res = await fetchFn(
    `${METALET_HOST}/wallet-api/v4/mvc/tx/outpoint?txId=${tuple.txid}&outputIndex=${tuple.vout}&net=livenet`,
  );
  if (!res.ok) return { state: 'unspent' };
  const json = (await res.json()) as {
    code?: number;
    data?: {
      spent?: boolean;
      spendTxId?: string;
      txId?: string;
      spendingTxId?: string;
    };
  };
  const data = json?.data;
  const spendTxId = String(
    data?.spendTxId ?? data?.spendingTxId ?? '',
  ).trim().toLowerCase();
  const isSpent = Boolean(data?.spent || /^[0-9a-f]{64}$/.test(spendTxId));
  if (!isSpent || !/^[0-9a-f]{64}$/.test(spendTxId)) {
    return { state: 'unspent' };
  }

  // Fetch spending rawTx to distinguish buyer `take` vs seller `cancel`
  try {
    const rawRes = await fetchFn(
      `${METALET_HOST}/wallet-api/v4/mvc/tx/raw?txId=${spendTxId}&net=mainnet`,
    );
    if (rawRes.ok) {
      const rawJson = (await rawRes.json()) as { data?: { hex?: string } };
      if (rawJson?.data?.hex) {
        const kind = classifyMvcTokenSellSpendingTx(
          rawJson.data.hex,
          order.sellerAddress,
          order.priceSats,
        );
        if (kind === 'self_canceled') {
          return { state: 'self_canceled', cancelTxId: spendTxId };
        }
      }
    }
  } catch {
    // Proceed with filled if outpoint is confirmed spent and not locally canceled
  }

  return { state: 'filled', filledTxId: spendTxId };
}

async function defaultCheckBtcPsbtOrder(
  order: FtActiveOrderRecord,
  fetchFn: typeof fetch,
): Promise<OutpointSpendResolution> {
  // 1. If marketOrderId is recorded, check MetaID.market order status first
  if (order.marketOrderId) {
    try {
      const mktRes = await fetchFn(
        `${METAID_MARKET_HOST}/api-market/api/v1/common/mrc20/market/order/info?orderId=${encodeURIComponent(order.marketOrderId)}`,
      );
      if (mktRes.ok) {
        const mktJson = (await mktRes.json()) as {
          code?: number;
          data?: { orderState?: number; status?: string; txId?: string; dealTxId?: string };
        };
        const stateNum = Number(mktJson?.data?.orderState ?? 0);
        const stateStr = String(mktJson?.data?.status ?? '').toLowerCase();
        const dealTxId = String(mktJson?.data?.dealTxId ?? mktJson?.data?.txId ?? '').trim();
        if (stateNum === 3 || stateStr === 'sold' || stateStr === 'filled') {
          if (dealTxId) return { state: 'filled', filledTxId: dealTxId };
        }
        if (stateNum === 2 || stateStr === 'canceled' || stateStr === 'cancelled') {
          return { state: 'self_canceled', cancelTxId: dealTxId || undefined };
        }
      }
    } catch {
      // Fall back to BTC outspend check
    }
  }

  // 2. Direct BTC outpoint spend check via mempool API
  const tuple = parseOutpointTuple(order.utxoOutpoint);
  if (!tuple) return { state: 'unspent' };

  const outspendRes = await fetchFn(
    `${MEMPOOL_HOST}/api/tx/${tuple.txid}/outspend/${tuple.vout}`,
  );
  if (!outspendRes.ok) return { state: 'unspent' };
  const outspend = (await outspendRes.json()) as { spent?: boolean; txid?: string };
  if (!outspend?.spent || !outspend.txid) {
    return { state: 'unspent' };
  }
  const spendingTxId = String(outspend.txid).trim().toLowerCase();

  // Inspect spending tx outputs on mempool API: if seller received >= priceSats
  // and another address also received an output, it's an external PSBT fill;
  // if every output belongs to sellerAddress, it's a self-cancel / UTXO consolidation.
  if (order.sellerAddress) {
    try {
      const txRes = await fetchFn(`${MEMPOOL_HOST}/api/tx/${spendingTxId}`);
      if (txRes.ok) {
        const txJson = (await txRes.json()) as {
          vout?: Array<{ value?: number; scriptpubkey_address?: string }>;
        };
        const vouts = Array.isArray(txJson?.vout) ? txJson.vout : [];
        const addresses = vouts
          .map((v) => String(v.scriptpubkey_address || '').trim())
          .filter(Boolean);
        if (
          addresses.length > 0 &&
          addresses.every((addr) => addr.toLowerCase() === order.sellerAddress!.toLowerCase())
        ) {
          return { state: 'self_canceled', cancelTxId: spendingTxId };
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return { state: 'filled', filledTxId: spendingTxId };
}

export class TokenOrderWatcher {
  private readonly db: SqliteDatabase;
  private readonly saveDb?: () => void;
  private readonly deps: TokenOrderWatcherDeps;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInFlight = false;

  constructor(db: SqliteDatabase, saveDb?: () => void, deps: TokenOrderWatcherDeps = {}) {
    this.db = db;
    this.saveDb = saveDb;
    this.deps = deps;
    ensureFtOrderTables(db);
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(msg: string): void {
    if (this.deps.emitLog) this.deps.emitLog(msg);
    else console.log(msg);
  }

  async pollOnce(): Promise<{ checked: number; filled: number; canceled: number }> {
    if (this.pollingInFlight) {
      return { checked: 0, filled: 0, canceled: 0 };
    }
    this.pollingInFlight = true;
    let checked = 0;
    let filled = 0;
    let canceled = 0;

    try {
      const activeOrders = listFtActiveOrders(this.db, {
        status: 'active',
        rails: ['btc-psbt', 'mvc-tokensell'],
      });
      if (activeOrders.length === 0) {
        return { checked: 0, filled: 0, canceled: 0 };
      }

      const fetchFn = this.deps.fetchImpl ?? fetch;

      for (const order of activeOrders) {
        checked += 1;
        try {
          const resolution =
            order.rail === 'mvc-tokensell'
              ? await (this.deps.checkMvcTokenSellOrder
                  ? this.deps.checkMvcTokenSellOrder(order)
                  : defaultCheckMvcTokenSellOrder(order, fetchFn))
              : await (this.deps.checkBtcPsbtOrder
                  ? this.deps.checkBtcPsbtOrder(order)
                  : defaultCheckBtcPsbtOrder(order, fetchFn));

          if (resolution.state === 'unspent') continue;

          if (resolution.state === 'self_canceled') {
            updateFtOrderStatus(
              this.db,
              order.listingKey,
              'canceled',
              { filledTxId: resolution.cancelTxId, nowMs: this.nowMs() },
              this.saveDb,
            );
            canceled += 1;
            continue;
          }

          // External buyer fill!
          const now = this.nowMs();
          updateFtOrderStatus(
            this.db,
            order.listingKey,
            'filled',
            { filledTxId: resolution.filledTxId, nowMs: now },
            this.saveDb,
          );
          filled += 1;

          const progress = getFtBatchOrderProgress(this.db, order.batchGroupId);
          const filledLots = progress?.filledLots ?? 1;
          const totalLots = progress?.totalLots ?? 1;

          const fillEvent: FtOrderFilledEvent = {
            listingKey: order.listingKey,
            batchGroupId: order.batchGroupId,
            metabotId: order.metabotId,
            assetKey: order.assetKey,
            symbol: order.symbol,
            rail: order.rail,
            amountDisplay: order.amountDisplay,
            ...(order.priceSats != null ? { priceSats: order.priceSats } : {}),
            filledTxId: resolution.filledTxId,
            filledLots,
            totalLots,
            settledAt: now,
          };

          this.deps.emitToRenderer?.('ftTrade:orderFilled', fillEvent);

          const priceBadge =
            order.priceSats != null ? ` for ${order.priceSats.toLocaleString('en-US')} sats` : '';
          this.deps.recordNotification?.({
            eventId: `ft-fill:${order.listingKey}`,
            type: 'ft.order.filled',
            category: 'work',
            metabotId: order.metabotId,
            sessionId: order.sessionId ?? null,
            taskId: null,
            runId: null,
            title: `${order.symbol} order filled (${filledLots}/${totalLots})`,
            body: `Sold ${order.amountDisplay} ${order.symbol}${priceBadge} on ${order.rail === 'btc-psbt' ? 'BTC PSBT' : 'MVC TokenSell'}.`,
            priority: 'normal',
            target: order.sessionId
              ? { kind: 'session', sessionId: order.sessionId }
              : { kind: 'bot_automation', metabotId: order.metabotId, section: 'surf' },
          });
        } catch (err) {
          this.log(
            `[TokenOrderWatcher] Check failed for ${order.listingKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.pollingInFlight = false;
    }

    return { checked, filled, canceled };
  }

  startPolling(intervalMs: number = TOKEN_ORDER_WATCHER_INTERVAL_MS): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        this.log(
          `[TokenOrderWatcher] Poll tick error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
