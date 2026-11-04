/**
 * ME points renderer store (S9 积分 UI).
 * One shared snapshot subscribed by: the global balance badge, the IDBots
 * Plan provider card, the usage & credits page and the purchase flow.
 *
 * Data discipline (PRD S9 §1): every number shown comes from the live API —
 * plans/rates/balance are server hot-config — the client never hardcodes
 * prices or quota amounts. All API amounts are milliME; this module's
 * formatters divide by 1000 for display.
 */

import type {
  MeRateInfo,
  MeBalanceInfo,
  MePlanInfo,
} from '../../types/electron';

export type {
  MeTopupPackageInfo,
} from '../../types/electron';

// ---------------------------------------------------------------------------
// milliME formatting + countdown helpers
// ---------------------------------------------------------------------------

/** milliME → integer ME (rounding down: the ledger balance is authoritative). */
export function meFromMilli(milli: number | undefined | null): number {
  const value = typeof milli === 'number' && Number.isFinite(milli) ? milli : 0;
  return Math.max(0, Math.floor(value / 1000));
}

/** Format an integer ME value with the user's grouping separators. */
export function formatMe(me: number): string {
  return new Intl.NumberFormat().format(Math.max(0, Math.floor(me)));
}

/** Signed ledger amount in ME (keeps the sign; negative entries are spends). */
export function formatMeSigned(milli: number | undefined | null): string {
  const value = typeof milli === 'number' && Number.isFinite(milli) ? milli : 0;
  const me = Math.trunc(value / 1000);
  const abs = new Intl.NumberFormat().format(Math.abs(me));
  return `${me < 0 ? '-' : '+'}${abs}`;
}

/** Format a display multiplier, e.g. 1 → "1x", 3 → "3x", 1.5 → "1.5x". */
export function formatMeRate(multiplier: number): string {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return '';
  const rounded = Math.round(multiplier * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

/** Hours until the weekly reset; ≤0 → resets within the hour. */
export function meResetCountdownHours(nextResetAt: number): number | null {
  const reset = Number(nextResetAt);
  if (!Number.isFinite(reset) || reset <= 0) return null;
  const ms = reset - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 3_600_000);
}

/** True when the ME weekly reset happens within 24h. */
export function meResetImminent(nextResetAt: number): boolean {
  const hours = meResetCountdownHours(nextResetAt);
  return hours !== null && hours <= 24;
}

/**
 * Human reset countdown: hours under a day, days above (120h → "5 天后重置").
 * Returns null when the server sent no reset timestamp.
 */
export function meResetParts(nextResetAt: number): { unit: 'soon' | 'hours' | 'days'; n: number } | null {
  const reset = Number(nextResetAt);
  if (!Number.isFinite(reset) || reset <= 0) return null;
  const ms = reset - Date.now();
  if (ms <= 0) return { unit: 'soon', n: 0 };
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 24) return { unit: 'hours', n: hours };
  return { unit: 'days', n: Math.ceil(ms / 86_400_000) };
}

/**
 * Badge/panel low-balance threshold: below 20% of one week's mean burn.
 * The weekly mean is estimated from the CURRENT grant size (server-config:
 * the tier's weeklyAmount); it falls back gracefully when no data yet.
 */
export function isMeBalanceLow(input: {
  weeklyAmountMilli: number;
  weeklyRemainingMilli: number;
  persistentTotalMilli: number;
}): boolean {
  const weekly = Math.max(0, Math.floor((input.weeklyAmountMilli || 0) / 1000));
  if (weekly <= 0) return false;
  const total = meFromMilli(input.weeklyRemainingMilli) + Math.max(0, Math.floor((input.persistentTotalMilli || 0) / 1000));
  return total < weekly * 0.2;
}

// ---------------------------------------------------------------------------
// Tier snapshot helpers
// ---------------------------------------------------------------------------

/** True when the subscription status reads as an active paid tier. */
export function isMeEffectivelySubscribed(subscription: { statusText: string; raw?: Record<string, unknown> } | null): boolean {
  if (!subscription) return false;
  return /^active/i.test(subscription.statusText || '');
}

