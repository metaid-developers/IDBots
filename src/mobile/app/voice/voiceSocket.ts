/**
 * Voice gateway WebSocket client (voice P0, subtask #10) — ASR channel v1.
 *
 * Thin, dependency-free client in the same spirit as the mobile C2
 * gatewayClient (Transport abstraction → fake-able in unit tests). It owns
 * ONLY the socket: no lifecycle timers (those live in useVoiceInput) and no
 * wire knowledge (that lives in protocol.ts).
 *
 * v1 shape: there is no client `start` frame — the handshake carries the
 * same-origin `idb_session` cookie, so the socket simply opens and audio may
 * flow immediately (the gateway buffers up to 64 chunks until `asr.open`).
 * The client only ever sends binary PCM plus the two control frames
 * `finish` / `abort`.
 */

import {
  buildVoiceSocketUrl,
  decodeServerEvent,
  encodeAbortFrame,
  encodeFinishFrame,
  VOICE_PCM_FORMAT,
  type VoiceServerEvent,
} from './protocol';

/** Structural subset of the browser WebSocket (same pattern as gatewayClient). */
export interface VoiceWebSocketLike {
  readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

export type VoiceWebSocketConstructor = new (url: string) => VoiceWebSocketLike;

export const VOICE_WS_CONNECTING = 0;
export const VOICE_WS_OPEN = 1;

export interface VoiceSocketOptions {
  /** Endpoint override (dev/e2e stub only); default same-origin /asr/v1/ws. */
  urlOverride?: string;
  WebSocketImpl?: VoiceWebSocketConstructor;
  onEvent: (event: VoiceServerEvent) => void;
  onOpen: () => void;
  onClose: (info: { code: number; wasOpen: boolean }) => void;
  /** Malformed/foreign frames are dropped; counted here if the caller cares. */
  onDroppedFrame?: (raw: string) => void;
}

/** Close code reported when we tear the socket down ourselves. */
export const VOICE_CLOSE_NORMAL = 1000;

export class VoiceSocketClient {
  private ws: VoiceWebSocketLike | null = null;
  private everOpened = false;
  private readonly WS: VoiceWebSocketConstructor;
  private readonly url: string;

  constructor(private readonly opts: VoiceSocketOptions) {
    // DOM lib's WebSocket handler signatures don't structurally unify with the
    // narrow WebSocketLike — same sanctioned unknown-cast seam as gatewayClient.
    this.WS = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as VoiceWebSocketConstructor);
    this.url = buildVoiceSocketUrl(opts.urlOverride);
  }

  /**
   * Dials the channel. The caller arms its own ready-timeout: the first
   * meaningful server frame is `asr.open` (there is no client handshake).
   */
  dial(): void {
    if (this.ws) return;
    this.everOpened = false;
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.everOpened = true;
      this.opts.onOpen();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return; // gateway never sends binary
      const decoded = decodeServerEvent(event.data);
      if (!decoded) {
        this.opts.onDroppedFrame?.(event.data);
        return;
      }
      this.opts.onEvent(decoded);
    };
    ws.onerror = () => {
      /* the close event follows; onClose reports it */
    };
    ws.onclose = (event) => {
      // wasOpen = the session HAD reached open (semantics the session layer
      // needs to tell connect_timeout apart from connection_lost) — not the
      // readyState at close time, which browsers may already have reset.
      const wasOpen = this.everOpened;
      this.ws = null;
      this.opts.onClose({ code: typeof event.code === 'number' ? event.code : 1006, wasOpen });
    };
  }

  /** Streams one wire-ready PCM chunk (Int16LE bytes from the PcmChunker). */
  sendPcm(bytes: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== VOICE_WS_OPEN) return false;
    // The gateway ignores empty chunks; skipping them keeps frame counts honest.
    if (bytes.length === 0) return false;
    ws.send(bytes);
    return true;
  }

  /** End of utterance: triggers asr.final + asr.done + close 1000. */
  sendFinish(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== VOICE_WS_OPEN) return;
    ws.send(encodeFinishFrame());
  }

  /** Cancel now: the gateway closes 1000 and still records the usage. */
  sendAbort(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== VOICE_WS_OPEN) return;
    ws.send(encodeAbortFrame());
  }

  /** Full teardown from OUR side (close code 1000, not an error). */
  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.close(VOICE_CLOSE_NORMAL, 'voice session end');
    } catch {
      // already closing
    }
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === VOICE_WS_OPEN;
  }

  get negotiatedPcmFormat(): typeof VOICE_PCM_FORMAT {
    return VOICE_PCM_FORMAT;
  }
}

/** Capability probe for the iOS Safari compatibility path (UI gate). */
export function isVoiceCaptureSupported(): boolean {
  const media = (navigator as { mediaDevices?: { getUserMedia?: unknown } }).mediaDevices;
  return typeof AudioWorklet !== 'undefined' && typeof media?.getUserMedia === 'function';
}
