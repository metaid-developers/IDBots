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
import { meTierDisplayName } from './IdbotsPlanCard';

const MeBalanceOverviewCard: React.FC<{ note?: string }> = ({ note }) => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);

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
          </p>
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
        {note ?? i18nService.t('mePanelNote')}
      </p>
    </div>
  );
};

export default MeBalanceOverviewCard;
