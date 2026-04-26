function compact(parts) {
  return parts.filter(Boolean).join(' ');
}

export function buildMetaBotToggleViewModel({ enabled, variant = 'enable' }) {
  const trackClass = compact([
    'w-9 h-5',
    'rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0',
    enabled
      ? 'bg-claude-accent'
      : 'dark:bg-claude-darkBorder bg-claude-border',
  ]);

  const knobClass = compact([
    'w-3.5 h-3.5',
    'rounded-full bg-white shadow-md transform transition-transform',
    enabled
      ? 'translate-x-[18px]'
      : 'translate-x-[3px]',
  ]);

  return {
    trackClass,
    knobClass,
  };
}

export function formatGlobalMetaIdShort(globalMetaId) {
  const value = typeof globalMetaId === 'string' ? globalMetaId.trim() : '';
  if (!value) return '';
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}....${value.slice(-4)}`;
}

export async function copyGlobalMetaIdToClipboard(globalMetaId, clipboard) {
  const value = typeof globalMetaId === 'string' ? globalMetaId.trim() : '';
  if (!value || !clipboard?.writeText) return false;
  await clipboard.writeText(value);
  return true;
}
