import { useCallback, useEffect, useState } from 'react';
import { t } from '../../../i18n';
import type { TrafficDailyUsageRowInfo, TrafficLedgerEntryInfo } from '../../../bridge/types';
import { getMobileElectron } from '../../appBridge';
import { useMeters } from '../../hooks/useMeters';
import { formatBytes, formatCount, formatDateTime } from '../../format';
import {
  isActiveOrder,
  loadRechargeRecovery,
  type RechargeOrderView,
} from '../../services/rechargeRecovery';
import { RedeemButton } from '../../components/RedeemButton';
import { SecondaryPageShell } from './SecondaryPageShell';

/**
 * Desktop parity constant (src/renderer/components/traffic/formatTraffic.ts):
 * TRAFFIC_LOW_BALANCE_BYTES = 5 * TRAFFIC_BYTES_PER_MB. Re-declared locally —
 * the mobile bundle never imports desktop renderer modules.
 */
const LOW_BALANCE_BYTES = 5 * 1_000_000;

const LEDGER_PAGE_SIZE = 20;

/**
 * traffic secondary page (IA-PLAN v1 §4.4 + §3.5): balance headline with the
 * SAME recharge/cashier channel as the primary card (no new payment logic),
 * pending-order strip over rechargeRecovery, free-grant claim, usage
 * summary + daily table, the static tariff explainer (desktop copy), and
 * the paginated ledger.
 *
 * rechargeAllowed=false (native iOS shell, NS1 policy — the same gate as the
 * ChatScreen quota card and the MeScreen balance card) hides every recharge
 * entry here instead of leaving a dead button: openRecharge is a no-op when
 * recharge is disallowed. Undefined keeps the button (legacy call shape).
 */
