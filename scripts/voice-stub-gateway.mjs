#!/usr/bin/env node
/**
 * Voice ASR stub gateway (voice P0, subtask #10) — ASR channel v1 dialect.
 *
 * Mirrors the frozen v1 channel document (docs/cloud-mobile/voice/asr-channel.md):
 *   - no client `start` frame: the socket opens and the gateway pushes
 *     {"type":"asr.open",sessionId,remainingMs} straight away (the real
 *     gateway does this after upstream ready; the stub upstream is instant)
 *   - client sends binary PCM (content ignored) + {"type":"finish"|"abort"}
 *   - finish -> asr.final, asr.done, close 1000
 *   - anything else (non-JSON / unknown type) -> close 4106
 *
 * The canned transcript is the documented stub-upstream sentence
 * (今天天气怎么样): partials grow towards it, the final is the punctuated form
 * so the e2e proves partial -> final REPLACEMENT in the composer.
 *
 * Usage: node scripts/voice-stub-gateway.mjs [--port 8791]
 * Env:   VOICE_STUB_PARTIAL_MS (default 250) — delay between partials.
 */
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = Number(portFlag >= 0 ? args[portFlag + 1] : process.env.VOICE_STUB_PORT || 8791);
const PARTIAL_MS = Number(process.env.VOICE_STUB_PARTIAL_MS || 250);
const REMAINING_MS = 3_600_000;

/** Canned recognition: partials grow, the final adds the closing punctuation. */
const PARTIALS = ['今天', '今天天气', '今天天气怎', '今天天气怎么', '今天天气怎么样'];
const FINAL_TEXT = '今天天气怎么样？';

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

/** Stats printed on shutdown — evidence for the delivery notes. */
let sessions = 0;
let pcmBytes = 0;
let pcmChunks = 0;

wss.on('listening', () => {
  console.log(`[voice-stub] listening on ws://127.0.0.1:${PORT} (asr channel v1, partial every ${PARTIAL_MS}ms)`);
});

wss.on('connection', (ws) => {
  sessions += 1;
  const openedAt = Date.now();
  let partialTimer = null;
  let partialIndex = 0;
  let finished = false;
  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const clearPartialTimer = () => {
    if (partialTimer !== null) {
      clearInterval(partialTimer);
      partialTimer = null;
    }
  };

  // asr.open is pushed by the gateway, never requested by the client.
  send({ type: 'asr.open', sessionId: `stub-${Date.now()}`, remainingMs: REMAINING_MS });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (finished) return;
      pcmChunks += 1;
      pcmBytes += data.length;
      if (partialTimer === null && partialIndex < PARTIALS.length) {
        // Stream the canned hypothesis while "audio" flows in.
        partialTimer = setInterval(() => {
          if (partialIndex >= PARTIALS.length) {
            clearPartialTimer();
            return;
          }
          send({ type: 'asr.partial', text: PARTIALS[partialIndex] });
          partialIndex += 1;
          if (partialIndex >= PARTIALS.length) clearPartialTimer();
        }, PARTIAL_MS);
      }
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      ws.close(4106, 'bad control frame');
      return;
    }
    if (frame && frame.type === 'finish') {
      if (finished) return;
      finished = true;
      clearPartialTimer();
      const usageSeconds = Math.max(0, (Date.now() - openedAt) / 1000);
      send({ type: 'asr.final', text: FINAL_TEXT });
      send({
        type: 'asr.done',
        usageSeconds: Math.round(usageSeconds * 10) / 10,
        remainingMs: Math.max(0, REMAINING_MS - Math.round(usageSeconds * 1000)),
        upstreamDurationMs: Math.round(usageSeconds * 1000),
      });
      ws.close(1000, 'stub session end');
      return;
    }
    if (frame && frame.type === 'abort') {
      finished = true;
      clearPartialTimer();
      ws.close(1000, 'client abort');
      return;
    }
    ws.close(4106, 'unknown control frame');
  });

  ws.on('close', clearPartialTimer);
  ws.on('error', () => clearPartialTimer());
});

process.on('SIGTERM', () => {
  console.log(`[voice-stub] shutdown: ${sessions} session(s), ${pcmChunks} chunk(s), ${pcmBytes} PCM bytes received`);
  wss.close(() => process.exit(0));
});
