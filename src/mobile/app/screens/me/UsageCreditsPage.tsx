import { ArrowLeftIcon, ArrowPathIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useState } from 'react';
import { mePaymentPhase } from '@/components/me/mePayment';
import { t } from '../../../i18n';
import { getMobileElectron } from '../../appBridge';
import {
  formatMe,
  formatMeRate,
  formatMeSigned,
  meFromMilli,
  meResetParts,
  meSpendableMilli,
  refreshMeBalance,
  refreshMeCatalog,
  refreshMeHistory,
  refreshMeTopupOrders,
  useMeStore,
  type MobileMeHistoryEntry,
  type MobileMeTopupOrder,
} from '../../me/mePointsStore';

type HistoryFilter = 'all' | 'grant' | 'spend' | 'topup' | 'earned';
type SubscriptionOrder = NonNullable<
  Awaited<ReturnType<Window['electron']['mePoints']['getSubscriptionOrders']>>['orders']
>[number];
type PurchaseOrder = MobileMeTopupOrder | SubscriptionOrder;

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
    case 'created':
    case 'submitted':
    case 'pending':
      return t('mobile.me.usage.statusSubmitted');
    case 'confirmed':
    case 'credited':
    case 'active':
    case 'completed':
    case 'succeeded':
      return t('mobile.me.usage.statusConfirmed');
    case 'closed':
    case 'expired':
    case 'failed':
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

function OrderRow(props: {
  order: PurchaseOrder;
  kind: 'subscribe' | 'topup';
  canResume: boolean;
  onResume?: (section: 'subscribe' | 'topup', subjectId: string, orderId: string) => void;
}): JSX.Element {
  const { order, kind } = props;
  const subjectId = kind === 'subscribe'
    ? (order as SubscriptionOrder).planId
    : (order as MobileMeTopupOrder).packageId;
  const detail = kind === 'subscribe'
    ? [subjectId, (order as SubscriptionOrder).period].filter(Boolean).join(' · ')
    : [
        subjectId,
        (order as MobileMeTopupOrder).meMilli
          ? t('mobile.me.usage.orderMe', { me: formatMe(meFromMilli((order as MobileMeTopupOrder).meMilli)) })
          : '',
      ].filter(Boolean).join(' · ');
  const amount = order.payAmount
    ?? ('amountCny' in order ? order.amountCny : undefined)
    ?? ('priceCny' in order ? order.priceCny : undefined);
  const rejected = mePaymentPhase(order.status) === 'closed';
  const pending = mePaymentPhase(order.status) === 'pending';
  return (
    <div className="me-order-row" data-testid="usage-order-row" data-kind={kind} data-status={order.status}>
      <div className="me-order-main">
        <span className="me-order-kind">{t(`mobile.me.usage.orderKind.${kind}`)}</span>
        <span className="me-order-id">{order.orderId}</span>
        <span className="me-order-meta">
          {detail}
          {typeof amount === 'number' ? ` · ¥${amount}` : ''}
        </span>
        {order.createdAt ? <span className="me-order-time">{timeLabel(order.createdAt)}</span> : null}
        {rejected && order.rejectReason ? (
          <span className="me-order-reject">{t('mobile.me.usage.rejectReason', { reason: order.rejectReason })}</span>
        ) : null}
        {pending && props.canResume && props.onResume ? (
          <button
            type="button"
            className="me-order-resume"
            data-testid={`usage-resume-${order.orderId}`}
            onClick={() => props.onResume?.(kind, subjectId, order.orderId)}
          >
            {t('mobile.me.usage.resumePayment')}
          </button>
        ) : null}
      </div>
      <span className={rejected ? 'me-order-status me-order-status-bad' : 'me-order-status'}>{statusLabel(order.status)}</span>
    </div>
  );
}

