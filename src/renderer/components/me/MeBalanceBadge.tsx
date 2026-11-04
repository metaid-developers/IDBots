/**
 * Global ME balance badge (S9 §3 信息架构 1).
 *
 * One number: the total ME balance (weekly grant pool + persistent pool).
 * Click opens the breakdown panel: 本周额度 (with reset countdown) / 充值 /
 * 赠送 / 收入, plus 「开通/升级套餐」 and 「充值」 buttons and the usage &
 * credits entry.
 *
 * 联动规则 (S9 §4 区块4): when the balance falls below 20% of one week's
 * mean consumption, the badge turns amber and the recharge shortcut is
 * highlighted. Amounts are always the live API values (milliME → ME)
 * — never hardcoded client-side.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  ensureMeSnapshot,
  formatMe,
  requestMeBalance,
  getMeSnapshot,
  isMeBalanceLow,
  meFromMilli,
  meResetParts,
  isMeEffectivelySubscribed,
  invalidateMeSnapshot,
  requestOpenMePurchase,
  requestOpenUsagePage,
  subscribeMeSnapshot,
} from './mePointsStore';

/** Small ME coin glyph (no extra icon dependency). */
const MeCoinIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
    <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.4" />
    <path d="M6.6 13.2V6.8h2.5c1.5 0 2.4.9 2.4 2.3s-.9 2.3-2.4 2.3H8v1.8H6.6Zm1.4-3.1h1c.7 0 1.1-.4 1.1-1s-.4-1-1.1-1H8v2Z" fill="currentColor" />
  </svg>
);

