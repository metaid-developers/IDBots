import { normalizeAttachmentRefs } from './attachmentRefs';
import { normalizeServiceRequestContract, type ServiceRequestContract } from './contracts';

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const toSafeNullableString = (value: unknown): string | null => {
  const normalized = toSafeString(value);
  return normalized || null;
};

const toSafeArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const toSafeNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export interface RequestWriteRecord {
  requestId: string;
  requesterSessionId: string;
  requesterConversationId: string | null;
  servicePinId: string;
  paymentTxid: string | null;
  orderReferenceId?: string | null;
  orderMessagePinId: string | null;
  normalizedOrderText?: string;
}

export interface DeliveryWriteRecord {
  requestId: string;
  requesterSessionId: string;
  requesterConversationId: string | null;
  servicePinId: string;
  paymentTxid: string | null;
  deliveryMessagePinId: string | null;
  text: string;
  attachments: string[];
  deliveredAt: number;
}

export interface ProviderWakeUpEnvelope {
  type: 'provider_wakeup';
  request_id: string;
  requester_session_id: string;
  requester_conversation_id: string | null;
  service_pin_id: string;
  requester_global_metaid: string;
  order_message_pin_id: string | null;
  payment_txid: string | null;
  order_reference_id: string | null;
  user_task: string;
  task_context: string;
  price: string;
  currency: string;
  payment: {
    txid: string | null;
    chain: string | null;
    amount: string;
    currency: string;
    order_message: string;
    order_message_pin_id: string | null;
  };
}

export interface ProviderDeliveryEnvelope {
  type: 'provider_delivery';
  request_id: string;
  requester_session_id: string;
  requester_conversation_id: string | null;
  service_pin_id: string;
  payment_txid: string | null;
  delivery_message_pin_id: string | null;
  text: string;
  attachments: string[];
  delivered_at: number;
}

export interface PendingRequesterDeliveryTarget {
  requestId: string;
  requesterSessionId: string;
  targetSessionId: string;
  requesterConversationId?: string | null;
}

function normalizeRequestWriteRecord(input: Partial<RequestWriteRecord>): RequestWriteRecord {
  return {
    requestId: toSafeString(input.requestId),
    requesterSessionId: toSafeString(input.requesterSessionId),
    requesterConversationId: toSafeNullableString(input.requesterConversationId),
    servicePinId: toSafeString(input.servicePinId),
    paymentTxid: toSafeNullableString(input.paymentTxid),
    orderReferenceId: toSafeNullableString(input.orderReferenceId),
    orderMessagePinId: toSafeNullableString(input.orderMessagePinId),
    normalizedOrderText: toSafeString(input.normalizedOrderText) || undefined,
  };
}

function normalizeDeliveryWriteRecord(input: Partial<DeliveryWriteRecord>): DeliveryWriteRecord {
  return {
    requestId: toSafeString(input.requestId),
    requesterSessionId: toSafeString(input.requesterSessionId),
    requesterConversationId: toSafeNullableString(input.requesterConversationId),
    servicePinId: toSafeString(input.servicePinId),
    paymentTxid: toSafeNullableString(input.paymentTxid),
    deliveryMessagePinId: toSafeNullableString(input.deliveryMessagePinId),
    text: toSafeString(input.text),
    attachments: normalizeAttachmentRefs(toSafeArray(input.attachments)),
    deliveredAt: Math.trunc(toSafeNumber(input.deliveredAt)),
  };
}

