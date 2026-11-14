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
  // Sub-1-ME metering burns are common (a single sponsored write costs a few
  // milliME): whole-ME truncation printed every one of them as "-0". Below
  // 1 ME keep up to three decimals (milliME resolution, mirroring the
  // per-order formatter); above, two decimals keep milli-ME visible.
  const decimals = Math.abs(value) >= 1000 ? 2 : 3;
  const me = value / 1000;
  const abs = new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals }).format(Math.abs(me));
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

export type MeResetParts =
  | { unit: 'soon'; n: number }
  | { unit: 'hours'; n: number }
  | { unit: 'days'; n: number; hours: number };

/**
 * Human reset countdown: whole hours inside the last day, days+hours above
 * (e.g. 6d 23h → "6 天 23 小时后重置", exact 7d → "7 天后重置").
 * Returns null when the server sent no reset timestamp.
 */
export function meResetParts(nextResetAt: number | null | undefined): MeResetParts | null {
  const reset = Number(nextResetAt);
  if (!Number.isFinite(reset) || reset <= 0) return null;
  const ms = reset - Date.now();
  if (ms <= 0) return { unit: 'soon', n: 0 };
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) {
    return { unit: 'hours', n: Math.max(1, Math.ceil(ms / 3_600_000)) };
  }
  return { unit: 'days', n: days, hours: Math.floor((ms % 86_400_000) / 3_600_000) };
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
// Subscription expiry — the server payload carries an expiry the UI never
// showed (2026-11-11 hardening): users could not see how long their paid
// tier lasts. The field name is not pinned by any contract, so parse
// tolerantly across the plausible epoch/ISO shapes; absent → null and the
// UI simply shows nothing (never a guessed date).
// ---------------------------------------------------------------------------

const ME_EXPIRY_KEYS = [
  'expireAt', 'expiresAt', 'expireTime', 'expiryAt',
  'expire_at', 'expires_at', 'expire_time', 'expiry_at',
  'applicableEnd', 'applicable_end',
  'endDate', 'end_date', 'endTime', 'end_time',
  'periodEnd', 'period_end', 'currentPeriodEnd', 'current_period_end',
  'validUntil', 'valid_until',
] as const;

function meExpiryValueToMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds → ms when the value is plausibly a second-epoch.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) {
      const n = Number(text);
      return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/** Subscription expiry (epoch ms) from the raw payload; null when absent. */
export function meSubscriptionExpiryMs(subscription: { raw?: Record<string, unknown> } | null | undefined): number | null {
  const raw = subscription?.raw;
  if (!raw) return null;
  for (const key of ME_EXPIRY_KEYS) {
    const ms = meExpiryValueToMs(raw[key]);
    if (ms !== null) return ms;
  }
  return null;
}

/**
 * Expiry countdown parts. Hour precision (owner request 2026-11-13): a plan
 * bought at noon expires at noon, so the line must carry the remaining hours,
 * not just whole days — "剩余 {n} 天 {h} 小时" beyond 24h, "剩余 {n} 小时"
 * inside it. Keep the mobile mirror (src/mobile/app/me/mePointsStore.ts) in
 * lockstep; a drift-guard test pins the two.
 */
export type MeExpiryParts =
  | { unit: 'expired'; n: number }
  | { unit: 'hours'; n: number }
  | { unit: 'days'; n: number; hours: number };

/** Expiry countdown: past → 'expired', within 24h → whole hours, else days+hours. */
export function meExpiryParts(expiryMs: number | null | undefined): MeExpiryParts | null {
  const expiry = Number(expiryMs);
  if (!Number.isFinite(expiry) || expiry <= 0) return null;
  const ms = expiry - Date.now();
  if (ms <= 0) return { unit: 'expired', n: 0 };
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) {
    // Under a day: round up so the line never says "0 小时" while time is
    // left (anything below the hour reads as "1 小时内").
    return { unit: 'hours', n: Math.max(1, Math.ceil(ms / 3_600_000)) };
  }
  return { unit: 'days', n: days, hours: Math.floor((ms % 86_400_000) / 3_600_000) };
}

/** Locale date for the expiry line, e.g. "2026/12/8". */
export function formatMeExpiryDate(expiryMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(expiryMs);
  } catch {
    return '—';
  }
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
