import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

const {
  publishServiceOrderEventToCowork,
} = await import('../dist-electron/services/serviceOrderCoworkBridge.js');

test('publishServiceOrderEventToCowork clears delegation blocking for buyer refund requests', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const session = store.createSession(
      'Delegation session',
      process.cwd(),
      '',
      'local',
      [],
      7
    );

    store.setDelegationBlocking(session.id, true, 'order-123');

    const result = publishServiceOrderEventToCowork(store, 'refund_requested', {
      id: 'order-123',
      role: 'buyer',
      coworkSessionId: session.id,
      paymentTxid: 'c'.repeat(64),
      refundRequestPinId: 'refund-pin-1',
      refundTxid: null,
    });

    assert.equal(store.isDelegationBlocking(session.id), false);
    assert.equal(result.delegationStateChange?.sessionId, session.id);
    assert.equal(result.delegationStateChange?.blocking, false);

    const updatedSession = store.getSession(session.id);
    const lastMessage = updatedSession?.messages?.[updatedSession.messages.length - 1] ?? null;
    assert.ok(lastMessage);
    assert.equal(lastMessage?.type, 'system');
    assert.match(lastMessage?.content || '', /服务订单已超时，已自动发起全额退款申请/);
    assert.match(lastMessage?.content || '', /申请凭证：refund-pin-1/);
    assert.equal(result.message?.id, lastMessage?.id);
  } finally {
    sqlite.cleanup();
  }
});

test('publishServiceOrderEventToCowork keeps non-blocked seller sessions unchanged', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const session = store.createSession(
      'Seller order session',
      process.cwd(),
      '',
      'local',
      [],
      9,
      'a2a',
      'buyer-global-metaid',
      'Buyer',
      null
    );

    const result = publishServiceOrderEventToCowork(store, 'refund_requested', {
      id: 'seller-order-1',
      role: 'seller',
      coworkSessionId: session.id,
      paymentTxid: 'd'.repeat(64),
      refundRequestPinId: 'refund-pin-seller',
      refundTxid: null,
    });

    assert.equal(store.isDelegationBlocking(session.id), false);
    assert.equal(result.delegationStateChange, null);
    assert.match(result.message?.content || '', /买家已发起全额退款申请/);
  } finally {
    sqlite.cleanup();
  }
});
