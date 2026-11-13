import { ArrowLeftIcon, ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMeMoney, meCheckoutErrorKey, mePaymentPhase, type MePaymentCheckout } from '@/components/me/mePayment';
import { t } from '../../i18n';
import { getMobileElectron } from '../appBridge';
import { MeTierCards } from '../components/MeTierCards';
import { fetchMePaymentCheckout, mergeMePaymentCheckout } from '../me/meCheckout';
import {
  clearMeCheckoutRecovery,
  loadMeCheckoutRecovery,
  saveMeCheckoutRecovery,
} from '../me/meCheckoutRecovery';
import {
  buildMePurchaseOrderRequest,
  submitMePurchaseOrder,
  type MePaymentGateway,
} from '../me/purchaseSubmit';
import { QrCanvas } from './recharge/QrCanvas';
import {
  formatMe,
  invalidateMeBalance,
  isMePlanDowngrade,
  isMeSubscribed,
  meActivePlanId,
  meActiveTierKey,
  meFromMilli,
  mePaidPlans,
  mePeriodDays,
  mePeriodPrice,
  meTierRank,
  refreshMeCatalog,
  refreshMeSubscription,
  refreshMeTopupOrders,
  refreshMeTopupPackages,
  useMeStore,
  type MePeriod,
} from '../me/mePointsStore';

export type MePurchaseSection = 'subscribe' | 'topup';
type Phase = 'form' | 'submitting' | 'paying' | 'credited' | 'closed';

const PERIODS: ReadonlyArray<{ id: MePeriod; labelKey: string }> = [
  { id: 'month', labelKey: 'mobile.me.purchase.periodMonth' },
  { id: 'quarter', labelKey: 'mobile.me.purchase.periodQuarter' },
  { id: 'year', labelKey: 'mobile.me.purchase.periodYear' },
];
const GATEWAYS: ReadonlyArray<{ id: MePaymentGateway; labelKey: string }> = [
  { id: 'alipay', labelKey: 'mobile.me.purchase.gatewayAlipay' },
  { id: 'paypal', labelKey: 'mobile.me.purchase.gatewayPaypal' },
];
const POLL_INTERVAL_MS = 4_000;
const POLL_WINDOW_MS = 10 * 60_000;

