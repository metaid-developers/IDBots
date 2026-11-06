/**
 * 「用量 & 积分」 merged details page (S9 §3 信息架构 2) — replaces the old
 * 剩余流量 / 免费 LLM 额度 / 小脑额度 surfaces on desktop.
 *
 * Sections: 双池概览 (from /v1/me/balance), 充值订单 (topup orders with
 * submitted → confirmed/rejected status polling), ME 流水 (/v1/me/history
 * cursor paging with type filter; metering entries carry refType llm/agent/
 * traffic — the burn pipeline is backend-pending, the display slot is ready),
 * and the rates/multiplier explainer.
 * All values render live from the API; nothing is hardcoded.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { MeHistoryEntryInfo, MeTopupOrderInfo } from '../../types/electron';
import {
  ensureMeSnapshot,
  formatMe,
  formatMeSigned,
  getMeSnapshot,
  meFromMilli,
  meResetParts,
  subscribeMeSnapshot,
} from './mePointsStore';

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
  if (isOrderClosed(normalized)) return i18nService.t('meOrderStatusRejected');
  if (/submit|created|pending|paid/i.test(normalized)) return i18nService.t('meOrderStatusSubmitted');
  return status || '—';
};

const orderStatusClass = (status: string): string => {
  const normalized = (status || '').toLowerCase();
  if (isOrderCredited(normalized)) return 'bg-green-500/15 text-green-600 dark:text-green-400';
  if (isOrderClosed(normalized)) return 'bg-red-500/10 text-red-600 dark:text-red-400';
  return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
};

/** Metering reference types (llm/agent/traffic) — display slots reserved ahead of the burn rollout. */
const meteringTagLabel = (refType: string | undefined): string | null => {
  const normalized = (refType || '').toLowerCase();
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

const MeUsageAndCredits: React.FC = () => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [entries, setEntries] = useState<MeHistoryEntryInfo[]>([]);
  const [nextCursor, setNextCursor] = useState<string>('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [orders, setOrders] = useState<MeTopupOrderInfo[]>([]);
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
      const res = await window.electron.mePoints.getTopupOrders();
      if (res.success && Array.isArray(res.orders)) setOrders(res.orders);
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

  // Status polling while any order is still submitted (refresh every 20s).
  useEffect(() => {
    if (!orders.some((order) => /submit/i.test(order.status))) return;
    const handle = setInterval(() => void loadOrders(false), 20_000);
    return () => clearInterval(handle);
  }, [orders, loadOrders]);

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    void ensureMeSnapshot();
    setEntries([]);
    setNextCursor('');
    await Promise.all([loadHistory(true), loadOrders(false)]);
    setRefreshing(false);
  }, [loadHistory, loadOrders]);

  const balance = snapshot.balance;
  const weekly = balance?.weeklyGrant;
  const grantMe = meFromMilli(weekly?.amountMilli);
  const remainingMe = meFromMilli(weekly?.remainingMilli);
  const reset = weekly ? meResetParts(weekly.nextResetAt) : null;
  const resetLine = !reset
    ? ''
    : reset.unit === 'soon'
      ? i18nService.t('mePanelResetSoon')
      : reset.unit === 'hours'
        ? i18nService.t('mePanelResetInHours').replace('{n}', String(reset.n))
        : i18nService.t('mePanelResetInDays').replace('{n}', String(reset.n));

  const rates = snapshot.rates ?? [];

  return (
    <div className="h-full overflow-y-auto px-4 py-4 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-claude-text dark:text-claude-darkText">{i18nService.t('meUsageTitle')}</h2>
          <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('meUsageSubtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefreshAll()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-claude-border dark:border-claude-darkBorder px-2.5 py-1.5 text-[11px] font-medium text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          <ArrowPathIcon className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {i18nService.t('freeQuotaRefresh')}
        </button>
      </div>

      {/* 双池概览 */}
      <div className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface/60 p-3.5">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-claude-surfaceInset/50 dark:bg-claude-darkSurfaceInset/40 px-3 py-2.5">
            <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('mePanelWeekly')}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-claude-text dark:text-claude-darkText">
              {balance ? `${formatMe(remainingMe)} / ${formatMe(grantMe)}` : '—'}
              <span className="ml-1 text-[10px] font-normal text-claude-textSecondary">ME</span>
            </p>
            <p className="mt-0.5 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{resetLine}</p>
          </div>
          <div className="rounded-xl bg-claude-surfaceInset/50 dark:bg-claude-darkSurfaceInset/40 px-3 py-2.5">
            <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('meUsagePersistent')}</p>
            <div className="mt-1 space-y-0.5 text-[11px] tabular-nums text-claude-text dark:text-claude-darkText">
              <div className="flex justify-between"><span>{i18nService.t('mePanelTopup')}</span><span>{balance ? formatMe(meFromMilli(balance.persistent?.topupMilli)) : '—'}</span></div>
              <div className="flex justify-between"><span>{i18nService.t('mePanelBonus')}</span><span>{balance ? formatMe(meFromMilli(balance.persistent?.bonusMilli)) : '—'}</span></div>
              <div className="flex justify-between"><span>{i18nService.t('mePanelEarned')}</span><span>{balance ? formatMe(meFromMilli(balance.persistent?.earnedMilli)) : '—'}</span></div>
            </div>
          </div>
        </div>
        <p className="mt-2 border-t border-claude-border/50 dark:border-claude-darkBorder/50 pt-2 text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('mePanelNote')}
        </p>
      </div>

      {/* 充值订单 */}
      <div className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface/60 p-3.5">
        <h3 className="text-xs font-semibold text-claude-text dark:text-claude-darkText">{i18nService.t('meUsageOrders')}</h3>
        {orders.length === 0 ? (
          <p className="mt-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {ordersLoading ? i18nService.t('loading') : i18nService.t('meUsageOrdersEmpty')}
          </p>
        ) : (
          <div className="mt-2 divide-y divide-claude-border/50 dark:divide-claude-darkBorder/50">
            {orders.map((order) => (
              <div key={order.orderId} className="flex items-center justify-between py-2 text-[11px]">
                <div className="min-w-0">
                  <p className="truncate text-claude-text dark:text-claude-darkText">
                    {order.packageId}
                    <span className="ml-2 tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {formatOrderTime(order.createdAt)}
                    </span>
                  </p>
                  {order.rejectReason && (
                    <p className="truncate text-[10px] text-red-500">{order.rejectReason}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {order.meMilli != null && order.meMilli > 0 && (
                    <span className="tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      +{formatMe(meFromMilli(order.meMilli))} ME
                    </span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${orderStatusClass(order.status)}`}>
                    {orderStatusLabel(order.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
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
