export function shouldShowCoworkA2ADot({ sessionType, showStatusIndicator }) {
  if (showStatusIndicator) return false;
  if (sessionType === 'a2a') return false;
  return false;
}

export function getCoworkSessionTitleClassName(sessionType) {
  return sessionType === 'a2a'
    ? 'text-sm font-medium truncate leading-tight text-blue-500 dark:text-blue-400'
    : 'text-sm font-medium truncate leading-tight dark:text-claude-darkText text-claude-text';
}
