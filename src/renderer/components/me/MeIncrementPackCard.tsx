import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import {
  ensureMeSnapshot,
  formatMe,
  getMeSnapshot,
  meFromMilli,
  requestOpenMePurchase,
  requestOpenUsagePage,
  subscribeMeSnapshot,
} from './mePointsStore';

/**
 * 积分增量包 (credit pack) — the persistent ME bucket card on the IDBots
 * subscription detail pane, above the shared provider fields / 测试连接
 * button.
 *
 * The persistent bucket (top-up + earned + bonus) never resets and is never
 * cleared with the weekly quota; it grows only through recharge, gifts, and
 * earnings. Besides the total the card carries:
 *  - the local auto-deduct preference (kvStore-backed, default ON — when the
 *    weekly grant runs out, spending continues from this pack),
 *  - 「购买额度」 opening the shared purchase modal on its topup section,
 *  - 「查看获得详情」 jumping to the 「用量 & 积分」 page.
 *
 * All amounts come from the shared ME snapshot store (same discipline as
 * IdbotsPlanCard: server data only, no hardcoded numbers).
 */
const MeIncrementPackCard: React.FC = () => {
  const snapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  const [autoDeduct, setAutoDeduct] = useState(true);
  const [settingsReady, setSettingsReady] = useState(false);

  useEffect(() => {
    ensureMeSnapshot();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electron.mePoints.getPointsSettings()
      .then((res) => {
        if (!cancelled && res.success && res.settings) {
          setAutoDeduct(res.settings.autoDeductFromPersistent !== false);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSettingsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoDeductChange = (next: boolean) => {
    setAutoDeduct(next);
    void window.electron.mePoints.setPointsSettings({ autoDeductFromPersistent: next })
      .then((res) => {
        // Re-sync from the persisted snapshot; revert on failure.
        setAutoDeduct(res.success && res.settings
          ? res.settings.autoDeductFromPersistent !== false
          : !next);
      })
      .catch(() => setAutoDeduct(!next));
  };

  const balance = snapshot.balance;
  const persistent = balance?.persistent;
  const topupMe = meFromMilli(persistent?.topupMilli);
  const earnedMe = meFromMilli(persistent?.earnedMilli);
  const bonusMe = meFromMilli(persistent?.bonusMilli);
  const packTotalMe = topupMe + earnedMe + bonusMe;

  return (
    <section
      className="rounded-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceInset/40 dark:bg-claude-darkSurfaceInset/30 p-3.5"
      aria-label={i18nService.t('meIncrementPackTitle')}
    >
      <p className="text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
        {i18nService.t('meIncrementPackTitle')}
      </p>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-lg font-semibold tabular-nums text-claude-text dark:text-claude-darkText">
          {balance ? formatMe(packTotalMe) : '—'}
          <span className="ml-1 text-[10px] font-normal text-claude-textSecondary dark:text-claude-darkTextSecondary">ME</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => requestOpenMePurchase('topup')}
            className="btn-idchat-primary-filled inline-flex items-center justify-center rounded-xl px-3 py-1.5 text-xs font-medium"
          >
            {i18nService.t('meIncrementPackBuy')}
          </button>
          <button
            type="button"
            onClick={() => requestOpenUsagePage()}
            className="inline-flex items-center justify-center rounded-xl px-3 py-1.5 text-xs font-medium border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
          >
            {i18nService.t('meIncrementPackDetails')}
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
        <span className="tabular-nums">{i18nService.t('mePanelTopup')} {formatMe(topupMe)}</span>
        <span className="tabular-nums">{i18nService.t('mePanelBonus')} {formatMe(bonusMe)}</span>
        <span className="tabular-nums">{i18nService.t('mePanelEarned')} {formatMe(earnedMe)}</span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-claude-border/50 dark:border-claude-darkBorder/50 pt-2.5">
        <span className="text-[11px] leading-snug text-claude-text dark:text-claude-darkText">
          {i18nService.t('meIncrementPackAutoDeduct')}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={autoDeduct}
          aria-label={i18nService.t('meIncrementPackAutoDeduct')}
          disabled={!settingsReady}
          onClick={() => handleAutoDeductChange(!autoDeduct)}
          className={`shrink-0 w-7 h-4 rounded-full flex items-center transition-colors ${
            autoDeduct ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
          } ${settingsReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
        >
          <span
            className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
              autoDeduct ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
        {i18nService.t('meIncrementPackNote')}
      </p>
    </section>
  );
};

export default MeIncrementPackCard;
