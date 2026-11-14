import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import { MeCoinIcon } from './MeCoin';
import {
  formatMe,
  formatMeExpiryDate,
  meExpiryParts,
  meFromMilli,
  meResetParts,
  meSpendableMilli,
  meWeeklyUsedRatio,
  type MobileMeBalance,
  type MobileMePlan,
} from '../me/mePointsStore';

function resetLine(nextResetAt: number | null | undefined): string {
  const parts = meResetParts(nextResetAt);
  if (!parts) return '';
  if (parts.unit === 'soon') return t('mobile.me.points.resetSoon');
  if (parts.unit === 'hours') return t('mobile.me.points.resetHours', { n: parts.n });
  if (parts.hours > 0) return t('mobile.me.points.resetDaysHours', { n: parts.n, h: parts.hours });
  return t('mobile.me.points.resetDays', { n: parts.n });
}

function planLine(plan: MobileMePlan | null, subscribed: boolean): string {
  if (!plan) return subscribed ? t('mobile.me.points.planActive') : t('mobile.me.points.planFree');
  const weekly = plan.weeklyAmountMilli ? formatMe(meFromMilli(plan.weeklyAmountMilli)) : '';
  const name = plan.name || t('mobile.me.points.planFree');
  return weekly
    ? t('mobile.me.points.planWeekly', { plan: name, me: weekly })
    : name;
}

/**
 * Expiry line under the plan name (2026-11-11 hardening): the paid period's
 * end + time left, hour precision since 2026-11-13 (mirror of the desktop
 * plan card) — the days+hours countdown, or whole hours inside the last
 * day; warning color within a week, once the date is past. Renders only when
 * the server payload carries an expiry — never a guess.
 */
function expiryLine(expiryMs: number | null): { text: string; urgent: boolean } | null {
  const parts = meExpiryParts(expiryMs);
  if (!parts || expiryMs === null) return null;
  if (parts.unit === 'expired') {
    return { text: t('mobile.me.points.expiredOn', { date: formatMeExpiryDate(expiryMs) }), urgent: true };
  }
  if (parts.unit === 'hours') {
    return { text: t('mobile.me.points.expiresToday', { n: parts.n }), urgent: true };
  }
  return {
    text: t('mobile.me.points.expiresIn', { date: formatMeExpiryDate(expiryMs), n: parts.n, h: parts.hours }),
    urgent: parts.n <= 7,
  };
}

/**
 * The points hero: spendable ME, weekly progress, and the four ledger pools.
 */
