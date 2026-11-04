import { t } from '../../i18n';
import {
  formatMe,
  meFromMilli,
  mePaidPlans,
  type MobileMePlan,
} from '../me/mePointsStore';

/**
 * Three-tier sales cards (S9 §2.1/§6): mobile/cloud price per month and the
 * weekly ME allowance, both read from /v1/me/plans at runtime. The middle
 * server-sorted tier carries the recommendation badge — no tier id is
 * hardcoded, so a backend reshuffle moves the badge with it.
 */
export function MeTierCards(props: {
  plans: readonly MobileMePlan[];
  loading: boolean;
  error: string | null;
  activePlanId: string;
  selectedPlanId: string;
  onChoose: (planId: string) => void;
  onRetry: () => void;
}): JSX.Element | null {
  const paid = mePaidPlans(props.plans);
  if (!props.loading && paid.length === 0) {
    return (
      <section className="twin-panel twin-panel-padded" data-testid="me-tiers-empty">
        <p className="text-sm text-[var(--text-secondary)]">{t('mobile.me.points.tiersUnavailable')}</p>
        <button type="button" onClick={props.onRetry} className="twin-button twin-button-ghost twin-button-small mt-2">
          {t('mobile.common.retry')}
        </button>
      </section>
    );
  }
  const recommendedId = paid.length > 1 ? paid[Math.min(1, paid.length - 1)].planId : paid[0]?.planId ?? '';
  return (
    <section className="me-tiers" data-testid="me-tier-cards">
      <div className="me-tiers-head">
        <h2 className="me-tiers-title">{t('mobile.me.points.tiersTitle')}</h2>
        <span className="me-tiers-note">{t('mobile.me.points.tiersNote')}</span>
      </div>
      <div className="me-tier-grid">
        {paid.map((plan) => {
          const weekly = plan.weeklyAmountMilli ? formatMe(meFromMilli(plan.weeklyAmountMilli)) : '';
          const isRecommended = plan.planId === recommendedId;
          const isCurrent = plan.planId === props.activePlanId;
          const isSelected = plan.planId === props.selectedPlanId;
          return (
            <button
              key={plan.planId}
              type="button"
              data-testid={`me-tier-${plan.planId}`}
              data-recommended={isRecommended ? 'true' : undefined}
              onClick={() => props.onChoose(plan.planId)}
              className={[
                'me-tier-card',
                isRecommended ? 'me-tier-card-featured' : '',
                isSelected ? 'me-tier-card-selected' : '',
              ].filter(Boolean).join(' ')}
            >
              {isRecommended ? (
                <span className="me-tier-badge">{t('mobile.me.points.tierRecommended')}</span>
              ) : null}
              <span className="me-tier-name">{plan.name}</span>
              <span className="me-tier-price">
                <span className="me-tier-currency">¥</span>
                {typeof plan.priceCny === 'number' ? plan.priceCny : '—'}
              </span>
              <span className="me-tier-period">{t('mobile.me.points.tierPerMonth')}</span>
              {weekly ? (
                <span className="me-tier-weekly">{t('mobile.me.points.tierWeekly', { me: weekly })}</span>
              ) : null}
              {isCurrent ? <span className="me-tier-current">{t('mobile.me.points.tierCurrent')}</span> : null}
            </button>
          );
        })}
      </div>
      <p className="me-tiers-foot">{t('mobile.me.points.tiersFoot')}</p>
    </section>
  );
}
