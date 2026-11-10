/**
 * Mobile ME points store (S9 credits UI, mobile).
 *
 * One shared snapshot consumed by the Me home (credits home), the purchase/recharge
 * flow and the usage & credits page. Every number rendered by the screens comes
 * from /v1/me/* at runtime (plans / packages are server hot-config) — this
 * module never hardcodes a price, a weekly amount or a topup size.
 *
 * The API speaks milliME integers (1 ME = 1000 milliME); display helpers divide
 * by 1000 and floor (the ledger balance is authoritative).
 *
 * Transport: `window.electron.mePoints.*` — on the real phone shell this rides
 * the C2 gateway to the same main-process handlers the desktop uses; in the
 * mock shell the fixtures in bridge/mockBridge.ts answer instead.
 */

import { useSyncExternalStore } from 'react';

type MePointsAPI = Window['electron']['mePoints'];
type PlansResult = Awaited<ReturnType<MePointsAPI['getPlans']>>;
type BalanceResult = Awaited<ReturnType<MePointsAPI['getBalance']>>;
type TopupPackagesResult = Awaited<ReturnType<MePointsAPI['getTopupPackages']>>;
type HistoryResult = Awaited<ReturnType<MePointsAPI['getHistory']>>;
type TopupOrdersResult = Awaited<ReturnType<MePointsAPI['getTopupOrders']>>;

export type MobileMePlan = NonNullable<PlansResult['plans']>[number];
export type MobileMeRate = NonNullable<Awaited<ReturnType<MePointsAPI['getRates']>>['rates']>[number];
export type MobileMeBalance = NonNullable<BalanceResult['balance']>;
export type MobileMeTopupPackage = NonNullable<TopupPackagesResult['topupPackages']>[number];
export type MobileMeHistoryEntry = NonNullable<NonNullable<HistoryResult['history']>['entries']>[number];
export type MobileMeTopupOrder = NonNullable<TopupOrdersResult['orders']>[number];
export type MobileMeSubscription = { statusText: string; raw?: Record<string, unknown> };
export type MobileMePaymentInfo = { qrContent: string; payeeHint: string };

export type MePeriod = 'month' | 'quarter' | 'year';

export type MeApiFailure = {
  success: false;
  error?: string;
  errorCode?: string;
  featureUnavailable?: boolean;
};

interface MeSnapshot {
  balance: MobileMeBalance | null;
  balanceLoading: boolean;
  balanceError: string | null;
  balanceFeatureUnavailable: boolean;
  subscription: MobileMeSubscription | null;
  subscriptionLoading: boolean;
  plans: MobileMePlan[];
  plansLoading: boolean;
  plansError: string | null;
  rates: MobileMeRate[];
  topupPackages: MobileMeTopupPackage[];
  topupPackagesLoading: boolean;
  topupPackagesError: string | null;
  history: MobileMeHistoryEntry[];
  historyLoading: boolean;
  historyError: string | null;
  historyNextCursor: string;
  orders: MobileMeTopupOrder[];
  ordersLoading: boolean;
  ordersError: string | null;
}

let snapshot: MeSnapshot = {
  balance: null,
  balanceLoading: false,
  balanceError: null,
  balanceFeatureUnavailable: false,
  subscription: null,
  subscriptionLoading: false,
  plans: [],
  plansLoading: false,
  plansError: null,
  rates: [],
  topupPackages: [],
  topupPackagesLoading: false,
  topupPackagesError: null,
  history: [],
  historyLoading: false,
  historyError: null,
  historyNextCursor: '',
  orders: [],
  ordersLoading: false,
  ordersError: null,
};

/**
 * Immutable patch: useSyncExternalStore bails on identical snapshots, so every
 * mutation must replace the object (the desktop store froze on first paint
 * once by mutating in place).
 */
