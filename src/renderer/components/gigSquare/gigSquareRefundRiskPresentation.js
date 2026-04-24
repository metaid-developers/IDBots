export function shouldHideRiskyGigSquareService(refundRisk) {
  // Keep risky providers visible in Bot Hub so users can still discover services
  // and make an informed choice with the explicit risk badge.
  return false;
}

export function getGigSquareRefundRiskBadge(refundRisk) {
  if (!refundRisk?.hasUnresolvedRefund) {
    return null;
  }
  return 'REFUND RISK';
}
