/**
 * One app-update check, shared by the automatic heartbeat and by the Settings
 * page's manual "check for updates" button.
 *
 * Owner order 2026-11-21: checking and installing are two separate consents.
 *   - auto-check ON  → the historical behaviour is preserved: a found update
 *                      starts the silent download/apply flow immediately;
 *   - auto-check OFF → a found update is only OFFERED ('prompt'); nothing is
 *                      downloaded until the user picks "update now" in the
 *                      dialog. "Not now" simply closes it and the badge stays
 *                      as the manual entry point.
 *
 * The caller supplies the platform pieces (version read, check request, the
 * found/no-update handlers), so this module stays a pure orchestration step and
 * can be exercised without Electron or React.
 */

import type { AppUpdateInfo } from './appUpdate';

export type UpdateCheckOutcome = 'up-to-date' | 'update-found' | 'skipped' | 'error';

/** What a found update is allowed to do under the current user setting. */
export type FoundUpdateAction = 'prompt' | 'silent-download';

export interface UpdateCheckResult {
  outcome: UpdateCheckOutcome;
  /** Present when outcome === 'update-found'. */
  latestVersion?: string;
  /** Present when outcome === 'skipped': why no request was issued. */
  reason?: 'busy' | 'mock';
}

export interface AppUpdateCheckOptions {
  /** The persisted auto-check switch. OFF means "offer, never download". */
  autoCheckEnabled: boolean;
  /** Silent download / apply in flight, or replaced and waiting for restart. */
  silentWorkInFlight: boolean;
  /** Dev mock update mode already owns the update state. */
  mockUpdateMode: boolean;
  getCurrentVersion: () => Promise<string>;
  checkForUpdate: (currentVersion: string) => Promise<AppUpdateInfo | null>;
  /** Version already downloaded and waiting to install, if any. */
  downloadedVersion: string | null;
  onFound: (info: AppUpdateInfo, action: FoundUpdateAction) => void;
  onNoUpdate: () => void;
  onError?: (error: unknown) => void;
}

/**
 * The consent rule, in one place: only an ON switch may start a silent
 * download. Kept exported so the wiring test can pin the mapping directly.
 */
export function resolveFoundUpdateAction(autoCheckEnabled: boolean): FoundUpdateAction {
  return autoCheckEnabled ? 'silent-download' : 'prompt';
}

export async function runAppUpdateCheck(
  options: AppUpdateCheckOptions,
): Promise<UpdateCheckResult> {
  // 静默下载/替换进行中，或已替换待重启时，不再重复检查
  if (options.mockUpdateMode || options.silentWorkInFlight) {
    return {
      outcome: 'skipped',
      reason: options.mockUpdateMode ? 'mock' : 'busy',
    };
  }

  try {
    const currentVersion = await options.getCurrentVersion();
    const nextUpdate = await options.checkForUpdate(currentVersion);

    if (!nextUpdate) {
      // 服务器端无更新：仅在本地没有待处理的已下载更新时清理提示
      options.onNoUpdate();
      return { outcome: 'up-to-date' };
    }

    if (options.downloadedVersion === nextUpdate.latestVersion) {
      // Already on disk; the badge / install flow owns it. Still report the
      // finding so a manual check can say "new version found".
      return { outcome: 'update-found', latestVersion: nextUpdate.latestVersion };
    }

    options.onFound(nextUpdate, resolveFoundUpdateAction(options.autoCheckEnabled));
    return { outcome: 'update-found', latestVersion: nextUpdate.latestVersion };
  } catch (error) {
    options.onError?.(error);
    return { outcome: 'error' };
  }
}
