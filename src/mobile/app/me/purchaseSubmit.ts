import {
  normalizeMePaymentCheckout,
  type MePaymentCheckout,
} from '../../../renderer/components/me/mePayment.ts';
import type { MePeriod } from './mePointsStore';

export type MePurchaseSubmitSection = 'subscribe' | 'topup';
export type MePaymentGateway = 'alipay' | 'paypal';

export interface MeSubscriptionOrderInput {
  planId: string;
  period: MePeriod;
  channel: 'mobile';
  gateway?: MePaymentGateway;
  voucherUrl?: string;
  voucherRemark?: string;
  idempotencyKey: string;
}

export interface MeTopupOrderInput {
  packageId: string;
  periodDays?: number;
  gateway?: MePaymentGateway;
  voucherUrl?: string;
  voucherRemark?: string;
  idempotencyKey: string;
}

export type MePurchaseOrderRequest =
  | { kind: 'subscribe'; input: MeSubscriptionOrderInput }
  | { kind: 'topup'; input: MeTopupOrderInput };

export interface MePurchaseOrderResponse {
  success: boolean;
  error?: string;
  errorCode?: string;
  featureUnavailable?: boolean;
}

export interface MePaymentOrder {
  orderId: string;
  status?: string;
  packageId?: string;
  planId?: string;
  period?: string;
  channel?: string;
  createdAt?: number;
  meMilli?: number;
  priceCny?: number;
  amountCny?: number;
  payAmount?: number;
  payCurrency?: string;
  gatewayParams?: unknown;
  rejectReason?: string;
  breakdown?: Record<string, unknown>;
}

export interface MeSubscriptionOrderResponse extends MePurchaseOrderResponse {
  subscriptionOrder?: MePaymentOrder;
}

export interface MeTopupOrderResponse extends MePurchaseOrderResponse {
  submission?: { order?: MePaymentOrder | null };
}

export interface MePurchaseSubmitApi {
  submitSubscriptionOrder: (input: MeSubscriptionOrderInput) => Promise<MeSubscriptionOrderResponse>;
  submitTopupOrder: (input: MeTopupOrderInput) => Promise<MeTopupOrderResponse>;
}

export interface MePurchaseSubmitResult {
  ok: boolean;
  orderId: string;
  payAmount?: number;
  checkout?: MePaymentCheckout;
  error?: string;
  errorCode?: string;
}

export function buildMePurchaseOrderRequest(args: {
  section: MePurchaseSubmitSection;
  planId?: string | null;
  packageId?: string | null;
  period: MePeriod;
  periodDays?: number;
  gateway?: MePaymentGateway;
  voucherUrl?: string;
  voucherRemark?: string;
  now?: number;
}): MePurchaseOrderRequest | null {
  const subjectId = args.section === 'subscribe' ? args.planId : args.packageId;
  if (!subjectId) return null;
  const gateway = args.gateway ?? 'alipay';
  const dayStamp = new Date(args.now ?? Date.now()).toISOString().slice(0, 10);
  const idempotencyKey = args.section === 'subscribe'
    ? `mobile-subscribe-${subjectId}-${args.period}-${gateway}-${dayStamp}`
    : `mobile-topup-${subjectId}-${gateway}-${dayStamp}`;
  const common = {
    gateway,
    voucherUrl: args.voucherUrl,
    voucherRemark: args.voucherRemark,
    idempotencyKey,
  };
  if (args.section === 'subscribe') {
    return {
      kind: 'subscribe',
      input: { planId: subjectId, period: args.period, channel: 'mobile', ...common },
    };
  }
  return { kind: 'topup', input: { packageId: subjectId, periodDays: args.periodDays, ...common } };
}

function successResult(order: MePaymentOrder | null | undefined): MePurchaseSubmitResult {
  const orderId = order?.orderId ?? '';
  const checkout = normalizeMePaymentCheckout(order, 0);
  return {
    ok: true,
    orderId,
    ...(typeof order?.payAmount === 'number' && Number.isFinite(order.payAmount)
      ? { payAmount: order.payAmount }
      : {}),
    ...(checkout && (checkout.approvalUrl || checkout.qrCode) ? { checkout } : {}),
  };
}

export async function submitMePurchaseOrder(
  api: MePurchaseSubmitApi,
  request: MePurchaseOrderRequest,
): Promise<MePurchaseSubmitResult> {
  if (request.kind === 'subscribe') {
    const res = await api.submitSubscriptionOrder(request.input);
    return res.success
      ? successResult(res.subscriptionOrder)
      : { ok: false, orderId: '', error: res.error, errorCode: res.errorCode };
  }
  const res = await api.submitTopupOrder(request.input);
  return res.success
    ? successResult(res.submission?.order)
    : { ok: false, orderId: '', error: res.error, errorCode: res.errorCode };
}
