/**
 * VoiceSession — imperative life-cycle core for one voice session (voice P1).
 *
 * Startup speed & zero-dropped-words guarantees:
 *  - Pre-open PCM buffer: any audio captured after `capture.start()` while the
 *    WebSocket handshake is still in flight is queued (bounded to 32 chunks,
 *    ~3.2 s, well inside the gateway's 64-chunk upstream buffer) and flushed
 *    in exact FIFO order the instant `ws.onOpen` fires. No early syllables are
 *    dropped while connecting.
 *  - Parallel dial: once microphone permission is known to be granted, the ASR
 *    WebSocket handshake runs concurrently with `capture.start()` instead of
 *    waiting sequentially behind hardware startup. When permission is not yet
 *    known granted, dialing still waits for `capture.start()` so an unanswered
 *    OS permission prompt never burns ASR quota or hits `connect_timeout`.
 *  - Coordinated readiness (`micReady && asrReady`): `socketReady` + `onReady`
 *    (which triggers the phone vibration and switches UI from Preparing to
 *    Listening) fire ONLY when BOTH hardware audio capture is running AND
 *    `asr.open` has arrived — regardless of which finishes first.
 */

import {
  composeDraft,
  createBackfill,
  splitDraftAtCaret,
  voiceTextCaret,
  type BackfillController,
} from './backfill';
import {
  isMicPermissionKnownGranted,
  VoiceCapture,
  type VoiceCaptureEvents,
} from './capture';
import { buildMockMicDeps, shouldUseMockMic } from './mockMic';
import { classifyVoiceClose, type VoiceServerErrorClass } from './protocol';
import type { VoiceClientErrorCode, VoiceMode, VoiceUiEvent } from './voiceButtonState';
import { VoiceSocketClient } from './voiceSocket';

export const MAX_SESSION_MS = 120_000;
/** ~3.2 s of 100 ms PCM chunks buffered client-side before WS open (gateway buffers up to 64). */
export const MAX_PREOPEN_PCM_CHUNKS = 32;
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
  sendPcm(bytes: Uint8Array): boolean | void;
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
  /** Fired exactly once when BOTH mic capture and ASR (`asr.open`) are ready. */
  onReady?: () => void;
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
  /**
   * Dial the ASR WebSocket concurrently with `capture.start()`. Defaults to
   * `isMicPermissionKnownGranted()` so warm sessions overlap mic + WS startup
   * while cold permission prompts never dial prematurely.
   */
  parallelDial?: boolean;
}

export class VoiceSession {
  private capture: VoiceCaptureLike | null = null;
  private socket: VoiceSocketLike | null = null;
  private readonly backfill: BackfillController = createBackfill();
  private base = { before: '', after: '' };
  private pendingPcmChunks: Uint8Array[] = [];
  private socketDialed = false;
  private micReady = false;
  private asrReady = false;
  private readyNotified = false;
  private pendingBudgetMs: number = MAX_SESSION_MS;
  private finalizing = false;
  private finishPendingSocketOpen = false;
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
        onOpen: () => this.handleSocketOpen(),
        onEvent: (event) => this.handleServerEvent(event),
        onClose: (info) => this.handleSocketClose(info),
      },
      urlOverride,
    );
    this.socket = socket;

    const captureEvents: VoiceCaptureEvents = {
      onWireChunk: (bytes) => {
        this.forwardOrBufferPcm(bytes);
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

    const shouldParallelDial = this.config.parallelDial ?? isMicPermissionKnownGranted();
    if (shouldParallelDial) {
      this.dialSocket();
    }

    capture
      .start()
      .then(() => {
        // Release/cancel can land while the mic prompt is still open: never
        // start streaming into a session that is already over.
        if (this.cancelled || this.finalizing || this.errored) {
          capture.stop();
          if (this.capture === capture) this.capture = null;
          return;
        }
        this.micReady = true;
        this.handlers.onUiEvent({ type: 'micGranted' });
        this.dialSocket();
        this.enterRecordingIfReady();
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
    this.pendingPcmChunks = [];
    this.finishPendingSocketOpen = false;
    const capture = this.capture;
    this.capture = null;
    capture?.stop();
    if (this.socketDialed) this.socket?.sendAbort();
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

  private dialSocket(): void {
    if (this.socketDialed || this.cancelled || !this.socket) return;
    this.socketDialed = true;
    this.readyTimer = setTimeout(() => {
      this.finalize(true);
      this.errored = true;
      this.handlers.onUiEvent({ type: 'socketError', code: 'connect_timeout' });
    }, READY_TIMEOUT_MS);
    this.socket.dial();
  }

  private forwardOrBufferPcm(bytes: Uint8Array): void {
    if (this.cancelled || bytes.length === 0) return;
    const socket = this.socket;
    if (socket?.isOpen) {
      this.flushBufferedPcm();
      socket.sendPcm(bytes);
      return;
    }
    if (this.pendingPcmChunks.length >= MAX_PREOPEN_PCM_CHUNKS) {
      this.pendingPcmChunks.shift();
    }
    this.pendingPcmChunks.push(bytes);
  }

  private flushBufferedPcm(): void {
    const socket = this.socket;
    if (!socket?.isOpen || this.pendingPcmChunks.length === 0) return;
    const queued = this.pendingPcmChunks;
    this.pendingPcmChunks = [];
    for (const chunk of queued) {
      socket.sendPcm(chunk);
    }
  }

  private handleSocketOpen(): void {
    if (this.cancelled) return;
    this.flushBufferedPcm();
    if (this.finishPendingSocketOpen) {
      this.finishPendingSocketOpen = false;
      this.socket?.sendFinish();
    }
  }

  private enterRecordingIfReady(): void {
    if (!this.micReady || !this.asrReady || this.cancelled || this.finalizing || this.errored) return;
    if (this.maxTimer !== null) clearTimeout(this.maxTimer);
    this.maxTimer = setTimeout(() => this.finalize(true), this.pendingBudgetMs);
    if (!this.readyNotified) {
      this.readyNotified = true;
      this.handlers.onUiEvent({ type: 'socketReady' });
      this.handlers.onReady?.();
      if (this.ticker !== null) clearInterval(this.ticker);
      let elapsed = 0;
      this.handlers.onElapsed(elapsed);
      this.ticker = setInterval(() => {
        elapsed += 1;
        this.handlers.onElapsed(elapsed);
      }, 1000);
    }
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
        // remainingMs is THIS connection's wall-clock budget, so the local
        // auto-finalize must never outlive it. A second asr.open (after
        // UPSTREAM_LOST recovery) simply updates the budget without firing a
        // duplicate ready vibration or resetting the elapsed timer.
        this.pendingBudgetMs =
          typeof event.remainingMs === 'number' && event.remainingMs > 0
            ? Math.min(MAX_SESSION_MS, event.remainingMs)
            : MAX_SESSION_MS;
        this.asrReady = true;
        this.enterRecordingIfReady();
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
      this.teardownMedia();
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
      if (tail && tail.length > 0) this.forwardOrBufferPcm(tail);
      const socket = this.socket;
      if (socket?.isOpen) {
        this.flushBufferedPcm();
        socket.sendFinish();
      } else if (this.socketDialed && socket) {
        this.finishPendingSocketOpen = true;
      }
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
      this.pendingPcmChunks = [];
      this.finishPendingSocketOpen = false;
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
    this.pendingPcmChunks = [];
    this.finishPendingSocketOpen = false;
    this.capture?.stop();
    this.capture = null;
    if (this.socketDialed && this.socket?.isOpen) this.socket.sendAbort();
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

export type { VoiceServerEventLike as VoiceServerEvent };
