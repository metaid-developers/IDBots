import test from 'node:test';
import assert from 'node:assert/strict';

test('createServiceOrderTraceWriter delegates buyer and seller lifecycle transitions', async () => {
  const calls = [];
  const { createServiceOrderTraceWriter } = await import('../dist-electron/metabotRuntime/requestTraceRuntime.js');

  const writer = createServiceOrderTraceWriter({
    createBuyerOrder(input) {
      calls.push(['createBuyerOrder', input]);
      return { id: 'buyer-order-1' };
    },
    createSellerOrder(input) {
      calls.push(['createSellerOrder', input]);
      return { id: 'seller-order-1' };
    },
    markBuyerOrderFirstResponseReceived(input) {
      calls.push(['markBuyerOrderFirstResponseReceived', input]);
      return { id: 'buyer-order-1', status: 'in_progress' };
    },
    markSellerOrderFirstResponseSent(input) {
      calls.push(['markSellerOrderFirstResponseSent', input]);
      return { id: 'seller-order-1', status: 'in_progress' };
    },
    markBuyerOrderDelivered(input) {
      calls.push(['markBuyerOrderDelivered', input]);
      return { id: 'buyer-order-1', status: 'delivered' };
    },
    markSellerOrderDelivered(input) {
      calls.push(['markSellerOrderDelivered', input]);
      return { id: 'seller-order-1', status: 'delivered' };
    },
  });

  const buyerOrder = writer.createBuyerOrder({
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'idq1buyer',
    servicePinId: 'pin-1',
    serviceName: 'Service One',
    paymentTxid: 'order-1',
    paymentChain: 'mvc',
    paymentAmount: '0',
    paymentCurrency: 'SPACE',
    orderMessagePinId: 'order-pin-1',
  });
  const sellerOrder = writer.createSellerOrder({
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'idq1buyer',
    servicePinId: 'pin-1',
    serviceName: 'Service One',
    paymentTxid: 'order-1',
    paymentChain: 'mvc',
    paymentAmount: '0',
    paymentCurrency: 'SPACE',
    orderMessagePinId: 'order-pin-1',
  });
  writer.markBuyerOrderFirstResponseReceived({
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'idq1buyer',
    paymentTxid: 'order-1',
  });
  writer.markSellerOrderFirstResponseSent({
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'idq1buyer',
    paymentTxid: 'order-1',
  });
  writer.markBuyerOrderDelivered({
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'idq1buyer',
    paymentTxid: 'order-1',
    deliveryMessagePinId: 'delivery-pin-1',
  });
  writer.markSellerOrderDelivered({
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'idq1buyer',
    paymentTxid: 'order-1',
    deliveryMessagePinId: 'delivery-pin-1',
  });

  assert.equal(buyerOrder.id, 'buyer-order-1');
  assert.equal(sellerOrder.id, 'seller-order-1');
  assert.deepEqual(calls.map(([name]) => name), [
    'createBuyerOrder',
    'createSellerOrder',
    'markBuyerOrderFirstResponseReceived',
    'markSellerOrderFirstResponseSent',
    'markBuyerOrderDelivered',
    'markSellerOrderDelivered',
  ]);
});
