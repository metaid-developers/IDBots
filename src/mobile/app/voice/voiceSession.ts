/**
 * VoiceSession — imperative life-cycle core for one voice session (voice P1).
 *
 * Extracted from the voice-P0 React hook so the hold-to-send rules can be
 * exercised end-to-end without a DOM: tests inject a fake capture and a fake
 * socket and drive the REAL finalize / settle / text-emission path.
 *
 * Life-cycle decisions carried over from P0 (must not regress):
 *  - Max duration 120 s, further clamped by the `asr.open` remainingMs budget:
 *    auto-finalize, text kept (the daily quota is metered server-side).
 *  - Ready timeout 8 s: no `asr.open` after the socket opened -> connect_timeout.
 *  - Mic permission dialog is NOT timed.
 *  - Interruption / socket loss / server error: graceful finalize, KEEP the
 *    recognized text — never punish the user by dropping words.
 *  - `upstream_lost` is NOT an error: the gateway reopens the upstream and
 *    re-emits `asr.open` on the same socket, so the session keeps running.
 *
 * New in P1:
 *  - `mode` split: a HOLD session never writes into the composer draft. Its
 *    transcript is emitted once through `onFinalText` after the gateway's
 *    `asr.done`, for ChatScreen to send as a new message. A TAP session keeps
 *    the P0 backfill-into-draft behaviour (a11y fallback).
 *  - `cancel()` discards everything: no final text, no draft write. Used for
 *    swipe-up cancel and accidental short presses.
 *  - `commitToDraft()` is the explicit salvage path ("put into input box") for
 *    an error card — the only way a hold transcript may enter the composer.
 */

import {
  composeDraft,
  createBackfill,
  splitDraftAtCaret,
  voiceTextCaret,
  type BackfillController,
} from './backfill';
import { VoiceCapture, type VoiceCaptureEvents } from './capture';
import { buildMockMicDeps, shouldUseMockMic } from './mockMic';
import { classifyVoiceClose, type VoiceServerErrorClass } from './protocol';
import type { VoiceClientErrorCode, VoiceMode, VoiceUiEvent } from './voiceButtonState';
import { VoiceSocketClient } from './voiceSocket';

export const MAX_SESSION_MS = 120_000;
const READY_TIMEOUT_MS = 8_000;
// Safety net only: `asr.done` closes the interaction, this covers a silent
// gateway (two-pass finals can be slow, so do not cut them at 600 ms).
const STOP_GRACE_MAX_MS = 3_000;

/** Structural capture surface (real VoiceCapture or a test fake). */
export interface VoiceCaptureLike {
  start(): Promise<unknown>;
  stop(): Uint8Array | null;
}

/** Structural socket surface (real VoiceSocketClient or a test fake). */
export interface VoiceSocketLike {
  readonly isOpen: boolean;
  dial(): void;
  sendPcm(bytes: Uint8Array): void;
  sendFinish(): void;
  sendAbort(): void;
  close(): void;
}

export interface VoiceSocketHandlers {
  onOpen(): void;
  onEvent(event: VoiceServerEventLike): void;
  onClose(info: { code: number; wasOpen: boolean }): void;
}

/** Subset of protocol.VoiceServerEvent used here (kept structural for fakes). */
export interface VoiceServerEventLike {
  kind: 'open' | 'partial' | 'final' | 'error' | 'done' | 'upstream_lost';
  text?: string;
  class?: VoiceServerErrorClass;
  remainingMs?: number;
}

export type VoiceSocketFactory = (
  handlers: VoiceSocketHandlers,
  urlOverride: string | undefined,
) => VoiceSocketLike;

export type VoiceCaptureFactory = (events: VoiceCaptureEvents) => VoiceCaptureLike;

export interface VoiceSessionDeps {
  createCapture?: VoiceCaptureFactory;
  createSocket?: VoiceSocketFactory;
}

export interface VoiceSessionHandlers {
  onUiEvent: (event: VoiceUiEvent) => void;
  onElapsed: (sec: number) => void;
  onLevel: (level: number) => void;
  onRecognizedText: (text: string) => void;
  /** Tap mode only: the P0 streaming backfill into the composer draft. */
  onDraftReplace?: (text: string, caret: number) => void;
  /** Hold mode only: the finished transcript, emitted once after `asr.done`. */
  onFinalText?: (text: string) => void;
}

export interface VoiceSessionConfig {
  mode: VoiceMode;
  draft: string;
  caret: number | null;
  urlOverride?: string;
}

export class VoiceSession {
  private capture: VoiceCaptureLike | null = null;
  private socket: VoiceSocketLike | null = null;
  private readonly backfill: BackfillController = createBackfill();
  private base = { before: '', after: '' };
  private finalizing = false;
  private cancelled = false;
  private errored = false;
  private finalEmitted = false;
  private settled = false;
  private started = false;
  private lastErrorClass: VoiceServerErrorClass | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private stopGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private settleFn: ((shouldDispatch: boolean) => void) | null = null;

  constructor(
    private readonly config: VoiceSessionConfig,
    private readonly handlers: VoiceSessionHandlers,
    private readonly deps: VoiceSessionDeps = {},
  ) {}