function patch(partial: Partial<MeSnapshot>): void {
  snapshot = { ...snapshot, ...partial };
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

export function subscribeMeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMeStore(): Readonly<MeSnapshot> {
  return snapshot;
}

/** React binding used by every ME surface. */
export function useMeStore(): Readonly<MeSnapshot> {
  return useSyncExternalStore(subscribeMeStore, getMeStore, getMeStore);
}

// ---------------------------------------------------------------------------
// milliME formatting + countdown helpers
// ---------------------------------------------------------------------------

/** milliME → integer ME (floored; the ledger is authoritative). */
export function meFromMilli(milli: number | null | undefined): number {
  const value = typeof milli === 'number' && Number.isFinite(milli) ? milli : 0;
  return Math.max(0, Math.floor(value / 1000));
}

/** Grouped integer ME (locale-aware). */
export function formatMe(me: number): string {
  return new Intl.NumberFormat().format(Math.max(0, Math.floor(me)));
}

/** Signed ledger amount in ME (negative = spend). */
export function formatMeSigned(milli: number | null | undefined): string {
  const value = typeof milli === 'number' && Number.isFinite(milli) ? milli : 0;
  // Sub-1-ME metering burns are common: whole-ME truncation printed them as
  // "-0" — mirror the desktop formatter (3 decimals below 1 ME, 2 above).
  const decimals = Math.abs(value) >= 1000 ? 2 : 3;
  const me = value / 1000;
  return `${me < 0 ? '-' : '+'}${new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals }).format(Math.abs(me))}`;
}

/** Display multiplier: 1 → "1x", 1.5 → "1.5x". */
export function formatMeRate(multiplier: number | null | undefined): string {
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) return '';
  const rounded = Math.round(multiplier * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

export type MeResetParts = { unit: 'soon' | 'hours' | 'days'; n: number };

/** Weekly reset countdown: ≤24h in hours, otherwise days. */
export function meResetParts(nextResetAt: number | null | undefined): MeResetParts | null {
  const reset = Number(nextResetAt);
  if (!Number.isFinite(reset) || reset <= 0) return null;
  const ms = reset - Date.now();
  if (ms <= 0) return { unit: 'soon', n: 0 };
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 24) return { unit: 'hours', n: hours };
  return { unit: 'days', n: Math.ceil(ms / 86_400_000) };
}

/** 0..1 share of the weekly grant already spent (0 when no grant). */
export function meWeeklyUsedRatio(balance: MobileMeBalance | null): number {
  if (!balance) return 0;
  const total = Number(balance.weeklyGrant.amountMilli) || 0;
  const remaining = Number(balance.weeklyGrant.remainingMilli) || 0;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (total - remaining) / total));
}

// ---------------------------------------------------------------------------
// Subscription / plan helpers
// ---------------------------------------------------------------------------

/** True when the subscription status reads as an active paid tier. */
export function isMeSubscribed(subscription: MobileMeSubscription | null): boolean {
  if (!subscription) return false;
  return /^active/i.test((subscription.statusText || '').trim());
}

/** Active plan id from the subscription payload ('' for free/unknown). */
export function meActivePlanId(subscription: MobileMeSubscription | null): string {
  const raw = subscription?.raw;
  if (!raw) return '';
  for (const key of ['planId', 'plan_id', 'tier']) {
    const value = typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';
    if (value) return value;
  }
  return '';
}

/** The free plan row (tier === 'free'), or null when the catalog hides it. */
export function meFreePlan(plans: readonly MobileMePlan[]): MobileMePlan | null {
  return plans.find((plan) => plan.tier === 'free' || plan.planId === 'me_free') ?? null;
}

/** Sellable paid tiers (the three cards), in server sort order. */
export function mePaidPlans(plans: readonly MobileMePlan[]): MobileMePlan[] {
  return plans.filter((plan) => plan.tier !== 'free' && plan.planId !== 'me_free');
}

/** The plan row matching the active subscription (falls back to free). */
export function meCurrentPlan(
  plans: readonly MobileMePlan[],
  subscription: MobileMeSubscription | null,
): MobileMePlan | null {
  const activeId = meActivePlanId(subscription);
  if (activeId) {
    const match = plans.find((plan) =>
      plan.planId === activeId || plan.tier === activeId || plan.name === activeId);
    if (match) return match;
  }
  return isMeSubscribed(subscription) ? null : meFreePlan(plans);
}