export function UsageCreditsPage(props: {
  onBack: () => void;
  canPurchase?: boolean;
  onResumeOrder?: (section: 'subscribe' | 'topup', subjectId: string, orderId: string) => void;
}): JSX.Element {
  const snapshot = useMeStore();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [ratesOpen, setRatesOpen] = useState(false);
  const [subscriptionOrders, setSubscriptionOrders] = useState<SubscriptionOrder[]>([]);
  const [subscriptionOrdersLoading, setSubscriptionOrdersLoading] = useState(false);
  const [subscriptionOrdersError, setSubscriptionOrdersError] = useState('');
  const balance = snapshot.balance;
  const weekly = balance?.weeklyGrant ?? null;
  const total = balance ? meFromMilli(meSpendableMilli(balance)) : null;

  const loadSubscriptionOrders = useCallback(async () => {
    setSubscriptionOrdersLoading(true);
    setSubscriptionOrdersError('');
    try {
      const result = await getMobileElectron().mePoints.getSubscriptionOrders();
      if (!result.success) throw new Error(result.error || t('mobile.me.usage.ordersUnavailable'));
      setSubscriptionOrders(Array.isArray(result.orders) ? result.orders : []);
    } catch (error) {
      setSubscriptionOrdersError(error instanceof Error ? error.message : t('mobile.me.usage.ordersUnavailable'));
    } finally {
      setSubscriptionOrdersLoading(false);
    }
  }, []);

  const loadAll = useCallback(() => {
    void refreshMeBalance();
    void refreshMeCatalog();
    void refreshMeTopupOrders();
    void refreshMeHistory({ reset: true, type: filter === 'all' ? undefined : filter });
    void loadSubscriptionOrders();
  }, [filter, loadSubscriptionOrders]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  return (
    <div className="twin-page h-full" data-testid="me-page-usage">
      <div className="twin-topbar twin-topbar-simple shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}>
        <button type="button" onClick={props.onBack} className="me-back" aria-label={t('mobile.common.back')} data-testid="me-secondary-back">
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
              <span className="me-ledger-value">{weekly ? formatMe(meFromMilli(weekly.remainingMilli)) : '—'}</span>
              {weekly ? <span className="me-ledger-sub">{`/ ${formatMe(meFromMilli(weekly.amountMilli))}`}</span> : null}
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

        <section className="twin-panel twin-panel-padded" data-testid="usage-unified">
          <h2 className="me-usage-title">{t('mobile.me.usage.unifiedTitle')}</h2>
          <p className="me-gate-body mt-1">{t('mobile.me.usage.unifiedBody')}</p>
          <div className="me-unified-grid">
            {(['officialLlm', 'cerebellum', 'chainTraffic'] as const).map((item) => (
              <div key={item} className="me-unified-item">
                <span className="me-unified-dot" aria-hidden />
                <span>{t(`mobile.me.usage.unified.${item}`)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="twin-panel twin-panel-padded" data-testid="usage-history">
          <div className="me-usage-head">
            <h2 className="me-usage-title">{t('mobile.me.usage.historyTitle')}</h2>
            <span className="me-usage-count">{snapshot.history.length}</span>
          </div>
          <div className="me-filter-row">
            {FILTERS.map((item) => (
              <button key={item.id} type="button" onClick={() => setFilter(item.id)} className={filter === item.id ? 'me-filter me-filter-active' : 'me-filter'}>
                {t(item.labelKey)}
              </button>
            ))}
          </div>
          <div className="me-history-list">
            {snapshot.history.map((entry) => <HistoryRow key={entry.id} entry={entry} />)}
            {!snapshot.history.length ? (
              <p className="me-empty" data-testid="usage-history-empty">
                {snapshot.historyLoading ? t('mobile.common.loading') : t('mobile.me.usage.historyEmpty')}
              </p>
            ) : null}
          </div>
          {snapshot.historyError ? <p className="me-inline-error">{snapshot.historyError}</p> : null}
          {snapshot.historyNextCursor ? (
            <button type="button" className="me-more" onClick={() => void refreshMeHistory({ type: filter === 'all' ? undefined : filter })}>
              {snapshot.historyLoading ? t('mobile.common.loading') : t('mobile.me.usage.loadMore')}
            </button>
          ) : null}
        </section>

        <section className="twin-panel twin-panel-padded" data-testid="usage-orders">
          <div className="me-usage-head">
            <h2 className="me-usage-title">{t('mobile.me.usage.ordersTitle')}</h2>
            <span className="me-usage-count">{snapshot.orders.length + subscriptionOrders.length}</span>
          </div>
          <div className="me-order-list">
            {subscriptionOrders.map((order) => (
              <OrderRow key={`subscribe-${order.orderId}`} order={order} kind="subscribe" canResume={props.canPurchase !== false} onResume={props.onResumeOrder} />
            ))}
            {snapshot.orders.map((order) => (
              <OrderRow key={`topup-${order.orderId}`} order={order} kind="topup" canResume={props.canPurchase !== false} onResume={props.onResumeOrder} />
            ))}
            {!snapshot.orders.length && !subscriptionOrders.length ? (
              <p className="me-empty">
                {snapshot.ordersLoading || subscriptionOrdersLoading ? t('mobile.common.loading') : t('mobile.me.usage.ordersEmpty')}
              </p>
            ) : null}
          </div>
          {snapshot.ordersError || subscriptionOrdersError ? (
            <p className="me-inline-error">{snapshot.ordersError || subscriptionOrdersError}</p>
          ) : null}
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