/** The plan id of the active subscription, or '' (free tier / unknown). */
export function meActivePlanId(subscription: { statusText: string; raw?: Record<string, unknown> } | null): string {
  if (!subscription?.raw) return '';
  const raw = subscription.raw as Record<string, unknown>;
  for (const key of ['planId', 'plan_id', 'tier']) {
    const value = typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';
    if (value) return value;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Snapshot store
// ---------------------------------------------------------------------------

interface MeSnapshot {
  balance: MeBalanceInfo | null;
  balanceLoading: boolean;
  balanceError: string | null;
  balanceFeatureUnavailable: boolean;
  subscription: { statusText: string; raw?: Record<string, unknown> } | null;
  plans: MePlanInfo[];
  plansLoading: boolean;
  rates: MeRateInfo[];
}

let snapshot: MeSnapshot = {
  balance: null,
  balanceLoading: false,
  balanceError: null,
  balanceFeatureUnavailable: false,
  subscription: null,
  plans: [],
  plansLoading: false,
  rates: [],
};

/**
 * Immutable patch. useSyncExternalStore bails when getSnapshot returns the
 * same object identity, so every mutation MUST replace the snapshot object —
 * mutating the singleton in place silently froze the whole UI on first paint.
 */
function patch(partial: Partial<MeSnapshot>): void {
  snapshot = { ...snapshot, ...partial };
  notify();
}

const listeners = new Set<() => void>();
const BALANCE_TTL_MS = 30_000;
let lastBalanceAt = 0;
let plansInFlight: Promise<void> | null = null;
let balanceInFlight: Promise<void> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

export function getMeSnapshot(): Readonly<MeSnapshot> {
  return snapshot;
}

export function subscribeMeSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function requestMePlanCatalog(): Promise<void> {
  if (snapshot.plansLoading) return plansInFlight ?? Promise.resolve();
  patch({ plansLoading: true });
  plansInFlight = (async () => {
    try {
      const plans = window.electron.mePoints.getPlans();
      const ratesPromise = window.electron.mePoints.getRates();
      const [plansRes, ratesRes] = await Promise.all([plans, ratesPromise]);
      patch({
        plans: plansRes.success && Array.isArray(plansRes.plans) ? plansRes.plans : [],
        rates: ratesRes.success && Array.isArray(ratesRes.rates) ? ratesRes.rates : [],
      });
    } catch {
      // Catalog is best-effort: failures leave the last-known snapshot in
      // place; callers treat an empty list as "unavailable".
    } finally {
      plansInFlight = null;
      patch({ plansLoading: false });
    }
  })();
  return plansInFlight;
}

export async function requestMeBalance(options: { forceRefresh?: boolean; ttlMs?: number } = {}): Promise<void> {
  const ttl = options.ttlMs ?? BALANCE_TTL_MS;
  if (!options.forceRefresh && snapshot.balance && Date.now() - lastBalanceAt < ttl) return;
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
        });
      } else {
        patch({
          balanceError: res.error || 'ME balance unavailable',
          balanceFeatureUnavailable: res.featureUnavailable === true,
        });
      }
    } catch {
      patch({ balanceError: 'ME balance unavailable' });
    } finally {
      balanceInFlight = null;
      patch({ balanceLoading: false });
    }
  })();
  return balanceInFlight;
}

export async function requestMeSubscription(): Promise<void> {
  try {
    const res = await window.electron.mePoints.getSubscription();
    patch({
      subscription: res.success && res.subscription
        ? { statusText: res.subscription.statusText, raw: res.subscription.raw }
        : null,
    });
  } catch {
    patch({ subscription: null });
  }
}

/** Pull everything the three UI surfaces need; cheap on repeat calls. */
export function ensureMeSnapshot(): void {
  void requestMePlanCatalog();
  void requestMeBalance();
  void requestMeSubscription();
}

/** Invalidate + refetch after a topup submission lands. */
export function invalidateMeSnapshot(): void {
  lastBalanceAt = 0;
  void requestMeBalance({ forceRefresh: true });
}

// ---------------------------------------------------------------------------
// Purchase-flow ripple (module-level so badge / plan card / settings page can
// open the shared modal mounted once in App.tsx without prop-threading).
// ---------------------------------------------------------------------------

export type MePurchaseSection = 'subscribe' | 'topup';
export function requestOpenMePurchase(section: MePurchaseSection): void {
  ensureMeSnapshot();
  window.dispatchEvent(new CustomEvent('me:openPurchase', { detail: { section } }));
}

export function onRequestOpenMePurchase(handler: (section: MePurchaseSection) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ section?: MePurchaseSection }>).detail;
    handler(detail?.section === 'topup' ? 'topup' : 'subscribe');
  };
  window.addEventListener('me:openPurchase', listener);
  return () => window.removeEventListener('me:openPurchase', listener);
}

export function requestOpenUsagePage(): void {
  window.dispatchEvent(new CustomEvent('me:openUsage'));
}

export function onRequestOpenUsagePage(handler: () => void): () => void {
  const listener = () => handler();
  window.addEventListener('me:openUsage', listener);
  return () => window.removeEventListener('me:openUsage', listener);
}
