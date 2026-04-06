import {
  normalizeServiceRequestContract,
  type ExecutionMode,
  type ServiceRequestContract,
} from './contracts';
import type { RequestTraceRuntime } from './requestTraceRuntime';
import type { RequestWriteRecord } from './transportRuntime';

const SIMPLEMSG_PATH = '/protocols/simplemsg';

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const toPaymentChain = (value?: string | null): 'mvc' | 'btc' | 'doge' => {
  const normalized = toSafeString(value).toLowerCase();
  if (normalized === 'btc' || normalized === 'doge' || normalized === 'mvc') {
    return normalized;
  }
  if (normalized === 'space') return 'mvc';
  return 'mvc';
};

export type PortableRequestWriteRecord = RequestWriteRecord;

export interface ResolveExecutionGateInput {
  request: Partial<ServiceRequestContract>;
  paymentTxid?: string | null;
  orderReferenceId?: string | null;
}

export interface ResolveExecutionGateResult {
  executionMode: ExecutionMode;
  paymentTxid: string | null;
  orderReferenceId: string | null;
}

export interface WritePortableServiceRequestDeps {
  buildDelegationOrderPayload(input: {
    rawRequest?: string | null;
    taskContext?: string | null;
    userTask?: string | null;
    serviceName?: string | null;
    providerSkill?: string | null;
    servicePinId?: string | null;
    paymentTxid: string;
    orderReference?: string | null;
    price: string;
    currency: string;
  }): string;
  prepareSimpleMessagePayload?: (orderText: string) => Promise<string> | string;
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

export interface WritePortableServiceRequestInput {
  store?: unknown;
  metabotId: number;
  request: Partial<ServiceRequestContract>;
  paymentTxid?: string | null;
  orderReferenceId?: string | null;
  counterpartyGlobalMetaId?: string | null;
  serviceName?: string | null;
  providerSkill?: string | null;
  paymentChain?: string | null;
  coworkSessionId?: string | null;
  trace: Pick<RequestTraceRuntime, 'createBuyerOrder'>;
  deps: WritePortableServiceRequestDeps;
}

export interface WritePortableServiceRequestResult {
  request: ServiceRequestContract;
  requestWrite: PortableRequestWriteRecord;
  buyerOrder: unknown;
  txids: string[];
}

export class PortableRequestTraceWriteError extends Error {
  requestWrite: PortableRequestWriteRecord;
  txids: string[];
  override cause: unknown;

  constructor(message: string, input: {
    requestWrite: PortableRequestWriteRecord;
    txids: string[];
    cause: unknown;
  }) {
    super(message);
    this.name = 'PortableRequestTraceWriteError';
    this.requestWrite = input.requestWrite;
    this.txids = input.txids;
    this.cause = input.cause;
  }
}

export function resolveExecutionGate(
  input: ResolveExecutionGateInput,
): ResolveExecutionGateResult {
  const request = normalizeServiceRequestContract(input.request);
  const explicitPaymentTxid = toSafeString(input.paymentTxid) || toSafeString(request.paymentProof.txid);
  const explicitOrderReferenceId = toSafeString(input.orderReferenceId);

  if (request.executionMode === 'free') {
    const freeTrackingId = explicitPaymentTxid
      || explicitOrderReferenceId
      || toSafeString(request.correlation.requestId)
      || null;
    return {
      executionMode: 'free',
      paymentTxid: freeTrackingId,
      orderReferenceId: explicitOrderReferenceId || freeTrackingId,
    };
  }

  return {
    executionMode: 'paid',
    paymentTxid: explicitPaymentTxid || null,
    orderReferenceId: explicitOrderReferenceId || null,
  };
}

export async function writePortableServiceRequest(
  input: WritePortableServiceRequestInput,
): Promise<WritePortableServiceRequestResult> {
  const request = normalizeServiceRequestContract(input.request);
  const gate = resolveExecutionGate({
    request,
    paymentTxid: input.paymentTxid,
    orderReferenceId: input.orderReferenceId,
  });
  const normalizedOrderText = input.deps.buildDelegationOrderPayload({
    rawRequest: request.taskContext || request.userTask,
    taskContext: request.taskContext,
    userTask: request.userTask,
    serviceName: toSafeString(input.serviceName) || request.servicePinId,
    providerSkill: toSafeString(input.providerSkill),
    servicePinId: request.servicePinId,
    paymentTxid: gate.executionMode === 'paid' ? gate.paymentTxid || '' : '',
    orderReference: gate.executionMode === 'free' ? gate.orderReferenceId || '' : '',
    price: request.price,
    currency: request.currency,
  });

  const wirePayload = input.deps.prepareSimpleMessagePayload
    ? await input.deps.prepareSimpleMessagePayload(normalizedOrderText)
    : normalizedOrderText;

  const pinResult = await input.deps.createPin(input.store, input.metabotId, {
    operation: 'create',
    path: SIMPLEMSG_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: wirePayload,
  });

  const txids = Array.isArray(pinResult.txids) ? pinResult.txids : [];
  const effectivePaymentTxid = gate.paymentTxid
    || toSafeString(pinResult.txids?.[0])
    || toSafeString(pinResult.pinId)
    || toSafeString(request.correlation.requestId)
    || '';

  const requestWrite: PortableRequestWriteRecord = {
    requestId: request.correlation.requestId,
    requesterSessionId: request.correlation.requesterSessionId,
    requesterConversationId: request.correlation.requesterConversationId,
    servicePinId: request.servicePinId,
    paymentTxid: effectivePaymentTxid || null,
    orderReferenceId: gate.orderReferenceId,
    orderMessagePinId: toSafeString(pinResult.pinId) || null,
    normalizedOrderText,
  };

  let buyerOrder: unknown;
  try {
    buyerOrder = input.trace.createBuyerOrder({
      localMetabotId: input.metabotId,
      counterpartyGlobalMetaId: toSafeString(input.counterpartyGlobalMetaId),
      servicePinId: request.servicePinId || null,
      serviceName: toSafeString(input.serviceName) || request.servicePinId || 'Service Order',
      paymentTxid: effectivePaymentTxid,
      paymentChain: toPaymentChain(input.paymentChain || request.paymentProof.chain || request.currency),
      paymentAmount: request.price,
      paymentCurrency: request.currency,
      coworkSessionId: toSafeString(input.coworkSessionId) || null,
      orderMessagePinId: toSafeString(pinResult.pinId) || null,
    });
  } catch (error) {
    throw new PortableRequestTraceWriteError(
      'Failed to create buyer trace after request write',
      { requestWrite, txids, cause: error },
    );
  }

  return {
    request,
    requestWrite,
    buyerOrder,
    txids,
  };
}
