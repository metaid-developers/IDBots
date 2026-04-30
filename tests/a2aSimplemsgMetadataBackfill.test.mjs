import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

const PAYMENT_TXID = 'a'.repeat(64);
const ORDER_TXID = 'b'.repeat(64);
const ACK_TXID = 'c'.repeat(64);
const STATUS_TXID = 'f'.repeat(64);
const OLD_STATUS_TXID = '9'.repeat(64);
const DELIVERY_TXID = 'd'.repeat(64);
const RATING_TXID = 'e'.repeat(64);
const PRIVATE_INCOMING_TXID = '1'.repeat(64);
const PRIVATE_OUTGOING_TXID = '2'.repeat(64);
const PRIVATE_OLD_DUPLICATE_TXID = '3'.repeat(64);
const OTHER_DELIVERY_TXID = '4'.repeat(64);

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
    const statusContent = '技能执行完毕，数字成果已生成，正在将数字成果上传链上交付，请耐心等待。';
    const deliveryContent = `[DELIVERY] {"paymentTxid":"${PAYMENT_TXID}","result":"done"}`;
    const ratingContent = '评分：5分。很满意，谢谢！\n\n我的评分已记录在链上（pin ID: rate-pin）。';

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
    const statusMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: statusContent,
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
    const ratingMessage = store.addMessage(session.id, {
      type: 'user',
      content: ratingContent,
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId,
        direction: 'outgoing',
      },
    });
    const statusCreatedAt = 1_777_427_683_855;
    sqlite.db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [statusCreatedAt, statusMessage.id]);

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
      '/protocols/simplemsg',
      ackContent,
      1,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${OLD_STATUS_TXID}i0`,
      OLD_STATUS_TXID,
      'seller-metaid',
      peerGlobalMetaId,
      'buyer-metaid',
      'buyer-global-metaid',
      '/protocols/simplemsg',
      statusContent,
      Math.floor((statusCreatedAt - 86_400_000) / 1000),
      1,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${STATUS_TXID}i0`,
      STATUS_TXID,
      'seller-metaid',
      peerGlobalMetaId,
      'buyer-metaid',
      'buyer-global-metaid',
      '/protocols/simplemsg',
      statusContent,
      Math.floor((statusCreatedAt + 2_000) / 1000),
      1,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${RATING_TXID}i0`,
      RATING_TXID,
      'buyer-metaid',
      'buyer-global-metaid',
      'seller-metaid',
      peerGlobalMetaId,
      '/protocols/simplemsg',
      ratingContent,
      1,
    ]);

    const changed = store.backfillMetawebOrderSimplemsgMetadata();
    assert.equal(changed, 5);

    const updated = store.getSession(session.id);
    const updatedOrder = updated.messages.find((message) => message.id === orderMessage.id);
    const updatedAck = updated.messages.find((message) => message.id === ackMessage.id);
    const updatedStatus = updated.messages.find((message) => message.id === statusMessage.id);
    const updatedDelivery = updated.messages.find((message) => message.id === deliveryMessage.id);
    const updatedRating = updated.messages.find((message) => message.id === ratingMessage.id);

    assert.equal(updatedOrder.content, orderContent);
    assert.equal(updatedOrder.metadata.txid, ORDER_TXID);
    assert.equal(updatedOrder.metadata.pinId, `${ORDER_TXID}i0`);
    assert.equal(updatedOrder.metadata.paymentTxid, PAYMENT_TXID);

    assert.equal(updatedAck.content, ackContent);
    assert.equal(updatedAck.metadata.txid, ACK_TXID);
    assert.equal(updatedAck.metadata.pinId, `${ACK_TXID}i0`);

    assert.equal(updatedStatus.content, statusContent);
    assert.equal(updatedStatus.metadata.txid, STATUS_TXID);
    assert.equal(updatedStatus.metadata.pinId, `${STATUS_TXID}i0`);

    assert.equal(updatedDelivery.content, deliveryContent);
    assert.equal(updatedDelivery.metadata.txid, DELIVERY_TXID);
    assert.equal(updatedDelivery.metadata.pinId, `${DELIVERY_TXID}i0`);

    assert.equal(updatedRating.content, ratingContent);
    assert.equal(updatedRating.metadata.txid, RATING_TXID);
    assert.equal(updatedRating.metadata.pinId, `${RATING_TXID}i0`);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 0);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata syncs seller local acknowledgement to transmitted simplemsg', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 2;
    const buyerGlobalMetaId = 'buyer-global-metaid';
    const sellerGlobalMetaId = 'seller-global-metaid';
    const externalConversationId = `metaweb_order:seller:${metabotId}:${buyerGlobalMetaId}:${PAYMENT_TXID.slice(0, 16)}`;
    const session = store.createSession(
      'Seller order session',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      buyerGlobalMetaId,
      'Buyer Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: buyerGlobalMetaId,
        serverBotGlobalMetaId: sellerGlobalMetaId,
        servicePaidTx: PAYMENT_TXID,
      }),
    });

    const localPlaceholder = 'Buyer Bot，已收到你的服务订单，技能执行可能需要一些时间，正在处理，请耐心等待最终结果。';
    const transmittedAck = '嗨 Buyer Bot，你的像素风机器人图片我收到啦，现在就开始动手创作，稍等片刻，马上就好哦！';
    const acknowledgement = store.addMessage(session.id, {
      type: 'assistant',
      content: localPlaceholder,
      metadata: {
        sourceChannel: 'metaweb_private',
        externalConversationId,
        direction: 'outgoing',
        excludeFromSandboxHistory: true,
        orderProcessingNotice: true,
      },
    });
    const acknowledgementCreatedAt = 1_777_427_593_787;
    sqlite.db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [
      acknowledgementCreatedAt,
      acknowledgement.id,
    ]);

    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${ACK_TXID}i0`,
      ACK_TXID,
      'seller-metaid',
      sellerGlobalMetaId,
      'buyer-metaid',
      buyerGlobalMetaId,
      '/protocols/simplemsg',
      transmittedAck,
      Math.floor((acknowledgementCreatedAt + 1_000) / 1000),
      1,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${STATUS_TXID}i0`,
      STATUS_TXID,
      'seller-metaid',
      sellerGlobalMetaId,
      'buyer-metaid',
      buyerGlobalMetaId,
      '/protocols/simplemsg',
      '技能执行完毕，数字成果已生成，正在将数字成果上传链上交付，请耐心等待。',
      Math.floor((acknowledgementCreatedAt + 90_000) / 1000),
      1,
    ]);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 1);

    const updated = store.getSession(session.id).messages.find((message) => message.id === acknowledgement.id);
    assert.ok(updated);
    assert.equal(updated.content, transmittedAck);
    assert.equal(updated.metadata.txid, ACK_TXID);
    assert.deepEqual(updated.metadata.txids, [ACK_TXID]);
    assert.equal(updated.metadata.pinId, `${ACK_TXID}i0`);
    assert.equal(updated.metadata.orderProcessingNotice, true);
    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 0);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata turns seller upload-complete status into delivery simplemsg bubble', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 2;
    const buyerGlobalMetaId = 'buyer-global-metaid';
    const sellerGlobalMetaId = 'seller-global-metaid';
    const externalConversationId = `metaweb_order:seller:${metabotId}:${buyerGlobalMetaId}:${PAYMENT_TXID.slice(0, 16)}`;
    const session = store.createSession(
      'Seller delivery session',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      buyerGlobalMetaId,
      'Buyer Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: buyerGlobalMetaId,
        serverBotGlobalMetaId: sellerGlobalMetaId,
        servicePaidTx: PAYMENT_TXID,
      }),
    });

    const localFinal = '# 像素风格机器人图片\n\n图片已生成完成。';
    const deliverySummary = '数字成果已生成并上传链上交付。\n交付文件: metafile://delivery-pin-i0.png';
    const deliveryContent = `[DELIVERY] {"paymentTxid":"${PAYMENT_TXID}","serviceName":"seedream","result":"${localFinal.replace(/\n/g, '\\n')}\\n\\n${deliverySummary.replace(/\n/g, '\\n')}","deliveredAt":1777427686}`;

    const finalMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: localFinal,
      metadata: {
        isFinal: true,
        isStreaming: false,
      },
    });
    const uploadCompleteMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: deliverySummary,
      metadata: {
        direction: 'outgoing',
        excludeFromSandboxHistory: true,
        orderDeliveryUploadComplete: true,
      },
    });
    const deliveredAt = 1_777_427_686_000;
    sqlite.db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [
      deliveredAt,
      uploadCompleteMessage.id,
    ]);

    const now = Date.now();
    sqlite.db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        order_message_pin_id, cowork_session_id, status, first_response_deadline_at,
        delivery_deadline_at, delivery_message_pin_id, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'seller-order-1',
      'seller',
      metabotId,
      buyerGlobalMetaId,
      'service-image',
      'seedream',
      PAYMENT_TXID,
      'mvc',
      '0.001',
      'SPACE',
      'native',
      `${ORDER_TXID}i0`,
      session.id,
      'completed',
      now + 60_000,
      now + 120_000,
      `${DELIVERY_TXID}i0`,
      deliveredAt,
      now,
      now,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${DELIVERY_TXID}i0`,
      DELIVERY_TXID,
      'seller-metaid',
      sellerGlobalMetaId,
      'buyer-metaid',
      buyerGlobalMetaId,
      '/protocols/simplemsg',
      deliveryContent,
      Math.floor(deliveredAt / 1000),
      1,
    ]);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 1);

    const updated = store.getSession(session.id);
    const unchangedFinal = updated.messages.find((message) => message.id === finalMessage.id);
    const deliveryBubble = updated.messages.find((message) => message.id === uploadCompleteMessage.id);

    assert.equal(unchangedFinal.content, localFinal);
    assert.equal(unchangedFinal.metadata.txid, undefined);

    assert.equal(deliveryBubble.content, deliveryContent);
    assert.equal(deliveryBubble.metadata.txid, DELIVERY_TXID);
    assert.deepEqual(deliveryBubble.metadata.txids, [DELIVERY_TXID]);
    assert.equal(deliveryBubble.metadata.pinId, `${DELIVERY_TXID}i0`);
    assert.equal(deliveryBubble.metadata.orderDeliveryMessage, true);
    assert.equal(deliveryBubble.metadata.orderDeliveryUploadComplete, undefined);
    assert.equal(deliveryBubble.metadata.sourceChannel, 'metaweb_private');
    assert.equal(deliveryBubble.metadata.externalConversationId, `metaweb-private:${buyerGlobalMetaId}`);
    assert.equal(deliveryBubble.metadata.orderMappingExternalConversationId, externalConversationId);
    assert.equal(deliveryBubble.metadata.paymentTxid, PAYMENT_TXID);
    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 0);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata turns legacy seller final result into delivery simplemsg bubble', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 2;
    const buyerGlobalMetaId = 'buyer-global-metaid';
    const sellerGlobalMetaId = 'seller-global-metaid';
    const externalConversationId = `metaweb_order:seller:${metabotId}:${buyerGlobalMetaId}:${PAYMENT_TXID.slice(0, 16)}`;
    const session = store.createSession(
      'Weather delivery session',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      buyerGlobalMetaId,
      'Buyer Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: buyerGlobalMetaId,
        serverBotGlobalMetaId: sellerGlobalMetaId,
        servicePaidTx: PAYMENT_TXID,
      }),
    });

    const localFinal = '## 北京当前天气\n\n☀️  晴天，**+27°C**';
    const deliveryContent = `[DELIVERY] {"paymentTxid":"${PAYMENT_TXID}","serviceName":"weather","result":"${localFinal.replace(/\n/g, '\\n')}","deliveredAt":1777427686}`;
    const finalMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: localFinal,
      metadata: {
        isFinal: true,
        isStreaming: false,
      },
    });
    const deliveredAt = 1_777_427_686_000;
    sqlite.db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [
      deliveredAt,
      finalMessage.id,
    ]);

    const now = Date.now();
    sqlite.db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        order_message_pin_id, cowork_session_id, status, first_response_deadline_at,
        delivery_deadline_at, delivery_message_pin_id, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'seller-order-legacy-final',
      'seller',
      metabotId,
      buyerGlobalMetaId,
      'service-weather',
      'weather',
      PAYMENT_TXID,
      'mvc',
      '0.001',
      'SPACE',
      'native',
      `${ORDER_TXID}i0`,
      session.id,
      'completed',
      now + 60_000,
      now + 120_000,
      `${DELIVERY_TXID}i0`,
      deliveredAt,
      now,
      now,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${DELIVERY_TXID}i0`,
      DELIVERY_TXID,
      'seller-metaid',
      sellerGlobalMetaId,
      'buyer-metaid',
      buyerGlobalMetaId,
      '/protocols/simplemsg',
      deliveryContent,
      Math.floor(deliveredAt / 1000),
      1,
    ]);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 1);

    const updated = store.getSession(session.id);
    const deliveryBubble = updated.messages.find((message) => message.id === finalMessage.id);

    assert.equal(deliveryBubble.content, deliveryContent);
    assert.equal(deliveryBubble.metadata.txid, DELIVERY_TXID);
    assert.deepEqual(deliveryBubble.metadata.txids, [DELIVERY_TXID]);
    assert.equal(deliveryBubble.metadata.pinId, `${DELIVERY_TXID}i0`);
    assert.equal(deliveryBubble.metadata.orderDeliveryMessage, true);
    assert.equal(deliveryBubble.metadata.sourceChannel, 'metaweb_private');
    assert.equal(deliveryBubble.metadata.externalConversationId, `metaweb-private:${buyerGlobalMetaId}`);
    assert.equal(deliveryBubble.metadata.orderMappingExternalConversationId, externalConversationId);
    assert.equal(deliveryBubble.metadata.direction, 'outgoing');
    assert.equal(deliveryBubble.metadata.paymentTxid, PAYMENT_TXID);
    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 0);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata ignores unrelated existing delivery bubble while binding legacy final result', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 2;
    const buyerGlobalMetaId = 'buyer-global-metaid';
    const sellerGlobalMetaId = 'seller-global-metaid';
    const externalConversationId = `metaweb_order:seller:${metabotId}:${buyerGlobalMetaId}:${PAYMENT_TXID.slice(0, 16)}`;
    const session = store.createSession(
      'Multiple delivery session',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      buyerGlobalMetaId,
      'Buyer Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: buyerGlobalMetaId,
        serverBotGlobalMetaId: sellerGlobalMetaId,
        servicePaidTx: PAYMENT_TXID,
      }),
    });

    const existingDelivery = store.addMessage(session.id, {
      type: 'assistant',
      content: '上一笔订单已交付。',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId,
        direction: 'outgoing',
        orderDeliveryMessage: true,
        pinId: `${OTHER_DELIVERY_TXID}i0`,
        txid: OTHER_DELIVERY_TXID,
        txids: [OTHER_DELIVERY_TXID],
      },
    });
    const localFinal = '## 北京当前天气\n\n☀️  晴天，**+27°C**';
    const deliveryContent = `[DELIVERY] {"paymentTxid":"${PAYMENT_TXID}","serviceName":"weather","result":"${localFinal.replace(/\n/g, '\\n')}","deliveredAt":1777427686}`;
    const finalMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: localFinal,
      metadata: {
        isFinal: true,
        isStreaming: false,
      },
    });

    const now = Date.now();
    sqlite.db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        order_message_pin_id, cowork_session_id, status, first_response_deadline_at,
        delivery_deadline_at, delivery_message_pin_id, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'seller-order-with-prior-delivery',
      'seller',
      metabotId,
      buyerGlobalMetaId,
      'service-weather',
      'weather',
      PAYMENT_TXID,
      'mvc',
      '0.001',
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
      now,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${DELIVERY_TXID}i0`,
      DELIVERY_TXID,
      'seller-metaid',
      sellerGlobalMetaId,
      'buyer-metaid',
      buyerGlobalMetaId,
      '/protocols/simplemsg',
      deliveryContent,
      Math.floor(now / 1000),
      1,
    ]);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 1);

    const updated = store.getSession(session.id);
    const unchangedExisting = updated.messages.find((message) => message.id === existingDelivery.id);
    const deliveryBubble = updated.messages.find((message) => message.id === finalMessage.id);

    assert.equal(unchangedExisting.metadata.pinId, `${OTHER_DELIVERY_TXID}i0`);
    assert.equal(deliveryBubble.content, deliveryContent);
    assert.equal(deliveryBubble.metadata.pinId, `${DELIVERY_TXID}i0`);
    assert.equal(deliveryBubble.metadata.orderDeliveryMessage, true);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata does not bind unrelated legacy seller final text to delivery', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 2;
    const buyerGlobalMetaId = 'buyer-global-metaid';
    const sellerGlobalMetaId = 'seller-global-metaid';
    const externalConversationId = `metaweb_order:seller:${metabotId}:${buyerGlobalMetaId}:${PAYMENT_TXID.slice(0, 16)}`;
    const session = store.createSession(
      'Unrelated final session',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      buyerGlobalMetaId,
      'Buyer Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: buyerGlobalMetaId,
        serverBotGlobalMetaId: sellerGlobalMetaId,
        servicePaidTx: PAYMENT_TXID,
      }),
    });

    const unrelatedFinal = '内部工具整理完成。';
    const deliveryContent = `[DELIVERY] {"paymentTxid":"${PAYMENT_TXID}","serviceName":"weather","result":"## 北京当前天气\\n\\n☀️  晴天，**+27°C**","deliveredAt":1777427686}`;
    const finalMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: unrelatedFinal,
      metadata: {
        isFinal: true,
        isStreaming: false,
      },
    });

    const now = Date.now();
    sqlite.db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        order_message_pin_id, cowork_session_id, status, first_response_deadline_at,
        delivery_deadline_at, delivery_message_pin_id, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'seller-order-unrelated-final',
      'seller',
      metabotId,
      buyerGlobalMetaId,
      'service-weather',
      'weather',
      PAYMENT_TXID,
      'mvc',
      '0.001',
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
      now,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${DELIVERY_TXID}i0`,
      DELIVERY_TXID,
      'seller-metaid',
      sellerGlobalMetaId,
      'buyer-metaid',
      buyerGlobalMetaId,
      '/protocols/simplemsg',
      deliveryContent,
      Math.floor(now / 1000),
      1,
    ]);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 0);

    const updated = store.getSession(session.id);
    const unchanged = updated.messages.find((message) => message.id === finalMessage.id);

    assert.equal(unchanged.content, unrelatedFinal);
    assert.equal(unchanged.metadata.txid, undefined);
    assert.equal(unchanged.metadata.pinId, undefined);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata does not match legacy final text outside delivery result fields', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 2;
    const buyerGlobalMetaId = 'buyer-global-metaid';
    const sellerGlobalMetaId = 'seller-global-metaid';
    const externalConversationId = `metaweb_order:seller:${metabotId}:${buyerGlobalMetaId}:${PAYMENT_TXID.slice(0, 16)}`;
    const session = store.createSession(
      'Delivery metadata field session',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      buyerGlobalMetaId,
      'Buyer Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: buyerGlobalMetaId,
        serverBotGlobalMetaId: sellerGlobalMetaId,
        servicePaidTx: PAYMENT_TXID,
      }),
    });

    const unrelatedFinal = 'weather';
    const deliveryContent = `[DELIVERY] {"paymentTxid":"${PAYMENT_TXID}","serviceName":"weather","result":"## 北京当前天气\\n\\n☀️  晴天，**+27°C**","deliveredAt":1777427686}`;
    const finalMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: unrelatedFinal,
      metadata: {
        isFinal: true,
        isStreaming: false,
      },
    });

    const now = Date.now();
    sqlite.db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        order_message_pin_id, cowork_session_id, status, first_response_deadline_at,
        delivery_deadline_at, delivery_message_pin_id, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'seller-order-result-field-only',
      'seller',
      metabotId,
      buyerGlobalMetaId,
      'service-weather',
      'weather',
      PAYMENT_TXID,
      'mvc',
      '0.001',
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
      now,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${DELIVERY_TXID}i0`,
      DELIVERY_TXID,
      'seller-metaid',
      sellerGlobalMetaId,
      'buyer-metaid',
      buyerGlobalMetaId,
      '/protocols/simplemsg',
      deliveryContent,
      Math.floor(now / 1000),
      1,
    ]);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 0);

    const updated = store.getSession(session.id);
    const unchanged = updated.messages.find((message) => message.id === finalMessage.id);

    assert.equal(unchanged.content, unrelatedFinal);
    assert.equal(unchanged.metadata.txid, undefined);
    assert.equal(unchanged.metadata.pinId, undefined);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebPrivateSimplemsgMetadata fills ordinary private-chat bubble txids without changing content', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 1;
    const localGlobalMetaId = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
    const peerGlobalMetaId = 'idq1g35d5yftpq3jv0ukejte7z76qdqp7sve8l2etm';
    const externalConversationId = `metaweb-private:${peerGlobalMetaId}`;
    sqlite.db.run(`
      INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
        name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
        tools, skills, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      metabotId,
      1,
      'mvc-local',
      'btc-local',
      'doge-local',
      'pub-local',
      'chat-local',
      'AI_Sunny',
      1,
      'metaid-local',
      localGlobalMetaId,
      'worker',
      'test',
      '',
      '',
      '[]',
      '[]',
      Date.now(),
      Date.now(),
    ]);
    const session = store.createSession(
      'Ordinary private chat',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      peerGlobalMetaId,
      'Twin Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        peerGlobalMetaId,
        peerName: 'Twin Bot',
      }),
    });

    const incomingContent = 'Hey AISunny! 我是 Twin Bot，来跟你聊聊。';
    const outgoingContent = '嘿 Twin Bot！Sunny 的数字主分身在此，很高兴认识你。';
    const incomingMessage = store.addMessage(session.id, {
      type: 'user',
      content: incomingContent,
      metadata: {
        sourceChannel: 'metaweb_private',
        externalConversationId,
        direction: 'incoming',
        senderGlobalMetaId: peerGlobalMetaId,
        senderName: 'Twin Bot',
      },
    });
    const outgoingMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: outgoingContent,
      metadata: {
        sourceChannel: 'metaweb_private',
        externalConversationId,
        direction: 'outgoing',
      },
    });
    const incomingCreatedAt = 1_777_379_085_668;
    const outgoingCreatedAt = 1_777_379_099_881;
    sqlite.db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [
      incomingCreatedAt,
      incomingMessage.id,
    ]);
    sqlite.db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [
      outgoingCreatedAt,
      outgoingMessage.id,
    ]);

    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${PRIVATE_OLD_DUPLICATE_TXID}i0`,
      PRIVATE_OLD_DUPLICATE_TXID,
      'peer-metaid',
      peerGlobalMetaId,
      'local-metaid',
      localGlobalMetaId,
      '/protocols/simplemsg',
      incomingContent,
      Math.floor((incomingCreatedAt - 86_400_000) / 1000),
      1,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${PRIVATE_INCOMING_TXID}i0`,
      PRIVATE_INCOMING_TXID,
      'peer-metaid',
      peerGlobalMetaId,
      'local-metaid',
      localGlobalMetaId,
      'simplemsg',
      incomingContent,
      Math.floor((incomingCreatedAt + 1_000) / 1000),
      1,
    ]);
    sqlite.db.run(`
      INSERT INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
        protocol, content, chain_timestamp, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `${PRIVATE_OUTGOING_TXID}i0`,
      PRIVATE_OUTGOING_TXID,
      'local-metaid',
      localGlobalMetaId,
      'peer-metaid',
      peerGlobalMetaId,
      '/protocols/simplemsg',
      outgoingContent,
      Math.floor((outgoingCreatedAt + 2_000) / 1000),
      1,
    ]);

    assert.equal(store.backfillMetawebPrivateSimplemsgMetadata(), 2);

    const updated = store.getSession(session.id);
    const updatedIncoming = updated.messages.find((message) => message.id === incomingMessage.id);
    const updatedOutgoing = updated.messages.find((message) => message.id === outgoingMessage.id);

    assert.equal(updatedIncoming.content, incomingContent);
    assert.equal(updatedIncoming.metadata.txid, PRIVATE_INCOMING_TXID);
    assert.deepEqual(updatedIncoming.metadata.txids, [PRIVATE_INCOMING_TXID]);
    assert.equal(updatedIncoming.metadata.pinId, `${PRIVATE_INCOMING_TXID}i0`);

    assert.equal(updatedOutgoing.content, outgoingContent);
    assert.equal(updatedOutgoing.metadata.txid, PRIVATE_OUTGOING_TXID);
    assert.deepEqual(updatedOutgoing.metadata.txids, [PRIVATE_OUTGOING_TXID]);
    assert.equal(updatedOutgoing.metadata.pinId, `${PRIVATE_OUTGOING_TXID}i0`);

    assert.equal(store.backfillMetawebPrivateSimplemsgMetadata(), 0);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata matches service orders by order txid inside unified peer sessions', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 9;
    const peerGlobalMetaId = 'seller-unified-peer';
    const firstOrderTxid = '7'.repeat(64);
    const secondOrderTxid = '8'.repeat(64);
    const firstPaymentTxid = '5'.repeat(64);
    const secondPaymentTxid = '6'.repeat(64);
    const firstExternalConversationId = `metaweb_order:buyer:${metabotId}:${peerGlobalMetaId}:${firstOrderTxid.slice(0, 16)}`;
    const secondExternalConversationId = `metaweb_order:buyer:${metabotId}:${peerGlobalMetaId}:${secondOrderTxid.slice(0, 16)}`;
    const session = store.createSession(
      'Unified peer',
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
      channel: 'metaweb_private',
      externalConversationId: `metaweb-private:${peerGlobalMetaId}`,
      metabotId,
      coworkSessionId: session.id,
    });
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: firstExternalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'buyer',
        peerGlobalMetaId,
        servicePaidTx: firstPaymentTxid,
        orderTxid: firstOrderTxid,
      }),
    });
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: secondExternalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'buyer',
        peerGlobalMetaId,
        servicePaidTx: secondPaymentTxid,
        orderTxid: secondOrderTxid,
      }),
    });
    const firstMessage = store.addMessage(session.id, {
      type: 'user',
      content: `[ORDER] first\ntxid: ${firstPaymentTxid}`,
      metadata: {
        sourceChannel: 'metaweb_private',
        externalConversationId: `metaweb-private:${peerGlobalMetaId}`,
        direction: 'outgoing',
        orderTxid: firstOrderTxid,
        orderMappingExternalConversationId: firstExternalConversationId,
      },
    });

    const now = Date.now();
    sqlite.db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        order_message_pin_id, order_message_txid, cowork_session_id, status,
        first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'first-unified-order',
      'buyer',
      metabotId,
      peerGlobalMetaId,
      'service-first',
      'First',
      firstPaymentTxid,
      'mvc',
      '1',
      'SPACE',
      'native',
      `${firstOrderTxid}i0`,
      firstOrderTxid,
      session.id,
      'completed',
      now + 1000,
      now + 2000,
      now,
      now,
    ]);
    sqlite.db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
        order_message_pin_id, order_message_txid, cowork_session_id, status,
        first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'second-unified-order',
      'buyer',
      metabotId,
      peerGlobalMetaId,
      'service-second',
      'Second',
      secondPaymentTxid,
      'mvc',
      '1',
      'SPACE',
      'native',
      `${secondOrderTxid}i0`,
      secondOrderTxid,
      session.id,
      'completed',
      now + 1000,
      now + 2000,
      now,
      now + 10_000,
    ]);

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 1);
    const updated = store.getSession(session.id);
    const updatedFirst = updated.messages.find((message) => message.id === firstMessage.id);
    assert.equal(updatedFirst.metadata.pinId, `${firstOrderTxid}i0`);
    assert.equal(updatedFirst.metadata.txid, firstOrderTxid);
    assert.notEqual(updatedFirst.metadata.pinId, `${secondOrderTxid}i0`);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata does not let another mapping order txid override message payment identity', async () => {
  const sqlite = await createSqliteStore();
  try {
    sqlite.db.run('PRAGMA reverse_unordered_selects = ON');
    const store = createCoworkStore(sqlite.db);
    const metabotId = 9;
    const peerGlobalMetaId = 'seller-payment-only-peer';
    const firstOrderTxid = '7'.repeat(64);
    const secondOrderTxid = '8'.repeat(64);
    const firstPaymentTxid = '5'.repeat(64);
    const secondPaymentTxid = '6'.repeat(64);
    const firstExternalConversationId = `metaweb_order:buyer:${metabotId}:${peerGlobalMetaId}:${firstOrderTxid.slice(0, 16)}`;
    const secondExternalConversationId = `metaweb_order:buyer:${metabotId}:${peerGlobalMetaId}:${secondOrderTxid.slice(0, 16)}`;
    const session = store.createSession(
      'Unified payment-only peer',
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
      channel: 'metaweb_private',
      externalConversationId: `metaweb-private:${peerGlobalMetaId}`,
      metabotId,
      coworkSessionId: session.id,
    });
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: firstExternalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'buyer',
        peerGlobalMetaId,
        servicePaidTx: firstPaymentTxid,
        orderTxid: firstOrderTxid,
      }),
    });
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: secondExternalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'buyer',
        peerGlobalMetaId,
        servicePaidTx: secondPaymentTxid,
        orderTxid: secondOrderTxid,
      }),
    });
    const firstMessage = store.addMessage(session.id, {
      type: 'user',
      content: `[ORDER] first\ntxid: ${firstPaymentTxid}`,
      metadata: {
        sourceChannel: 'metaweb_private',
        externalConversationId: `metaweb-private:${peerGlobalMetaId}`,
        direction: 'outgoing',
        txid: firstPaymentTxid,
        txids: [firstPaymentTxid],
        paymentTxid: firstPaymentTxid,
      },
    });

    const now = Date.now();
    for (const [id, orderTxid, paymentTxid, serviceName, updatedAt] of [
      ['first-payment-only-order', firstOrderTxid, firstPaymentTxid, 'First', now],
      ['second-payment-only-order', secondOrderTxid, secondPaymentTxid, 'Second', now + 10_000],
    ]) {
      sqlite.db.run(`
        INSERT INTO service_orders (
          id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
          payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
          order_message_pin_id, order_message_txid, cowork_session_id, status,
          first_response_deadline_at, delivery_deadline_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        'buyer',
        metabotId,
        peerGlobalMetaId,
        `service-${serviceName.toLowerCase()}`,
        serviceName,
        paymentTxid,
        'mvc',
        '1',
        'SPACE',
        'native',
        `${orderTxid}i0`,
        orderTxid,
        session.id,
        'completed',
        now + 1000,
        now + 2000,
        now,
        updatedAt,
      ]);
    }

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 1);
    const updated = store.getSession(session.id);
    const updatedFirst = updated.messages.find((message) => message.id === firstMessage.id);
    assert.equal(updatedFirst.metadata.pinId, `${firstOrderTxid}i0`);
    assert.equal(updatedFirst.metadata.txid, firstOrderTxid);
    assert.deepEqual(updatedFirst.metadata.txids, [firstOrderTxid]);
    assert.notEqual(updatedFirst.metadata.pinId, `${secondOrderTxid}i0`);
  } finally {
    sqlite.cleanup();
  }
});

test('backfillMetawebOrderSimplemsgMetadata binds seller delivery by message order identity in unified peer sessions', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 10;
    const buyerGlobalMetaId = 'buyer-unified-delivery-peer';
    const sellerGlobalMetaId = 'seller-unified-delivery-peer';
    const firstOrderTxid = '1'.repeat(64);
    const secondOrderTxid = '2'.repeat(64);
    const firstPaymentTxid = '3'.repeat(64);
    const secondPaymentTxid = '4'.repeat(64);
    const firstDeliveryTxid = '5'.repeat(64);
    const secondDeliveryTxid = '6'.repeat(64);
    const firstExternalConversationId = `metaweb_order:seller:${metabotId}:${buyerGlobalMetaId}:${firstOrderTxid.slice(0, 16)}`;
    const secondExternalConversationId = `metaweb_order:seller:${metabotId}:${buyerGlobalMetaId}:${secondOrderTxid.slice(0, 16)}`;
    const session = store.createSession(
      'Unified seller delivery peer',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      buyerGlobalMetaId,
      'Buyer Bot',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: `metaweb-private:${buyerGlobalMetaId}`,
      metabotId,
      coworkSessionId: session.id,
    });
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: firstExternalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: buyerGlobalMetaId,
        serverBotGlobalMetaId: sellerGlobalMetaId,
        servicePaidTx: firstPaymentTxid,
        orderTxid: firstOrderTxid,
      }),
    });
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: secondExternalConversationId,
      metabotId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: buyerGlobalMetaId,
        serverBotGlobalMetaId: sellerGlobalMetaId,
        servicePaidTx: secondPaymentTxid,
        orderTxid: secondOrderTxid,
      }),
    });

    const deliverySummary = '数字成果已生成并上传链上交付。';
    const uploadCompleteMessage = store.addMessage(session.id, {
      type: 'assistant',
      content: deliverySummary,
      metadata: {
        sourceChannel: 'metaweb_private',
        externalConversationId: `metaweb-private:${buyerGlobalMetaId}`,
        direction: 'outgoing',
        excludeFromSandboxHistory: true,
        orderDeliveryUploadComplete: true,
        orderTxid: firstOrderTxid,
        paymentTxid: firstPaymentTxid,
        orderMappingExternalConversationId: firstExternalConversationId,
      },
    });

    const now = Date.now();
    for (const [id, orderTxid, paymentTxid, deliveryTxid, deliveredAt] of [
      ['first-seller-unified-order', firstOrderTxid, firstPaymentTxid, firstDeliveryTxid, now],
      ['second-seller-unified-order', secondOrderTxid, secondPaymentTxid, secondDeliveryTxid, now + 10_000],
    ]) {
      sqlite.db.run(`
        INSERT INTO service_orders (
          id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
          payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
          order_message_pin_id, order_message_txid, cowork_session_id, status,
          first_response_deadline_at, delivery_deadline_at, delivery_message_pin_id,
          delivered_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        'seller',
        metabotId,
        buyerGlobalMetaId,
        `service-${id}`,
        'delivery',
        paymentTxid,
        'mvc',
        '1',
        'SPACE',
        'native',
        `${orderTxid}i0`,
        orderTxid,
        session.id,
        'completed',
        now + 1000,
        now + 2000,
        `${deliveryTxid}i0`,
        deliveredAt,
        now,
        deliveredAt,
      ]);
      sqlite.db.run(`
        INSERT INTO private_chat_messages (
          pin_id, tx_id, from_metaid, from_global_metaid, to_metaid, to_global_metaid,
          protocol, content, chain_timestamp, is_processed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        `${deliveryTxid}i0`,
        deliveryTxid,
        'seller-metaid',
        sellerGlobalMetaId,
        'buyer-metaid',
        buyerGlobalMetaId,
        '/protocols/simplemsg',
        `[DELIVERY:${orderTxid}] {"paymentTxid":"${paymentTxid}","result":"${id}"}`,
        Math.floor(deliveredAt / 1000),
        1,
      ]);
    }

    assert.equal(store.backfillMetawebOrderSimplemsgMetadata(), 1);
    const updated = store.getSession(session.id);
    const deliveryBubble = updated.messages.find((message) => message.id === uploadCompleteMessage.id);
    assert.match(deliveryBubble.content, new RegExp(`^\\[DELIVERY:${firstOrderTxid}\\]`));
    assert.equal(deliveryBubble.metadata.pinId, `${firstDeliveryTxid}i0`);
    assert.equal(deliveryBubble.metadata.txid, firstDeliveryTxid);
    assert.notEqual(deliveryBubble.metadata.pinId, `${secondDeliveryTxid}i0`);
    assert.equal(deliveryBubble.metadata.paymentTxid, firstPaymentTxid);
  } finally {
    sqlite.cleanup();
  }
});
