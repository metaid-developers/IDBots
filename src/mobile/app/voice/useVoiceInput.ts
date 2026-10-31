/**
 * useVoiceInput — glue hook for the mobile voice input (voice P0, #10).
 *
 * Owns the lifecycle: state machine (voiceButtonState) + capture
 * (VoiceCapture) + socket (VoiceSocketClient) + text merge (backfill), and
 * reports the merged draft back to the screen through `onDraftReplace`.
 * ChatScreen stays free of voice logic — it only passes a draft getter and a
 * draft setter (reusing the existing caret-restore plumbing).
 *
 * Lifecycle decisions (documented in the delivery notes):
 *  - Max duration 120 s: auto-finalize, text kept (quota is server-side).
 *  - Ready timeout 8 s: gateway did not ack `start` → connect_timeout.
 *  - Mic permission dialog is NOT timed (killing a session under an
 *    unanswered system dialog is worse than waiting).
 *  - Interruption / socket loss / server error: graceful finalize, KEEP the
 *    recognized text in the draft — never punish the user by dropping words.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createBackfill, splitDraftAtCaret, composeDraft, voiceTextCaret } from './backfill';
import { VoiceCapture } from './capture';
import { buildMockMicDeps, shouldUseMockMic } from './mockMic';
import {
  reduceVoiceUi,
  VOICE_UI_INITIAL,
  type VoiceClientErrorCode,
  type VoiceUiEvent,
  type VoiceUiState,
} from './voiceButtonState';
import { VoiceSocketClient } from './voiceSocket';

const MAX_SESSION_MS = 120_000;
const READY_TIMEOUT_MS = 8_000;
const STOP_GRACE_MS = 600;

export interface UseVoiceInputOptions {
  /** Replaces the composer draft (ChatScreen wires chat.setDraft + caret). */
  onDraftReplace: (text: string, caret: number) => void;
  /** Reads the draft + caret at session start (textareaRef access). */
  getDraftAndCaret: () => { draft: string; caret: number | null } | null;
  urlOverride?: string;
  token?: string;
}

