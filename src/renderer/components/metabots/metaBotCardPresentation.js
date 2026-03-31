function compact(parts) {
  return parts.filter(Boolean).join(' ');
}

export function buildMetaBotToggleViewModel({ enabled, variant = 'enable' }) {
  const isHeartbeat = variant === 'heartbeat';
  const trackClass = compact([
    isHeartbeat ? 'w-8 h-4' : 'w-9 h-5',
    'rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0',
    enabled
      ? (isHeartbeat ? 'bg-emerald-500 dark:bg-emerald-500' : 'bg-claude-accent')
      : 'dark:bg-claude-darkBorder bg-claude-border',
  ]);

  const knobClass = compact([
    isHeartbeat ? 'w-3 h-3' : 'w-3.5 h-3.5',
    'rounded-full bg-white shadow-md transform transition-transform',
    enabled
      ? (isHeartbeat ? 'translate-x-[17px]' : 'translate-x-[18px]')
      : (isHeartbeat ? 'translate-x-[2px]' : 'translate-x-[3px]'),
  ]);

  return {
    trackClass,
    knobClass,
  };
}
