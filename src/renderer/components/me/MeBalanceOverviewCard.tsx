/**
 * ME 双池概览 card — the weekly grant (with tier badge and reset countdown)
 * next to the persistent pools (top-up / bonus / earned). Shared by the
 * 积分 tab (MeUsageAndCredits) and the 流量 tab once sponsored traffic is
 * billed in ME credits (TrafficSettings), so both answer "how much ME can I
 * spend" from the same mePointsStore snapshot. Callers own the refresh.
 */

import React from 'react';
import { i18nService } from '../../services/i18n';
import {
  formatMe,
  getMeSnapshot,
  isMeEffectivelySubscribed,
  meActivePlanId,
  meFromMilli,
  meResetParts,
  subscribeMeSnapshot,
} from './mePointsStore';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { meTierDisplayName } from './IdbotsPlanCard';

const MeBalanceOverviewCard: React.FC<{
  note?: string;
  footer?: React.ReactNode;
  /** OWNER 2026-11-16 00:40: refresh is an inline icon after 本周额度, not a footer box button. */
  onRefresh?: () => void;
  refreshing?: boolean;
}> = ({ note, footer, onRefresh, refreshing }) => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);

  const balance = snapshot.balance;
  const weekly = balance?.weeklyGrant;
  const grantMe = meFromMilli(weekly?.amountMilli);
  const remainingMe = meFromMilli(weekly?.remainingMilli);
  const persistent = balance?.persistent;
  const topupMe = meFromMilli(persistent?.topupMilli);
  const bonusMe = meFromMilli(persistent?.bonusMilli);
  const earnedMe = meFromMilli(persistent?.earnedMilli);
  const packTotalMe = topupMe + bonusMe + earnedMe;
  const reset = weekly ? meResetParts(weekly.nextResetAt) : null;
  const resetLine = !reset
    ? ''
    : reset.unit === 'soon'
      ? i18nService.t('mePanelResetSoon')
      : reset.unit === 'hours'
        ? i18nService.t('mePanelResetInHours').replace('{n}', String(reset.n))
        : reset.hours > 0
          ? i18nService.t('mePanelResetInDaysHours').replace('{n}', String(reset.n)).replace('{h}', String(reset.hours))
          : i18nService.t('mePanelResetInDays').replace('{n}', String(reset.n));

  // Current subscription tier for the weekly-grant badge (same resolution
  // as the plan card): active paid tier, or ID.Free when not subscribed.
  const subscribed = isMeEffectivelySubscribed(snapshot.subscription);
  const activePlanId = meActivePlanId(snapshot.subscription);
  const currentPlan = subscribed
    ? snapshot.plans.find((plan) => plan.planId === activePlanId || plan.tier === activePlanId)
      ?? snapshot.plans.find((plan) => plan.tier === snapshot.subscription?.raw?.tier)
      ?? null
    : snapshot.plans.find((plan) => plan.tier === 'free') ?? null;

  return (
    <div className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface/60 p-3.5">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-claude-surfaceInset/50 dark:bg-claude-darkSurfaceInset/40 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('mePanelWeekly')}
            <span className="rounded-full bg-claude-accent/10 px-2 py-0.5 text-[10px] font-medium text-claude-accent dark:text-claude-darkAccent">
              {meTierDisplayName(currentPlan, activePlanId || 'free')}
            </span>
            {onRefresh ? (
              <button
                type="button"
                aria-label={i18nService.t('freeQuotaRefresh')}
                title={i18nService.t('freeQuotaRefresh')}
                onClick={onRefresh}
                className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[var(--shape-radius-sm)] text-claude-textSecondary hover:bg-claude-surfaceHover hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText transition-colors"
              >
                <ArrowPathIcon className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            ) : null}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-claude-text dark:text-claude-darkText">
            {balance ? `${formatMe(remainingMe)} / ${formatMe(grantMe)}` : '—'}
            <span className="ml-1 text-[10px] font-normal text-claude-textSecondary">ME</span>
          </p>
          <p className="mt-0.5 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{resetLine}</p>
        </div>
        <div className="rounded-xl bg-claude-surfaceInset/50 dark:bg-claude-darkSurfaceInset/40 px-3 py-2.5">
          <p className="flex min-h-[19px] items-center text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('meUsagePersistent')}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-claude-text dark:text-claude-darkText">
            {balance ? formatMe(packTotalMe) : '—'}
            <span className="ml-1 text-[10px] font-normal text-claude-textSecondary">ME</span>
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary">
            <span>{i18nService.t('mePanelTopup')} {balance ? formatMe(topupMe) : '—'} ME</span>
            <span>{i18nService.t('mePanelBonus')}{i18nService.getLanguage() === 'zh' ? '：' : ': '}{balance ? formatMe(bonusMe) : '—'} ME</span>
            <span>{i18nService.t('mePanelEarned')} {balance ? formatMe(earnedMe) : '—'} ME</span>
          </p>
        </div>
      </div>
      {/* OWNER 2026-11-16 00:29: action buttons (buy credits / refresh) live
          at the card's bottom-right, after the weekly-reset note line. */}
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-claude-border/50 dark:border-claude-darkBorder/50 pt-3.5"> {/* OWNER 01:08: buy button vertically centered between the divider and the card bottom edge */}
        <p className="text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {note ?? i18nService.t('mePanelNote')}
        </p>
        {footer ? <div className="flex shrink-0 items-center gap-2">{footer}</div> : null}
      </div>
    </div>
  );
};

export default MeBalanceOverviewCard;