/**
 * Mobile/cloud price for the chosen period. `priceCny` is the mobile/cloud
 * list price (the desktop card renders `desktopPriceCny`); both channels bill
 * the same uniform monthly-rate model (owner decision 2026-11-07): quarter
 * bills 3 months at 90% of the monthly price, year bills 12 months at 80%,
 * and the one-payment total is rounded once to 2dp. This MUST stay in sync
 * with the server's PriceSubscriptionOrderCny and the desktop tag
 * (src/renderer/components/me/mePayment.ts mePeriodPricing) — the displayed
 * amount must equal the charged amount. plan.quarterlyDiscountPct /
 * plan.annualPriceCny are retired for pricing and no longer read here; after
 * the order is created the screen prefers the server-quoted payAmount.
 */
export const ME_QUARTER_DISCOUNT_PCT = 90;
export const ME_YEAR_DISCOUNT_PCT = 80;

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function mePeriodPrice(plan: MobileMePlan | null, period: MePeriod): number | null {
  if (!plan) return null;
  const monthly = typeof plan.priceCny === 'number' && plan.priceCny > 0 ? plan.priceCny : null;
  if (monthly == null) return null;
  if (period === 'month') return monthly;
  if (period === 'quarter') {
    return round2(monthly * 3 * ME_QUARTER_DISCOUNT_PCT / 100);
  }
  return round2(monthly * 12 * ME_YEAR_DISCOUNT_PCT / 100);
}

/** Period length in days (server periodDays × period multiplier). */
export function mePeriodDays(plan: MobileMePlan | null, period: MePeriod): number {
  const base = plan?.periodDays && plan.periodDays > 0 ? plan.periodDays : 30;
  if (period === 'month') return base;
  if (period === 'quarter') return base * 3;
  return base * 12;
}

/** Weekly ME from the plan row ('' when the server omitted it). */
export function meWeeklyLabel(plan: MobileMePlan | null): string {
  const weekly = plan?.weeklyAmountMilli;
  if (typeof weekly !== 'number' || !Number.isFinite(weekly) || weekly <= 0) return '';
  return formatMe(meFromMilli(weekly));
}

// ---------------------------------------------------------------------------
// Fetch actions
// ---------------------------------------------------------------------------

const BALANCE_TTL_MS = 30_000;
let lastBalanceAt = 0;
let catalogInFlight: Promise<void> | null = null;
let balanceInFlight: Promise<void> | null = null;

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function refreshMeCatalog(): Promise<void> {
  if (catalogInFlight) return catalogInFlight;
  patch({ plansLoading: true });
  catalogInFlight = (async () => {
    try {
      const [plansRes, ratesRes] = await Promise.all([
        window.electron.mePoints.getPlans(),
        window.electron.mePoints.getRates(),
      ]);
      patch({
        plans: plansRes.success && Array.isArray(plansRes.plans) ? plansRes.plans : snapshot.plans,
        rates: ratesRes.success && Array.isArray(ratesRes.rates) ? ratesRes.rates : snapshot.rates,
        plansLoading: false,
        plansError: plansRes.success ? null : (plansRes.error || 'plans unavailable'),
      });
    } catch (error) {
      patch({ plansLoading: false, plansError: errorText(error, 'plans unavailable') });
    } finally {
      catalogInFlight = null;
    }
  })();
  return catalogInFlight;
}

export async function refreshMeBalance(options: { forceRefresh?: boolean } = {}): Promise<void> {
  if (!options.forceRefresh && snapshot.balance && Date.now() - lastBalanceAt < BALANCE_TTL_MS) return;
  if (balanceInFlight) return balanceInFlight;
  patch({ balanceLoading: true });
  balanceInFlight = (async () => {
    try {
      const res = await window.electron.mePoints.getBalance({ forceRefresh: options.forceRefresh === true });
      if (res.success && res.balance) {
        lastBalanceAt = Date.now();
        patch({
          balance: res.balance,
          balanceError: null,
          balanceFeatureUnavailable: false,
          balanceLoading: false,
        });
      } else {
        patch({
          balanceError: res.error || 'ME balance unavailable',
          balanceFeatureUnavailable: res.featureUnavailable === true,
          balanceLoading: false,
        });
      }
    } catch (error) {
      patch({ balanceError: errorText(error, 'ME balance unavailable'), balanceLoading: false });
    } finally {
      balanceInFlight = null;
    }
  })();
  return balanceInFlight;
}

