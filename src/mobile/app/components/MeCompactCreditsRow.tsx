import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import { MeCoinIcon } from './MeCoin';
import { formatMe, meFromMilli, type MobileMeBalance, type MobileMePlan } from '../me/mePointsStore';

export function MeCompactCreditsRow(props: {
  balance: MobileMeBalance | null;
  error: string | null;
  plan: MobileMePlan | null;
  subscribed: boolean;
  onOpen: () => void;
  onRetry: () => void;
}): JSX.Element {
  const weekly = props.balance?.weeklyGrant ?? null;
  const remaining = weekly ? formatMe(meFromMilli(weekly.remainingMilli)) : null;
  return (
    <section className="twin-panel" data-testid="me-compact-credits">
      <button type="button" className="twin-list-row" onClick={props.onOpen}>
        <span className="twin-list-leading"><MeCoinIcon className="h-5 w-5" /></span>
        <span className="twin-list-copy">
          <span className="twin-list-title">
            {props.plan?.name || t(props.subscribed ? 'mobile.me.points.planActive' : 'mobile.me.points.planFree')}
          </span>
          <span className="twin-list-subtitle">
            {remaining === null ? t('mobile.me.points.usageHint') : t('mobile.me.points.thisWeekRemaining', { me: remaining })}
          </span>
        </span>
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
      </button>
      {props.error && !props.balance ? (
        <div className="flex items-center justify-between gap-2 border-t border-[var(--border-color)] px-3 py-2" data-testid="me-points-error">
          <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.points.loadFailed')}</p>
          <button type="button" className="twin-icon-button" aria-label={t('mobile.common.retry')} onClick={props.onRetry}>
            <ArrowPathIcon className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </section>
  );
}
