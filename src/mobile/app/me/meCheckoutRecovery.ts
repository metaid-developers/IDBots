import type { MePeriod } from './mePointsStore';
import type { MePaymentGateway, MePurchaseSubmitSection } from './purchaseSubmit';

const STORAGE_KEY = 'idbots.mobile.meCheckout.v1';

export interface MeCheckoutRecovery {
  section: MePurchaseSubmitSection;
  orderId: string;
  planId?: string;
  packageId?: string;
  period: MePeriod;
  gateway: MePaymentGateway;
  createdAt: number;
}

function storageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadMeCheckoutRecovery(): MeCheckoutRecovery | null {
  const storage = storageOrNull();
  if (!storage) return null;
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Partial<MeCheckoutRecovery> | null;
    if (!raw || (raw.section !== 'subscribe' && raw.section !== 'topup')) return null;
    if (typeof raw.orderId !== 'string' || !raw.orderId.trim()) return null;
    if (!['month', 'quarter', 'year'].includes(raw.period ?? '')) return null;
    if (raw.gateway !== 'alipay' && raw.gateway !== 'paypal') return null;
    return {
      section: raw.section,
      orderId: raw.orderId.trim(),
      ...(typeof raw.planId === 'string' && raw.planId ? { planId: raw.planId } : {}),
      ...(typeof raw.packageId === 'string' && raw.packageId ? { packageId: raw.packageId } : {}),
      period: raw.period as MePeriod,
      gateway: raw.gateway,
      createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveMeCheckoutRecovery(recovery: MeCheckoutRecovery): void {
  const storage = storageOrNull();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(recovery));
  } catch {
    return;
  }
}

export function clearMeCheckoutRecovery(orderId?: string): void {
  const storage = storageOrNull();
  if (!storage) return;
  if (orderId) {
    const current = loadMeCheckoutRecovery();
    if (current && current.orderId !== orderId) return;
  }
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}
