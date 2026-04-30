import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

const PAYMENT_TXID = 'a'.repeat(64);
const ORDER_TXID = 'b'.repeat(64);
const ACK_TXID = 'c'.repeat(64);
const DELIVERY_TXID = 'd'.repeat(64);

test('backfillMetawebOrderSimplemsgMetadata fills chain metadata without changing bubble content', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 1;
    const peerGlobalMetaId = 'seller-global-metaid';
    const externalConversationId = `metaweb_order:buyer:${metabotId}:${peerGlobalMetaId}:${PAYMENT_TXID.slice(0, 16)}`;
    const session = store.createSession(
      'Order session',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      peerGlobalMetaId,
      'Seller Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'buyer',
        peerGlobalMetaId,
        servicePaidTx: PAYMENT_TXID,
      }),
    });

    const orderContent = `[ORDER] 查询北京天气\n支付金额 0.0001 SPACE\ntxid: ${PAYMENT_TXID}`;
    const ackContent = '我已收到你的服务订单，马上开始处理。';
    const deliveryContent = `[DELIVERY] {"paymentTxid":"${PAYMENT_TXID}","result":"done"}`;

    const orderMessage = store.addMessage(session.id, {
      type: 'user',
      content: orderContent,
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId,
        direction: 'outgoing',
        txid: PAYMENT_TXID,
        paymentTxid: PAYMENT_TXID,
      },
    });
    const ackMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: ackContent,
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId,
        direction: 'incoming',
      },
    });
    const deliveryMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: deliveryContent,
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId,
        direction: 'incoming',
      },
    });

    const now = Date.now();
    sqlite.db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        order_message_pin_id, cowork_session_id, status, first_response_deadline_at,
        delivery_deadline_at, delivery_message_pin_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'order-1',
      'buyer',
      metabotId,
      peerGlobalMetaId,
      'service-weather',
      'weather',
      PAYMENT_TXID,
      'mvc',
      '0.0001',
      'SPACE',
      'native',
      `${ORDER_TXID}i0`,
      session.id,
      'completed',
      now + 60_000,
      now + 120_000,
      `${DELIVERY_TXID}i0`,
      now,
      now,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${ACK_TXID}i0`,
      ACK_TXID,
      'seller-metaid',
      peerGlobalMetaId,
      'buyer-metaid',
      'buyer-global-metaid',
      'simplemsg',
      ackContent,
      1,
    ]);

    const changed = store.backfillMetawebOrderSimplemsgMetadata();
    assert.equal(changed, 3);

    const updated = store.getSession(session.id);
    const updatedOrder = updated.messages.find((message) => message.id === orderMessage.id);
    const updatedAck = updated.messages.find((message) => message.id === ackMessage.id);
    const updatedDelivery = updated.messages.find((message) => message.id === deliveryMessage.id);

    assert.equal(updatedOrder.content, orderContent);
    assert.equal(updatedOrder.metadata.txid, ORDER_TXID);
    assert.equal(updatedOrder.metadata.pinId, `${ORDER_TXID}i0`);
    assert.equal(updatedOrder.metadata.paymentTxid, PAYMENT_TXID);

    assert.equal(updatedAck.content, ackContent);
    assert.equal(updatedAck.metadata.txid, ACK_TXID);
    assert.equal(updatedAck.metadata.pinId, `${ACK_TXID}i0`);

    assert.equal(updatedDelivery.content, deliveryContent);
    assert.equal(updatedDelivery.metadata.txid, DELIVERY_TXID);
    assert.equal(updatedDelivery.metadata.pinId, `${DELIVERY_TXID}i0`);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 0);
  } finally {
    sqlite.cleanup();
  }
});
