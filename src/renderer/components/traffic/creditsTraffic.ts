/**
 * Pure helpers for the traffic tab's ME credits mode (requirements v1.0):
 * what "spendable" means for the 积分支付 card, how per-order ME amounts
 * render, and how the local spend journal stands in for the server-side
 * per-order history when that endpoint is not deployed yet.
 * Kept React-free so node tests can import it directly.
 */

import type { TrafficSpendJournalEntryInfo, TrafficSponsorOrderInfo } from '../../types/electron';

/** Subset of the ME balance snapshot the spendable rule reads (all milliME). */
export interface CreditsBalanceLike {
  weeklyGrant?: { remainingMilli?: number };
  persistent?: { topupMilli?: number; bonusMilli?: number; earnedMilli?: number };
  autoDeductFromPersistent?: boolean;
  spendableMilli?: number;
}

const finiteOrZero = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

/**
 * What a new sponsored write can draw from, in milliME. The sponsor's own
 * figure wins (address/info me.spendableMilli, then /v1/me/balance
 * spendableMilli); otherwise the rule is rebuilt from the pools: weekly grant
 * remaining, plus the persistent pools unless the credit-pack switch is
 * explicitly off. Undefined when nothing is known yet — callers must not
 * read that as "empty".
 */
export function creditsSpendableMilli(input: {
  sponsorSpendableMilli?: number;
  balance?: CreditsBalanceLike | null;
}): number | undefined {
  if (typeof input.sponsorSpendableMilli === 'number' && Number.isFinite(input.sponsorSpendableMilli)) {
    return Math.max(0, input.sponsorSpendableMilli);
  }
  const balance = input.balance;
  if (!balance) return undefined;
  if (typeof balance.spendableMilli === 'number' && Number.isFinite(balance.spendableMilli)) {
    return Math.max(0, balance.spendableMilli);
  }
  const grant = finiteOrZero(balance.weeklyGrant?.remainingMilli);
  if (balance.autoDeductFromPersistent === false) return grant;
  const persistent = balance.persistent ?? {};
  return grant
    + finiteOrZero(persistent.topupMilli)
    + finiteOrZero(persistent.bonusMilli)
    + finiteOrZero(persistent.earnedMilli);
}

/**
 * Per-order ME amount for the usage history. Single writes cost a few
 * milliME, so whole-ME rounding would print "0 ME": below 1 ME the value is
 * shown with up to three decimals (one milliME resolution).
 */
export function formatOrderMe(milli: number): string {
  const value = Number.isFinite(milli) ? Math.max(0, milli) : 0;
  if (value >= 1000) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 1000);
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value / 1000);
}

/**
 * Local spend journal rows rendered as sponsor orders (fallback while the
 * backend has no sponsor-orders endpoint): this device's sponsored commits
 * only, already newest first.
 */
export function journalEntriesToOrders(entries: TrafficSpendJournalEntryInfo[]): TrafficSponsorOrderInfo[] {
  return entries.map((entry) => {
    const order: TrafficSponsorOrderInfo = {
      orderId: entry.orderId,
      botAddress: entry.botAddress,
      txId: entry.txId,
      txSize: entry.txSize,
      paySource: entry.billedBy === 'me' ? 'me' : entry.billedBy === 'traffic' ? 'bytes' : 'quota',
      meAmountMilli: entry.billedBy === 'me' ? entry.meAmountMilli : 0,
      status: 'committed',
      createdAt: entry.createdAt,
      committedAt: entry.createdAt,
    };
    if (entry.kind) order.kind = entry.kind;
    return order;
  });
}
