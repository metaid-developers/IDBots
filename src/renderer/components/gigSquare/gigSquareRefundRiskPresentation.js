export function shouldHideRiskyGigSquareService(refundRisk) {
  if (!refundRisk?.hasUnresolvedRefund) {
    return false;
  }
  return Number(refundRisk.unresolvedRefundAgeHours || 0) >= 72;
}

export function getGigSquareRefundRiskBadge(refundRisk) {
  if (!refundRisk?.hasUnresolvedRefund) {
    return null;
  }
  return 'REFUND RISK';
}
