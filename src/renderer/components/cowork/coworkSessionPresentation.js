export function shouldShowCoworkA2ADot({ sessionType, showStatusIndicator }) {
  if (showStatusIndicator) return false;
  if (sessionType === 'a2a') return false;
  return false;
}

export function getCoworkSessionTitleClassName(input) {
  const sessionType = typeof input === 'string' ? input : input?.sessionType;
  const serviceOrderStatus = typeof input === 'string' ? undefined : input?.serviceOrderStatus;

  if (sessionType === 'a2a' && serviceOrderStatus === 'refund_pending') {
    return 'text-sm font-medium truncate leading-tight text-orange-600 dark:text-orange-400';
  }

  if (sessionType === 'a2a' && serviceOrderStatus === 'refunded') {
    return 'text-sm font-medium truncate leading-tight text-emerald-600 dark:text-emerald-400';
  }

  return sessionType === 'a2a'
    ? 'text-sm font-medium truncate leading-tight text-blue-500 dark:text-blue-400'
    : 'text-sm font-medium truncate leading-tight dark:text-claude-darkText text-claude-text';
}

export function shouldShowA2AServiceSessionId(input) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return false;
  if (input?.sessionType !== 'a2a') return false;
  return Boolean(input?.serviceOrderSummary);
}
