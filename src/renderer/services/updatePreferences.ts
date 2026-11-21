/**
 * Persisted user control over the app-update channel.
 *
 * Owner order 2026-11-21: the update mechanism must leave the choice with the
 * user. Settings owns a visible "check automatically" switch that gates the
 * periodic check (30-minute heartbeat + visibilitychange re-check), and a
 * manual "check for updates" button keeps the same check reachable on demand.
 *
 * Default ON: existing installs keep the behaviour they already had. Turning
 * it OFF stops the polling loop entirely, and a found update is then only
 * offered — never downloaded in the background.
 *
 * Storage is best-effort localStorage (the same mechanism the sidebar width and
 * the persisted view state use): a missing, unreadable or unparsable value
 * means "default", i.e. ON.
 */

export const AUTO_CHECK_UPDATES_STORAGE_KEY = 'idbots.autoCheckUpdates';

/** The persisted switch value; defaults to true (keep the historical behaviour). */
export function loadAutoCheckUpdates(): boolean {
  try {
    const raw = window.localStorage.getItem(AUTO_CHECK_UPDATES_STORAGE_KEY);
    if (raw === '0' || raw === 'false') return false;
    // '1', 'true', null (never set) and anything unparsable all mean default ON.
    return true;
  } catch {
    return true;
  }
}

/** Persist the switch. A full or blocked localStorage must never break Settings. */
export function saveAutoCheckUpdates(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTO_CHECK_UPDATES_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Best effort, same as the other persisted UI preferences.
  }
}
