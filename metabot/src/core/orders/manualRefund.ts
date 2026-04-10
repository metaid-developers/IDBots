export interface ManualRefundOrder {
  id: string;
  role: 'buyer' | 'seller';
  status: string;
  refundRequestPinId?: string | null;
  coworkSessionId?: string | null;
  paymentTxid?: string | null;
}

export type ManualRefundDecision =
  | {
      required: true;
      state: 'manual_action_required';
      code: 'manual_refund_required';
      message: string;
      ui: {
        kind: 'refund';
        orderId: string;
        sessionId: string | null;
        refundRequestPinId: string;
      };
    }
  | {
      required: false;
      state: 'not_required';
      code: 'refund_not_required';
      message: string;
    };

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveManualRefundDecision(
  order: ManualRefundOrder | null | undefined
): ManualRefundDecision {
  if (
    order
    && order.role === 'seller'
    && normalizeText(order.status) === 'refund_pending'
    && normalizeText(order.refundRequestPinId)
  ) {
    return {
      required: true,
      state: 'manual_action_required',
      code: 'manual_refund_required',
      message: 'Seller refund requires manual confirmation.',
      ui: {
        kind: 'refund',
        orderId: normalizeText(order.id),
        sessionId: normalizeText(order.coworkSessionId) || null,
        refundRequestPinId: normalizeText(order.refundRequestPinId),
      },
    };
  }

  return {
    required: false,
    state: 'not_required',
    code: 'refund_not_required',
    message: 'Manual refund is not required.',
  };
}
