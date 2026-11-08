import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AcademicCapIcon,
  ArrowPathIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  GiftIcon,
  PencilIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { MePlanInfo, MeTopupPackageInfo } from '../../types/electron';
import {
  ensureMeSnapshot,
  formatMe,
  getMeSnapshot,
  invalidateMeSnapshot,
  isMeEffectivelySubscribed,
  meActivePlanId,
  meFromMilli,
  requestMeSubscription,
  requestOpenUsagePage,
  subscribeMeSnapshot,
  type MePurchaseSection,
} from './mePointsStore';
import {
  meDiscountFromPct,
  mePaymentPhase,
  mePeriodPricing,
  normalizeMePaymentCheckout,
  type MePaymentCheckout,
  type MeSubscriptionPeriodOption,
} from './mePayment';

const COMPLIANCE_LINES = (): string[] => [
  i18nService.t('meComplianceWeekly'),
  i18nService.t('meCompliancePersistent'),
  i18nService.t('meComplianceNoCash'),
  i18nService.t('meComplianceFallback'),
];

const POLL_INTERVAL_MS = 4_000;
const POLL_WINDOW_MS = 10 * 60_000;

type OrderPhase = 'pick' | 'creating' | 'paying' | 'credited' | 'closed';

/**
 * ID.Free is the built-in allowance tier: listed in the panel for
 * comparison, never purchasable (no order exists for a free plan). The
 * server's free-tier entry wins when /v1/me/plans carries one; otherwise
 * this constant renders (weekly 2000 ME, price free).
 */
const LOCAL_FREE_PLAN: MePlanInfo = {
  planId: 'me-id-free',
  tier: 'free',
  name: 'ID.Free',
  nameEn: 'ID.Free',
  priceCny: 0,
  desktopPriceCny: 0,
  weeklyAmountMilli: 2_000_000,
};

// Tier icons for the four plan cards (product-catalog style): gift for
// the free allowance, pencil → book → academic cap following the
// pupil → student → scholar ladder.
const TIER_ICONS: Record<string, React.ReactNode> = {
  free: <GiftIcon className="h-4 w-4" />,
  standard: <PencilIcon className="h-4 w-4" />,
  pro: <BookOpenIcon className="h-4 w-4" />,
  max: <AcademicCapIcon className="h-4 w-4" />,
};

const tierIcon = (plan: MePlanInfo): React.ReactNode => TIER_ICONS[plan.tier] ?? TIER_ICONS.standard;

interface MePurchaseFlowProps {
  open: boolean;
  section: MePurchaseSection;
  onSectionChange?: (section: MePurchaseSection) => void;
  onClose: () => void;
}

const priceLabel = (value: number | null | undefined): string => (
  value != null && Number.isFinite(value) ? `${value}` : '—'
);

