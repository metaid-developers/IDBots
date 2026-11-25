/**
 * Voice button state machine (voice P1: hold-to-send) — PURE reducer, no DOM,
 * no React, no network. Unit-tested exhaustively in
 * tests/mobileVoiceButtonState.test.ts.
 *
 * Interaction decision (2026-11-10, owner explicitly overrode voice P0):
 * HOLD TO TALK — pointerdown immediately shows a Preparing UI while mic + ASR
 * initialize; once BOTH microphone capture and the ASR session are ready, the
 * phone vibrates and the overlay transitions into the live Listening state
 * with a voice-reactive waveform. Pointerup sends the final transcript as a
 * new message.
 */

export type VoicePhase =
  | 'idle' // button shows mic icon / hold bar, press to start
  | 'requestingMic' // getUserMedia in flight (system permission dialog may show)
  | 'connecting' // mic granted, WebSocket dialing + awaiting `asr.open`
  | 'recording' // BOTH mic capture and ASR session ready; streaming PCM live
  | 'stopping' // user released; flushing PCM + awaiting final/done (recognizing)
  | 'error'; // terminal for this attempt; user dismisses or salvages the text

/** Which interaction started the session. */
export type VoiceMode = 'hold' | 'tap';

/** Client-side error codes (server codes arrive as `server:<code>`). */
export type VoiceClientErrorCode =
  | 'unsupported' // no AudioWorklet / no getUserMedia (old iOS Safari)
  | 'mic_denied'
  | 'mic_unavailable' // device missing / not readable
  | 'audio_context_failed' // AudioContext or worklet module failed to start
  | 'mic_timeout'
  | 'connect_timeout'
  | 'connection_lost'
  | 'interrupted' // iOS lock screen / call grabbed the audio session
  | `server:${string}`;

export interface VoiceUiState {
  phase: VoicePhase;
  mode: VoiceMode;
  errorCode: VoiceClientErrorCode | null;
  /** Set when the session ended but recognized text was kept (tap mode draft). */
  keptText: boolean;
}

export type VoiceUiEvent =
  | { type: 'tapStart' } // a11y fallback: tap toggles recording
  | { type: 'tapStop' }
  | { type: 'holdStart' } // pointerdown
  | { type: 'holdStop' } // pointerup, release-to-send
  | { type: 'holdCancel' } // swipe-up cancel / too-short press: discard everything
  | { type: 'unsupported' }
  | { type: 'micGranted' }
  | { type: 'micDenied' }
  | { type: 'micTimeout' }
  | { type: 'socketReady' }
  | { type: 'socketError'; code: VoiceClientErrorCode }
  | { type: 'interrupted' }
  | { type: 'sessionDone'; keptText: boolean }
  | { type: 'dismissError' }
  | { type: 'reset' };

export const VOICE_UI_INITIAL: VoiceUiState = {
  phase: 'idle',
  mode: 'hold',
  errorCode: null,
  keptText: false,
};

/**
 * Pure transition function. Unknown/self-contradictory events in a phase are
 * NO-OPs (idempotent): UI events can race timers on slow phones, and the
 * machine must never strand the user in a dead state — `reset` always works.
 */
export function reduceVoiceUi(state: VoiceUiState, event: VoiceUiEvent): VoiceUiState {
  switch (event.type) {
    case 'tapStart': {
      if (state.phase === 'idle') {
        return { phase: 'requestingMic', mode: 'tap', errorCode: null, keptText: false };
      }
      if (state.phase === 'recording') return { ...state, phase: 'stopping' };
      return state;
    }
    case 'holdStart': {
      if (state.phase === 'idle') {
        return { phase: 'requestingMic', mode: 'hold', errorCode: null, keptText: false };
      }
      return state;
    }
    case 'holdStop': {
      // Release is only meaningful for a hold session that is still running.
      if (state.mode !== 'hold') return state;
      if (state.phase === 'recording' || state.phase === 'connecting' || state.phase === 'requestingMic') {
        return { ...state, phase: 'stopping' };
      }
      return state;
    }
    case 'holdCancel': {
      // Swipe-up cancel or an accidental short press: nothing is kept.
      return VOICE_UI_INITIAL;
    }
    case 'tapStop': {
      if (state.phase === 'recording' || state.phase === 'connecting' || state.phase === 'requestingMic') {
        return { ...state, phase: 'stopping' };
      }
      return state;
    }
    case 'unsupported': {
      // Capability gate (old iOS Safari): fails from idle, no session started.
      if (state.phase === 'idle') {
        return { phase: 'error', mode: 'hold', errorCode: 'unsupported', keptText: false };
      }
      return state;
    }
    case 'micGranted': {
      if (state.phase === 'requestingMic') return { ...state, phase: 'connecting', errorCode: null };
      return state;
    }
    case 'micDenied': {
      if (state.phase === 'requestingMic' || state.phase === 'stopping') {
        return { phase: 'error', mode: state.mode, errorCode: 'mic_denied', keptText: false };
      }
      return state;
    }
    case 'micTimeout': {
      if (state.phase === 'requestingMic') {
        return { phase: 'error', mode: state.mode, errorCode: 'mic_timeout', keptText: false };
      }
      return state;
    }
    case 'socketReady': {
      if (state.phase === 'connecting') return { ...state, phase: 'recording', errorCode: null };
      return state;
    }
    case 'socketError': {
      // Any phase short of idle can fail; recording keeps accumulated text.
      if (state.phase === 'idle') return state;
      return {
        phase: 'error',
        mode: state.mode,
        errorCode: event.code,
        keptText: state.phase === 'recording' || state.phase === 'stopping',
      };
    }
    case 'interrupted': {
      // iOS lock screen / phone call: finalize with what we have, keep text.
      if (state.phase === 'recording' || state.phase === 'connecting') {
        return { ...state, phase: 'stopping' };
      }
      return state;
    }
    case 'sessionDone': {
      if (state.phase === 'stopping' || state.phase === 'recording' || state.phase === 'connecting') {
        return { phase: 'idle', mode: 'hold', errorCode: null, keptText: event.keptText };
      }
      return state;
    }
    case 'dismissError': {
      if (state.phase === 'error') return VOICE_UI_INITIAL;
      return state;
    }
    case 'reset':
      return VOICE_UI_INITIAL;
    default:
      return state;
  }
}

/** Convenience for a11y labels and test ids in the button component. */
export function voicePhaseTestid(state: VoiceUiState): string {
  return `voice-btn-${state.phase}`;
}

/** Overlay variant for the current phase; null = no overlay (idle / tap mode). */
export type VoiceOverlayVariant = 'preparing' | 'recording' | 'recognizing' | 'cancel' | 'error';

export function voiceOverlayVariant(
  state: VoiceUiState,
  cancelArmed: boolean,
  pressingHold = false,
): VoiceOverlayVariant | null {
  if (state.mode !== 'hold') return null;
  if (state.phase === 'error') return 'error';
  if (state.phase === 'stopping') return 'recognizing';
  if (state.phase === 'recording') {
    return cancelArmed ? 'cancel' : 'recording';
  }
  if (
    state.phase === 'requestingMic' ||
    state.phase === 'connecting' ||
    (state.phase === 'idle' && pressingHold)
  ) {
    // Show the explicit Preparing UI immediately on press until BOTH the mic
    // and ASR upstream are ready; swiping up still arms cancel right away.
    return cancelArmed ? 'cancel' : 'preparing';
  }
  return null;
}
