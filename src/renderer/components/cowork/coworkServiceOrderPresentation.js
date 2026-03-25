export function getCoworkServiceOrderTone(summary) {
  const status = summary?.status;
  if (status === 'refund_pending') return 'warning';
  if (status === 'refunded') return 'success';
  return 'neutral';
}

export function shouldShowRefundStatusCard(summary) {
  const status = summary?.status;
  return status === 'refund_pending' || status === 'refunded';
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