  get recognizedText(): string {
    return this.backfill.voiceText;
  }

  /** Unmount path: tear everything down WITHOUT emitting UI events. */
  dispose(): void {
    this.cancelled = true;
    this.teardownMedia();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.base = splitDraftAtCaret(this.config.draft, this.config.caret);

    this.handlers.onUiEvent({ type: this.config.mode === 'hold' ? 'holdStart' : 'tapStart' });

    const urlOverride =
      this.config.urlOverride ??
      (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_VOICE_WS_URL;
    const createSocket =
      this.deps.createSocket ??
      ((handlers, override) =>
        new VoiceSocketClient({
          urlOverride: override,
          onOpen: handlers.onOpen,
          onEvent: (event) => handlers.onEvent(event),
          onClose: handlers.onClose,
        }));

    const socket = createSocket(
      {
        onOpen: () => this.handlers.onUiEvent({ type: 'micGranted' }),
        onEvent: (event) => this.handleServerEvent(event),
        onClose: (info) => this.handleSocketClose(info),
      },
      urlOverride,
    );
    this.socket = socket;

    const captureEvents: VoiceCaptureEvents = {
      onWireChunk: (bytes) => {
        this.socket?.sendPcm(bytes);
      },
      onInterrupted: () => {
        // Lock screen / call / app switch: finalize, keep the words.
        this.finish();
      },
      onError: (code) => {
        this.teardownMedia();
        if (code === 'mic_denied') this.handlers.onUiEvent({ type: 'micDenied' });
        else {
          this.errored = true;
          this.handlers.onUiEvent({
            type: 'socketError',
            code: 'mic_unavailable' as VoiceClientErrorCode,
          });
        }
      },
      onLevel: (level) => this.handlers.onLevel(level),
    };
    const capture: VoiceCaptureLike =
      this.deps.createCapture?.(captureEvents) ??
      new VoiceCapture(captureEvents, shouldUseMockMic() ? buildMockMicDeps() : undefined);
    this.capture = capture;

    capture
      .start()
      .then(() => {
        // Release/cancel can land while the mic prompt is still open: never
        // start streaming into a session that is already over.
        if (this.cancelled || this.finalizing) {
          capture.stop();
          if (this.capture === capture) this.capture = null;
          return;
        }
        this.handlers.onUiEvent({ type: 'micGranted' });
        this.socket?.dial();
        this.readyTimer = setTimeout(() => {
          this.finalize(true);
          this.errored = true;
          this.handlers.onUiEvent({ type: 'socketError', code: 'connect_timeout' });
        }, READY_TIMEOUT_MS);
      })
      .catch(() => {
        // onError already dispatched the typed failure; just clean up.
        this.teardownMedia();
      });
  }

  /** Release / tap-stop: flush the tail, ask for the final, wait for `done`. */
  finish(): void {
    if (this.cancelled || this.settled) return;
    this.handlers.onUiEvent({ type: this.config.mode === 'hold' ? 'holdStop' : 'tapStop' });
    this.finalize(true);
  }

  /** Swipe-up cancel or accidental press: discard everything, no send. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    // Discarded means discarded: no transcript survives to be salvaged.
    this.backfill.clearAll();
    const capture = this.capture;
    this.capture = null;
    capture?.stop();
    this.socket?.sendAbort();
    this.socket?.close();
    this.socket = null;
    this.clearTimers();
    this.finalizing = false;
    this.settleFn = null;
    this.handlers.onRecognizedText('');
    this.handlers.onUiEvent({ type: 'holdCancel' });
  }

  /**
   * Explicit salvage ("put into input box" on the error card): merge the
   * transcript accumulated so far into the composer draft at the caret
   * snapshot taken when the session started.
   */
  commitToDraft(): void {
    const text = this.backfill.voiceText;
    if (!text) return;
    const draft = composeDraft(this.base, text);
    this.handlers.onDraftReplace?.(draft, voiceTextCaret(this.base, text));
  }

  private pushDraft(): void {
    if (this.config.mode !== 'tap') return;
    const text = composeDraft(this.base, this.backfill.voiceText);
    this.handlers.onDraftReplace?.(text, voiceTextCaret(this.base, this.backfill.voiceText));
    this.handlers.onRecognizedText(this.backfill.voiceText);
  }

  private handleServerEvent(event: VoiceServerEventLike): void {
    switch (event.kind) {
      case 'open': {
        if (this.readyTimer !== null) {
          clearTimeout(this.readyTimer);
          this.readyTimer = null;
        }
        this.handlers.onUiEvent({ type: 'socketReady' });
        // remainingMs is THIS connection's wall-clock budget, so the local
        // auto-finalize must never outlive it. A second asr.open (after
        // UPSTREAM_LOST recovery) simply re-arms.
        const budgetMs =
          typeof event.remainingMs === 'number' && event.remainingMs > 0
            ? Math.min(MAX_SESSION_MS, event.remainingMs)
            : MAX_SESSION_MS;
        if (this.maxTimer !== null) clearTimeout(this.maxTimer);
        this.maxTimer = setTimeout(() => this.finalize(true), budgetMs);
        if (this.ticker !== null) clearInterval(this.ticker);
        let elapsed = 0;
        this.handlers.onElapsed(elapsed);
        this.ticker = setInterval(() => {
          elapsed += 1;
          this.handlers.onElapsed(elapsed);
        }, 1000);
        return;
      }
      case 'partial': {
        this.backfill.setPartial(event.text ?? '');
        this.pushDraft();
        this.handlers.onRecognizedText(this.backfill.voiceText);
        return;
      }
      case 'final': {
        this.backfill.commitFinal(event.text ?? '');
        this.pushDraft();
        this.handlers.onRecognizedText(this.backfill.voiceText);
        return;
      }
      case 'upstream_lost': {
        // Self-healing inside the gateway: keep the last partial, keep
        // streaming, never finalize.
        return;
      }
      case 'error': {
        // Server-side rejection: keep whatever text already landed.
        this.lastErrorClass = event.class;
        this.errored = true;
        this.finalize(true);
        this.handlers.onRecognizedText(this.backfill.voiceText);
        this.handlers.onUiEvent({
          type: 'socketError',
          code: `server:${event.class ?? 'generic'}` as VoiceClientErrorCode,
        });
        return;
      }
      case 'done': {
        // Authoritative end of the interaction: settle now instead of waiting
        // out the safety net. Unknown when we never finalized (e.g. the
        // gateway finalized on its own) -> normal finalize.
        if (this.settleFn) this.settleFn(true);
        else this.finalize(true);
        return;
      }
      default:
        return;
    }
  }

  private handleSocketClose(info: { code: number; wasOpen: boolean }): void {
    // We closed it ourselves -> finalize() already owns the flow.
    if (this.finalizing || this.cancelled) return;
    if (!info.wasOpen) {
      this.errored = true;
      this.handlers.onUiEvent({ type: 'socketError', code: 'connect_timeout' });
      return;
    }
    const close = classifyVoiceClose(info.code, this.lastErrorClass);
    this.finalize(true);
    if (close.action === 'reconnect') {
      // Transient (gateway fault / keepalive loss). The honest recovery is
      // "words kept, try again" rather than silently re-dialing.
      this.errored = true;
      this.handlers.onUiEvent({ type: 'socketError', code: 'connection_lost' });
      return;
    }
    if (close.action === 'fail' && close.class) {
      this.errored = true;
      this.handlers.onUiEvent({
        type: 'socketError',
        code: `server:${close.class}` as VoiceClientErrorCode,
      });
    }
    // action 'none' (clean 1000 without asr.done): silent graceful end.
  }

  /**
   * Graceful finalize: flush tail PCM, send `finish`, then KEEP the socket
   * open until the gateway says the interaction is over. The timer below is
   * only a SAFETY NET for a gateway that never answers; a slow two-pass final
   * must not be cut off mid-utterance.
   */
  private finalize(dispatchDone: boolean): void {
    if (this.finalizing || this.cancelled) return;
    this.finalizing = true;
    const capture = this.capture;
    if (capture) {
      const tail = capture.stop();
      this.capture = null;
      const socket = this.socket;
      if (tail && socket?.isOpen) socket.sendPcm(tail);
      socket?.sendFinish();
    }
    this.clearTimers();
    const settle = (shouldDispatch: boolean) => {
      if (!this.finalizing) return;
      if (this.stopGraceTimer !== null) {
        clearTimeout(this.stopGraceTimer);
        this.stopGraceTimer = null;
      }
      // Read the merge state LAST: a final that landed during the wait
      // must still count as kept text.
      const text = this.backfill.voiceText;
      const kept = text.length > 0;
      this.socket?.close();
      this.socket = null;
      this.finalizing = false;
      this.settleFn = null;
      this.settled = true;
      this.handlers.onRecognizedText(text);
      if (shouldDispatch) this.handlers.onUiEvent({ type: 'sessionDone', keptText: kept });
      // Hold mode: the transcript is a NEW message, emitted exactly once.
      // Cancelled and errored sessions never auto-send (errors offer salvage).
      if (this.config.mode === 'hold' && !this.cancelled && !this.errored && !this.finalEmitted) {
        this.finalEmitted = true;
        this.handlers.onFinalText?.(text);
      }
    };
    this.settleFn = settle;
    this.stopGraceTimer = setTimeout(() => settle(dispatchDone), STOP_GRACE_MAX_MS);
  }

  private teardownMedia(): void {
    this.capture?.stop();
    this.capture = null;
    this.socket?.close();
    this.socket = null;
    this.clearTimers();
    this.finalizing = false;
    this.settleFn = null;
  }

  private clearTimers(): void {
    for (const ref of ['readyTimer', 'maxTimer', 'stopGraceTimer'] as const) {
      const handle = this[ref];
      if (handle !== null) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
        this[ref] = null;
      }
    }
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}

// Re-exported so tests and the hook share the exact type without importing
// the whole protocol module.
export type { VoiceServerEventLike as VoiceServerEvent };
