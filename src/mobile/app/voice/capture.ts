/**
 * Microphone capture controller (voice P0, subtask #10) — the only module
 * that touches browser audio APIs directly.
 *
 * iOS Safari compatibility path (documented decisions):
 *  1. The AudioContext is created INSIDE the user gesture (tap handler) —
 *     Safari refuses to start audio outside a gesture.
 *  2. We request `new AudioContext({ sampleRate: 16000 })`. Safari 14.1+
 *     honors the option; if the context still reports another rate (older
 *     iOS quirks), pcm.ts linearly downsamples to the 16 kHz wire contract.
 *  3. Interruption (lock screen, phone call, app switch): iOS suspends the
 *     context ('interrupted'/'suspended'). We report `onInterrupted` and the
 *     session layer finalizes gracefully — PCM flush + `stop` frame — so the
 *     text recognized so far lands in the draft instead of being lost. A web
 *     page CANNOT keep recording on a locked screen; the honest guarantee is
 *     "no data loss on interruption", not "recording continues while locked".
 *  4. Permission: getUserMedia inside the same gesture; NotAllowedError maps
 *     to the mic_denied copy with a settings hint. We deliberately do NOT
 *     arm a timeout while the system permission dialog is open — killing the
 *     session under an unanswered dialog would be worse UX.
 *  5. Old iOS (< 14.1, no AudioWorklet): `isVoiceCaptureSupported()` gates
 *     the button; tapping shows the degrade hint instead of failing silently.
 */

import { PcmChunker, TARGET_SAMPLE_RATE } from './pcm';
import { isVoiceCaptureSupported } from './voiceSocket';

export interface VoiceCaptureEvents {
  /** Wire-ready Int16LE PCM chunk (see PcmChunker). */
  onWireChunk: (bytes: Uint8Array) => void;
  /** Audio session left the running state (lock screen / call / app switch). */
  onInterrupted: () => void;
  /** Capture-side failure with a machine error code. */
  onError: (code: 'mic_denied' | 'mic_unavailable' | 'audio_context_failed') => void;
}

export type VoiceAudioContextLike = {
  sampleRate: number;
  state: string;
  onstatechange: (() => void) | null;
  audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(stream: unknown): { connect(node: unknown): void; disconnect(): void };
  destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
};

export type VoiceAudioContextConstructor = new (options?: { sampleRate?: number }) => VoiceAudioContextLike;

export interface VoiceCaptureDeps {
  getUserMedia: (constraints: { audio: Record<string, unknown> }) => Promise<MediaStream>;
  AudioContextCtor: VoiceAudioContextConstructor;
  /** Worklet module URL; defaults to the sibling processor file (vite asset). */
  workletUrl?: string;
  /**
   * Worklet node factory (test seam — the voice e2e mock mic replaces this;
   * the default builds a real AudioWorkletNode).
   */
  createWorkletNode?: (context: VoiceAudioContextLike) => ActiveSession['workletNode'];
}

interface ActiveSession {
  stream: MediaStream;
  context: VoiceAudioContextLike;
  source: { connect(node: unknown): void; disconnect(): void };
  workletNode: { port: { onmessage: ((event: { data: Float32Array }) => void) | null }; disconnect(): void };
  chunker: PcmChunker;
}

const DEFAULT_WORKLET_URL = new URL('./pcm-capture-processor.js', import.meta.url).toString();

export class VoiceCapture {
  private active: ActiveSession | null = null;
  private readonly deps: VoiceCaptureDeps;

  constructor(
    private readonly events: VoiceCaptureEvents,
    deps?: Partial<VoiceCaptureDeps>,
  ) {
    const nav = navigator as { mediaDevices?: { getUserMedia?: VoiceCaptureDeps['getUserMedia'] } };
    this.deps = {
      getUserMedia: deps?.getUserMedia ?? nav.mediaDevices!.getUserMedia.bind(nav.mediaDevices),
      // DOM lib's AudioContext has handler signatures TS can't structurally
      // unify with our narrow shape — the unknown cast is the sanctioned seam.
      AudioContextCtor:
        deps?.AudioContextCtor ?? (globalThis.AudioContext as unknown as VoiceAudioContextConstructor),
      workletUrl: deps?.workletUrl ?? DEFAULT_WORKLET_URL,
      createWorkletNode: deps?.createWorkletNode ?? ((context) => this.createRealWorkletNode(context)),
    };
  }

  static supported(): boolean {
    return isVoiceCaptureSupported();
  }

  /** Real rate the context negotiated (wire stays 16 kHz either way). */
  get actualSampleRate(): number {
    return this.active?.context.sampleRate ?? TARGET_SAMPLE_RATE;
  }

  get capturing(): boolean {
    return this.active !== null;
  }

  /**
   * MUST be called synchronously inside the tap handler chain. Resolves once
   * PCM is flowing; rejects with a typed capture error otherwise.
   */
  async start(): Promise<{ sampleRate: number }> {
    if (this.active) return { sampleRate: this.actualSampleRate };
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') this.events.onError('mic_denied');
      else this.events.onError('mic_unavailable');
      throw error;
    }

    let context: VoiceAudioContextLike;
    try {
      context = new this.deps.AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
      await context.audioWorklet.addModule(this.deps.workletUrl!);
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      this.events.onError('audio_context_failed');
      throw error;
    }

    const chunker = new PcmChunker(context.sampleRate);
    const source = context.createMediaStreamSource(stream);
    const workletNode = this.deps.createWorkletNode!(context);
    workletNode.port.onmessage = (event) => {
      const frame = event.data;
      for (const bytes of chunker.push(frame)) this.events.onWireChunk(bytes);
    };
    source.connect(workletNode);

    context.onstatechange = () => {
      if (context.state !== 'running' && this.active) this.events.onInterrupted();
    };
    if (context.state !== 'running') {
      try {
        await context.resume();
      } catch {
        // iOS may resume asynchronously after the gesture; statechange covers it.
      }
    }

    this.active = { stream, context, source, workletNode, chunker };
    return { sampleRate: context.sampleRate };
  }

  /** Flushes remaining PCM and tears everything down. Returns the tail chunk. */
  stop(): Uint8Array | null {
    const session = this.active;
    if (!session) return null;
    this.active = null;
    const tail = session.chunker.flush();
    session.workletNode.port.onmessage = null;
    session.context.onstatechange = null;
    try {
      session.source.disconnect();
      session.workletNode.disconnect();
    } catch {
      // node already disconnected
    }
    for (const track of session.stream.getTracks()) track.stop();
    void session.context.close().catch(() => undefined);
    return tail;
  }

  private createRealWorkletNode(context: VoiceAudioContextLike): ActiveSession['workletNode'] {
    // Minimal structural wrapper around AudioWorkletNode: we only rely on
    // port.onmessage + disconnect, so the fake contexts in tests work too.
    const node = new (globalThis as unknown as {
      AudioWorkletNode: new (
        ctx: VoiceAudioContextLike,
        name: string,
      ) => { port: { onmessage: ((event: { data: Float32Array }) => void) | null }; disconnect(): void };
    }).AudioWorkletNode(context, 'pcm-capture');
    return node;
  }
}
