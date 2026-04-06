import { normalizeAttachmentRefs } from './attachmentRefs';
import { normalizeServiceRequestContract, type ServiceRequestContract } from './contracts';
import type { RequestTraceRuntime } from './requestTraceRuntime';
import type { DeliveryWriteRecord } from './transportRuntime';

const SIMPLEMSG_PATH = '/protocols/simplemsg';

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const toSafeNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export interface PortableDeliveryInput {
  text: string;
  attachments?: unknown[];
}

export interface PortableDeliveryPayload {
  requestId: string;
  requesterSessionId: string;
  requesterConversationId: string | null;
  servicePinId: string;
  paymentTxid: string | null;
  serviceName?: string | null;
  text: string;
  result: string;
  attachments: string[];
  deliveredAt: number;
}

export type PortableDeliveryWriteRecord = DeliveryWriteRecord;

export interface WritePortableDeliveryDeps {
  buildDeliveryMessage(payload: PortableDeliveryPayload): string;
  prepareSimpleMessagePayload?: (deliveryText: string) => Promise<string> | string;
  createPin(
    store: unknown,
    metabotId: number,
    pinInput: {
      operation: 'create';
      path: string;
      encryption: '0';
      version: '1.0.0';
      contentType: 'application/json';
      payload: string;
    },
  ): Promise<{ pinId?: string | null; txids?: string[] }>;
}

export interface WritePortableDeliveryRecordInput {
  store?: unknown;
  metabotId: number;
  request: Partial<ServiceRequestContract>;
  paymentTxid?: string | null;
  counterpartyGlobalMetaId?: string | null;
  serviceName?: string | null;
  delivery: PortableDeliveryInput;
  deliveredAt?: number;
  trace: Pick<RequestTraceRuntime, 'markSellerDelivered'>;
  deps: WritePortableDeliveryDeps;
}

export interface WritePortableDeliveryRecordResult {
  request: ServiceRequestContract;
  deliveryPayload: PortableDeliveryPayload;
  deliveryWrite: PortableDeliveryWriteRecord;
  sellerOrder: unknown;
}

export interface ApplyPortableBuyerDeliveryInput {
  request: Partial<ServiceRequestContract>;
  delivery: Record<string, unknown> | null | undefined;
  localMetabotId: number;
  counterpartyGlobalMetaId: string;
  paymentTxid?: string | null;
  deliveryMessagePinId?: string | null;
  nowMs?: number;
  trace: Pick<RequestTraceRuntime, 'markBuyerOrderDelivered'>;
}

export function buildPortableDeliveryPayload(input: {
  request: Partial<ServiceRequestContract>;
  delivery: PortableDeliveryInput;
  paymentTxid?: string | null;
  serviceName?: string | null;
  deliveredAt?: number;
}): PortableDeliveryPayload {
  const request = normalizeServiceRequestContract(input.request);
  const text = toSafeString(input.delivery.text);
  const deliveredAt = Math.trunc(
    toSafeNumber(input.deliveredAt) > 0 ? toSafeNumber(input.deliveredAt) : Math.floor(Date.now() / 1000),
  );
  return {
    requestId: request.correlation.requestId,
    requesterSessionId: request.correlation.requesterSessionId,
    requesterConversationId: request.correlation.requesterConversationId,
    servicePinId: request.servicePinId,
    paymentTxid: toSafeString(input.paymentTxid) || toSafeString(request.paymentProof.txid) || null,
    serviceName: toSafeString(input.serviceName) || null,
    text,
    result: text,
    attachments: normalizeAttachmentRefs(Array.isArray(input.delivery.attachments) ? input.delivery.attachments : []),
    deliveredAt,
  };
}

export async function writePortableDeliveryRecord(
  input: WritePortableDeliveryRecordInput,
): Promise<WritePortableDeliveryRecordResult> {
  const request = normalizeServiceRequestContract(input.request);
  const deliveryPayload = buildPortableDeliveryPayload({
    request,
    delivery: input.delivery,
    paymentTxid: input.paymentTxid,
    serviceName: input.serviceName,
    deliveredAt: input.deliveredAt,
  });
  const deliveryText = input.deps.buildDeliveryMessage(deliveryPayload);
  const wirePayload = input.deps.prepareSimpleMessagePayload
    ? await input.deps.prepareSimpleMessagePayload(deliveryText)
    : deliveryText;

  const pinResult = await input.deps.createPin(input.store, input.metabotId, {
    operation: 'create',
    path: SIMPLEMSG_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: wirePayload,
  });

  const deliveryWrite: PortableDeliveryWriteRecord = {
    requestId: deliveryPayload.requestId,
    requesterSessionId: deliveryPayload.requesterSessionId,
    requesterConversationId: deliveryPayload.requesterConversationId,
    servicePinId: deliveryPayload.servicePinId,
    paymentTxid: deliveryPayload.paymentTxid,
    deliveryMessagePinId: toSafeString(pinResult.pinId) || null,
    text: deliveryPayload.text,
    attachments: deliveryPayload.attachments,
    deliveredAt: deliveryPayload.deliveredAt,
  };

  const sellerOrder = deliveryPayload.paymentTxid
    ? input.trace.markSellerDelivered({
      localMetabotId: input.metabotId,
      counterpartyGlobalMetaId: toSafeString(input.counterpartyGlobalMetaId),
      paymentTxid: deliveryPayload.paymentTxid,
      deliveryMessagePinId: deliveryWrite.deliveryMessagePinId,
      deliveredAt: deliveryPayload.deliveredAt * 1000,
    })
    : null;

  return {
    request,
    deliveryPayload,
    deliveryWrite,
    sellerOrder,
  };
}

export function applyPortableBuyerDelivery(
  input: ApplyPortableBuyerDeliveryInput,
): unknown {
  const request = normalizeServiceRequestContract(input.request);
  const delivery = input.delivery && typeof input.delivery === 'object' ? input.delivery : null;
  const paymentTxid = toSafeString(delivery?.paymentTxid)
    || toSafeString(input.paymentTxid)
    || toSafeString(request.paymentProof.txid);
  if (!paymentTxid) return null;

  const deliveredAtSec = Math.trunc(toSafeNumber(delivery?.deliveredAt));
  const deliveredAt = deliveredAtSec > 0
    ? deliveredAtSec * 1000
    : Math.trunc(toSafeNumber(input.nowMs) || Date.now());

  return input.trace.markBuyerOrderDelivered({
    localMetabotId: input.localMetabotId,
    counterpartyGlobalMetaId: toSafeString(input.counterpartyGlobalMetaId),
    paymentTxid,
    deliveryMessagePinId: toSafeString(input.deliveryMessagePinId) || null,
    deliveredAt,
  });
}
