import type { CoworkMessage, CoworkStore } from '../coworkStore';
import type { ServiceOrderRecord } from '../serviceOrderStore';
import { buildOrderProtocolDisplayMetadata } from './simplemsgPeerConversation';

export interface ServiceOrderCoworkPublishResult {
  message: CoworkMessage | null;
  delegationStateChange: { sessionId: string; blocking: false } | null;
}

export function buildServiceOrderEventMessage(
  type: 'refund_requested' | 'refunded',
  order: ServiceOrderRecord
): string {
  if (type === 'refund_requested') {
    if (order.role === 'seller') {
      const pinId = order.refundRequestPinId ? ` 申请凭证：${order.refundRequestPinId}` : '';
      return `系统提示：买家已发起全额退款申请，请人工处理。${pinId}`.trim();
    }
    const pinId = order.refundRequestPinId ? ` 申请凭证：${order.refundRequestPinId}` : '';
    return `系统提示：服务订单已超时，已自动发起全额退款申请。${pinId}`.trim();
  }

  const refundTxid = order.refundTxid ? ` 退款 txid：${order.refundTxid}` : '';
  return `系统提示：退款已处理完成。${refundTxid}`.trim();
}

export function publishServiceOrderEventToCowork(
  store: CoworkStore,
  type: 'refund_requested' | 'refunded',
  order: ServiceOrderRecord
): ServiceOrderCoworkPublishResult {
  if (!order.coworkSessionId) {
    return { message: null, delegationStateChange: null };
  }

  let delegationStateChange: { sessionId: string; blocking: false } | null = null;
  if (order.role === 'buyer' && store.isDelegationBlocking(order.coworkSessionId)) {
    store.setDelegationBlocking(order.coworkSessionId, false);
    delegationStateChange = {
      sessionId: order.coworkSessionId,
      blocking: false,
    };
  }

  const message = store.addMessage(order.coworkSessionId, {
    type: 'system',
    content: buildServiceOrderEventMessage(type, order),
    metadata: buildOrderProtocolDisplayMetadata({
      peerGlobalMetaId: order.counterpartyGlobalMetaid,
      direction: order.role === 'seller' ? 'incoming' : 'outgoing',
      tag: 'ORDER_STATUS',
      orderTxid: order.orderMessageTxid,
      orderRole: order.role,
      paymentTxid: order.paymentTxid,
      extra: {
        refreshSessionSummary: true,
        serviceOrderEvent: type,
        refundRequestPinId: order.refundRequestPinId,
        refundTxid: order.refundTxid,
      },
    }),
  });

  return {
    message,
    delegationStateChange,
  };
}
