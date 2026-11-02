import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addPendingPaymentRecord,
  hasPendingPaymentRecord,
  listPendingPaymentRecords,
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
    });
    assert.equal(hasPendingPaymentRecord('S3-20261103-0001', storage), true);
    assert.equal(hasPendingPaymentRecord('S3-OTHER', storage), false);
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
