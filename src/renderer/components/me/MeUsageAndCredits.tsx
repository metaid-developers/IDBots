/**
 * 「用量 & 积分」 merged details page (S9 §3 信息架构 2) — replaces the old
 * 剩余流量 / 免费 LLM 额度 / 小脑额度 surfaces on desktop.
 *
 * Sections: 双池概览 (MeBalanceOverviewCard, from /v1/me/balance), 充值订单
 * (topup orders with submitted → confirmed/rejected status polling), ME 流水
 * (/v1/me/history cursor paging with type filter; metering burns carry refType
 * metering:llm / metering:agent / metering:traffic), and the rates/multiplier
 * explainer.
 * All values render live from the API; nothing is hardcoded.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { MeHistoryEntryInfo, MeSubscriptionOrderInfo, MeTopupOrderInfo } from '../../types/electron';
import {
  ensureMeSnapshot,
  formatMe,
  formatMeSigned,
  getMeSnapshot,
  meFromMilli,
  requestOpenMePurchase,
  subscribeMeSnapshot,
} from './mePointsStore';
import MeBalanceOverviewCard from './MeBalanceOverviewCard';

const HISTORY_TYPES = ['', 'mint', 'topup', 'bonus', 'burn', 'transfer', 'reverse', 'adjust', 'expire'] as const;

const historyTypeLabel = (type: string): string => {
  switch ((type || '').toLowerCase()) {
    case 'mint': return i18nService.t('meUsageTypeMint');
    case 'topup': return i18nService.t('meUsageTypeTopup');
    case 'bonus': return i18nService.t('meUsageTypeBonus');
    case 'burn': return i18nService.t('meUsageTypeBurn');
    case 'transfer': return i18nService.t('meUsageTypeTransfer');
    case 'reverse': return i18nService.t('meUsageTypeReverse');
    case 'adjust': return i18nService.t('meUsageTypeAdjust');
    case 'expire': return i18nService.t('meUsageTypeExpire');
    default: return type || '—';
  }
};

const isOrderCredited = (status: string): boolean => /confirm|credit|active|complete|success/i.test(status);
const isOrderClosed = (status: string): boolean => /reject|closed|expired|cancel|fail/i.test(status);

const orderStatusLabel = (status: string): string => {
  const normalized = (status || '').toLowerCase();
  if (isOrderCredited(normalized)) return i18nService.t('meOrderStatusConfirmed');
  if (isOrderClosed(normalized)) {
    // Janitor-expired orders close as "closed" — not an admin rejection.
    return /reject|fail/i.test(normalized)
      ? i18nService.t('meOrderStatusRejected')
      : i18nService.t('meOrderStatusClosed');
  }
  if (/submit|created|pending|paid/i.test(normalized)) return i18nService.t('meOrderStatusSubmitted');
  return status || '—';
};

const orderStatusClass = (status: string): string => {
  const normalized = (status || '').toLowerCase();
  if (isOrderCredited(normalized)) return 'bg-green-500/15 text-green-600 dark:text-green-400';
  if (isOrderClosed(normalized)) return 'bg-red-500/10 text-red-600 dark:text-red-400';
  return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
};

/**
 * A subscription checkout order still unpaid after this long was abandoned:
 * the Alipay 当面付 code lapses after ~2h, while the server janitor only
 * closes the row at 24h. Rendering it as 「提交中」 for a whole day reads as a
 * live payment, so it shows 「超时未支付」 and stops driving the status poll.
 * Server status always wins once it moves (paid / credited / closed). Topup
 * orders are manual-review rows whose `submitted` state is genuinely
 * pending, so they never go stale here.
 */
export const ME_UNPAID_ORDER_STALE_MS = 2 * 60 * 60 * 1000;

const isUnpaidOrderStatus = (status: string): boolean => /created|pending|submit/i.test(status || '') && !/paid/i.test(status || '');

const isStaleUnpaidSubscriptionOrder = (
  order: { status: string; createdAt?: number },
  now: number,
): boolean => {
  const createdMs = orderEpochMs(order.createdAt);
  return createdMs > 0 && isUnpaidOrderStatus(order.status) && now - createdMs > ME_UNPAID_ORDER_STALE_MS;
};

/**
 * Metering reference types (llm/agent/traffic). The backend writes metering
 * burns as `metering:<line>` (ABS RefTypePrefixMetering) — sponsored traffic
 * burns as `metering:traffic` — while older rows and docs used the bare line,
 * so both shapes map to the same tag.
 */
