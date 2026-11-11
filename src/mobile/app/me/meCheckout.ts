import {
  normalizeMePaymentCheckout,
  type MePaymentCheckout,
} from '../../../renderer/components/me/mePayment.ts';
import type { MePurchaseSubmitSection } from './purchaseSubmit';

type MePointsApi = Window['electron']['mePoints'];

export async function fetchMePaymentCheckout(args: {
  api: MePointsApi;
  section: MePurchaseSubmitSection;
  orderId: string;
  fallbackAmount?: number;
}): Promise<MePaymentCheckout | null> {
  if (args.section === 'subscribe') {
    const result = await args.api.getSubscriptionOrder({ orderId: args.orderId });
    if (!result.success || !result.subscriptionOrder) return null;
    return normalizeMePaymentCheckout(result.subscriptionOrder, args.fallbackAmount ?? 0);
  }
  const result = await args.api.getTopupOrders();
  if (!result.success) return null;
  const order = result.orders?.find((candidate) => candidate.orderId === args.orderId);
  return normalizeMePaymentCheckout(order, args.fallbackAmount ?? 0);
}

export function mergeMePaymentCheckout(
  current: MePaymentCheckout | null,
  next: MePaymentCheckout,
): MePaymentCheckout {
  if (!current || current.orderId !== next.orderId) return next;
  return {
    ...next,
    approvalUrl: next.approvalUrl || current.approvalUrl,
    qrCode: next.qrCode || current.qrCode,
    expiresAt: next.expiresAt ?? current.expiresAt,
    listAmountCny: next.listAmountCny ?? current.listAmountCny,
    creditAppliedCny: next.creditAppliedCny ?? current.creditAppliedCny,
  };
}
