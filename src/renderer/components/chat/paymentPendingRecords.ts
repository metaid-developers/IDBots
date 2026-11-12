/**
 * Local "I have paid" pending-verification records (S3 fiat slice).
 *
 * Personal Alipay transfers have no callback API (design doc 01 §1), so the
 * loop closes on evidence: when the buyer taps 「我已支付」 the card writes
 * one local record (orderId / amount / memo / time); the seller's「待核验」
 * panel (PendingPaymentRecordsPanel) lists it and flips it to 'confirmed'
 * once the money is actually seen. Records live in localStorage only — they
 * never go on-chain and never leave the device.
 *
 * Status contract: records written before the confirmation loop existed have
 * no `status` field; every read normalizes a missing/invalid status to
 * 'pending' so an old row is never dropped and never silently looks
 * confirmed. Confirmation is a human action — there is no platform callback.
 *
 * The storage is injectable so tests drive the module without a DOM.
 */

export type PendingPaymentStatus = 'pending' | 'confirmed';

export interface PendingPaymentRecord {
  orderId: string;
  amountCents: number;
  /** Payment memo — the card forces it to the orderId. */
  memo: string;
  /** When the buyer marked the order paid (unix ms). */
  recordedAt: number;
  /** Absent on pre-confirmation-loop rows; reads normalize it to 'pending'. */
  status?: PendingPaymentStatus;
  /** When the seller confirmed receipt (unix ms); only set with 'confirmed'. */
  confirmedAt?: number;
}

export const PENDING_PAYMENT_STORAGE_KEY = 'idbots.payment.pendingRecords';
const MAX_RECORDS = 200;

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

/**
 * Normalize one stored row. Only orderId + amountCents are required (the same
 * gate the previous version used); a row missing memo/recordedAt keeps its
 * identity and gets safe defaults instead of being dropped.
 */
function normalizeRecord(row: Record<string, unknown>): PendingPaymentRecord {
  const orderId = row.orderId as string;
  const confirmed = row.status === 'confirmed';
  const record: PendingPaymentRecord = {
    orderId,
    amountCents: row.amountCents as number,
    memo: asString(row.memo, orderId),
    recordedAt: typeof row.recordedAt === 'number' ? row.recordedAt : 0,
    status: confirmed ? 'confirmed' : 'pending',
  };
  if (confirmed && typeof row.confirmedAt === 'number') {
    record.confirmedAt = row.confirmedAt;
  }
  return record;
}

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

/**
 * Add (or refresh, keyed by orderId) a record for a fresh「我已支付」tap.
 * A repeat tap is a new payment claim, so it resets an earlier confirmed row
 * back to 'pending'. Returns the written record.
 */
export function addPendingPaymentRecord(
  record: PendingPaymentRecord,
  storage?: StorageLike | null,
): PendingPaymentRecord {
  const stored: PendingPaymentRecord = {
    orderId: record.orderId,
    amountCents: record.amountCents,
    memo: record.memo,
    recordedAt: record.recordedAt,
    status: 'pending',
  };
  const store = resolveStorage(storage);
  if (!store) return stored;
  const existing = listPendingPaymentRecords(store);
  const next = [stored, ...existing.filter((r) => r.orderId !== stored.orderId)].slice(0, MAX_RECORDS);
  store.setItem(PENDING_PAYMENT_STORAGE_KEY, JSON.stringify(next));
  return stored;
}

/**
 * All records, newest first, each with an explicit status. Damaged payloads
 * degrade to an empty list; a damaged ROW is skipped, never the whole list.
 */
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
    return parsed
      .filter(
        (r): r is Record<string, unknown> =>
          Boolean(r && typeof r === 'object' && typeof r.orderId === 'string' && typeof r.amountCents === 'number'),
      )
      .map(normalizeRecord);
  } catch {
    return [];
  }
}

/**
 * Mark one order's record as seller-confirmed and persist it. Returns the
 * updated record, or null when the order has no record (or no storage).
 */
export function confirmPendingPaymentRecord(
  orderId: string,
  storage?: StorageLike | null,
  now: number = Date.now(),
): PendingPaymentRecord | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  const records = listPendingPaymentRecords(store);
  const target = records.find((r) => r.orderId === orderId);
  if (!target) return null;
  const updated: PendingPaymentRecord = { ...target, status: 'confirmed', confirmedAt: now };
  store.setItem(
    PENDING_PAYMENT_STORAGE_KEY,
    JSON.stringify(records.map((r) => (r.orderId === orderId ? updated : r))),
  );
  return updated;
}

/** True when this order already has a record (drives the card's「已记录」state). */
export function hasPendingPaymentRecord(orderId: string, storage?: StorageLike | null): boolean {
  return listPendingPaymentRecords(storage).some((r) => r.orderId === orderId);
}

/**
 * Elapsed time since a record was written, bucketed for display. Ordering is
 * left to the caller (minute/hour/day keys differ per language).
 */
export function paymentRecordElapsed(
  recordedAt: number,
  now: number = Date.now(),
): { unit: 'minute' | 'hour' | 'day'; value: number } {
  const minutes = Math.max(0, Math.floor((now - recordedAt) / 60_000));
  if (minutes < 60) return { unit: 'minute', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hour', value: hours };
  return { unit: 'day', value: Math.floor(hours / 24) };
}
