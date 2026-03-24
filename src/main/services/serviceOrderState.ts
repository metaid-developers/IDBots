export type ServiceOrderStatus =
  | 'awaiting_first_response'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'refund_pending'
  | 'refunded'
  ;

export interface ServiceOrderTimeoutCheckRecord {
  status: ServiceOrderStatus;
  firstResponseDeadlineAt: number;
  deliveryDeadlineAt: number;
}

export interface ServiceOrderRefundVisibilityRecord {
  status?: ServiceOrderStatus;
  refundRequestedAt?: number | null;
  refundCompletedAt?: number | null;
}

export const REFUND_HIDE_AFTER_MS = 72 * 60 * 60_000;

export function computeOrderDeadlines(now: number) {
  return {
    firstResponseDeadlineAt: now + 5 * 60_000,
    deliveryDeadlineAt: now + 15 * 60_000,
  };
}

export function getTimedOutOrderTransition(order: ServiceOrderTimeoutCheckRecord, now: number) {
  if (order.status === 'awaiting_first_response' && now > order.firstResponseDeadlineAt) {
    return 'first_response_timeout';
  }
  if (order.status === 'in_progress' && now > order.deliveryDeadlineAt) {
    return 'delivery_timeout';
  }
  return null;
}

export function hasUnresolvedRefund(order: ServiceOrderRefundVisibilityRecord): boolean {
  if (!order) return false;
  return order.refundRequestedAt != null && order.refundCompletedAt == null;
}

export function shouldHideProviderForUnresolvedRefund(
  order: ServiceOrderRefundVisibilityRecord,
  now: number = Date.now()
): boolean {
  if (!hasUnresolvedRefund(order)) return false;
  return now - Number(order.refundRequestedAt) >= REFUND_HIDE_AFTER_MS;
}
