/**
 * Shared ME purchase flow modal (S9 §5 首期人工凭证通道).
 *
 * Two sections over the same voucher channel:
 * - 订阅: pick tier → pick period (月/季/年, desktop prices from
 *   /v1/me/plans: monthly desktopPriceCny, quarterly desktop×3×discount,
 *   annual annualPriceCny) → 收款说明 → 凭证上传（截图 + 备注）→ 提交。
 * - 充值: pick topup package (visible to PAID subscribers only — free tier
 *   must NOT see a recharge entry, PRD §2.2; they see the 需先开通套餐 hint
 *   and the tier cards instead) → same voucher steps → topup_submit.
 *
 * Backend error codes surface verbatim from the client contract:
 * SUBSCRIPTION_REQUIRED → the 需先开通套餐 hint + open-plans shortcut.
 * Order status is visible in the usage & credits page.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { buildAlipayVariantCUrl } from '../chat/paymentCardSyntax';
import {
  XMarkIcon,
  DocumentArrowUpIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { MeTopupPackageInfo } from '../../types/electron';
import {
  ensureMeSnapshot,
  formatMe,
  getMeSnapshot,
  invalidateMeSnapshot,
  isMeEffectivelySubscribed,
  meFromMilli,
  requestOpenUsagePage,
  subscribeMeSnapshot,
  type MePurchaseSection,
} from './mePointsStore';

const COMPLIANCE_LINES = (): string[] => [
  i18nService.t('meComplianceWeekly'),
  i18nService.t('meCompliancePersistent'),
  i18nService.t('meComplianceNoCash'),
  i18nService.t('meComplianceFallback'),
];

type SubmitPhase = 'idle' | 'submitting' | 'submitted' | 'error';

interface MePurchaseFlowProps {
  open: boolean;
  section: MePurchaseSection;
  onSectionChange?: (section: MePurchaseSection) => void;
  onClose: () => void;
}

const pricePeriodLabel = (value: number | null | undefined): string =>
  value != null && Number.isFinite(value) ? `${value}` : '—';

interface MeVoucherState {
  fileLabel: string;
  voucherUrl: string | null;
  signedError: string | null;
}

const EMPTY_VOUCHER: MeVoucherState = { fileLabel: '', voucherUrl: null, signedError: null };

const MePurchaseFlow: React.FC<MePurchaseFlowProps> = ({ open, section, onSectionChange, onClose }) => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const [selectedPackageId, setSelectedPackageId] = useState<string>('');
  const [period, setPeriod] = useState<'month' | 'quarter' | 'year'>('month');
  const [remark, setRemark] = useState('');
  const [voucher, setVoucher] = useState<MeVoucherState>(EMPTY_VOUCHER);
  const [phase, setPhase] = useState<SubmitPhase>('idle');
  const [submitError, setSubmitError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [pending, setPending] = useState(false);
  const [topupPackages, setTopupPackages] = useState<MeTopupPackageInfo[]>([]);
  const [payQr, setPayQr] = useState<{ qrContent: string; payeeHint: string; qrImageDataUrl?: string } | null>(null);
  const [payQrImage, setPayQrImage] = useState<string | null>(null);

  const plans = snapshot.plans.filter((plan) => plan.tier !== 'free');
  const subscribed = isMeEffectivelySubscribed(snapshot.subscription);

  useEffect(() => {
    if (!open) return;
    ensureMeSnapshot();
    setPhase('idle');
    setSubmitError('');
    setErrorCode('');
    setVoucher(EMPTY_VOUCHER);
    setRemark('');
    setPeriod('month');
    setTopupPackages([]);
    if (section === 'topup') {
      void window.electron.mePoints.getTopupPackages().then((res) => {
        if (res.success && Array.isArray(res.topupPackages)) {
          setTopupPackages(res.topupPackages);
          setSelectedPackageId((current) =>
            current && res.topupPackages!.some((pkg) => pkg.packageId === current)
              ? current
              : (res.topupPackages![0]?.packageId ?? ''),
          );
        }
      });
    }
    void window.electron.mePoints.getPaymentInfo().then((res) => {
      if (res.success && res.payment) setPayQr(res.payment);
    });
    // 默认选中中间档（通常为性价比档）；保持用户已选项。
    setSelectedPlanId((current) => {
      if (current && plans.some((plan) => plan.planId === current)) return current;
      return plans.length > 0 ? plans[Math.min(1, plans.length - 1)].planId : '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, section]);

  // 计划列表为异步加载：首次渲染时 plans 还是空的，回落到中间档作为默认选中，
  // 避免「档位卡已出现但周期/支付区不出现」的空白态。
  const effectivePlanId =
    selectedPlanId ||
    (plans.length > 0 ? plans[Math.min(1, plans.length - 1)].planId : '');
  const selectedPlan = plans.find((plan) => plan.planId === effectivePlanId) ?? null;
  const selectedTopup = topupPackages.find((pkg) => pkg.packageId === selectedPackageId) ?? null;

  /** Desktop price for the chosen period — all inputs live from plans data. */
  const periodPrice = useMemo(() => {
    if (!selectedPlan) return null;
    const monthly = selectedPlan.desktopPriceCny ?? selectedPlan.priceCny ?? null;
    if (monthly == null) return null;
    if (period === 'month') return monthly;
    if (period === 'quarter') {
      const discountPct = selectedPlan.quarterlyDiscountPct;
      return Math.round(monthly * 3 * (discountPct && discountPct > 0 && discountPct < 100 ? discountPct / 100 : 1));
    }
    return selectedPlan.annualPriceCny ?? Math.round(monthly * 12);
  }, [selectedPlan, period]);

  const voucherRemarkFor = useCallback((): string => {
    if (section === 'subscribe' && selectedPlan) {
      return `订阅 ${selectedPlan.planId} / ${i18nService.t(`mePurchasePeriod_${period}`)}`;
    }
    if (section === 'topup' && selectedTopup) return `充值包 ${selectedTopup.packageId}`;
    return '';
  }, [section, selectedPlan, selectedTopup, period]);

  const pickVoucher = useCallback(async () => {
    setPending(true);
    try {
      const res = await window.electron.mePoints.pickVoucher({});
      if (res.success && res.fileLabel) {
        setVoucher({
          fileLabel: res.fileLabel,
          voucherUrl: res.voucherUrl ?? null,
          signedError: res.signedUrlError ?? null,
        });
      }
    } finally {
      setPending(false);
    }
  }, []);

  const submit = useCallback(async () => {
    // S9-A: the two sections post to different endpoints. 订阅 sends
    // planId + period + channel to /v1/me/subscription/order (a planId is NOT
    // a topup packageId — that mismatch is why a free user could never open a
    // subscription); 充值 keeps the unchanged topup submit.
    const planId = section === 'subscribe' ? selectedPlan?.planId : undefined;
    const packageId = section === 'topup' ? selectedTopup?.packageId : undefined;
    const subjectId = planId || packageId;
    if (!subjectId) return;
    const voucherRemark = remark.trim() || voucherRemarkFor();
    if (!voucher.voucherUrl && !voucherRemark) {
      setPhase('error');
      setSubmitError(i18nService.t('mePurchaseVoucherRequired'));
      return;
    }
    setPhase('submitting');
    setSubmitError('');
    setErrorCode('');
    const voucherFields = {
      voucherUrl: voucher.voucherUrl ?? undefined,
      voucherRemark,
      idempotencyKey: `ui-${section}-${subjectId}-${Date.now()}`,
    };
    const res = section === 'subscribe'
      ? await window.electron.mePoints.submitSubscriptionOrder({
        planId,
        period,
        channel: 'desktop',
        ...voucherFields,
      })
      : await window.electron.mePoints.submitTopupOrder({
        packageId,
        ...voucherFields,
      });
    if (res.success) {
      setPhase('submitted');
      invalidateMeSnapshot();
    } else {
      setPhase('error');
      setSubmitError(res.error || 'submit failed');
      setErrorCode(res.errorCode || '');
    }
  }, [section, selectedPlan, selectedTopup, period, remark, voucher, voucherRemarkFor]);

  useEffect(() => {
    // S9 v1.2: prefer the owner-uploaded payee QR image (收款设置 page); only
    // synthesize one from qrContent when no image was archived.
    if (payQr?.qrImageDataUrl) {
      setPayQrImage(payQr.qrImageDataUrl);
      return;
    }
    if (!payQr?.qrContent) {
      setPayQrImage(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(payQr.qrContent, { margin: 1, width: 240 })
      .then((url) => {
        if (!cancelled) setPayQrImage(url);
      })
      .catch(() => {
        if (!cancelled) setPayQrImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [payQr]);

  // S9 v1.2: one merchant account serves every tier — launch Alipay directly
  // (variant C, real-device tested in S3) instead of asking the user to scan.
  // Desktop Electron without an Alipay handler silently no-ops, so the QR and
  // the note stay on screen as the fallback rather than being hidden.
  const payLaunchUrl = payQr?.qrContent ? buildAlipayVariantCUrl(payQr.qrContent) : null;

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: string }>).detail;
      if (detail?.section === 'subscribe' || detail?.section === 'topup') {
        setPhase('idle');
        setErrorCode('');
        setSubmitError('');
        onSectionChange?.(detail.section);
      }
    };
    window.addEventListener('me:purchaseSwitchSection', listener);
    return () => window.removeEventListener('me:purchaseSwitchSection', listener);
  }, [onSectionChange]);

  if (!open) return null;

  const isSubRequired = errorCode === 'SUBSCRIPTION_REQUIRED';
  const canShowPay = section === 'subscribe'
    ? !!selectedPlan
    : section === 'topup' && subscribed
      ? !!selectedTopup
      : false;
  const amountDue = section === 'subscribe' ? periodPrice : selectedTopup?.priceCny ?? null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={phase === 'submitting' ? undefined : onClose} />
      <div className="relative w-[560px] max-h-[86vh] overflow-y-auto rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-claude-border/60 dark:border-claude-darkBorder/60 bg-claude-surface/95 dark:bg-claude-darkSurface/95 px-4 py-3 backdrop-blur">
          <h3 className="text-sm font-semibold text-claude-text dark:text-claude-darkText">
            {section === 'subscribe' ? i18nService.t('mePurchaseTitle') : i18nService.t('mePurchaseTopupTitle')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-4">
          {snapshot.plansLoading && plans.length === 0 && (
            <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('loading')}</p>
          )}

          {section === 'subscribe' && (
            <div className="space-y-2">
              {plans.map((plan, index) => (
                <button
                  key={plan.planId}
                  type="button"
                  disabled={phase === 'submitting'}
                  onClick={() => setSelectedPlanId(plan.planId)}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    effectivePlanId === plan.planId
                      ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                      : 'border-claude-border dark:border-claude-darkBorder hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-claude-text dark:text-claude-darkText">{plan.name}</span>
                    <span className="tabular-nums text-xs text-claude-text dark:text-claude-darkText">
                      {i18nService.t('mePlanPriceMonthly')
                        .replace('{price}', pricePeriodLabel(plan.desktopPriceCny ?? plan.priceCny))}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary truncate">
                      {i18nService.t('mePlanHighlightWeekly').replace('{me}', formatMe(meFromMilli(plan.weeklyAmountMilli)))}
                    </span>
                    {index === 1 && (
                      <span className="shrink-0 text-[10px] text-claude-accent dark:text-claude-darkAccent">
                        {i18nService.t('mePlanPopularBadge')}
                      </span>
                    )}
                  </div>
                </button>
              ))}

              {selectedPlan && (
                <div className="rounded-xl border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 px-3 py-2.5">
                  <span className="text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('mePurchasePeriod')}
                  </span>
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    {(['month', 'quarter', 'year'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        disabled={phase === 'submitting'}
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
            </div>
          )}

          {section === 'topup' && (
            subscribed ? (
              <div className="space-y-2">
                {topupPackages.map((pkg) => (
                  <button
                    key={pkg.packageId}
                    type="button"
                    disabled={phase === 'submitting'}
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
                        {pricePeriodLabel(pkg.priceCny)} {i18nService.t('mePurchaseCny')}
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
              /* 免费档：充值入口隐藏（不是置灰），只给提示 + 升级路径（PRD §2.2） */
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

          {/* 收款码 / 支付说明 */}
          {canShowPay && (
            <div className="rounded-xl border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 px-3 py-3 space-y-1.5">
              {payLaunchUrl ? (
                <div className="space-y-1 pb-1">
                  <button
                    type="button"
                    onClick={() => {
                      // Variant C opens Alipay at the payee's receive page; the
                      // amount is shown above and copied into the note field.
                      window.location.href = payLaunchUrl;
                    }}
                    className="btn-idchat-primary-filled w-full rounded-lg px-3 py-2 text-[12px] font-medium"
                  >
                    {i18nService.t('mePurchasePayNow')}
                  </button>
                  <p className="text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('mePurchasePayFallback')}
                  </p>
                </div>
              ) : null}
              {/* 收款码：平台下发的 QR 内容（ME_PAY_QR_CONTENT）；未下发时如实占位，不伪造可扫码图 */}
              <div className="flex items-start gap-3 pb-1">
                <div className="flex h-[132px] w-[132px] shrink-0 items-center justify-center rounded-xl border border-dashed border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface">
                  {payQrImage ? (
                    <img src={payQrImage} alt={i18nService.t('mePurchaseQrAlt')} className="h-[120px] w-[120px] rounded-lg" />
                  ) : (
                    <span className="px-2 text-center text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('mePurchaseQrUnavailable')}
                    </span>
                  )}
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-[11px] font-medium text-claude-text dark:text-claude-darkText">
                    {i18nService.t('mePurchaseQrTitle')}
                  </p>
                  <p className="text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('mePurchaseQrHint').replace('{remark}', voucherRemarkFor())}
                  </p>
                  {payQr?.payeeHint ? (
                    <p className="text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{payQr.payeeHint}</p>
                  ) : null}
                </div>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('mePurchaseAmountDue')}
                </span>
                <span className="tabular-nums text-base font-semibold text-claude-text dark:text-claude-darkText">
                  {pricePeriodLabel(amountDue)}
                  <span className="ml-0.5 text-[10px] font-normal">{i18nService.t('mePurchaseCny')}</span>
                </span>
              </div>
            </div>
          )}

          {/* 凭证上传 */}
          {canShowPay && (
            <div className="space-y-2">
              <button
                type="button"
                disabled={phase === 'submitting' || pending}
                onClick={() => void pickVoucher()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-claude-border dark:border-claude-darkBorder px-2.5 py-1.5 text-[11px] font-medium text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <DocumentArrowUpIcon className="h-3.5 w-3.5" />
                {i18nService.t('mePurchaseVoucherPick')}
              </button>
              {voucher.fileLabel && (
                <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('mePurchaseVoucherPicked').replace('{name}', voucher.fileLabel)}
                </p>
              )}
              {voucher.signedError && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400">{voucher.signedError}</p>
              )}
              <label className="block text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('mePurchaseRemarkLabel')}
              </label>
              <textarea
                value={remark}
                disabled={phase === 'submitting'}
                onChange={(event) => setRemark(event.target.value)}
                rows={2}
                className="w-full rounded-xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurfaceInset text-xs text-claude-text dark:text-claude-darkText px-3 py-2 focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30"
                placeholder={i18nService.t('mePurchaseRemarkPlaceholder')}
              />
            </div>
          )}

          {phase === 'submitted' && (
            <div className="rounded-xl border border-green-200 dark:border-green-800/70 bg-green-50/70 dark:bg-green-950/30 px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-green-700 dark:text-green-300">
                <CheckCircleIcon className="mr-1 inline h-3.5 w-3.5" />
                {i18nService.t('mePurchaseSubmitted')}
              </p>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  requestOpenUsagePage();
                }}
                className="mt-1.5 text-[11px] font-medium text-green-700 dark:text-green-300 hover:underline"
              >
                {i18nService.t('mePurchaseViewOrders')}
              </button>
            </div>
          )}

          {phase === 'error' && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-800/70 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2.5">
              {isSubRequired ? (
                <>
                  <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
                    {i18nService.t('mePurchaseNeedsBundle')}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      onSectionChange?.('subscribe');
                    }}
                    className="mt-1.5 text-[11px] font-medium text-claude-accent dark:text-claude-darkAccent hover:underline"
                  >
                    {i18nService.t('mePurchaseOpenPlans')}
                  </button>
                </>
              ) : (
                <p className="text-[11px] text-amber-800 dark:text-amber-300">
                  {i18nService.t('mePurchaseSubmitFailed').replace('{error}', submitError)}
                </p>
              )}
            </div>
          )}

          {/* 合规四条（必展示，S9 §5 / 接入指南 §6） */}
          <div className="rounded-xl bg-claude-surfaceHover/50 dark:bg-claude-darkSurfaceHover/40 px-3 py-2.5 space-y-1">
            {COMPLIANCE_LINES().map((line) => (
              <p key={line} className="text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                · {line}
              </p>
            ))}
            <p className="text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('mePurchaseRatesNote')}
            </p>
            {section === 'topup' && (
              <p className="text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('mePurchaseTopupCapNote')}
              </p>
            )}
          </div>
        </div>

        {canShowPay && phase !== 'submitted' && (
          <div className="sticky bottom-0 border-t border-claude-border/60 dark:border-claude-darkBorder/60 bg-claude-surface/95 dark:bg-claude-darkSurface/95 px-4 py-3 backdrop-blur">
            <button
              type="button"
              disabled={phase === 'submitting' || pending}
              onClick={() => void submit()}
              className="btn-idchat-primary-filled w-full rounded-xl px-3 py-2 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {phase === 'submitting' ? i18nService.t('mePurchaseSubmitting') : i18nService.t('mePurchaseSubmit')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default MePurchaseFlow;
