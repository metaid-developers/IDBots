/**
 * IDBots Plan provider card (S9 §4 区块1) — pinned to the top of the
 * settings > model page.
 *
 * Three states rendered from live server data:
 * - 未订阅 (free tier / no subscription): snapshot line (免费档 · {ME}/周
 *   with remaining progress) + a horizontal row of the three subscription
 *   tier cards, each with 开通 → the shared purchase flow.
 * - 已订阅: current tier, weekly remaining progress, next reset time and
 *   the 升级/续费 entry.
 * - 免费档 counts as 未订阅 for the tier row (its snapshot line is always
 *   shown when no active paid tier exists).
 *
 * Every price / weekly amount / remaining number comes from
 * /v1/me/plans + /v1/me/balance — the client hardcodes nothing.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  formatMe,
  getMeSnapshot,
  meActivePlanId,
  meFromMilli,
  meResetParts,
  isMeEffectivelySubscribed,
  requestOpenMePurchase,
  requestOpenUsagePage,
  subscribeMeSnapshot,
  ensureMeSnapshot,
} from './mePointsStore';

const PROGRESS_ACCENT = 'bg-claude-accent';
const PROGRESS_LOW = 'bg-amber-500';

const getTierHighlight = (plan: { weeklyAmountMilli?: number; periodDays?: number }): string =>
  i18nService.t('mePlanHighlightWeekly').replace('{me}', formatMe(meFromMilli(plan.weeklyAmountMilli)));

const IdbotsPlanCard: React.FC = () => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    ensureMeSnapshot();
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    ensureMeSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 600));
    setRefreshing(false);
  }, []);

  const plans = snapshot.plans.filter((plan) => plan.tier !== 'free');
  const balance = snapshot.balance;
  const weekly = balance?.weeklyGrant;
  const grantMe = meFromMilli(weekly?.amountMilli);
  const remainingMe = meFromMilli(weekly?.remainingMilli);
  const reset = weekly ? meResetParts(weekly.nextResetAt) : null;
  const subscribed = isMeEffectivelySubscribed(snapshot.subscription);
  const activePlanId = meActivePlanId(snapshot.subscription);
  const activePlan =
    (activePlanId && plans.find((plan) => plan.planId === activePlanId)) ||
    plans.find((plan) => plan.tier && snapshot.subscription?.raw?.tier === plan.tier) ||
    null;
  const grantRatio = grantMe > 0 ? Math.max(0, Math.min(100, (remainingMe / grantMe) * 100)) : 0;
  const progressAccent = grantMe > 0 && remainingMe / grantMe < 0.2 ? PROGRESS_LOW : PROGRESS_ACCENT;

  return (
    <div className="mb-3 rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface/60 p-3.5 shadow-subtle">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-claude-text dark:text-claude-darkText">
              {i18nService.t('mePlanTitle')}
            </h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                subscribed
                  ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                  : 'bg-claude-accent/10 text-claude-accent dark:text-claude-darkAccent'
              }`}
            >
              {subscribed
                ? i18nService.t('mePlanCurrentTier').replace('{name}', activePlan?.name ?? activePlanId ?? '')
                : i18nService.t('mePlanFreeBadge')}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('mePlanSub')}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          title={i18nService.t('mePanelRefresh')}
          className="shrink-0 rounded-lg p-1.5 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          <ArrowPathIcon className={`h-3.5 w-3.5 ${refreshing || snapshot.plansLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 状态行：免费档 or 已订阅 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        {subscribed ? (
          <div className="flex-1 min-w-[260px]">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('mePlanThisWeek')}
              </span>
              <span className="tabular-nums text-claude-text dark:text-claude-darkText">
                {formatMe(remainingMe)} / {formatMe(grantMe)} ME
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-claude-border dark:bg-claude-darkBorder overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${progressAccent}`}
                style={{ width: `${grantRatio}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="tabular-nums text-xs text-claude-text dark:text-claude-darkText">
            <span className="font-medium">{i18nService.t('mePlanFreeTierWithWeekly').replace('{me}', formatMe(grantMe))}</span>
            <span className="ml-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('mePlanRemainingShort').replace('{me}', formatMe(remainingMe))}
            </span>
          </div>
        )}
        <div className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {!reset
            ? ''
            : reset.unit === 'soon'
              ? i18nService.t('mePanelResetSoon')
              : reset.unit === 'hours'
                ? i18nService.t('mePlanResetIn').replace('{n}', String(reset.n))
                : i18nService.t('mePlanResetInDays').replace('{n}', String(reset.n))}
        </div>
        <button
          type="button"
          onClick={() => requestOpenMePurchase('subscribe')}
          className={`inline-flex items-center rounded-lg px-2.5 py-1 text-[11px] font-medium ${
            subscribed
              ? 'border border-claude-border dark:border-claude-darkBorder text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              : 'btn-idchat-primary-filled'
          }`}
        >
          {i18nService.t('mePlanUpgrade')}
          <ChevronRightIcon className="ml-0.5 h-3 w-3" />
        </button>
      </div>

      {/* 未订阅：三档横排卡片 */}
      {!subscribed && plans.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {plans.slice(0, 3).map((plan, index) => (
            <div
              key={plan.planId}
              className={`rounded-xl border px-2.5 py-2.5 transition-colors ${
                index === 1
                  ? 'border-claude-accent/40 bg-claude-accent/5 dark:bg-claude-accent/10'
                  : 'border-claude-border dark:border-claude-darkBorder bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30'
              }`}
            >
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-xs font-semibold text-claude-text dark:text-claude-darkText truncate">
                  {plan.name}
                </span>
                <span className="tabular-nums text-sm font-semibold text-claude-text dark:text-claude-darkText whitespace-nowrap">
                  {i18nService.t('mePlanPriceMonthly')
                    .replace('{price}', plan.desktopPriceCny != null ? String(plan.desktopPriceCny) : '—')}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary truncate">
                {getTierHighlight(plan)}
              </p>
              <button
                type="button"
                onClick={() => requestOpenMePurchase('subscribe')}
                className={`mt-1.5 w-full rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${
                  index === 1
                    ? 'btn-idchat-primary-filled'
                    : 'border border-claude-border dark:border-claude-darkBorder text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {i18nService.t('mePlanSubscribe')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-claude-border/50 dark:border-claude-darkBorder/50 pt-2">
        <p className="text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('mePlanComplianceLine')}
        </p>
        <button
          type="button"
          onClick={() => requestOpenUsagePage()}
          className="shrink-0 ml-3 text-[11px] text-claude-accent dark:text-claude-darkAccent hover:underline whitespace-nowrap"
        >
          {i18nService.t('mePanelUsageLink')}
        </button>
      </div>
    </div>
  );
};

export default IdbotsPlanCard;
