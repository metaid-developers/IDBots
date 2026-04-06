import type { MetabotStore } from '../metabotStore';
import {
  checkOrderPaymentStatus,
  extractOrderReferenceId,
  extractOrderSkillId,
  type OrderPaymentCheckResult,
  type OrderSource,
} from '../services/orderPayment';
import { normalizeServiceRequestContract, type ServiceRequestContract } from './contracts';

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

export interface VerifyPortablePaymentEligibilityInput {
  request: Partial<ServiceRequestContract>;
  providerContext: {
    metabotId: number;
    metabotStore: MetabotStore;
    source: OrderSource;
  };
  checkOrderPaymentStatusImpl?: typeof checkOrderPaymentStatus;
}

export interface VerifyPortablePaymentEligibilityResult {
  executable: boolean;
  reason: string;
  payment: OrderPaymentCheckResult;
  orderSkillId: string | null;
  orderReferenceId: string | null;
}

export async function verifyPortablePaymentEligibility(
  input: VerifyPortablePaymentEligibilityInput,
): Promise<VerifyPortablePaymentEligibilityResult> {
  const request = normalizeServiceRequestContract(input.request);
  const orderSkillId = extractOrderSkillId(request.paymentProof.orderMessage);
  const orderReferenceId = extractOrderReferenceId(request.paymentProof.orderMessage);
  const checkPayment = input.checkOrderPaymentStatusImpl ?? checkOrderPaymentStatus;
  const payment = await checkPayment({
    txid: request.paymentProof.txid,
    plaintext: request.paymentProof.orderMessage,
    source: input.providerContext.source,
    metabotId: input.providerContext.metabotId,
    metabotStore: input.providerContext.metabotStore,
  });

  if (request.executionMode === 'free') {
    if (payment.reason !== 'free_order_no_payment_required') {
      return {
        executable: false,
        reason: payment.reason,
        payment,
        orderSkillId,
        orderReferenceId,
      };
    }

    return {
      executable: true,
      reason: 'free_order_no_payment_required',
      payment: {
        ...payment,
        paid: true,
        txid: request.paymentProof.txid,
        reason: 'free_order_no_payment_required',
        chain: payment.chain || toPaymentChain(request.paymentProof.chain || request.currency),
        amountSats: 0,
      },
      orderSkillId,
      orderReferenceId,
    };
  }

  if (!payment.paid) {
    return {
      executable: false,
      reason: payment.reason,
      payment,
      orderSkillId,
      orderReferenceId,
    };
  }

  if (orderSkillId && request.servicePinId && toSafeString(orderSkillId) !== request.servicePinId) {
    return {
      executable: false,
      reason: 'service_pin_mismatch',
      payment,
      orderSkillId,
      orderReferenceId,
    };
  }

  return {
    executable: true,
    reason: payment.reason,
    payment,
    orderSkillId,
    orderReferenceId,
  };
}
