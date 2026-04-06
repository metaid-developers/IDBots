export type ExecutionMode = 'free' | 'paid';

export interface PaymentProofContract {
  txid: string | null;
  chain: string | null;
  amount: string;
  currency: string;
  orderMessage: string;
  orderMessagePinId: string | null;
}

export interface RequestCorrelationContract {
  requestId: string;
  requesterSessionId: string;
  requesterConversationId: string | null;
}

export interface ServiceRequestContract {
  correlation: RequestCorrelationContract;
  servicePinId: string;
  requesterGlobalMetaId: string;
  price: string;
  currency: string;
  paymentProof: PaymentProofContract;
  userTask: string;
  taskContext: string;
  executionMode: ExecutionMode;
}

function isZeroLikeAmount(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

export function normalizeServiceRequestContract(input: Partial<ServiceRequestContract>): ServiceRequestContract {
  const price = String(input.price ?? '').trim() || '0';
  const correlationInput = (input.correlation ?? {}) as Partial<RequestCorrelationContract>;
  const paymentProofInput = (input.paymentProof ?? {}) as Partial<PaymentProofContract>;
  const normalizedExecutionMode: ExecutionMode =
    input.executionMode === 'free' || input.executionMode === 'paid'
      ? input.executionMode
      : (isZeroLikeAmount(price) ? 'free' : 'paid');
  return {
    correlation: {
      requestId: String(correlationInput.requestId ?? '').trim(),
      requesterSessionId: String(correlationInput.requesterSessionId ?? '').trim(),
      requesterConversationId: String(correlationInput.requesterConversationId ?? '').trim() || null,
    },
    servicePinId: String(input.servicePinId ?? '').trim(),
    requesterGlobalMetaId: String(input.requesterGlobalMetaId ?? '').trim(),
    price,
    currency: String(input.currency ?? '').trim().toUpperCase(),
    paymentProof: {
      txid: String(paymentProofInput.txid ?? '').trim() || null,
      chain: String(paymentProofInput.chain ?? '').trim().toLowerCase() || null,
      amount: String(paymentProofInput.amount ?? '').trim() || price,
      currency: String(paymentProofInput.currency ?? '').trim().toUpperCase()
        || String(input.currency ?? '').trim().toUpperCase(),
      orderMessage: String(paymentProofInput.orderMessage ?? '').trim(),
      orderMessagePinId: String(paymentProofInput.orderMessagePinId ?? '').trim() || null,
    },
    userTask: String(input.userTask ?? '').trim(),
    taskContext: String(input.taskContext ?? '').trim(),
    executionMode: normalizedExecutionMode,
  };
}
