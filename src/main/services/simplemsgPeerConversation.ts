import {
  parseDeliveryMessage,
  parseNeedsRatingMessage,
  parseOrderEndMessage,
  parseOrderStatusMessage,
} from './serviceOrderProtocols.js';

export type SimplemsgProtocolTag = 'ORDER' | 'ORDER_STATUS' | 'DELIVERY' | 'NeedsRating' | 'ORDER_END';

export type SimplemsgClassification =
  | { kind: 'private_chat' }
  | {
      kind: 'order_protocol';
      tag: SimplemsgProtocolTag;
      orderTxid?: string | null;
      orderPinId?: string | null;
      reason?: string | null;
    };

const ORDER_PREFIX = '[ORDER]';

function isOrderMessage(content: string): boolean {
  return String(content || '').trim().toUpperCase().startsWith(ORDER_PREFIX);
}

export function buildCanonicalPrivateConversationExternalConversationId(peerGlobalMetaId: string): string {
  return `metaweb-private:${String(peerGlobalMetaId || '').trim() || 'unknown-peer'}`;
}

export function buildOrderProtocolDisplayMetadata(input: {
  peerGlobalMetaId: string;
  direction: 'incoming' | 'outgoing';
  tag: SimplemsgProtocolTag;
  orderTxid?: string | null;
  orderRole?: 'buyer' | 'seller' | string | null;
  orderPinId?: string | null;
  paymentTxid?: string | null;
  orderMappingExternalConversationId?: string | null;
  extra?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const orderTxid = String(input.orderTxid || '').trim();
  const paymentTxid = String(input.paymentTxid || '').trim();
  const orderPinId = String(input.orderPinId || '').trim();
  const orderRole = String(input.orderRole || '').trim();
  const orderMappingExternalConversationId = String(input.orderMappingExternalConversationId || '').trim();
  return {
    ...(input.extra ?? {}),
    sourceChannel: 'metaweb_private',
    externalConversationId: buildCanonicalPrivateConversationExternalConversationId(input.peerGlobalMetaId),
    direction: input.direction,
    simplemsgKind: 'order_protocol',
    orderProtocolTag: input.tag,
    ...(orderTxid ? { orderTxid } : {}),
    ...(orderRole ? { orderRole } : {}),
    ...(orderPinId ? { serviceOrderPinId: orderPinId, orderPinId } : {}),
    ...(paymentTxid ? { paymentTxid, orderPaymentTxid: paymentTxid } : {}),
    ...(orderMappingExternalConversationId ? { orderMappingExternalConversationId } : {}),
  };
}

export function classifySimplemsgContent(content: string): SimplemsgClassification {
  const text = String(content || '').trim();
  if (!text) return { kind: 'private_chat' };

  if (isOrderMessage(text)) {
    return { kind: 'order_protocol', tag: 'ORDER' };
  }

  const status = parseOrderStatusMessage(text);
  if (status) {
    return { kind: 'order_protocol', tag: 'ORDER_STATUS', orderTxid: status.orderTxid ?? null, orderPinId: status.orderPinId ?? null };
  }

  const delivery = parseDeliveryMessage(text);
  if (delivery) {
    return { kind: 'order_protocol', tag: 'DELIVERY', orderTxid: delivery.orderTxid ?? null, orderPinId: delivery.serviceOrderPinId ?? delivery.orderPinId ?? null };
  }

  const needsRating = parseNeedsRatingMessage(text);
  if (needsRating) {
    return { kind: 'order_protocol', tag: 'NeedsRating', orderTxid: needsRating.orderTxid ?? null, orderPinId: needsRating.orderPinId ?? null };
  }

  const orderEnd = parseOrderEndMessage(text);
  if (orderEnd) {
    return {
      kind: 'order_protocol',
      tag: 'ORDER_END',
      orderTxid: orderEnd.orderTxid ?? null,
      orderPinId: orderEnd.orderPinId ?? null,
      reason: orderEnd.reason || null,
    };
  }

  return { kind: 'private_chat' };
}

export function isServiceOrderActiveForPrivateChatSuppression(order: {
  role?: string | null;
  status?: string | null;
  refundRequestPinId?: string | null;
  refundTxid?: string | null;
  refundCompletedAt?: number | null;
}): boolean {
  const status = String(order.status || '').trim();
  if (
    status === 'awaiting_first_response'
    || status === 'in_progress'
    || status === 'rating_pending'
    || status === 'refund_pending'
  ) {
    return true;
  }

  if (status !== 'failed') {
    return false;
  }

  return String(order.role || '').trim() === 'buyer'
    && !order.refundRequestPinId
    && !order.refundTxid
    && !order.refundCompletedAt;
}
