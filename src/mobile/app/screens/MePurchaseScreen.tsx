import { ArrowLeftIcon, CheckCircleIcon, DocumentArrowUpIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import { getMobileElectron } from '../appBridge';
import { MeTierCards } from '../components/MeTierCards';
import { buildMePurchaseOrderRequest, submitMePurchaseOrder } from '../me/purchaseSubmit';
import { QrCanvas } from './recharge/QrCanvas';
import {
  formatMe,
  invalidateMeBalance,
  isMeSubscribed,
  loadMePaymentInfo,
  meActivePlanId,
  meFromMilli,
  mePaidPlans,
  mePeriodDays,
  mePeriodPrice,
  refreshMeCatalog,
  refreshMeTopupOrders,
  refreshMeTopupPackages,
  useMeStore,
  type MePeriod,
  type MobileMePaymentInfo,
} from '../me/mePointsStore';

/**
 * ME purchase / topup (S9 §5, first-phase manual voucher channel).
 *
 * Subscribe: tier -> period (month/quarter/year, prices from /v1/me/plans) -> payee QR seam
 * -> voucher upload (or remark) -> submit -> status visible in Usage & credits.
 * Topup: paid subscribers only (PRD §2.2); a free tier sees the
 * the "plan required" gate and the tier cards instead - and the backend's
 * SUBSCRIPTION_REQUIRED answer is surfaced verbatim if it still happens.
 *
 * iOS (capacitor) never gets the cashier: `canPurchase=false` swaps the whole
 * payment block for display-only guidance (Apple IAP policy), while the plan
 * catalog stays visible. Android/web keep the full channel.
 */

export type MePurchaseSection = 'subscribe' | 'topup';

type Phase = 'form' | 'submitting' | 'submitted';

const PERIODS: ReadonlyArray<{ id: MePeriod; labelKey: string }> = [
  { id: 'month', labelKey: 'mobile.me.purchase.periodMonth' },
  { id: 'quarter', labelKey: 'mobile.me.purchase.periodQuarter' },
  { id: 'year', labelKey: 'mobile.me.purchase.periodYear' },
];

interface VoucherState {
  path: string;
  url: string | null;
  label: string;
  signingError: string | null;
}

function fileNameFromPath(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export default function MePurchaseScreen(props: {
  section: MePurchaseSection;
  initialPlanId?: string;
  canPurchase: boolean;
  onClose: () => void;
  onSwitchSection: (section: MePurchaseSection) => void;
  onOpenUsage?: () => void;
  onSubmitted?: () => void;
}): JSX.Element {
  const snapshot = useMeStore();
  const [section, setSection] = useState<MePurchaseSection>(props.section);
  const [period, setPeriod] = useState<MePeriod>('month');
  const [selectedPlanId, setSelectedPlanId] = useState(props.initialPlanId ?? '');
  const [selectedPackageId, setSelectedPackageId] = useState('');
  const [payment, setPayment] = useState<MobileMePaymentInfo | null>(null);
  const [voucher, setVoucher] = useState<VoucherState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [remark, setRemark] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [submitError, setSubmitError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [orderId, setOrderId] = useState('');
  /** Server-priced amount from the created order — authoritative over the local tag. */
  const [serverPayAmount, setServerPayAmount] = useState<number | null>(null);
  const submittingRef = useRef(false);

  const paidPlans = useMemo(() => mePaidPlans(snapshot.plans), [snapshot.plans]);
  const activePlanId = meActivePlanId(snapshot.subscription);
  const subscribed = isMeSubscribed(snapshot.subscription);

  const effectivePlanId = selectedPlanId
    || (paidPlans.length > 0 ? paidPlans[Math.min(1, paidPlans.length - 1)].planId : '');
  const selectedPlan = paidPlans.find((plan) => plan.planId === effectivePlanId) ?? null;
  const selectedPackage = snapshot.topupPackages.find((pkg) => pkg.packageId === selectedPackageId)
    ?? snapshot.topupPackages[0]
    ?? null;
  const localAmountDue = section === 'subscribe'
    ? mePeriodPrice(selectedPlan, period)
    : (typeof selectedPackage?.priceCny === 'number' ? selectedPackage.priceCny : null);
  // A submitted order's server-priced amount wins until the subject or period
  // changes (reset below) — the server charges exactly that number.
  const amountDue = serverPayAmount ?? localAmountDue;
  const days = mePeriodDays(selectedPlan, period);

  // A stale server amount from a previous order must not leak into a newly
  // chosen subject/period: the local tag takes over until the next order.
  useEffect(() => {
    setServerPayAmount(null);
  }, [section, effectivePlanId, selectedPackageId, period]);

  useEffect(() => {
    setSection(props.section);
    setPhase('form');
    setSubmitError('');
    setErrorCode('');
    setVoucher(null);
    setRemark('');
    setSelectedPlanId(props.initialPlanId ?? '');
    void loadMePaymentInfo().then(setPayment);
    void refreshMeTopupPackages();
  }, [props.section, props.initialPlanId]);

  const pickVoucher = useCallback(async () => {
    setUploading(true);
    setUploadError('');
    try {
      const selectFile = getMobileElectron().dialog.selectFile as unknown as (options: Record<string, unknown>) => Promise<{
        success?: boolean;
        path?: string | null;
        error?: string;
      }>;
      const picked = await selectFile({
        title: t('mobile.me.purchase.voucherPick'),
        source: 'photos',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (!picked?.success || !picked.path) {
        if (picked?.error) setUploadError(picked.error);
        return;
      }
      const path = picked.path;
      let url: string | null = null;
      let signingError: string | null = null;
      try {
        const signed = await getMobileElectron().gateway.fileSign({ path, disposition: 'inline' });
        if ('url' in signed && typeof signed.url === 'string') url = signed.url;
        else if ('error' in signed) signingError = signed.error;
      } catch (error) {
        signingError = error instanceof Error ? error.message : t('mobile.me.purchase.voucherFailed');
      }
      setVoucher({
        path,
        url,
        label: fileNameFromPath(path),
        signingError,
      });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : t('mobile.me.purchase.voucherFailed'));
    } finally {
      setUploading(false);
    }
  }, []);

  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    const defaultRemark = section === 'subscribe' && selectedPlan
      ? `${t('mobile.me.purchase.subscribeTitle')} ${selectedPlan.name} / ${t(PERIODS.find((p) => p.id === period)!.labelKey)}`
      : selectedPackage
        ? `${t('mobile.me.purchase.topupTitle')} ${selectedPackage.packageId}`
        : '';
    const voucherRemark = remark.trim() || (voucher ? '' : defaultRemark);
    const request = buildMePurchaseOrderRequest({
      section,
      planId: selectedPlan?.planId,
      packageId: selectedPackage?.packageId,
      period,
      voucherUrl: voucher?.url ?? undefined,
      voucherRemark: voucherRemark || undefined,
    });
    if (!request) return;
    if (!voucher && !voucherRemark) {
      setSubmitError(t('mobile.me.purchase.voucherRequired'));
      return;
    }
    submittingRef.current = true;
    setPhase('submitting');
    setSubmitError('');
    setErrorCode('');
    try {
      const result = await submitMePurchaseOrder(window.electron.mePoints, request);
      if (result.ok) {
        setOrderId(result.orderId);
        setServerPayAmount(typeof result.payAmount === 'number' ? result.payAmount : null);
        setPhase('submitted');
        invalidateMeBalance();
        void refreshMeTopupOrders();
        props.onSubmitted?.();
      } else {
        setPhase('form');
        setSubmitError(result.error || t('mobile.me.purchase.errorTitle'));
        setErrorCode(result.errorCode || '');
      }
    } catch (error) {
      setPhase('form');
      setSubmitError(error instanceof Error ? error.message : t('mobile.me.purchase.errorTitle'));
    } finally {
      submittingRef.current = false;
    }
  }, [section, selectedPlan, selectedPackage, period, days, voucher, remark, props]);

  const needSubscriptionGate = section === 'topup' && !subscribed && !snapshot.subscriptionLoading;
  const isSubRequired = errorCode === 'SUBSCRIPTION_REQUIRED';
  const title = section === 'subscribe' ? t('mobile.me.purchase.subscribeTitle') : t('mobile.me.purchase.topupTitle');

  return (
    <div className="twin-page h-full" data-testid="me-purchase-page" data-section={section}>
      <div
        className="twin-topbar twin-topbar-simple shrink-0"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}
      >
        <button type="button" onClick={props.onClose} className="me-back" aria-label={t('mobile.common.back')}>
          <ArrowLeftIcon className="h-5 w-5" aria-hidden />
          <span>{title}</span>
        </button>
        <button type="button" className="me-close-text" onClick={props.onClose}>
          {t('mobile.common.close')}
        </button>
      </div>

      <div className="twin-scroll space-y-3 p-3">
        {section === 'subscribe' && phase !== 'submitted' ? (
          <MeTierCards
            plans={snapshot.plans}
            loading={snapshot.plansLoading}
            error={snapshot.plansError}
            activePlanId={activePlanId}
            selectedPlanId={effectivePlanId}
            onChoose={(planId) => {
              setSelectedPlanId(planId);
              setErrorCode('');
            }}
            onRetry={() => void refreshMeCatalog()}
          />
        ) : null}

        {section === 'subscribe' && phase !== 'submitted' ? (
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
            <p className="me-period-note">
              {t('mobile.me.purchase.periodNote', { days })}
            </p>
          </section>
        ) : null}

        {needSubscriptionGate ? (
          <section className="twin-panel twin-panel-padded" data-testid="me-topup-gate">
            <div className="me-gate-head">
              <ExclamationTriangleIcon className="h-5 w-5 text-[var(--twin-warning)]" aria-hidden />
              <h2 className="me-usage-title">{t('mobile.me.purchase.subRequiredTitle')}</h2>
            </div>
            <p className="me-gate-body">{t('mobile.me.purchase.subRequiredBody')}</p>
            <button
              type="button"
              className="twin-button twin-button-primary twin-button-full mt-3"
              onClick={() => {
                setSection('subscribe');
                props.onSwitchSection('subscribe');
              }}
            >
              {t('mobile.me.purchase.openPlans')}
            </button>
          </section>
        ) : null}

        {section === 'topup' && !needSubscriptionGate && phase !== 'submitted' ? (
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

        {phase === 'submitted' ? (
          <section className="twin-panel twin-panel-padded me-success" data-testid="me-purchase-submitted">
            <CheckCircleIcon className="me-success-icon" aria-hidden />
            <h2 className="me-usage-title">{t('mobile.me.purchase.submittedTitle')}</h2>
            <p className="me-gate-body">{t('mobile.me.purchase.submittedBody')}</p>
            {orderId ? <p className="me-success-order">{orderId}</p> : null}
            {serverPayAmount != null ? (
              <p className="me-success-order" data-testid="me-purchase-server-amount">
                {t('mobile.me.purchase.submittedAmount', { price: serverPayAmount })}
              </p>
            ) : null}
            {props.onOpenUsage ? (
              <button
                type="button"
                className="twin-button twin-button-primary twin-button-full mt-3"
                onClick={props.onOpenUsage}
              >
                {t('mobile.me.purchase.openUsage')}
              </button>
            ) : null}
            <button type="button" className="twin-button twin-button-ghost twin-button-full mt-2" onClick={props.onClose}>
              {t('mobile.me.purchase.done')}
            </button>
          </section>
        ) : null}

        {!props.canPurchase && phase !== 'submitted' ? (
          <section className="twin-panel twin-panel-padded" data-testid="me-ios-guidance">
            <h2 className="me-usage-title">{t('mobile.me.purchase.iosTitle')}</h2>
            <p className="me-gate-body">{t('mobile.me.purchase.iosBody')}</p>
            <button type="button" className="twin-button twin-button-secondary twin-button-full mt-3" onClick={props.onClose}>
              {t('mobile.me.purchase.done')}
            </button>
          </section>
        ) : null}

        {props.canPurchase && phase !== 'submitted' && !needSubscriptionGate ? (
          <>
            <section className="twin-panel twin-panel-padded" data-testid="me-payment-card">
              <div className="me-pay-head">
                <h2 className="me-usage-title">{t('mobile.me.purchase.payTitle')}</h2>
                <span className="me-pay-amount">
                  {amountDue == null ? '—' : t('mobile.me.purchase.amountDue', { price: amountDue })}
                </span>
              </div>
              {payment?.qrContent ? (
                <div className="me-qr-wrap">
                  <QrCanvas value={payment.qrContent} size={188} />
                  <p className="me-qr-hint">{payment.payeeHint || t('mobile.me.purchase.payHint')}</p>
                </div>
              ) : (
                <div className="me-qr-placeholder" data-testid="me-payment-placeholder">
                  <span className="me-qr-placeholder-mark" aria-hidden>
                    QR
                  </span>
                  <p>{t('mobile.me.purchase.payUnavailable')}</p>
                </div>
              )}
            </section>

            <section className="twin-panel twin-panel-padded" data-testid="me-voucher-card">
              <h2 className="me-usage-title mb-2">{t('mobile.me.purchase.voucherTitle')}</h2>
              <button
                type="button"
                className="twin-button twin-button-secondary twin-button-full"
                onClick={() => void pickVoucher()}
                disabled={uploading || phase === 'submitting'}
              >
                <DocumentArrowUpIcon className="h-4 w-4" aria-hidden />
                {uploading ? t('mobile.me.purchase.voucherUploading') : t('mobile.me.purchase.voucherPick')}
              </button>
              {voucher ? (
                <p className="me-voucher-file" data-testid="me-voucher-picked">
                  {t('mobile.me.purchase.voucherPicked', { name: voucher.label })}
                </p>
              ) : null}
              {voucher?.signingError ? (
                <p className="me-inline-error">{t('mobile.me.purchase.voucherLinkFailed')}</p>
              ) : null}
              {uploadError ? <p className="me-inline-error">{uploadError}</p> : null}
              <label className="me-field-label" htmlFor="me-remark">
                {t('mobile.me.purchase.remarkLabel')}
              </label>
              <textarea
                id="me-remark"
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                rows={2}
                maxLength={200}
                placeholder={t('mobile.me.purchase.remarkPlaceholder')}
                className="me-textarea"
              />
            </section>

            {submitError ? (
              <div className="twin-notice twin-notice-error" data-testid="me-purchase-error">
                <p className="text-sm font-semibold">{isSubRequired ? t('mobile.me.purchase.subRequiredTitle') : t('mobile.me.purchase.errorTitle')}</p>
                <p className="mt-1 text-xs">{isSubRequired ? t('mobile.me.purchase.subRequiredBody') : submitError}</p>
                {isSubRequired ? (
                  <button
                    type="button"
                    className="twin-button twin-button-primary twin-button-full mt-2"
                    onClick={() => {
                      setSection('subscribe');
                      setErrorCode('');
                      props.onSwitchSection('subscribe');
                    }}
                  >
                    {t('mobile.me.purchase.openPlans')}
                  </button>
                ) : null}
              </div>
            ) : null}

            <button
              type="button"
              className="twin-button twin-button-primary twin-button-full"
              data-testid="me-purchase-submit"
              disabled={phase === 'submitting' || (section === 'subscribe' ? !selectedPlan : !selectedPackage)}
              onClick={() => void submit()}
            >
              {phase === 'submitting' ? t('mobile.me.purchase.submitting') : t('mobile.me.purchase.submit')}
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
