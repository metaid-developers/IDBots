// Variant matrix probe: which flag combo makes getUserMedia resolve?
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5196';
const variants = [
  { name: 'A: fake-device+fake-ui, no ctx permission', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], perms: [] },
  { name: 'B: fake-device only + ctx permission', args: ['--use-fake-device-for-media-stream'], perms: ['microphone'] },
  { name: 'C: fake-device+fake-ui+fake-audio-file', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=/tmp/voice-fake-tone.wav'], perms: [] },
  { name: 'D: fake-device+fake-ui+blinkDevices', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-features=FakeDeviceForMediaStream'], perms: [] },
];

// 1-second 440Hz sine wav (44-byte header + PCM) — for variant C.
function writeToneWav(path) {
  const sampleRate = 16000;
  const seconds = 30;
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path, Buffer.concat([header, data]));
}

writeToneWav('/tmp/voice-fake-tone.wav');

for (const v of variants) {
  try {
    const browser = await chromium.launch({ args: v.args });
    const context = await browser.newContext({ permissions: v.perms });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
      try {
        const stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 4000);
        const label = stream.getAudioTracks()[0]?.label;
        stream.getTracks().forEach((t) => t.stop());
        return `OK label=${label}`;
      } catch (e) {
        return String(e && e.message ? e.message : e);
      }
    });
    console.log(`[${v.name}] → ${result}`);
    await browser.close();
  } catch (e) {
    console.log(`[${v.name}] → LAUNCH/OTHER ERROR: ${String(e).slice(0, 120)}`);
  }
}
