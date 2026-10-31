import { randomUUID } from 'node:crypto';
import type { AsrUpstreamEvent, AsrUpstreamProvider, AsrUpstreamSession } from './types.js';

/**
 * StubUpstream — the fake ASR provider used until the Volcano credentials
 * arrive (and for joint debugging with the PWA afterwards).
 *
 * Implements the same UpstreamProvider interface as the real Doubao
 * implementation. Behavior is scriptable through `faults` so the gateway,
 * the frontend, and the tests can exercise:
 *   - `delayMs`:           time before the session becomes ready
 *   - `disconnectAfterMs`: kill the session mid-stream (UPSTREAM_LOST),
 *                          0 disables; fires at most once per session
 *   - `slowFinalMs`:       finish() → final/done delayed by this much
 *
 * In stub mode the session streams a fixed test transcript, revealing it
 * progressively as audio chunks arrive: partials grow towards the full
 * text, and `finish()` finalizes the whole sentence.
 */

export interface StubFaults {
  delayMs?: number;
  disconnectAfterMs?: number;
  slowFinalMs?: number;
}

export interface StubUpstreamOptions {
  faults?: StubFaults;
  /** Full final transcript; partials are prefixes of it. */
  transcript?: string;
  /** How many audio chunks are expected for the full reveal (progress scale). */
  expectedChunks?: number;
}

export class StubUpstream implements AsrUpstreamProvider {
  readonly name = 'stub';
  private readonly transcript: string;
  private readonly expectedChunks: number;
  private readonly faults: Required<StubFaults>;

  constructor(options: StubUpstreamOptions = {}) {
    this.transcript = options.transcript ?? '今天天气怎么样';
    this.expectedChunks = Math.max(1, options.expectedChunks ?? 4);
    this.faults = {
      delayMs: options.faults?.delayMs ?? 0,
      disconnectAfterMs: options.faults?.disconnectAfterMs ?? 0,
      slowFinalMs: options.faults?.slowFinalMs ?? 0,
    };
  }

  startSession(opts: { userId: string; onEvent: (event: AsrUpstreamEvent) => void }): Promise<AsrUpstreamSession> {
    const { onEvent } = opts;
    const sessionId = `stub-${randomUUID()}`;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let chunkCount = 0;
    let finished = false;
    let dead = false;

    const emit = (event: AsrUpstreamEvent): void => {
      if (!dead) {
        onEvent(event);
      }
    };

    const later = (ms: number, fn: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!dead) {
          fn();
        }
      }, ms);
      timers.add(timer);
    };

    const kill = (): void => {
      dead = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    };

    const delayedReady = this.faults.delayMs;
    const disconnectAfterMs = this.faults.disconnectAfterMs;

    later(delayedReady, () => {
      emit({ kind: 'ready', sessionId });
      if (disconnectAfterMs > 0) {
        later(disconnectAfterMs, () => {
          if (finished) {
            return;
          }
          // Emit BEFORE kill(): the emit guard drops events once dead.
          emit({
            kind: 'error',
            code: 'UPSTREAM_LOST',
            message: `stub: dropped after ${disconnectAfterMs}ms`,
            retryable: true,
          });
          kill();
        });
      }
    });

    const NOMINAL_CHUNK_MS = 100;
    const transcriptRef = this.transcript;
    const expectedChunksRef = this.expectedChunks;
    const slowFinalMsRef = this.faults.slowFinalMs;

    const session: AsrUpstreamSession = {
      pushAudio(chunk: Buffer): void {
        if (dead || finished || chunk.length === 0) {
          return;
        }
        chunkCount += 1;
        const progress = Math.min(1, chunkCount / expectedChunksRef);
        const chars = Math.max(1, Math.round(progress * transcriptRef.length));
        if (chars > transcriptRef.length) {
          return;
        }
        emit({ kind: 'partial', text: transcriptRef.slice(0, chars) });
      },
      finish(): void {
        if (dead || finished) {
          return;
        }
        finished = true;
        later(slowFinalMsRef, () => {
          emit({ kind: 'final', text: transcriptRef });
          emit({ kind: 'done', durationMs: chunkCount * NOMINAL_CHUNK_MS });
        });
      },
      abort(): void {
        kill();
      },
    };

    return Promise.resolve(session);
  }
}
