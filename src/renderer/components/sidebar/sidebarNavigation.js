// Feature flag: the Group Tasks nav entry (and everything behind it) stays
// implemented. This is currently enabled for Group Task testing; set to
// `false` to hide the link on the Bot home page before a public release.
const GROUP_TASKS_NAV_ENABLED = true;

// Feature flag: the Bot Hub (gigSquare) nav entry and everything behind it
// stay implemented; Bot Hub is just not a promoted column for now. Set to
// `true` to restore the entry on the Bot Internet page.
const BOT_HUB_NAV_ENABLED = false;

export function getSidebarPrimaryNavModel({ t, hasRunningScheduledTask, needsDecisionCount = 0 }) {
  // A parked owner decision (waiting_owner) outranks "a task is running": a
  // running task needs nobody, while a parked decision needs the OWNER. Both
  // surface as the same amber dot, so the decision wins and carries its own
  // label/count.
  const decisionCount = Number.isFinite(needsDecisionCount) && needsDecisionCount > 0
    ? Math.floor(needsDecisionCount)
    : 0;
  const hasDecision = decisionCount > 0;
  return [
    {
      id: 'scheduledTasks',
      label: t('scheduledTasks'),
      icon: 'clock',
      hasIndicator: Boolean(hasRunningScheduledTask) || hasDecision,
      indicatorKind: hasDecision ? 'decision' : hasRunningScheduledTask ? 'running' : undefined,
      indicatorLabel: hasDecision
        ? t('trackedTaskNeedsDecision').replace('{count}', String(decisionCount))
        : undefined,
    },
    {
      id: 'groupTasks',
      label: t('groupTasks'),
      icon: 'userGroup',
      hidden: !GROUP_TASKS_NAV_ENABLED,
    },
  ];
}

export function getSidebarInternetNavModel({ t }) {
  return [
    {
      id: 'browser',
      label: t('botBrowser'),
      icon: 'globe',
    },
    {
      id: 'gigSquare',
      label: t('gigSquare'),
      icon: 'shoppingBag',
      badge: t('gigSquareAlphaBadge'),
      hidden: !BOT_HUB_NAV_ENABLED,
    },
    {
      id: 'metaapps',
      label: t('metaApps'),
      icon: 'squares2x2',
    },
    {
      // My Bots lives on the Bot Internet surface now (moved out of the Bot
      // Home primary nav): it is a catalog-side view like Meta Apps, mounted
      // right below it.
      id: 'myBots',
      label: t('metabots'),
      icon: 'cpuChip',
    },
  ];
}

export function isBotBrowserPaneVisible(surfaceMode, internetPane) {
  return surfaceMode === 'browser' && internetPane === 'browser';
}
