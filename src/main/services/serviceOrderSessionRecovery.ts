import type { CoworkMessage, CoworkStore } from '../coworkStore';
import {
  ServiceOrderStore,
  type ServiceOrderRecord,
} from '../serviceOrderStore';
import {
  buildServiceOrderObserverConversationId,
  ensureServiceOrderObserverSession,
} from './serviceOrderObserverSession';

export interface RecoverMissingRefundPendingOrderSessionsInput {
  coworkStore: CoworkStore;
  orderStore: ServiceOrderStore;
  resolveLocalMetabotIdByGlobalMetaId?: (
    globalMetaId: string
  ) => number | null | undefined;
  resolveLocalMetabotGlobalMetaId?: (
    localMetabotId: number
  ) => string | null | undefined;
  resolveOrderText?: (
    order: ServiceOrderRecord
  ) => string | null | undefined | Promise<string | null | undefined>;
  resolvePeerInfo?: (
    order: ServiceOrderRecord
  ) => {
    peerName?: string | null;
    peerAvatar?: string | null;
    serverBotGlobalMetaId?: string | null;
  } | null | undefined | Promise<{
    peerName?: string | null;
    peerAvatar?: string | null;
    serverBotGlobalMetaId?: string | null;
  } | null | undefined>;
}

export interface RecoveredRefundPendingOrderSession {
  orderId: string;
  coworkSessionId: string;
  created: boolean;
  recreated: boolean;
  initialMessage: CoworkMessage | null;
  recoveryMessage: CoworkMessage | null;
}

const REFUND_RECOVERY_NOTICE =
  '系统提示：由于该退款订单缺少原始 A2A 会话，系统已自动恢复退款处理窗口。';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function orderNeedsRecoveredSession(
  coworkStore: CoworkStore,
  order: ServiceOrderRecord
): boolean {
  const observerConversationId = buildServiceOrderObserverConversationId({
    role: order.role,
    metabotId: order.localMetabotId,
    peerGlobalMetaId: order.counterpartyGlobalMetaid,
    paymentTxid: order.paymentTxid,
  });
  const mapping = coworkStore.getConversationMapping(
    'metaweb_order',
    observerConversationId,
    order.localMetabotId
  );
  const observerSessionId = normalizeText(mapping?.coworkSessionId);
  if (!observerSessionId) {
    return true;
  }
  return coworkStore.getSession(observerSessionId) == null;
}

function synthesizeMissingLocalSellerRefundPendingOrders(
  input: RecoverMissingRefundPendingOrderSessionsInput
): ServiceOrderRecord[] {
  const resolveSellerLocalMetabotId = input.resolveLocalMetabotIdByGlobalMetaId;
  const resolveBuyerGlobalMetaId = input.resolveLocalMetabotGlobalMetaId;
  if (!resolveSellerLocalMetabotId || !resolveBuyerGlobalMetaId) {
    return [];
  }

  const synthesized: ServiceOrderRecord[] = [];
  const buyerRefundPendingOrders = input.orderStore.listOrdersByStatuses('buyer', ['refund_pending']);
  for (const buyerOrder of buyerRefundPendingOrders) {
    const sellerLocalMetabotId = resolveSellerLocalMetabotId(buyerOrder.counterpartyGlobalMetaid);
    if (typeof sellerLocalMetabotId !== 'number' || !Number.isFinite(sellerLocalMetabotId)) {
      continue;
    }

    const buyerGlobalMetaId = normalizeText(resolveBuyerGlobalMetaId(buyerOrder.localMetabotId));
    if (!buyerGlobalMetaId) {
      continue;
    }

    const existingSellerOrder = input.orderStore.findOrderByPayment({
      role: 'seller',
      localMetabotId: sellerLocalMetabotId,
      counterpartyGlobalMetaid: buyerGlobalMetaId,
      paymentTxid: buyerOrder.paymentTxid,
    });
    if (existingSellerOrder) {
      continue;
    }

    const failedAt = buyerOrder.failedAt ?? buyerOrder.refundRequestedAt ?? buyerOrder.updatedAt;
    const created = input.orderStore.createOrder({
      role: 'seller',
      localMetabotId: sellerLocalMetabotId,
      counterpartyGlobalMetaid: buyerGlobalMetaId,
      servicePinId: buyerOrder.servicePinId,
      serviceName: buyerOrder.serviceName,
      paymentTxid: buyerOrder.paymentTxid,
      paymentChain: buyerOrder.paymentChain,
      paymentAmount: buyerOrder.paymentAmount,
      paymentCurrency: buyerOrder.paymentCurrency,
      settlementKind: buyerOrder.settlementKind,
      mrc20Ticker: buyerOrder.mrc20Ticker,
      mrc20Id: buyerOrder.mrc20Id,
      paymentCommitTxid: buyerOrder.paymentCommitTxid,
      orderMessagePinId: buyerOrder.orderMessagePinId,
      status: 'failed',
      now: failedAt,
    });
    const failedOrder = input.orderStore.markFailed(
      created.id,
      buyerOrder.failureReason ?? 'delivery_timeout',
      failedAt
    ) ?? created;
    const refundPendingOrder = input.orderStore.markRefundPending(
      failedOrder.id,
      buyerOrder.refundRequestPinId,
      buyerOrder.refundRequestedAt ?? failedAt
    );
    synthesized.push(refundPendingOrder ?? failedOrder);
  }

  return synthesized;
}

