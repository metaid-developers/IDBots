/**
 * PaymentCard — a fiat (Alipay point-to-point) payment card rendered from a
 * `pay-card` fence in any markdown surface (design doc 01, S3 slice).
 *
 * Behavior contract (acceptance): the「前往支付宝付款」button launches
 * variant C (alipays://platformapi/startapp?saId=10000007&qrcode=…); if the
 * page does not hide within 2s (no visibilitychange/pagehide/blur), the card
 * auto-degrades to the embedded fallback — QR re-rendered from the payee's
 * qrContent, amount, memo, copy buttons — plus a standing manual fallback
 * entry. 「付款后回来点我已支付」writes one local pending-verification
 * record (orderId/amount/memo/time); personal transfers have no callback
 * API, so the loop closes on evidence + seller confirmation, never on
 * auto-reconciliation. The card never claims the platform touches funds.
 *
 * Desktop note (doc 01 §4): the main process hands the exact variant-C URL
 * to the OS (paymentLaunchUrl.ts), so Electron does open the Alipay app. The
 * page itself never hides (the app is a separate process), so the same 2s
 * watchdog still degrades to the QR card underneath the opened app — the QR
 * stays the standing fallback, not a failure signal.
 *
 * Display-only besides the launch attempt, the local record write, and the
 * QR re-render (all local; no network side effects).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  CheckCircleIcon,
  ClipboardDocumentCheckIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';
import {
  buildAlipayVariantCUrl,
  formatCentsToYuan,
  type PaymentCardData,
} from './paymentCardSyntax';
import { startLaunchWatchdog, type LaunchWatchdog } from './paymentLaunchWatchdog';
import {
  addPendingPaymentRecord,
  hasPendingPaymentRecord,
} from './paymentPendingRecords';

type CardPhase = 'ready' | 'launching' | 'degraded';

const QR_RENDER_WIDTH = 220;

const PaymentCard: React.FC<{ data: PaymentCardData }> = ({ data }) => {
  const { orderId, amountCents, payee } = data;
  const amountYuan = useMemo(() => formatCentsToYuan(amountCents), [amountCents]);

  const [phase, setPhase] = useState<CardPhase>('ready');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [paidRecorded, setPaidRecorded] = useState(() => hasPendingPaymentRecord(orderId));
  const [copied, setCopied] = useState<'amount' | 'memo' | null>(null);
  const watchdogRef = useRef<LaunchWatchdog | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const launchCleanupRef = useRef<(() => void) | null>(null);

  const clearLaunchListeners = useCallback(() => {
    launchCleanupRef.current?.();
    launchCleanupRef.current = null;
  }, []);

  // Re-render the QR from the payee's qrContent (doc 02 §2: the card shows a
  // freshly generated code, never re-transmits the seller's image).
  useEffect(() => {
    if (phase !== 'degraded' || !payee.qrContent) return;
    let cancelled = false;
    QRCode.toDataURL(payee.qrContent, { margin: 1, width: QR_RENDER_WIDTH })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, payee.qrContent]);

  // Tear down the watchdog + hide listeners when leaving the launching phase.
  useEffect(() => {
    return () => {
      watchdogRef.current?.cancel();
      watchdogRef.current = null;
      launchCleanupRef.current?.();
      launchCleanupRef.current = null;
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const markLaunched = useCallback(() => {
    watchdogRef.current?.succeed();
  }, []);

  const handleLaunch = useCallback(() => {
    if (phase === 'launching') return;
    const url = buildAlipayVariantCUrl(payee.qrContent ?? '');
    if (!url) {
      // No valid receiving code: the degrade card IS the payment path (the
      // buyer screenshots/long-presses the code in the Alipay app).
      setPhase('degraded');
      return;
    }
    setPhase('launching');

    // Any hide signal within the 2s window means Alipay took over. When the
    // buyer comes back (visibility → visible / window focus) the entry must
    // re-arm instead of staying on a disabled 「正在拉起支付宝…」 forever
    // (doc 01 §4 PWA focus-recovery note).
    const onHidden = () => markLaunched();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') markLaunched();
      else {
        clearLaunchListeners();
        setPhase((current) => (current === 'launching' ? 'ready' : current));
      }
    };
    const onFocus = () => {
      clearLaunchListeners();
      setPhase((current) => (current === 'launching' ? 'ready' : current));
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onHidden);
    window.addEventListener('blur', onHidden);
    window.addEventListener('focus', onFocus);
    launchCleanupRef.current = () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onHidden);
      window.removeEventListener('blur', onHidden);
      window.removeEventListener('focus', onFocus);
    };
    watchdogRef.current = startLaunchWatchdog(() => {
      clearLaunchListeners();
      setPhase('degraded');
    });
    // Gesture-synchronous assignment (doc 01 §4: within the click handler so
    // mobile browsers do not treat it as a popup).
    window.location.href = url;
  }, [phase, payee.qrContent, markLaunched, clearLaunchListeners]);

  const handleManualFallback = useCallback(() => {
    watchdogRef.current?.cancel();
    clearLaunchListeners();
    setPhase('degraded');
  }, [clearLaunchListeners]);

  const handleCopy = useCallback(async (kind: 'amount' | 'memo') => {
    const text = kind === 'amount' ? amountYuan : orderId;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard may be denied; the values stay visible for manual copy.
    }
  }, [amountYuan, orderId]);

  const handlePaidConfirm = useCallback(() => {
    addPendingPaymentRecord({
      orderId,
      amountCents,
      memo: orderId,
      recordedAt: Date.now(),
    });
    setPaidRecorded(true);
  }, [orderId, amountCents]);

  const canLaunch = Boolean(payee.qrContent);

  return (
    <div className="my-[12px] max-w-[380px] overflow-hidden rounded-xl border border-claude-border bg-claude-surface shadow-subtle dark:border-claude-darkBorder dark:bg-claude-darkSurface">
      {/* ① header: amount + order id (always visible) */}
      <div className="flex items-start justify-between gap-2 border-b border-claude-border px-3 py-2 dark:border-claude-darkBorder">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[13px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">¥</span>
            <span className="text-[20px] font-semibold leading-6 text-claude-text dark:text-claude-darkText">{amountYuan}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            <span className="truncate">{orderId}</span>
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
          {payee.displayName ? `收款方 ${payee.displayName}` : '支付宝收款'}
        </span>
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        {phase !== 'degraded' ? (
          <>
            {/* ② launch button (variant C) */}
            <button
              type="button"
              onClick={handleLaunch}
              disabled={!canLaunch || phase === 'launching'}
              className="w-full rounded-lg bg-[#1677FF] px-3 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === 'launching' ? '正在拉起支付宝…' : '前往支付宝付款'}
            </button>
            <p className="text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">
              请勿修改金额与备注；转账直接进入卖方账户，平台不经手资金。
            </p>
            {!canLaunch && (
              <p className="text-[11px] leading-4 text-amber-600 dark:text-amber-400">
                卖方尚未配置收款码——请让卖方在「设置 → 收款信息」中补充后再付款。
              </p>
            )}
            {/* ④ standing manual fallback entry (doc 01 §3: always available) */}
            <button
              type="button"
              onClick={handleManualFallback}
              className="self-start text-[11px] text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
            >
              打不开？出示收款码
            </button>
          </>
        ) : (
          <>
            {/* ③ embedded degrade card: QR + amount + memo + copies */}
            <div className="flex flex-col items-center gap-2 rounded-lg border border-claude-border bg-white px-3 py-3 dark:border-claude-darkBorder dark:bg-white">
              {!payee.qrContent ? (
                <div className="flex h-[180px] w-[180px] items-center justify-center px-4 text-center text-[11px] text-gray-500">
                  卖方尚未配置收款码，请先与卖方确认收款方式
                </div>
              ) : qrDataUrl ? (
                <img src={qrDataUrl} alt="支付宝收款码" className="h-[180px] w-[180px]" />
              ) : qrFailed ? (
                <div className="flex h-[180px] w-[180px] items-center justify-center px-4 text-center text-[11px] text-gray-500">
                  收款码生成失败——请让卖方重新发卡或复制下方链接
                </div>
              ) : (
                <div className="flex h-[180px] w-[180px] items-center justify-center text-[11px] text-gray-400">
                  收款码生成中…
                </div>
              )}
              <div className="text-[16px] font-semibold text-[#1677FF]">¥{amountYuan}</div>
              <div className="max-w-full truncate font-mono text-[11px] text-gray-500">备注 {orderId}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleCopy('amount')}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-claude-border px-2 py-1.5 text-[12px] text-claude-text transition-colors hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkText dark:hover:bg-claude-darkSurfaceHover"
              >
                {copied === 'amount' ? <ClipboardDocumentCheckIcon className="h-4 w-4 text-emerald-500" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
                复制金额
              </button>
              <button
                type="button"
                onClick={() => handleCopy('memo')}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-claude-border px-2 py-1.5 text-[12px] text-claude-text transition-colors hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkText dark:hover:bg-claude-darkSurfaceHover"
              >
                {copied === 'memo' ? <ClipboardDocumentCheckIcon className="h-4 w-4 text-emerald-500" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
                复制备注
              </button>
            </div>
            <p className="text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">
              用支付宝「扫一扫」识别上图，或保存后相册识别；付款时请保持金额与备注不变。
            </p>
          </>
        )}

        {/* ⑤「我已支付」— decoupled from the launch entry (doc 01 §3) */}
        {paidRecorded ? (
          <div className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[12px] text-emerald-600 dark:text-emerald-400">
            <CheckCircleIcon className="h-4 w-4 shrink-0" />
            已记录待核对——请把支付凭证发给对方完成确认
          </div>
        ) : (
          <button
            type="button"
            onClick={handlePaidConfirm}
            className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[13px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/20 dark:text-emerald-400"
          >
            付款后回来点我已支付
          </button>
        )}
      </div>
    </div>
  );
};

export default PaymentCard;
