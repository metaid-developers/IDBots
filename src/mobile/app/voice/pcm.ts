/**
 * Pure PCM pipeline math for the mobile voice input (voice P0, subtask #10).
 *
 * Everything here is side-effect-free so it unit-tests under `tsx --test`
 * without a browser: Float32 (WebAudio domain) → Float32 resampled to 16 kHz
 * → Int16 (wire domain) → little-endian bytes. The AudioWorklet processor
 * only forwards Float32 frames; ALL rate/format decisions happen here on the
 * main thread, which keeps the worklet trivial and the math testable.
 */

/** Wire contract: 16 kHz mono little-endian Int16 (see protocol.ts). */
export const TARGET_SAMPLE_RATE = 16000;

/** ~100 ms of PCM per WebSocket binary frame at 16 kHz (1600 samples). */
export const CHUNK_SAMPLES = 1600;

/** Converts Float32 samples in [-1, 1] to Int16 with clamping. */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = input[i] < -1 ? -1 : input[i] > 1 ? 1 : input[i];
    // Round-half-away-from-zero keeps the midpoint symmetric around DC
    // (Math.round alone rounds .5 toward +∞, biasing quiet negatives).
    out[i] = Math.sign(clamped) * Math.round(Math.abs(clamped) * 32767);
  }
  return out;
}

/** Encodes Int16 samples as little-endian bytes (the wire frame body). */
export function int16ToLittleEndianBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(i * 2, pcm[i], true);
  }
  return bytes;
}

/**
 * Linear-interpolation resample for arbitrary input rates → target rate.
 * Returns the SAME array unchanged when rates match (identity fast path —
 * when the browser honored `new AudioContext({ sampleRate: 16000 })` there
 * is nothing to do). Endpoint alignment: out[0] = in[0], out[last] = in[last].
 */
export function downsampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error(`downsampleLinear: invalid rates ${fromRate} → ${toRate}`);
  }
  if (fromRate === toRate || input.length === 0) return input;
  if (input.length === 1) return new Float32Array(input); // single sample survives as-is
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  const lastIn = input.length - 1;
  const lastOut = outLength - 1;
  for (let i = 0; i < outLength; i += 1) {
    if (i === lastOut) {
      out[i] = input[lastIn];
      break;
    }
    const srcPos = i * ratio;
    const left = Math.floor(srcPos);
    const right = Math.min(left + 1, lastIn);
    const frac = srcPos - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

/** Concatenates Float32 chunks into one contiguous array (order preserved). */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Accumulates Float32 samples and emits fixed-size Int16 wire chunks
 * (CHUNK_SAMPLES) plus a trailing flush for session end. Keeps the WS frame
 * rate near 10/s instead of ~375/s (AudioWorklet 128-sample quantum).
 */
export class PcmChunker {
  private buffer: Float32Array[] = [];
  private bufferedSamples = 0;

  constructor(
    private readonly inputRate: number,
    private readonly targetRate: number = TARGET_SAMPLE_RATE,
    private readonly chunkSamples: number = CHUNK_SAMPLES,
  ) {}

  /** Feeds one worklet frame; returns wire-ready byte chunks (may be empty). */
  push(input: Float32Array): Uint8Array[] {
    this.buffer.push(input);
    this.bufferedSamples += input.length;
    const out: Uint8Array[] = [];
    while (this.bufferedSamples >= this.chunkSamples * (this.inputRate / this.targetRate)) {
      const consumed = Math.ceil(this.chunkSamples * (this.inputRate / this.targetRate));
      const taken = this.take(consumed);
      out.push(this.encode(taken));
    }
    return out;
  }

  /** Emits whatever remains as one final chunk (call once at stop). */
  flush(): Uint8Array | null {
    if (this.bufferedSamples === 0) return null;
    return this.encode(this.take(this.bufferedSamples));
  }

  get pending(): number {
    return this.bufferedSamples;
  }

  private take(count: number): Float32Array {
    const taken = new Float32Array(count);
    let filled = 0;
    while (filled < count && this.buffer.length > 0) {
      const head = this.buffer[0];
      const need = count - filled;
      if (head.length <= need) {
        taken.set(head, filled);
        filled += head.length;
        this.buffer.shift();
      } else {
        taken.set(head.subarray(0, need), filled);
        this.buffer[0] = head.subarray(need);
        filled += need;
      }
    }
    this.bufferedSamples -= filled;
    return taken;
  }

  private encode(samples: Float32Array): Uint8Array {
    const resampled = downsampleLinear(samples, this.inputRate, this.targetRate);
    return int16ToLittleEndianBytes(floatToInt16(resampled));
  }
}

/**
 * Full-frame convenience for tests and the stub path: one-shot encode of a
 * Float32 buffer at any input rate into wire bytes (single chunk, no framing).
 */
export function encodeFloat32ToWirePcm(input: Float32Array, inputRate: number): Uint8Array {
  const resampled = downsampleLinear(input, inputRate, TARGET_SAMPLE_RATE);
  return int16ToLittleEndianBytes(floatToInt16(resampled));
}
