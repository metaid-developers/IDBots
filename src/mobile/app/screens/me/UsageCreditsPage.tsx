import { ArrowLeftIcon, ArrowPathIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useState } from 'react';
import { t } from '../../../i18n';
import {
  formatMe,
  formatMeRate,
  formatMeSigned,
  meFromMilli,
  meResetParts,
  refreshMeBalance,
  refreshMeCatalog,
  refreshMeHistory,
  refreshMeTopupOrders,
  useMeStore,
  type MobileMeHistoryEntry,
  type MobileMeTopupOrder,
} from '../../me/mePointsStore';

/**
 * Usage & credits (S9 §3.2) - the merged page that replaces the old traffic page:
 * balance snapshot + ME ledger history + topup order states + multiplier notes.
 * No token, traffic-MB or cerebellum-quota vocabulary survives here.
 */

type HistoryFilter = 'all' | 'grant' | 'spend' | 'topup' | 'earned';

const FILTERS: ReadonlyArray<{ id: HistoryFilter; labelKey: string }> = [
  { id: 'all', labelKey: 'mobile.me.usage.all' },
  { id: 'grant', labelKey: 'mobile.me.usage.typeGrant' },
  { id: 'spend', labelKey: 'mobile.me.usage.typeSpend' },
  { id: 'topup', labelKey: 'mobile.me.usage.typeTopup' },
  { id: 'earned', labelKey: 'mobile.me.usage.typeEarned' },
];

function typeLabel(type: string): string {
  switch (type.toLowerCase()) {
    case 'grant':
      return t('mobile.me.usage.typeGrant');
    case 'spend':
    case 'burn':
      return t('mobile.me.usage.typeSpend');
    case 'topup':
      return t('mobile.me.usage.typeTopup');
    case 'bonus':
      return t('mobile.me.usage.typeBonus');
    case 'earned':
      return t('mobile.me.usage.typeEarned');
    default:
      return t('mobile.me.usage.typeOther');
  }
}

function statusLabel(status: string): string {
  switch (status.toLowerCase()) {
    case 'submitted':
    case 'pending':
      return t('mobile.me.usage.statusSubmitted');
    case 'confirmed':
    case 'credited':
      return t('mobile.me.usage.statusConfirmed');
    case 'rejected':
      return t('mobile.me.usage.statusRejected');
    default:
      return status;
  }
}

