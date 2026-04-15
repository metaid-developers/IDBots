export function getSidebarPrimaryNavModel({ t, hasRunningScheduledTask }) {
  return [
    {
      id: 'scheduledTasks',
      label: t('scheduledTasks'),
      icon: 'clock',
      hasIndicator: Boolean(hasRunningScheduledTask),
    },
    {
      id: 'gigSquare',
      label: t('gigSquare'),
      icon: 'shoppingBag',
      badge: t('gigSquareAlphaBadge'),
    },
    {
      id: 'skills',
      label: t('skills'),
      icon: 'puzzlePiece',
    },
    {
      id: 'metabots',
      label: t('metabots'),
      icon: 'cpuChip',
    },
  ];
}
