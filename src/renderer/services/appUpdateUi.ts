/**
 * Pure helpers for the in-app update modal.
 *
 * Silent download/apply and the visible modal used to diverge: opening the
 * badge mid-download froze the UI at 100% with only Cancel, and Confirm then
 * raced the silent installer (missing DMG / "already in progress").
 */

export type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'applying' | 'restartReady';

export type UpdateModalState = 'info' | 'prompt' | 'downloading' | 'installing' | 'error' | 'restart';

export function isDownloadComplete(
  progress: { percent?: number | null } | null | undefined,
): boolean {
  const percent = progress?.percent;
  return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0.999;
}

export function modalStateForUpdatePhase(phase: UpdatePhase): UpdateModalState {
  switch (phase) {
    case 'downloading':
      return 'downloading';
    case 'applying':
      return 'installing';
    case 'restartReady':
      return 'restart';
    default:
      return 'info';
  }
}

export function shouldPreserveDownloadProgress(phase: UpdatePhase): boolean {
  return phase === 'downloading';
}

export type ConfirmUpdateAction =
  | { type: 'relaunch' }
  | { type: 'showRestart' }
  | { type: 'waitForSilentApply' }
  | { type: 'installLocal'; filePath: string }
  | { type: 'downloadManual' };

/**
 * Decide what Confirm/Install should do given the silent-update phase.
 * Never starts a second download or install while silent work owns the file.
 */
export function resolveConfirmUpdateAction(input: {
  phase: UpdatePhase;
  modalState: UpdateModalState;
  downloadedFilePath: string | null;
}): ConfirmUpdateAction {
  const { phase, modalState, downloadedFilePath } = input;

  if (modalState === 'restart') {
    return { type: 'relaunch' };
  }
  if (phase === 'restartReady') {
    return { type: 'showRestart' };
  }
  if (phase === 'applying' || phase === 'downloading') {
    return { type: 'waitForSilentApply' };
  }
  if (downloadedFilePath) {
    return { type: 'installLocal', filePath: downloadedFilePath };
  }
  return { type: 'downloadManual' };
}

export type CancelDownloadFollowUp =
  | { type: 'resetToInfo' }
  | { type: 'joinPhase'; modalState: UpdateModalState };

/**
 * Cancel only resets the modal when a download was actually aborted.
 * After 100% the IPC is a no-op — join the silent phase instead of offering
 * a second Install that races applySilent.
 */
export function resolveCancelDownloadFollowUp(input: {
  phase: UpdatePhase;
  downloadWasActive: boolean;
}): CancelDownloadFollowUp {
  if (input.downloadWasActive) {
    return { type: 'resetToInfo' };
  }
  return {
    type: 'joinPhase',
    modalState: modalStateForUpdatePhase(input.phase),
  };
}
