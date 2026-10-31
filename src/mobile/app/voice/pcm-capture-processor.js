/**
 * AudioWorklet capture processor (voice P0, subtask #10).
 *
 * Loaded as an AudioWorklet module asset (vite emits it for
 * `new URL('./pcm-capture-processor.js', import.meta.url)`). Deliberately
 * trivial: it only forwards Float32 frames (128-sample quantum) to the main
 * thread — ALL resampling/chunking/format math lives in pcm.ts so it is
 * unit-testable without a browser. Buffers are COPIED because the WebAudio
 * implementation reuses them after `process` returns.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      // Mono: channel 0 only. `.slice()` copies out of the implementation's
      // reused buffer before posting.
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
