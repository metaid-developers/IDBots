// Minimal probe: does getUserMedia + AudioContext(16k) + worklet work
// in this chromium with fake-media flags? (voice e2e diagnosis)
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  channel: process.env.VOICE_GUM_CHANNEL || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
await page.goto(process.env.E2E_BASE_URL || 'http://localhost:5196', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const out = {};
  const withTimeout = (p, ms, tag) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag} timeout ${ms}ms`)), ms))]);
  try {
    out.secure = window.isSecureContext;
    out.devices = navigator.mediaDevices ? 'present' : 'missing';
    const stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 5000, 'gum');
    out.gum = 'ok';
    out.trackLabel = stream.getAudioTracks()[0]?.label;
    stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext({ sampleRate: 16000 });
    out.ctxRate = ctx.sampleRate;
    out.ctxState = ctx.state;
    const blobUrl = URL.createObjectURL(new Blob(
      ["class P extends AudioWorkletProcessor{process(i){return true}}registerProcessor('probe',P)"],
      { type: 'application/javascript' },
    ));
    await withTimeout(ctx.audioWorklet.addModule(blobUrl), 5000, 'addModule');
    out.worklet = 'ok';
    await ctx.close();
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
});
console.log('[probe-result]', JSON.stringify(result, null, 1));
await browser.close();
