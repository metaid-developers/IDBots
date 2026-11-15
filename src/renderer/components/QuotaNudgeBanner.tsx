/**
 * Global free-quota nudge banner (Phase 2 of the 2026-10-23 new-user
 * free-quota post-mortem).
 *
 * A dumb view over the main-process derived nudge state
 * (services/quotaNudgeService): the banner renders only while the state's
 * level is low/exhausted, so it DISAPPEARS BY ITSELF the moment the setup is
 * fixed (one-click switch, or a manual brain edit — the main process
 * recomputes and pushes 'none'). The close button records a per-quota-cycle
 * dismissal in the main process; the low nudge may be dismissed without
 * suppressing a later exhausted alarm in the same cycle.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../services/i18n';

interface QuotaNudgeBannerProps {
  /** Opens Settings > Models (the no-own-provider CTA). */
  onOpenModelSettings?: () => void;
}

/** The nudge state shape, derived from the IPC surface type (electron.d.ts keeps its interfaces module-scoped). */
type QuotaNudgeBannerState = NonNullable<
  Awaited<ReturnType<typeof window.electron.llmRelay.getQuotaNudgeState>>['state']
>;

const QuotaNudgeBanner: React.FC<QuotaNudgeBannerProps> = ({ onOpenModelSettings }) => {
  const [state, setState] = useState<QuotaNudgeBannerState | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    // Non-desktop runtimes (mobile web shell) have no llmRelay bridge — the
    // nudge is desktop-only and the component stays hidden there.
    const nudgeApi = window.electron?.llmRelay;
    if (!nudgeApi?.getQuotaNudgeState || !nudgeApi?.onQuotaNudgeChanged) return;
    let disposed = false;
    nudgeApi.getQuotaNudgeState()
      .then((res) => {
        if (!disposed && res?.success && res.state) setState(res.state);
      })
      .catch(() => undefined);
    const unsubscribe = nudgeApi.onQuotaNudgeChanged((next) => {
      setState(next);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const handleDismiss = useCallback(() => {
    if (!state || state.level === 'none') return;
    const level = state.level;
    // Optimistic hide; the dismissal is persisted per quota cycle in main, so
    // the banner stays down until the next cycle (or an exhaustion escalation).
    setState(null);
    window.electron.llmRelay.dismissQuotaNudge({ level }).catch(() => undefined);
  }, [state]);

  const handleSwitch = useCallback(async () => {
    const target = state?.suggestedProvider;
    if (!target || switching) return;
    setSwitching(true);
    try {
      const res = await window.electron.brainSwitch.switchFreeBrainsTo({ providerKey: target.key });
      const toastKey = res?.success ? 'quotaNudgeSwitchSuccess' : 'quotaNudgeSwitchFailed';
      const detail = res?.success
        ? i18nService.t(toastKey)
          .replace('{name}', target.name)
          .replace('{count}', String(res.result?.switchedBotIds?.length ?? 0))
        : i18nService.t(toastKey).replace('{error}', res?.error || 'unknown error');
      window.dispatchEvent(new CustomEvent('app:showToast', { detail }));
      // Re-pull: a successful switch takes every bot off the free relay, so
      // the derived state flips to 'none' and the banner hides for real.
      const fresh = await window.electron.llmRelay.getQuotaNudgeState().catch(() => null);
      if (fresh?.success && fresh.state) setState(fresh.state);
    } finally {
      setSwitching(false);
    }
  }, [state, switching]);

  if (!state || state.level === 'none') return null;
  const exhausted = state.level === 'exhausted';

  const resetIn = (() => {
    if (!state.cycleResetAt) return '';
    const ms = Date.parse(state.cycleResetAt) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return i18nService.t('quotaNudgeResetSoon');
    return i18nService.t('quotaNudgeResetInDays').replace('{n}', String(Math.ceil(ms / 86_400_000)));
  })();
  const pct = state.quotaRemaining != null && state.quotaTotal != null && state.quotaTotal > 0
    ? String(Math.max(0, Math.round((state.quotaRemaining / state.quotaTotal) * 100)))
    : '?';
  const text = (exhausted ? i18nService.t('quotaNudgeExhausted') : i18nService.t('quotaNudgeLow'))
    .replace('{pct}', pct)
    .replace('{bots}', String(state.freeBrainBotCount))
    .replace('{resetIn}', resetIn);

  return (
    <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[90] w-[min(720px,92vw)]">
      <div
        className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 shadow-lg backdrop-blur-md ${
          exhausted
            ? 'bg-red-50/95 dark:bg-red-950/80 border-red-200 dark:border-red-800'
            : 'bg-amber-50/95 dark:bg-amber-950/70 border-amber-200 dark:border-amber-800'
        }`}
      >
        <ExclamationTriangleIcon
          className={`h-4 w-4 shrink-0 ${exhausted ? 'text-red-500' : 'text-amber-500'}`}
        />
        <span
          className={`flex-1 min-w-0 text-xs leading-5 ${
            exhausted ? 'text-red-700 dark:text-red-300' : 'text-amber-800 dark:text-amber-300'
          }`}
        >
          {text}
        </span>
        {state.suggestedProvider ? (
          <button
            type="button"
            disabled={switching}
            onClick={() => void handleSwitch()}
            className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
              exhausted
                ? 'bg-red-600 text-white hover:bg-red-500 disabled:opacity-60'
                : 'bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-60'
            }`}
          >
            {switching
              ? i18nService.t('quotaNudgeSwitching')
              : i18nService.t('quotaNudgeSwitchTo').replace('{name}', state.suggestedProvider.name)}
          </button>
        ) : (
          onOpenModelSettings && (
            <button
              type="button"
              onClick={onOpenModelSettings}
              className={`shrink-0 rounded-[8px] px-2.5 py-1 text-xs font-medium underline hover:no-underline ${
                exhausted ? 'text-red-700 dark:text-red-300' : 'text-amber-800 dark:text-amber-300'
              }`}
            >
              {i18nService.t('freeQuotaGoSettings')}
            </button>
          )
        )}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={i18nService.t('quotaNudgeDismiss')}
          title={i18nService.t('quotaNudgeDismiss')}
          className={`shrink-0 rounded-[var(--shape-radius-md)] p-1 transition-colors ${
            exhausted
              ? 'text-red-500 hover:bg-red-100 dark:hover:bg-red-900/40'
              : 'text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40'
          }`}
        >
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

export default QuotaNudgeBanner;