export default function MePurchaseScreen(props: {
  section: MePurchaseSection;
  initialPlanId?: string;
  initialPackageId?: string;
  initialOrderId?: string;
  canPurchase: boolean;
  onClose: () => void;
  onSwitchSection: (section: MePurchaseSection) => void;
  onOpenUsage?: () => void;
  onSubmitted?: () => void;
}): JSX.Element {
  const snapshot = useMeStore();
  const [section, setSection] = useState<MePurchaseSection>(props.section);
  const [period, setPeriod] = useState<MePeriod>('month');
  const [gateway, setGateway] = useState<MePaymentGateway>('alipay');
  const [selectedPlanId, setSelectedPlanId] = useState(props.initialPlanId ?? '');
  const [selectedPackageId, setSelectedPackageId] = useState(props.initialPackageId ?? '');
  const [phase, setPhase] = useState<Phase>('form');
  const [checkout, setCheckout] = useState<MePaymentCheckout | null>(null);
  const [checking, setChecking] = useState(false);
  const [pollExpired, setPollExpired] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [upgradeConfirmOpen, setUpgradeConfirmOpen] = useState(false);
  const submittingRef = useRef(false);
  const onSubmittedRef = useRef(props.onSubmitted);
  onSubmittedRef.current = props.onSubmitted;

  const paidPlans = useMemo(() => mePaidPlans(snapshot.plans), [snapshot.plans]);
  const activePlanId = meActivePlanId(snapshot.subscription);
  const activeTierKey = meActiveTierKey(snapshot.subscription);
  const subscribed = isMeSubscribed(snapshot.subscription);
  const selectablePlans = useMemo(
    () => paidPlans.filter((plan) => !isMePlanDowngrade(activeTierKey, plan.tier)),
    [paidPlans, activeTierKey],
  );
  const preferredPlanId = selectablePlans.find((plan) => plan.planId === activePlanId || plan.tier === activeTierKey)?.planId
    ?? (subscribed ? selectablePlans[0]?.planId : selectablePlans[Math.min(1, Math.max(0, selectablePlans.length - 1))]?.planId)
    ?? '';
  const effectivePlanId = selectedPlanId && selectablePlans.some((plan) => plan.planId === selectedPlanId)
    ? selectedPlanId
    : preferredPlanId;
  const selectedPlan = paidPlans.find((plan) => plan.planId === effectivePlanId) ?? null;
  const selectedPackage = snapshot.topupPackages.find((pkg) => pkg.packageId === selectedPackageId)
    ?? snapshot.topupPackages[0]
    ?? null;
  const amountDue = section === 'subscribe'
    ? mePeriodPrice(selectedPlan, period)
    : (typeof selectedPackage?.priceCny === 'number' ? selectedPackage.priceCny : null);
  const days = mePeriodDays(selectedPlan, period);
  const isUpgrade = Boolean(
    subscribed
    && selectedPlan
    && meTierRank(activeTierKey) >= 0
    && meTierRank(selectedPlan.tier) > meTierRank(activeTierKey),
  );

  const finishCredited = useCallback((orderId: string) => {
    clearMeCheckoutRecovery(orderId);
    invalidateMeBalance();
    void refreshMeSubscription();
    void refreshMeTopupOrders();
    onSubmittedRef.current?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const nextSection = props.section;
    setSection(nextSection);
    setPhase('form');
    setCheckout(null);
    setSubmitError('');
    setErrorCode('');
    setUpgradeConfirmOpen(false);
    setPollExpired(false);
    setSelectedPlanId(props.initialPlanId ?? '');
    setSelectedPackageId(props.initialPackageId ?? '');
    setPeriod('month');
    setGateway('alipay');
    const stored = loadMeCheckoutRecovery();
    const recovery = props.initialOrderId
      ? {
          section: nextSection,
          orderId: props.initialOrderId,
          planId: props.initialPlanId,
          packageId: props.initialPackageId,
          period: 'month' as MePeriod,
          gateway: 'alipay' as MePaymentGateway,
          createdAt: Date.now(),
        }
      : stored?.section === nextSection
        ? stored
        : null;
    if (recovery) {
      setPeriod(recovery.period);
      setGateway(recovery.gateway);
      if (recovery.planId) setSelectedPlanId(recovery.planId);
      if (recovery.packageId) setSelectedPackageId(recovery.packageId);
      setPhase('paying');
      void fetchMePaymentCheckout({
        api: getMobileElectron().mePoints,
        section: recovery.section,
        orderId: recovery.orderId,
      }).then((next) => {
        if (cancelled) return;
        if (!next) {
          setPhase('form');
          setSubmitError(t('mobile.me.purchase.orderUnavailable'));
          return;
        }
        setCheckout(next);
        const orderPhase = mePaymentPhase(next.status);
        if (orderPhase === 'credited') {
          setPhase('credited');
          finishCredited(next.orderId);
        } else if (orderPhase === 'closed') {
          setPhase('closed');
          clearMeCheckoutRecovery(next.orderId);
        } else {
          setPhase('paying');
        }
      }).catch((error) => {
        if (cancelled) return;
        setPhase('form');
        setSubmitError(error instanceof Error ? error.message : t('mobile.me.purchase.orderUnavailable'));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [props.section, props.initialPlanId, props.initialPackageId, props.initialOrderId, finishCredited]);

  useEffect(() => {
    void refreshMeCatalog();
    void refreshMeSubscription();
    void refreshMeTopupPackages();
  }, []);

  useEffect(() => {
    setUpgradeConfirmOpen(false);
  }, [effectivePlanId, selectedPackageId, period, gateway]);

  const checkOrder = useCallback(async (showError = false) => {
    if (!checkout) return;
    if (showError) {
      setChecking(true);
      setSubmitError('');
    }
    try {
      const next = await fetchMePaymentCheckout({
        api: getMobileElectron().mePoints,
        section,
        orderId: checkout.orderId,
        fallbackAmount: amountDue ?? 0,
      });
      if (!next) {
        if (showError) setSubmitError(t('mobile.me.purchase.checkFailed'));
        return;
      }
      const merged = mergeMePaymentCheckout(checkout, next);
      setCheckout(merged);
      const orderPhase = mePaymentPhase(merged.status);
      if (orderPhase === 'credited') {
        setPhase('credited');
        finishCredited(merged.orderId);
      } else if (orderPhase === 'closed') {
        setPhase('closed');
        clearMeCheckoutRecovery(merged.orderId);
      }
    } catch (error) {
      if (showError) setSubmitError(error instanceof Error ? error.message : t('mobile.me.purchase.checkFailed'));
    } finally {
      if (showError) setChecking(false);
    }
  }, [checkout, section, amountDue, finishCredited]);

  const checkOrderRef = useRef(checkOrder);
  checkOrderRef.current = checkOrder;
  const checkoutOrderId = checkout?.orderId;
  useEffect(() => {
    if (phase !== 'paying' || !checkoutOrderId || pollExpired) return;
    const startedAt = Date.now();
    void checkOrderRef.current();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > POLL_WINDOW_MS) {
        window.clearInterval(timer);
        setPollExpired(true);
        return;
      }
      void checkOrderRef.current();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [phase, checkoutOrderId, pollExpired]);

  const openPayment = useCallback(async () => {
    const url = checkout?.approvalUrl || (/^https?:\/\//i.test(checkout?.qrCode ?? '') ? checkout?.qrCode : '');
    if (!url) return;
    try {
      const result = await getMobileElectron().shell.openExternal(url);
      if (result && typeof result === 'object' && 'success' in result && result.success === false) {
        throw new Error(result.error || t('mobile.me.purchase.openFailed'));
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('mobile.me.purchase.openFailed'));
    }
  }, [checkout]);

  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    if (section === 'subscribe' && isUpgrade && !upgradeConfirmOpen) {
      setUpgradeConfirmOpen(true);
      return;
    }
    const request = buildMePurchaseOrderRequest({
      section,
      planId: selectedPlan?.planId,
      packageId: selectedPackage?.packageId,
      period,
      periodDays: days,
      gateway,
    });
    if (!request) return;
    submittingRef.current = true;
    setPhase('submitting');
    setSubmitError('');
    setErrorCode('');
    try {
      const result = await submitMePurchaseOrder(window.electron.mePoints, request);
      if (!result.ok) {
        setPhase('form');
        setSubmitError(result.error || t('mobile.me.purchase.errorTitle'));
        setErrorCode(result.errorCode || '');
        return;
      }
      if (!result.checkout) {
        setPhase('form');
        setSubmitError(t('mobile.me.purchase.paymentUnavailable'));
        return;
      }
      setCheckout(result.checkout);
      setPhase('paying');
      setPollExpired(false);
      saveMeCheckoutRecovery({
        section,
        orderId: result.orderId,
        ...(selectedPlan ? { planId: selectedPlan.planId } : {}),
        ...(selectedPackage ? { packageId: selectedPackage.packageId } : {}),
        period,
        gateway,
        createdAt: Date.now(),
      });
      if (result.checkout.approvalUrl) {
        const url = result.checkout.approvalUrl;
        window.setTimeout(() => {
          void getMobileElectron().shell.openExternal(url).catch(() => {
            setSubmitError(t('mobile.me.purchase.openFailed'));
          });
        }, 0);
      }
    } catch (error) {
      setPhase('form');
      setSubmitError(error instanceof Error ? error.message : t('mobile.me.purchase.errorTitle'));
    } finally {
      submittingRef.current = false;
    }
  }, [section, isUpgrade, upgradeConfirmOpen, selectedPlan, selectedPackage, period, days, gateway]);

  const backToForm = useCallback(() => {
    if (checkout) clearMeCheckoutRecovery(checkout.orderId);
    setCheckout(null);
    setPhase('form');
    setSubmitError('');
    setErrorCode('');
    setPollExpired(false);
    setUpgradeConfirmOpen(false);
  }, [checkout]);

  const needSubscriptionGate = section === 'topup' && !subscribed && !snapshot.subscriptionLoading;
  const isSubRequired = errorCode === 'SUBSCRIPTION_REQUIRED';
  // The server envelope message is a generic "error"; the errorCode decides
  // the copy (shared mapping with the desktop panel).
  const submitErrorKey = submitError ? meCheckoutErrorKey(errorCode, submitError) : '';
  const submitErrorText = submitErrorKey
    ? t(`mobile.me.purchase.${submitErrorKey}`, { gateway: t(gateway === 'paypal' ? 'mobile.me.purchase.gatewayPaypal' : 'mobile.me.purchase.gatewayAlipay') })
    : submitError;
  const title = section === 'subscribe' ? t('mobile.me.purchase.subscribeTitle') : t('mobile.me.purchase.topupTitle');
  const paymentUrl = checkout?.approvalUrl || (/^https?:\/\//i.test(checkout?.qrCode ?? '') ? checkout?.qrCode : '');
  const formVisible = phase === 'form' || phase === 'submitting';

  return (
    <div className="twin-page h-full" data-testid="me-purchase-page" data-section={section}>
      <div className="twin-topbar twin-topbar-simple shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}>
        <button type="button" onClick={props.onClose} className="me-back" aria-label={t('mobile.common.back')}>
          <ArrowLeftIcon className="h-5 w-5" aria-hidden />
          <span>{title}</span>
        </button>
        <button type="button" className="me-close-text" onClick={props.onClose}>
          {t('mobile.common.close')}
        </button>
      </div>

      <div className="twin-scroll space-y-3 p-3">
        {formVisible && section === 'subscribe' ? (
          <>
            <MeTierCards
              plans={snapshot.plans}
              loading={snapshot.plansLoading}
              error={snapshot.plansError}
              activePlanId={activePlanId}
              activeTierKey={activeTierKey}
              subscribed={subscribed}
              selectedPlanId={effectivePlanId}
              onChoose={(planId) => {
                setSelectedPlanId(planId);
                setErrorCode('');
              }}
              onRetry={() => void refreshMeCatalog()}
            />
            <section className="twin-panel twin-panel-padded">
              <h2 className="me-usage-title mb-2">{t('mobile.me.purchase.periodTitle')}</h2>
              <div className="me-segment" role="group" aria-label={t('mobile.me.purchase.periodTitle')}>
                {PERIODS.map((item) => {
                  const price = mePeriodPrice(selectedPlan, item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`me-period-${item.id}`}
                      onClick={() => setPeriod(item.id)}
                      className={period === item.id ? 'me-segment-item me-segment-active' : 'me-segment-item'}
                    >
                      <span className="me-segment-label">{t(item.labelKey)}</span>
                      <span className="me-segment-price">{price == null ? '—' : `¥${price}`}</span>
                    </button>
                  );
                })}
              </div>
              <p className="me-period-note">{t('mobile.me.purchase.periodNote', { days })}</p>
            </section>
            <section className="twin-panel twin-panel-padded">
              <h2 className="me-usage-title mb-2">{t('mobile.me.purchase.gatewayTitle')}</h2>
              <div className="me-segment me-segment-two" role="group" aria-label={t('mobile.me.purchase.gatewayTitle')}>
                {GATEWAYS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`me-gateway-${item.id}`}
                    onClick={() => setGateway(item.id)}
                    className={gateway === item.id ? 'me-segment-item me-segment-active' : 'me-segment-item'}
                  >
                    <span className="me-segment-label">{t(item.labelKey)}</span>
                  </button>
                ))}
              </div>
              {gateway === 'paypal' ? (
                <p className="me-period-note" data-testid="me-paypal-usd-note">{t('mobile.me.purchase.paypalUsdNote')}</p>
              ) : null}
            </section>
          </>
        ) : null}

        {needSubscriptionGate && formVisible ? (
          <section className="twin-panel twin-panel-padded" data-testid="me-topup-gate">
            <div className="me-gate-head">
              <ExclamationTriangleIcon className="h-5 w-5 text-[var(--twin-warning)]" aria-hidden />
              <h2 className="me-usage-title">{t('mobile.me.purchase.subRequiredTitle')}</h2>
            </div>
            <p className="me-gate-body">{t('mobile.me.purchase.subRequiredBody')}</p>
            <button
              type="button"
              className="twin-button twin-button-primary twin-button-full mt-3"
              onClick={() => props.onSwitchSection('subscribe')}
            >
              {t('mobile.me.purchase.openPlans')}
            </button>
          </section>
        ) : null}

        {formVisible && section === 'topup' && !needSubscriptionGate ? (
          <section className="twin-panel twin-panel-padded" data-testid="me-topup-packages">
            <h2 className="me-usage-title mb-2">{t('mobile.me.purchase.topupTitle')}</h2>
            <div className="space-y-2">
              {snapshot.topupPackages.map((pkg) => {
                const active = pkg.packageId === selectedPackage?.packageId;
                return (
                  <button
                    key={pkg.packageId}
                    type="button"
                    data-testid={`me-topup-${pkg.packageId}`}
                    onClick={() => setSelectedPackageId(pkg.packageId)}
                    className={active ? 'me-package-row me-package-active' : 'me-package-row'}
                  >
                    <span className="me-package-name">{pkg.name || pkg.packageId}</span>
                    <span className="me-package-me">
                      {pkg.meMilli ? t('mobile.me.purchase.topupPackageMe', { me: formatMe(meFromMilli(pkg.meMilli)) }) : '—'}
                    </span>
                    <span className="me-package-price">{typeof pkg.priceCny === 'number' ? `¥${pkg.priceCny}` : '—'}</span>
                  </button>
                );
              })}
              {!snapshot.topupPackages.length ? (
                <p className="me-empty">
                  {snapshot.topupPackagesLoading ? t('mobile.common.loading') : t('mobile.me.purchase.topupUnavailable')}
                </p>
              ) : null}
            </div>
            <p className="me-period-note">{t('mobile.me.purchase.topupPricingNote')}</p>
          </section>
        ) : null}

        {formVisible && !needSubscriptionGate && props.canPurchase ? (
          <section className="twin-panel twin-panel-padded me-checkout-summary" data-testid="me-checkout-summary">
            <span>{t('mobile.me.purchase.amountDueLabel')}</span>
            <strong>{amountDue == null ? '—' : t('mobile.me.purchase.amountDue', { price: amountDue })}</strong>
          </section>
        ) : null}

        {formVisible && upgradeConfirmOpen ? (
          <section className="twin-notice twin-notice-warning" data-testid="me-upgrade-confirm">
            <p className="text-sm">{t('mobile.me.purchase.upgradeNotice')}</p>
          </section>
        ) : null}

        {phase === 'paying' && checkout ? (
          <>
            <section className="twin-panel twin-panel-padded" data-testid="me-payment-pending">
              <div className="me-pay-head">
                <div>
                  <h2 className="me-usage-title">{t('mobile.me.purchase.waitingTitle')}</h2>
                  <p className="me-gate-body mt-1">
                    {t(paymentUrl ? 'mobile.me.purchase.waitingBrowser' : 'mobile.me.purchase.waitingQr')}
                  </p>
                </div>
                <span className="me-pay-amount">{t('mobile.me.purchase.amountDue', { price: formatMeMoney(checkout.payAmount, checkout.payCurrency) })}</span>
              </div>
              {checkout.creditAppliedCny != null && checkout.creditAppliedCny > 0 ? (
                <div className="me-proration" data-testid="me-proration-credit">
                  <span>
                    {t('mobile.me.purchase.prorationApplied')}
                    {checkout.listAmountCny != null ? ` · ${t('mobile.me.purchase.listPrice', { price: checkout.listAmountCny })}` : ''}
                  </span>
                  <strong>-¥{checkout.creditAppliedCny}</strong>
                </div>
              ) : null}
              {checkout.qrCode ? (
                <div className="me-qr-wrap">
                  <QrCanvas value={checkout.qrCode} size={188} />
                  <p className="me-qr-hint">{t('mobile.me.purchase.waitingQr')}</p>
                </div>
              ) : null}
              <div className="me-checkout-order">{checkout.orderId}</div>
              {checkout.expiresAt ? (
                <p className="me-period-note">{t('mobile.me.purchase.expiresAt', { time: new Date(checkout.expiresAt).toLocaleString() })}</p>
              ) : null}
            </section>
            <section className="twin-panel twin-panel-padded space-y-2">
              {paymentUrl ? (
                <button type="button" className="twin-button twin-button-primary twin-button-full" data-testid="me-payment-reopen" onClick={() => void openPayment()}>
                  {t('mobile.me.purchase.reopenPayment')}
                </button>
              ) : null}
              <button type="button" className="twin-button twin-button-secondary twin-button-full" data-testid="me-payment-check" disabled={checking} onClick={() => void checkOrder(true)}>
                {checking ? t('mobile.me.purchase.checking') : t('mobile.me.purchase.checkNow')}
              </button>
              <div className="me-checkout-status" role="status">
                <ArrowPathIcon className={checking || !pollExpired ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
                <span>{t(pollExpired ? 'mobile.me.purchase.pollExpired' : 'mobile.me.purchase.autoChecking')}</span>
              </div>
              <button type="button" className="twin-button twin-button-ghost twin-button-full" onClick={backToForm}>
                {t('mobile.me.purchase.backToPlans')}
              </button>
            </section>
          </>
        ) : null}

        {phase === 'credited' ? (
          <section className="twin-panel twin-panel-padded me-success" data-testid="me-purchase-submitted">
            <CheckCircleIcon className="me-success-icon" aria-hidden />
            <h2 className="me-usage-title">{t('mobile.me.purchase.creditedTitle')}</h2>
            <p className="me-gate-body">{t(section === 'subscribe' ? 'mobile.me.purchase.creditedSubscribe' : 'mobile.me.purchase.creditedTopup')}</p>
            {checkout?.orderId ? <p className="me-success-order">{checkout.orderId}</p> : null}
            {checkout ? (
              <p className="me-success-order" data-testid="me-purchase-server-amount">
                {t('mobile.me.purchase.submittedAmount', { price: formatMeMoney(checkout.payAmount, checkout.payCurrency) })}
              </p>
            ) : null}
            {props.onOpenUsage ? (
              <button type="button" className="twin-button twin-button-primary twin-button-full mt-3" onClick={props.onOpenUsage}>
                {t('mobile.me.purchase.openUsage')}
              </button>
            ) : null}
            <button type="button" className="twin-button twin-button-ghost twin-button-full mt-2" onClick={props.onClose}>
              {t('mobile.me.purchase.done')}
            </button>
          </section>
        ) : null}

        {phase === 'closed' ? (
          <section className="twin-notice twin-notice-warning" data-testid="me-payment-closed">
            <p className="text-sm">{t('mobile.me.purchase.closed')}</p>
            <button type="button" className="twin-button twin-button-secondary twin-button-full mt-3" onClick={backToForm}>
              {t('mobile.me.purchase.backToPlans')}
            </button>
          </section>
        ) : null}

        {!props.canPurchase && formVisible ? (
          <section className="twin-panel twin-panel-padded" data-testid="me-ios-guidance">
            <h2 className="me-usage-title">{t('mobile.me.purchase.iosTitle')}</h2>
            <p className="me-gate-body">{t('mobile.me.purchase.iosBody')}</p>
            <button type="button" className="twin-button twin-button-secondary twin-button-full mt-3" onClick={props.onClose}>
              {t('mobile.me.purchase.done')}
            </button>
          </section>
        ) : null}

        {submitError ? (
          <div className="twin-notice twin-notice-error" data-testid="me-purchase-error" role="alert">
            <p className="text-sm font-semibold">{isSubRequired ? t('mobile.me.purchase.subRequiredTitle') : t('mobile.me.purchase.errorTitle')}</p>
            <p className="mt-1 text-xs">{isSubRequired ? t('mobile.me.purchase.subRequiredBody') : submitErrorText}</p>
            {isSubRequired ? (
              <button type="button" className="twin-button twin-button-primary twin-button-full mt-2" onClick={() => props.onSwitchSection('subscribe')}>
                {t('mobile.me.purchase.openPlans')}
              </button>
            ) : null}
          </div>
        ) : null}

        {formVisible && props.canPurchase && !needSubscriptionGate ? (
          <>
            <button
              type="button"
              className="twin-button twin-button-primary twin-button-full"
              data-testid="me-purchase-submit"
              disabled={phase === 'submitting'
                || (section === 'subscribe'
                  ? (!selectedPlan || isMePlanDowngrade(activeTierKey, selectedPlan.tier))
                  : !selectedPackage)}
              onClick={() => void submit()}
            >
              {phase === 'submitting'
                ? t('mobile.me.purchase.creating')
                : upgradeConfirmOpen
                  ? t('mobile.me.purchase.upgradeConfirm')
                  : t('mobile.me.purchase.payNow')}
            </button>
            <section className="me-compliance">
              <h3 className="me-compliance-title">{t('mobile.me.purchase.complianceTitle')}</h3>
              <ul className="me-compliance-list">
                <li>{t('mobile.me.compliance.weekly')}</li>
                <li>{t('mobile.me.compliance.persistent')}</li>
                <li>{t('mobile.me.compliance.noCash')}</li>
                <li>{t('mobile.me.compliance.fallback')}</li>
              </ul>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