const MePurchaseFlow: React.FC<MePurchaseFlowProps> = ({ open, section, onSectionChange, onClose }) => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [selectedPackageId, setSelectedPackageId] = useState('');
  const [period, setPeriod] = useState<MeSubscriptionPeriodOption>('month');
  const [gateway, setGateway] = useState<'alipay' | 'paypal'>('alipay');
  const [topupPackages, setTopupPackages] = useState<MeTopupPackageInfo[]>([]);
  const [phase, setPhase] = useState<OrderPhase>('pick');
  const [orderError, setOrderError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkout, setCheckout] = useState<MePaymentCheckout | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');

  const paidPlans = useMemo(
    () => snapshot.plans.filter((plan) => plan.tier !== 'free'),
    [snapshot.plans]
  );
  const serverFreePlan = useMemo(
    () => snapshot.plans.find((plan) => plan.tier === 'free') ?? null,
    [snapshot.plans]
  );
  const subscribed = isMeEffectivelySubscribed(snapshot.subscription);
  const activePlanId = meActivePlanId(snapshot.subscription);
  const activeRawTier = typeof snapshot.subscription?.raw?.tier === 'string'
    ? (snapshot.subscription.raw as Record<string, unknown>).tier
    : '';
  // The currently-active tier (free for un-subscribed users, the paid plan
  // otherwise) renders as "current plan": highlighted but not selectable.
  const isCurrentPlan = useCallback((plan: MePlanInfo) => {
    if (!subscribed) return plan.tier === 'free';
    return plan.planId === activePlanId
      || plan.tier === activePlanId
      || (!!activeRawTier && plan.tier === activeRawTier);
  }, [subscribed, activePlanId, activeRawTier]);
  // A paying user must not see the free tier at all: no downgrade option —
  // the subscription falls back to free on its own when it expires.
  const planCards = useMemo(() => {
    const cards = [serverFreePlan ?? LOCAL_FREE_PLAN, ...paidPlans];
    return subscribed ? cards.filter((plan) => plan.tier !== 'free') : cards;
  }, [serverFreePlan, paidPlans, subscribed]);

  // Latest plan-selection context for the reset effect below. The effect must
  // run ONLY on open/section transitions: the plan catalog refetches on every
  // ensureMeSnapshot (no TTL) and lands as a fresh plans array, so data-derived
  // deps would re-run the reset mid-panel — flashing a picked 季付/年付 back to
  // 月付 and the gateway back to Alipay.
  const selectionContextRef = useRef({ isCurrentPlan, planCards, paidPlans });
  selectionContextRef.current = { isCurrentPlan, planCards, paidPlans };

  useEffect(() => {
    if (!open) return;
    ensureMeSnapshot();
    setPhase('pick');
    setOrderError('');
    setErrorCode('');
    setCheckout(null);
    setQrDataUrl('');
    setChecking(false);
    setPeriod('month');
    setGateway('alipay');
    setTopupPackages([]);
    if (section === 'topup') {
      void window.electron.mePoints.getTopupPackages().then((res) => {
        if (res.success && Array.isArray(res.topupPackages)) {
          setTopupPackages(res.topupPackages);
          setSelectedPackageId((current) => (
            current && res.topupPackages!.some((pkg) => pkg.packageId === current)
              ? current
              : res.topupPackages![0]?.packageId ?? ''
          ));
        }
      });
    }
    setSelectedPlanId((current) => {
      const { isCurrentPlan, planCards, paidPlans } = selectionContextRef.current;
      const stillValid = current
        && planCards.some((plan) => plan.planId === current && !isCurrentPlan(plan));
      if (stillValid) return current;
      const preferred = paidPlans[Math.min(1, Math.max(0, paidPlans.length - 1))];
      if (preferred && !isCurrentPlan(preferred)) return preferred.planId;
      return paidPlans.find((plan) => !isCurrentPlan(plan))?.planId ?? '';
    });
  }, [open, section]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: string }>).detail;
      if (detail?.section === 'subscribe' || detail?.section === 'topup') {
        onSectionChange?.(detail.section);
      }
    };
    window.addEventListener('me:purchaseSwitchSection', listener);
    return () => window.removeEventListener('me:purchaseSwitchSection', listener);
  }, [onSectionChange]);

  // Effective selection never lands on the current (non-selectable) plan.
  const effectivePlanId = useMemo(() => {
    if (selectedPlanId) {
      const selected = planCards.find((plan) => plan.planId === selectedPlanId);
      if (selected && !isCurrentPlan(selected)) return selectedPlanId;
    }
    const preferred = paidPlans[Math.min(1, Math.max(0, paidPlans.length - 1))];
    if (preferred && !isCurrentPlan(preferred)) return preferred.planId;
    return paidPlans.find((plan) => !isCurrentPlan(plan))?.planId ?? '';
  }, [selectedPlanId, planCards, paidPlans, isCurrentPlan]);
  const selectedPlan = planCards.find((plan) => plan.planId === effectivePlanId) ?? null;
  const selectedTopup = topupPackages.find((pkg) => pkg.packageId === selectedPackageId) ?? null;
  // The free tier is display-only: it has no order, no period and no CTA.
  const isFreeSelected = selectedPlan?.tier === 'free';

  const periodPricing = useMemo(() => {
    if (!selectedPlan || isFreeSelected) return null;
    const monthly = selectedPlan.desktopPriceCny ?? selectedPlan.priceCny ?? null;
    if (monthly == null) return null;
    return mePeriodPricing({ monthly, period });
  }, [selectedPlan, isFreeSelected, period]);
  const discount = periodPricing ? meDiscountFromPct(periodPricing.discountPct) : null;

  const amountDue = section === 'subscribe'
    ? (isFreeSelected ? 0 : periodPricing?.total ?? null)
    : selectedTopup?.priceCny ?? null;

  useEffect(() => {
    if (!checkout?.qrCode) {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(checkout.qrCode, { margin: 1, width: 220 })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(''); });
    return () => { cancelled = true; };
  }, [checkout?.qrCode]);

  const checkOrder = useCallback(async (showError = false) => {
    if (!checkout) return;
    if (showError) {
      setChecking(true);
      setOrderError('');
    }
    try {
      if (section === 'subscribe') {
        const res = await window.electron.mePoints.getSubscriptionOrder({ orderId: checkout.orderId });
        if (!res.success || !res.subscriptionOrder) {
          if (showError) setOrderError(res.error || i18nService.t('mePurchaseCheckFailed'));
          return;
        }
        const nextPhase = mePaymentPhase(res.subscriptionOrder.status);
        if (nextPhase === 'credited') {
          setCheckout((current) => current ? { ...current, status: res.subscriptionOrder!.status } : current);
          setPhase('credited');
          invalidateMeSnapshot();
          void requestMeSubscription();
        } else if (nextPhase === 'closed') {
          setPhase('closed');
        }
      } else {
        const res = await window.electron.mePoints.getTopupOrders();
        const order = res.success ? res.orders?.find((item) => item.orderId === checkout.orderId) : null;
        if (!order) {
          if (showError) setOrderError(res.error || i18nService.t('mePurchaseCheckFailed'));
          return;
        }
        const nextPhase = mePaymentPhase(order.status);
        if (nextPhase === 'credited') {
          setCheckout((current) => current ? { ...current, status: order.status } : current);
          setPhase('credited');
          invalidateMeSnapshot();
        } else if (nextPhase === 'closed') {
          setPhase('closed');
        }
      }
    } catch {
      if (showError) setOrderError(i18nService.t('mePurchaseCheckFailed'));
    } finally {
      if (showError) setChecking(false);
    }
  }, [checkout, section]);

  useEffect(() => {
    if (!open || phase !== 'paying' || !checkout) return;
    const startedAt = Date.now();
    void checkOrder();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > POLL_WINDOW_MS) {
        window.clearInterval(timer);
        return;
      }
      void checkOrder();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, phase, checkout, checkOrder]);

  const handleCreateOrder = useCallback(async () => {
    const subjectId = section === 'subscribe' ? selectedPlan?.planId : selectedTopup?.packageId;
    if (!subjectId || phase === 'creating') return;
    setPhase('creating');
    setOrderError('');
    setErrorCode('');
    const idempotencyKey = `desktop-${section}-${subjectId}-${period}-${Date.now()}`;
    try {
      const res = section === 'subscribe'
        ? await window.electron.mePoints.submitSubscriptionOrder({
            planId: subjectId,
            period,
            channel: 'desktop',
            gateway,
            idempotencyKey,
          })
        : await window.electron.mePoints.submitTopupOrder({
            packageId: subjectId,
            gateway: 'alipay',
            idempotencyKey,
          });
      if (!res.success) {
        setPhase('pick');
        setOrderError(res.error || i18nService.t('mePurchaseUnavailable'));
        setErrorCode(res.errorCode || '');
        return;
      }
      const order = section === 'subscribe'
        ? ('subscriptionOrder' in res ? res.subscriptionOrder : null)
        : ('submission' in res ? res.submission?.order : null);
      const nextCheckout = normalizeMePaymentCheckout(order, amountDue ?? 0);
      if (!nextCheckout || (!nextCheckout.approvalUrl && !nextCheckout.qrCode)) {
        setPhase('pick');
        setOrderError(i18nService.t('mePurchaseUnavailable'));
        return;
      }
      setCheckout(nextCheckout);
      setPhase('paying');
      if (nextCheckout.approvalUrl) {
        void window.electron.shell.openExternal(nextCheckout.approvalUrl).catch(() => {
          setOrderError(i18nService.t('mePurchaseOpenFailed'));
        });
      }
    } catch (error) {
      setPhase('pick');
      setOrderError(error instanceof Error && error.message ? error.message : i18nService.t('mePurchaseUnavailable'));
    }
  }, [section, selectedPlan, selectedTopup, phase, period, amountDue, gateway]);

  const backToPicker = () => {
    setPhase('pick');
    setCheckout(null);
    setOrderError('');
    setErrorCode('');
  };

  if (!open) return null;

  const canCreate = section === 'subscribe'
    ? Boolean(selectedPlan) && !isFreeSelected && !isCurrentPlan(selectedPlan)
    : section === 'topup' && subscribed && Boolean(selectedTopup);
  const paymentUrl = checkout?.approvalUrl || (/^https?:\/\//i.test(checkout?.qrCode ?? '') ? checkout!.qrCode : '');

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={phase === 'creating' ? undefined : onClose} />
      <div className="relative max-h-[90vh] w-[560px] overflow-y-auto rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-claude-border/60 dark:border-claude-darkBorder/60 bg-claude-surface/95 dark:bg-claude-darkSurface/95 px-4 py-3 backdrop-blur">
          <h3 className="text-sm font-semibold text-claude-text dark:text-claude-darkText">
            {section === 'subscribe' ? i18nService.t('mePurchaseTitle') : i18nService.t('mePurchaseTopupTitle')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={i18nService.t('close')}
            className="rounded-lg p-1 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3">
          {(phase === 'pick' || phase === 'creating') && (
            <>
              {snapshot.plansLoading && paidPlans.length === 0 && (
                <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('loading')}</p>
              )}

              {section === 'subscribe' && (
                <div className="space-y-1.5">
                  {planCards.map((plan) => {
                    const currentPlan = isCurrentPlan(plan);
                    const selected = effectivePlanId === plan.planId;
                    return (
                      <button
                        key={plan.planId}
                        type="button"
                        disabled={phase === 'creating' || currentPlan}
                        onClick={() => {
                          if (!currentPlan) setSelectedPlanId(plan.planId);
                        }}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                          currentPlan
                            // "cannot select" style — deliberately distinct from
                            // the accent selection state
                            ? 'border-claude-border dark:border-claude-darkBorder bg-claude-surfaceHover/50 dark:bg-claude-darkSurfaceHover/30 cursor-not-allowed'
                            : selected
                              ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                              : 'border-claude-border dark:border-claude-darkBorder hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${currentPlan ? 'bg-claude-surfaceHover text-claude-textSecondary dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary' : 'bg-claude-accent/10 text-claude-accent dark:bg-claude-accent/15 dark:text-claude-darkAccent'}`}>
                              {tierIcon(plan)}
                            </span>
                            <span className={`truncate text-xs font-semibold ${currentPlan ? 'text-claude-textSecondary dark:text-claude-darkTextSecondary' : 'text-claude-text dark:text-claude-darkText'}`}>{plan.name}</span>
                          </span>
                          <span className={`shrink-0 tabular-nums text-xs ${currentPlan ? 'text-claude-textSecondary dark:text-claude-darkTextSecondary' : 'text-claude-text dark:text-claude-darkText'}`}>
                            {plan.tier === 'free'
                              ? i18nService.t('mePurchaseFreePrice')
                              : i18nService.t('mePlanPriceMonthly').replace('{price}', priceLabel(plan.desktopPriceCny ?? plan.priceCny))}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2">
                          <span className="truncate text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                            {i18nService.t('mePlanHighlightWeekly').replace('{me}', formatMe(meFromMilli(plan.weeklyAmountMilli)))}
                          </span>
                          {currentPlan ? (
                            <span className="shrink-0 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                              {i18nService.t('meCurrentPlanBadge')}
                            </span>
                          ) : plan.tier === 'pro' ? (
                            <span className="shrink-0 text-[10px] text-claude-accent dark:text-claude-darkAccent">
                              {i18nService.t('mePlanPopularBadge')}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}

                  {selectedPlan && !isFreeSelected && (
                    <div className="rounded-xl border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 px-3 py-2">
                      <span className="text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('mePurchasePeriod')}
                      </span>
                      <div className="mt-1.5 grid grid-cols-3 gap-2">
                        {(['month', 'quarter', 'year'] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            disabled={phase === 'creating'}
                            onClick={() => setPeriod(value)}
                            className={`rounded-lg border px-2 py-1.5 text-[11px] transition-colors ${
                              period === value
                                ? 'border-claude-accent text-claude-accent dark:text-claude-darkAccent bg-claude-accent/5'
                                : 'border-claude-border dark:border-claude-darkBorder text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                            }`}
                          >
                            {i18nService.t(`mePurchasePeriod_${value}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedPlan && !isFreeSelected && (
                    <div className="rounded-xl border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 px-3 py-2">
                      <span className="text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('mePurchaseGatewayLabel')}
                      </span>
                      <div className="mt-1.5 grid grid-cols-2 gap-2">
                        {(['alipay', 'paypal'] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            disabled={phase === 'creating'}
                            onClick={() => setGateway(value)}
                            className={`rounded-lg border px-2 py-1.5 text-[11px] transition-colors ${
                              gateway === value
                                ? 'border-claude-accent text-claude-accent dark:text-claude-darkAccent bg-claude-accent/5'
                                : 'border-claude-border dark:border-claude-darkBorder text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                            }`}
                          >
                            {i18nService.t(value === 'alipay' ? 'mePurchaseGatewayAlipay' : 'mePurchaseGatewayPaypal')}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {section === 'topup' && (
                subscribed ? (
                  <div className="space-y-2">
                    {topupPackages.map((pkg) => (
                      <button
                        key={pkg.packageId}
                        type="button"
                        disabled={phase === 'creating'}
                        onClick={() => setSelectedPackageId(pkg.packageId)}
                        className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          selectedPackageId === pkg.packageId
                            ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                            : 'border-claude-border dark:border-claude-darkBorder hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-claude-text dark:text-claude-darkText">
                            {i18nService.t('mePurchaseTopupPackage').replace('{me}', formatMe(meFromMilli(pkg.meMilli ?? 0)))}
                          </span>
                          <span className="tabular-nums text-xs text-claude-text dark:text-claude-darkText">
                            {priceLabel(pkg.priceCny)} {i18nService.t('mePurchaseCny')}
                          </span>
                        </div>
                      </button>
                    ))}
                    {topupPackages.length === 0 && !snapshot.plansLoading && (
                      <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('mePurchaseTopupUnavailable')}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-200 dark:border-amber-800/70 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-3">
                    <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
                      <ExclamationTriangleIcon className="mr-1 inline h-3.5 w-3.5" />
                      {i18nService.t('mePurchaseTopupHiddenHint')}
                    </p>
                    <button
                      type="button"
                      onClick={() => onSectionChange?.('subscribe')}
                      className="mt-2 text-[11px] font-medium text-claude-accent dark:text-claude-darkAccent hover:underline"
                    >
                      {i18nService.t('mePurchaseOpenPlans')}
                    </button>
                  </div>
                )
              )}

              {section === 'subscribe' && selectedPlan && (
                isFreeSelected ? (
                  <div className="flex items-baseline justify-between rounded-xl bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 px-3 py-2">
                    <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('mePurchaseAmountDue')}
                    </span>
                    <span className="text-base font-semibold text-green-600 dark:text-green-400">
                      {i18nService.t('mePurchaseFreePrice')}
                    </span>
                  </div>
                ) : (
                  <div className="rounded-xl bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('mePurchasePriceTagLabel')}
                      </span>
                      <span className="flex items-baseline gap-1.5">
                        <span className="tabular-nums text-lg font-semibold text-claude-text dark:text-claude-darkText">
                          {i18nService.t('mePlanPriceMonthly').replace('{price}', priceLabel(periodPricing?.monthlyRate ?? amountDue))}
                        </span>
                        {periodPricing?.originalMonthly != null && (
                          <span className="tabular-nums text-[11px] text-claude-textSecondary line-through dark:text-claude-darkTextSecondary">
                            ¥{priceLabel(periodPricing.originalMonthly)}
                          </span>
                        )}
                        {discount && (
                          <span className="rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-500 dark:text-red-400">
                            {i18nService.getLanguage() === 'zh'
                              ? i18nService.t('mePurchaseDiscountZhe').replace('{zhe}', discount.zhe)
                              : i18nService.t('mePurchaseDiscountPctOff').replace('{pct}', String(discount.pctOff))}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      <span>
                        {selectedPlan.name} · {i18nService.t(`mePurchasePeriod_${period}`)}
                      </span>
                      {periodPricing && periodPricing.months > 1 && (
                        <span className="tabular-nums">
                          {i18nService.t('mePurchaseLumpSum')
                            .replace('{months}', String(periodPricing.months))
                            .replace('{total}', priceLabel(periodPricing.total))}
                        </span>
                      )}
                    </div>
                  </div>
                )
              )}

              {section === 'topup' && canCreate && (
                <div className="flex items-baseline justify-between rounded-xl bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 px-3 py-2">
                  <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('mePurchaseAmountDue')}
                  </span>
                  <span className="tabular-nums text-base font-semibold text-claude-text dark:text-claude-darkText">
                    {priceLabel(amountDue)}
                    <span className="ml-0.5 text-[10px] font-normal">{i18nService.t('mePurchaseCny')}</span>
                  </span>
                </div>
              )}
            </>
          )}

          {phase === 'paying' && checkout && (
            <div className="space-y-3">
              <div>
                <h4 className="text-sm font-medium text-claude-text dark:text-claude-darkText">{i18nService.t('mePurchaseWaitingTitle')}</h4>
                <p className="mt-1 text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t(checkout.approvalUrl ? 'mePurchaseBrowserWaiting' : 'mePurchaseQrWaiting')}
                </p>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-claude-surfaceInset/50 dark:bg-claude-darkSurfaceInset/40 px-3 py-2.5">
                <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('mePurchaseAmountDue')}</span>
                <span className="text-base font-semibold tabular-nums text-claude-text dark:text-claude-darkText">
                  {priceLabel(checkout.payAmount)} {i18nService.t('mePurchaseCny')}
                </span>
              </div>
              {checkout.qrCode && (
                <div className="flex flex-col items-center">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={i18nService.t('mePurchaseScanQr')}
                      className="h-[220px] w-[220px] rounded-xl border border-claude-border dark:border-claude-darkBorder bg-white p-1"
                    />
                  ) : (
                    <div className="flex h-[220px] w-[220px] items-center justify-center rounded-xl border border-claude-border dark:border-claude-darkBorder">
                      <ArrowPathIcon className="h-5 w-5 animate-spin text-claude-textSecondary dark:text-claude-darkTextSecondary" />
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('mePurchaseScanQr')}</p>
                </div>
              )}
              <div className="flex items-center gap-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                <ArrowPathIcon className="h-4 w-4 animate-spin" />
                <span>{i18nService.t('mePurchaseChecking')}</span>
              </div>
              <p className="text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('mePurchaseOrderExpiry')}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                {paymentUrl && (
                  <button
                    type="button"
                    onClick={() => void window.electron.shell.openExternal(paymentUrl).catch(() => setOrderError(i18nService.t('mePurchaseOpenFailed')))}
                    className="rounded-lg border border-claude-border dark:border-claude-darkBorder px-3 py-1.5 text-[11px] text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  >
                    {i18nService.t('mePurchaseReopen')}
                  </button>
                )}
                <button
                  type="button"
                  disabled={checking}
                  onClick={() => void checkOrder(true)}
                  className="rounded-lg border border-claude-border dark:border-claude-darkBorder px-3 py-1.5 text-[11px] text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50"
                >
                  {checking ? i18nService.t('mePurchaseCheckChecking') : i18nService.t('mePurchaseCheckNow')}
                </button>
                <button
                  type="button"
                  onClick={backToPicker}
                  className="rounded-lg px-3 py-1.5 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                >
                  {i18nService.t('mePurchaseBack')}
                </button>
              </div>
            </div>
          )}

          {phase === 'credited' && (
            <div className="rounded-2xl border border-green-200 dark:border-green-800/70 bg-green-50/70 dark:bg-green-950/30 px-4 py-6 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15">
                <CheckCircleIcon className="h-8 w-8 text-green-500" />
              </div>
              <p className="mt-3 text-base font-semibold text-green-700 dark:text-green-300">
                {i18nService.t('mePurchaseSuccessTitle')}
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-green-700/80 dark:text-green-300/80">
                {i18nService.t(section === 'subscribe' ? 'mePurchaseSubscribeCredited' : 'mePurchaseTopupCredited')}
              </p>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  requestOpenUsagePage();
                }}
                className="mt-4 text-[11px] font-medium text-green-700 dark:text-green-300 hover:underline"
              >
                {i18nService.t('mePurchaseViewOrders')}
              </button>
            </div>
          )}

          {phase === 'closed' && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-800/70 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-3">
              <p className="text-[11px] text-amber-800 dark:text-amber-300">{i18nService.t('mePurchaseClosed')}</p>
              <button
                type="button"
                onClick={backToPicker}
                className="mt-2 text-[11px] font-medium text-claude-accent dark:text-claude-darkAccent hover:underline"
              >
                {i18nService.t('mePurchaseBack')}
              </button>
            </div>
          )}

          {orderError && (
            <div className="rounded-xl border border-red-200 dark:border-red-800/70 bg-red-50/70 dark:bg-red-950/30 px-3 py-2.5">
              {errorCode === 'SUBSCRIPTION_REQUIRED' ? (
                <>
                  <p className="text-[11px] text-red-700 dark:text-red-300">{i18nService.t('mePurchaseNeedsBundle')}</p>
                  <button
                    type="button"
                    onClick={() => onSectionChange?.('subscribe')}
                    className="mt-1.5 text-[11px] font-medium text-claude-accent dark:text-claude-darkAccent hover:underline"
                  >
                    {i18nService.t('mePurchaseOpenPlans')}
                  </button>
                </>
              ) : (
                <p className="text-[11px] text-red-700 dark:text-red-300">
                  {i18nService.t('mePurchasePaymentFailed').replace('{error}', orderError)}
                </p>
              )}
            </div>
          )}

          <div className="space-y-0.5 rounded-xl bg-claude-surfaceHover/50 dark:bg-claude-darkSurfaceHover/40 px-3 py-2">
            {COMPLIANCE_LINES().map((line) => (
              <p key={line} className="text-[10px] leading-snug text-claude-textSecondary dark:text-claude-darkTextSecondary">· {line}</p>
            ))}
            <p className="text-[10px] leading-snug text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('mePurchaseRatesNote')}</p>
            {section === 'topup' && (
              <p className="text-[10px] leading-snug text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('mePurchaseTopupCapNote')}</p>
            )}
          </div>
        </div>

        {(phase === 'pick' || phase === 'creating') && canCreate && (
          <div className="sticky bottom-0 border-t border-claude-border/60 dark:border-claude-darkBorder/60 bg-claude-surface/95 dark:bg-claude-darkSurface/95 px-4 py-3 backdrop-blur">
            <button
              type="button"
              disabled={phase === 'creating'}
              onClick={() => void handleCreateOrder()}
              className="btn-idchat-primary-filled w-full rounded-xl px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === 'creating' ? i18nService.t('mePurchaseCreating') : i18nService.t('mePurchasePay')}
            </button>
          </div>
        )}

        {(phase === 'pick' || phase === 'creating') && section === 'subscribe' && isFreeSelected && (
          <div className="sticky bottom-0 border-t border-claude-border/60 dark:border-claude-darkBorder/60 bg-claude-surface/95 dark:bg-claude-darkSurface/95 px-4 py-3 backdrop-blur">
            <p className="text-center text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('mePurchaseFreeNote')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default MePurchaseFlow;
