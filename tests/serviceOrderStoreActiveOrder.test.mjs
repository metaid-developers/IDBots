import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  createSqliteStore,
} from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');

function createOrder(store, overrides = {}) {
  return store.createOrder({
    role: overrides.role ?? 'buyer',
    localMetabotId: overrides.localMetabotId ?? 1,
    counterpartyGlobalMetaid: overrides.counterpartyGlobalMetaid ?? 'peer-global',
    serviceName: overrides.serviceName ?? 'Weather',
    paymentTxid: overrides.paymentTxid ?? 'a'.repeat(64),
    paymentAmount: overrides.paymentAmount ?? '0.01',
    status: overrides.status ?? 'awaiting_first_response',
    now: overrides.now ?? 1_770_000_000_000,
  });
}

test('hasActiveOrderForPrivateChatSuppression matches active statuses for a peer', async () => {
  const sqlite = await createSqliteStore();

  try {
    const store = new ServiceOrderStore(sqlite.db, () => {});
    const statuses = ['awaiting_first_response', 'in_progress', 'rating_pending', 'refund_pending'];

    for (const [index, status] of statuses.entries()) {
      createOrder(store, {
        status,
        paymentTxid: `${index}`.repeat(64).slice(0, 64),
      });
      assert.equal(
        store.hasActiveOrderForPrivateChatSuppression(1, 'peer-global'),
        true,
        `status ${status} should suppress ordinary private-chat auto-reply`,
      );
      sqlite.db.run('DELETE FROM service_orders');
    }
  } finally {
    sqlite.cleanup();
  }
});

test('hasActiveOrderForPrivateChatSuppression ignores terminal statuses', async () => {
  const sqlite = await createSqliteStore();

  try {
    const store = new ServiceOrderStore(sqlite.db, () => {});
    createOrder(store, { status: 'completed', paymentTxid: 'b'.repeat(64) });
    createOrder(store, { status: 'refunded', paymentTxid: 'c'.repeat(64) });
    createOrder(store, {
      status: 'failed',
      role: 'seller',
      paymentTxid: 'd'.repeat(64),
    });

    assert.equal(store.hasActiveOrderForPrivateChatSuppression(1, 'peer-global'), false);
  } finally {
    sqlite.cleanup();
  }
});

test('buyer failed refund retry remains active until refund request exists', async () => {
  const sqlite = await createSqliteStore();

  try {
    const store = new ServiceOrderStore(sqlite.db, () => {});
    const failed = createOrder(store, {
      role: 'buyer',
      status: 'failed',
      paymentTxid: 'e'.repeat(64),
    });

    assert.equal(store.hasActiveOrderForPrivateChatSuppression(1, 'peer-global'), true);

    store.markRefundPending(failed.id, 'refund-request-pin', 1_770_000_001_000);

    assert.equal(store.hasActiveOrderForPrivateChatSuppression(1, 'peer-global'), true);

    store.markRefunded(failed.id, {
      refundTxid: 'f'.repeat(64),
      refundFinalizePinId: 'refund-finalize-pin',
      refundCompletedAt: 1_770_000_002_000,
    });

    assert.equal(store.hasActiveOrderForPrivateChatSuppression(1, 'peer-global'), false);
  } finally {
    sqlite.cleanup();
  }
});
