/**
 * Upstream contract for the ASR voice gateway (voice channel — new
 * capability, independent of the frozen C2/C3 contracts).
 *
 * The gateway speaks this interface to a streaming ASR provider; the
 * frontend speaks the WebSocket protocol documented in
 * `docs/cloud-mobile/voice/asr-channel.md`. Keeping the two decoupled is
 * what lets the PWA (AudioWorklet capture) and the gateway be developed in
 * parallel against the stub upstream.
 */

/** Events a streaming upstream session emits to the gateway. */
export type AsrUpstreamEvent =
  /** The upstream session is ready to receive audio. */
  | { kind: 'ready'; sessionId: string }
  /** Interim hypothesis for the current utterance (replaces the previous partial). */
  | { kind: 'partial'; text: string }
  /** A definite (VAD-finalized) utterance. */
  | { kind: 'final'; text: string }
  /** The upstream acknowledged end-of-stream after `finish()`. */
  | { kind: 'done'; durationMs: number }
  /**
   * Upstream failure. `code` is provider-scoped (DOUBAO_*, STUB_*, or
   * UPSTREAM_LOST for an unexpected transport drop); the gateway maps
   * retryable transport loss to an automatic reconnect.
   */
  | { kind: 'error'; code: string; message: string; retryable: boolean };

export interface AsrUpstreamSession {
  /** Streams one PCM chunk (s16le 16 kHz mono, 100–200 ms worth). */
  pushAudio(chunk: Buffer): void;
  /** Client said "no more audio": send end-of-stream upstream. */
  finish(): void;
  /** Teardown without end-of-stream (client aborted / gateway closing). */
  abort(): void;
}

export interface AsrUpstreamProvider {
  /** Stable name recorded in asr_usage rows and metrics labels. */
  readonly name: string;
  /**
   * Opens one streaming recognition session. Resolves only after the
   * provider accepted the session (the `ready` event follows immediately);
   * rejects when the provider cannot be reached or is misconfigured.
   */
  startSession(opts: {
    userId: string;
    onEvent: (event: AsrUpstreamEvent) => void;
  }): Promise<AsrUpstreamSession>;
}
