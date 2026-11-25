/**
 * Microphone capture controller (voice P0/P1) — the only module that touches
 * browser audio APIs directly.
 *
 * iOS Safari & Android WebView fast-path and compatibility decisions:
 *  1. AudioContext creation / resume happens synchronously at the top of the
 *     user gesture (BEFORE awaiting `getUserMedia`), running `addModule` in
 *     parallel with `getUserMedia` so cold startup latency is overlapped and
 *     iOS gesture activation never expires across an await boundary.
 *  2. Warm reuse: once an AudioContext + `pcm-capture` worklet module has been
 *     initialized (via `VoiceCapture.warmup()` or the first press), `stop()`
 *     immediately stops all `MediaStream` tracks (turning off the OS mic
 *     indicator right away) while suspending — not destroying — the warm
 *     AudioContext so subsequent presses skip worklet loading completely.
 *  3. We request `new AudioContext({ sampleRate: 16000 })`. If the context
 *     negotiates another rate, `pcm.ts` linearly downsamples to 16 kHz.
 *  4. Interruption (lock screen, phone call, app switch): iOS suspends the
 *     context ('interrupted'/'suspended'). We report `onInterrupted` and the
 *     session layer finalizes gracefully so recognized words are preserved.
 *  5. Permission: `NotAllowedError` maps to `mic_denied`; we never arm a
 *     timeout while the system permission dialog may still be open.
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
  /**
   * Live input level in 0..1, derived from the RMS of the same PCM frames the
   * wire gets (no synthetic animation). Emitted roughly every 32 ms while
   * recording; consumers draw the hold overlay's volume wave from it.
   */
  onLevel?: (level: number) => void;
}

/**
 * Perceptual mapping from frame RMS to a 0..1 bar height. Speech lands around
 * -30..-12 dBFS, so the useful window is roughly -60 dB (silence) to -10 dB
 * (loud). Values are clamped, never randomized: the bars must track the mic.
 */
export function rmsToLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

function frameRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
  return frame.length > 0 ? Math.sqrt(sum / frame.length) : 0;
}

/** Worklet frames are 128 samples; 4 frames ≈ 32 ms at the 16 kHz target rate. */
const LEVEL_EMIT_FRAMES = 4;

export type VoiceAudioContextLike = {
  sampleRate: number;
  state: string;
  onstatechange: (() => void) | null;
  audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(stream: unknown): { connect(node: unknown): void; disconnect(): void };
  destination: unknown;
  resume(): Promise<void>;
  suspend?: () => Promise<void>;
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
  sharedContext: boolean;
  source: { connect(node: unknown): void; disconnect(): void };
  workletNode: { port: { onmessage: ((event: { data: Float32Array }) => void) | null }; disconnect(): void };
  chunker: PcmChunker;
  /** Level aggregation: peak over the frames since the last emit. */
  levelFrames: number;
  levelPeak: number;
}

const DEFAULT_WORKLET_URL = new URL('./pcm-capture-processor.js', import.meta.url).toString();

let warmContext: VoiceAudioContextLike | null = null;
let warmWorkletPromise: Promise<void> | null = null;
let warmContextInUse = false;
let micPermissionGrantedCache = false;

export function isMicPermissionKnownGranted(): boolean {
  return micPermissionGrantedCache;
}

export function markMicPermissionGranted(): void {
  micPermissionGrantedCache = true;
}

/**
 * Best-effort non-prompting permission check so returning users get parallel
 * ASR socket dialing on their very first press after loading the page.
 */
export function probeMicPermission(): void {
  if (micPermissionGrantedCache || typeof navigator === 'undefined') return;
  const permissions = (navigator as unknown as {
    permissions?: {
      query?: (desc: { name: string }) => Promise<{ state?: string; onchange?: (() => void) | null }>;
    };
  }).permissions;
  if (typeof permissions?.query !== 'function') return;
  void permissions
    .query({ name: 'microphone' })
    .then((status) => {
      if (status?.state === 'granted') micPermissionGrantedCache = true;
      else if (status?.state === 'denied') micPermissionGrantedCache = false;
      if (status && 'onchange' in status) {
        status.onchange = () => {
          micPermissionGrantedCache = status.state === 'granted';
        };
      }
    })
    .catch(() => undefined);
}

