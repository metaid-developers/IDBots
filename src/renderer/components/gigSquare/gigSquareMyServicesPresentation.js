const ACTION_STATES = {
  detail: { disabled: false, key: null },
  revoke: { disabled: true, key: 'gigSquareMyServicesComingSoon' },
  edit: { disabled: true, key: 'gigSquareMyServicesComingSoon' },
};

const METRIC_LABELS = {
  successCount: 'gigSquareMyServicesSuccessCount',
  refundCount: 'gigSquareMyServicesRefundCount',
  grossRevenue: 'gigSquareMyServicesGrossRevenue',
  netIncome: 'gigSquareMyServicesNetIncome',
  ratingAvg: 'gigSquareMyServicesRatingAvg',
};

export function getMyServiceActionState(action) {
  return ACTION_STATES[action] || { disabled: true, key: 'gigSquareMyServicesComingSoon' };
}

export function getMyServiceMetricLabel(metric) {
  return METRIC_LABELS[metric] || 'gigSquareMyServicesGrossRevenue';
}

export function getMyServiceOrderStatusKey(status) {
  return status === 'refunded'
    ? 'gigSquareMyServicesStatusRefunded'
    : 'gigSquareMyServicesStatusCompleted';
}

export function getMyServiceOrderStatusClassName(status) {
  return status === 'refunded'
    ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
}

export function getMyServiceSessionActionState(sessionId) {
  return String(sessionId || '').trim()
    ? { disabled: false, key: null }
    : { disabled: true, key: 'gigSquareMyServicesNoSession' };
}

export function shortenMyServiceHash(value, head = 10, tail = 6) {
  const normalized = String(value || '').trim();
  if (!normalized) return '—';
  if (normalized.length <= head + tail + 3) return normalized;
  return `${normalized.slice(0, head)}...${normalized.slice(-tail)}`;
}
