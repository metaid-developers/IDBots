export const SERVICE_ORDER_OPEN_ORDER_EXISTS_ERROR_CODE = 'open_order_exists';
export const SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE = 'self_order_not_allowed';
export const DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS = 60_000;
export const SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON = 'free_order_no_refund_required';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildBuyerPaymentKey(
  localMetabotId: number,
  counterpartyGlobalMetaId: string,
  paymentTxid?: string | null,
): string | null {
  const normalizedTxid = normalizeText(paymentTxid);
  if (!normalizedTxid) return null;
  return `${localMetabotId}:${normalizeText(counterpartyGlobalMetaId)}:${normalizedTxid}`;
}

export function isSelfDirectedPair(input: {
  localGlobalMetaId?: string | null;
  counterpartyGlobalMetaId?: string | null;
}): boolean {
  const local = normalizeText(input.localGlobalMetaId);
  const counterparty = normalizeText(input.counterpartyGlobalMetaId);
  return Boolean(local && counterparty && local === counterparty);
}
