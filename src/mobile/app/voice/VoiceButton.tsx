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
import { errorClassToCopyCode, type VoiceServerErrorClass } from './protocol';
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
      className={`twin-icon-button twin-composer-accessory relative shrink-0 ${
        errored
          ? 'text-[var(--twin-warning)]'
          : recording
            ? 'twin-icon-button-danger animate-pulse'
            : stopping
              ? 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'
              : ''
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
    const errorClass = code.slice('server:'.length) as VoiceServerErrorClass;
    return `mobile.chat.voice.errorServer.${errorClassToCopyCode(errorClass)}`;
  }
  return `mobile.chat.voice.error.${code}`;
}

export function VoiceErrorBanner({ state, onDismiss }: { state: VoiceUiState; onDismiss: () => void }): JSX.Element | null {
  if (state.phase !== 'error' || !state.errorCode) return null;
  return (
    <div
      role="alert"
      data-testid="voice-error"
      className="twin-notice twin-notice-warning mx-3 mb-2 flex items-center gap-2"
    >
      <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-xs" data-testid="voice-error-text">
        {t(voiceErrorCopyKey(state.errorCode))}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('mobile.chat.voice.errorDismiss')}
        data-testid="voice-error-dismiss"
        className="twin-icon-button"
      >
        <XMarkIcon className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
