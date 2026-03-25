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