export function TrafficPage(props: {
  onBack: () => void;
  onOpenRecharge: () => void;
  rechargeAllowed?: boolean;
  resyncCounter?: number;
}): JSX.Element {
  const { meters, loading, error, reload } = useMeters(props.resyncCounter);
  const [pendingOrder, setPendingOrder] = useState<RechargeOrderView | null>(null);
  const [summary, setSummary] = useState<{ todayBytes: number; weekBytes: number; monthBytes: number } | null>(null);
  const [usageRows, setUsageRows] = useState<TrafficDailyUsageRowInfo[] | null>(null);
  const [ledger, setLedger] = useState<TrafficLedgerEntryInfo[]>([]);
  const [ledgerCursor, setLedgerCursor] = useState<number | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [claimState, setClaimState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [claimBytes, setClaimBytes] = useState<number | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [tariffOpen, setTariffOpen] = useState(false);

  useEffect(() => {
    setPendingOrder((current) => {
      const state = loadRechargeRecovery();
      return isActiveOrder(state.order) ? state.order : current && isActiveOrder(current) ? current : null;
    });
  }, [props.resyncCounter]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const bridge = getMobileElectron().traffic;
      try {
        const usage = await bridge.getUsageSummary();
        if (!cancelled && usage?.success && usage.summary) setSummary(usage.summary);
      } catch {
        if (!cancelled) setSummary(null);
      }
      try {
        const daily = await bridge.getDailyUsage({});
        if (!cancelled && daily?.success && Array.isArray(daily.rows)) setUsageRows(daily.rows);
      } catch {
        if (!cancelled) setUsageRows(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [props.resyncCounter]);

  const loadLedger = useCallback(async (cursor?: number) => {
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const result = await getMobileElectron().traffic.getLedger({ limit: LEDGER_PAGE_SIZE, ...(cursor !== undefined ? { cursor } : {}) });
      if (!result?.success) throw new Error(result?.error || 'getLedger rejected');
      const entries = Array.isArray(result.entries) ? result.entries : [];
      setLedger((current) => (cursor === undefined ? entries : [...current, ...entries]));
      setLedgerCursor(result.nextCursor ?? null);
    } catch (caught) {
      setLedgerError(caught instanceof Error ? caught.message : t('mobile.me.traffic.loadFailed'));
    } finally {
      setLedgerLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger, props.resyncCounter]);

  const claimFreeGrant = async () => {
    if (claimState === 'busy') return;
    setClaimState('busy');
    try {
      const result = await getMobileElectron().traffic.claimFreeGrant();
      if (!result?.success || !result.claim) throw new Error(result?.error || 'claim rejected');
      setClaimBytes(result.claim.grantBytes);
      setClaimState('done');
      await reload();
    } catch {
      setClaimState('failed');
    }
  };

  const lowBalance = Boolean(meters?.traffic && meters.traffic.balanceBytes < LOW_BALANCE_BYTES);

  const tariffRows: ReadonlyArray<{ typeKey: string; size: string; capacityKey: string }> = [
    { typeKey: 'mobile.me.traffic.tariff.rowText', size: '1 KB', capacityKey: 'mobile.me.traffic.tariff.rowTextCapacity' },
    { typeKey: 'mobile.me.traffic.tariff.rowImage', size: '200 KB', capacityKey: 'mobile.me.traffic.tariff.rowImageCapacity' },
    { typeKey: 'mobile.me.traffic.tariff.rowHd', size: '1 MB', capacityKey: 'mobile.me.traffic.tariff.rowHdCapacity' },
    { typeKey: 'mobile.me.traffic.tariff.rowVideo', size: '500 KB', capacityKey: 'mobile.me.traffic.tariff.rowVideoCapacity' },
    { typeKey: 'mobile.me.traffic.tariff.rowVector', size: '4 KB', capacityKey: 'mobile.me.traffic.tariff.rowVectorCapacity' },
  ];

  return (
    <SecondaryPageShell title={t('mobile.me.entry.traffic')} onBack={props.onBack} testId="me-page-traffic">
      {/* Pending order strip (rechargeRecovery, §4.4) — resume goes to the
          existing cashier overlay; order cancel lives in the overlay too. */}
      {pendingOrder ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10" data-testid="traffic-pending-order">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{t('mobile.recharge.pendingTitle')}</p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {t('mobile.recharge.expiresAt', { time: formatDateTime(pendingOrder.expiresAt * 1000) })}
          </p>
          {props.rechargeAllowed !== false ? (
            <button
              type="button"
              onClick={props.onOpenRecharge}
              className="mt-3 min-h-[44px] w-full rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80"
            >
              {t('mobile.recharge.resumeOrder')}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Balance headline + the SAME two buttons as the primary card. */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        <div className="mb-3 flex gap-3">
          <div className="flex-1 rounded-xl bg-[var(--bg-main)] p-3">
            <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.trafficLabel')}</p>
            <p className="text-2xl font-semibold text-[var(--text-primary)]" data-testid="traffic-balance-traffic">
              {meters?.traffic ? formatBytes(meters.traffic.balanceBytes) : '—'}
            </p>
          </div>
          <div className="flex-1 rounded-xl bg-[var(--bg-main)] p-3">
            <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.llmLabel')}</p>
            <p className="text-2xl font-semibold text-[var(--text-primary)]">
              {meters ? `${formatCount(meters.llm.quotaRemaining)} ${meters.llm.unit}` : '—'}
            </p>
          </div>
        </div>
        {loading ? <p className="mb-2 text-xs text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
        {error ? (
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs text-red-600">{t('mobile.me.balanceLoadFailed')}</p>
            <button type="button" onClick={() => void reload()} className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]">
              {t('mobile.common.retry')}
            </button>
          </div>
        ) : null}
        {lowBalance ? (
          <p className="mb-2 text-xs text-amber-600" data-testid="traffic-low-balance">
            {t('mobile.me.traffic.lowBalance')}
          </p>
        ) : null}
        <div className="flex gap-2">
          {props.rechargeAllowed !== false ? (
            <button
              type="button"
              onClick={props.onOpenRecharge}
              className="min-h-[44px] flex-1 rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80"
            >
              {t('mobile.me.rechargeEntry')}
            </button>
          ) : null}
          <RedeemButton />
        </div>
      </div>

      {/* Free grant (§3.5): desktop-parity claim flow; the confirmed amount
          comes from the claim result, never an invented pre-claim number. */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4" data-testid="traffic-free-grant">
        <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">{t('mobile.me.traffic.freeGrantTitle')}</p>
        {claimState === 'done' && claimBytes !== null ? (
          <p aria-live="polite" className="text-sm text-emerald-600">
            {t('mobile.me.traffic.freeGrantSuccess', { amount: formatBytes(claimBytes) })}
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void claimFreeGrant()}
              disabled={claimState === 'busy'}
              className="min-h-[44px] w-full rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)] disabled:opacity-40"
            >
              {claimState === 'busy' ? t('mobile.me.traffic.freeGrantClaiming') : t('mobile.me.traffic.freeGrantClaim')}
            </button>
            {claimState === 'failed' ? (
              <p aria-live="polite" className="mt-2 text-xs text-red-600">{t('mobile.me.traffic.freeGrantFailed')}</p>
            ) : null}
          </>
        )}
      </div>

      {/* Usage summary (today / week / month) + collapsible daily table. */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">{t('mobile.me.traffic.usageTitle')}</p>
        <div className="flex gap-3">
          {([
            ['todayBytes', 'mobile.me.traffic.usageToday'],
            ['weekBytes', 'mobile.me.traffic.usageWeek'],
            ['monthBytes', 'mobile.me.traffic.usageMonth'],
          ] as const).map(([field, labelKey]) => (
            <div key={field} className="flex-1 rounded-xl bg-[var(--bg-main)] p-3">
              <p className="text-xs text-[var(--text-secondary)]">{t(labelKey)}</p>
              <p className="text-sm font-semibold text-[var(--text-primary)]" data-testid={`traffic-usage-${field}`}>
                {summary ? formatBytes(summary[field]) : '—'}
              </p>
            </div>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={usageOpen}
          data-testid="traffic-usage-toggle"
          onClick={() => setUsageOpen((value) => !value)}
          className="mt-3 min-h-[44px] w-full text-left text-sm text-[var(--text-secondary)]"
        >
          {t('mobile.me.traffic.usageTableTitle')} {usageOpen ? '▾' : '▸'}
        </button>
        {usageOpen ? (
          usageRows === null || usageRows.length === 0 ? (
            <p className="py-2 text-xs text-[var(--text-secondary)]">
              {usageRows === null ? t('mobile.me.traffic.loadFailed') : t('mobile.me.traffic.usageEmpty')}
            </p>
          ) : (
            <table className="mt-1 w-full text-left text-xs" data-testid="traffic-usage-table">
              <thead>
                <tr className="text-[var(--text-secondary)]">
                  <th className="py-1 pr-2 font-medium">{t('mobile.me.traffic.usageTableDate')}</th>
                  <th className="py-1 pr-2 font-medium">{t('mobile.me.traffic.usageTableBot')}</th>
                  <th className="py-1 pr-2 font-medium">{t('mobile.me.traffic.usageTableTraffic')}</th>
                  <th className="py-1 font-medium">{t('mobile.me.traffic.usageTableWrites')}</th>
                </tr>
              </thead>
              <tbody>
                {usageRows.map((row) => (
                  <tr key={`${row.date}-${row.botAddress}`} className="border-t border-[var(--border-color)]">
                    <td className="py-1.5 pr-2 text-[var(--text-primary)]">{row.date}</td>
                    <td className="max-w-[120px] truncate py-1.5 pr-2 text-[var(--text-primary)]">{row.botAddress}</td>
                    <td className="py-1.5 pr-2 text-[var(--text-primary)]">{formatBytes(row.bytes)}</td>
                    <td className="py-1.5 text-[var(--text-primary)]">{formatCount(row.txCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </div>

      {/* Static tariff explainer, desktop copy ported (§3.5 trafficTariff*). */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        <button
          type="button"
          aria-expanded={tariffOpen}
          data-testid="traffic-tariff-toggle"
          onClick={() => setTariffOpen((value) => !value)}
          className="min-h-[44px] w-full text-left text-sm font-medium text-[var(--text-primary)]"
        >
          {t('mobile.me.traffic.tariffTitle')} {tariffOpen ? '▾' : '▸'}
        </button>
        {tariffOpen ? (
          <div data-testid="traffic-tariff-table">
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('mobile.me.traffic.tariffIntro')}</p>
            <table className="mt-2 w-full text-left text-xs">
              <thead>
                <tr className="text-[var(--text-secondary)]">
                  <th className="py-1 pr-2 font-medium">{t('mobile.me.traffic.tariff.colType')}</th>
                  <th className="py-1 pr-2 font-medium">{t('mobile.me.traffic.tariff.colSize')}</th>
                  <th className="py-1 font-medium">{t('mobile.me.traffic.tariff.colCapacity')}</th>
                </tr>
              </thead>
              <tbody>
                {tariffRows.map((row) => (
                  <tr key={row.typeKey} className="border-t border-[var(--border-color)]">
                    <td className="py-1.5 pr-2 text-[var(--text-primary)]">{t(row.typeKey)}</td>
                    <td className="py-1.5 pr-2 text-[var(--text-primary)]">{row.size}</td>
                    <td className="py-1.5 text-[var(--text-primary)]">{t(row.capacityKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* Ledger: newest first, paged (§4.4). */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">{t('mobile.me.traffic.ledgerTitle')}</p>
        {ledger.length === 0 && !ledgerLoading && !ledgerError ? (
          <p className="py-3 text-center text-sm text-[var(--text-secondary)]" data-testid="traffic-ledger-empty">
            {t('mobile.me.traffic.ledgerEmpty')}
          </p>
        ) : null}
        {ledger.map((entry) => (
          <div
            key={`${entry.id}-${entry.timestamp}`}
            className="flex min-h-[44px] items-center justify-between gap-3 border-b border-[var(--border-color)] py-2 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-[var(--text-primary)]">{entry.remark || entry.sourceType}</p>
              <p className="text-xs text-[var(--text-secondary)]">{formatDateTime(entry.timestamp)}</p>
            </div>
            <p className="shrink-0 text-sm font-medium text-[var(--text-primary)]">{formatBytes(entry.amountBytes)}</p>
          </div>
        ))}
        {ledgerError ? <p className="mt-2 break-words text-xs text-red-600">{ledgerError}</p> : null}
        {ledgerCursor !== null && !ledgerLoading ? (
          <button
            type="button"
            data-testid="traffic-ledger-more"
            onClick={() => void loadLedger(ledgerCursor)}
            className="mt-2 min-h-[44px] w-full rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          >
            {t('mobile.me.traffic.ledgerLoadMore')}
          </button>
        ) : null}
        {ledgerLoading ? <p className="mt-2 text-xs text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      </div>
    </SecondaryPageShell>
  );
}