export function MePointsHero(props: {
  balance: MobileMeBalance | null;
  loading: boolean;
  error: string | null;
  featureUnavailable: boolean;
  plan: MobileMePlan | null;
  subscribed: boolean;
  /** Subscription expiry (epoch ms) from the raw payload; null when absent. */
  expiryMs?: number | null;
  canPurchase: boolean;
  onUpgrade: () => void;
  onRecharge: () => void;
  onOpenUsage: () => void;
  onRetry: () => void;
}): JSX.Element {
  const { balance } = props;
  const weekly = balance?.weeklyGrant ?? null;
  const total = balance ? meFromMilli(meSpendableMilli(balance)) : null;
  const weeklyTotal = weekly ? meFromMilli(weekly.amountMilli) : 0;
  const weeklyRemaining = weekly ? meFromMilli(weekly.remainingMilli) : 0;
  const remainingRatio = weeklyTotal > 0 ? Math.min(1, Math.max(0, weeklyRemaining / weeklyTotal)) : 0;
  const usedRatio = meWeeklyUsedRatio(balance);
  const topup = balance ? meFromMilli(balance.persistent.topupMilli) : 0;
  const bonus = balance ? meFromMilli(balance.persistent.bonusMilli) : 0;
  const earned = balance ? meFromMilli(balance.persistent.earnedMilli) : 0;

  return (
    <section className="me-hero" data-testid="me-points-hero">
      <div className="me-hero-head">
        <span className="me-hero-kicker">
          <MeCoinIcon className="h-4 w-4" />
          {t('mobile.me.points.title')}
        </span>
        <button
          type="button"
          className="me-hero-refresh"
          aria-label={t('mobile.common.retry')}
          onClick={props.onRetry}
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {props.featureUnavailable ? (
        <p className="me-hero-empty" data-testid="me-points-unavailable">
          {t('mobile.me.points.unavailable')}
        </p>
      ) : (
        <>
          <p className="me-hero-amount" data-testid="me-points-total">
            {total === null ? (props.loading ? '…' : '—') : formatMe(total)}
          </p>
          <p className="me-hero-caption">{t('mobile.me.points.totalHint')}</p>

          <div className="me-hero-progress">
            <div className="me-hero-progress-head">
              <span>{t('mobile.me.points.thisWeekRemaining', { me: formatMe(weeklyRemaining) })}</span>
              <span className="me-hero-reset">{resetLine(weekly?.nextResetAt)}</span>
            </div>
            <div
              className="me-progress"
              role="progressbar"
              aria-label={t('mobile.me.points.weekly')}
              aria-valuemin={0}
              aria-valuemax={weeklyTotal}
              aria-valuenow={weeklyRemaining}
            >
              <span className="me-progress-fill" style={{ width: `${Math.round(remainingRatio * 100)}%` }} />
            </div>
            <p className="me-hero-used">
              {t('mobile.me.points.weeklyValue', {
                remaining: formatMe(weeklyRemaining),
                total: formatMe(weeklyTotal),
              })}
            </p>
          </div>

          <div className="me-ledger" data-testid="me-ledger-breakdown">
            <div className="me-ledger-cell">
              <span className="me-ledger-label">{t('mobile.me.points.weekly')}</span>
              <span className="me-ledger-value">{formatMe(weeklyRemaining)}</span>
            </div>
            <div className="me-ledger-cell">
              <span className="me-ledger-label">{t('mobile.me.points.topup')}</span>
              <span className="me-ledger-value">{formatMe(topup)}</span>
            </div>
            <div className="me-ledger-cell">
              <span className="me-ledger-label">{t('mobile.me.points.bonus')}</span>
              <span className="me-ledger-value">{formatMe(bonus)}</span>
            </div>
            <div className="me-ledger-cell">
              <span className="me-ledger-label">{t('mobile.me.points.earned')}</span>
              <span className="me-ledger-value">{formatMe(earned)}</span>
            </div>
          </div>
        </>
      )}

      {props.error && !balance ? (
        <div className="me-hero-error" data-testid="me-points-error">
          <p>{t('mobile.me.points.loadFailed')}</p>
          <button type="button" className="me-hero-error-action" onClick={props.onRetry}>
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : null}

      <div className="me-hero-plan">
        <span className="me-hero-plan-name">{planLine(props.plan, props.subscribed)}</span>
        {balance ? (
          <span className="me-hero-plan-used">
            {t('mobile.me.points.usedShare', { percent: Math.round(usedRatio * 100) })}
          </span>
        ) : null}
      </div>
      {props.subscribed && (() => {
        const line = expiryLine(props.expiryMs ?? null);
        return line ? (
          <p
            className="me-hero-plan-expiry"
            data-testid="me-points-expiry"
            style={line.urgent ? { color: 'var(--twin-warning)' } : undefined}
          >
            {line.text}
          </p>
        ) : null;
      })()}

      <div className="me-hero-actions">
        <button type="button" className="me-hero-button me-hero-button-primary" onClick={props.onUpgrade}>
          {props.subscribed ? t('mobile.me.points.renew') : t('mobile.me.points.upgrade')}
        </button>
        {props.subscribed && props.canPurchase ? (
          <button type="button" className="me-hero-button me-hero-button-ghost" onClick={props.onRecharge}>
            {t('mobile.me.points.recharge')}
          </button>
        ) : null}
      </div>
      {!props.subscribed ? (
        <p className="me-hero-lock" data-testid="me-topup-locked">
          {t('mobile.me.points.rechargeLocked')}
        </p>
      ) : null}

      <button type="button" className="me-hero-link" onClick={props.onOpenUsage} data-testid="me-usage-link">
        <span>
          <span className="me-hero-link-title">{t('mobile.me.points.usageEntry')}</span>
          <span className="me-hero-link-hint">{t('mobile.me.points.usageHint')}</span>
        </span>
        <ChevronRightIcon className="h-4 w-4" aria-hidden />
      </button>
    </section>
  );
}
