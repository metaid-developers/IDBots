import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addPendingPaymentRecord,
  confirmPendingPaymentRecord,
  hasPendingPaymentRecord,
  listPendingPaymentRecords,
  paymentRecordElapsed,
  PENDING_PAYMENT_STORAGE_KEY,
  type PendingPaymentRecord,
} from '../src/renderer/components/chat/paymentPendingRecords';

/** In-memory Storage stand-in (node has no localStorage). */
function createFakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

const record = (orderId: string, recordedAt = 1_793_641_471_526): PendingPaymentRecord => ({
  orderId,
  amountCents: 100,
  memo: orderId,
  recordedAt,
});

describe('local pending-payment records (「我已支付」)', () => {
  it('writes one record with orderId / amount / memo / time and reads it back', () => {
    const storage = createFakeStorage();
    const written = addPendingPaymentRecord(record('S3-20261103-0001'), storage);
    assert.equal(written.orderId, 'S3-20261103-0001');

    const list = listPendingPaymentRecords(storage);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], {
      orderId: 'S3-20261103-0001',
      amountCents: 100,
      memo: 'S3-20261103-0001',
      recordedAt: 1_793_641_471_526,
      // Reads normalize an explicit status; a fresh write is always pending.
      status: 'pending',
    });
    assert.equal(hasPendingPaymentRecord('S3-20261103-0001', storage), true);
    assert.equal(hasPendingPaymentRecord('S3-OTHER', storage), false);
  });

  it('treats a record written before the status field existed as pending', () => {
    const storage = createFakeStorage();
    // Byte-for-byte the pre-confirmation-loop shape (no status / confirmedAt).
    storage.setItem(
      PENDING_PAYMENT_STORAGE_KEY,
      JSON.stringify([
        { orderId: 'S3-LEGACY', amountCents: 250, memo: 'S3-LEGACY', recordedAt: 1_700_000_000_000 },
      ]),
    );

    const list = listPendingPaymentRecords(storage);
    assert.equal(list.length, 1, 'legacy row must not be dropped');
    assert.equal(list[0].status, 'pending');
    assert.equal(list[0].confirmedAt, undefined);
    assert.equal(hasPendingPaymentRecord('S3-LEGACY', storage), true);
  });

  it('confirms a record and persists the new status across a fresh read', () => {
    const storage = createFakeStorage();
    storage.setItem(
      PENDING_PAYMENT_STORAGE_KEY,
      JSON.stringify([
        { orderId: 'S3-CONFIRM', amountCents: 999, memo: 'S3-CONFIRM', recordedAt: 1_700_000_000_000 },
        { orderId: 'S3-KEEP', amountCents: 100, memo: 'S3-KEEP', recordedAt: 1_700_000_001_000 },
      ]),
    );

    const updated = confirmPendingPaymentRecord('S3-CONFIRM', storage, 1_800_000_000_000);
    assert.ok(updated);
    assert.equal(updated.status, 'confirmed');
    assert.equal(updated.confirmedAt, 1_800_000_000_000);

    // Persisted: the raw storage bytes carry the status, and a reader that
    // never saw the in-memory object agrees.
    const raw = JSON.parse(storage.getItem(PENDING_PAYMENT_STORAGE_KEY)!) as Array<Record<string, unknown>>;
    assert.equal(raw.find((r) => r.orderId === 'S3-CONFIRM')?.status, 'confirmed');
    const reloaded = listPendingPaymentRecords(storage);
    assert.equal(reloaded.find((r) => r.orderId === 'S3-CONFIRM')?.status, 'confirmed');
    assert.equal(reloaded.find((r) => r.orderId === 'S3-CONFIRM')?.confirmedAt, 1_800_000_000_000);
    // Neighbouring records are untouched.
    assert.equal(reloaded.find((r) => r.orderId === 'S3-KEEP')?.status, 'pending');
  });

  it('confirm returns null for an unknown order and leaves storage byte-identical', () => {
    const storage = createFakeStorage();
    addPendingPaymentRecord(record('S3-ONLY'), storage);
    const before = storage.getItem(PENDING_PAYMENT_STORAGE_KEY);
    assert.equal(confirmPendingPaymentRecord('S3-MISSING', storage), null);
    assert.equal(storage.getItem(PENDING_PAYMENT_STORAGE_KEY), before);
  });

  it('keeps a record whose memo/recordedAt are missing instead of dropping it', () => {
    const storage = createFakeStorage();
    storage.setItem(PENDING_PAYMENT_STORAGE_KEY, JSON.stringify([{ orderId: 'S3-THIN', amountCents: 500 }]));
    const list = listPendingPaymentRecords(storage);
    assert.equal(list.length, 1);
    assert.equal(list[0].memo, 'S3-THIN');
    assert.equal(list[0].recordedAt, 0);
    assert.equal(list[0].status, 'pending');
  });

  it('buckets elapsed time for the「已过多久」column', () => {
    assert.deepEqual(paymentRecordElapsed(1_000_000, 1_000_000 + 30_000), { unit: 'minute', value: 0 });
    assert.deepEqual(paymentRecordElapsed(1_000_000, 1_000_000 + 5 * 60_000), { unit: 'minute', value: 5 });
    assert.deepEqual(paymentRecordElapsed(1_000_000, 1_000_000 + 3 * 3_600_000), { unit: 'hour', value: 3 });
    assert.deepEqual(paymentRecordElapsed(1_000_000, 1_000_000 + 2 * 86_400_000), { unit: 'day', value: 2 });
    // A clock that walks backwards never renders a negative age.
    assert.deepEqual(paymentRecordElapsed(1_000_000, 999_000), { unit: 'minute', value: 0 });
  });

  it('dedupes by orderId (repeat taps refresh instead of stacking)', () => {
    const storage = createFakeStorage();
    addPendingPaymentRecord(record('S3-A', 1000), storage);
    addPendingPaymentRecord(record('S3-B', 2000), storage);
    addPendingPaymentRecord(record('S3-A', 3000), storage);

    const list = listPendingPaymentRecords(storage);
    assert.equal(list.length, 2);
    assert.equal(list[0].orderId, 'S3-A'); // refreshed entry moves to front
    assert.equal(list[0].recordedAt, 3000);
  });

  it('degrades to empty on damaged storage payloads', () => {
    const storage = createFakeStorage();
    storage.setItem(PENDING_PAYMENT_STORAGE_KEY, '{not json');
    assert.deepEqual(listPendingPaymentRecords(storage), []);

    storage.setItem(PENDING_PAYMENT_STORAGE_KEY, JSON.stringify([{ nope: true }]));
    assert.deepEqual(listPendingPaymentRecords(storage), []);
  });

  it('survives a missing storage (no throw, record not persisted)', () => {
    const written = addPendingPaymentRecord(record('S3-NOSTORE'), null);
    assert.equal(written.orderId, 'S3-NOSTORE');
    assert.deepEqual(listPendingPaymentRecords(null), []);
  });
});