export async function recoverMissingRefundPendingOrderSessions(
  input: RecoverMissingRefundPendingOrderSessionsInput
): Promise<RecoveredRefundPendingOrderSession[]> {
  synthesizeMissingLocalSellerRefundPendingOrders(input);
  const refundPendingOrders = [
    ...input.orderStore.listOrdersByStatuses('buyer', ['refund_pending']),
    ...input.orderStore.listOrdersByStatuses('seller', ['refund_pending']),
  ];
  const recovered: RecoveredRefundPendingOrderSession[] = [];

  for (const order of refundPendingOrders) {
    if (!orderNeedsRecoveredSession(input.coworkStore, order)) {
      continue;
    }

    const peerInfo = input.resolvePeerInfo
      ? await input.resolvePeerInfo(order)
      : null;
    const orderText = input.resolveOrderText
      ? await input.resolveOrderText(order)
      : null;

    const ensured = await ensureServiceOrderObserverSession(input.coworkStore, {
      role: order.role,
      metabotId: order.localMetabotId,
      peerGlobalMetaId: order.counterpartyGlobalMetaid,
      peerName: normalizeText(peerInfo?.peerName) || null,
      peerAvatar: normalizeText(peerInfo?.peerAvatar) || null,
      serviceId: order.servicePinId,
      servicePrice: order.paymentAmount,
      serviceCurrency: order.paymentCurrency,
      servicePaymentChain: order.paymentChain,
      serviceSettlementKind: order.settlementKind,
      serviceMrc20Ticker: order.mrc20Ticker,
      serviceMrc20Id: order.mrc20Id,
      servicePaymentCommitTxid: order.paymentCommitTxid,
      serviceSkill: order.serviceName,
      serverBotGlobalMetaId: normalizeText(peerInfo?.serverBotGlobalMetaId)
        || (order.role === 'buyer' ? order.counterpartyGlobalMetaid : ''),
      servicePaidTx: order.paymentTxid,
      orderPayload: normalizeText(orderText) || null,
      recoveryNotice: REFUND_RECOVERY_NOTICE,
    });

    const existingSessionId = normalizeText(order.coworkSessionId);
    const hasExistingLiveSession = existingSessionId
      ? input.coworkStore.getSession(existingSessionId) != null
      : false;
    if (!hasExistingLiveSession && order.coworkSessionId !== ensured.coworkSessionId) {
      input.orderStore.setCoworkSessionId(order.id, ensured.coworkSessionId);
    }

    recovered.push({
      orderId: order.id,
      coworkSessionId: ensured.coworkSessionId,
      created: ensured.created,
      recreated: ensured.recreated,
      initialMessage: ensured.initialMessage,
      recoveryMessage: ensured.recoveryMessage,
    });
  }

  return recovered;
}
