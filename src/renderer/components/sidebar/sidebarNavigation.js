// Feature flag: the Group Tasks nav entry (and everything behind it) stays
// implemented. This is currently enabled for Group Task testing; set to
// `false` to hide the link on the Bot home page before a public release.
const GROUP_TASKS_NAV_ENABLED = true;

// Feature flag: the Bot Hub (gigSquare) nav entry and everything behind it
// stay implemented; Bot Hub is just not a promoted column for now. Set to
// `true` to restore the entry on the Bot Internet rail.
const BOT_HUB_NAV_ENABLED = false;

/**
 * Navigation models for the three-column shell (slice 1).
 *
 * The left rail is an ICON rail: every entry is one icon plus a hover tooltip,
 * never a text row. The two surfaces share the same skeleton but not the same
 * entries — the Bot Internet rail lists the internet destinations, the Bot Home
 * rail lists the task lists. Settings and ME are pinned to the rail bottom by
 * the rail component itself, so they are deliberately absent from these models.
 *
 * All copy comes from i18n at call time; the models carry only ids, labels,
 * icon tokens and the attention indicator.
 */

/**
 * The Codex-style surface switcher: two entries, each with a title line and a
 * subtitle line. `id` is the BotBrowserSurfaceMode the entry selects.
 */
export function getSurfaceMenuModel({ t }) {
  return [
    {
      id: 'browser',
      label: t('botInternet'),
      subtitle: t('surfaceBotInternetSubtitle'),
    },
    {
      id: 'home',
      label: t('botHome'),
      subtitle: t('surfaceBotHomeSubtitle'),
    },
  ];
}

/**
 * Bot Internet rail entries. `browser` / `metaapps` / `myBots` fill the right
 * column with their destination (the browser pane stays mounted and hidden
 * behind a catalog); `cowork` is the Co-Work landing. Bot Hub stays implemented
 * but hidden behind its feature flag.
 */
export function getRailInternetNavModel({ t }) {
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
      // My Bots lives on the Bot Internet surface: a catalog-side view like
      // Meta Apps, mounted right below it.
      id: 'myBots',
      label: t('metabots'),
      icon: 'cpuChip',
    },
    {
      // The Co-Work list itself sits in the middle column on this surface; the
      // rail entry is its destination (and the landing in the right column).
      id: 'cowork',
      label: t('botBrowserCoworkTitle'),
      icon: 'chatBubbles',
    },
  ];
}

/**
 * Bot Home rail entries: a creation action plus the three task-list
 * destinations.
 *
 * The 长期任务 entry carries the attention dot: a parked owner decision
 * (waiting_owner) outranks "a task is running" — a running task needs nobody,
 * while a parked decision needs the OWNER. Both surface as the same amber dot,
 * so the decision wins and carries its own label/count.
 */
export function getRailHomeNavModel({ t, hasRunningScheduledTask, needsDecisionCount = 0 }) {
  const decisionCount = Number.isFinite(needsDecisionCount) && needsDecisionCount > 0
    ? Math.floor(needsDecisionCount)
    : 0;
  const hasDecision = decisionCount > 0;

  return [
    {
      id: 'newTask',
      label: t('newChat'),
      icon: 'compose',
    },
    {
      id: 'longTerm',
      label: t('railLongTermTasks'),
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
    {
      id: 'records',
      label: t('railTaskRecords'),
      icon: 'archive',
    },
  ];
}

/**
 * The Bot Home middle column reads as one list column with three sections;
 * every section header stays visible and exactly one body is expanded.
 */
export function getHomeSectionModel({ t }) {
  return [
    { id: 'longTerm', label: t('railLongTermTasks'), icon: 'clock' },
    { id: 'groupTasks', label: t('groupTasks'), icon: 'userGroup' },
    { id: 'records', label: t('railTaskRecords'), icon: 'archive' },
  ];
}

export function isBotBrowserPaneVisible(surfaceMode, internetPane) {
  return surfaceMode === 'browser' && internetPane === 'browser';
}
