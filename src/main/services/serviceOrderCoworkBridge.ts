import type { CoworkMessage, CoworkStore } from '../coworkStore';
import type { ServiceOrderRecord } from '../serviceOrderStore';
import { buildSharedServiceOrderEventMessage } from '../shared/metabotChatBridge';

export interface ServiceOrderCoworkPublishResult {
  message: CoworkMessage | null;
  delegationStateChange: { sessionId: string; blocking: false } | null;
}

export function buildServiceOrderEventMessage(
  type: 'refund_requested' | 'refunded',
  order: ServiceOrderRecord
): string {
  return buildSharedServiceOrderEventMessage(type, order);
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
    metadata: {
      sourceChannel: 'metaweb_order',
      refreshSessionSummary: true,
      serviceOrderEvent: type,
      paymentTxid: order.paymentTxid,
      refundRequestPinId: order.refundRequestPinId,
      refundTxid: order.refundTxid,
    },
  });

  return {
    message,
    delegationStateChange,
  };
}
