import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import {
  ensureMeSnapshot,
  formatMe,
  getMeSnapshot,
  invalidateMeSnapshot,
  isMeBalanceLow,
  isMeEffectivelySubscribed,
  meFromMilli,
  meResetParts,
  requestMeBalance,
  requestOpenUsagePage,
  subscribeMeSnapshot,
} from '../../components/me/mePointsStore';
import { formatUserProfileCount, formatUserProfileFrozen, useUserProfileCopy } from './i18n';
import { openUserProfilePlansPage } from './userProfileStore';

/**
 * The ME credits panel, IN the profile page (owner ruling 2026-11-09 10:05: the
 * interaction moves from a popover to a page).
 *
 * This is the old sidebar-footer popover's content, laid out for a page instead
 * of a 300 px tray: total available (with the frozen note), the weekly grant
 * with its reset countdown, the three persistent pools, the plan/upgrade and
 * top-up entries, and the usage-details door.
 *
 * No new service call and no new endpoint: every number is read from the one
 * shared snapshot store (`components/me/mePointsStore`), and every action
 * routes inside the page — the plan/upgrade and top-up entries open the
 * level-2 plans page of the SAME card (`openUserProfilePlansPage`, 页面嵌套
 * 定版 2026-11-09), and the usage door keeps the existing
 * `requestOpenUsagePage` → Settings › 用量 & 积分 routing.
 */
const MeCreditsPanel: React.FC = () => {
  const copy = useUserProfileCopy();
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    ensureMeSnapshot();
    // Same light freshness loop the badge keeps: the main process caches the
    // balance for 30 s, a 60 s poll keeps the page honest.
    const handle = setInterval(() => {
      void requestMeBalance({ ttlMs: 55_000 });
    }, 60_000);
    return () => clearInterval(handle);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    invalidateMeSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 600));
    setRefreshing(false);
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
  const upgraded = isMeEffectivelySubscribed(snapshot.subscription);
  const isTopupAllowed = upgraded; // PRD §2.2: the free tier must NOT see a recharge entry.

  const reset = weekly ? meResetParts(weekly.nextResetAt) : null;
  const resetLine = !reset
    ? ''
    : reset.unit === 'soon'
      ? copy.meResetSoon
      : reset.unit === 'hours'
        ? formatUserProfileCount(copy.meResetInHours, reset.n)
        : formatUserProfileCount(copy.meResetInDays, reset.n);

  const grantRatio = grantMe > 0 ? Math.max(0, Math.min(100, (remainingMe / grantMe) * 100)) : 0;

  return (
    <section data-slot="user-profile-me" className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">{copy.meSectionTitle}</h3>
        <button
          type="button"
          onClick={handleRefresh}
          title={copy.meRefresh}
          aria-label={copy.meRefresh}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
        >
          <ArrowPathIcon className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {unavailable ? (
        <p className="rounded-xl border border-claude-border/60 px-3 py-3 text-xs leading-relaxed text-claude-textSecondary dark:border-claude-darkBorder/60 dark:text-claude-darkTextSecondary">
          {copy.meLoadFailed}
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-claude-border/60 bg-claude-surfaceInset/60 px-4 py-3 dark:border-claude-darkBorder/60 dark:bg-claude-darkSurfaceInset/40">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">{copy.meTotal}</span>
              <span className="text-2xl font-semibold tabular-nums text-claude-text dark:text-claude-darkText">
                {loading ? '…' : formatMe(totalMe)}
                <span className="ml-1 text-xs font-normal text-claude-textSecondary dark:text-claude-darkTextSecondary">ME</span>
              </span>
            </div>
            {balance && balance.frozenMilli > 0 ? (
              <p className="mt-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {formatUserProfileFrozen(copy, formatMe(meFromMilli(balance.frozenMilli)))}
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-claude-border/60 px-4 py-3 dark:border-claude-darkBorder/60">
            <div className="flex items-center justify-between text-xs">
              <span className="text-claude-textSecondary dark:text-claude-darkTextSecondary">{copy.meWeekly}</span>
              <span className="tabular-nums text-claude-text dark:text-claude-darkText">
                {formatMe(remainingMe)} / {formatMe(grantMe)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-claude-border dark:bg-claude-darkBorder">
              <div
                className={`h-full rounded-full transition-all ${low ? 'bg-amber-500' : 'bg-claude-accent'}`}
                style={{ width: `${grantRatio}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{resetLine}</p>

            <dl className="mt-3 space-y-1.5 border-t border-claude-border/50 pt-2.5 dark:border-claude-darkBorder/50">
              {[
                { key: 'topup', label: copy.meTopup, value: balance?.persistent?.topupMilli },
                { key: 'bonus', label: copy.meBonus, value: balance?.persistent?.bonusMilli },
                { key: 'earned', label: copy.meEarned, value: balance?.persistent?.earnedMilli },
              ].map((row) => (
                <div key={row.key} data-slot="user-profile-me-pool" data-pool={row.key} className="flex items-center justify-between text-xs">
                  <dt className="text-claude-textSecondary dark:text-claude-darkTextSecondary">{row.label}</dt>
                  <dd className="tabular-nums text-claude-text dark:text-claude-darkText">{formatMe(meFromMilli(row.value))}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className={`flex ${isTopupAllowed ? 'gap-2' : ''}`}>
            <button
              type="button"
              onClick={() => openUserProfilePlansPage('subscribe')}
              data-slot="user-profile-me-upgrade"
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                isTopupAllowed
                  ? 'border border-claude-border text-claude-text hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkText dark:hover:bg-claude-darkSurfaceHover'
                  : 'btn-idchat-primary-filled'
              }`}
            >
              {copy.meUpgrade}
            </button>
            {isTopupAllowed ? (
              <button
                type="button"
                onClick={() => openUserProfilePlansPage('topup')}
                data-slot="user-profile-me-recharge"
                className="btn-idchat-primary-filled flex-1 rounded-lg px-3 py-2 text-xs font-medium"
              >
                {copy.meRecharge}
              </button>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => requestOpenUsagePage()}
            data-slot="user-profile-me-usage"
            className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-xs text-claude-accent transition-colors hover:underline dark:text-claude-darkAccent"
          >
            <span>{copy.meUsage}</span>
            <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
          </button>

          <p className="text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">{copy.meNote}</p>
        </>
      )}
    </section>
  );
};

export default MeCreditsPanel;