function timeLabel(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return '';
  const ms = value > 1e12 ? value : value * 1000;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

function resetLabel(nextResetAt: number | undefined): string {
  const parts = meResetParts(nextResetAt);
  if (!parts) return '';
  if (parts.unit === 'soon') return t('mobile.me.points.resetSoon');
  if (parts.unit === 'hours') return t('mobile.me.points.resetHours', { n: parts.n });
  return t('mobile.me.points.resetDays', { n: parts.n });
}

function HistoryRow(props: { entry: MobileMeHistoryEntry }): JSX.Element {
  const amountMe = formatMeSigned(props.entry.amountMilli);
  const negative = (props.entry.amountMilli ?? 0) < 0;
  const reason = props.entry.reason || props.entry.refType || '';
  return (
    <div className="me-history-row" data-testid="usage-history-row">
      <div className="me-history-main">
        <span className="me-history-type">{typeLabel(props.entry.type)}</span>
        {reason ? <span className="me-history-reason">{reason}</span> : null}
        {props.entry.createdAt ? <span className="me-history-time">{timeLabel(props.entry.createdAt)}</span> : null}
      </div>
      <div className="me-history-side">
        <span className={negative ? 'me-history-amount me-history-out' : 'me-history-amount me-history-in'}>
          {amountMe}
        </span>
        {typeof props.entry.balanceAfterMilli === 'number' ? (
          <span className="me-history-after">
            {t('mobile.me.usage.ledgerAfter', { me: formatMe(meFromMilli(props.entry.balanceAfterMilli)) })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function OrderRow(props: { order: MobileMeTopupOrder }): JSX.Element {
  const me = props.order.meMilli ? formatMe(meFromMilli(props.order.meMilli)) : '';
  const status = statusLabel(props.order.status);
  const rejected = props.order.status.toLowerCase() === 'rejected';
  return (
    <div className="me-order-row" data-testid="usage-order-row" data-status={props.order.status}>
      <div className="me-order-main">
        <span className="me-order-id">{props.order.orderId}</span>
        <span className="me-order-meta">
          {props.order.packageId}
          {me ? ` · ${t('mobile.me.usage.orderMe', { me })}` : ''}
          {typeof props.order.priceCny === 'number' ? ` · ¥${props.order.priceCny}` : ''}
        </span>
        {props.order.createdAt ? <span className="me-order-time">{timeLabel(props.order.createdAt)}</span> : null}
        {rejected && props.order.rejectReason ? (
          <span className="me-order-reject">{t('mobile.me.usage.rejectReason', { reason: props.order.rejectReason })}</span>
        ) : null}
      </div>
      <span className={rejected ? 'me-order-status me-order-status-bad' : 'me-order-status'}>{status}</span>
    </div>
  );
}

export function UsageCreditsPage(props: { onBack: () => void }): JSX.Element {
  const snapshot = useMeStore();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [ratesOpen, setRatesOpen] = useState(false);
  const balance = snapshot.balance;
  const weekly = balance?.weeklyGrant ?? null;
  const total = balance ? meFromMilli(balance.totalAvailable) : null;

  const loadAll = useCallback(() => {
    void refreshMeBalance();
    void refreshMeCatalog();
    void refreshMeTopupOrders();
    void refreshMeHistory({ reset: true, type: filter === 'all' ? undefined : filter });
  }, [filter]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  return (
    <div className="twin-page h-full" data-testid="me-page-usage">
      <div
        className="twin-topbar twin-topbar-simple shrink-0"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}
      >
        <button
          type="button"
          onClick={props.onBack}
          className="me-back"
          aria-label={t('mobile.common.back')}
          data-testid="me-secondary-back"
        >
          <ArrowLeftIcon className="h-5 w-5" aria-hidden />
          <span>{t('mobile.me.usage.title')}</span>
        </button>
        <button type="button" className="me-hero-refresh me-refresh-light" aria-label={t('mobile.common.retry')} onClick={loadAll}>
          <ArrowPathIcon className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="twin-scroll space-y-3 p-3">
        <section className="twin-panel twin-panel-padded">
          <div className="me-summary-head">
            <span className="me-summary-label">{t('mobile.me.usage.balanceTitle')}</span>
            <span className="me-summary-total">
              {total === null ? '—' : formatMe(total)}
              <span className="me-summary-unit"> ME</span>
            </span>
          </div>
          <div className="me-ledger me-ledger-light">
            <div className="me-ledger-cell">
              <span className="me-ledger-label">{t('mobile.me.points.weekly')}</span>
              <span className="me-ledger-value">
                {weekly ? formatMe(meFromMilli(weekly.remainingMilli)) : '—'}
              </span>
              {weekly ? (
                <span className="me-ledger-sub">{`/ ${formatMe(meFromMilli(weekly.amountMilli))}`}</span>
              ) : null}
            </div>
            <div className="me-ledger-cell">
              <span className="me-ledger-label">{t('mobile.me.points.topup')}</span>
              <span className="me-ledger-value">{balance ? formatMe(meFromMilli(balance.persistent.topupMilli)) : '—'}</span>
            </div>
            <div className="me-ledger-cell">
              <span className="me-ledger-label">{t('mobile.me.points.bonus')}</span>
              <span className="me-ledger-value">{balance ? formatMe(meFromMilli(balance.persistent.bonusMilli)) : '—'}</span>
            </div>
            <div className="me-ledger-cell">
              <span className="me-ledger-label">{t('mobile.me.points.earned')}</span>
              <span className="me-ledger-value">{balance ? formatMe(meFromMilli(balance.persistent.earnedMilli)) : '—'}</span>
            </div>
          </div>
          {weekly ? <p className="me-summary-reset">{resetLabel(weekly.nextResetAt)}</p> : null}
          {snapshot.balanceError && !balance ? (
            <p className="twin-notice twin-notice-warning mt-2 text-xs">{t('mobile.me.points.loadFailed')}</p>
          ) : null}
        </section>

        <section className="twin-panel twin-panel-padded" data-testid="usage-history">
          <div className="me-usage-head">
            <h2 className="me-usage-title">{t('mobile.me.usage.historyTitle')}</h2>
            <span className="me-usage-count">{snapshot.history.length}</span>
          </div>
          <div className="me-filter-row">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={filter === item.id ? 'me-filter me-filter-active' : 'me-filter'}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
          <div className="me-history-list">
            {snapshot.history.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} />
            ))}
            {!snapshot.history.length ? (
              <p className="me-empty" data-testid="usage-history-empty">
                {snapshot.historyLoading ? t('mobile.common.loading') : t('mobile.me.usage.historyEmpty')}
              </p>
            ) : null}
          </div>
          {snapshot.historyError ? <p className="me-inline-error">{snapshot.historyError}</p> : null}
          {snapshot.historyNextCursor ? (
            <button
              type="button"
              className="me-more"
              onClick={() => void refreshMeHistory({ type: filter === 'all' ? undefined : filter })}
            >
              {snapshot.historyLoading ? t('mobile.common.loading') : t('mobile.me.usage.loadMore')}
            </button>
          ) : null}
        </section>

        <section className="twin-panel twin-panel-padded" data-testid="usage-orders">
          <div className="me-usage-head">
            <h2 className="me-usage-title">{t('mobile.me.usage.ordersTitle')}</h2>
            <span className="me-usage-count">{snapshot.orders.length}</span>
          </div>
          <div className="me-order-list">
            {snapshot.orders.map((order) => (
              <OrderRow key={order.orderId} order={order} />
            ))}
            {!snapshot.orders.length ? (
              <p className="me-empty">{snapshot.ordersLoading ? t('mobile.common.loading') : t('mobile.me.usage.ordersEmpty')}</p>
            ) : null}
          </div>
          {snapshot.ordersError ? <p className="me-inline-error">{snapshot.ordersError}</p> : null}
        </section>

        <section className="twin-panel twin-panel-padded" data-testid="usage-rates">
          <button type="button" className="me-fold" onClick={() => setRatesOpen((value) => !value)} aria-expanded={ratesOpen}>
            <span className="me-usage-title">{t('mobile.me.usage.ratesTitle')}</span>
            <ChevronDownIcon className={ratesOpen ? 'me-fold-icon me-fold-icon-open' : 'me-fold-icon'} aria-hidden />
          </button>
          {ratesOpen ? (
            <div className="me-rate-list">
              {snapshot.rates.map((rate) => (
                <div key={rate.key} className="me-rate-row">
                  <span className="me-rate-key">{rate.key}</span>
                  <span className="me-rate-value">{formatMeRate(rate.multiplier)}</span>
                </div>
              ))}
              {!snapshot.rates.length ? <p className="me-empty">{t('mobile.me.usage.ratesEmpty')}</p> : null}
              <p className="me-rate-note">{t('mobile.me.usage.ratesNote')}</p>
            </div>
          ) : null}
        </section>

        <section className="twin-panel twin-panel-padded" data-testid="usage-compliance">
          <h2 className="me-usage-title mb-2">{t('mobile.me.usage.complianceTitle')}</h2>
          <ul className="me-compliance-list">
            <li>{t('mobile.me.compliance.weekly')}</li>
            <li>{t('mobile.me.compliance.persistent')}</li>
            <li>{t('mobile.me.compliance.noCash')}</li>
            <li>{t('mobile.me.compliance.fallback')}</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