export function resetVoiceWarmStateForTests(): void {
  micPermissionGrantedCache = false;
  warmContextInUse = false;
  warmWorkletPromise = null;
  if (warmContext) {
    void warmContext.close().catch(() => undefined);
    warmContext = null;
  }
}

function ensureWarmAudioContext(resumeNow: boolean): {
  context: VoiceAudioContextLike;
  ready: Promise<void>;
} {
  const Ctor = globalThis.AudioContext as unknown as VoiceAudioContextConstructor;
  if (!warmContext || warmContext.state === 'closed') {
    const ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
    warmContext = ctx;
    warmWorkletPromise = ctx.audioWorklet.addModule(DEFAULT_WORKLET_URL).catch((err) => {
      if (warmContext === ctx) {
        warmContext = null;
        warmWorkletPromise = null;
      }
      void ctx.close().catch(() => undefined);
      throw err;
    });
  }
  const ctx = warmContext;
  const ready = warmWorkletPromise!;
  if (resumeNow && ctx.state !== 'running') {
    void ctx.resume().catch(() => undefined);
  }
  return { context: ctx, ready };
}

export class VoiceCapture {
  private active: ActiveSession | null = null;
  private readonly deps: VoiceCaptureDeps;
  private readonly canShareWarmContext: boolean;
  private readonly usesDefaultGetUserMedia: boolean;

  constructor(
    private readonly events: VoiceCaptureEvents,
    deps?: Partial<VoiceCaptureDeps>,
  ) {
    const nav = navigator as { mediaDevices?: { getUserMedia?: VoiceCaptureDeps['getUserMedia'] } };
    this.usesDefaultGetUserMedia = !deps?.getUserMedia;
    this.canShareWarmContext =
      !deps?.AudioContextCtor && !deps?.workletUrl && !deps?.createWorkletNode;
    this.deps = {
      getUserMedia: deps?.getUserMedia ?? nav.mediaDevices!.getUserMedia.bind(nav.mediaDevices),
      AudioContextCtor:
        deps?.AudioContextCtor ?? (globalThis.AudioContext as unknown as VoiceAudioContextConstructor),
      workletUrl: deps?.workletUrl ?? DEFAULT_WORKLET_URL,
      createWorkletNode: deps?.createWorkletNode ?? ((context) => this.createRealWorkletNode(context)),
    };
  }

  static supported(): boolean {
    return isVoiceCaptureSupported();
  }

  /**
   * Pre-initializes the shared AudioContext and loads the AudioWorklet module
   * without touching `getUserMedia` (never triggers a mic prompt or OS mic dot).
   * Call inside a user gesture such as switching to voice mode or pointerdown.
   */
  static warmup(options: { resume?: boolean } = {}): void {
    probeMicPermission();
    if (!isVoiceCaptureSupported() || typeof globalThis.AudioContext !== 'function') return;
    try {
      const { context, ready } = ensureWarmAudioContext(options.resume === true);
      if (options.resume !== true) {
        void ready
          .then(() => {
            if (!warmContextInUse && context.state === 'running' && typeof context.suspend === 'function') {
              void context.suspend().catch(() => undefined);
            }
          })
          .catch(() => undefined);
      }
    } catch {
      // Warmup is strictly opportunistic; start() handles real errors.
    }
  }

  /** Real rate the context negotiated (wire stays 16 kHz either way). */
  get actualSampleRate(): number {
    return this.active?.context.sampleRate ?? TARGET_SAMPLE_RATE;
  }

  get capturing(): boolean {
    return this.active !== null;
  }