const MeBalanceBadge: React.FC = () => {
  // useSyncExternalStore keeps this render in step with the shared store.
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [panelOpen, setPanelOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    ensureMeSnapshot();
    // Light freshness loop: the main process caches balance for 30s; a 60s
    // poll keeps the badge honest (weekly burn + manual topup confirmations)
    // without hammering the signed endpoint.
    const handle = setInterval(() => {
      void requestMeBalance({ ttlMs: 55_000 });
    }, 60_000);
    return () => clearInterval(handle);
  }, []);

  const balance = snapshot.balance;
  const weekly = balance ? balance.weeklyGrant : null;
  const persistentMilli = balance
    ? (balance.persistent?.topupMilli ?? 0) + (balance.persistent?.earnedMilli ?? 0) + (balance.persistent?.bonusMilli ?? 0)
    : 0;
  const totalMe = balance ? meFromMilli(balance.totalAvailable) : 0;
  const grantMe = balance ? meFromMilli(weekly?.amountMilli) : 0;
  const remainingMe = balance ? meFromMilli(weekly?.remainingMilli) : 0;
  const low = balance
    ? isMeBalanceLow({
        weeklyAmountMilli: weekly?.amountMilli ?? 0,
        weeklyRemainingMilli: weekly?.remainingMilli ?? 0,
        persistentTotalMilli: persistentMilli,
      })
    : false;
  const loading = snapshot.balanceLoading && !balance;
  const unavailable = !!snapshot.balanceError && !balance;

  const reset = weekly ? meResetParts(weekly.nextResetAt) : null;
  const resetLine = !reset
    ? ''
    : reset.unit === 'soon'
      ? i18nService.t('mePanelResetSoon')
      : reset.unit === 'hours'
        ? i18nService.t('mePanelResetInHours').replace('{n}', String(reset.n))
        : i18nService.t('mePanelResetInDays').replace('{n}', String(reset.n));

  const handleRefresh = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      setRefreshing(true);
      invalidateMeSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 600));
      setRefreshing(false);
    },
    [],
  );

  const grantRatio = grantMe > 0 ? Math.max(0, Math.min(100, (remainingMe / grantMe) * 100)) : 0;
  const upgraded = isMeEffectivelySubscribed(snapshot.subscription);
  const isTopupAllowed = upgraded; // PRD §2.2: free tier must NOT see a recharge entry.
  const badgeClass = unavailable
    ? 'text-claude-textSecondary dark:text-claude-darkTextSecondary'
    : low
      ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-300/60 dark:border-amber-700/60'
      : 'text-claude-accent dark:text-claude-darkAccent';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setPanelOpen((open) => !open)}
        title={i18nService.t('mePanelTitle')}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors bg-claude-surface/80 dark:bg-claude-darkSurface/80 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${badgeClass}`}
      >
        <MeCoinIcon className="h-3.5 w-3.5" />
        <span className="tabular-nums tracking-tight">
          {loading ? '…' : unavailable ? i18nService.t('meBadgeUnavailable') : formatMe(totalMe)}
        </span>
        <span className="text-[10px] opacity-80">ME</span>
        <ChevronUpIcon className={`h-3 w-3 transition-transform ${panelOpen ? 'rotate-180' : ''}`} />
      </button>

      {panelOpen && (
        <>
          <div className="fixed inset-0 z-[79]" onClick={() => setPanelOpen(false)} />
          <div className="absolute right-0 top-[calc(100%+8px)] z-[80] w-[300px] rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface shadow-xl p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-claude-text dark:text-claude-darkText">
                {i18nService.t('mePanelTitle')}
              </span>
              <button
                type="button"
                onClick={handleRefresh}
                title={i18nService.t('mePanelRefresh')}
                className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ArrowPathIcon className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {unavailable ? (
              <p className="mt-3 text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('mePanelLoadFailed')}
              </p>
            ) : (
              <>
                <div className="mt-3 rounded-xl border border-claude-border/60 dark:border-claude-darkBorder/60 bg-claude-surfaceInset/60 dark:bg-claude-darkSurfaceInset/40 px-3 py-2.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('mePanelTotal')}
                    </span>
                    <span className="text-lg font-semibold tabular-nums text-claude-text dark:text-claude-darkText">
                      {formatMe(totalMe)}
                      <span className="ml-1 text-[10px] font-normal text-claude-textSecondary dark:text-claude-darkTextSecondary">ME</span>
                    </span>
                  </div>
                  {balance && balance.frozenMilli > 0 && (
                    <p className="mt-1 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('mePanelFrozen').replace('{me}', formatMe(meFromMilli(balance.frozenMilli)))}
                    </p>
                  )}
                </div>

                <div className="mt-3 space-y-2">
                  <div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('mePanelWeekly')}
                      </span>
                      <span className="tabular-nums text-claude-text dark:text-claude-darkText">
                        {formatMe(remainingMe)} / {formatMe(grantMe)}
                      </span>
                    </div>
                    <div className="mt-1 h-1 w-full rounded-full bg-claude-border dark:bg-claude-darkBorder overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${low ? 'bg-amber-500' : 'bg-claude-accent'}`}
                        style={{ width: `${grantRatio}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {resetLine}
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('mePanelTopup')}
                    </span>
                    <span className="tabular-nums text-claude-text dark:text-claude-darkText">
                      {formatMe(meFromMilli(balance?.persistent?.topupMilli))}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('mePanelBonus')}
                    </span>
                    <span className="tabular-nums text-claude-text dark:text-claude-darkText">
                      {formatMe(meFromMilli(balance?.persistent?.bonusMilli))}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('mePanelEarned')}
                    </span>
                    <span className="tabular-nums text-claude-text dark:text-claude-darkText">
                      {formatMe(meFromMilli(balance?.persistent?.earnedMilli))}
                    </span>
                  </div>
                </div>

                <div className={`mt-3 flex ${isTopupAllowed ? 'gap-2' : ''}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setPanelOpen(false);
                      requestOpenMePurchase('subscribe');
                    }}
                    className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors ${
                      isTopupAllowed
                        ? 'border border-claude-border dark:border-claude-darkBorder text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                        : 'btn-idchat-primary-filled'
                    }`}
                  >
                    {i18nService.t('mePanelUpgrade')}
                  </button>
                  {isTopupAllowed && (
                    <button
                      type="button"
                      onClick={() => {
                        setPanelOpen(false);
                        requestOpenMePurchase('topup');
                      }}
                      className="btn-idchat-primary-filled flex-1 rounded-lg px-2 py-1.5 text-[11px] font-medium"
                    >
                      {i18nService.t('mePanelRecharge')}
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setPanelOpen(false);
                    requestOpenUsagePage();
                  }}
                  className="mt-2.5 w-full text-left text-[11px] text-claude-accent dark:text-claude-darkAccent hover:underline"
                >
                  {i18nService.t('mePanelUsageLink')}
                </button>

                <p className="mt-2 border-t border-claude-border/50 dark:border-claude-darkBorder/50 pt-2 text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('mePanelNote')}
                </p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default MeBalanceBadge;
