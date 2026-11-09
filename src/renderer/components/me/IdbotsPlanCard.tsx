import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { MePlanInfo } from '../../types/electron';
import {
  ensureMeSnapshot,
  formatMe,
  getMeSnapshot,
  isMeEffectivelySubscribed,
  meActivePlanId,
  meFromMilli,
  meResetParts,
  requestOpenMePurchase,
  requestOpenUsagePage,
  subscribeMeSnapshot,
} from './mePointsStore';

const TIER_NAMES: Record<string, string> = {
  free: 'ID.Free',
  standard: 'ID.Pupil',
  pro: 'ID.Student',
  max: 'ID.Scholar',
};

interface IdbotsPlanCardProps {
  /**
   * Optional upgrade handler override. Default opens the shared floating
   * purchase modal; the user-profile card passes its own handler so the
   * button opens the in-card level-2 plans page instead (页面嵌套定版
   * 2026-11-09) — the card is the SAME component everywhere, only the
   * upgrade door is host-owned.
   */
  onUpgrade?: () => void;
}

const tierName = (plan: MePlanInfo | null, fallbackId: string): string => {
  const key = (plan?.tier || fallbackId).replace(/^me_/, '');
  return TIER_NAMES[key] || plan?.nameEn || plan?.name || fallbackId || TIER_NAMES.free;
};

// Shared with the usage page's current-tier badge (single naming source).
export const meTierDisplayName = tierName;

const IdbotsPlanCard: React.FC<IdbotsPlanCardProps> = ({ onUpgrade }) => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    ensureMeSnapshot();
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await window.electron.mePoints.getBalance({ forceRefresh: true }).catch(() => null);
    ensureMeSnapshot();
    setRefreshing(false);
  }, []);

  const balance = snapshot.balance;
  const weekly = balance?.weeklyGrant;
  const grantMe = meFromMilli(weekly?.amountMilli);
  const remainingMe = meFromMilli(weekly?.remainingMilli);
  const totalMe = meFromMilli(balance?.totalAvailable);
  const reset = weekly ? meResetParts(weekly.nextResetAt) : null;
  const subscribed = isMeEffectivelySubscribed(snapshot.subscription);
  const activePlanId = meActivePlanId(snapshot.subscription);
  const activePlan = subscribed
    ? snapshot.plans.find((plan) => plan.planId === activePlanId || plan.tier === activePlanId)
      ?? snapshot.plans.find((plan) => plan.tier === snapshot.subscription?.raw?.tier)
      ?? null
    : snapshot.plans.find((plan) => plan.tier === 'free') ?? null;
  const currentTier = tierName(activePlan, activePlanId);
  const grantRatio = grantMe > 0 ? Math.max(0, Math.min(100, (remainingMe / grantMe) * 100)) : 0;
  const runningLow = grantMe > 0 && remainingMe / grantMe < 0.2;
  const resetLine = !reset
    ? ''
    : reset.unit === 'soon'
      ? i18nService.t('mePanelResetSoon')
      : reset.unit === 'hours'
        ? i18nService.t('mePlanResetIn').replace('{n}', String(reset.n))
        : i18nService.t('mePlanResetInDays').replace('{n}', String(reset.n));

  return (
    <section className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 p-3.5" aria-label={i18nService.t('mePlanTitle')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('mePlanCurrentTierLabel')}
          </p>
          <p className="mt-1 text-xl font-semibold tracking-tight text-claude-text dark:text-claude-darkText">
            {currentTier}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          title={i18nService.t('mePanelRefresh')}
          aria-label={i18nService.t('mePanelRefresh')}
          className="shrink-0 rounded-lg p-1.5 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-4 w-4 ${refreshing || snapshot.balanceLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('mePanelTotal')}
        </span>
        <span className="text-lg font-semibold tabular-nums text-claude-text dark:text-claude-darkText">
          {balance ? formatMe(totalMe) : '—'}
          <span className="ml-1 text-[10px] font-normal text-claude-textSecondary dark:text-claude-darkTextSecondary">ME</span>
        </span>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('mePlanThisWeek')}
          </span>
          <span className="tabular-nums text-claude-text dark:text-claude-darkText">
            {balance ? `${formatMe(remainingMe)} / ${formatMe(grantMe)} ME` : '—'}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-claude-border dark:bg-claude-darkBorder">
          <div
            className={`h-full rounded-full transition-all ${runningLow ? 'bg-amber-500' : 'bg-claude-accent'}`}
            style={{ width: `${grantRatio}%` }}
          />
        </div>
        {resetLine && (
          <p className="mt-1 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{resetLine}</p>
        )}
      </div>

      <button
        type="button"
        onClick={onUpgrade ?? (() => requestOpenMePurchase('subscribe'))}
        className="btn-idchat-primary-filled mt-4 inline-flex w-full items-center justify-center rounded-xl px-3 py-2 text-xs font-medium"
      >
        {i18nService.t('mePlanUpgrade')}
        <ChevronRightIcon className="ml-1 h-3.5 w-3.5" />
      </button>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-claude-border/50 dark:border-claude-darkBorder/50 pt-2.5">
        <p className="text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('mePlanComplianceLine')}
        </p>
        <button
          type="button"
          onClick={() => requestOpenUsagePage()}
          className="shrink-0 text-[11px] text-claude-accent dark:text-claude-darkAccent hover:underline"
        >
          {i18nService.t('mePanelUsageLink')}
        </button>
      </div>
    </section>
  );
};

export default IdbotsPlanCard;
