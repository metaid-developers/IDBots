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