export const meteringTagLabel = (refType: string | undefined): string | null => {
  const normalized = (refType || '').toLowerCase().replace(/^metering:/, '');
  if (normalized === 'llm' || normalized === 'agent' || normalized === 'traffic' || normalized === 'brain') {
    return normalized.toUpperCase();
  }
  return null;
};

const formatOrderTime = (ts: number | undefined): string => {
  if (!ts || !Number.isFinite(ts)) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(ts > 1e11 ? ts : ts * 1000);
  } catch {
    return '—';
  }
};

const orderEpochMs = (ts: number | undefined): number => (
  ts && Number.isFinite(ts) ? (ts > 1e11 ? ts : ts * 1000) : 0
);

/** One row of the merged payment-records list (subscription + topup orders). */
interface MePaymentRecordRow {
  key: string;
  kind: 'subscription' | 'topup';
  orderId: string;
  title: string;
  createdAt?: number;
  /** milliME granted (topup only). */
  meMilli?: number;
  amountCny?: number;
  status: string;
  rejectReason?: string;
  /** Subscription order still unpaid past the stale window (超时未支付). */
  staleUnpaid?: boolean;
}

const MeUsageAndCredits: React.FC = () => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [entries, setEntries] = useState<MeHistoryEntryInfo[]>([]);
  const [nextCursor, setNextCursor] = useState<string>('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [orders, setOrders] = useState<MeTopupOrderInfo[]>([]);
  const [subOrders, setSubOrders] = useState<MeSubscriptionOrderInfo[]>([]);
  const [subOrdersUnavailable, setSubOrdersUnavailable] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadHistory = useCallback(async (reset: boolean) => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const res = await window.electron.mePoints.getHistory({
        type: typeFilter || undefined,
        beforeId: reset ? undefined : (nextCursor || undefined),
        limit: 50,
      });
      if (res.success && res.history) {
        setEntries((prev) => (reset ? res.history!.entries : [...prev, ...res.history!.entries]));
        setNextCursor(res.history.nextCursor || '');
      } else {
        setHistoryError(res.error || i18nService.t('meUsageLoadFailed'));
      }
    } catch {
      setHistoryError(i18nService.t('meUsageLoadFailed'));
    } finally {
      setHistoryLoading(false);
    }
  }, [typeFilter, nextCursor]);

  const loadOrders = useCallback(async (withSpinner: boolean) => {
    if (withSpinner) setOrdersLoading(true);
    try {
      const [topupRes, subRes] = await Promise.all([
        window.electron.mePoints.getTopupOrders(),
        window.electron.mePoints.getSubscriptionOrders().catch(() => null),
      ]);
      if (topupRes.success && Array.isArray(topupRes.orders)) setOrders(topupRes.orders);
      if (subRes && subRes.success && Array.isArray(subRes.orders)) {
        setSubOrders(subRes.orders);
        setSubOrdersUnavailable(false);
      } else if (subRes && subRes.featureUnavailable) {
        // List endpoint not deployed yet (pre-v0.3 servers) — degrade to
        // topup-only records instead of surfacing an error.
        setSubOrders([]);
        setSubOrdersUnavailable(true);
      }
      // Other subscription-list failures keep the previous rows (transient).
    } catch {
      // Orders stay as-is on failure; the section shows its empty state.
    } finally {
      if (withSpinner) setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!snapshot.balance) ensureMeSnapshot();
    void loadHistory(true);
    void loadOrders(true);
  }, [typeFilter]);

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    void ensureMeSnapshot();
    setEntries([]);
    setNextCursor('');
    await Promise.all([loadHistory(true), loadOrders(false)]);
    setRefreshing(false);
  }, [loadHistory, loadOrders]);

  const rates = snapshot.rates ?? [];

  // Merged payment records: subscription orders + topup orders, newest first.
  // `now` pins the staleness sweep to a single clock read per rebuild.
  const now = Date.now();
  const paymentRows = useMemo<MePaymentRecordRow[]>(() => {
    const rows: MePaymentRecordRow[] = [];
    for (const order of subOrders) {
      const plan = snapshot.plans.find((item) => item.planId === order.planId);
      const isPeriod = order.period === 'month' || order.period === 'quarter' || order.period === 'year';
      const periodLabel = isPeriod
        ? i18nService.t(`mePurchasePeriod_${order.period as 'month' | 'quarter' | 'year'}`)
        : '';
      rows.push({
        key: `sub-${order.orderId}`,
        kind: 'subscription',
        orderId: order.orderId,
        title: `${plan?.name ?? order.planId}${periodLabel ? ` · ${periodLabel}` : ''}`,
        createdAt: order.createdAt,
        amountCny: order.payAmount ?? order.amountCny,
        status: order.status,
        rejectReason: order.rejectReason,
        staleUnpaid: isStaleUnpaidSubscriptionOrder(order, now),
      });
    }
    for (const order of orders) {
      rows.push({
        key: `topup-${order.orderId}`,
        kind: 'topup',
        orderId: order.orderId,
        title: order.packageId,
        createdAt: order.createdAt,
        meMilli: order.meMilli,
        amountCny: order.priceCny,
        status: order.status,
        rejectReason: order.rejectReason,
      });
    }
    return rows.sort((a, b) => orderEpochMs(b.createdAt) - orderEpochMs(a.createdAt));
  }, [subOrders, orders, snapshot.plans, now]);

  // Status polling while any order (topup or subscription) is still live-
  // pending (refresh every 20s). Stale-unpaid subscription orders stop
  // driving the poll — only their server-side closure (janitor) changes them.
  useEffect(() => {
    const pendingLive = (status: string): boolean => /submit|created|pending|paid/i.test(status);
    const pending = orders.some((order) => pendingLive(order.status))
      || subOrders.some((order) => !isStaleUnpaidSubscriptionOrder(order, now) && pendingLive(order.status));
    if (!pending) return;
    const handle = setInterval(() => void loadOrders(false), 20_000);
    return () => clearInterval(handle);
  }, [orders, subOrders, loadOrders, now]);

  return (
    <div className="h-full overflow-y-auto px-4 py-4 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-claude-text dark:text-claude-darkText">{i18nService.t('meUsageTitle')}</h2>
          <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('meUsageSubtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            data-slot="me-usage-buy-credits"
            onClick={() => requestOpenMePurchase('topup')}
            className="btn-idchat-primary-filled inline-flex items-center justify-center rounded-xl px-3 py-1.5 text-xs font-medium"
          >
            {i18nService.t('meIncrementPackBuy')}
          </button>
          <button
            type="button"
            onClick={() => void handleRefreshAll()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-claude-border dark:border-claude-darkBorder px-2.5 py-1.5 text-[11px] font-medium text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {i18nService.t('freeQuotaRefresh')}
          </button>
        </div>
      </div>

      {/* 双池概览 */}
      <MeBalanceOverviewCard />

      {/* 支付记录：订阅订单 + 充值订单合并展示 */}
      <div className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface/60 p-3.5">
        <h3 className="text-xs font-semibold text-claude-text dark:text-claude-darkText">{i18nService.t('meUsageOrders')}</h3>
        {paymentRows.length === 0 ? (
          <p className="mt-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {ordersLoading ? i18nService.t('loading') : i18nService.t('meUsageOrdersEmpty')}
          </p>
        ) : (
          <div className="mt-2 divide-y divide-claude-border/50 dark:divide-claude-darkBorder/50">
            {paymentRows.map((row) => (
              <div key={row.key} className="flex items-center justify-between py-2 text-[11px]">
                <div className="min-w-0">
                  <p className="truncate text-claude-text dark:text-claude-darkText">
                    <span className="mr-1.5 rounded-md bg-claude-surfaceHover px-1.5 py-0.5 text-[10px] text-claude-textSecondary dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary">
                      {i18nService.t(row.kind === 'subscription' ? 'meUsageOrderKindSubscription' : 'meUsageOrderKindTopup')}
                    </span>
                    {row.title}
                    <span className="ml-2 tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {formatOrderTime(row.createdAt)}
                    </span>
                  </p>
                  {row.rejectReason && (
                    <p className="truncate text-[10px] text-red-500">{row.rejectReason}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {row.kind === 'topup' && row.meMilli != null && row.meMilli > 0 && (
                    <span className="tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      +{formatMe(meFromMilli(row.meMilli))} ME
                    </span>
                  )}
                  {row.kind === 'subscription' && row.amountCny != null && row.amountCny > 0 && (
                    <span className="tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      ¥{row.amountCny}
                    </span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    row.staleUnpaid
                      ? 'bg-claude-surfaceHover text-claude-textSecondary dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary'
                      : orderStatusClass(row.status)
                  }`}>
                    {row.staleUnpaid ? i18nService.t('meUsageOrderStale') : orderStatusLabel(row.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {subOrdersUnavailable && paymentRows.length > 0 && (
          <p className="mt-2 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('meUsageSubOrdersPending')}
          </p>
        )}
      </div>

      {/* ME 流水 */}
      <div className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface/60 p-3.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-xs font-semibold text-claude-text dark:text-claude-darkText">{i18nService.t('meUsageLedger')}</h3>
          <div className="flex flex-wrap gap-1">
            {HISTORY_TYPES.map((type) => (
              <button
                key={type || 'all'}
                type="button"
                onClick={() => setTypeFilter(type)}
                className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                  typeFilter === type
                    ? 'border-claude-accent text-claude-accent dark:text-claude-darkAccent bg-claude-accent/5'
                    : 'border-claude-border dark:border-claude-darkBorder text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {type ? historyTypeLabel(type) : i18nService.t('meUsageTypeAll')}
              </button>
            ))}
          </div>
        </div>
        {historyError && <p className="mt-2 text-[11px] text-red-500">{historyError}</p>}
        {entries.length === 0 && !historyLoading ? (
          <p className="mt-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('meUsageLedgerEmpty')}</p>
        ) : (
          <div className="mt-2 divide-y divide-claude-border/50 dark:divide-claude-darkBorder/50">
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between py-1.5 text-[11px]">
                <div className="min-w-0 flex items-center gap-1.5">
                  <span className="rounded-md bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover px-1.5 py-0.5 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {historyTypeLabel(entry.type)}
                  </span>
                  {meteringTagLabel(entry.refType) && (
                    <span
                      title={i18nService.t('meUsageReservedBadge')}
                      className="rounded-md border border-dashed border-claude-border dark:border-claude-darkBorder px-1.5 py-0.5 text-[9px] tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary"
                    >
                      {meteringTagLabel(entry.refType)}
                    </span>
                  )}
                  <span className="truncate text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {entry.reason || entry.refId || ''}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {entry.createdAt != null && (
                    <span className="text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {formatOrderTime(entry.createdAt)}
                    </span>
                  )}
                  <span className={`tabular-nums ${entry.amountMilli >= 0 ? 'text-green-600 dark:text-green-400' : 'text-claude-text dark:text-claude-darkText'}`}>
                    {formatMeSigned(entry.amountMilli)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {nextCursor && (
          <button
            type="button"
            disabled={historyLoading}
            onClick={() => void loadHistory(false)}
            className="mt-2 inline-flex items-center text-[11px] font-medium text-claude-accent dark:text-claude-darkAccent hover:underline disabled:opacity-50"
          >
            {i18nService.t('meUsageLoadMore')}
            <ChevronRightIcon className="ml-0.5 h-3 w-3" />
          </button>
        )}
        {historyLoading && <p className="mt-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('loading')}</p>}
        <p className="mt-2 text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('meUsageReservedNote')}
        </p>
      </div>

      {/* 倍率与换算说明（折叠区） */}
      <div className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface/60 p-3.5">
        <button
          type="button"
          onClick={() => setRatesOpen((open) => !open)}
          className="flex w-full items-center justify-between text-left"
        >
          <h3 className="text-xs font-semibold text-claude-text dark:text-claude-darkText">{i18nService.t('meUsageRates')}</h3>
          <ChevronRightIcon className={`h-3.5 w-3.5 text-claude-textSecondary dark:text-claude-darkTextSecondary transition-transform ${ratesOpen ? 'rotate-90' : ''}`} />
        </button>
        {ratesOpen && (
          <div className="mt-2 space-y-1">
            {rates.length === 0 ? (
              <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('meUsageRatesEmpty')}</p>
            ) : (
              rates.map((rate) => (
                <div key={rate.key} className="flex items-center justify-between text-[11px]">
                  <span className="truncate text-claude-text dark:text-claude-darkText">{rate.key}</span>
                  <span className="tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary">{rate.multiplier}x</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <p className="pb-2 text-center text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
        {i18nService.t('meUsageFooterNote')}
      </p>
    </div>
  );
};

export default MeUsageAndCredits;
