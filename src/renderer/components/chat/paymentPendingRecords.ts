/**
 * Local "I have paid" pending-verification records (S3 fiat slice).
 *
 * Personal Alipay transfers have no callback API (design doc 01 §1), so the
 * loop closes on evidence: when the buyer taps 「我已支付」 the card writes
 * one local record (orderId / amount / memo / time) for later reconciliation
 * against the seller's confirmation. Records live in localStorage only —
 * they never go on-chain and never leave the device.
 *
 * The storage is injectable so tests drive the module without a DOM.
 */

export interface PendingPaymentRecord {
  orderId: string;
  amountCents: number;
  /** Payment memo — the card forces it to the orderId. */
  memo: string;
  /** When the buyer marked the order paid (unix ms). */
  recordedAt: number;
}

export const PENDING_PAYMENT_STORAGE_KEY = 'idbots.payment.pendingRecords';
const MAX_RECORDS = 200;

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Some sandboxed contexts throw on touching localStorage — degrade to
    // no persistence rather than crashing the card.
  }
  return null;
}

/** Add (or refresh, keyed by orderId) a pending record. Returns the written record. */
export function addPendingPaymentRecord(
  record: PendingPaymentRecord,
  storage?: StorageLike | null,
): PendingPaymentRecord {
  const store = resolveStorage(storage);
  if (!store) return record;
  const existing = listPendingPaymentRecords(store);
  const next = [record, ...existing.filter((r) => r.orderId !== record.orderId)].slice(0, MAX_RECORDS);
  store.setItem(PENDING_PAYMENT_STORAGE_KEY, JSON.stringify(next));
  return record;
}

/** All pending records, newest first. Damaged payloads degrade to an empty list. */
export function listPendingPaymentRecords(storage?: StorageLike | null): PendingPaymentRecord[] {
  const store = resolveStorage(storage);
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(PENDING_PAYMENT_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is PendingPaymentRecord =>
      Boolean(r && typeof r === 'object' && typeof r.orderId === 'string' && typeof r.amountCents === 'number'));
  } catch {
    return [];
  }
}

/** True when this order already has a pending record (drives the card's「已记录」state). */
export function hasPendingPaymentRecord(orderId: string, storage?: StorageLike | null): boolean {
  return listPendingPaymentRecords(storage).some((r) => r.orderId === orderId);
}
