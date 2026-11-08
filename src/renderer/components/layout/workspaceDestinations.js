/**
 * Left rail → right-column pane renderer map (three-column shell, slice 1 fix).
 *
 * The rail (WorkspaceRail) only reports which destination is current; App owns
 * the rendering. This module is the single table that binds the two directions:
 *
 *   rail model entry id  →  renderer key   (INTERNET_PANE_RENDERERS / HOME_RAIL_RENDERERS)
 *   mainView             →  renderer key   (HOME_MAIN_VIEW_RENDERERS)
 *   renderer key         →  App's switch branch
 *
 * The static guard in tests/workspaceRailDestinations.test.mjs asserts that
 * every entry of every rail model resolves here and that App implements a
 * branch for every renderer key. A rail entry can therefore never be added
 * without a rendered pane behind it.
 *
 * Both resolvers end on a non-blank fallback on purpose: an unknown or stale
 * destination value (HMR state carried over from an older module, a persisted
 * view id from an older profile) must still land on a real pane instead of an
 * empty column. `null` is never a valid destination.
 *
 * Settings and ME are deliberately absent: they are rail-bottom CONTROLS that
 * open an overlay/modal, not pane destinations.
 */

/** Bot Internet rail entry id → right-column renderer key. */
export const INTERNET_PANE_RENDERERS = Object.freeze({
  browser: 'botBrowserSurface',
  gigSquare: 'gigSquareView',
  metaapps: 'metaAppsView',
  myBots: 'metabotsView',
  cowork: 'coworkLanding',
});

/**
 * Bot Home rail entry id → right-column renderer key.
 *
 * `newTask` is the creation ACTION: it clears the session and lands on the
 * Co-Work view (the new-task composer); `records` lands on the same view but
 * with the records list expanded in the middle column. The two are kept as
 * separate rows so a future split of either landing cannot silently reuse the
 * other's pane.
 */
export const HOME_RAIL_RENDERERS = Object.freeze({
  newTask: 'coworkView',
  longTerm: 'scheduledTasksView',
  groupTasks: 'groupTasksView',
  records: 'coworkView',
});

/** App mainView → right-column renderer key (the pane a Bot Home entry lands on). */
export const HOME_MAIN_VIEW_RENDERERS = Object.freeze({
  scheduledTasks: 'scheduledTasksView',
  groupTasks: 'groupTasksView',
  metabots: 'metabotsView',
  cowork: 'coworkView',
});

/**
 * Every renderer App must implement. `botBrowserSurface` is the keep-alive
 * Browser pane; the rest are the right-column catalog/home payloads.
 */
export const PANE_RENDERER_KEYS = Object.freeze([
  'botBrowserSurface',
  'gigSquareView',
  'metaAppsView',
  'metabotsView',
  'coworkLanding',
  'coworkView',
  'scheduledTasksView',
  'groupTasksView',
]);

/** Unknown pane → the Co-Work landing card (always renders something). */
export const INTERNET_PANE_FALLBACK_RENDERER = 'coworkLanding';
/** Unknown/removed mainView → the Co-Work view (the historic else branch). */
export const HOME_MAIN_VIEW_FALLBACK_RENDERER = 'coworkView';

export function resolveInternetPaneRenderer(pane) {
  return INTERNET_PANE_RENDERERS[pane] ?? INTERNET_PANE_FALLBACK_RENDERER;
}

export function resolveHomeViewRenderer(mainView) {
  return HOME_MAIN_VIEW_RENDERERS[mainView] ?? HOME_MAIN_VIEW_FALLBACK_RENDERER;
}

/**
 * The renderer key one rail click lands on. Used by the guard test and by any
 * tooling that wants to walk the rail without rendering React.
 */
export function resolveRailEntryRenderer(surfaceMode, entryId) {
  const table = surfaceMode === 'home' ? HOME_RAIL_RENDERERS : INTERNET_PANE_RENDERERS;
  const fallback =
    surfaceMode === 'home' ? HOME_MAIN_VIEW_FALLBACK_RENDERER : INTERNET_PANE_FALLBACK_RENDERER;
  return table[entryId] ?? fallback;
}