export async function refreshMeSubscription(): Promise<void> {
  patch({ subscriptionLoading: true });
  try {
    const res = await window.electron.mePoints.getSubscription();
    patch({
      subscription: res.success && res.subscription
        ? { statusText: res.subscription.statusText, raw: res.subscription.raw }
        : snapshot.subscription,
      subscriptionLoading: false,
    });
  } catch {
    patch({ subscriptionLoading: false });
  }
}

export async function refreshMeTopupPackages(): Promise<void> {
  patch({ topupPackagesLoading: true });
  try {
    const res = await window.electron.mePoints.getTopupPackages();
    patch({
      topupPackages: res.success && Array.isArray(res.topupPackages) ? res.topupPackages : snapshot.topupPackages,
      topupPackagesLoading: false,
      topupPackagesError: res.success ? null : (res.error || 'topup packages unavailable'),
    });
  } catch (error) {
    patch({ topupPackagesLoading: false, topupPackagesError: errorText(error, 'topup packages unavailable') });
  }
}

export async function refreshMeHistory(options: { type?: string; reset?: boolean } = {}): Promise<void> {
  if (snapshot.historyLoading) return;
  const beforeId = options.reset ? '' : snapshot.historyNextCursor;
  patch({ historyLoading: true, historyError: null });
  try {
    const res = await window.electron.mePoints.getHistory({ type: options.type, beforeId: beforeId || undefined, limit: 30 });
    if (!res.success || !res.history) {
      patch({ historyLoading: false, historyError: res.error || 'history unavailable' });
      return;
    }
    const entries = Array.isArray(res.history.entries) ? res.history.entries : [];
    patch({
      history: options.reset || !beforeId ? entries : [...snapshot.history, ...entries],
      historyNextCursor: res.history.nextCursor || '',
      historyLoading: false,
      historyError: null,
    });
  } catch (error) {
    patch({ historyLoading: false, historyError: errorText(error, 'history unavailable') });
  }
}

export async function refreshMeTopupOrders(): Promise<void> {
  patch({ ordersLoading: true, ordersError: null });
  try {
    const res = await window.electron.mePoints.getTopupOrders();
    patch({
      orders: res.success && Array.isArray(res.orders) ? res.orders : snapshot.orders,
      ordersLoading: false,
      ordersError: res.success ? null : (res.error || 'orders unavailable'),
    });
  } catch (error) {
    patch({ ordersLoading: false, ordersError: errorText(error, 'orders unavailable') });
  }
}

/** Payment QR/payee seam (public endpoint). Cached per app session. */
let paymentInfoCache: MobileMePaymentInfo | null = null;
export async function loadMePaymentInfo(): Promise<MobileMePaymentInfo | null> {
  if (paymentInfoCache) return paymentInfoCache;
  try {
    const res = await window.electron.mePoints.getPaymentInfo();
    if (res.success && res.payment) paymentInfoCache = res.payment;
    return paymentInfoCache;
  } catch {
    return null;
  }
}

/** Pull everything the Me home needs; cheap on repeat calls. */
export function ensureMeOverview(): void {
  void refreshMeCatalog();
  void refreshMeBalance();
  void refreshMeSubscription();
}

/** After a submit/confirm: force a fresh ledger read. */
export function invalidateMeBalance(): void {
  lastBalanceAt = 0;
  void refreshMeBalance({ forceRefresh: true });
}

/** Test/QA seam: reset the module snapshot (not used by production screens). */
export function resetMeStoreForTests(): void {
  lastBalanceAt = 0;
  paymentInfoCache = null;
  catalogInFlight = null;
  balanceInFlight = null;
  snapshot = {
    balance: null,
    balanceLoading: false,
    balanceError: null,
    balanceFeatureUnavailable: false,
    subscription: null,
    subscriptionLoading: false,
    plans: [],
    plansLoading: false,
    plansError: null,
    rates: [],
    topupPackages: [],
    topupPackagesLoading: false,
    topupPackagesError: null,
    history: [],
    historyLoading: false,
    historyError: null,
    historyNextCursor: '',
    orders: [],
    ordersLoading: false,
    ordersError: null,
  };
  for (const listener of listeners) listener();
}
