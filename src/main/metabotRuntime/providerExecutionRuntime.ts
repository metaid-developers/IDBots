import type { OrderSource } from '../services/orderPayment';
import { normalizeAttachmentRefs } from './attachmentRefs';
import { normalizeServiceRequestContract, type ServiceRequestContract } from './contracts';
import type { HostSessionAdapter } from './hostSessionAdapter';
import type { VerifyPortablePaymentEligibilityResult } from './paymentVerificationRuntime';
import type { RequestTraceRuntime } from './requestTraceRuntime';

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

export interface ProviderExecutionContext {
  metabotId: number;
  source: OrderSource;
  counterpartyGlobalMetaId: string;
  serviceName: string;
  paymentTxid?: string | null;
  paymentChain?: string | null;
  paymentAmount: string;
  paymentCurrency?: string | null;
  orderMessagePinId?: string | null;
  coworkSessionId?: string | null;
  externalConversationId?: string | null;
  prompt: string;
  systemPrompt: string;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
  skipSellerTrace?: boolean;
}

export interface ExecuteProviderRequestInput {
  request: Partial<ServiceRequestContract>;
  verification: VerifyPortablePaymentEligibilityResult;
  providerContext: ProviderExecutionContext;
  trace: Pick<RequestTraceRuntime, 'createSellerOrder'>;
  hostAdapter: HostSessionAdapter;
}

export interface ExecuteProviderRequestResult {
  executable: boolean;
  reason: string;
  request: ServiceRequestContract;
  paymentTxid: string | null;
  sessionId: string | null;
  text: string;
  attachments: string[];
  ratingInvite: string;
  sellerOrder: unknown;
}

export async function executeProviderRequest(
  input: ExecuteProviderRequestInput,
): Promise<ExecuteProviderRequestResult> {
  const request = normalizeServiceRequestContract(input.request);
  const paymentTxid = toSafeString(input.providerContext.paymentTxid)
    || toSafeString(input.verification.payment.txid)
    || toSafeString(request.paymentProof.txid)
    || null;

  if (!input.verification.executable) {
    return {
      executable: false,
      reason: input.verification.reason,
      request,
      paymentTxid,
      sessionId: null,
      text: '',
      attachments: [],
      ratingInvite: '',
      sellerOrder: null,
    };
  }

  let sellerOrder: unknown = null;
  if (!input.providerContext.skipSellerTrace && paymentTxid) {
    sellerOrder = input.trace.createSellerOrder({
      localMetabotId: input.providerContext.metabotId,
      counterpartyGlobalMetaId: input.providerContext.counterpartyGlobalMetaId,
      servicePinId: request.servicePinId || null,
      serviceName: input.providerContext.serviceName,
      paymentTxid,
      paymentChain: toSafeString(input.providerContext.paymentChain) || undefined,
      paymentAmount: input.providerContext.paymentAmount,
      paymentCurrency: toSafeString(input.providerContext.paymentCurrency) || undefined,
      coworkSessionId: toSafeString(input.providerContext.coworkSessionId) || null,
      orderMessagePinId: toSafeString(input.providerContext.orderMessagePinId) || null,
    });
  }

  const session = await input.hostAdapter.startProviderSession({
    metabotId: input.providerContext.metabotId,
    source: input.providerContext.source,
    externalConversationId: toSafeString(input.providerContext.externalConversationId),
    existingSessionId: toSafeString(input.providerContext.coworkSessionId) || null,
    prompt: input.providerContext.prompt,
    systemPrompt: input.providerContext.systemPrompt,
    peerGlobalMetaId: toSafeString(input.providerContext.peerGlobalMetaId) || null,
    peerName: toSafeString(input.providerContext.peerName) || null,
    peerAvatar: toSafeString(input.providerContext.peerAvatar) || null,
    servicePinId: request.servicePinId,
    requesterGlobalMetaId: request.requesterGlobalMetaId,
    userTask: request.userTask,
    taskContext: request.taskContext,
  });

  const providerResult = await input.hostAdapter.waitForProviderResult(session.sessionId);

  return {
    executable: true,
    reason: input.verification.reason,
    request,
    paymentTxid,
    sessionId: session.sessionId,
    text: toSafeString(providerResult.text) || '处理完成，但没有生成回复。',
    attachments: normalizeAttachmentRefs(Array.isArray(providerResult.attachments) ? providerResult.attachments : []),
    ratingInvite: toSafeString(providerResult.ratingInvite),
    sellerOrder,
  };
}
