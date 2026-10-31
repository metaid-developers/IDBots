/**
 * Voice gateway WebSocket client (voice P0, subtask #10).
 *
 * Thin, dependency-free client in the same spirit as the mobile C2
 * gatewayClient (Transport abstraction → fake-able in unit tests): it sends
 * the `start` frame, streams binary PCM, and translates server frames into
 * typed events via protocol.ts. Lifecycle timers live in the session layer
 * (useVoiceInput), NOT here — this class only owns the socket.
 */

import {
  buildVoiceSocketUrl,
  decodeServerEvent,
  encodeStartMessage,
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
  /** Endpoint override (dev/e2e stub); default same-origin /ws/voice. */
  urlOverride?: string;
  /** Optional auth token appended as ?token= (headers are impossible in browser WS). */
  token?: string;
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
    this.url = appendToken(buildVoiceSocketUrl(opts.urlOverride), opts.token);
  }

  /**
   * Dials and sends the `start` frame as soon as the socket opens. The caller
   * is expected to arm a ready-timeout (no server ack → connect_timeout).
   */
  dialStart(): void {
    if (this.ws) return;
    this.everOpened = false;
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.everOpened = true;
      try {
        ws.send(encodeStartMessage(navigatorLocaleOrUndefined()));
        this.opts.onOpen();
      } catch {
        this.opts.onEvent({ kind: 'error', code: 'internal', message: 'start frame send failed' });
      }
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return; // server never sends binary in v0
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
    ws.send(bytes);
    return true;
  }

  /** Tells the server this utterance is over (PCM flush already sent). */
  sendStop(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== VOICE_WS_OPEN) return;
    ws.send(JSON.stringify({ type: 'stop' }));
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

function appendToken(url: string, token: string | undefined): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function navigatorLocaleOrUndefined(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const lang = navigator.language;
  return lang ? lang.slice(0, 8) : undefined;
}

/** Capability probe for the iOS Safari compatibility path (DRAFT: UI gate). */
export function isVoiceCaptureSupported(): boolean {
  const media = (navigator as { mediaDevices?: { getUserMedia?: unknown } }).mediaDevices;
  return typeof AudioWorklet !== 'undefined' && typeof media?.getUserMedia === 'function';
}
