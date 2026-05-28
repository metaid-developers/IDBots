import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBuyerOrderProtocolMapping,
} from '../src/main/services/privateChatDaemon';
import {
  buildDeliveryMessage,
  buildNeedsRatingMessage,
  buildOrderEndMessage,
  buildOrderStatusMessage,
} from '../src/main/services/serviceOrderProtocols.js';

function createRoutingStore() {
  const calls: string[] = [];
  const first = {
    coworkSessionId: 'first-session',
    externalConversationId: 'first-conversation',
    metadataJson: JSON.stringify({ role: 'buyer', serviceOrderPinId: 'free-order-first-pin-i0' }),
  };
  const second = {
    coworkSessionId: 'second-session',
    externalConversationId: 'second-conversation',
    metadataJson: JSON.stringify({ role: 'buyer', serviceOrderPinId: 'free-order-second-pin-i0' }),
  };
  return {
    calls,
    first,
    second,
    store: {
      findOrderSessionByOrderPinId(_metabotId: number, _peerGlobalMetaId: string, orderPinId: string) {
        calls.push(`pin:${orderPinId}`);
        return orderPinId === 'free-order-first-pin-i0' ? first : second;
      },
      findOrderSessionByOrderTxid(_metabotId: number, _peerGlobalMetaId: string, orderTxid: string) {
        calls.push(`txid:${orderTxid}`);
        return second;
      },
      findOrderSessionByPeer() {
        calls.push('peer');
        return second;
      },
    },
  };
}

test('buyer order protocol routing uses explicit order pin before peer fallback for free-order messages', () => {
  const messages = [
    buildDeliveryMessage({
      serviceOrderPinId: 'free-order-first-pin-i0',
      orderPinId: 'free-order-first-pin-i0',
      result: 'first delivery',
    }, ''),
    buildOrderStatusMessage('', 'first status', 'free-order-first-pin-i0'),
    buildNeedsRatingMessage('', 'first rating request', 'free-order-first-pin-i0'),
    buildOrderEndMessage('', 'rated', 'first rating', 'free-order-first-pin-i0'),
  ];

  for (const plaintext of messages) {
    const { calls, first, store } = createRoutingStore();
    const mapping = resolveBuyerOrderProtocolMapping(store, {
      localMetabotId: 1,
      peerGlobalMetaId: 'seller-global-metaid',
      plaintext,
    });

    assert.equal(mapping, first);
    assert.deepEqual(calls, ['pin:free-order-first-pin-i0']);
  }
});

test('buyer order protocol routing keeps txid and peer fallback only for legacy unpinned messages', () => {
  const orderTxid = 'a'.repeat(64);
  const byTxid = createRoutingStore();
  const txidMapping = resolveBuyerOrderProtocolMapping(byTxid.store, {
    localMetabotId: 1,
    peerGlobalMetaId: 'seller-global-metaid',
    plaintext: buildOrderStatusMessage(orderTxid, 'paid status'),
  });

  assert.equal(txidMapping, byTxid.second);
  assert.deepEqual(byTxid.calls, [`txid:${orderTxid}`]);

  const legacy = createRoutingStore();
  const legacyMapping = resolveBuyerOrderProtocolMapping(legacy.store, {
    localMetabotId: 1,
    peerGlobalMetaId: 'seller-global-metaid',
    plaintext: '[NeedsRating] legacy invite',
  });

  assert.equal(legacyMapping, legacy.second);
  assert.deepEqual(legacy.calls, ['peer']);
});
