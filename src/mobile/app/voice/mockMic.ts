/**
 * TEST-ONLY microphone source for the voice e2e (voice P0, subtask #10).
 *
 * The sandboxed e2e environment cannot rely on Chromium's fake-media flags
 * (verified 2026-10-31: getUserMedia hangs under every fake-device flag
 * combination on this host — probe matrix output in the delivery evidence).
 * When BOTH gates below hold, VoiceCapture's injectable deps are replaced
 * with a synthetic 16 kHz sine "microphone":
 *
 *   1. build gate: import.meta.env.VITE_MOBILE_MOCK === '1' (mock builds
 *      only — production never bundles the call site, same pattern as the
 *      demo-notice handling in i18n.ts)
 *   2. URL gate: ?voiceMockMic=1 in the page URL (explicit opt-in)
 *
 * What stays REAL in the e2e: the worklet frame shape (Float32 128-sample
 * frames), the PcmChunker → 16 kHz Int16LE wire encoding, the WebSocket
 * draft-v0 client, the stub gateway round-trip, the button state machine and
 * the streaming draft backfill. What is FAKE: only the OS microphone (a
 * deterministic 220 Hz sine instead of a human voice). Real-mic verification
 * is manual (see 交付说明) and honestly marked NOT RUN in CI.
 */

import type { VoiceCaptureDeps, VoiceAudioContextLike } from './capture';

export function shouldUseMockMic(): boolean {
  if ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MOBILE_MOCK !== '1') return false;
  try {
    return new URLSearchParams(window.location.search).get('voiceMockMic') === '1';
  } catch {
    return false;
  }
}

const FRAME_SAMPLES = 128; // AudioWorklet render quantum
const FRAME_INTERVAL_MS = 8; // ~125 frames/s ≈ real-time at 16 kHz

interface MockWorkletNode {
  port: {
    onmessage: ((event: { data: Float32Array }) => void) | null;
    /** Mock frames enter through postMessage — same entry as a real worklet. */
    postMessage: (frame: Float32Array) => void;
  };
  disconnect(): void;
}

class MockMediaStream {
  private stopped = false;
  getAudioTracks() {
    return [{ kind: 'audio', label: 'mock-mic', id: 'mock-track-1', stop: () => { this.stopped = true; } }];
  }
  getTracks() {
    return this.getAudioTracks();
  }
  get stoppedState(): boolean {
    return this.stopped;
  }
}

class MockAudioContext implements VoiceAudioContextLike {
  sampleRate = 16000;
  state = 'running';
  onstatechange: (() => void) | null = null;
  readonly audioWorklet = { addModule: (_url: string) => Promise.resolve() };
  readonly destination = {};
  private timers = new Set<ReturnType<typeof setInterval>>();

  createMediaStreamSource(_stream: unknown): { connect(node: unknown): void; disconnect(): void } {
    let phase = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    return {
      connect: (node: unknown) => {
        const worklet = node as MockWorkletNode;
        timer = setInterval(() => {
          const frame = new Float32Array(FRAME_SAMPLES);
          for (let i = 0; i < FRAME_SAMPLES; i += 1) {
            // Deterministic 220 Hz sine at moderate level — "speech-like".
            frame[i] = Math.sin(phase) * 0.3;
            phase += (2 * Math.PI * 220) / this.sampleRate;
          }
          worklet.port.postMessage(frame);
        }, FRAME_INTERVAL_MS);
        this.timers.add(timer);
      },
      disconnect: () => {
        if (timer !== null) clearInterval(timer);
        this.timers.delete(timer);
      },
    };
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    return Promise.resolve();
  }
}

/** Builds the injected deps for the e2e mock mic (worklet module load is
 * faked by the mock context, so no worklet URL is needed). */
export function buildMockMicDeps(): VoiceCaptureDeps {
  return {
    getUserMedia: () => Promise.resolve(new MockMediaStream() as unknown as MediaStream),
/** Constructable: `new` per capture session (arrow fns can't be `new`ed). */
    AudioContextCtor: MockAudioContext as unknown as VoiceCaptureDeps['AudioContextCtor'],
    createWorkletNode: (_ctx) => {
      const node: MockWorkletNode = {
        port: {
          onmessage: null,
          // Frames enter exactly where the real worklet posts them; by the
          // time frames flow, capture.start() has assigned onmessage.
          postMessage: (frame: Float32Array) => {
            node.port.onmessage?.({ data: frame });
          },
        },
        disconnect: () => undefined,
      };
      return node;
    },
  };
}
