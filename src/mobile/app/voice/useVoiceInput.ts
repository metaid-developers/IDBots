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
 *  - Max duration 120 s, further clamped by the `asr.open` remainingMs budget:
 *    auto-finalize, text kept (the daily quota is metered server-side).
 *  - Ready timeout 8 s: no `asr.open` after the socket opened → connect_timeout.
 *  - Mic permission dialog is NOT timed (killing a session under an
 *    unanswered system dialog is worse than waiting).
 *  - Interruption / socket loss / server error: graceful finalize, KEEP the
 *    recognized text in the draft — never punish the user by dropping words.
 *  - `upstream_lost` is NOT an error: the gateway reopens the upstream and
 *    re-emits `asr.open` on the same socket, so the session keeps running.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createBackfill, splitDraftAtCaret, composeDraft, voiceTextCaret } from './backfill';
import { VoiceCapture } from './capture';
import { buildMockMicDeps, shouldUseMockMic } from './mockMic';
import { classifyVoiceClose, type VoiceServerErrorClass } from './protocol';
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
// Safety net only: `asr.done` closes the interaction, this covers a silent
// gateway (two-pass finals can be slow, so do not cut them at 600 ms).
const STOP_GRACE_MAX_MS = 3_000;

export interface UseVoiceInputOptions {
  /** Replaces the composer draft (ChatScreen wires chat.setDraft + caret). */
  onDraftReplace: (text: string, caret: number) => void;
  /** Reads the draft + caret at session start (textareaRef access). */
  getDraftAndCaret: () => { draft: string; caret: number | null } | null;
  urlOverride?: string;
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
  // Last `asr.error` class — disambiguates close 4104 (quota vs session cap).
  const lastErrorClassRef = useRef<VoiceServerErrorClass | undefined>(undefined);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set while a finalize is waiting for `asr.done` (or the safety net). */
  const settleRef = useRef<((shouldDispatch: boolean) => void) | null>(null);
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
    settleRef.current = null;
  }, [clearTimers]);

  /**
   * Graceful finalize: flush tail PCM, send `finish`, then KEEP the socket
   * open until the gateway says the interaction is over. v1 makes that an
   * explicit signal — `asr.done` — so the timer below is only a SAFETY NET
   * for a gateway that never answers; a slow two-pass final must not be cut
   * off mid-utterance. `keepText` is true for every non-cancel path — words
   * are never dropped.
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
        socket?.sendFinish();
      }
      clearTimers();
      const settle = (shouldDispatch: boolean) => {
        if (!finalizingRef.current) return;
        if (stopGraceRef.current !== null) {
          clearTimeout(stopGraceRef.current);
          stopGraceRef.current = null;
        }
        // Read the merge state LAST: a final that landed during the wait
        // must still count as kept text.
        keptTextRef.current = backfillRef.current.hasText;
        socketRef.current?.close();
        socketRef.current = null;
        finalizingRef.current = false;
        settleRef.current = null;
        if (shouldDispatch) dispatch({ type: 'sessionDone', keptText: keptTextRef.current });
      };
      settleRef.current = settle;
      stopGraceRef.current = setTimeout(() => settle(dispatchDone), STOP_GRACE_MAX_MS);
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
    lastErrorClassRef.current = undefined;
    const snapshot = optionsRef.current.getDraftAndCaret();
    baseRef.current = splitDraftAtCaret(snapshot?.draft ?? '', snapshot?.caret ?? null);

    dispatch({ type: 'tapStart' });

    const socket = new VoiceSocketClient({
      // Precedence: programmatic option > VITE_VOICE_WS_URL (dev/e2e stub
      // gateway) > same-origin /asr/v1/ws default (protocol.ts).
      urlOverride:
        optionsRef.current.urlOverride ??
        (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_VOICE_WS_URL,
      onOpen: () => dispatch({ type: 'micGranted' }),
      onEvent: (event) => {
        switch (event.kind) {
          case 'open': {
            if (readyTimerRef.current !== null) {
              clearTimeout(readyTimerRef.current);
              readyTimerRef.current = null;
            }
            dispatch({ type: 'socketReady' });
            // remainingMs is THIS connection's wall-clock budget (doc section
            // 6), so the local auto-finalize must never outlive it. A second
            // asr.open (after UPSTREAM_LOST recovery) simply re-arms.
            const budgetMs =
              typeof event.remainingMs === 'number' && event.remainingMs > 0
                ? Math.min(MAX_SESSION_MS, event.remainingMs)
                : MAX_SESSION_MS;
            if (maxTimerRef.current !== null) clearTimeout(maxTimerRef.current);
            maxTimerRef.current = setTimeout(() => finalize(true), budgetMs);
            if (tickerRef.current !== null) clearInterval(tickerRef.current);
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
          case 'upstream_lost': {
            // Self-healing inside the gateway (upstream reopen + fresh
            // asr.open on this socket): keep the last partial, keep
            // streaming, never finalize.
            return;
          }
          case 'error': {
            // Server-side rejection: keep whatever text already landed.
            lastErrorClassRef.current = event.class;
            finalize(true);
            dispatch({ type: 'socketError', code: `server:${event.class}` as VoiceClientErrorCode });
            return;
          }
          case 'done': {
            // Authoritative end of the interaction: settle now instead of
            // waiting out the safety net. Unknown when we never finalized
            // (e.g. the gateway finalized on its own) -> normal finalize.
            if (settleRef.current) settleRef.current(true);
            else finalize(true);
            return;
          }
        }
      },
      onClose: ({ code, wasOpen }) => {
        // We closed it ourselves → finalize() already owns the flow.
        if (finalizingRef.current) return;
        if (!wasOpen) {
          dispatch({ type: 'socketError', code: 'connect_timeout' });
          return;
        }
        const close = classifyVoiceClose(code, lastErrorClassRef.current);
        finalize(true);
        if (close.action === 'reconnect') {
          // Transient (gateway fault / keepalive loss). P0 surfaces it rather
          // than silently re-dialing: a fresh socket carries no audio of its
          // own, so the honest recovery is "words kept, tap to retry".
          dispatch({ type: 'socketError', code: 'connection_lost' });
          return;
        }
        if (close.action === 'fail' && close.class) {
          dispatch({ type: 'socketError', code: `server:${close.class}` as VoiceClientErrorCode });
        }
        // action 'none' (clean 1000 without asr.done): silent graceful end.
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
        socket.dial();
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