export interface UseVoiceInputResult {
  state: VoiceUiState;
  elapsedSec: number;
  start: () => void;
  stop: () => void;
  dismissError: () => void;
}

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, dispatch] = useReducer(reduceVoiceUi, VOICE_UI_INITIAL);
  const [elapsedSec, setElapsedSec] = useState(0);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const captureRef = useRef<VoiceCapture | null>(null);
  const socketRef = useRef<VoiceSocketClient | null>(null);
  const backfillRef = useRef(createBackfill());
  const baseRef = useRef<{ before: string; after: string }>({ before: '', after: '' });
  const keptTextRef = useRef(false);
  const finalizingRef = useRef(false);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    for (const ref of [readyTimerRef, maxTimerRef, stopGraceRef]) {
      if (ref.current !== null) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    }
    if (tickerRef.current !== null) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  }, []);

  const pushDraft = useCallback(() => {
    const text = composeDraft(baseRef.current, backfillRef.current.voiceText);
    optionsRef.current.onDraftReplace(text, voiceTextCaret(baseRef.current, backfillRef.current.voiceText));
  }, []);

  const teardownMedia = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    clearTimers();
    finalizingRef.current = false;
  }, [clearTimers]);

  /**
   * Graceful finalize: flush tail PCM, send `stop`, then KEEP the socket
   * open for a short grace so the server's `final`/`end` can land (the final
   * text must replace the trailing partial in the draft). Only after the
   * grace do we close and declare done. `keepText` is true for every
   * non-cancel path — words are never dropped.
   */
  const finalize = useCallback(
    (dispatchDone: boolean) => {
      if (finalizingRef.current) return;
      finalizingRef.current = true;
      const capture = captureRef.current;
      if (capture) {
        const tail = capture.stop();
        captureRef.current = null;
        const socket = socketRef.current;
        if (tail && socket?.isOpen) socket.sendPcm(tail);
        socket?.sendStop();
      }
      clearTimers();
      keptTextRef.current = backfillRef.current.hasText;
      const done = () => {
        socketRef.current?.close();
        socketRef.current = null;
        finalizingRef.current = false;
        if (dispatchDone) dispatch({ type: 'sessionDone', keptText: keptTextRef.current });
      };
      // Grace window: final/end frames still arrive through the live socket.
      stopGraceRef.current = setTimeout(done, STOP_GRACE_MS);
    },
    [clearTimers],
  );

  const start = useCallback(() => {
    if (state.phase !== 'idle') return;
    if (!VoiceCapture.supported()) {
      dispatch({ type: 'unsupported' });
      return;
    }
    backfillRef.current = createBackfill();
    keptTextRef.current = false;
    const snapshot = optionsRef.current.getDraftAndCaret();
    baseRef.current = splitDraftAtCaret(snapshot?.draft ?? '', snapshot?.caret ?? null);

    dispatch({ type: 'tapStart' });

    const socket = new VoiceSocketClient({
      // Precedence: programmatic option > VITE_VOICE_WS_URL (dev/e2e stub
      // gateway) > same-origin /ws/voice default (protocol.ts).
      urlOverride:
        optionsRef.current.urlOverride ??
        (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_VOICE_WS_URL,
      token: optionsRef.current.token,
      onOpen: () => dispatch({ type: 'micGranted' }),
      onEvent: (event) => {
        switch (event.kind) {
          case 'ready': {
            if (readyTimerRef.current !== null) {
              clearTimeout(readyTimerRef.current);
              readyTimerRef.current = null;
            }
            dispatch({ type: 'socketReady' });
            maxTimerRef.current = setTimeout(() => finalize(true), MAX_SESSION_MS);
            tickerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
            return;
          }
          case 'partial': {
            backfillRef.current.setPartial(event.text);
            pushDraft();
            return;
          }
          case 'final': {
            backfillRef.current.commitFinal(event.text);
            pushDraft();
            return;
          }
          case 'error': {
            // Server-side rejection: keep whatever text already landed.
            finalize(true);
            dispatch({ type: 'socketError', code: `server:${event.code}` as VoiceClientErrorCode });
            return;
          }
          case 'end': {
            finalize(true);
            return;
          }
        }
      },
      onClose: ({ wasOpen }) => {
        // We closed it ourselves → finalize() already owns the flow.
        if (finalizingRef.current) return;
        if (wasOpen) {
          finalize(true);
          dispatch({ type: 'socketError', code: 'connection_lost' });
        } else {
          dispatch({ type: 'socketError', code: 'connect_timeout' });
        }
      },
    });
    socketRef.current = socket;

    // E2E-only mock mic (mock builds + ?voiceMockMic=1): synthetic sine
    // frames feed the REAL chunker/socket/backfill pipeline. Vite folds
    // the mock branch out of production builds (VITE_MOBILE_MOCK gate in
    // shouldUseMockMic), so the dependency is never even evaluated there.
    const useMockMic = shouldUseMockMic();
    const capture = new VoiceCapture(
      {
        onWireChunk: (bytes) => {
          socketRef.current?.sendPcm(bytes);
        },
        onInterrupted: () => {
          // Lock screen / call / app switch: finalize, keep the words.
          finalize(true);
        },
        onError: (code) => {
          teardownMedia();
          if (code === 'mic_denied') dispatch({ type: 'micDenied' });
          else dispatch({ type: 'socketError', code: 'mic_unavailable' as VoiceClientErrorCode });
        },
      },
      useMockMic ? buildMockMicDeps() : undefined,
    );
    captureRef.current = capture;

    capture
      .start()
      .then(() => {
        dispatch({ type: 'micGranted' });
        socket.dialStart();
        readyTimerRef.current = setTimeout(() => {
          finalize(true);
          dispatch({ type: 'socketError', code: 'connect_timeout' });
        }, READY_TIMEOUT_MS);
      })
      .catch(() => {
        // onError already dispatched the typed failure; just clean up.
        teardownMedia();
      });
  }, [state.phase, finalize, pushDraft, teardownMedia]);

  const stop = useCallback(() => {
    dispatch({ type: 'tapStop' });
    finalize(true);
  }, [finalize]);

  const dismissError = useCallback(() => {
    dispatch({ type: 'dismissError' } satisfies VoiceUiEvent);
  }, []);

  // Unmount safety: never leak a mic or socket.
  useEffect(
    () => () => {
      teardownMedia();
    },
    [teardownMedia],
  );

  return useMemo(
    () => ({ state, elapsedSec, start, stop, dismissError }),
    [state, elapsedSec, start, stop, dismissError],
  );
}
