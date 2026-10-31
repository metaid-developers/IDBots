// Voice PCM pipeline unit tests (voice P0, subtask #10).
//
// Covers the pure math in src/mobile/app/voice/pcm.ts: Float32→Int16
// conversion with clamping, little-endian byte layout, linear resampling
// (identity fast path, length math, endpoints), the 100 ms chunker across
// worklet-frame boundaries, and the one-shot wire encoder.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_SAMPLES,
  PcmChunker,
  TARGET_SAMPLE_RATE,
  concatFloat32,
  downsampleLinear,
  encodeFloat32ToWirePcm,
  floatToInt16,
  int16ToLittleEndianBytes,
} from '../src/mobile/app/voice/pcm.ts';

// ---------------------------------------------------------------------------
// floatToInt16
// ---------------------------------------------------------------------------

test('floatToInt16 scales to full Int16 range and clamps out-of-range input', () => {
  const input = new Float32Array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5]);
  const pcm = floatToInt16(input);
  assert.equal(pcm.length, input.length);
  assert.equal(pcm[0], -32767, 'clamped to Int16 minimum magnitude');
  assert.equal(pcm[1], -32767);
  assert.equal(pcm[2], -16384); // round(−0.5 × 32767) = −16383.5 → away from zero
  assert.equal(pcm[3], 0);
  assert.equal(pcm[4], 16384);
  assert.equal(pcm[5], 32767);
  assert.equal(pcm[6], 32767, 'clamped to Int16 maximum magnitude');
});

test('floatToInt16 keeps zero-centered symmetric rounding', () => {
  assert.equal(floatToInt16(new Float32Array([0.5]))[0], 16384);
  assert.equal(floatToInt16(new Float32Array([-0.5]))[0], -16384);
});

// ---------------------------------------------------------------------------
// int16ToLittleEndianBytes
// ---------------------------------------------------------------------------

test('int16ToLittleEndianBytes writes little-endian pairs', () => {
  const bytes = int16ToLittleEndianBytes(Int16Array.from([1, -1, 0x7fff, -0x8000]));
  assert.equal(bytes.length, 8);
  assert.deepEqual(Array.from(bytes.slice(0, 2)), [0x01, 0x00], '1 → 01 00');
  assert.deepEqual(Array.from(bytes.slice(2, 4)), [0xff, 0xff], '−1 → ff ff');
  assert.deepEqual(Array.from(bytes.slice(4, 6)), [0xff, 0x7f], '32767 → ff 7f');
  assert.deepEqual(Array.from(bytes.slice(6, 8)), [0x00, 0x80], '−32768 → 00 80');
});

// ---------------------------------------------------------------------------
// downsampleLinear
// ---------------------------------------------------------------------------

test('downsampleLinear is identity when rates match', () => {
  const input = new Float32Array([0, 0.25, -0.75, 1]);
  assert.equal(downsampleLinear(input, 16000, 16000), input, 'same array, no copy');
  assert.equal(downsampleLinear(new Float32Array(0), 48000, 16000).length, 0);
});

test('downsampleLinear produces the expected length and endpoints for 48k→16k', () => {
  const input = new Float32Array(4800); // 0.1 s @48k
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin((i / input.length) * Math.PI * 2);
  const out = downsampleLinear(input, 48000, 16000);
  assert.equal(out.length, 1600, '4800/3 = 1600 samples');
  assert.equal(out[0], input[0], 'first sample aligned');
  assert.equal(out[out.length - 1], input[input.length - 1], 'last sample pinned to input end');
});

test('downsampleLinear collapses degenerate short inputs to the input tail', () => {
  const input = new Float32Array([0, 1, 2, 3]);
  const out = downsampleLinear(input, 48000, 16000); // ratio 3 → round(4/3) = 1 sample
  // A 1-sample output hits the endpoint-pinning branch: out[last] = in[last].
  assert.equal(out.length, 1);
  assert.equal(out[0], 3);
});

test('downsampleLinear rejects invalid rates', () => {
  assert.throws(() => downsampleLinear(new Float32Array(8), 0, 16000));
  assert.throws(() => downsampleLinear(new Float32Array(8), 48000, Number.NaN));
});

test('concatFloat32 preserves order', () => {
  const out = concatFloat32([Float32Array.from([1, 2]), Float32Array.from([3]), Float32Array.from([])]);
  assert.equal(out.length, 3);
  assert.deepEqual(Array.from(out), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// PcmChunker
// ---------------------------------------------------------------------------

test('PcmChunker emits 1600-sample wire chunks on exact boundaries', () => {
  const chunker = new PcmChunker(16000);
  // One worklet frame is 128 samples; 25 frames = 3200 samples = 2 chunks.
  for (let i = 0; i < 25; i += 1) {
    const frames = chunker.push(new Float32Array(128));
    if (i < 12) assert.equal(frames.length, 0, `no chunk before 1600 samples (frame ${i})`);
    if (i === 12) assert.equal(frames.length, 1, '1600 samples reached → first chunk');
    if (i > 12 && i < 24) assert.equal(frames.length, 0, `buffering between chunks (frame ${i})`);
    if (i === 24) assert.equal(frames.length, 1, '3200 = 2×1600 → second chunk on exact boundary');
  }
  assert.equal(chunker.pending, 0, 'boundary-exact input leaves nothing buffered');
  assert.equal(chunker.flush(), null, 'nothing left to flush');
  assert.equal(chunker.flush(), null, 'second flush is still null (drained)');
});

test('PcmChunker flushes a non-boundary tail once', () => {
  const chunker = new PcmChunker(16000);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(chunker.push(new Float32Array(128)).length, 0, '1280 samples never reaches a chunk');
  }
  const tail = chunker.flush();
  assert.ok(tail, 'remaining samples flush as a tail');
  assert.equal(tail!.length, 1280 * 2, 'tail is 1280 Int16 pairs of bytes');
  assert.equal(chunker.flush(), null, 'second flush is null (drained)');
});

test('PcmChunker resamples 48k input down to the 16 kHz wire rate', () => {
  const chunker = new PcmChunker(48000);
  const frames = chunker.push(new Float32Array(4800)); // 0.1 s @48k
  assert.equal(frames.length, 1, '4800 @48k = 1600 @16k → exactly one wire chunk');
  assert.equal(frames[0].length, CHUNK_SAMPLES * 2, 'wire chunk is 1600 Int16 pairs of bytes');
});

test('PcmChunker buffers frames that straddle the chunk boundary', () => {
  const chunker = new PcmChunker(16000);
  let emitted = 0;
  for (let i = 0; i < 13; i += 1) {
    emitted += chunker.push(new Float32Array(130)).length; // awkward 130-sample frames
  }
  // 13 × 130 = 1690 samples → 1 full chunk (1600) emitted, 90 buffered.
  assert.equal(emitted, 1);
  assert.equal(chunker.pending, 90);
});

// ---------------------------------------------------------------------------
// encodeFloat32ToWirePcm
// ---------------------------------------------------------------------------

test('encodeFloat32ToWirePcm: one-shot Float32@anyRate → Int16LE bytes', () => {
  const bytes = encodeFloat32ToWirePcm(Float32Array.from([0, 1, -1]), 16000);
  // Scale is 32767 uniformly: +full → 0x7fff, −full → −32767 (0x8001), not
  // −32768 — the documented scale-32767 convention keeps zero exact.
  assert.deepEqual(
    Array.from(bytes),
    [0x00, 0x00, 0xff, 0x7f, 0x01, 0x80],
  );
  assert.equal(TARGET_SAMPLE_RATE, 16000, 'wire contract stays 16 kHz');
});
