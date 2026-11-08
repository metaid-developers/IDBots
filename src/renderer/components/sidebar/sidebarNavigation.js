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
 * Bot Home TEXT MENU (owner ruling 2026-11-08 14:22: "Bot home 界面先恢复到
 * 原来的状态" — the restored two-column Home face, not the three-column shell).
 *
 * The Home face no longer renders the 64 px icon rail, so its destinations are
 * the baseline text rows again: one creation action plus the two list
 * destinations the owner kept (2026-11-08 15:46). `scheduledTasks` is the
 * long-term workspace entry and carries the amber owner-decision dot;
 * `groupTasks` opens the 多人任务 management view.
 *
 * The 「我的 Bot」row is RETIRED from this menu by the same 15:46 ruling. The
 * roster keeps its entry point on the Bot Internet surface — the rail's
 * `myBots` pane (getRailInternetNavModel below) resolves to the same
 * metabotsView — so the destination did not lose its only door.
 *
 * Deliberately separate from `getRailHomeNavModel`: that model still feeds the
 * rail component (which only mounts on the Internet surface now), while this
 * one feeds the restored Home sidebar. They share destination ids, so App's
 * right-column renderer table stays the single source of truth for both.
 */
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

/**
 * Bot Internet text menu, baseline shape. The three-column Internet face uses
 * the rail instead; the model is kept beside the Home one because both
 * describe the baseline sidebar's menus, and the restored Home face must never
 * accidentally grow the Internet rows.
 */
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
  ];
}

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
 * The three Bot Home record types, in rail order.
 *
 * This is the CONTRACT model, not a rendered control: the middle column no
 * longer renders these as a selector (the owner ruling of 2026-11-08 moved the
 * only entry point to the rail's four icons). It stays here because the rail
 * model above and the middle column's bodies must name the same three types,
 * and tests/homeFaceLayering.test.mjs pins that parity against this list.
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
