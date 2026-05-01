export function getCoworkServiceOrderTone(summary) {
  const status = summary?.status;
  if (status === 'refund_pending') return 'warning';
  if (status === 'refunded') return 'success';
  return 'neutral';
}

function normalizeRefundStatusDismissPart(value) {
  return String(value || '').trim();
}

export function buildRefundStatusDismissKey(sessionId, summary) {
  const normalizedSessionId = normalizeRefundStatusDismissPart(sessionId);
  const stableOrderId = normalizeRefundStatusDismissPart(summary?.paymentTxid)
    || normalizeRefundStatusDismissPart(summary?.refundRequestPinId)
    || normalizeRefundStatusDismissPart(summary?.refundTxid)
    || normalizeRefundStatusDismissPart(summary?.servicePinId);
  const role = normalizeRefundStatusDismissPart(summary?.role) || 'unknown';

  if (!normalizedSessionId || !stableOrderId) {
    return '';
  }

  return [
    'cowork-refund-status',
    normalizedSessionId,
    role,
    stableOrderId,
  ].join(':');
}

export function shouldShowRefundStatusCard(summary, options = {}) {
  const status = summary?.status;
  const hasRefundStatus = status === 'refund_pending' || status === 'refunded';
  if (!hasRefundStatus) return false;

  const dismissedKeys = options?.dismissedKeys;
  const dismissKey = normalizeRefundStatusDismissPart(options?.dismissKey);
  if (dismissKey && typeof dismissedKeys?.has === 'function' && dismissedKeys.has(dismissKey)) {
    return false;
  }

  return true;
}

export function getRefundCardVariant(summary) {
  const status = summary?.status;
  const role = summary?.role;

  if (status === 'refund_pending') {
    return role === 'seller' ? 'seller-action' : 'buyer-pending';
  }

  if (status === 'refunded') {
    return 'refunded';
  }

  return null;
}
