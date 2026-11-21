/**
 * Pure presentation rules for the Apple-style software-update surface
 * (owner order 2026-11-21 17:29, superseding the paused 17:25 version block).
 *
 * Decided here, without React:
 *   - `resolveUpdateStatus` — the ONE status the General tab's "软件更新" row
 *     and the Software Update sub-panel both read: downloading / installing /
 *     ready / restart-ready / found / up-to-date / check failed / busy /
 *     unknown (never checked);
 *   - `formatUpdateStatus` — the one status sentence (i18n injected);
 *   - `selectChangeLogPreview` — the 3-item highlights preview plus how many
 *     items the expand control reveals;
 *   - `shouldShowUpdateDot` — the red dot on the bottom-left version block,
 *     the one "there is an update" signal.
 *
 * Since the row, the sub-panel and the dot share these resolvers, they can
 * never disagree about what the app currently knows.
 */

import type { UpdatePhase } from './appUpdateUi';
import type { UpdateCheckResult } from './appUpdateCheck';

export type UpdateStatusKind =
  | 'failed'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'restart-ready'
  | 'found'
  | 'up-to-date'
  | 'check-failed'
  | 'busy'
  | 'unknown';

export interface UpdateStatus {
  kind: UpdateStatusKind;
  /** Version the line talks about, when the kind carries one. */
  version?: string;
  /** 0-100 download percent, when the kind carries it. */
  percent?: number;
}

export interface UpdateStatusInput {
  phase: UpdatePhase;
  downloadPercent: number | null;
  latestVersion: string | null;
  silentDownloadFailed: boolean;
  /** Result of the most recent check (automatic or manual), if any. */
  lastCheck: UpdateCheckResult | null;
}

export function resolveUpdateStatus(input: UpdateStatusInput): UpdateStatus {
  // A failed silent download keeps phase 'idle'; it outranks "found" because
  // the useful sentence is "download failed, will retry", not "found".
  if (input.silentDownloadFailed) return { kind: 'failed' };

  switch (input.phase) {
    case 'downloading':
      return {
        kind: 'downloading',
        version: input.latestVersion ?? undefined,
        percent: input.downloadPercent ?? undefined,
      };
    case 'applying':
      return { kind: 'installing', version: input.latestVersion ?? undefined };
    case 'ready':
      return { kind: 'ready', version: input.latestVersion ?? undefined };
    case 'restartReady':
      return { kind: 'restart-ready', version: input.latestVersion ?? undefined };
    default:
      break;
  }

  if (input.latestVersion) {
    return { kind: 'found', version: input.latestVersion };
  }

  const last = input.lastCheck;
  if (last?.outcome === 'update-found') {
    return { kind: 'found', version: last.latestVersion };
  }
  if (last?.outcome === 'up-to-date') return { kind: 'up-to-date' };
  if (last?.outcome === 'error') return { kind: 'check-failed' };
  if (last?.outcome === 'skipped' && last.reason === 'busy') return { kind: 'busy' };
  return { kind: 'unknown' };
}

/**
 * Red dot on the rail's Settings button: an update is known and has not been
 * handed to the installer yet. While `applying` owns the update the dot is
 * dark — the header badge already reports that state.
 */
export function shouldShowUpdateDot(input: {
  latestVersion: string | null;
  phase: UpdatePhase;
  silentDownloadFailed: boolean;
}): boolean {
  return Boolean(input.latestVersion) && input.phase !== 'applying';
}

/**
 * The one status sentence. `t` is injected so the General row, the sub-panel
 * and the tests all render the same words from the same place.
 */
export function formatUpdateStatus(
  status: UpdateStatus,
  currentVersion: string,
  t: (key: string) => string,
): string {
  switch (status.kind) {
    case 'failed':
      return t('updateDownloadFailedTitle');
    case 'downloading': {
      const base = t('updateDownloadingPill');
      return status.percent != null ? `${base} ${status.percent}%` : base;
    }
    case 'installing':
      return t('updateInstalling');
    case 'ready':
      return t('updateDownloadedTitle');
    case 'restart-ready':
      return t('updateReadyPill');
    case 'found':
      return t('softwareUpdateAvailable').replace('{version}', status.version ?? '');
    case 'up-to-date':
      return t('softwareUpdateUpToDate').replace('{version}', currentVersion);
    case 'check-failed':
      return t('updateCheckFailed');
    case 'busy':
      return t('updateCheckInProgress');
    default:
      return t('softwareUpdateNotChecked');
  }
}

export interface ChangeLogPreview {
  /** The highlights shown before expanding. */
  visible: string[];
  /** How many further items the expand control reveals. */
  hiddenCount: number;
}

/**
 * Apple's "What's new" block shows a short preview, then expands. Blank
 * entries are dropped; at least one item is always shown.
 */
export function selectChangeLogPreview(content: string[], limit = 3): ChangeLogPreview {
  const items = Array.isArray(content)
    ? content.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
  const safeLimit = Math.max(1, Math.floor(limit));
  return {
    visible: items.slice(0, safeLimit),
    hiddenCount: Math.max(0, items.length - safeLimit),
  };
}
