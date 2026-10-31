/**
 * VoiceButton + VoiceErrorBanner (voice P0, subtask #10).
 *
 * Interaction: TAP TOGGLE (one tap starts, next tap stops) — hold-to-talk was
 * rejected for mobile web (iOS long-press callout, touchcancel on scroll,
 * worse a11y). Same model as Doubao mobile web. The recording state is a red
 * pulsing button with a live elapsed counter; errors surface as a banner
 * above the composer with a dismiss (and, for mic_denied, a settings hint).
 *
 * This component is presentational: all behavior comes from `useVoiceInput`
 * via props so the composer wiring stays in ChatScreen.
 */

import { MicrophoneIcon, StopIcon, XMarkIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import { mapServerErrorToCopyKey, type VoiceServerErrorCode } from './protocol';
import { voicePhaseTestid, type VoiceUiState, type VoiceClientErrorCode } from './voiceButtonState';

export interface VoiceButtonProps {
  state: VoiceUiState;
  elapsedSec: number;
  onStart: () => void;
  onStop: () => void;
}

export function VoiceButton({ state, elapsedSec, onStart, onStop }: VoiceButtonProps): JSX.Element {
  const recording = state.phase === 'recording';
  const inFlight = state.phase === 'requestingMic' || state.phase === 'connecting';
  const stopping = state.phase === 'stopping';
  const errored = state.phase === 'error';

  const label = errored
    ? t('mobile.chat.voice.errorDismiss')
    : recording
      ? t('mobile.chat.voice.stop')
      : t('mobile.chat.voice.start');

  return (
    <button
      type="button"
      data-testid={voicePhaseTestid(state)}
      aria-label={label}
      aria-pressed={recording}
      onClick={() => {
        if (errored) return; // dismissal is the banner's job; keep taps unambiguous
        if (recording) onStop();
        else onStart();
      }}
      className={`relative flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border transition-colors ${
        errored
          ? 'border-amber-300 bg-amber-50 text-amber-700'
          : recording
            ? 'animate-pulse border-red-300 bg-red-500 text-white'
            : stopping
              ? 'border-[var(--border-color)] bg-[var(--bg-hover)] text-[var(--text-secondary)]'
              : 'border-[var(--border-color)] bg-transparent text-[var(--text-primary)] active:bg-[var(--bg-hover)]'
      } ${inFlight ? 'opacity-70' : ''}`}
    >
      {recording ? <StopIcon className="h-5 w-5" aria-hidden /> : <MicrophoneIcon className="h-5 w-5" aria-hidden />}
      {recording && elapsedSec > 0 ? (
        <span
          data-testid="voice-elapsed"
          className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-red-500 px-1.5 text-[10px] font-medium leading-4 text-white"
        >
          {formatElapsed(elapsedSec)}
        </span>
      ) : null}
    </button>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** Maps a machine error code to its i18n key (server codes via protocol.ts). */
export function voiceErrorCopyKey(code: VoiceClientErrorCode): string {
  if (code.startsWith('server:')) {
    const serverCode = code.slice('server:'.length) as VoiceServerErrorCode | 'unknown';
    return `mobile.chat.voice.errorServer.${mapServerErrorToCopyKey(serverCode)}`;
  }
  return `mobile.chat.voice.error.${code}`;
}

export function VoiceErrorBanner({ state, onDismiss }: { state: VoiceUiState; onDismiss: () => void }): JSX.Element | null {
  if (state.phase !== 'error' || !state.errorCode) return null;
  return (
    <div
      role="alert"
      data-testid="voice-error"
      className="mx-3 mb-2 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2"
    >
      <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <p className="min-w-0 flex-1 text-xs text-amber-800" data-testid="voice-error-text">
        {t(voiceErrorCopyKey(state.errorCode))}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('mobile.chat.voice.errorDismiss')}
        data-testid="voice-error-dismiss"
        className="flex min-h-[32px] min-w-[32px] items-center justify-center text-amber-700 active:opacity-70"
      >
        <XMarkIcon className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
