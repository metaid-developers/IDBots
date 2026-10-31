/**
 * Voice button state machine (voice P0, subtask #10) — PURE reducer, no DOM,
 * no React, no network. Unit-tested exhaustively in
 * tests/mobileVoiceButtonState.test.ts.
 *
 * Interaction decision (documented in the delivery notes): TAP TOGGLE —
 * one tap starts, the next tap stops. Hold-to-talk was rejected for mobile
 * web: iOS long-press raises the callout/context menu, touchcancel on scroll
 * aborts mid-word, and it is worse for accessibility. Same model as Doubao's
 * own mobile web voice input.
 */

export type VoicePhase =
  | 'idle' // button shows mic icon, tap to start
  | 'requestingMic' // getUserMedia in flight (system permission dialog may show)
  | 'connecting' // mic granted, WebSocket dialing + awaiting `ready`
  | 'recording' // streaming PCM, partials may arrive
  | 'stopping' // user tapped stop; flushing PCM + awaiting final/end
  | 'error'; // terminal for this attempt; user dismisses back to idle

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
  errorCode: VoiceClientErrorCode | null;
  /** Set when the session ended but recognized text was kept in the draft. */
  keptText: boolean;
}

export type VoiceUiEvent =
  | { type: 'tapStart' }
  | { type: 'tapStop' }
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

export const VOICE_UI_INITIAL: VoiceUiState = { phase: 'idle', errorCode: null, keptText: false };

/**
 * Pure transition function. Unknown/self-contradictory events in a phase are
 * NO-OPs (idempotent): UI events can race timers on slow phones, and the
 * machine must never strand the user in a dead state — `reset` always works.
 */
export function reduceVoiceUi(state: VoiceUiState, event: VoiceUiEvent): VoiceUiState {
  switch (event.type) {
    case 'tapStart': {
      if (state.phase === 'idle') return { phase: 'requestingMic', errorCode: null, keptText: false };
      if (state.phase === 'recording') return { ...state, phase: 'stopping' };
      return state;
    }
    case 'tapStop': {
      if (state.phase === 'recording' || state.phase === 'connecting' || state.phase === 'requestingMic') {
        return { ...state, phase: 'stopping' };
      }
      return state;
    }
    case 'unsupported': {
      // Capability gate (old iOS Safari): fails from idle, no session started.
      if (state.phase === 'idle') return { phase: 'error', errorCode: 'unsupported', keptText: false };
      return state;
    }
    case 'micGranted': {
      if (state.phase === 'requestingMic') return { ...state, phase: 'connecting', errorCode: null };
      return state;
    }
    case 'micDenied': {
      if (state.phase === 'requestingMic' || state.phase === 'stopping') {
        return { phase: 'error', errorCode: 'mic_denied', keptText: false };
      }
      return state;
    }
    case 'micTimeout': {
      if (state.phase === 'requestingMic') return { phase: 'error', errorCode: 'mic_timeout', keptText: false };
      return state;
    }
    case 'socketReady': {
      if (state.phase === 'connecting') return { ...state, phase: 'recording', errorCode: null };
      return state;
    }
    case 'socketError': {
      // Any phase short of idle can fail; recording keeps accumulated text.
      if (state.phase === 'idle') return state;
      return { phase: 'error', errorCode: event.code, keptText: state.phase === 'recording' || state.phase === 'stopping' };
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
        return { phase: 'idle', errorCode: null, keptText: event.keptText };
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
