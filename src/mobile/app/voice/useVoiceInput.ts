/**
 * useVoiceInput — React glue for the mobile voice input (voice P1).
 *
 * Thin wrapper around VoiceSession (voiceSession.ts): the React layer owns
 * only the reducer state, the elapsed ticker mirror, the live level ref, the
 * recognized-text mirror, warmup, and the ready-haptic trigger; capture,
 * socket, pre-open audio buffering, timers, and text-merge live in the
 * imperative core so they are testable without a DOM.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { probeMicPermission, VoiceCapture } from './capture';
import { triggerVoiceReadyHaptic, type VoiceHapticSink } from './voiceHaptics';
import { reduceVoiceUi, VOICE_UI_INITIAL, type VoiceUiEvent, type VoiceUiState } from './voiceButtonState';
import { VoiceSession } from './voiceSession';

export interface UseVoiceInputOptions {
  /** Replaces the composer draft (tap mode backfill; ChatScreen caret seam). */
  onDraftReplace: (text: string, caret: number) => void;
  /** Reads the draft + caret at session start (textareaRef access). */
  getDraftAndCaret: () => { draft: string; caret: number | null } | null;
  /** Hold mode: finished transcript, emitted once after `asr.done`. */
  onFinalText?: (text: string) => void;
  /** Optional hook notified at the exact ready-to-speak transition. */
  onReady?: () => void;
  hapticSink?: VoiceHapticSink | null;
  urlOverride?: string;
}

export interface UseVoiceInputResult {
  state: VoiceUiState;
  elapsedSec: number;
  /** Live transcript for the hold overlay (partials + settled finals). */
  recognizedText: string;
  /** 0..1 input level from PCM RMS; read it in rAF, never in render loops. */
  levelRef: MutableRefObject<number>;
  /** Pre-warms AudioWorklet / permission state inside a user gesture. */
  warmup: (options?: { resume?: boolean }) => void;
  /** a11y fallback: tap toggles recording (backfills the draft). */
  start: () => void;
  stop: () => void;
  /** Pointerdown: start a hold session. */
  startHold: () => void;
  /** Pointerup (send): flush, await `asr.done`, emit the final transcript. */
  endHold: () => void;
  /** Swipe-up cancel / accidental short press: discard, never send. */
  cancelHold: () => void;
  /** Error recovery: move the recognized text into the composer. */
  commitToDraft: () => void;
  dismissError: () => void;
}

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, dispatch] = useReducer(reduceVoiceUi, VOICE_UI_INITIAL);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [recognizedText, setRecognizedText] = useState('');
  const levelRef = useRef(0);
  const sessionRef = useRef<VoiceSession | null>(null);
  // Synchronous in-flight guard: two pointerdowns can land before React
  // re-renders the phase, and one microphone is one session.
  const busyRef = useRef(false);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;

  const dispose = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    busyRef.current = false;
    levelRef.current = 0;
  }, []);

  // Probe permission state once on mount (never prompts) so returning users
  // get parallel WebSocket dialing on their very first press; clean up on unmount.
  useEffect(() => {
    probeMicPermission();
    return dispose;
  }, [dispose]);

  const warmup = useCallback((warmOpts?: { resume?: boolean }) => {
    VoiceCapture.warmup(warmOpts);
  }, []);

  const begin = useCallback(
    (mode: 'hold' | 'tap'): void => {
      if (busyRef.current || stateRef.current.phase !== 'idle') return;
      if (!VoiceCapture.supported()) {
        dispatch({ type: 'unsupported' });
        return;
      }
      busyRef.current = true;
      const snapshot = optionsRef.current.getDraftAndCaret();
      setElapsedSec(0);
      setRecognizedText('');
      levelRef.current = 0;

      const session = new VoiceSession(
        {
          mode,
          draft: snapshot?.draft ?? '',
          caret: snapshot?.caret ?? null,
          urlOverride: optionsRef.current.urlOverride,
        },
        {
          onUiEvent: (event: VoiceUiEvent) => {
            if (event.type === 'sessionDone') {
              // Keep the session object until the screen disposes it: an
              // ERROR phase settles asynchronously (3 s safety net) and the
              // salvage button still needs its retained transcript afterwards.
              busyRef.current = false;
            }
            if (event.type === 'holdCancel') {
              sessionRef.current = null;
              busyRef.current = false;
            }
            dispatch(event);
          },
          onReady: () => {
            triggerVoiceReadyHaptic(optionsRef.current.hapticSink);
            optionsRef.current.onReady?.();
          },
          onElapsed: (sec) => setElapsedSec(sec),
          onLevel: (level) => {
            levelRef.current = level;
          },
          onRecognizedText: (text) => setRecognizedText(text),
          onDraftReplace: (text, caret) => optionsRef.current.onDraftReplace(text, caret),
          onFinalText: (text) => optionsRef.current.onFinalText?.(text),
        },
      );
      sessionRef.current = session;
      session.start();
    },
    [],
  );

  const startHold = useCallback(() => begin('hold'), [begin]);
  const start = useCallback(() => begin('tap'), [begin]);

  const endHold = useCallback(() => {
    sessionRef.current?.finish();
  }, []);

  const stop = useCallback(() => {
    sessionRef.current?.finish();
  }, []);

  const cancelHold = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    busyRef.current = false;
    session?.cancel();
    levelRef.current = 0;
    setElapsedSec(0);
  }, []);

  const commitToDraft = useCallback(() => {
    sessionRef.current?.commitToDraft();
    sessionRef.current = null;
    busyRef.current = false;
    levelRef.current = 0;
    dispatch({ type: 'dismissError' });
  }, []);

  const dismissError = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    busyRef.current = false;
    levelRef.current = 0;
    setRecognizedText('');
    dispatch({ type: 'dismissError' });
  }, []);

  return useMemo(
    () => ({
      state,
      elapsedSec,
      recognizedText,
      levelRef,
      warmup,
      start,
      stop,
      startHold,
      endHold,
      cancelHold,
      commitToDraft,
      dismissError,
    }),
    [
      state,
      elapsedSec,
      recognizedText,
      warmup,
      start,
      stop,
      startHold,
      endHold,
      cancelHold,
      commitToDraft,
      dismissError,
    ],
  );
}