  /**
   * MUST be called synchronously inside the gesture/timer chain. Resolves once
   * PCM is flowing; rejects with a typed capture error otherwise.
   */
  async start(): Promise<{ sampleRate: number }> {
    if (this.active) return { sampleRate: this.actualSampleRate };

    // Start/prepare the AudioContext synchronously BEFORE awaiting getUserMedia
    // so worklet loading overlaps mic hardware startup AND iOS gesture
    // activation stays bound to the user press.
    let sharedContext = false;
    let pendingContext: VoiceAudioContextLike | null = null;
    let contextError: unknown = null;
    let workletReady: Promise<void> | null = null;

    if (this.canShareWarmContext && !warmContextInUse && typeof this.deps.AudioContextCtor === 'function') {
      try {
        const warm = ensureWarmAudioContext(true);
        pendingContext = warm.context;
        sharedContext = true;
        warmContextInUse = true;
        workletReady = warm.ready.catch((err) => {
          contextError = err;
        });
      } catch (error) {
        contextError = error;
      }
    } else {
      try {
        const ctx = new this.deps.AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
        pendingContext = ctx;
        if (ctx.state !== 'running') {
          void ctx.resume().catch(() => undefined);
        }
        workletReady = ctx.audioWorklet.addModule(this.deps.workletUrl!).catch((err) => {
          contextError = err;
        });
      } catch (error) {
        contextError = error;
      }
    }

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
      if (this.usesDefaultGetUserMedia) markMicPermissionGranted();
    } catch (error) {
      if (sharedContext) {
        warmContextInUse = false;
        if (pendingContext && typeof pendingContext.suspend === 'function') {
          void pendingContext.suspend().catch(() => undefined);
        }
      } else if (pendingContext) {
        void pendingContext.close().catch(() => undefined);
      }
      const name = (error as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') this.events.onError('mic_denied');
      else this.events.onError('mic_unavailable');
      throw error;
    }

    if (workletReady) await workletReady;
    if (contextError || !pendingContext) {
      if (sharedContext) warmContextInUse = false;
      for (const track of stream.getTracks()) track.stop();
      this.events.onError('audio_context_failed');
      throw contextError ?? new Error('AudioContext failed to initialize');
    }

    const context = pendingContext;
    let source: ActiveSession['source'];
    let workletNode: ActiveSession['workletNode'];
    try {
      source = context.createMediaStreamSource(stream);
      workletNode = this.deps.createWorkletNode!(context);
    } catch (error) {
      if (sharedContext) {
        warmContextInUse = false;
        if (warmContext === context) {
          warmContext = null;
          warmWorkletPromise = null;
        }
      }
      void context.close().catch(() => undefined);
      for (const track of stream.getTracks()) track.stop();
      this.events.onError('audio_context_failed');
      throw error;
    }

    const chunker = new PcmChunker(context.sampleRate);
    const session: ActiveSession = {
      stream,
      context,
      sharedContext,
      source,
      workletNode,
      chunker,
      levelFrames: 0,
      levelPeak: 0,
    };
    workletNode.port.onmessage = (event) => {
      const frame = event.data;
      // Level first: the chunker holds frames back until a wire chunk is full,
      // while the overlay waveform reacts every ~32 ms.
      if (this.events.onLevel) {
        session.levelPeak = Math.max(session.levelPeak, frameRms(frame));
        session.levelFrames += 1;
        if (session.levelFrames >= LEVEL_EMIT_FRAMES) {
          this.events.onLevel(rmsToLevel(session.levelPeak));
          session.levelFrames = 0;
          session.levelPeak = 0;
        }
      }
      for (const bytes of chunker.push(frame)) this.events.onWireChunk(bytes);
    };
    source.connect(workletNode);

    if (context.state !== 'running') {
      try {
        await context.resume();
      } catch {
        // iOS may resume asynchronously right after the gesture; statechange covers it.
      }
    }
    context.onstatechange = () => {
      if (context.state !== 'running' && this.active === session) this.events.onInterrupted();
    };

    this.active = session;
    return { sampleRate: context.sampleRate };
  }

  /** Flushes remaining PCM and releases mic hardware immediately. Returns the tail chunk. */
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
    if (session.sharedContext) {
      warmContextInUse = false;
      if (typeof session.context.suspend === 'function') {
        void session.context.suspend().catch(() => undefined);
      } else {
        if (warmContext === session.context) {
          warmContext = null;
          warmWorkletPromise = null;
        }
        void session.context.close().catch(() => undefined);
      }
    } else {
      void session.context.close().catch(() => undefined);
    }
    return tail;
  }

  private createRealWorkletNode(context: VoiceAudioContextLike): ActiveSession['workletNode'] {
    const node = new (globalThis as unknown as {
      AudioWorkletNode: new (
        ctx: VoiceAudioContextLike,
        name: string,
      ) => { port: { onmessage: ((event: { data: Float32Array }) => void) | null }; disconnect(): void };
    }).AudioWorkletNode(context, 'pcm-capture');
    return node;
  }
}