export function buildProviderWakeUpEnvelope(input: {
  request: Partial<ServiceRequestContract>;
  requestWrite: Partial<RequestWriteRecord>;
}): ProviderWakeUpEnvelope {
  const request = normalizeServiceRequestContract(input.request);
  const requestWrite = normalizeRequestWriteRecord(input.requestWrite);

  return {
    type: 'provider_wakeup',
    request_id: requestWrite.requestId || request.correlation.requestId,
    requester_session_id: requestWrite.requesterSessionId || request.correlation.requesterSessionId,
    requester_conversation_id: requestWrite.requesterConversationId ?? request.correlation.requesterConversationId,
    service_pin_id: requestWrite.servicePinId || request.servicePinId,
    requester_global_metaid: request.requesterGlobalMetaId,
    order_message_pin_id: requestWrite.orderMessagePinId ?? request.paymentProof.orderMessagePinId,
    payment_txid: requestWrite.paymentTxid ?? request.paymentProof.txid,
    order_reference_id: requestWrite.orderReferenceId ?? null,
    user_task: request.userTask,
    task_context: request.taskContext,
    price: request.price,
    currency: request.currency,
    payment: {
      txid: request.paymentProof.txid,
      chain: request.paymentProof.chain,
      amount: request.paymentProof.amount || request.price,
      currency: request.paymentProof.currency || request.currency,
      order_message: requestWrite.normalizedOrderText || request.paymentProof.orderMessage,
      order_message_pin_id: requestWrite.orderMessagePinId ?? request.paymentProof.orderMessagePinId,
    },
  };
}

export function buildDeliveryTransportEnvelope(input: {
  request: Partial<ServiceRequestContract>;
  deliveryWrite: Partial<DeliveryWriteRecord>;
}): ProviderDeliveryEnvelope {
  const request = normalizeServiceRequestContract(input.request);
  const deliveryWrite = normalizeDeliveryWriteRecord(input.deliveryWrite);

  return {
    type: 'provider_delivery',
    request_id: deliveryWrite.requestId || request.correlation.requestId,
    requester_session_id: deliveryWrite.requesterSessionId || request.correlation.requesterSessionId,
    requester_conversation_id: deliveryWrite.requesterConversationId ?? request.correlation.requesterConversationId,
    service_pin_id: deliveryWrite.servicePinId || request.servicePinId,
    payment_txid: deliveryWrite.paymentTxid ?? request.paymentProof.txid,
    delivery_message_pin_id: deliveryWrite.deliveryMessagePinId,
    text: deliveryWrite.text,
    attachments: deliveryWrite.attachments,
    delivered_at: deliveryWrite.deliveredAt,
  };
}

export function normalizeProviderWakeUpEnvelope(
  input: Record<string, unknown>,
): ServiceRequestContract {
  const paymentInput = input.payment && typeof input.payment === 'object'
    ? input.payment as Record<string, unknown>
    : {};

  return normalizeServiceRequestContract({
    correlation: {
      requestId: toSafeString(input.request_id),
      requesterSessionId: toSafeString(input.requester_session_id),
      requesterConversationId: toSafeNullableString(input.requester_conversation_id),
    },
    servicePinId: toSafeString(input.service_pin_id),
    requesterGlobalMetaId: toSafeString(input.requester_global_metaid),
    price: toSafeString(input.price) || '0',
    currency: toSafeString(input.currency) || 'SPACE',
    paymentProof: {
      txid: toSafeNullableString(paymentInput.txid)
        || toSafeNullableString(input.payment_txid)
        || toSafeNullableString(input.order_reference_id),
      chain: toSafeNullableString(paymentInput.chain),
      amount: toSafeString(paymentInput.amount) || toSafeString(input.price) || '0',
      currency: toSafeString(paymentInput.currency) || toSafeString(input.currency) || 'SPACE',
      orderMessage: toSafeString(paymentInput.order_message),
      orderMessagePinId: toSafeNullableString(paymentInput.order_message_pin_id)
        || toSafeNullableString(input.order_message_pin_id),
    },
    userTask: toSafeString(input.user_task),
    taskContext: toSafeString(input.task_context),
  });
}

export function resolveRequesterDeliveryTarget(input: {
  delivery: Record<string, unknown> | ProviderDeliveryEnvelope;
  pendingRequest: PendingRequesterDeliveryTarget;
}): PendingRequesterDeliveryTarget | null {
  const deliveryRequestId = toSafeString(input.delivery.request_id);
  const deliveryRequesterSessionId = toSafeString(input.delivery.requester_session_id);
  if (deliveryRequestId !== input.pendingRequest.requestId) return null;
  if (deliveryRequesterSessionId !== input.pendingRequest.requesterSessionId) return null;
  return input.pendingRequest;
}
